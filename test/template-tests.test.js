// Template tests: *.liquidtest.json suites render a template against known data
// and check the output. These drive the runner through the extension's own
// render path — so a case sees exactly what the preview would — and check the
// verdicts, the report, the accept-output workflow and the Test Explorer
// mapping.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extension, stub, harnessReset } = require('./harness');
const templateTests = require('../template-tests');

const TEMPLATE = '/w/report.liquid';
const SUITE = '/w/report.liquidtest.json';

const deps = {
    readText: async file => (await stub.vscode.workspace.openTextDocument(file)).getText(),
    render: extension.renderForTest,
    format: extension.formatHtml
};

// Parse `suite` (an object) as if it lived at SUITE and run every case.
async function run(suite, files = {}) {
    for (const [file, text] of Object.entries(files)) stub.workspaceFiles.set(file, text);
    const parsed = templateTests.parseSuite(JSON.stringify(suite, null, 2), SUITE);
    return templateTests.runSuite(parsed, deps);
}

function only(result) {
    assert.strictEqual(result.results.length, 1);
    return result.results[0];
}

test.beforeEach(() => harnessReset());

// ---- suites -------------------------------------------------------------------

test('paths in a suite resolve against the suite file, not the workspace root', () => {
    const suite = templateTests.parseSuite(JSON.stringify({
        template: '../templates/a.liquid',
        cases: [{ name: 'one', data: 'data/one.json', expected: 'expected/one.html' }]
    }), '/w/tests/a.liquidtest.json');
    const [c] = suite.cases;
    assert.strictEqual(c.template, path.resolve('/w/templates/a.liquid'));
    assert.strictEqual(c.dataFile, path.resolve('/w/tests/data/one.json'));
    assert.strictEqual(c.expected, path.resolve('/w/tests/expected/one.html'));
});

test('a case records the line its name is on, so it can be jumped to', () => {
    const text = '{\n  "template": "a.liquid",\n  "cases": [\n    { "name": "first" },\n    {\n      "name": "second"\n    }\n  ]\n}';
    const suite = templateTests.parseSuite(text, SUITE);
    assert.deepStrictEqual(suite.cases.map(c => c.line), [4, 6]);
});

test('repeated case names are made unique rather than shadowing each other', () => {
    const suite = templateTests.parseSuite(JSON.stringify({ template: 'a.liquid', cases: [{ name: 'x' }, { name: 'x' }, {}] }), SUITE);
    assert.deepStrictEqual(suite.cases.map(c => c.name), ['x', 'x (2)', 'case 3']);
});

test('a broken suite reports what is wrong with it', () => {
    assert.match(templateTests.parseSuite('{ "cases": [', SUITE).error, /Not valid JSON/);
    assert.match(templateTests.parseSuite('{}', SUITE).error, /"cases" array/);
    assert.match(templateTests.parseSuite('{ "cases": [] }', SUITE).error, /no cases/);
});

test('a case with no template, or a bad option, errors on its own without sinking the suite', async () => {
    const result = await run(
        { cases: [{ name: 'no template' }, { name: 'bad', template: 'report.liquid', whitespace: 'loose' }, { name: 'ok', template: 'report.liquid' }] },
        { [TEMPLATE]: 'hi' }
    );
    assert.deepStrictEqual(result.results.map(r => r.status), ['error', 'error', 'passed']);
    assert.match(result.results[0].failures[0].message, /No template/);
    assert.match(result.results[1].failures[0].message, /"whitespace" must be/);
});

// ---- verdicts -----------------------------------------------------------------

test('a case passes when the output matches its expected file', async () => {
    const r = only(await run(
        { template: 'report.liquid', cases: [{ name: 'match', data: 'data.json', expected: 'expected.html' }] },
        { [TEMPLATE]: '<p>{{ name }}</p>', '/w/data.json': '{"name":"Ada"}', '/w/expected.html': '<p>Ada</p>' }
    ));
    assert.strictEqual(r.status, 'passed', JSON.stringify(r.failures));
    assert.strictEqual(r.actual, '<p>Ada</p>');
});

test('a changed output fails with a diff of expected against actual', async () => {
    const r = only(await run(
        { template: 'report.liquid', cases: [{ name: 'changed', data: { name: 'Bob' }, expected: 'expected.html' }] },
        { [TEMPLATE]: '<h1>Title</h1>\n<p>{{ name }}</p>\n<p>end</p>', '/w/expected.html': '<h1>Title</h1>\n<p>Ada</p>\n<p>end</p>' }
    ));
    assert.strictEqual(r.status, 'failed');
    const mismatch = r.failures.find(f => f.kind === 'mismatch');
    assert.ok(mismatch);
    const changed = mismatch.diff.hunks.flat().filter(l => l.type !== ' ');
    assert.deepStrictEqual(changed.map(l => l.type + l.text), ['-<p>Ada</p>', '+<p>Bob</p>']);
});

