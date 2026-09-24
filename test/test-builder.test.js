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
    assert.deepStrictEqual(count.check.count, 4, 'the header row is a row too');
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
