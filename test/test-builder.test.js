// The test builder in the HTML preview (webview/test-builder.js). It turns a
// click on the rendered page into checks, so a reader who has never seen a
// CSS selector can build a test. The promise that matters: every check it
// offers passes when the runner checks it against the same output. These load
// the builder into jsdom — whose HTML parser is parse5, the runner's — and hold
// it to that for every element of a realistic Reporter document.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const engine = require('../engine');
const { parseChecks, runChecks } = require('../output-checks');

const BUILDER = fs.readFileSync(path.join(__dirname, '..', 'webview', 'test-builder.js'), 'utf8');

const TEMPLATE = `
<h1>Invoice for {{ customer.name }}</h1>
<p class="intro">Thanks for your order &amp; your patience.</p>
{% editor "reference", placeholder: "Your reference" %}{% endeditor %}
{% editor "comments", lines: 3 %}{% endeditor %}
<table class="items">
  <tr><th>Item</th><th>Price</th></tr>
  {% for item in items %}
  <tr class="item"><td>{{ item.description }}</td><td class="price">{{ item.price | money }}</td></tr>
  {% endfor %}
</table>
<ul>{% for n in notes %}<li><span class="n">{{ n }}</span></li>{% endfor %}</ul>
{% optional "includeTerms" %}<p>Payment within <b>30 days</b>.</p>{% endoptional %}
{% choice "delivery", title: "Delivery" %}Post{% or %}Courier{% or %}Collect{% endchoice %}
<div id="odd:id.1"><p>Weird id</p></div>
<div><div><p>Nested</p></div><div><p>Nested</p></div></div>
<footer>Page 1</footer>`;

const DATA = {
    customer: { name: 'Ada Lovelace' },
    items: [{ description: 'Engine', price: 1250.5 }, { description: 'Cards', price: 42 }, { description: 'Oil', price: 3 }],
    notes: ['Fragile', 'Keep dry'],
    fields: { reference: 'PO-77', comments: 'Leave at the door', includeTerms: 'true', delivery: '1' }
};