test('line endings and a final newline do not count as a difference', async () => {
    const r = only(await run(
        { template: 'report.liquid', cases: [{ name: 'crlf', expected: 'expected.html' }] },
        { [TEMPLATE]: 'a\nb', '/w/expected.html': 'a\r\nb\r\n' }
    ));
    assert.strictEqual(r.status, 'passed', JSON.stringify(r.failures));
});

test('exact mode catches whitespace changes; collapse mode ignores them', async () => {
    const files = { [TEMPLATE]: '<ul>\n  <li>a</li>\n</ul>', '/w/expected.html': '<ul><li>a</li></ul>' };
    const exact = only(await run({ template: 'report.liquid', cases: [{ name: 'e', expected: 'expected.html' }] }, files));
    const collapsed = only(await run({ template: 'report.liquid', cases: [{ name: 'c', expected: 'expected.html', whitespace: 'collapse' }] }, files));
    assert.strictEqual(exact.status, 'failed');
    assert.strictEqual(collapsed.status, 'passed', JSON.stringify(collapsed.failures));
});

test('contains and notContains check fragments of the output', async () => {
    const r = only(await run(
        { template: 'report.liquid', cases: [{ name: 'fragments', data: { n: 3 }, contains: ['3 items', 'missing text'], notContains: 'items' }] },
        { [TEMPLATE]: '{{ n }} items' }
    ));
    assert.strictEqual(r.status, 'failed');
    assert.deepStrictEqual(r.failures.map(f => f.kind), ['contains', 'not-contains']);
    assert.match(r.failures[0].message, /missing text/);
});

test('a filter warning fails the case unless warnings are allowed', async () => {
    const files = { [TEMPLATE]: '{{ missing | slice: 0, 2 }}ok' };
    const strict = only(await run({ template: 'report.liquid', cases: [{ name: 's', contains: 'ok' }] }, files));
    const lenient = only(await run({ template: 'report.liquid', allowWarnings: true, cases: [{ name: 'l', contains: 'ok' }] }, files));

    assert.strictEqual(strict.status, 'failed');
    const warning = strict.failures.find(f => f.kind === 'problem');
    assert.match(warning.message, /slice filter/);
    assert.strictEqual(warning.line, 1, 'the warning is located, as in the preview');

    assert.strictEqual(lenient.status, 'passed', JSON.stringify(lenient.failures));
    assert.strictEqual(lenient.diagnostics.length, 1, 'the warning is still recorded for the report');
});

test('a duplicate field name fails the case even when warnings are allowed', async () => {
    const r = only(await run(
        { template: 'report.liquid', allowWarnings: true, cases: [{ name: 'dupe' }] },
        { [TEMPLATE]: '{% editor "a" %}{% endeditor %}\n{% editor "a" %}{% endeditor %}' }
    ));
    assert.strictEqual(r.status, 'failed');
    assert.match(r.failures[0].message, /Duplicate field name/);
});

test('a template that does not parse is an error, located in the template', async () => {
    const r = only(await run({ template: 'report.liquid', cases: [{ name: 'broken' }] }, { [TEMPLATE]: 'a\n{% if x %}never closed' }));
    assert.strictEqual(r.status, 'error');
    assert.match(r.failures[0].message, /Template error/);
    assert.strictEqual(r.failures[0].file, TEMPLATE);
    assert.strictEqual(r.failures[0].line, 2);
});

test('missing or broken data files are errors that say which file', async () => {
    const result = await run(
        { template: 'report.liquid', cases: [{ name: 'gone', data: 'nope.json' }, { name: 'bad', data: 'bad.json' }] },
        { [TEMPLATE]: 'x', '/w/bad.json': '{ nope' }
    );
    assert.deepStrictEqual(result.results.map(r => r.status), ['error', 'error']);
    assert.match(result.results[0].failures[0].message, /Cannot read the data file .*nope\.json/);
    assert.match(result.results[1].failures[0].message, /not valid JSON/);
});

test('a missing expected file fails and asks for the output to be accepted', async () => {
    const r = only(await run({ template: 'report.liquid', cases: [{ name: 'new', expected: 'new.html' }] }, { [TEMPLATE]: 'hello' }));
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failures[0].kind, 'missing-expected');
    assert.strictEqual(r.actual, 'hello', 'the output is kept so it can be accepted');
});

