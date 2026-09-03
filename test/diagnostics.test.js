// Every problem the preview reports has to say where it is. These drive real
// preview refreshes over fixture files and check the position each entry lands
// on, the Problems-panel rows that mirror them, and the cases where a position
// is deliberately withheld.

const test = require('node:test');
const assert = require('node:assert');

const {
    extension, stub, harnessReset, makePreview, makePanel, paneOf, renderPreview,
    settle, positionsIn, messagesIn
} = require('./harness');

const TEMPLATE = '/w/report.liquid';
const DATA = '/w/data.json';

// Lines are numbered in the comments so the expected positions below can be
// read against the source without counting.
const FIXTURE = [
    '<h1>Report</h1>',                                      // 1
    '{% editor "patientName", lines: 1 %}{% endeditor %}',  // 2
    '<p>Owner: {{ owner.name }}</p>',                       // 3
    '{% for item in items %}',                              // 4
    '  <li>{{ item.code | slice: 0, 3 }}</li>',             // 5
    '{% endfor %}',                                         // 6
    '{% editor "patientName" %}{% endeditor %}',            // 7
    '<p>{{ missingList | sort: "name" | json }}</p>',       // 8
    ''
].join('\n');

const DATA_JSON = '{\n  "items": [ {}, {}, {} ],\n  "owner": { "name": "Ada" }\n}\n';

test.beforeEach(() => harnessReset());

test('a filter warning points at the output tag that ran the filter', async () => {
    const { pane } = await renderPreview({ template: FIXTURE, data: DATA_JSON });

    const slice = positionsIn(pane).find(p => p.line === 5);
    assert.deepStrictEqual(slice, { file: TEMPLATE, line: 5, col: 7 });
    assert.ok(pane.includes('slice filter: value is missing'));
    assert.ok(pane.includes('{{ item.code | slice: 0, 3 }}'), 'quotes the offending source');
});

test('a filter warning outside a loop is located too', async () => {
    const { pane } = await renderPreview({ template: FIXTURE, data: DATA_JSON });
    assert.deepStrictEqual(positionsIn(pane).find(p => p.line === 8), { file: TEMPLATE, line: 8, col: 4 });
});

test('the same warning on every iteration collapses to one row with a count', async () => {
    const { pane } = await renderPreview({ template: FIXTURE, data: DATA_JSON });

    const sliceRows = messagesIn(pane).filter(m => m.includes('slice filter'));
    assert.strictEqual(sliceRows.length, 1, 'three iterations, one row');
    assert.ok(pane.includes('&times;3'), 'and the count says three');
});

test('a duplicate field name points at the repeat and names the first use', async () => {
    const { pane } = await renderPreview({ template: FIXTURE, data: DATA_JSON });

    assert.ok(pane.includes('Duplicate field name'));
    assert.ok(pane.includes('It is first used on line 2.'));
    assert.deepStrictEqual(positionsIn(pane).find(p => p.line === 7), { file: TEMPLATE, line: 7, col: 1 });
});

test('a template that does not parse is located at the tag left open', async () => {
    const { pane } = await renderPreview({ template: 'a\nb\n{% if x %}\nnever closed\n', data: '{}' });

    assert.ok(pane.includes('Template error'));
    assert.ok(pane.includes('tag {% if x %} not closed'));
    assert.ok(!/line:\d+/.test(pane), 'the position is shown as a link, not repeated in the prose');
    assert.deepStrictEqual(positionsIn(pane), [{ file: TEMPLATE, line: 3, col: 1 }]);
});

test('warnings from a stale template are dropped rather than mislocated', async () => {
    stub.workspaceFiles.set(TEMPLATE, FIXTURE);
    stub.workspaceFiles.set(DATA, DATA_JSON);
    const preview = makePreview({ templateUri: TEMPLATE, dataUri: DATA });

    await extension.refreshHtmlPanel(preview, makePanel());

    // Break the template. The preview keeps rendering the last version that
    // parsed, so its warnings describe lines that are no longer there.
    stub.workspaceFiles.set(TEMPLATE, 'a\nb\n{% if x %}\n');
    preview.templateDirty = true;
    const panel = makePanel();
    await extension.refreshHtmlPanel(preview, panel);
    const pane = paneOf(panel.chrome());

    assert.ok(pane.includes('tag {% if x %} not closed'));
    assert.ok(!pane.includes('slice filter'), 'no warning from the version that is gone');
    assert.ok(!pane.includes('Duplicate field name'));
    assert.deepStrictEqual(positionsIn(pane), [{ file: TEMPLATE, line: 3, col: 1 }]);
});