async function renderedPage() {
    const { html } = await engine.renderForTest(TEMPLATE, DATA, '/w/invoice.liquid');
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="lp-rendered-root"></div></body>`, { runScripts: 'outside-only' });
    const root = dom.window.document.getElementById('lp-rendered-root');
    // The preview patches output in with innerHTML, so this is its tree.
    root.innerHTML = html;
    dom.window.eval(BUILDER);
    return { html, root, builder: dom.window.RLPTestBuilder, document: dom.window.document };
}

function passes(check, html) {
    const { checks } = parseChecks([Object.assign({ name: 'x' }, check)]);
    return runChecks(checks, html)[0];
}

test('every check the builder offers, for every element, passes against the output it came from', async () => {
    const { html, root, builder } = await renderedPage();
    const elements = Array.from(root.querySelectorAll('*'));
    assert.ok(elements.length > 40, 'a realistic page');

    let offered = 0;
    const broken = [];
    for (const el of elements) {
        for (const proposal of builder.proposalsFor(el, root)) {
            offered++;
            const result = passes(proposal.check, html);
            if (result.status !== 'passed') broken.push(`${el.outerHTML.slice(0, 60)} → ${proposal.kind} ${JSON.stringify(proposal.check)}: ${result.failures.join('; ')}`);
        }
    }
    assert.deepStrictEqual(broken, []);
    assert.ok(offered > elements.length * 2, `offers several checks per element (${offered} for ${elements.length})`);
});

test('every element can be picked out on its own', async () => {
    const { root, builder } = await renderedPage();
    const missing = Array.from(root.querySelectorAll('*')).filter(el => !builder.selectorFor(el, root)).map(el => el.outerHTML.slice(0, 60));
    assert.deepStrictEqual(missing, []);
});

test('selectors use names before positions', async () => {
    const { root, builder, document } = await renderedPage();
    assert.strictEqual(builder.selectorFor(document.getElementById('reference'), root), '#reference', 'Reporter field ids');
    assert.strictEqual(builder.selectorFor(root.querySelector('h1'), root), 'h1');
    assert.strictEqual(builder.selectorFor(root.querySelector('p.intro'), root), 'p.intro');
    assert.strictEqual(builder.selectorFor(document.getElementById('odd:id.1'), root), '#odd\\:id\\.1', 'awkward ids are escaped');
    assert.strictEqual(builder.selectorFor(root.querySelectorAll('.price')[1], root), 'tr:nth-of-type(3) > td:nth-of-type(2)', 'a position when nothing names it');
});

test('a table cell\'s likes are its column, not the rest of its row', async () => {
    const { html, root, builder } = await renderedPage();
    const price = root.querySelectorAll('.price')[1];
    const count = builder.proposalsFor(price, root).find(p => p.kind === 'count');
    assert.strictEqual(count.check.count, 3, 'the three prices');
    assert.strictEqual(count.name, 'There are 3 table cells like this');
    assert.deepStrictEqual(Array.from(root.querySelectorAll(count.check.selector)).map(td => td.textContent), ['1,250.50', '42.00', '3.00']);
    assert.strictEqual(passes(count.check, html).status, 'passed');
});

test('a repeated element offers a count of it and its likes', async () => {
    const { root, builder } = await renderedPage();
    const row = root.querySelectorAll('tr.item')[1];
    const count = builder.proposalsFor(row, root).find(p => p.kind === 'count');
    assert.strictEqual(count.check.count, 3, 'the rows the loop made, not the header row too');
    assert.strictEqual(count.check.selector, 'tr.item');
    assert.strictEqual(count.name, 'There are 3 table rows like this');
    const li = root.querySelector('li');
    const liCount = builder.proposalsFor(li, root).find(p => p.kind === 'count');
    assert.strictEqual(liCount.check.count, 2);
    assert.strictEqual(liCount.name, 'There are 2 list items');
});

test('proposals are in plain words, and the likely one comes first', async () => {
    const { root, builder, document } = await renderedPage();

    const heading = builder.proposalsFor(root.querySelector('h1'), root);
    assert.strictEqual(heading[0].kind, 'reads');
    assert.strictEqual(heading[0].label, 'It reads exactly “Invoice for Ada Lovelace”');
    assert.strictEqual(heading[0].name, 'The heading reads “Invoice for Ada Lovelace”');

    const tick = builder.proposalsFor(document.getElementById('includeTerms'), root);
    assert.strictEqual(tick[0].kind, 'ticked');
    assert.strictEqual(tick[0].label, 'It is ticked');
    assert.strictEqual(tick[0].name, '“Payment within 30 days.” is ticked');

    const reference = builder.proposalsFor(document.getElementById('reference'), root);
    assert.strictEqual(reference[0].name, 'The text box shows “PO-77”');

    const courier = builder.proposalsFor(document.getElementById('delivery-2'), root);
    assert.strictEqual(courier[0].name, '“Courier” is ticked');
    assert.strictEqual(builder.proposalsFor(document.getElementById('delivery-1'), root)[0].name, '“Post” is not ticked');
});

test('long text starts as "includes", for the reader to trim to what matters', async () => {
    const dom = new JSDOM('<div id="r"></div>', { runScripts: 'outside-only' });
    const root = dom.window.document.getElementById('r');
    root.innerHTML = `<p>${'All goods remain the property of the seller until paid in full. '.repeat(2)}</p>`;
    dom.window.eval(BUILDER);
    const [first] = dom.window.RLPTestBuilder.proposalsFor(root.querySelector('p'), root);
    assert.strictEqual(first.kind, 'includes');
    assert.strictEqual(first.nameFor('property of the seller'), 'The paragraph includes “property of the seller”');
});

test('the builder reads text exactly as the runner does', () => {
    const list = file => {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        return ['BREAKS', 'SILENT'].map(name => {
            const match = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
            return match[1].replace(/\s+/g, '');
        });
    };
    assert.deepStrictEqual(list('webview/test-builder.js'), list('output-checks.js'));
});

test('cssEscape matches the browser\'s CSS.escape', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    dom.window.eval(BUILDER);
    const { cssEscape } = dom.window.RLPTestBuilder;
    for (const [input, expected] of [['plain', 'plain'], ['odd:id.1', 'odd\\:id\\.1'], ['1abc', '\\31 abc'], ['-', '\\-'], ['-1x', '-\\31 x'], ['a b', 'a\\ b'], ['é', 'é']]) {
        assert.strictEqual(cssEscape(input), expected, input);
    }
});

// ---- the panel while closed -------------------------------------------------------
//
// The panel is fixed over the right-hand side of the preview. In 1.5.0 the
// closed panel still took that space — `all: initial` on its host reset the
// display that [hidden] relies on — and in a dark theme it showed as a black
// bar covering the page and the Create test button.

test('the closed panel\'s host is display: none, not reset to inline by all: initial', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'webview', 'test-builder.css'), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const host = /:host\s*\{([^}]*)\}/.exec(rules)[1];
    assert.match(host, /display:\s*block/, 'display is set explicitly after all: initial');
    assert.match(rules, /:host\(\[hidden\]\)\s*\{\s*display:\s*none;?\s*\}/);
    assert.match(rules, /\.panel\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});

test('in the real preview, the builder is hidden until opened and hidden again when closed', async () => {
    const { renderPreview } = require('./harness');
    const { panel } = await renderPreview({ template: '<h1>Hi {{ name }}</h1>', data: '{"name":"Ada"}' });
    const { VirtualConsole } = require('jsdom');
    const quiet = new VirtualConsole();
    const dom = new JSDOM(panel.webview.html, { runScripts: 'dangerously', virtualConsole: quiet, pretendToBeVisual: true });
    const { document } = dom.window;
    const host = document.getElementById('lp-builder');
    const builderPanel = () => host.shadowRoot.querySelector('.panel');

    assert.strictEqual(host.hidden, true);
    assert.strictEqual(builderPanel().hidden, true, 'the panel itself is hidden too');

    document.querySelector('[data-lp-local="build-test"]').click();
    assert.strictEqual(host.hidden, false);
    assert.strictEqual(builderPanel().hidden, false);
    assert.match(builderPanel().textContent, /Create a test/);

    builderPanel().querySelector('[data-do="close"]').click();
    assert.strictEqual(host.hidden, true);
    assert.strictEqual(builderPanel().hidden, true);
    assert.strictEqual(document.body.classList.contains('lp-building'), false, 'the page gets its width back');
});

// ---- counting what a loop made ------------------------------------------------------
//
// "There are 3 of these" is how a reader checks a loop ran once per item —
// three recommendations, three recommendation tables. It has to count the
// loop's output and nothing else, or a missing recommendation can hide behind
// another table on the page.

const RECOMMENDATIONS = { plans: ['A', 'B'], recommendations: [{ name: 'Critical Illness Plus' }, { name: 'Life Cover' }, { name: 'Income Protection' }] };

const LOOP_LAYOUTS = {
    'tables with a class, beside a plans table': `
<h1>Plans included</h1>
<table class="plans"><tr><td>Plans</td></tr>{% for p in plans %}<tr><td>{{ p }}</td></tr>{% endfor %}</table>
<h1>My recommendation</h1>
{% for r in recommendations %}<h2>{{ r.name }}</h2><table class="summary recommendation"><tr><td>Plan name</td><td>{{ r.name }}</td></tr></table>{% endfor %}`,
    'tables inside a repeated section': `
<section><h1>Plans</h1><table><tr><td>Plan list</td></tr></table></section>
{% for r in recommendations %}<section class="rec"><h2>{{ r.name }}</h2><table><tr><td>{{ r.name }}</td></tr></table></section>{% endfor %}`,
    'no classes at all': `
<div><table><tr><td>Plans</td></tr></table></div>
<div>{% for r in recommendations %}<div><table><tr><td>{{ r.name }}</td></tr></table></div>{% endfor %}</div>`,
    // The plans table sits at the top level of the output, whose parent in the
    // preview is its own container <div>. Matched in place, "div > table"
    // counted it too; the runner, reading the output on its own, never does.
    'no classes, each loop table in its own div, plans table at the top level': `
<h1>Plans included</h1><table><tr><td>Plans</td></tr></table>
{% for r in recommendations %}<div><h2>{{ r.name }}</h2><table><tr><td>{{ r.name }}</td></tr></table></div>{% endfor %}`,
    'no classes, the loop inside one wrapper div, plans table at the top level': `
<table><tr><td>Plans</td></tr></table>
<div>{% for r in recommendations %}<h2>{{ r.name }}</h2><table><tr><td>{{ r.name }}</td></tr></table>{% endfor %}</div>`
};

for (const [layout, template] of Object.entries(LOOP_LAYOUTS)) {
    test(`a loop's tables are counted, and only those: ${layout}`, async () => {
        const { html } = await engine.renderForTest(template, RECOMMENDATIONS, '/w/r.liquid');
        const dom = new JSDOM('<div id="r"></div>', { runScripts: 'outside-only' });
        const root = dom.window.document.getElementById('r');
        root.innerHTML = html;
        dom.window.eval(BUILDER);
        const tables = [...root.querySelectorAll('table')];
        const count = dom.window.RLPTestBuilder.proposalsFor(tables[tables.length - 2], root).find(p => p.kind === 'count');

        assert.strictEqual(count.check.count, 3);
        assert.match(count.name, /^There are 3 tables/);
        // Read what the check counts the runner's way: the output on its own.
        const alone = new JSDOM(`<body>${html}</body>`).window.document.body;
        const counted = [...alone.querySelectorAll(count.check.selector)].map(t => t.textContent);
        assert.ok(counted.every(text => /Critical Illness Plus|Life Cover|Income Protection/.test(text)), `only recommendation tables: ${JSON.stringify(counted)}`);
        assert.strictEqual(passes(count.check, html).status, 'passed');

        // And it notices a recommendation going missing, which counting every
        // table on the page would not.
        const fewer = (await engine.renderForTest(template, Object.assign({}, RECOMMENDATIONS, { recommendations: RECOMMENDATIONS.recommendations.slice(1) }), '/w/r.liquid')).html;
        assert.strictEqual(passes(count.check, fewer).status, 'failed');
    });
}