test('custom tags and fields render in a test exactly as in the preview', async () => {
    const r = only(await run(
        { template: 'report.liquid', cases: [{ name: 'fields', data: { fields: { opt: 'true' } }, contains: 'checked=""' }] },
        { [TEMPLATE]: '{% optional "opt" %}Yes{% endoptional %}' }
    ));
    assert.strictEqual(r.status, 'passed', JSON.stringify(r.failures));
});

// ---- diffs --------------------------------------------------------------------

test('a one-line HTML output is pretty-printed so the diff lands on the element that changed', () => {
    const cells = n => Array.from({ length: 12 }, (_, i) => `<td>cell ${i === 5 ? n : i}</td>`).join('');
    const expected = `<table><tr>${cells('five')}</tr></table>`;
    const actual = `<table><tr>${cells('FIVE')}</tr></table>`;
    const diff = templateTests.diffOutputs(expected, actual, extension.formatHtml);
    assert.match(diff.note, /pretty-printed/);
    const changed = diff.hunks.flat().filter(l => l.type !== ' ');
    assert.ok(changed.length <= 4, `a small diff, not the whole line: ${JSON.stringify(changed)}`);
    assert.ok(changed.some(l => l.text.includes('cell five')) && changed.some(l => l.text.includes('cell FIVE')));
});

test('hunks keep only a few lines of context around each change', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 3\n', 'line three\n').replace('line 25\n', 'line twenty-five\n');
    const hunks = templateTests.toHunks(templateTests.diffLines(a, b));
    assert.strictEqual(hunks.length, 2);
    assert.ok(hunks.every(h => h.length <= 8));
    assert.deepStrictEqual(hunks[1].find(l => l.type === '-'), { type: '-', text: 'line 25', oldLine: 26, newLine: null });
});

// ---- the report ---------------------------------------------------------------

test('the report escapes template output, so a rendered script cannot run in it', async () => {
    const r = only(await run(
        { template: 'report.liquid', cases: [{ name: '<b>name</b>', expected: 'e.html' }] },
        { [TEMPLATE]: '<script>alert(1)</script>', '/w/e.html': '<p>x</p>' }
    ));
    const html = templateTests.buildReportHtml({ startedAt: Date.now(), durationMs: 5, suites: [{ file: SUITE, error: null, results: [r] }] });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;b&gt;name&lt;/b&gt;'));
    assert.ok(!/<script>/.test(html), 'the saved report carries no script at all');
});

test('the report summarises the run and opens failing cases', async () => {
    const result = await run(
        { template: 'report.liquid', cases: [{ name: 'good', contains: 'hi' }, { name: 'bad', contains: 'bye' }] },
        { [TEMPLATE]: 'hi' }
    );
    const html = templateTests.buildReportHtml({ startedAt: Date.now(), durationMs: 5, suites: [result] }, { interactive: true });
    assert.match(html, /Template tests failed/);
    assert.match(html, /1 passed/);
    assert.match(html, /1 failed/);
    assert.match(html, /<details class="case case-passed">/);
    assert.match(html, /<details class="case case-failed" open>/);
    assert.match(html, /data-action="rerun"/, 'the panel version has its toolbar');
});

test('a run with nothing to run says how to add a suite', () => {
    const html = templateTests.buildReportHtml({ startedAt: Date.now(), durationMs: 0, suites: [] });
    assert.match(html, /No test suites found/);
});

// ---- the extension ------------------------------------------------------------

test('Run Template Tests finds every suite in the workspace and records the report', async () => {
    stub.workspaceFiles.set(TEMPLATE, 'hi');
    stub.workspaceFiles.set(SUITE, JSON.stringify({ template: 'report.liquid', cases: [{ name: 'a', contains: 'hi' }] }));
    stub.workspaceFiles.set('/w/other.liquidtest.json', JSON.stringify({ template: 'report.liquid', cases: [{ name: 'b', contains: 'bye' }] }));

    const report = await extension.runTemplateTests();
    assert.deepStrictEqual(report.suites.map(s => s.file), ['/w/other.liquidtest.json', SUITE]);
    assert.deepStrictEqual(templateTests.summarize(report.suites), { passed: 1, failed: 1, error: 0, total: 2, suiteErrors: 0 });
});

