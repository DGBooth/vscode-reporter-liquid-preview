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

test('titles are headings for the adviser while editing, and never part of the PDF', async () => {
    const text = '{% optional "ps", title: "Add a PS" %}<p>PS</p>{% endoptional %}'
        + '{% editor "note", title: "Your note", placeholder: "Type here" %}{% endeditor %}'
        + '{% choice "sign", title: "Sign off" %}<p>A</p>{% or %}<p>B</p>{% endchoice %}';
    const data = { fields: { ps: 'true', note: 'Hello', sign: '1' } };
    const editing = await render(text, data, 'edit');
    for (const title of ['Add a PS', 'Your note', 'Sign off']) {
        assert.ok(editing.includes(`<span class="editor-intro">${title}</span>`), `${title} while editing`);
    }
    assert.strictEqual(await render(text, data, 'view'), '<p>PS</p>Hello<p>B</p>', 'the PDF: answers only, no titles or placeholders');
});

test('what is between the editor tags is the box’s starting text', async () => {
    const line = await render('{% editor "amount" %}1500{% endeditor %}', {}, 'edit');
    assert.match(line, /<input type="text" id="amount"[^>]* placeholder="" value="1500">/);
    const box = await render('{% editor "note", lines: 3 %}Dear client{% endeditor %}', {}, 'edit');
    assert.match(box, /<textarea id="note"[^>]*>Dear client<\/textarea>/);
    assert.strictEqual(await render('{% editor "note" %}Dear client{% endeditor %}', {}, 'view'), 'Dear client', 'and what goes to the PDF if it’s left as it is');
});

test('an answer replaces the starting text, even an empty one', async () => {
    const text = '{% editor "amount" %}1500{% endeditor %}';
    assert.match(await render(text, { fields: { amount: '2000' } }, 'edit'), /value="2000"/);
    assert.strictEqual(await render(text, { fields: { amount: '2000' } }, 'view'), '2000');
    assert.strictEqual(await render(text, { fields: { amount: '' } }, 'view'), '', 'a box the reader cleared stays clear');
});

test('the starting text is the field’s value until it’s answered', async () => {
    assert.strictEqual(await render('{% editor "amount" %}1500{% endeditor %}[{{ fields.amount }}]', {}, 'view'), '1500[1500]');
    assert.strictEqual(await render('[{{ fields.amount }}]{% editor "amount" %}1500{% endeditor %}', {}, 'view'), '[1500]1500', 'read before the tag, too');
});

test('the starting text can come from the data, and the tag’s layout doesn’t add to it', async () => {
    assert.match(await render('{% editor "to" %}{{ client.name }}{% endeditor %}', { client: { name: 'Ada' } }, 'edit'), /value="Ada"/);
    const laidOut = '{%- editor "note", lines: 3 %}\n\tLine one\n\tLine two\n{%- endeditor %}';
    assert.match(await render(laidOut, {}, 'edit'), /<textarea[^>]*>Line one\n\tLine two<\/textarea>/);
    assert.match(await render('{% editor "e", placeholder: "Type here" %}{% endeditor %}', {}, 'edit'), /placeholder="Type here" value=""/, 'nothing between the tags: an empty box with its placeholder');
});

// A choice named per item, as in a loop over a report's provisions. Its name
// came from the template's own variables, which weren't looked in, so it had
// none: its radio buttons weren't one group, choosing one didn't clear the
// other, and the choice had no field.
const PER_PROVISION = '{% for p in provisions %}'
    + '{% assign protection = "protection" | append: p.urn %}'
    + '{% choice protection, title: "Annuity protection" %}<p>Yes</p>{% or %}<p>No</p>{% endchoice %}'
    + '[{{ fields[protection] }}]'
    + '{% endfor %}';
const PROVISIONS = { provisions: [{ urn: 'A1' }, { urn: 'B2' }] };

test('a field named by the template’s own variables has that name', async () => {
    const names = async (text, data) => [...(await render(text, data, 'edit')).matchAll(/<input type="(?:radio|checkbox|text)" id="[^"]*" name="([^"]*)"|<input type="text" id="([^"]*)"/g)].map(m => m[1] || m[2]);
    assert.deepStrictEqual(await names(PER_PROVISION, PROVISIONS), ['protectionA1', 'protectionA1', 'protectionB2', 'protectionB2'], 'from assign, in a loop');
    assert.deepStrictEqual(await names('{% capture n %}ps{{ 1 }}{% endcapture %}{% optional n %}x{% endoptional %}', {}), ['ps1'], 'from capture');
    assert.deepStrictEqual(await names('{% for p in ps %}{% editor p.ref %}{% endeditor %}{% endfor %}', { ps: [{ ref: 'note' }] }), ['note'], 'from a loop variable’s property');
});

test('a choice’s value is its option’s number from 0, under fields, before and after it’s answered', async () => {
    const before = await render(PER_PROVISION, PROVISIONS, 'edit');
    assert.deepStrictEqual([...before.matchAll(/\[(\d*)\]/g)].map(m => m[1]), ['0', '0'], 'the first option until answered');
    const after = await render(PER_PROVISION, Object.assign({ fields: { protectionB2: '1' } }, PROVISIONS), 'edit');
    assert.deepStrictEqual([...after.matchAll(/\[(\d*)\]/g)].map(m => m[1]), ['0', '1']);
    assert.deepStrictEqual([...after.matchAll(/id="(protection\w+-\d)"[^>]*checked=""/g)].map(m => m[1]), ['protectionA1-1', 'protectionB2-2'], 'one option checked in each');
});

test('choosing the other option clears the first, in the preview', async () => {
    const { preview, panel, page } = await htmlPreview(PER_PROVISION, { data: PROVISIONS });
    const posted = [];
    const dom = new JSDOM(page, {
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
        beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(message) }); }
    });
    try {
        const { document, Event } = dom.window;
        const no = document.getElementById('protectionB2-2');
        no.checked = true;
        no.dispatchEvent(new Event('change', { bubbles: true }));
        assert.strictEqual(document.getElementById('protectionB2-1').checked, false, 'one group: the browser clears Yes');
        assert.strictEqual(document.getElementById('protectionA1-1').checked, true, 'another provision’s choice is its own');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'action', action: 'setField', name: 'protectionB2', value: '1' }]);
    } finally {
        dom.window.close();
    }
    preview.fieldAnswers = { protectionB2: '1' };
    await extension.refreshHtmlPanel(preview, panel);
    const rendered = panel.messages[panel.messages.length - 1].rendered;
    assert.deepStrictEqual([...rendered.matchAll(/id="(protection\w+-\d)"[^>]*checked=""/g)].map(m => m[1]), ['protectionA1-1', 'protectionB2-2'], 'and the render with the answer agrees');
});

test('a field whose name has no value is warned about, not left to fail silently', async () => {
    const result = await engine.renderForTest('{% choice missingName %}A{% or %}B{% endchoice %}', {}, TEMPLATE);
    assert.strictEqual(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0].message, /name comes from missingName, which has no value here/);
    assert.strictEqual(result.diagnostics[0].line, 1);
});