// ---- rows found by their label -------------------------------------------------------
//
// A report's label/value tables: "Plan name | NFUM Select…". A check found by
// position ("2nd row, 2nd cell") breaks when a table is added above it; one
// found by the row's label doesn't. This is the case that broke in practice.

const LETTER = (extraTable) => `
<section><h1>Your pension</h1>
${extraTable ? '<table><tr><td>Reference</td><td>REF-1</td></tr><tr><td>Adviser</td><td>James</td></tr></table>' : ''}
<table>
  <tr><td>Crystallisation amount</td><td>£65,639.13</td></tr>
  <tr><td>Plan name:</td><td>NFUM Select Personal Pension Plan - Decumulation</td></tr>
</table></section>`;

async function page(html) {
    const dom = new JSDOM('<div id="r"></div>', { runScripts: 'outside-only' });
    const root = dom.window.document.getElementById('r');
    root.innerHTML = html;
    dom.window.eval(BUILDER);
    return { root, builder: dom.window.RLPTestBuilder };
}

test('clicking a value cell offers a check found by its row label, first', async () => {
    const { root, builder } = await page(LETTER(false));
    const cell = [...root.querySelectorAll('td')].find(td => td.textContent.startsWith('NFUM'));
    const [first] = builder.proposalsFor(cell, root);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first.check)), { row: 'Plan name', text: 'NFUM Select Personal Pension Plan - Decumulation' });
    assert.strictEqual(first.name, '“Plan name” reads “NFUM Select Personal Pension Plan - Dec…”');
});

