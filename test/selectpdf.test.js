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
    assert.strictEqual(describeGeometry(pageGeometry({})), 'A4 portrait · 1024px at 78%');
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
    assert.ok(chromeOf(page).includes('id="lp-selectpdf"'), 'the toggle is in the toolbar');
    assert.ok(page.includes('<div id="lp-pages"></div>'));
    assert.ok(page.includes('body:has(#lp-selectpdf:checked) #lp-rendered-root { display: none; }'));
    const script = page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
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

test('the toggle stays on across a live edit, and turning it on turns the source view off', async () => {
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
