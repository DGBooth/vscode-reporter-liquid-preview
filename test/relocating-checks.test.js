// Checks that look in the wrong place. A check found by position ("the 3rd
// paragraph") shifts onto its neighbour when a section above it is removed, so
// it fails reading the neighbour's text while its own text is still on the
// page. The report says so, and offers to find the check by its text instead;
// accepting would record the neighbour's text. The builder offers a
// position-free check first for parts with no name of their own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const { extension, stub, harnessReset } = require('./harness');
const templateTests = require('../template-tests');
const { parseChecks, runChecks, relocateCheck } = require('../output-checks');

const BUILDER = fs.readFileSync(path.join(__dirname, '..', 'webview', 'test-builder.js'), 'utf8');

// Built against the page with section A; run against the page without it.
const CHECKS = [
    { name: 'The paragraph reads “Section A”', selector: 'div > p:nth-of-type(2)', text: 'Section A' },
    { name: 'The paragraph reads “Terms apply”', selector: 'div > p:nth-of-type(3)', text: 'Terms apply' },
    { name: 'The paragraph includes “Signed”', selector: 'div > p:nth-of-type(4)', contains: 'Signed' }
];
const WITHOUT_A = '<div><p>Intro</p><p>Terms apply</p><p>Signed by Ada</p></div>';

function run(raw, html) {
    return runChecks(parseChecks(raw).checks, html);
}

test('a check whose text is still on the page, just not where it looks, is marked as looking in the wrong place', () => {
    const [removed, shifted, gone] = run(CHECKS, WITHOUT_A);
    assert.strictEqual(removed.relocatable, undefined, 'its text is gone: that is a real change');
    assert.strictEqual(shifted.relocatable, true);
    assert.match(shifted.failures.join(' '), /“Terms apply” is still on the page, just not where this check looks/);
    assert.strictEqual(gone.relocatable, true, 'matching nothing, with its text elsewhere');
});

test('a check whose text changed is not marked, nor one that failed for another reason', () => {
    const changed = run([{ name: 'h', selector: 'h1', text: 'For Fred' }], '<h1>For Ada</h1><p>Fred</p>')[0];
    assert.strictEqual(changed.relocatable, undefined);
    const twice = run([{ name: 'p', selector: 'p', text: 'Terms apply' }], WITHOUT_A)[0];
    assert.strictEqual(twice.relocatable, undefined, 'its text is in what it matches; moving it would not help');
    const row = run([{ name: 'r', row: 'Plan', text: 'Gold' }], '<table><tr><td>Plan</td><td>Silver</td></tr></table><p>Gold</p>')[0];
    assert.strictEqual(row.relocatable, undefined, 'a row check is found by its label, so it does not shift');
});

test('found by its text, a check looks for that text anywhere on the page, and is renamed to say so', () => {
    assert.deepStrictEqual(relocateCheck(CHECKS[1], WITHOUT_A).check, { name: 'The page shows “Terms apply”', contains: 'Terms apply' });
    assert.deepStrictEqual(relocateCheck(CHECKS[2], WITHOUT_A).check, { name: 'The page shows “Signed”', contains: 'Signed' });
    assert.deepStrictEqual(relocateCheck({ name: 'my own name', selector: 'p', text: 'Intro' }, WITHOUT_A).check, { name: 'my own name', contains: 'Intro' });
    assert.match(relocateCheck(CHECKS[0], WITHOUT_A).error, /still wouldn’t pass: The page should mention “Section A”/);
    assert.match(relocateCheck({ name: 'n', selector: 'li', count: 2 }, WITHOUT_A).error, /Only a check that finds text/);
});

// ---- the report and the extension ------------------------------------------------

let dir;
const at = rel => path.join(dir, rel);
const suite = () => JSON.parse(fs.readFileSync(at('report.liquidtest.json'), 'utf8'));
const TEMPLATE = '<div><p>Intro</p>{% if showA %}<p>Section A</p>{% endif %}<p>Terms apply</p><p>Signed by {{ name }}</p></div>';