test('a check found by row label survives a table added above it; one found by position does not', async () => {
    const before = await page(LETTER(false));
    const cell = [...before.root.querySelectorAll('td')].find(td => td.textContent.startsWith('NFUM'));
    const proposals = before.builder.proposalsFor(cell, before.root);
    const byLabel = proposals.find(p => p.check.row && p.kind === 'reads').check;
    // What the builder would have written without the label to go on.
    const byPosition = { selector: before.builder.selectorFor(cell, before.root), text: byLabel.text };
    assert.ok(!proposals.some(p => p.check.selector && p.kind === 'reads'), 'the positional version isn\'t offered alongside');

    const after = LETTER(true);
    assert.strictEqual(passes(byLabel, after).status, 'passed', 'the label still finds it');
    const positional = passes(byPosition, after);
    assert.strictEqual(positional.status, 'failed', `the position now matches the wrong thing or two things: ${byPosition.selector}`);
});

test('a label in every row of a loop gives a list and a count of those rows', async () => {
    const recs = ['Critical Illness Plus', 'Life Cover', 'Income Protection'];
    const html = '<table><tr><td>Plans</td><td>2</td></tr></table>'
        + recs.map(r => `<table><tr><td>Plan name</td><td>${r}</td></tr><tr><td>Sum</td><td>1</td></tr></table>`).join('');
    const { root, builder } = await page(html);
    const cell = [...root.querySelectorAll('td')].find(td => td.textContent === 'Life Cover');
    const proposals = builder.proposalsFor(cell, root);

    const list = proposals.find(p => p.check.row && Array.isArray(p.check.text));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(list.check)), { row: 'Plan name', text: recs });
    assert.ok(proposals[0].check.row && !Array.isArray(proposals[0].check.text), '"just this table" — the one clicked — comes first');
    const count = proposals.find(p => p.check.row && p.kind === 'count');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(count.check)), { row: 'Plan name', count: 3 });
    assert.strictEqual(count.name, 'There are 3 “Plan name” rows');
    assert.strictEqual(passes(count.check, html).status, 'passed');
    assert.strictEqual(passes(count.check, html.replace(/<table><tr><td>Plan name<\/td><td>Life Cover[\s\S]*?<\/table>/, '')).status, 'failed', 'a missing recommendation is caught');
});