test('accepting the actual output writes the expected files, then the case passes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-accept-'));
    try {
        const template = path.join(dir, 'report.liquid');
        const suiteFile = path.join(dir, 'report.liquidtest.json');
        stub.workspaceFiles.set(template, '<p>{{ name }}</p>');
        stub.workspaceFiles.set(suiteFile, JSON.stringify({
            template: 'report.liquid',
            cases: [{ name: 'new', data: { name: 'Ada' }, expected: 'expected/new.html' }]
        }));

        const selection = [{ file: suiteFile, only: null }];
        const before = await extension.runTemplateTests({ selection });
        assert.strictEqual(before.suites[0].results[0].status, 'failed');

        stub.warningAnswers.push('Overwrite');
        const written = await extension.acceptActualOutput(before);
        assert.deepStrictEqual(written, [path.join(dir, 'expected', 'new.html')]);
        assert.strictEqual(fs.readFileSync(written[0], 'utf8'), '<p>Ada</p>');
        assert.match(stub.shownMessages[0], /Overwrite 1 expected output file/);

        const after = await extension.runTemplateTests({ selection });
        assert.strictEqual(after.suites[0].results[0].status, 'passed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('declining the confirmation writes nothing', async () => {
    stub.workspaceFiles.set(TEMPLATE, 'x');
    stub.workspaceFiles.set(SUITE, JSON.stringify({ template: 'report.liquid', cases: [{ name: 'n', expected: '/nonexistent-dir/never.html' }] }));
    const report = await extension.runTemplateTests();
    stub.warningAnswers.push(undefined);
    assert.deepStrictEqual(await extension.acceptActualOutput(report), []);
    assert.ok(!fs.existsSync('/nonexistent-dir/never.html'));
});

// ---- the Test Explorer ------------------------------------------------------------

function controller() {
    const found = stub.testControllers.find(c => c.id === 'reporterLiquidTemplateTests');
    assert.ok(found, 'the extension registers a test controller when the Testing API exists');
    return found;
}

test('suites and their cases appear in the Test Explorer, placed on their lines', async () => {
    stub.workspaceFiles.set(TEMPLATE, 'hi');
    stub.workspaceFiles.set(SUITE, '{\n  "template": "report.liquid",\n  "cases": [\n    { "name": "a" },\n    { "name": "b" }\n  ]\n}');
    const c = controller();
    await c.resolveHandler(undefined);

    const suite = c.items.get(SUITE);
    assert.ok(suite);
    const children = [];
    suite.children.forEach(child => children.push([child.label, child.range.start.line]));
    assert.deepStrictEqual(children, [['a', 3], ['b', 4]]);
});

test('a Test Explorer run reports each case, with a diff for changed output', async () => {
    stub.workspaceFiles.set(TEMPLATE, '<p>{{ name }}</p>');
    stub.workspaceFiles.set('/w/expected.html', '<p>Ada</p>');
    stub.workspaceFiles.set(SUITE, JSON.stringify({
        template: 'report.liquid',
        cases: [
            { name: 'same', data: { name: 'Ada' }, expected: 'expected.html' },
            { name: 'changed', data: { name: 'Bob' }, expected: 'expected.html' },
            { name: 'broken', template: 'missing.liquid' }
        ]
    }));
    const c = controller();
    await c.resolveHandler(undefined);
    await c.profiles[0].runHandler({ include: undefined, exclude: [] }, { isCancellationRequested: false });

    const run = c.runs[c.runs.length - 1];
    assert.ok(run.ended);
    const outcome = id => run.calls.filter(call => call.id === `${SUITE}::${id}` && !['enqueued', 'started'].includes(call.state));
    assert.deepStrictEqual(outcome('same').map(x => x.state), ['passed']);
    assert.deepStrictEqual(outcome('broken').map(x => x.state), ['errored']);

    const [failed] = outcome('changed');
    assert.strictEqual(failed.state, 'failed');
    const message = failed.messages[0];
    assert.strictEqual(message.expectedOutput, '<p>Ada</p>');
    assert.strictEqual(message.actualOutput, '<p>Bob</p>');
    assert.strictEqual(message.location.uri.fsPath, SUITE);
});

test('running one case from the Test Explorer runs only that case', async () => {
    stub.workspaceFiles.set(TEMPLATE, 'hi');
    stub.workspaceFiles.set(SUITE, JSON.stringify({ template: 'report.liquid', cases: [{ name: 'a' }, { name: 'b' }] }));
    const c = controller();
    await c.resolveHandler(undefined);
    const b = c.items.get(SUITE).children.get(`${SUITE}::b`);

    await c.profiles[0].runHandler({ include: [b], exclude: [] }, { isCancellationRequested: false });
    const run = c.runs[c.runs.length - 1];
    assert.deepStrictEqual([...new Set(run.calls.map(call => call.id))], [`${SUITE}::b`]);
});
