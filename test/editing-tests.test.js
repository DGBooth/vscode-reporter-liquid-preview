// Changing tests after they're made: accepting one check's new result from
// the report, removing a check, and editing a test in the builder — adding,
// removing and reordering its checks. Each change goes through the suite file
// by the test's position and name, so a suite edited since the run can't have
// the wrong test changed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const { extension, stub, harnessReset, renderPreview } = require('./harness');
const templateTests = require('../template-tests');
const { acceptCheck } = require('../output-checks');

// ---- accepting a check's new result: the logic ------------------------------------

const PAGE = '<h1>For Client4</h1><table><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></table><input type="checkbox" id="notes">';

test('accepting updates the expected value, and the name where it quoted it', () => {
    const cases = [
        [{ name: 'The heading reads “For Fred”', selector: 'h1', text: 'For Fred' },
            { name: 'The heading reads “For Client4”', selector: 'h1', text: 'For Client4' }],
        [{ name: 'There are 2 table rows', selector: 'tr', count: 2 },
            { name: 'There are 3 table rows', selector: 'tr', count: 3 }],
        [{ name: '“Notes” is ticked', selector: '#notes', attributes: { checked: true } },
            { name: '“Notes” is not ticked', selector: '#notes', attributes: { checked: false } }],
        [{ name: 'The footer is shown', selector: 'footer', exists: true },
            { name: 'The footer is not shown', selector: 'footer', exists: false }],
        [{ name: 'cells in order', selector: 'td', text: ['a', 'x'] },
            { name: 'cells in order', selector: 'td', text: ['a', 'b', 'c'] }]
    ];
    for (const [before, after] of cases) {
        const result = acceptCheck(before, PAGE);
        assert.deepStrictEqual(result.check, after, before.name);
    }
});

test('a name cut short by the builder is updated too', () => {
    const long = 'Analytical engine service and maintenance contract';
    const { check } = acceptCheck({ name: 'The heading reads “Analytical engine service and maintenan…”', selector: 'h1', text: long }, '<h1>Something else entirely</h1>');
    assert.strictEqual(check.name, 'The heading reads “Something else entirely”');
});

test('the changes are described, for the confirmation', () => {
    assert.deepStrictEqual(acceptCheck({ name: 'n', selector: 'tr', count: 2 }, PAGE).changes, [{ what: 'count', from: 2, to: 3 }]);
});

test('there is nothing to accept where no single new value is right', () => {
    assert.match(acceptCheck({ name: 'p', contains: 'Net 30' }, PAGE).error, /looks for a phrase on the page/);
    assert.match(acceptCheck({ name: 'p', selector: 'h1', contains: 'Fred' }, PAGE).error, /looks for a phrase/);
    assert.match(acceptCheck({ name: 'one cell', selector: 'td', text: 'a' }, PAGE).error, /matches 3 elements now, so there is no single text/);
    assert.match(acceptCheck({ name: 'gone', selector: 'ul', text: 'x' }, PAGE).error, /matches nothing now/);
});

// ---- editing a suite ------------------------------------------------------------------

test('a case is edited in place, and every other case and setting kept', () => {
    const text = JSON.stringify({ template: 'r.liquid', whitespace: 'collapse', cases: [{ name: 'a', checks: [{ name: 'x', selector: 'h1' }] }, { name: 'b', data: 'd.json' }] });
    const out = JSON.parse(templateTests.editCase(text, '/w/s.liquidtest.json', 0, 'a', raw => { raw.checks = []; }));
    assert.deepStrictEqual(out, { template: 'r.liquid', whitespace: 'collapse', cases: [{ name: 'a', checks: [] }, { name: 'b', data: 'd.json' }] });
});

test('a case that isn\'t where it was is not edited', () => {
    const text = JSON.stringify({ template: 'r.liquid', cases: [{ name: 'b' }, { name: 'a' }] });
    assert.throws(() => templateTests.editCase(text, '/w/s.liquidtest.json', 0, 'a', () => { }), /has changed since the tests ran/);
});

// ---- the extension ------------------------------------------------------------------------

let dir;
const at = rel => path.join(dir, rel);
const suite = () => JSON.parse(fs.readFileSync(at('report.liquidtest.json'), 'utf8'));

