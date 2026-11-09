// The template's fields (optional, choice, editor) as Reporter has them: an
// edit mode where they are answered and a view of the document with the
// answers applied, the answers readable as fields.<name>, and the HTML
// preview's own edit mode, where answering a field renders the page again.

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const engine = require('../engine');
const { extension, stub, harnessReset, makePreview, makePanel, chromeOf } = require('./harness');

const TEMPLATE = '/w/letter.liquid';
const LETTER = '<p>Dear {{ name }}</p>'
    + '{% optional "ps" %}<p>PS see you soon</p>{% endoptional %}'
    + '{% choice "sign", title: "Sign off" %}<p>Yours sincerely</p>{% or %}<p>Yours faithfully</p>{% endchoice %}'
    + '{% editor "note", lines: 3 %}{% endeditor %}';

const render = async (text, data, mode) => (await engine.renderForTest(text, data, TEMPLATE, { mode })).html;

test.beforeEach(() => harnessReset());

// ---- the answers, as fields.<name> ----

test('an unanswered field reads as Reporter gives it: false, 0 and nothing', async () => {
    const text = '[{{ fields.ps }}|{{ fields.sign }}|{{ fields.note }}]' + LETTER;
    assert.match(await render(text, {}, 'view'), /^\[false\|0\|\]/);
    assert.match(await render(text, { fields: { ps: 'true', sign: '1', note: 'hi' } }, 'view'), /^\[true\|1\|hi\]/);
});

test('a condition on an unanswered field sees its answer, even above the tag', async () => {
    const text = '{% if fields.ps == "false" %}no ps{% endif %}{% optional "ps" %}x{% endoptional %}';
    assert.ok((await render(text, {}, 'view')).startsWith('no ps'));
    assert.ok(!(await render(text, { fields: { ps: 'true' } }, 'view')).startsWith('no ps'));
});

test('a field that only appears once another is answered gets its answer too', async () => {
    const text = '{{ fields.inner }}{% if fields.outer == "false" %}{% optional "inner" %}x{% endoptional %}{% endif %}{% optional "outer" %}y{% endoptional %}';
    assert.ok((await render(text, {}, 'view')).startsWith('false'));
});

test('a name that is not a field of the template stays empty, and the data is not written to', async () => {
    const data = { fields: { sign: '1' } };
    assert.strictEqual(await render('[{{ fields.other }}]{% optional "ps" %}x{% endoptional %}{{ fields.ps }}', data, 'view'), '[]false');
    assert.deepStrictEqual(data, { fields: { sign: '1' } });
});

test('listing the fields includes the unanswered ones', async () => {
    assert.strictEqual(await render('{% optional "ps" %}{% endoptional %}{{ fields | json: 0 }}', { fields: { a: '1' } }, 'view'), '{"a":"1","ps":"false"}');
});

// ---- the two modes ----

test('view mode is the document with the answers applied and no controls', async () => {
    const html = await render(LETTER, { name: 'Ada', fields: { ps: 'true', sign: '1', note: 'Line <one>\nline two' } }, 'view');
    assert.strictEqual(html, '<p>Dear Ada</p><p>PS see you soon</p><p>Yours faithfully</p>Line &lt;one&gt;<br>line two');
});

test('view mode, unanswered: the optional part is left out and the first choice is taken', async () => {
    assert.strictEqual(await render(LETTER, { name: 'Ada' }, 'view'), '<p>Dear Ada</p><p>Yours sincerely</p>');
});

test('edit mode is unchanged: the controls, set to the answers', async () => {
    const html = await render(LETTER, { fields: { ps: 'true', sign: '1' } });
    assert.match(html, /<input type="checkbox" id="ps"[^>]* checked="">/);
    assert.match(html, /<input type="radio" id="sign-2"[^>]* checked="">/);
    assert.ok(html.includes('<textarea id="note"'));
    assert.strictEqual(html, await render(LETTER, { fields: { ps: 'true', sign: '1' } }, 'edit'));
});

