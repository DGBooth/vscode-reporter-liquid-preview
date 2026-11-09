// The preview is a string of HTML built by hand, so the things that can break
// it silently are escaping, unbalanced markup, and the inline webview script —
// none of which throw. These check the document that actually gets handed to
// the webview.

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const { extension, stub, harnessReset, makePreview, makePanel, chromeOf, paneOf } = require('./harness');

const TEMPLATE = '/w/report.liquid';

const rows = [
    { severity: 'error', title: 'Render error', message: 'x < y & "z"', file: '/w/a b/report.liquid', line: 12, col: 4, snippet: '{{ a | boom }}' },
    { severity: 'warning', title: 'Warning', message: 'value is missing', file: TEMPLATE, line: 3, col: 1, snippet: '{{ x | slice: 1 }}' },
    { severity: 'warning', title: 'Warning', message: 'value is missing', file: TEMPLATE, line: 3, col: 1, snippet: '{{ x | slice: 1 }}' },
    { severity: 'error', title: 'Data error', message: 'no position known', file: '/w/data.json', line: null, col: null, snippet: '' },
    { severity: 'error', title: 'Odd', message: 'no file at all', file: null, line: 7, col: 2, snippet: '' }
];

test.beforeEach(() => harnessReset());

test('no problems means no pane at all', () => {
    assert.strictEqual(extension.buildErrorPaneHtml([]), '');
    assert.strictEqual(extension.buildErrorPaneHtml(null), '');
});

test('the pane summarises what it holds', () => {
    const pane = extension.buildErrorPaneHtml(rows);
    assert.ok(pane.includes('3 errors and 1 warning'), pane.slice(0, 200));
});

test('errors are listed before warnings', () => {
    const pane = extension.buildErrorPaneHtml(rows);
    assert.ok(pane.indexOf('Render error') < pane.indexOf('Data error'));
    assert.ok(pane.indexOf('Data error') < pane.indexOf('&#9432; Warning'));
});

test('a position with a file is a button, and carries the path verbatim', () => {
    const pane = extension.buildErrorPaneHtml(rows);
    assert.ok(pane.includes('data-diag-file="/w/a b/report.liquid" data-diag-line="12" data-diag-col="4"'));
    assert.ok(pane.includes('>report.liquid:12:4</button>'));
    assert.ok(pane.includes('title="Go to line 12 in report.liquid"'));
});

test('a row with nowhere to jump to is plain text, not a dead button', () => {
    const pane = extension.buildErrorPaneHtml(rows);
    assert.ok(pane.includes('<span class="diag-where">data.json</span>'), 'a file with no line');
    assert.ok(pane.includes('<span class="diag-where">line 7:2</span>'), 'a line with no file');
});

test('message and snippet text is escaped', () => {
    const pane = extension.buildErrorPaneHtml(rows);
    assert.ok(pane.includes('x &lt; y &amp; &quot;z&quot;'));
    assert.ok(!pane.includes('x < y & "z"'));
});

test('a title or path carrying markup cannot break out of its attribute', () => {
    const pane = extension.buildErrorPaneHtml([{
        severity: 'error',
        title: '<script>bad()</script>',
        message: 'ok',
        file: '/w/"><script>bad()</script>.liquid',
        line: 1,
        col: 1,
        snippet: '<img onerror="bad()">'
    }]);
    assert.ok(!pane.includes('<script>'), pane);
    assert.ok(!pane.includes('<img '), pane);
});

test('the pane markup is balanced', () => {
    const pane = extension.buildErrorPaneHtml(rows);
    assert.strictEqual((pane.match(/<div\b/g) || []).length, (pane.match(/<\/div>/g) || []).length);
    assert.strictEqual((pane.match(/<button\b/g) || []).length, (pane.match(/<\/button>/g) || []).length);
});

test('the inline webview script is valid JavaScript', () => {
    const page = extension.buildPreviewHtml('', extension.buildErrorPaneHtml(rows), '<p>hi</p>', extension.htmlPreviewStyles);
    const script = page.slice(page.lastIndexOf('<script nonce=')).replace(/^<script[^>]*>/, '').replace(/<\/script>(?![\s\S]*<\/script>)[\s\S]*$/, '');

    assert.doesNotThrow(() => new vm.Script(script), 'the script is embedded in a template literal, so escaping can break it');
    assert.ok(script.includes('acquireVsCodeApi'));
    assert.ok(script.includes(".closest('.diag-goto')"));
    assert.ok(script.includes("type: 'reveal'"));
});

