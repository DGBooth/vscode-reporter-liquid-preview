// `{% echo value %}` is `{{ value }}`. Reporter accepts it; LiquidJS only gained the
// tag in version 10 and this runs 8, so a template that works in Reporter failed
// to preview with "tag echo not found". Each case here is held to what {{ }}
// gives, since the tag is that and nothing more.

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../engine');
const { extension } = require('./harness');

const DATA = { name: 'ada', items: [1, 2, 3], customer: { name: 'Ada Lovelace' }, fields: {} };

async function render(text, data = DATA) {
    return engine.renderForTest(text, data, '/w/t.liquid');
}

test('echo gives what {{ }} gives, filters and all', async () => {
    for (const expression of ['name', 'name | upcase', 'name | upcase | append: "!"', '"a b" | capitalize', 'customer.name | split: " " | first', 'items | size', 'items | join: "-"', 'missing', '5', 'name | default: "x"', 'missing | default: "none"']) {
        const tag = await render(`[{% echo ${expression} %}]`);
        const output = await render(`[{{ ${expression} }}]`);
        assert.strictEqual(tag.html, output.html, expression);
        assert.deepStrictEqual(tag.diagnostics, output.diagnostics, `${expression}: the same problems`);
    }
});

test('echo works wherever an output does: loops, conditions, and Reporter’s own tags', async () => {
    assert.strictEqual((await render('{% for i in items %}{% echo i %},{% endfor %}')).html, '1,2,3,');
    assert.strictEqual((await render('{% if name %}{% echo name | upcase %}{% endif %}')).html, 'ADA');
    const optional = await render('{% optional "survey9", title:"If tax residency declaration needed" %}\n  <p>{% echo name %}</p>\n{% endoptional %}');
    assert.strictEqual(optional.diagnostics.length, 0);
    assert.match(optional.html, /<p>ada<\/p>/);
    assert.match((await render('{% choice "c" %}A {% echo name %}{% or %}B{% endchoice %}')).html, /A ada/);
    assert.strictEqual((await render('{% editor "e" %}{% echo name %}{% endeditor %}')).diagnostics.length, 0);
});

test('echo takes whitespace control like any tag', async () => {
    assert.strictEqual((await render('a   {%- echo name -%}   b')).html, 'aadab');
    assert.strictEqual((await render('a   {% echo name -%}   b')).html, 'a   adab');
});

test('an echo with nothing to show is an error, located at the tag', async () => {
    const result = await render('one\ntwo {% echo %}\nthree');
    assert.strictEqual(result.html, null);
    assert.strictEqual(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0].message, /echo needs a value/);
    assert.strictEqual(result.diagnostics[0].line, 2);
    assert.strictEqual(result.diagnostics[0].col, 5);
});

test('a warning from a filter in an echo is located at the echo, as it would be in {{ }}', async () => {
    const text = 'one\ntwo {% echo missing | slice: 0, 3 %}\n';
    const tag = (await render(text)).diagnostics;
    const output = (await render('one\ntwo {{ missing | slice: 0, 3 }}\n')).diagnostics;
    assert.strictEqual(tag.length, 1);
    assert.strictEqual(tag[0].line, 2);
    assert.strictEqual(tag[0].col, 5);
    assert.strictEqual(tag[0].message, output[0].message);
});

test('echo is among the tags offered, and described', () => {
    const editing = require('../editing');
    assert.ok(editing.known().tags.includes('echo'));
    assert.strictEqual(editing.TAGS.echo[0], 'echo ${1:value} %}');
});

test('the Full HTML Preview shows an echo as the value it gives, and counts it', () => {
    const { rendered, chrome } = extension.buildFullPreviewContent('<p>Hi {% echo customer.name | upcase %}, plan {{ plan }} {%- echo x -%}!</p>');
    assert.match(rendered, /Hi <span class="lp-var">customer name<\/span>, plan <span class="lp-var">plan<\/span> <span class="lp-var">x<\/span>!/);
    assert.match(chrome, /contains 3 data values/);
});

test('echo shows a date two weeks ahead, as the real letters use it', async () => {
    const day = 24 * 60 * 60 * 1000;
    const before = Date.now();
    const out = await render("{% echo 'now' | date: '%s' | plus: 1209600 | date: '%e %B %Y' %}");
    const after = Date.now();
    assert.deepStrictEqual(out.diagnostics, []);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const wanted = new Set([before, after].map(t => {
        const d = new Date(t + 14 * day);
        return `${String(d.getDate()).padStart(2, ' ').trim()} ${months[d.getMonth()]} ${d.getFullYear()}`.trim();
    }));
    assert.ok(wanted.has(out.html.trim()), `${out.html} is not 14 days from now (${[...wanted]})`);
});