// ---- in the HTML preview ----

async function htmlPreview(template, set = {}) {
    stub.workspaceFiles.set(TEMPLATE, template);
    const preview = Object.assign(makePreview({ templateUri: TEMPLATE }), set);
    const panel = makePanel();
    await extension.refreshHtmlPanel(preview, panel);
    return { preview, panel, page: panel.webview.html };
}

const renderedOf = page => page.slice(page.indexOf('<div id="lp-rendered-root">'), page.indexOf('<div id="lp-pages">'));
const pagedOf = page => JSON.parse(new JSDOM(page).window.document.getElementById('lp-selectpdf-config').textContent).html;

test('the preview opens on the Edit tab, and the PDF preview pages the document as it is read', async () => {
    const { page } = await htmlPreview(LETTER);
    const tabs = [...chromeOf(page).matchAll(/<input type="radio" name="lp-view" id="([^"]+)"( checked)?>([^<]+)/g)].map(m => [m[1], m[3], !!m[2]]);
    assert.deepStrictEqual(tabs, [['lp-view-edit', 'Edit', true], ['lp-selectpdf', 'PDF preview', false], ['lp-show-source', 'HTML source', false]]);
    assert.ok(!chromeOf(page).includes('type="checkbox"'), 'tabs, not checkboxes');
    assert.ok(renderedOf(page).includes('type="checkbox"'), 'the fields can be answered');
    assert.strictEqual(pagedOf(page), '<p>Dear </p><p>Yours sincerely</p>', 'no controls in the PDF');
});

test('an answer given in the preview is rendered, laid over the data file\'s, and can be reset', async () => {
    const { preview, panel } = await htmlPreview(LETTER, { data: { name: 'Ada', fields: { sign: '1' } }, fieldAnswers: { ps: 'true' } });
    assert.match(renderedOf(panel.webview.html), /id="ps"[^>]* checked=""/);
    assert.match(renderedOf(panel.webview.html), /id="sign-2"[^>]* checked=""/, 'the data file\'s answer still holds');
    assert.ok(pagedOf(panel.webview.html).includes('PS see you soon'));
    assert.ok(chromeOf(panel.webview.html).includes('data-lp-action="resetFields"'));
    assert.deepStrictEqual(preview.data, { name: 'Ada', fields: { sign: '1' } }, 'the data itself is untouched');

    preview.fieldAnswers = {};
    await extension.refreshHtmlPanel(preview, panel);
    assert.ok(!panel.chrome().includes('resetFields'));
    assert.ok(!panel.messages[panel.messages.length - 1].rendered.includes('checked="" ><span class="optional-content">'));
});

test('answering a field is posted to the extension, and choosing a tab is not', async () => {
    const { page } = await htmlPreview(LETTER);
    const posted = [];
    const dom = new JSDOM(page, {
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
        beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(message) }); }
    });
    try {
        const { document, Event } = dom.window;
        const change = input => input.dispatchEvent(new Event('change', { bubbles: true }));
        const tick = document.getElementById('ps');
        tick.checked = true;
        change(tick);
        const radio = document.getElementById('sign-2');
        radio.checked = true;
        change(radio);
        const text = document.getElementById('note');
        text.value = 'typed';
        change(text);
        const pdf = document.getElementById('lp-selectpdf');
        pdf.checked = true;
        change(pdf);
        assert.strictEqual(document.getElementById('lp-view-edit').checked, false, 'one tab at a time');
        // Through JSON: the messages are objects of the page's own, not of this one.
        assert.deepStrictEqual(JSON.parse(JSON.stringify(posted)), [
            { type: 'action', action: 'setField', name: 'ps', value: 'true' },
            { type: 'action', action: 'setField', name: 'sign', value: '1' },
            { type: 'action', action: 'setField', name: 'note', value: 'typed' }
        ]);
    } finally {
        dom.window.close();
    }
});