test.beforeEach(() => {
    harnessReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-relocate-'));
    fs.mkdirSync(at('data'));
    fs.writeFileSync(at('report.liquid'), TEMPLATE);
    // Section A was removed from the page the checks were built against.
    fs.writeFileSync(at('data/ada.json'), '{"name":"Ada","showA":false}');
    fs.writeFileSync(at('report.liquidtest.json'), JSON.stringify({
        template: 'report.liquid',
        cases: [{ name: 'Ada', data: 'data/ada.json', checks: CHECKS.concat([{ name: 'The page mentions “Intro”', contains: 'Intro' }]) }]
    }, null, 2));
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const CASE = () => ({ suiteFile: at('report.liquidtest.json'), caseIndex: 0, caseName: 'Ada' });
const runAll = () => extension.runTemplateTests({ selection: [{ file: at('report.liquidtest.json'), only: null }] });

test('the report offers Find it by its text on each shifted check, and on the test for all of them', async () => {
    const html = templateTests.buildReportHtml(await runAll(), { interactive: true });
    const relocate = [...html.matchAll(/data-action="relocate-check"[^>]*data-check-name="([^"]*)"/g)].map(m => m[1]);
    assert.deepStrictEqual(relocate, ['The paragraph reads “Terms apply”', 'The paragraph includes “Signed”']);
    assert.match(html, /data-action="relocate-checks" data-suite="[^"]+" data-case="0" data-case-name="Ada"[^>]*>Find all 2 by their text</);
    assert.ok(!/data-action="relocate/.test(templateTests.buildReportHtml(await runAll())), 'a saved report changes nothing');
});

test('Find all by their text fixes every shifted check at once, after asking, and leaves the rest', async () => {
    await runAll();
    stub.warningAnswers.push('Find by text');
    assert.ok(await extension.relocateChecks(CASE()));
    assert.match(stub.shownMessages[0], /2 checks will look for their text anywhere on the page/);
    assert.deepStrictEqual(suite().cases[0].checks, [
        CHECKS[0],
        { name: 'The page shows “Terms apply”', contains: 'Terms apply' },
        { name: 'The page shows “Signed”', contains: 'Signed' },
        { name: 'The page mentions “Intro”', contains: 'Intro' }
    ]);
    const statuses = (await runAll()).suites[0].results[0].checks.map(c => c.status);
    assert.deepStrictEqual(statuses, ['failed', 'passed', 'passed', 'passed'], 'only the check for the removed section still fails');
});

test('one check can be found by its text on its own', async () => {
    await runAll();
    const one = Object.assign(CASE(), { checkIndex: 2, checkName: 'The paragraph includes “Signed”' });
    assert.ok(await extension.relocateChecks(one, { confirm: false }));
    assert.deepStrictEqual(suite().cases[0].checks[1], CHECKS[1], 'the others are untouched');
    assert.deepStrictEqual(suite().cases[0].checks[2], { name: 'The page shows “Signed”', contains: 'Signed' });
});

test('declining changes nothing, and a stale report changes nothing', async () => {
    const before = fs.readFileSync(at('report.liquidtest.json'), 'utf8');
    stub.warningAnswers.push(undefined);
    assert.strictEqual(await extension.relocateChecks(CASE()), null);
    const stale = Object.assign(CASE(), { checkIndex: 1, checkName: 'Something else' });
    assert.strictEqual(await extension.relocateChecks(stale, { confirm: false }), null);
    assert.match(stub.shownErrors[0], /has changed since the tests ran/);
    assert.strictEqual(fs.readFileSync(at('report.liquidtest.json'), 'utf8'), before);
});

// ---- the builder ----------------------------------------------------------------

function builderOn(html) {
    const dom = new JSDOM('<div id="r"></div>', { runScripts: 'outside-only' });
    const root = dom.window.document.getElementById('r');
    root.innerHTML = html;
    dom.window.eval(BUILDER);
    return { root, builder: dom.window.RLPTestBuilder };
}

test('for a part found only by its position, the builder first offers to check the page shows its text', () => {
    const { root, builder } = builderOn('<div><p>Intro</p><p>Terms apply</p><p>Signed</p></div>');
    const proposals = builder.proposalsFor(root.querySelectorAll('p')[1], root);
    assert.deepStrictEqual({ ...proposals[0].check }, { contains: 'Terms apply' });
    assert.strictEqual(proposals[0].name, 'The page shows “Terms apply”');
    assert.strictEqual(proposals[0].nameFor('Terms'), 'The page shows “Terms”');
    const reads = proposals.find(p => p.kind === 'reads');
    assert.match(reads.check.selector, /:nth-/);
    assert.match(reads.label, /found by position: breaks if anything above it is added or removed/);
});

test('a part with a name of its own is still checked where it is', () => {
    const { root, builder } = builderOn('<div><p>Intro</p><p class="terms">Terms apply</p></div>');
    const proposals = builder.proposalsFor(root.querySelector('.terms'), root);
    assert.strictEqual(proposals[0].kind, 'reads');
    assert.deepStrictEqual({ ...proposals[0].check }, { selector: 'p.terms', text: 'Terms apply' });
    assert.ok(proposals.every(p => !/found by position/.test(p.label)));
});