test('a broken data file is located in the JSON, not the template', async () => {
    const broken = '{\n  "items": [],\n  "owner": { "name": "Ada" \n}\n';
    const { pane } = await renderPreview({ template: FIXTURE, data: broken });

    assert.ok(pane.includes('Data error'));
    const dataPosition = positionsIn(pane).find(p => p.file === DATA);
    assert.ok(dataPosition, 'the entry points into the data file');
    assert.ok(dataPosition.line >= 3, `expected a position past the unclosed object, got line ${dataPosition.line}`);
});

test('jsonDiagnostic turns a parse failure into a line and column', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    let err;
    try { JSON.parse(text); } catch (caught) { err = caught; }

    const item = extension.jsonDiagnostic('Data error', err, text, DATA);
    assert.strictEqual(item.severity, 'error');
    assert.strictEqual(item.file, DATA);
    assert.strictEqual(item.line, 3);
    assert.strictEqual(item.snippet, '"b": 2');
    assert.ok(!/position \d+/.test(item.message), 'the raw offset is not repeated in the prose');
});

test('jsonDiagnostic falls back to a character offset when that is all it gets', () => {
    const text = 'line one\nline two\nline three';
    const err = new Error('Unexpected token x in JSON at position 12');
    const item = extension.jsonDiagnostic('Data error', err, text, DATA);

    assert.strictEqual(item.line, 2);
    assert.strictEqual(item.col, 4);
    assert.strictEqual(item.message, 'Unexpected token x');
});

test('jsonDiagnostic reports the problem even with no position to give', () => {
    const item = extension.jsonDiagnostic('Data error', new Error('cannot open the file'), '', DATA);
    assert.strictEqual(item.line, null);
    assert.strictEqual(item.message, 'cannot open the file');
});

test('cleanLiquidMessage strips the position LiquidJS appends', () => {
    assert.strictEqual(
        extension.cleanLiquidMessage('tag {% if x %} not closed, line:3, col:1'),
        'tag {% if x %} not closed');
    assert.strictEqual(
        extension.cleanLiquidMessage('oops, file:a.liquid, line:9, col:4'),
        'oops');
    assert.strictEqual(
        extension.cleanLiquidMessage('nothing to strip'),
        'nothing to strip');
});

test('tokenLocation collapses a multi-line construct onto one readable line', () => {
    const location = extension.tokenLocation({ line: 4, col: 2, raw: '{% if a\n   and b %}' });
    assert.deepStrictEqual(location, { line: 4, col: 2, snippet: '{% if a and b %}' });
    assert.strictEqual(extension.tokenLocation(null), null);
    assert.strictEqual(extension.tokenLocation({ col: 1 }), null, 'a token with no line has no position');
});

test('snippetOf caps a very long construct', () => {
    const snippet = extension.snippetOf('{{ ' + 'x'.repeat(300) + ' }}');
    assert.strictEqual(snippet.length, 120);
    assert.ok(snippet.endsWith('…'));
});

test('dedupeDiagnostics merges only genuinely identical rows', () => {
    const row = (over = {}) => Object.assign(
        { severity: 'warning', title: 'Warning', message: 'm', file: 'f', line: 1, col: 1, snippet: '' }, over);

    assert.strictEqual(extension.dedupeDiagnostics([row(), row()])[0].count, 2);
    assert.strictEqual(extension.dedupeDiagnostics([row(), row({ line: 2 })]).length, 2);
    assert.strictEqual(extension.dedupeDiagnostics([row(), row({ file: 'g' })]).length, 2);
    // The key is built from the fields, so a separator inside one of them
    // cannot make two different rows look the same.
    assert.strictEqual(
        extension.dedupeDiagnostics([row({ title: 'a | b', message: 'c' }), row({ title: 'a', message: 'b | c' })]).length,
        2);
});

test('the problems reach the Problems panel as located diagnostics', async () => {
    await renderPreview({ template: FIXTURE, data: DATA_JSON });

    const rows = stub.publishedDiagnostics.get(TEMPLATE) || [];
    assert.strictEqual(rows.length, 3, 'one duplicate name and two filter warnings');

    const warning = rows.find(d => d.message.includes('slice filter'));
    assert.strictEqual(warning.severity, 'Warning');
    // 0-based, and wide enough to underline the whole output tag.
    assert.strictEqual(String(warning.range), '4:6-4:35');

    const error = rows.find(d => d.message.includes('Duplicate field name'));
    assert.strictEqual(error.severity, 'Error');
    assert.strictEqual(error.range.start.line, 6);
});