test('the collapse checkbox sits inside the pane, where the CSS and the update handler look for it', () => {
    const page = extension.buildPreviewHtml('', extension.buildErrorPaneHtml(rows), '<p>hi</p>', extension.htmlPreviewStyles);
    const checkbox = page.indexOf('id="lp-hide-problems"');

    assert.ok(checkbox > page.indexOf('<div id="error-pane">'));
    assert.ok(checkbox < page.indexOf('<div id="lp-rendered-root">'));
    assert.ok(page.includes('#error-pane:has(#lp-hide-problems:checked) .diag-list'), 'the CSS that hides the list');
    assert.ok(page.includes("'.lp-toggle input[id], .lp-tab input[id], #error-pane input[id]'"), 'the state kept across in-place updates');
});

test('the pane sits in the chrome half, never in the rendered document', async () => {
    stub.workspaceFiles.set(TEMPLATE, '{{ nope | slice: 1 }}');
    stub.workspaceFiles.set('/w/data.json', '{}');
    const panel = makePanel();

    await extension.refreshHtmlPanel(makePreview({ templateUri: TEMPLATE, dataUri: '/w/data.json' }), panel);
    const page = panel.webview.html;

    // Stop at the inline script, which names the pane in a selector of its own.
    const renderedHalf = page.slice(page.indexOf('<div id="lp-rendered-root">'), page.indexOf('<script nonce='));
    assert.ok(chromeOf(page).includes('<div id="error-pane">'));
    assert.ok(!renderedHalf.includes('error-pane'), renderedHalf);
});

test('a later refresh patches the panel instead of reloading it', async () => {
    stub.workspaceFiles.set(TEMPLATE, '<p>one</p>');
    stub.workspaceFiles.set('/w/data.json', '{}');
    const preview = makePreview({ templateUri: TEMPLATE, dataUri: '/w/data.json' });
    const panel = makePanel();

    await extension.refreshHtmlPanel(preview, panel);
    stub.workspaceFiles.set(TEMPLATE, '<p>two</p>');
    preview.templateDirty = true;
    await extension.refreshHtmlPanel(preview, panel);

    assert.strictEqual(panel.documents.length, 1, 'the document is only ever set once');
    assert.strictEqual(panel.messages.length, 1);
    assert.strictEqual(panel.messages[0].type, 'update');
    assert.ok(panel.messages[0].rendered.includes('<p>two</p>'));
});

test('the rendered output survives a template that stops parsing', async () => {
    stub.workspaceFiles.set(TEMPLATE, '<p>good</p>');
    stub.workspaceFiles.set('/w/data.json', '{}');
    const preview = makePreview({ templateUri: TEMPLATE, dataUri: '/w/data.json' });
    const panel = makePanel();

    await extension.refreshHtmlPanel(preview, panel);
    stub.workspaceFiles.set(TEMPLATE, '<p>good</p>{% if x %}');
    preview.templateDirty = true;
    await extension.refreshHtmlPanel(preview, panel);

    assert.ok(panel.messages[0].rendered.includes('<p>good</p>'), 'the last good render stays on screen');
    assert.ok(paneOf(panel.messages[0].chrome).includes('not closed'));
});

test('the Full HTML Preview keeps its toolbar alongside the pane', async () => {
    stub.workspaceFiles.set(TEMPLATE, '{% choice "c" %}A{% or %}B{% endchoice %}\n{% if x %}\n');
    const panel = makePanel();

    await extension.refreshHtmlFullPanel(makePreview({ templateUri: TEMPLATE }), panel);
    const chrome = chromeOf(panel.webview.html);

    assert.ok(chrome.includes('data-lp-action="exportSpec"'), 'the export button');
    assert.ok(paneOf(chrome).includes('Template error'));
    assert.ok(panel.webview.html.includes('Template specification'), 'and the spec beside it');
});

// ---- only the extension's own scripts run ----

