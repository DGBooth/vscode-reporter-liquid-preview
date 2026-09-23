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

test('the HTML preview has a Save as test button that asks the extension to create one', async () => {
    const { panel } = await renderPreview({ template: 'x', data: '{}' });
    assert.ok(panel.webview.html.includes('data-lp-action="createTest"'));

    let asked = 0;
    const wired = makePanel();
    extension.wirePreviewMessages(wired, { createTest: () => { asked++; } });
    wired.send({ type: 'action', action: 'createTest' });
    wired.send({ type: 'action', action: 'somethingElse' });
    assert.strictEqual(asked, 1);
});

test('Save as test uses the preview\'s template, data file and the name given', async () => {
    workspace({ 'letter.liquid': 'Dear {{ name }}', 'people/ada.json': '{"name":"Ada"}' });
    const preview = { templateUri: at('letter.liquid'), dataUri: at('people/ada.json') };

    stub.inputBoxAnswers.push('  Letter to Ada ');
    const result = await extension.saveHtmlPreviewAsTest(preview);
    assert.deepStrictEqual(result.added, ['Letter to Ada']);
    assert.deepStrictEqual(suiteJson('letter.liquidtest.json').cases[0], {
        name: 'Letter to Ada', data: 'people/ada.json', expected: 'expected/letter/letter-to-ada.html'
    });
    assert.strictEqual(read('expected/letter/letter-to-ada.html'), 'Dear Ada');

    stub.inputBoxAnswers.push(undefined);
    assert.strictEqual(await extension.saveHtmlPreviewAsTest(preview), null, 'dismissing the name box cancels');
});
