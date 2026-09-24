// Checks: small named assertions about parts of a case's output. These cover
// how each kind of check judges an output, the messages it fails with, that the
// output is parsed the way a browser would parse it, and how checks show up in
// a case's result, the report, the command line and the Test Explorer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { extension, stub, harnessReset } = require('./harness');
const { parseChecks, runChecks } = require('../output-checks');
const templateTests = require('../template-tests');
const cli = require('../bin/liquid-test');

// Run raw check definitions against some HTML; hand back { name: failures }.
function check(html, ...raw) {
    const { checks } = parseChecks(raw.map((c, i) => Object.assign({ name: `c${i}` }, c)));
    const out = {};
    for (const r of runChecks(checks, html)) out[r.name] = r.failures;
    return raw.length === 1 ? out.c0 : out;
}

const INVOICE = `
<h1>Invoice for   Ada &amp; Co</h1>
<table>
  <tr><td>Engine</td><td class="price">1,250.50</td></tr>
  <tr><td>Cards</td><td class="price">42.00</td></tr>
</table>
<input type="checkbox" id="notes" checked="" value="true">
<p class="empty" hidden>No items.</p>`;

// ---- judging --------------------------------------------------------------------

test('text compares what a reader sees: entities decoded, whitespace collapsed', () => {
    assert.deepStrictEqual(check(INVOICE, { selector: 'h1', text: 'Invoice for Ada & Co' }), []);
    assert.deepStrictEqual(check(INVOICE, { selector: 'h1', text: 'Invoice for Bob' }), ['It reads “Invoice for Ada & Co”; expected “Invoice for Bob”.']);
});