test('no row check is offered for a cell that isn\'t beside its row\'s label', async () => {
    const { root, builder } = await page('<table><tr><td>Plan</td><td>Aviva</td><td>£60,000</td></tr></table>');
    const third = root.querySelectorAll('td')[2];
    assert.ok(!builder.proposalsFor(third, root).some(p => p.check.row), 'the third column is not the "Plan" value');
    const first = root.querySelectorAll('td')[0];
    assert.ok(!builder.proposalsFor(first, root).some(p => p.check.row), 'nor is the label itself');
});

// ---- just this table ----------------------------------------------------------------

const TABLE = (rows, attrs = '') => `<table${attrs}>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;

test('"just this table" names the table by another label only it has, and survives tables added above', async () => {
    const letter = extra => (extra ? TABLE([['Plan name', 'NFUM Select'], ['Adviser', 'James']]) : '')
        + TABLE([['Reference', 'R1'], ['Plan name', 'NFUM Select']])
        + TABLE([['Crystallisation amount', '£65,639.13'], ['Plan name:', 'NFUM Select']]);
    const { root, builder } = await page(letter(false));
    const cell = [...root.querySelectorAll('td')].filter(td => td.textContent === 'NFUM Select').pop();
    const [first] = builder.proposalsFor(cell, root);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(first.check)), { tableWith: 'Crystallisation amount', row: 'Plan name', text: 'NFUM Select' });
    assert.strictEqual(first.name, '“Plan name” reads “NFUM Select” (in the table with “Crystallisation amount”)');
    assert.match(first.label, /^Just this table/);
    assert.strictEqual(passes(first.check, letter(true)).status, 'passed', 'another "Plan name" table above changes nothing');
});

test('"just this table" uses the table\'s class when it has one', async () => {
    const { root, builder } = await page(TABLE([['Plan name', 'A']], ' class="summary"') + TABLE([['Plan name', 'A']], ' class="detail"'));
    const cell = root.querySelectorAll('td')[3];
    const [first] = builder.proposalsFor(cell, root);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first.check)), { selector: 'table.detail', row: 'Plan name', text: 'A' });
});

test('with nothing to name the table by, "just this table" says it is found by position, and why that is fragile', async () => {
    const { root, builder } = await page(TABLE([['Plan name', 'A']]) + TABLE([['Plan name', 'A']]));
    const [first] = builder.proposalsFor(root.querySelectorAll('td')[3], root);
    assert.match(first.name, /\(in this table, found by its position\)$/);
    assert.match(first.label, /This breaks if tables are added above it; giving the table a class makes it sturdier/);
});

// ---- saved and run again --------------------------------------------------------------
//
// Every check the builder offers has to survive being saved — written to the
// suite through the real save path, read back and run. 1.8.0 shipped row
// checks that the save step silently stripped of their "row", because the
// list of keys a saved check keeps didn't include it.

test('every check the builder offers passes after being saved to a suite and run from it', async () => {
    const os = require('os');
    const { extension, harnessReset } = require('./harness');
    const templateTests = require('../template-tests');
    harnessReset();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-roundtrip-'));
    try {
        const template = `${TEMPLATE}
