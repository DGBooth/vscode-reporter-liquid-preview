// Creating test cases from known cases: a template and data whose output the
// reader knows is right become cases in a suite, with that output frozen as the
// expected file. These check the plan (paths, names, what is skipped), the
// guards against freezing output that is wrong, and the two ways in — the
// command and the HTML preview's "Save as test" button.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extension, stub, harnessReset, renderPreview, makePanel } = require('./harness');
const templateTests = require('../template-tests');

let dir;

// Write files into a fresh temporary workspace. The feature writes with fs and
// checks what already exists on disk, so fixtures live on disk too.
function workspace(files) {
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
}
const at = rel => path.join(dir, rel);
const read = rel => fs.readFileSync(at(rel), 'utf8');
const suiteJson = rel => JSON.parse(read(rel));

test.beforeEach(() => {
    harnessReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-create-'));
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---- the plan -------------------------------------------------------------------

test('a new suite sits beside the template, with paths relative to it', () => {
    const plan = templateTests.planNewCases({
        suiteFile: '/w/reports/invoice.liquidtest.json',
        suiteText: null,
        template: '/w/reports/invoice.liquid',
        entries: [{ name: 'Two items', dataFile: '/w/data/two-items.json', output: '<p>x</p>' }]
    });
    assert.deepStrictEqual(JSON.parse(plan.suiteText), {
        template: 'invoice.liquid',
        cases: [{ name: 'Two items', data: '../data/two-items.json', expected: 'expected/invoice/two-items.html' }]
    });
    assert.deepStrictEqual(plan.writes, [{ file: path.resolve('/w/reports/expected/invoice/two-items.html'), text: '<p>x</p>' }]);
});

test('adding to a suite keeps its cases, skips data it already covers and keeps names unique', () => {
    const existing = JSON.stringify({
        template: 'invoice.liquid',
        whitespace: 'collapse',
        cases: [{ name: 'a', data: 'a.json', expected: 'expected/invoice/a.html' }]
    });
    const plan = templateTests.planNewCases({
        suiteFile: '/w/invoice.liquidtest.json',
        suiteText: existing,
        template: '/w/invoice.liquid',
        entries: [
            { name: 'a', dataFile: '/w/a.json', output: 'dup' },
            { name: 'a', dataFile: '/w/other.json', output: 'x' }
        ],
        exists: file => file === path.resolve('/w/expected/invoice/a-2.html')
    });
    const suite = JSON.parse(plan.suiteText);
    assert.strictEqual(suite.whitespace, 'collapse', 'suite settings survive');
    assert.deepStrictEqual(suite.cases.map(c => c.name), ['a', 'a (2)']);
    assert.strictEqual(suite.cases[1].expected, 'expected/invoice/a-2-2.html', 'an existing file is never overwritten');
    assert.deepStrictEqual(plan.skipped, [{ name: 'a', reason: 'a case in the suite already uses this data file' }]);
});

test('a case for a different template than the suite\'s names its own', () => {
    const plan = templateTests.planNewCases({
        suiteFile: '/w/all.liquidtest.json',
        suiteText: JSON.stringify({ template: 'invoice.liquid', cases: [] }),
        template: '/w/letters/letter.liquid',
        entries: [{ name: 'l', data: { a: 1 }, output: 'x' }]
    });
    assert.deepStrictEqual(JSON.parse(plan.suiteText).cases[0], {
        name: 'l', template: 'letters/letter.liquid', data: { a: 1 }, expected: 'expected/letter/l.html'
    });
});

test('a suite that is not valid JSON is refused rather than overwritten', () => {
    assert.throws(() => templateTests.planNewCases({
        suiteFile: '/w/x.liquidtest.json', suiteText: '{ "cases": [', template: '/w/x.liquid', entries: []
    }), /not valid JSON/);
});

test('case names become safe file names', () => {
    assert.strictEqual(templateTests.slugify('Café: 2 items / no notes!'), 'cafe-2-items-no-notes');
    assert.strictEqual(templateTests.slugify('***'), 'case');
});

// ---- creating ---------------------------------------------------------------------

test('known cases become passing tests, with the current output as expected', async () => {
    workspace({
        'invoice.liquid': '<h1>{{ customer }}</h1>',
        'data/ada.json': '{"customer":"Ada"}',
        'data/bob.json': '{"customer":"Bob"}'
    });
    const result = await extension.createTestsFromCases(at('invoice.liquid'), [
        { name: 'ada', dataFile: at('data/ada.json') },
        { name: 'bob', dataFile: at('data/bob.json') }
    ]);

    assert.deepStrictEqual(result.added, ['ada', 'bob']);
    assert.strictEqual(read('expected/invoice/ada.html'), '<h1>Ada</h1>');
    assert.strictEqual(read('expected/invoice/bob.html'), '<h1>Bob</h1>');
    assert.deepStrictEqual(suiteJson('invoice.liquidtest.json').cases.map(c => c.data), ['data/ada.json', 'data/bob.json']);

    // The new cases are run straight away, and pass.
    assert.deepStrictEqual(result.report.suites[0].results.map(r => r.status), ['passed', 'passed']);
    assert.strictEqual(stub.createdPanels.length, 1, 'the report opens');
    assert.match(stub.shownMessages.find(m => m.startsWith('Added')), /Added 2 test cases/);
});

test('a case that fails to render, or repeats a field name, is left out with the reason', async () => {
    workspace({
        'broken.liquid': '{% if x %}never closed',
        'dupes.liquid': '{% editor "a" %}{% endeditor %}{% editor "a" %}{% endeditor %}'
    });
    const broken = await extension.createTestsFromCases(at('broken.liquid'), [{ name: 'b', data: {} }]);
    const dupes = await extension.createTestsFromCases(at('dupes.liquid'), [{ name: 'd', data: {} }]);

    assert.deepStrictEqual(broken.added, []);
    assert.match(broken.skipped[0].reason, /Template error/);
    assert.match(dupes.skipped[0].reason, /Duplicate field name/);
    assert.ok(!fs.existsSync(at('broken.liquidtest.json')), 'nothing is written when nothing is added');
    assert.ok(!fs.existsSync(at('expected')));
});

test('output with filter warnings is only frozen if the reader allows warnings for it', async () => {
    workspace({ 'r.liquid': '{{ items | slice: 0, 1 }}ok', 'full.json': '{"items":[1]}', 'empty.json': '{}' });
    const sources = [{ name: 'full', dataFile: at('full.json') }, { name: 'empty', dataFile: at('empty.json') }];

    stub.warningAnswers.push('Skip those cases');
    const skipped = await extension.createTestsFromCases(at('r.liquid'), sources);
    assert.deepStrictEqual(skipped.added, ['full']);
    assert.deepStrictEqual(skipped.skipped, [{ name: 'empty', reason: 'filters warned about missing data' }]);
    assert.match(stub.shownMessages[0], /1 case \(empty\) makes filters warn/);

    stub.warningAnswers.push('Allow warnings');
    const allowed = await extension.createTestsFromCases(at('r.liquid'), sources);
    assert.deepStrictEqual(allowed.added, ['empty'], 'full is already covered');
    const emptyCase = suiteJson('r.liquidtest.json').cases.find(c => c.name === 'empty');
    assert.strictEqual(emptyCase.allowWarnings, true);
    assert.strictEqual(allowed.report.suites[0].results[0].status, 'passed');
});

test('cancelling the warnings question writes nothing', async () => {
    workspace({ 'r.liquid': '{{ items | slice: 0, 1 }}', 'empty.json': '{}' });
    stub.warningAnswers.push(undefined);
    const result = await extension.createTestsFromCases(at('r.liquid'), [{ name: 'e', dataFile: at('empty.json') }]);
    assert.strictEqual(result, null);
    assert.ok(!fs.existsSync(at('r.liquidtest.json')));
});

test('unsaved template or data edits are saved first, or nothing happens', async () => {
    workspace({ 'r.liquid': 'hi', 'd.json': '{}' });
    let saved = 0;
    stub.vscode.workspace.textDocuments = [{ fileName: at('d.json'), isDirty: true, save: async () => { saved++; } }];

    stub.warningAnswers.push(undefined);
    assert.strictEqual(await extension.createTestsFromCases(at('r.liquid'), [{ name: 'd', dataFile: at('d.json') }]), null);
    assert.strictEqual(saved, 0);
    assert.ok(!fs.existsSync(at('r.liquidtest.json')));

    stub.warningAnswers.push('Save and continue');
    const result = await extension.createTestsFromCases(at('r.liquid'), [{ name: 'd', dataFile: at('d.json') }]);
    assert.strictEqual(saved, 1);
    assert.deepStrictEqual(result.added, ['d']);
});

// ---- the ways in -----------------------------------------------------------------------

test('Create Tests from Data Files offers data files only, and makes a case per pick', async () => {
    workspace({
        'invoice.liquid': '{{ n }}',
        'a.json': '{"n":1}',
        'b.json': '{"n":2}',
        'package.json': '{}',
        'old.liquidtest.json': '{"cases":[]}'
    });
    for (const f of ['a.json', 'b.json', 'package.json', 'old.liquidtest.json']) stub.workspaceFiles.set(at(f), read(f));

    let offered;
    stub.quickPickAnswers.push(items => { offered = items.map(i => i.label); return items; });
    const result = await extension.createTestsFromDataFiles(stub.vscode.Uri.file(at('invoice.liquid')));

    assert.deepStrictEqual(offered, ['a.json', 'b.json']);
    assert.deepStrictEqual(result.added, ['a', 'b']);
    assert.strictEqual(read('expected/invoice/b.html'), '2');
});

test('the HTML preview carries the test builder, and hands its messages over whole', async () => {
    const { panel } = await renderPreview({ template: 'x', data: '{}' });
    const page = panel.webview.html;
    assert.ok(page.includes('data-lp-local="build-test"'), 'the Create test button');
    assert.ok(page.includes('<aside id="lp-builder" hidden data-default-name="data">'), 'named after the data file by default');
    assert.ok(page.includes('window.RLPTestBuilder'), 'the builder script');
    assert.ok(page.includes('window.__rlpVsCodeApi = vscodeApi'), 'which shares the one VS Code handle');

    let received = null;
    const wired = makePanel();
    extension.wirePreviewMessages(wired, { saveBuiltTest: message => { received = message; } });
    wired.send({ type: 'action', action: 'saveBuiltTest', name: 'n', checks: [] });
    assert.deepStrictEqual(received, { type: 'action', action: 'saveBuiltTest', name: 'n', checks: [] });
});

test('the Full HTML Preview has no builder: it has no data to test against', () => {
    const page = extension.buildPreviewHtml('', '', '<p>x</p>');
    assert.ok(!page.includes('lp-builder'));
});

// A panel that records what the extension says back to the builder.
function builderPanel() {
    const replies = [];
    return { replies, webview: { postMessage: message => { replies.push(message); return Promise.resolve(true); } } };
}

const BUILT = [
    { name: 'The heading reads “Dear Ada”', selector: 'h1', text: 'Dear Ada' },
    { name: 'The page doesn’t mention “overdue”', notContains: 'overdue' }
];

test('a built test is saved as a case with its checks, and no expected file', async () => {
    workspace({ 'letter.liquid': '<h1>Dear {{ name }}</h1>', 'people/ada.json': '{"name":"Ada"}' });
    const panel = builderPanel();
    await extension.saveBuiltTest({ templateUri: at('letter.liquid'), dataUri: at('people/ada.json') }, panel,
        { name: 'Letter to Ada', checks: BUILT, wholePage: false });

    assert.deepStrictEqual(suiteJson('letter.liquidtest.json').cases, [{
        name: 'Letter to Ada',
        data: 'people/ada.json',
        checks: [
            { name: 'The heading reads “Dear Ada”', selector: 'h1', text: 'Dear Ada' },
            { name: 'The page doesn’t mention “overdue”', notContains: 'overdue' }
        ]
    }]);
    assert.ok(!fs.existsSync(at('expected')), 'no snapshot unless asked for');
    assert.deepStrictEqual(panel.replies, [{ type: 'builderResult', ok: true, message: `Saved “Letter to Ada” to ${at('letter.liquidtest.json')}. The test report shows it passing.` }]);
});

test('"Also check the whole page" adds the expected file too', async () => {
    workspace({ 'letter.liquid': '<h1>Dear {{ name }}</h1>', 'ada.json': '{"name":"Ada"}' });
    await extension.saveBuiltTest({ templateUri: at('letter.liquid'), dataUri: at('ada.json') }, builderPanel(),
        { name: 'Ada', checks: [BUILT[0]], wholePage: true });
    const [c] = suiteJson('letter.liquidtest.json').cases;
    assert.strictEqual(c.expected, 'expected/letter/ada.html');
    assert.strictEqual(read('expected/letter/ada.html'), '<h1>Dear Ada</h1>');
    assert.strictEqual(c.checks.length, 1);
});

test('several built tests can use the same data file', async () => {
    workspace({ 'letter.liquid': '<h1>Dear {{ name }}</h1>', 'ada.json': '{"name":"Ada"}' });
    const preview = { templateUri: at('letter.liquid'), dataUri: at('ada.json') };
    await extension.saveBuiltTest(preview, builderPanel(), { name: 'Greeting', checks: [BUILT[0]], wholePage: false });
    await extension.saveBuiltTest(preview, builderPanel(), { name: 'Tone', checks: [BUILT[1]], wholePage: false });
    assert.deepStrictEqual(suiteJson('letter.liquidtest.json').cases.map(c => c.name), ['Greeting', 'Tone']);
});

test('a built check that does not pass is refused, and the builder is told which and why', async () => {
    workspace({ 'letter.liquid': '<h1>Dear {{ name }}</h1>', 'ada.json': '{"name":"Ada"}' });
    const panel = builderPanel();
    await extension.saveBuiltTest({ templateUri: at('letter.liquid'), dataUri: at('ada.json') }, panel,
        { name: 'Wrong', checks: [{ name: 'Says Bob', selector: 'h1', text: 'Dear Bob' }], wholePage: false });
    assert.ok(!fs.existsSync(at('letter.liquidtest.json')), 'nothing written');
    assert.strictEqual(panel.replies[0].ok, false);
    assert.match(panel.replies[0].message, /a check doesn’t pass against the current output: Says Bob \(It reads “Dear Ada”; expected “Dear Bob”\.\)/);
});

test('the builder is told what is missing before anything is attempted', async () => {
    const preview = { templateUri: at('x.liquid'), dataUri: null };
    const noName = builderPanel();
    await extension.saveBuiltTest(preview, noName, { name: '  ', checks: BUILT, wholePage: false });
    assert.deepStrictEqual(noName.replies[0], { type: 'builderResult', ok: false, message: 'Give the test a name first.' });
    const nothing = builderPanel();
    await extension.saveBuiltTest(preview, nothing, { name: 'x', checks: [], wholePage: false });
    assert.match(nothing.replies[0].message, /Add at least one check/);
});

test('a check written by the builder keeps only the keys a check understands', () => {
    const plan = templateTests.planNewCases({
        suiteFile: '/w/x.liquidtest.json', suiteText: null, template: '/w/x.liquid',
        entries: [{ name: 'n', data: {}, output: '', snapshot: false, checks: [{ name: 'c', selector: 'h1', text: 'a', noun: 'Heading', kind: 'reads' }] }]
    });
    assert.deepStrictEqual(JSON.parse(plan.suiteText).cases[0].checks, [{ name: 'c', selector: 'h1', text: 'a' }]);
    assert.deepStrictEqual(plan.writes, []);
});