function workspace() {
    fs.mkdirSync(at('data'), { recursive: true });
    fs.writeFileSync(at('report.liquid'), '<h1>For {{ client }}</h1><ul>{% for i in items %}<li>{{ i }}</li>{% endfor %}</ul>');
    fs.writeFileSync(at('data/fred.json'), '{"client":"Client4","items":[1,2,3]}');
    fs.writeFileSync(at('report.liquidtest.json'), JSON.stringify({
        template: 'report.liquid',
        cases: [{
            name: 'Fred',
            data: 'data/fred.json',
            checks: [
                { name: 'The heading reads “For Fred”', selector: 'h1', text: 'For Fred' },
                { name: 'There are 2 list items', selector: 'li', count: 2 },
                { name: 'The page doesn’t mention “Error”', notContains: 'Error' }
            ]
        }]
    }, null, 2));
}

test.beforeEach(() => {
    harnessReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-edit-'));
    workspace();
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const HEADING = () => ({ suiteFile: at('report.liquidtest.json'), caseIndex: 0, caseName: 'Fred', checkIndex: 0, checkName: 'The heading reads “For Fred”' });

test('Accept new result updates that one check, after saying what changes', async () => {
    await extension.runTemplateTests({ selection: [{ file: at('report.liquidtest.json'), only: null }] });
    stub.warningAnswers.push('Accept');
    const accepted = await extension.acceptCheckResult(HEADING());
    assert.ok(accepted);
    assert.match(stub.shownMessages[0], /Accept the new result for “The heading reads “For Fred”” in “Fred”\? it expected “For Fred”; the page now has “For Client4”/);

    const checks = suite().cases[0].checks;
    assert.deepStrictEqual(checks[0], { name: 'The heading reads “For Client4”', selector: 'h1', text: 'For Client4' });
    assert.deepStrictEqual(checks[1], { name: 'There are 2 list items', selector: 'li', count: 2 }, 'the other checks are untouched');
});

test('declining the confirmation changes nothing', async () => {
    const before = fs.readFileSync(at('report.liquidtest.json'), 'utf8');
    stub.warningAnswers.push(undefined);
    assert.strictEqual(await extension.acceptCheckResult(HEADING()), null);
    assert.strictEqual(fs.readFileSync(at('report.liquidtest.json'), 'utf8'), before);
});

test('a check can\'t be accepted if the suite moved since the run', async () => {
    const stale = Object.assign(HEADING(), { checkName: 'Something else' });
    assert.strictEqual(await extension.acceptCheckResult(stale, { confirm: false }), null);
    assert.match(stub.shownErrors[0], /has changed since the tests ran/);
});

test('a test that lost its checks since the run gets a plain answer, not a crash', async () => {
    const text = suite();
    delete text.cases[0].checks;
    fs.writeFileSync(at('report.liquidtest.json'), JSON.stringify(text));
    assert.strictEqual(await extension.acceptCheckResult(HEADING(), { confirm: false }), null);
    assert.match(stub.shownErrors[0], /has changed since the tests ran/);
});

test('Remove check takes out just that check', async () => {
    stub.warningAnswers.push('Remove');
    assert.strictEqual(await extension.removeCheck(Object.assign(HEADING(), { checkIndex: 1, checkName: 'There are 2 list items' })), true);
    assert.deepStrictEqual(suite().cases[0].checks.map(c => c.name), ['The heading reads “For Fred”', 'The page doesn’t mention “Error”']);
});

test('the report offers Accept only where there is a new result to accept, and Edit on each test', async () => {
    fs.writeFileSync(at('data/fred.json'), '{"client":"Client4","items":[1,2,3],"x":"Error"}');
    fs.writeFileSync(at('report.liquid'), '<h1>For {{ client }}</h1><ul>{% for i in items %}<li>{{ i }}</li>{% endfor %}</ul>{{ x }}');
    const report = await extension.runTemplateTests({ selection: [{ file: at('report.liquidtest.json'), only: null }] });
    const html = templateTests.buildReportHtml(report, { interactive: true });

    const accepts = [...html.matchAll(/data-action="accept-check"[^>]*data-check-name="([^"]*)"/g)].map(m => m[1]);
    const removes = [...html.matchAll(/data-action="remove-check"[^>]*data-check-name="([^"]*)"/g)].map(m => m[1]);
    assert.deepStrictEqual(accepts, ['The heading reads “For Fred”', 'There are 2 list items']);
    assert.deepStrictEqual(removes, ['The heading reads “For Fred”', 'There are 2 list items', 'The page doesn’t mention “Error”']);
    assert.match(html, /data-action="edit-test" data-suite="[^"]+" data-case="0" data-case-name="Fred"/);

    const saved = templateTests.buildReportHtml(report);
    assert.ok(!/data-action="(accept-check|remove-check|edit-test)"/.test(saved), 'a saved report changes nothing');
});

// ---- editing in the builder --------------------------------------------------------------

function builderPanel() {
    const replies = [];
    return { replies, webview: { postMessage: m => { replies.push(m); return Promise.resolve(true); } } };
}
const preview = () => ({ templateUri: at('report.liquid'), dataUri: at('data/fred.json') });
const EDITING = () => ({ suiteFile: at('report.liquidtest.json'), caseIndex: 0, originalName: 'Fred' });

test('the builder is told which tests this template and data file already have', async () => {
    const panel = builderPanel();
    await extension.listBuiltTests(preview(), panel);
    const [{ type, tests }] = panel.replies;
    assert.strictEqual(type, 'builderTests');
    assert.deepStrictEqual(tests.map(t => [t.name, t.index, t.checks.length]), [['Fred', 0, 3]]);
});

test('saving an edited test replaces its checks in the new order, keeping what it didn\'t touch', async () => {
    const panel = builderPanel();
    const current = suite().cases[0].checks;
    await extension.saveBuiltTest(preview(), panel, {
        name: 'Fred',
        editing: EDITING(),
        // Reordered, the count check removed, a new one added.
        checks: [current[2], current[0], { name: 'The page mentions “Client4”', contains: 'Client4' }],
        newChecks: [2]
    });
    assert.strictEqual(panel.replies[0].ok, true, panel.replies[0].message);
    assert.match(panel.replies[0].message, /Some of its checks still fail/, 'the heading check still fails — editing doesn\'t hide that');
    assert.deepStrictEqual(suite().cases[0].checks.map(c => c.name), ['The page doesn’t mention “Error”', 'The heading reads “For Fred”', 'The page mentions “Client4”']);
    assert.strictEqual(suite().cases[0].data, 'data/fred.json');
});

test('a new check that doesn\'t pass is refused; an old failing one isn\'t in the way', async () => {
    const panel = builderPanel();
    const current = suite().cases[0].checks;
    await extension.saveBuiltTest(preview(), panel, {
        name: 'Fred', editing: EDITING(),
        checks: [current[0], { name: 'Says Bob', selector: 'h1', text: 'For Bob' }],
        newChecks: [1]
    });
    assert.strictEqual(panel.replies[0].ok, false);
    assert.match(panel.replies[0].message, /a new check doesn’t pass against the current output: Says Bob/);
    assert.strictEqual(suite().cases[0].checks.length, 3, 'nothing written');
});

test('an edited test can be renamed, but not to another test\'s name, and can\'t be left empty', async () => {
    const text = suite();
    text.cases.push({ name: 'Other', data: 'data/fred.json', checks: [{ name: 'c', selector: 'h1' }] });
    fs.writeFileSync(at('report.liquidtest.json'), JSON.stringify(text));

    const taken = builderPanel();
    await extension.saveBuiltTest(preview(), taken, { name: 'Other', editing: EDITING(), checks: text.cases[0].checks, newChecks: [] });
    assert.match(taken.replies[0].message, /already called “Other”/);

    const empty = builderPanel();
    await extension.saveBuiltTest(preview(), empty, { name: 'Fred', editing: EDITING(), checks: [], newChecks: [] });
    assert.match(empty.replies[0].message, /A test needs at least one check/);

    const renamed = builderPanel();
    await extension.saveBuiltTest(preview(), renamed, { name: 'Fred (Client4)', editing: EDITING(), checks: text.cases[0].checks, newChecks: [] });
    assert.strictEqual(renamed.replies[0].ok, true);
    assert.deepStrictEqual(suite().cases.map(c => c.name), ['Fred (Client4)', 'Other']);
});

// ---- the builder panel --------------------------------------------------------------------

async function builderPage(edit) {
    fs.writeFileSync(at('report.liquid'), '<h1>For {{ client }}</h1><p class="note">Hello</p>');
    const { panel } = await renderPreview({ template: '<h1>For {{ client }}</h1><p class="note">Hello</p>', data: '{"client":"Client4"}' });
    let page = panel.webview.html;
    if (edit) page = page.replace('<aside id="lp-builder" hidden', `<aside id="lp-builder" hidden data-edit="${JSON.stringify(edit).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
    const dom = new JSDOM(page, { runScripts: 'dangerously', virtualConsole: new VirtualConsole(), pretendToBeVisual: true, beforeParse(window) {
        window.__posted = [];
        window.acquireVsCodeApi = () => ({ postMessage: m => window.__posted.push(m) });
    } });
    const { document } = dom.window;
    const shadow = document.getElementById('lp-builder').shadowRoot;
    const send = message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
    return { dom, document, shadow, send, posted: dom.window.__posted };
}

const TESTS = [{
    suiteFile: '/w/report.liquidtest.json', index: 0, name: 'Fred',
    checks: [
        { name: 'first', selector: 'h1', text: 'For Client4' },
        { name: 'second', selector: 'p.note', text: 'Hello' },
        { name: 'third', notContains: 'Error' }
    ]
}];

test('the builder lists this page\'s tests, and picking one loads its checks to reorder', async () => {
    const { document, shadow, send, posted } = await builderPage();
    document.querySelector('[data-lp-local="build-test"]').click();
    assert.ok(posted.some(m => m.action === 'listBuiltTests'), 'asks which tests exist');
    send({ type: 'builderTests', tests: TESTS });

    const select = shadow.querySelector('select[data-field="test"]');
    assert.deepStrictEqual([...select.options].map(o => o.textContent), ['A new test', 'Edit “Fred”']);
    select.value = '0';
    select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    assert.match(shadow.textContent, /Edit a test/);

    shadow.querySelector('[data-do="down"][data-index="0"]').click();   // first ↓
    shadow.querySelector('[data-do="remove"][data-index="2"]').click(); // drop third
    assert.strictEqual(shadow.querySelector('[data-do="up"][data-index="0"]').disabled, true, 'the top one can\'t move up');

    shadow.querySelector('[data-do="save"]').click();
    // Messages come from jsdom's realm; compare them as plain data.
    const save = JSON.parse(JSON.stringify(posted.find(m => m.action === 'saveBuiltTest')));
    assert.deepStrictEqual(save.checks.map(c => c.name), ['second', 'first']);
    assert.deepStrictEqual(save.editing, { suiteFile: '/w/report.liquidtest.json', caseIndex: 0, originalName: 'Fred' });
    assert.deepStrictEqual(save.newChecks, [], 'nothing new was added');
});

test('a check added while editing is marked new, and only it has to pass', async () => {
    const { document, shadow, send, posted } = await builderPage();
    document.querySelector('[data-lp-local="build-test"]').click();
    send({ type: 'builderTests', tests: TESTS });
    const select = shadow.querySelector('select[data-field="test"]');
    select.value = '0';
    select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));

    document.querySelector('#lp-rendered-root p.note').click();
    shadow.querySelector('[data-do="add"]').click();
    assert.match(shadow.querySelector('.checks').textContent, /new/);

    shadow.querySelector('[data-do="save"]').click();
    const save = JSON.parse(JSON.stringify(posted.find(m => m.action === 'saveBuiltTest')));
    assert.deepStrictEqual(save.newChecks, [3]);
});

test('"Edit test" from the report opens the builder already on that test', async () => {
    const { shadow } = await builderPage(TESTS[0]);
    assert.strictEqual(shadow.querySelector('.panel').hidden, false);
    assert.match(shadow.textContent, /Edit a test/);
    assert.deepStrictEqual([...shadow.querySelectorAll('.check-text')].map(e => e.textContent), ['first', 'second', 'third']);
});