test('closing a preview clears its diagnostics', async () => {
    const { preview } = await renderPreview({ template: FIXTURE, data: DATA_JSON });
    assert.ok((stub.publishedDiagnostics.get(TEMPLATE) || []).length > 0);

    extension.clearPreviewDiagnostics(preview);
    assert.strictEqual(stub.publishedDiagnostics.size, 0);
});

test('two previews of one template do not double up in the Problems panel', async () => {
    const first = await renderPreview({ template: FIXTURE, data: DATA_JSON });
    const second = await renderPreview({ template: FIXTURE, data: DATA_JSON });

    assert.strictEqual((stub.publishedDiagnostics.get(TEMPLATE) || []).length, 3);

    extension.clearPreviewDiagnostics(first.preview);
    assert.strictEqual((stub.publishedDiagnostics.get(TEMPLATE) || []).length, 3,
        'the surviving preview keeps its own');
    extension.clearPreviewDiagnostics(second.preview);
    assert.strictEqual(stub.publishedDiagnostics.size, 0);
});

test('a clean template and data report nothing at all', async () => {
    const { pane } = await renderPreview({
        template: '<p>{{ owner.name }}</p>\n',
        data: '{ "owner": { "name": "Ada" } }'
    });
    assert.strictEqual(pane, '');
    assert.strictEqual(stub.publishedDiagnostics.size, 0);
});

test('the Full HTML Preview locates a missing end tag', async () => {
    stub.workspaceFiles.set(TEMPLATE, 'intro\n{% if x %}\nswallowed\n');
    const preview = makePreview({ templateUri: TEMPLATE });
    const panel = makePanel();

    await extension.refreshHtmlFullPanel(preview, panel);
    const chrome = panel.chrome();

    assert.ok(paneOf(chrome).includes('tag {% if x %} not closed'));
    assert.deepStrictEqual(positionsIn(paneOf(chrome)), [{ file: TEMPLATE, line: 2, col: 1 }]);
    assert.ok(chrome.includes('Not closed'), 'and the annotated document still marks the section');
});

test('the Full HTML Preview reports nothing for a template that parses', async () => {
    stub.workspaceFiles.set(TEMPLATE, 'intro\n{% if x %}body{% endif %}\n');
    const panel = makePanel();

    await extension.refreshHtmlFullPanel(makePreview({ templateUri: TEMPLATE }), panel);
    assert.strictEqual(paneOf(panel.chrome()), '');
});

test('clicking a position opens the file there', async () => {
    const { panel } = await renderPreview({ template: FIXTURE, data: DATA_JSON });

    panel.send({ type: 'reveal', file: TEMPLATE, line: 5, col: 7 });
    await settle();

    assert.deepStrictEqual(stub.revealed, [{ file: TEMPLATE, line: 4, character: 6, viewColumn: 1 }]);
});

test('clicking a position reuses the column the file is already open in', async () => {
    const { panel } = await renderPreview({ template: FIXTURE, data: DATA_JSON });
    stub.vscode.window.visibleTextEditors = [{
        document: { uri: stub.vscode.Uri.file(TEMPLATE) },
        viewColumn: 3
    }];

    panel.send({ type: 'reveal', file: TEMPLATE, line: 1, col: 1 });
    await settle();

    assert.strictEqual(stub.revealed[0].viewColumn, 3);
});

test('a message that is not a reveal is ignored', async () => {
    const { panel } = await renderPreview({ template: FIXTURE, data: DATA_JSON });

    panel.send({ type: 'update' });
    panel.send({ type: 'reveal' });
    panel.send(null);
    await settle();

    assert.deepStrictEqual(stub.revealed, []);
    assert.deepStrictEqual(stub.shownErrors, []);
});

test('a reveal for a file that has gone away reports instead of throwing', async () => {
    const { panel } = await renderPreview({ template: FIXTURE, data: DATA_JSON });

    panel.send({ type: 'reveal', file: '/w/deleted.liquid', line: 1, col: 1 });
    await settle();

    assert.deepStrictEqual(stub.revealed, []);
    assert.strictEqual(stub.shownErrors.length, 1);
    assert.ok(stub.shownErrors[0].includes('/w/deleted.liquid'));
});
