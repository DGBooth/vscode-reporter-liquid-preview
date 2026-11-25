// The HTML preview's "SelectPdf pages" view: the page worked out from the
// settings (selectpdf-page.js), the choice of where each page ends and the
// print-media rewrite (webview/selectpdf-pages.js), and how the view is put
// into the preview.
//
// jsdom has no layout, so the paging itself — measuring the laid-out page and
// pushing content to the next one — can't run here. chooseNextBreak is the
// decision it makes at each page, and is tested on made-up positions. The
// whole view was checked against Chromium's own print-to-PDF at the same scale
// while it was built (see the README section on the view).

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const { PAGE_SIZES, normalizeSelectPdfSettings, pageGeometry, describeGeometry } = require('../selectpdf-page');
const { chooseNextBreak, chooseBreaks, rewriteMediaText } = require('../webview/selectpdf-pages');
const { extension, stub, harnessReset, makePreview, makePanel, chromeOf } = require('./harness');

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} is not ${expected}`);

test.beforeEach(() => harnessReset());

// ---- the page ----

test('the defaults are SelectPdf\'s: A4 portrait, laid out 1024px wide', () => {
    const g = pageGeometry({});
    close(g.page.widthPt, 595.28, 'A4 width in points');
    close(g.page.heightPt, 841.89, 'A4 height in points');
    assert.strictEqual(g.webPageWidth, 1024);
    assert.strictEqual(g.orientation, 'Portrait');
    assert.strictEqual(g.cssMediaType, 'Screen');
    assert.strictEqual(g.allowContentHeightResize, true);
    assert.strictEqual(g.header, null);
});

test('the layout is scaled so its width fills the page between the margins', () => {
    const g = pageGeometry({});
    close(g.page.width, 793.7, 'A4 in px');
    close(g.scale, 793.7 / 1024, 'scale');
    close(g.layoutPageHeight, g.content.height / g.scale, 'layout px per page');
    close(g.layoutPageHeight, 1122.52 * 1024 / 793.7, 'A4 is about 1448 layout px tall');
});

test('margins, header and footer come off the content box', () => {
    const g = pageGeometry({ marginLeft: 36, marginRight: 36, marginTop: 18, marginBottom: 18, header: { display: true, height: 50 }, footer: { display: true, height: 30 } });
    const px = pt => pt * 96 / 72;
    close(g.content.left, px(36), 'left');
    close(g.content.top, px(18) + px(50), 'top is below the header');
    close(g.content.width, g.page.width - px(72), 'width');
    close(g.content.height, g.page.height - px(36) - px(80), 'height');
    close(g.scale, g.content.width / 1024, 'scale from the narrower content');
});

test('a header that is not displayed, or has no height, takes no room', () => {
    assert.strictEqual(pageGeometry({ header: { display: false, height: 50 } }).header, null);
    assert.strictEqual(pageGeometry({ header: { display: true, height: 0 } }).header, null);
    const g = pageGeometry({ header: { display: true, height: 50, displayOnFirstPage: false } });
    assert.strictEqual(g.header.displayOnFirstPage, false);
    assert.strictEqual(g.header.displayOnOddPages, true, 'unset means shown');
});

test('landscape swaps the sides; a custom size wins over the named one', () => {
    const g = pageGeometry({ pageSize: 'Letter', orientation: 'Landscape' });
    close(g.page.widthPt, 792, 'Letter landscape width');
    close(g.page.heightPt, 612, 'Letter landscape height');
    const custom = pageGeometry({ pageSize: 'A3', customPageSize: { width: 300, height: 400 } });
    close(custom.page.widthPt, 300, 'custom width');
    assert.strictEqual(custom.pageSizeName, 'Custom');
});

test('a smaller web page width makes the content larger on the page', () => {
    assert.ok(pageGeometry({ webPageWidth: 800 }).scale > pageGeometry({}).scale);
});

test('settings out of range fall back rather than breaking the page', () => {
    const s = normalizeSelectPdfSettings({ pageSize: 'Tabloid', orientation: 'sideways', webPageWidth: 'wide', marginTop: -5, cssMediaType: 'print', customPageSize: { width: 0, height: 10 } });
    assert.strictEqual(s.pageSize, 'A4');
    assert.strictEqual(s.orientation, 'Portrait');
    assert.strictEqual(s.webPageWidth, 1024);
    assert.strictEqual(s.marginTop, 0);
    assert.strictEqual(s.cssMediaType, 'Print', 'any capitals');
    assert.strictEqual(s.customPageSize, null);
    const huge = pageGeometry({ marginLeft: 2000, marginRight: 2000 });
    assert.ok(huge.scale > 0 && Number.isFinite(huge.layoutPageHeight), 'margins wider than the page');
});

test('every page size the settings offer is known', () => {
    const offered = require('../package.json').contributes.configuration.properties['reporterLiquidPreview.selectPdf.pageSize'].enum;
    assert.deepStrictEqual([...offered].sort(), Object.keys(PAGE_SIZES).sort());
});

test('the toolbar says what page it is drawing', () => {
    assert.strictEqual(describeGeometry(pageGeometry({})), 'A4 portrait · 1024px layout at 78% on the page', 'the shrink onto the page, not a zoom');
    assert.match(describeGeometry(pageGeometry({ cssMediaType: 'Print', customPageSize: { width: 300, height: 400 } })), /^300×400pt portrait .* print media$/);
});

// ---- where pages end ----

const at = (y, extra = {}) => ({ y, forced: false, avoid: false, ...extra });

test('everything fits: one page', () => {
    assert.deepStrictEqual(chooseNextBreak([at(100), at(200)], 0, 1000, 900), { kind: 'end' });
});

test('the page ends at the last break that still fits', () => {
    const choice = chooseNextBreak([at(300), at(700), at(990), at(1200)], 0, 1000, 2000);
    assert.deepStrictEqual(choice, { kind: 'break', index: 2, forced: false });
});

test('a forced break wins over a later one that fits', () => {
    const choice = chooseNextBreak([at(300, { forced: true }), at(900)], 0, 1000, 2000);
    assert.deepStrictEqual(choice, { kind: 'break', index: 0, forced: true });
});

test('a forced break is taken even when the rest would fit on the page', () => {
    assert.strictEqual(chooseNextBreak([at(300, { forced: true })], 0, 1000, 500).kind, 'break');
});

test('a forced break at the very top of a page does not make an empty page', () => {
    assert.deepStrictEqual(chooseNextBreak([at(1000, { forced: true })], 1000, 1000, 1500), { kind: 'end' });
});

test('a forced break after the last thing in the document does not add a page', () => {
    assert.deepStrictEqual(chooseNextBreak([at(500, { forced: true })], 0, 1000, 500), { kind: 'end' });
});

test('places to avoid are passed over for an earlier one', () => {
    const choice = chooseNextBreak([at(400), at(950, { avoid: true })], 0, 1000, 2000);
    assert.strictEqual(choice.index, 0);
});

test('when only places to avoid fit, the latest of them is used', () => {
    const choice = chooseNextBreak([at(400, { avoid: true }), at(950, { avoid: true })], 0, 1000, 2000);
    assert.strictEqual(choice.index, 1);
});

test('content with nowhere to break is cut at the page end', () => {
    assert.deepStrictEqual(chooseNextBreak([at(1500)], 0, 1000, 3000), { kind: 'slice', y: 1000 });
});

test('a whole document: breaks push what follows to the next page', () => {
    // Blocks ending at 600, 1100 and 1500, the next one starting 20px lower
    // each time, then a forced break before a block at 1700.
    const candidates = [
        at(600, { next: 620 }),
        at(1100, { next: 1120 }),
        at(1500, { next: 1520 }),
        at(1700, { next: 1700, forced: true })
    ];
    const { pages, contentEnd } = chooseBreaks(candidates, 1000, 2000);
    assert.deepStrictEqual(pages.map(p => [p.top, p.end, p.at, p.forced]), [
        // 1100 doesn't fit, so the page ends at 600, and 620 moves to 1000.
        [0, 'break', 0, false],
        // Everything after moved 380 down: 1100 is at 1480, 1500 at 1880.
        [1000, 'break', 2, false],
        // 1520 moved to 2000, so the forced break is now at 2180.
        [2000, 'break', 3, true],
        [3000, 'end', undefined, undefined]
    ]);
    assert.strictEqual(contentEnd, 2000 + 380 + 100 + 820);
});

test('a whole document: a long run of lines breaks once per page', () => {
    const lines = Array.from({ length: 99 }, (_, i) => at((i + 1) * 30));
    const { pages } = chooseBreaks(lines, 1000, 3000);
    assert.strictEqual(pages.length, 4);
    assert.ok(pages.slice(0, 3).every(p => p.end === 'break'));
});

// ---- print media ----

test('print media: print rules apply, screen rules stop applying', () => {
    assert.strictEqual(rewriteMediaText('print', 'print'), 'all');
    assert.strictEqual(rewriteMediaText('screen', 'print'), 'not all');
    assert.strictEqual(rewriteMediaText('print and (min-width: 500px)', 'print'), 'all and (min-width: 500px)');
    assert.strictEqual(rewriteMediaText('only screen and (max-width: 600px)', 'print'), 'not all');
    assert.strictEqual(rewriteMediaText('not print', 'print'), 'not all');
    assert.strictEqual(rewriteMediaText('not screen', 'print'), 'all');
    assert.strictEqual(rewriteMediaText('screen, print', 'print'), 'not all, all');
    assert.strictEqual(rewriteMediaText('(min-width: 500px)', 'print'), '(min-width: 500px)', 'no media type is left alone');
    assert.strictEqual(rewriteMediaText('all', 'print'), 'all');
});

// ---- in the preview ----

const TEMPLATE = '/w/report.liquid';

async function htmlPreview(template, settings = {}) {
    for (const [name, value] of Object.entries(settings)) stub.settings.set('reporterLiquidPreview.selectPdf.' + name, value);
    stub.workspaceFiles.set(TEMPLATE, template);
    const preview = makePreview({ templateUri: TEMPLATE });
    const panel = makePanel();
    await extension.refreshHtmlPanel(preview, panel);
    return { preview, panel, page: panel.webview.html };
}

function configIn(html) {
    const dom = new JSDOM(html);
    return JSON.parse(dom.window.document.getElementById('lp-selectpdf-config').textContent);
}

test('the HTML preview has the toggle, the pages container and the paging script', async () => {
    const { page } = await htmlPreview('<p>hi</p>');
    assert.ok(chromeOf(page).includes('<input type="radio" name="lp-view" id="lp-selectpdf">PDF preview'), 'the tab is in the toolbar');
    assert.ok(page.includes('<div id="lp-pages"></div>'));
    assert.ok(page.includes('body:has(#lp-selectpdf:checked) #lp-rendered-root { display: none; }'));
    const script = page.slice(page.lastIndexOf('<script nonce=')).replace(/^<script[^>]*>/, '').replace(/<\/script>(?![\s\S]*<\/script>)[\s\S]*$/, '');
    assert.ok(script.includes('chooseNextBreak'), 'the last script is the paging one');
    assert.doesNotThrow(() => new vm.Script(script));
});

test('the template spec has none of it', async () => {
    stub.workspaceFiles.set(TEMPLATE, '<p>hi</p>');
    const panel = makePanel();
    await extension.refreshHtmlFullPanel(makePreview({ templateUri: TEMPLATE }), panel);
    assert.ok(!panel.webview.html.includes('lp-selectpdf'));
    assert.ok(!panel.webview.html.includes('id="lp-pages"'));
});

test('the settings reach the view', async () => {
    const { page } = await htmlPreview('<p>hi</p>', { pageSize: 'Letter', orientation: 'Landscape', webPageWidth: 800, cssMediaType: 'Print', header: { display: true, height: 40 } });
    const { geometry } = configIn(page);
    close(geometry.page.widthPt, 792, 'Letter landscape');
    assert.strictEqual(geometry.webPageWidth, 800);
    assert.strictEqual(geometry.cssMediaType, 'Print');
    assert.strictEqual(geometry.header.heightPt, 40);
    assert.ok(chromeOf(page).includes('Letter landscape · 800px'), 'and the toolbar says so');
});

test('the view pages the output as the template wrote it, not the balanced fragment', async () => {
    const template = '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>one</p></div></body></html>';
    const { page } = await htmlPreview(template);
    assert.strictEqual(configIn(page).html, template);
});

test('output that closes a script element cannot end the settings early', async () => {
    const { page } = await htmlPreview('<p>a</p><script>var x = "</script><b>escaped</b>";</script>');
    const config = configIn(page);
    assert.ok(config.html.includes('</script><b>escaped</b>'), 'the JSON round-trips');
    const json = page.slice(page.indexOf('id="lp-selectpdf-config">'), page.indexOf('</script>', page.indexOf('id="lp-selectpdf-config">')));
    assert.ok(!json.includes('<'), 'no < survives inside the JSON');
});

test('the workspace CSS goes with it, inlined', async () => {
    // The CSS is found on disk, next to the template, as the preview finds it.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-selectpdf-'));
    fs.mkdirSync(path.join(dir, 'css'));
    fs.writeFileSync(path.join(dir, 'css', 'site.css'), 'p { color: green }');
    const templateUri = path.join(dir, 'report.liquid');
    const config = extension.selectPdfConfig(templateUri, '<p>x</p>');
    assert.ok(config.css.includes('p { color: green }'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the PDF preview tab stays chosen across a live edit, and choosing it leaves the source view', async () => {
    const { panel } = await htmlPreview('<p>one</p>');
    const dom = new JSDOM(panel.webview.html, { runScripts: 'dangerously', virtualConsole: new VirtualConsole(), pretendToBeVisual: true });
    const { document } = dom.window;
    try {
        document.getElementById('lp-show-source').checked = true;
        const pages = document.getElementById('lp-selectpdf');
        pages.checked = true;
        pages.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        assert.strictEqual(document.getElementById('lp-show-source').checked, false, 'only one view at a time');

        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'update', chrome: chromeOf(panel.webview.html).replace('<div id="lp-chrome">', ''), rendered: '<p>two</p>' } }));
        assert.strictEqual(document.getElementById('lp-selectpdf').checked, true);
    } finally {
        dom.window.close();
    }
});

// ---- trying page settings ----

// The preview's page, live: its scripts run, as in the webview, with what it
// posts to the extension collected. jsdom can't lay out, so the PDF preview
// tab is left unchosen and nothing is paged; the panel and the page it works
// out are what's tested.
function livePage(page) {
    const posted = [];
    const dom = new JSDOM(page, {
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
        beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(message) }); }
    });
    const { document, Event } = dom.window;
    const set = (name, value) => {
        const input = document.querySelector(`[data-tune-field="${name}"]`);
        if (input.type === 'checkbox') input.checked = value; else input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const click = selector => document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const label = () => document.getElementById('lp-selectpdf-geometry').textContent;
    return { dom, document, posted, set, click, label };
}

test('the preview carries the settings, a description of the page it can change, and the panel\u2019s button', async () => {
    const { page } = await htmlPreview('<p>hi</p>', { marginLeft: 29, marginRight: 29 });
    const config = configIn(page);
    assert.strictEqual(config.settings.marginLeft, 29, 'the settings, to try others against');
    assert.ok(chromeOf(page).includes('<span id="lp-selectpdf-geometry">A4 portrait · 1024px layout at 70% on the page</span>'));
    assert.ok(chromeOf(page).includes('data-lp-local="tune-pages"'));
    assert.ok(page.includes('window.__rlpPageGeometry = module.exports'), 'the page geometry goes with the paging script');
});

test('values tried in the panel page the view as if they were the settings, until reverted', async () => {
    const { page } = await htmlPreview('<p>hi</p>', { marginLeft: 29, marginRight: 29, webPageWidth: 1024 });
    const live = livePage(page);
    try {
        live.click('[data-lp-local="tune-pages"]');
        const panel = live.document.getElementById('lp-tune');
        assert.ok(panel && !panel.hidden, 'the panel opens');
        assert.strictEqual(live.document.querySelector('[data-tune-field="marginLeft"]').value, '29', 'with the settings in it');
        assert.strictEqual(live.document.querySelector('[data-tune-field="pageSize"]').value, 'A4');
        assert.ok(live.document.querySelector('[data-tune="save"]').disabled, 'nothing to save yet');

        live.set('marginLeft', 0);
        live.set('marginRight', 0);
        assert.strictEqual(live.label(), 'A4 portrait · 1024px layout at 78% on the page · trying, not saved');
        assert.match(live.document.getElementById('lp-tune-readout').textContent, /shrunk to 77\.5% .* each page holds 1448px of it/);
        live.set('webPageWidth', 1000);
        assert.match(live.label(), /1000px layout at 79% on the page · trying/);
        assert.ok(!live.document.querySelector('[data-tune="save"]').disabled);

        live.click('[data-tune="revert"]');
        assert.strictEqual(live.label(), 'A4 portrait · 1024px layout at 70% on the page', 'back to the settings');
        assert.strictEqual(live.document.querySelector('[data-tune-field="marginLeft"]').value, '29');
    } finally {
        live.dom.window.close();
    }
});

test('a header or footer height is tried as its band, and 0 turns it off', async () => {
    const { page } = await htmlPreview('<p>hi</p>', { header: { display: true, height: 50, displayOnFirstPage: false } });
    const live = livePage(page);
    try {
        live.click('[data-lp-local="tune-pages"]');
        assert.strictEqual(live.document.querySelector('[data-tune-field="header"]').value, '50');
        live.set('header', 30);
        live.set('footer', 20);
        live.click('[data-tune="save"]');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(live.posted.filter(m => m.action === 'saveSelectPdfSettings'))), [{
            type: 'action', action: 'saveSelectPdfSettings',
            settings: { header: { display: true, height: 30, displayOnFirstPage: false }, footer: { display: true, height: 20 } }
        }], 'what was tried, keeping the band\u2019s other options');
        live.set('header', 0);
        assert.match(live.label(), /trying/);
        live.click('[data-tune="save"]');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(live.posted[live.posted.length - 1].settings.header)), { display: false, height: 50, displayOnFirstPage: false });
    } finally {
        live.dom.window.close();
    }
});

test('once saved, the values are the settings and no longer being tried', async () => {
    const { page } = await htmlPreview('<p>hi</p>', { marginLeft: 29, marginRight: 29 });
    const live = livePage(page);
    try {
        live.click('[data-lp-local="tune-pages"]');
        live.set('marginLeft', 0);
        assert.match(live.label(), /trying/);
        // The extension saves them; the settings change, and the preview is
        // rendered again with them (an update message, as in the webview).
        stub.settings.set('reporterLiquidPreview.selectPdf.marginLeft', 0);
        const again = await htmlPreview('<p>hi</p>');
        const chrome = chromeOf(again.page);
        live.document.getElementById('lp-chrome').innerHTML = chrome;
        live.dom.window.dispatchEvent(new live.dom.window.MessageEvent('message', { data: { type: 'update', chrome, rendered: '<p>hi</p>' } }));
        assert.strictEqual(live.label(), 'A4 portrait · 1024px layout at 74% on the page');
        assert.ok(live.document.querySelector('[data-tune="save"]').disabled);
    } finally {
        live.dom.window.close();
    }
});

test('saving writes the values that changed to the workspace settings', async () => {
    stub.vscode.workspace.workspaceFolders = [{ uri: stub.vscode.Uri.file('/w'), name: 'w', index: 0 }];
    try {
        stub.settings.set('reporterLiquidPreview.selectPdf.marginLeft', 29);
        stub.settings.set('reporterLiquidPreview.selectPdf.webPageWidth', 1024);
        await extension.saveSelectPdfSettings({ marginLeft: 0, webPageWidth: 1024, header: { display: true, height: 50 }, notASetting: 1 });
        assert.deepStrictEqual(stub.settingUpdates, [
            { key: 'reporterLiquidPreview.selectPdf.marginLeft', value: 0, target: stub.vscode.ConfigurationTarget.Workspace },
            { key: 'reporterLiquidPreview.selectPdf.header', value: { display: true, height: 50 }, target: stub.vscode.ConfigurationTarget.Workspace }
        ], 'only what changed, and only the page settings');
        assert.match(stub.shownMessages[0], /Saved 2 page settings to the workspace settings \(\.vscode\/settings\.json\): selectPdf\.marginLeft, selectPdf\.header\./);
    } finally {
        stub.vscode.workspace.workspaceFolders = [];
    }
});

test('with no folder open, saving goes to the user\u2019s settings', async () => {
    await extension.saveSelectPdfSettings({ marginTop: 10 });
    assert.deepStrictEqual(stub.settingUpdates.map(u => u.target), [stub.vscode.ConfigurationTarget.Global]);
    assert.match(stub.shownMessages[0], /to your user settings/);
});

// ---- a template's definition.json ----

// Reporter's definition.json for the small pot letter, as it is.
const LETTER_DEFINITION = {
    name: 'money-out-3_letter_l3066-select-pension-ufpls-small-pot-letter',
    renderer: 'selectwin8',
    fileName: 'L3066.pdf',
    settings: [
        { key: 'select.header.enabled', value: true },
        { key: 'select.footer.enabled', value: true },
        { key: 'select.footer.height', value: 60 }
    ]
};

const { definitionPageSettings } = require('../selectpdf-page');

test('a definition.json’s select.* settings are the page, with Reporter’s defaults for the rest', () => {
    const { settings, keys } = definitionPageSettings(JSON.stringify(LETTER_DEFINITION));
    assert.deepStrictEqual(settings, {
        customPageSize: { width: 595, height: 842 },
        orientation: 'Portrait',
        header: { display: true, height: 0, displayOnFirstPage: true },
        footer: { display: true, height: 60, displayOnFirstPage: true }
    });
    assert.deepStrictEqual(keys, ['select.header.enabled', 'select.footer.enabled', 'select.footer.height']);
    const g = pageGeometry(settings);
    assert.strictEqual(g.header, null, 'a header enabled with no height takes no room');
    close(g.content.height * 0.75, 842 - 60, 'the content area is the page less the footer');
    close(g.page.width * 0.75, 595, 'Reporter’s page width');
});

test('a definition with no select.* settings is Reporter’s default page: 595 x 842, no bands', () => {
    assert.deepStrictEqual(definitionPageSettings({ name: 'x' }).settings, {
        customPageSize: { width: 595, height: 842 }, orientation: 'Portrait', header: null, footer: null
    });
    const set = definitionPageSettings({ settings: [
        { key: 'select.widthPoints', value: '842' }, { key: 'select.heightPoints', value: 595 },
        { key: 'select.header.enabled', value: 'true' }, { key: 'select.header.height', value: '40' },
        { key: 'select.header.displayOnFirstPage', value: false },
        { key: 'select.footer.height', value: 30 },
        { key: 'select.header.pageNumbers.enabled', value: true }, { key: 'other', value: 1 }
    ] }).settings;
    assert.deepStrictEqual(set.customPageSize, { width: 842, height: 595 }, 'text values are read');
    assert.deepStrictEqual(set.header, { display: true, height: 40, displayOnFirstPage: false });
    assert.strictEqual(set.footer, null, 'a height without enabled is no footer');
    assert.strictEqual(definitionPageSettings('{ not json'), null);
    assert.strictEqual(definitionPageSettings('[1]'), null);
});

// A template on disk with a definition.json beside it, as Reporter's are.
function templateWithDefinition(definition) {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-definition-'));
    const template = path.join(dir, 'template.liquid');
    fs.writeFileSync(template, '<p>hi</p>');
    if (definition) fs.writeFileSync(path.join(dir, 'definition.json'), JSON.stringify(definition));
    return { template, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the preview pages a template on the page its definition.json sets, over the workspace settings', async () => {
    const { template, cleanup } = templateWithDefinition(LETTER_DEFINITION);
    try {
        for (const [name, value] of Object.entries({ pageSize: 'Letter', header: { display: true, height: 60 }, footer: { display: true, height: 60 }, marginLeft: 10 })) {
            stub.settings.set('reporterLiquidPreview.selectPdf.' + name, value);
        }
        const config = extension.selectPdfConfig(template, '<p>hi</p>');
        close(config.geometry.page.widthPt, 595, 'the definition’s page, not the workspace’s Letter');
        assert.strictEqual(config.geometry.header, null);
        assert.strictEqual(config.geometry.footer.heightPt, 60);
        close(config.geometry.margins.left * 0.75, 10, 'what the definition doesn’t set stays the workspace’s');
        assert.deepStrictEqual(config.definition, { file: 'definition.json', controls: ['pageSize', 'customPageSize', 'orientation', 'header', 'footer'] });

        stub.workspaceFiles.set(template, '<p>hi</p>');
        const panel = makePanel();
        await extension.refreshHtmlPanel(makePreview({ templateUri: template }), panel);
        assert.match(chromeOf(panel.webview.html), /<span id="lp-selectpdf-geometry">595×842pt portrait · 1024px layout at \d+% on the page · page from definition\.json<\/span>/);
    } finally {
        cleanup();
    }
});

test('without a definition.json the workspace settings are the page, as before', () => {
    const { template, cleanup } = templateWithDefinition(null);
    try {
        stub.settings.set('reporterLiquidPreview.selectPdf.footer', { display: true, height: 50 });
        const config = extension.selectPdfConfig(template, '<p>hi</p>');
        assert.strictEqual(config.definition, null);
        assert.strictEqual(config.geometry.footer.heightPt, 50);
    } finally {
        cleanup();
    }
});

test('for a template with a definition.json, the panel says where its page comes from and Save leaves it out', async () => {
    const { template, cleanup } = templateWithDefinition(LETTER_DEFINITION);
    try {
        stub.workspaceFiles.set(template, '<p>hi</p>');
        const panel = makePanel();
        await extension.refreshHtmlPanel(makePreview({ templateUri: template }), panel);
        const live = livePage(panel.webview.html);
        try {
            live.click('[data-lp-local="tune-pages"]');
            const note = live.document.getElementById('lp-tune-definition');
            assert.ok(!note.hidden && /definition\.json, which sets its page size, header and footer/.test(note.textContent));
            const size = live.document.querySelector('[data-tune-field="pageSize"]');
            assert.ok(size.disabled);
            assert.strictEqual(size.selectedOptions[0].textContent, '595 × 842pt', 'shown as the definition\u2019s size, not a named one');
            assert.strictEqual(live.document.querySelector('[data-tune-field="footer"]').value, '60', 'the definition’s footer');
            assert.match(live.document.getElementById('lp-tune-readout').textContent, /^The page is 595 × 842pt; less a 60pt footer, the content area is 595 × 782pt\./);

            live.set('footer', 70);
            assert.match(live.label(), /page from definition\.json · trying, not saved/, 'tried');
            assert.ok(live.document.querySelector('[data-tune="save"]').disabled, 'but there’s nothing the workspace settings decide to save');
            live.set('marginTop', 12);
            live.click('[data-tune="save"]');
            assert.deepStrictEqual(JSON.parse(JSON.stringify(live.posted.filter(m => m.action === 'saveSelectPdfSettings').map(m => m.settings))), [{ marginTop: 12 }]);
        } finally {
            live.dom.window.close();
        }

        await extension.saveSelectPdfSettings({ marginTop: 12, footer: { display: true, height: 70 } }, template);
        assert.deepStrictEqual(stub.settingUpdates.map(u => u.key), ['reporterLiquidPreview.selectPdf.marginTop'], 'the extension leaves it out too');
        assert.match(stub.shownMessages[0], /The footer tried come from this template's definition\.json, so weren't saved/);
    } finally {
        cleanup();
    }
});