test('text for one element refuses to guess when the selector matches several', () => {
    const [why] = check(INVOICE, { selector: '.price', text: '42.00' });
    assert.match(why, /matched 2 elements, so it's unclear which one "text" means/);
});

test('text as a list checks each match in order, and the number of matches', () => {
    assert.deepStrictEqual(check(INVOICE, { selector: '.price', text: ['1,250.50', '42.00'] }), []);
    assert.deepStrictEqual(check(INVOICE, { selector: '.price', text: ['1,250.50', '45.00'] }), ['Element 2 reads “42.00”; expected “45.00”.']);
    assert.match(check(INVOICE, { selector: '.price', text: ['1,250.50'] })[0], /matched 2 elements, but 1 text was given/);
});

test('count and exists check how many elements match', () => {
    assert.deepStrictEqual(check(INVOICE, { selector: 'tr', count: 2 }), []);
    assert.deepStrictEqual(check(INVOICE, { selector: 'tr', count: 3 }), ['“tr” matched 2 elements; expected 3.']);
    assert.deepStrictEqual(check(INVOICE, { selector: '.missing', exists: false }), []);
    assert.deepStrictEqual(check(INVOICE, { selector: 'h1', exists: false }), ['“h1” matched 1 element; expected none.']);
});

test('a selector on its own asks that something matches it', () => {
    assert.deepStrictEqual(check(INVOICE, { selector: 'table' }), []);
    assert.deepStrictEqual(check(INVOICE, { selector: 'ul' }), ['“ul” matched nothing; expected at least one.']);
});

test('contains and notContains with a selector search the matched elements\' text', () => {
    assert.deepStrictEqual(check(INVOICE, { selector: 'table', contains: ['Engine', '42.00'] }), []);
    assert.match(check(INVOICE, { selector: 'table', contains: 'Invoice' })[0], /The text of “table” should contain “Invoice”; it reads “Engine 1,250.50 Cards 42.00”/);
    assert.deepStrictEqual(check(INVOICE, { selector: 'table', notContains: 'Invoice' }), []);
    assert.deepStrictEqual(check(INVOICE, { selector: '.nothing', notContains: 'x' }), [], 'nothing matched, so nothing contains it');
});

test('contains and notContains without a selector search the whole output, as a case\'s do', () => {
    assert.deepStrictEqual(check(INVOICE, { contains: 'class="price"' }), [], 'the HTML, not just the text');
    assert.deepStrictEqual(check(INVOICE, { notContains: 'No items.' }), ['The output should not contain “No items.”.']);
});

test('attributes check presence, absence and exact values', () => {
    assert.deepStrictEqual(check(INVOICE, { selector: '#notes', attributes: { checked: true, value: 'true', disabled: false } }), []);
    assert.deepStrictEqual(check(INVOICE, { selector: '#notes', attributes: { checked: false, value: 'false', name: 'x' } }), [
        'It has a “checked” attribute; expected none.',
        'Its “value” is “true”; expected “false”.',
        'It has no “name” attribute; expected name=“x”.'
    ]);
    assert.match(check(INVOICE, { selector: 'td', attributes: { class: 'price' } })[0], /unclear which one "attributes" means/);
});

test('every wrong thing about a check is reported, not just the first', () => {
    const why = check(INVOICE, { selector: '.price', count: 3, text: ['1', '2'] });
    assert.strictEqual(why.length, 3);
});

test('the output is parsed as a browser would, so selectors see the preview\'s tree', () => {
    // A browser moves stray text out of a table, and a <div> closes an open <p>.
    const html = '<table><tr><td>a</td>stray</tr></table><p>para<div>block</div>';
    assert.deepStrictEqual(check(html, { selector: 'table', notContains: 'stray' }), []);
    assert.deepStrictEqual(check(html, { selector: 'p div', exists: false }), []);
    assert.deepStrictEqual(check(html, { selector: 'p', text: 'para' }), []);
});

test('text reads across elements the way a reader does', () => {
    const html = '<table><tr><td>Engine</td><td>1,250.50</td></tr></table><p>Net<br>30</p><div>a<b>bold</b>c<script>var x;</script></div>';
    assert.deepStrictEqual(check(html, { selector: 'tr', text: 'Engine 1,250.50' }), [], 'cells are separated');
    assert.deepStrictEqual(check(html, { selector: 'p', text: 'Net 30' }), [], 'a line break is a break');
    assert.deepStrictEqual(check(html, { selector: 'div', text: 'aboldc' }), [], 'inline elements are not, and scripts are skipped');
});

test('a malformed check fails with what is wrong with it, and the others still run', () => {
    const results = check(INVOICE,
        { count: 2 },
        { selector: 'td[[', exists: true },
        { selector: 'h1', count: -1 },
        { selector: 'h1', text: 3 },
        {},
        { selector: 'h1', exists: true, count: 1 },
        { selector: 'h1', text: 'Invoice for Ada & Co' });
    assert.match(results.c0[0], /"count" checks the elements a "selector" matches, so it needs one/);
    assert.match(results.c1[0], /The selector "td\[\[" is not valid CSS/);
    assert.match(results.c2[0], /"count" must be a whole number/);
    assert.match(results.c3[0], /"text" must be text or a list of text/);
    assert.match(results.c4[0], /A check needs a "selector", or something to check/);
    assert.match(results.c5[0], /Use "exists" or "count", not both/);
    assert.deepStrictEqual(results.c6, []);
});

test('repeated check names are made unique', () => {
    const { checks } = parseChecks([{ name: 'x', contains: 'a' }, { name: 'x', contains: 'b' }, { contains: 'c' }]);
    assert.deepStrictEqual(checks.map(c => c.name), ['x', 'x (2)', 'check 3']);
});

test('the HTML parser is only loaded when a check uses a selector', () => {
    const script = `
        const { parseChecks, runChecks } = require('./output-checks');
        runChecks(parseChecks([{ name: 'a', contains: 'x' }]).checks, '<p>x</p>');
        if (Object.keys(require.cache).some(f => f.includes('parse5'))) process.exit(1);
        runChecks(parseChecks([{ name: 'b', selector: 'p' }]).checks, '<p>x</p>');
        if (!Object.keys(require.cache).some(f => f.includes('parse5'))) process.exit(2);`;
    execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
});

// ---- in a case ------------------------------------------------------------------

const SUITE = '/w/report.liquidtest.json';
const deps = {
    readText: async file => (await stub.vscode.workspace.openTextDocument(file)).getText(),
    render: extension.renderForTest,
    format: extension.formatHtml
};

async function runSuiteText(text, files) {
    for (const [file, content] of Object.entries(files)) stub.workspaceFiles.set(file, content);
    return templateTests.runSuite(templateTests.parseSuite(text, SUITE), deps);
}

const SUITE_TEXT = `{
  "template": "report.liquid",
  "cases": [
    {
      "name": "ada",
      "data": { "name": "Ada", "items": [1, 2] },
      "checks": [
        { "name": "greets by name", "selector": "h1", "text": "Hello Ada" },
        { "name": "a row per item", "selector": "li", "count": 3 }
      ]
    }
  ]
}`;

test.beforeEach(() => harnessReset());

test('a failing check fails its case, and each check is reported on its own line', async () => {
    const { results: [r] } = await runSuiteText(SUITE_TEXT, { '/w/report.liquid': '<h1>Hello {{ name }}</h1><ul>{% for i in items %}<li>{{ i }}</li>{% endfor %}</ul>' });
    assert.strictEqual(r.status, 'failed');
    assert.deepStrictEqual(r.failures, [], 'check failures stay with their checks');
    assert.deepStrictEqual(r.checks.map(c => [c.name, c.status, c.line]), [['greets by name', 'passed', 8], ['a row per item', 'failed', 9]]);
    assert.deepStrictEqual(r.checks[1].failures, ['“li” matched 2 elements; expected 3.']);
});

test('when the case cannot render, its checks are reported as not run', async () => {
    const { results: [r] } = await runSuiteText(SUITE_TEXT, { '/w/report.liquid': '{% if %}' });
    assert.strictEqual(r.status, 'error');
    assert.deepStrictEqual(r.checks.map(c => c.status), ['skipped', 'skipped']);
});

test('a "checks" that is not a list is a case error', async () => {
    const suite = templateTests.parseSuite(JSON.stringify({ template: 'r.liquid', cases: [{ name: 'x', checks: {} }] }), SUITE);
    assert.strictEqual(suite.cases[0].error, '"checks" must be a list.');
});

test('the report lists each case\'s checks and counts them', async () => {
    const result = await runSuiteText(SUITE_TEXT, { '/w/report.liquid': '<h1>Hello {{ name }}</h1><ul>{% for i in items %}<li>{{ i }}</li>{% endfor %}</ul>' });
    const html = templateTests.buildReportHtml({ startedAt: Date.now(), durationMs: 1, suites: [result] });
    assert.match(html, /1 case \(2 checks, 1 failing\)/);
    assert.match(html, /<span class="check-count">1\/2 checks<\/span>/);
    assert.match(html, /<li class="check check-failed">[\s\S]*a row per item[\s\S]*matched 2 elements; expected 3/);
    assert.deepStrictEqual(
        (({ checks, checksFailed, checksSkipped }) => ({ checks, checksFailed, checksSkipped }))(templateTests.summarize([result])),
        { checks: 2, checksFailed: 1, checksSkipped: 0 }
    );
});

// ---- the command line -----------------------------------------------------------

test('the command line lists checks and writes each as its own JUnit test case', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-checks-'));
    try {
        fs.writeFileSync(path.join(dir, 'report.liquid'), '<h1>Hello {{ name }}</h1><ul>{% for i in items %}<li>{{ i }}</li>{% endfor %}</ul>');
        fs.writeFileSync(path.join(dir, 'report.liquidtest.json'), SUITE_TEXT);
        let out = '';
        const code = await cli.main(['--junit', 'j.xml'], { cwd: dir, stdout: { write: s => { out += s; }, isTTY: false }, stderr: { write() { } }, env: {} });
        assert.strictEqual(code, 1);
        assert.match(out, / {6}✓ greets by name\n {6}✗ a row per item\n {10}“li” matched 2 elements; expected 3\./);
        assert.match(out, /1 failed — 1 case \(2 checks, 1 failing\)/);

        const xml = fs.readFileSync(path.join(dir, 'j.xml'), 'utf8');
        assert.match(xml, /<testsuites name="Liquid template tests" tests="3" failures="1" errors="0" skipped="0"/);
        assert.match(xml, /<testcase name="ada" classname="report.liquidtest.json" time="[\d.]+"><\/testcase>/, 'the case\'s own assertions passed');
        assert.match(xml, /<testcase name="ada › a row per item"[^>]*><failure message="“li” matched 2 elements; expected 3.">/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---- the Test Explorer ----------------------------------------------------------

function controller() {
    return stub.testControllers.find(c => c.id === 'reporterLiquidTemplateTests');
}

test('checks appear under their case in the Test Explorer, on their own lines', async () => {
    stub.workspaceFiles.set('/w/report.liquid', 'x');
    stub.workspaceFiles.set(SUITE, SUITE_TEXT);
    const c = controller();
    await c.resolveHandler(undefined);
    const caseItem = c.items.get(SUITE).children.get(`${SUITE}::ada`);
    const checks = [];
    caseItem.children.forEach(item => checks.push([item.label, item.range.start.line]));
    assert.deepStrictEqual(checks, [['greets by name', 7], ['a row per item', 8]]);
});

test('running a check runs its case and reports each check\'s result', async () => {
    stub.workspaceFiles.set('/w/report.liquid', '<h1>Hello {{ name }}</h1><ul>{% for i in items %}<li>{{ i }}</li>{% endfor %}</ul>');
    stub.workspaceFiles.set(SUITE, SUITE_TEXT);
    const c = controller();
    await c.resolveHandler(undefined);
    const caseItem = c.items.get(SUITE).children.get(`${SUITE}::ada`);
    const checkItem = caseItem.children.get(`${SUITE}::ada::a row per item`);

    await c.profiles[0].runHandler({ include: [checkItem], exclude: [] }, { isCancellationRequested: false });
    const run = c.runs[c.runs.length - 1];
    const outcome = id => run.calls.filter(x => x.id === id && !['enqueued', 'started'].includes(x.state));

    assert.deepStrictEqual(outcome(`${SUITE}::ada::greets by name`).map(x => x.state), ['passed']);
    const [failed] = outcome(`${SUITE}::ada::a row per item`);
    assert.strictEqual(failed.state, 'failed');
    assert.strictEqual(failed.messages[0].message, '“li” matched 2 elements; expected 3.');
    assert.strictEqual(failed.messages[0].location.range.line, 8, 'points at the check (0-based)');

    const [caseOutcome] = outcome(`${SUITE}::ada`);
    assert.strictEqual(caseOutcome.state, 'failed');
    assert.match(caseOutcome.messages[0].message, /1 check failed: a row per item/);
});