test('the preview allows only its own scripts: a nonce on each, and a policy naming it', () => {
    const page = extension.buildPreviewHtml('', '', '<p>hi</p><script>templateScript()</script>', extension.htmlPreviewStyles, { defaultName: '' }, { pages: true, cspSource: 'https://webview.test' });
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page)[1];
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)[1];
    assert.ok(policy.startsWith("default-src 'none'"), policy);
    assert.ok(!/script-src[^;]*unsafe/.test(policy), 'no inline or eval scripts');
    assert.ok(policy.includes('style-src https://webview.test'), 'the workspace stylesheets load');

    const scripts = page.match(/<script\b[^>]*>/g);
    const ours = scripts.filter(tag => tag.includes(`nonce="${nonce}"`));
    assert.strictEqual(ours.length, 3, 'the preview, the test builder and the pages view');
    // Whatever else is a script is data (the builder's styles) or the template's own, which has no nonce.
    for (const tag of scripts.filter(tag => !ours.includes(tag))) {
        assert.ok(tag === '<script>' || /type="(text\/plain|application\/json)"/.test(tag), tag);
    }
    assert.ok(page.includes('<script>templateScript()</script>'), 'the template\'s script is left as written, and has no nonce');
    assert.notStrictEqual(nonce, /script-src 'nonce-([^']+)'/.exec(extension.buildPreviewHtml('', '', ''))[1], 'a new nonce for each document');
});

test('a changed stylesheet is linked again without reloading the preview', () => {
    const { JSDOM, VirtualConsole } = require('jsdom');
    const page = extension.buildPreviewHtml('<link rel="stylesheet" data-lp-css href="/w/css/site.css">', '', '<p>hi</p>');
    const dom = new JSDOM(page, { runScripts: 'dangerously', virtualConsole: new VirtualConsole() });
    try {
        const { document } = dom.window;
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'css', links: '<link rel="stylesheet" data-lp-css href="/w/css/site.css?v=2">' } }));
        const links = [...document.querySelectorAll('link[data-lp-css]')].map(link => link.getAttribute('href'));
        assert.deepStrictEqual(links, ['/w/css/site.css?v=2']);
        assert.ok(document.getElementById('lp-rendered-root').innerHTML.includes('<p>hi</p>'), 'the content is untouched');
    } finally {
        dom.window.close();
    }
});

test('relative addresses in a stylesheet inlined for the pages view point at the files', () => {
    const webview = { asWebviewUri: uri => 'https://res.test' + uri.fsPath };
    const css = '@import "base.css"; @font-face { src: url(fonts/a%20b.woff2?v=1#x) } p { background: url("../img/bg.png"), url(data:image/png;base64,AAAA), url(https://cdn.test/x.png), url(/abs.png) }';
    const out = extension.rebaseCssUrls(css, '/w/letters/css/site.css', webview);
    assert.ok(out.includes('@import "https://res.test/w/letters/css/base.css"'), out);
    assert.ok(out.includes('url("https://res.test/w/letters/css/fonts/a b.woff2?v=1#x")'), out);
    assert.ok(out.includes('url("https://res.test/w/letters/img/bg.png")'), out);
    assert.ok(out.includes('url("data:image/png;base64,AAAA")') && out.includes('url("https://cdn.test/x.png")') && out.includes('url("/abs.png")'), 'absolute addresses are left alone');
});

test('refreshes waiting their turn are run as one', async () => {
    const preview = {};
    const ran = [];
    let release;
    const first = extension.queueRefresh(preview, () => new Promise(resolve => { ran.push('first'); release = resolve; }));
    await Promise.resolve();
    // The first is under way; three more edits arrive before it finishes.
    const second = extension.queueRefresh(preview, () => { ran.push('second'); });
    const third = extension.queueRefresh(preview, () => { ran.push('third'); });
    assert.strictEqual(second, third, 'the later edits share the refresh already waiting');
    release();
    await Promise.all([first, second]);
    assert.deepStrictEqual(ran, ['first', 'second']);
    // Nothing waiting any more: the next edit gets a refresh of its own.
    await extension.queueRefresh(preview, () => { ran.push('fourth'); });
    assert.deepStrictEqual(ran, ['first', 'second', 'fourth']);
});