${TABLE([['Reference', 'R1'], ['Plan name', '{{ customer.name }}']])}
${TABLE([['Crystallisation amount', '£65,639.13'], ['Plan name:', '{{ customer.name }}']])}`;
        fs.writeFileSync(path.join(dir, 'letter.liquid'), template);
        fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(DATA));
        const { html } = await engine.renderForTest(template, DATA, path.join(dir, 'letter.liquid'));

        const dom = new JSDOM('<div id="r"></div>', { runScripts: 'outside-only' });
        const root = dom.window.document.getElementById('r');
        root.innerHTML = html;
        dom.window.eval(BUILDER);
        const offered = [];
        const seen = new Set();
        for (const el of root.querySelectorAll('*')) {
            for (const p of dom.window.RLPTestBuilder.proposalsFor(el, root)) {
                const check = JSON.parse(JSON.stringify(p.check));
                const key = JSON.stringify(check);
                if (!seen.has(key)) { seen.add(key); offered.push(Object.assign({ name: `${p.kind} ${offered.length}` }, check)); }
            }
        }
        assert.ok(offered.some(c => c.row) && offered.some(c => c.tableWith), 'row and table checks are among them');

        const replies = [];
        await extension.saveBuiltTest(
            { templateUri: path.join(dir, 'letter.liquid'), dataUri: path.join(dir, 'data.json') },
            { webview: { postMessage: m => { replies.push(m); return Promise.resolve(true); } } },
            { name: 'everything', checks: offered, wholePage: false }
        );
        assert.strictEqual(replies[0].ok, true, replies[0].message);

        const suiteFile = path.join(dir, 'letter.liquidtest.json');
        const saved = JSON.parse(fs.readFileSync(suiteFile, 'utf8')).cases[0].checks;
        assert.deepStrictEqual(saved.map(c => { const { name, ...rest } = c; return rest; }), offered.map(c => { const { name, ...rest } = c; return rest; }), 'saved exactly as offered');

        const suite = templateTests.parseSuite(fs.readFileSync(suiteFile, 'utf8'), suiteFile);
        const result = await templateTests.runSuite(suite, {
            readText: f => fs.promises.readFile(f, 'utf8'),
            render: engine.renderForTest,
            format: engine.formatHtml
        });
        const failing = result.results[0].checks.filter(c => c.status !== 'passed').map(c => `${c.name}: ${c.failures[0]}`);
        assert.deepStrictEqual(failing, []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        harnessReset();
    }
});
