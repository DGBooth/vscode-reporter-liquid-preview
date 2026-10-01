// Formatting a template (formatter.js): laid out by Shopify's Liquid plugin
// for Prettier, Reporter's own tags included, in the `{%-` house style, and
// refused or held back wherever it would change what the page shows.

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../engine');
const { formatTemplate, layOut, differenceBetween } = require('../formatter');

const render = async (text, data) => (await engine.renderForTest(text, data, '/w/t.liquid')).html;
const format = (text, ...data) => formatTemplate(text, { render, datasets: data.map((d, i) => ({ label: `data ${i + 1}`, data: d })) });

test('Reporter’s tags are laid out as blocks, and come back as written', async () => {
    const { text } = await format(
        '{% if a %}{% optional "notes" %}<p>Notes</p>{% endoptional %}{% endif %}\n{% editor "ref", placeholder: "Your ref" %}{% endeditor %}',
        { a: true, fields: { notes: 'true' } });
    assert.strictEqual(text, [
        // The plugin adds -%} where the template had no whitespace to keep.
        '{%- if a -%}',
        '  {%- optional "notes" %}',
        '    <p>Notes</p>',
        '  {%- endoptional -%}',
        '{%- endif %}',
        '{%- editor "ref", placeholder: "Your ref" %}{% endeditor %}',
        ''
    ].join('\n'));
});

test('a choice keeps its options, whose text is part of the page', async () => {
    const source = '{% choice "delivery", title: "Delivery" %}Post{% or %}Courier{% endchoice %}';
    const { text } = await format(source, { fields: { delivery: '1' } });
    assert.match(text, /\{%-? choice "delivery", title: "Delivery" %\}Post\{% or %\}Courier\{% endchoice %\}/);
});

test('Liquid strings keep their double quotes', async () => {
    const { text } = await format('{% assign x = items | where: "kind", "car" %}{{ x | size }}', { items: [] });
    assert.match(text, /where: "kind", "car"/);
});

test('a tag starting a line trims the space before it, unless the page needs that space', async () => {
    const { text, trimmed, keptSpacing } = await format('<span>a</span>\n{% if x %}<span>b</span>{% endif %}\n<div>{% if x %}<p>c</p>{% endif %}</div>', { x: true });
    assert.match(text, /<span>a<\/span>\n\{% if x/, 'trimming here would run "a" and "b" together');
    assert.match(text, /\{%- if x %\}\n\s*<p>c<\/p>/, 'beside a block, the space isn’t seen');
    assert.ok(trimmed >= 1);
    assert.strictEqual(keptSpacing, 1);
});

test('formatting twice changes nothing more', async () => {
    const source = '<table>{% for i in items %}<tr><td>{{ i }}</td></tr>{% endfor %}</table>{% optional "n" %}<p>x</p>{% endoptional %}';
    const once = (await format(source, { items: [1, 2] })).text;
    assert.strictEqual((await format(once, { items: [1, 2] })).text, once);
});

test('raw and comment blocks are left as written', async () => {
    const { text } = await format('{% raw %}{% optional "x" %}{% endraw %}{% comment %} {% choice %} {% endcomment %}<p>y</p>', {});
    assert.match(text, /\{%-? raw %\}\{% optional "x" %\}\{% endraw %\}/);
    assert.match(text, /\{%-? comment %\} \{% choice %\} \{% endcomment %\}/);
});

test('a layout that would change the page is refused, saying with which data', async () => {
    // A render that shows the template's own text: any change is a change.
    const verbatim = async text => `<pre>${text.replace(/</g, '&lt;')}</pre>`;
    const result = await formatTemplate('<p>a</p><p>b</p>', { render: verbatim, datasets: [{ label: 'fred.json', data: {} }] });
    assert.match(result.error, /would change what the page shows with fred\.json/);
    assert.ok(result.difference.before && result.difference.after);
    assert.strictEqual(result.text, undefined);
});

test('a template that can’t be read, or doesn’t render, is left alone', async () => {
    assert.match((await format('<div>{% if a %}</div>{% endif %', {})).error, /doesn’t render at the moment/);
    assert.match((await format('{% if a %}<p>x</p>', {})).error, /couldn’t be read for formatting|doesn’t render/);
});

test('pages compare as a reader sees them', () => {
    assert.strictEqual(differenceBetween('<p>a</p><p>b</p>', '<p>\n  a\n</p>\n<p>b</p>'), null, 'layout between blocks');
    assert.strictEqual(differenceBetween('<p>Dear <b>Mr</b> X</p>', '<p>\n  Dear <b>Mr</b>\n  X\n</p>'), null, 'a space is a space');
    assert.ok(differenceBetween('<p>Dear <b>Mr</b></p>', '<p>Dear<b>Mr</b></p>'), 'a lost space is seen');
    assert.ok(differenceBetween('<pre>a\n b</pre>', '<pre>a\nb</pre>'), 'in <pre>, whitespace counts');
    assert.ok(differenceBetween('<p class="x">a</p>', '<p class="y">a</p>'), 'attributes count');
    assert.strictEqual(differenceBetween('<style>.a{color:red}</style>', '<style>\n  .a {\n    color: red;\n  }\n</style>'), null, 'a stylesheet’s layout doesn’t');
});

test('the indentation follows the editor’s settings', async () => {
    const source = '<div><p>first</p><p>second</p></div>';
    assert.match(await layOut(source, { tabWidth: 4, printWidth: 20 }), /\n {4}<p>first<\/p>/);
    assert.match(await layOut(source, { useTabs: true, printWidth: 20 }), /\n\t<p>first<\/p>/);
});
