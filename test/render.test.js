// The engine's template loop is wrapped so warnings can name the line they came
// from (trackRenderPosition). The wrapper reimplements a LiquidJS internal, so
// the first thing to guard is that it changed nothing about what gets rendered:
// every case below is compared against a stock engine carrying the same custom
// tags and filters, and has to come out byte for byte identical.

const test = require('node:test');
const assert = require('node:assert');

const { extension } = require('./harness');
const Liquid = require('liquidjs');

const stock = new Liquid();
extension.registerCustomTags(stock);
extension.registerCustomFilters(stock);

const cases = [
    ['plain output', 'Hello {{ name }}!', { name: 'Ada' }],
    ['missing value', 'Hello {{ nope }}!', {}],
    ['for loop', '{% for i in (1..4) %}[{{ i }}]{% endfor %}', {}],
    ['for over data', '{% for x in list %}{{ x.n }},{% endfor %}', { list: [{ n: 1 }, { n: 2 }] }],
    ['for else', '{% for x in list %}{{ x }}{% else %}none{% endfor %}', { list: [] }],
    ['break', '{% for i in (1..5) %}[{{ i }}]{% if i == 3 %}{% break %}{% endif %}{% endfor %}', {}],
    ['break before output', '{% for i in (1..5) %}{% if i > 2 %}{% break %}{% endif %}{{ i }}{% endfor %}', {}],
    ['continue', '{% for i in (1..4) %}{% if i == 2 %}{% continue %}{% endif %}[{{ i }}]{% endfor %}', {}],
    ['nested break', '{% for a in (1..3) %}<{% for b in (1..3) %}{% if b == 2 %}{% break %}{% endif %}{{ b }}{% endfor %}>{% endfor %}', {}],
    ['capture', '{% capture c %}{% for i in (1..3) %}{{ i }}{% endfor %}{% endcapture %}[{{ c }}]', {}],
    ['assign', '{% assign a = "x" %}{{ a }}', {}],
    ['if elsif else', '{% if n == 1 %}one{% elsif n == 2 %}two{% else %}many{% endif %}', { n: 2 }],
    ['case', '{% case n %}{% when 1 %}one{% when 2 %}two{% else %}many{% endcase %}', { n: 3 }],
    ['unless', '{% unless n %}empty{% endunless %}', {}],
    ['tablerow', '{% tablerow i in (1..2) %}{{ i }}{% endtablerow %}', {}],
    ['raw', '{% raw %}{{ not.interpolated }}{% endraw %}', {}],
    ['comment', 'a{% comment %}hidden{% endcomment %}b', {}],
    ['optional tag', '{% optional "opt" %}body{% endoptional %}', { fields: { opt: 'true' } }],
    ['optional unchecked', '{% optional "opt" %}body{% endoptional %}', { fields: {} }],
    ['editor tag', '{% editor "note", lines: 3, placeholder: "hi" %}{% endeditor %}', { fields: { note: 'typed' } }],
    ['editor single line', '{% editor "note" %}{% endeditor %}', { fields: {} }],
    ['choice tag', '{% choice "pick", title: "T" %}A{% or %}B{% endchoice %}', { fields: { pick: '1' } }],
    ['choice in a loop', '{% for i in (1..2) %}{% choice "c" %}A{% or %}B{% endchoice %}{% endfor %}', {}],
    ['nested tags', '{% optional "o" %}{% editor "e" %}{% endeditor %}{% endoptional %}', { fields: { o: 'true' } }],
    ['money filter', '{{ n | money }} {{ bad | money }}', { n: 1234.5, bad: 'x' }],
    ['json filter', '{{ v | json: 0 }}{{ v | json }}', { v: { a: [1, 2] } }],
    ['sort by key', '{{ list | sort: "n" | json: 0 }}', { list: [{ n: 'b' }, { n: 'a' }] }],
    ['sort_natural', '{{ list | sort_natural | json: 0 }}', { list: ['B', 'a'] }],
    ['where', '{{ list | where: "ok", true | json: 0 }}', { list: [{ ok: true }, { ok: false }] }],
    ['slice', '{{ s | slice: 0, 2 }}{{ s | slice: -2, 2 }}', { s: 'abcdef' }],
    ['markdownify', '{{ md | markdownify }}', { md: '- one\n- two' }],
    ['null-tolerant filters', '{{ z | sort | json: 0 }}{{ z | sort_natural | json: 0 }}{{ z | slice: 1 }}{{ z | where: "x" | json: 0 }}{{ z | markdownify }}', {}],
    ['filters inside a loop', '{% for x in list %}{{ x.v | slice: 0, 1 }}{% endfor %}', { list: [{ v: 'ab' }, {}] }],
    ['filter in a tag argument', '{% assign a = s | slice: 0, 2 %}{{ a }}', { s: 'abcd' }]
];

for (const [name, template, data] of cases) {
    test(`renders the same as a stock engine: ${name}`, async () => {
        const patched = await extension.liquidEngine.parseAndRender(template, data);
        const expected = await stock.parseAndRender(template, data);
        assert.strictEqual(patched, expected);
    });
}

test('a break still yields the output rendered before it', async () => {
    const out = await extension.liquidEngine.parseAndRender(
        '{% for i in (1..5) %}[{{ i }}]{% if i == 3 %}{% break %}{% endif %}{% endfor %}', {});
    assert.strictEqual(out, '[1][2][3]');
});

test('a continue skips only its own iteration', async () => {
    const out = await extension.liquidEngine.parseAndRender(
        '{% for i in (1..4) %}{% if i == 2 %}{% continue %}{% endif %}[{{ i }}]{% endfor %}', {});
    assert.strictEqual(out, '[1][3][4]');
});

test('a render error still reports the token it failed on', async () => {
    extension.liquidEngine.registerFilter('rlp_test_boom', () => { throw new Error('kaboom'); });
    const template = extension.liquidEngine.parse('a\nb\n{{ 1 | rlp_test_boom }}');
    await assert.rejects(
        () => extension.liquidEngine.render(template, {}),
        err => {
            assert.strictEqual(err.name, 'RenderError');
            assert.strictEqual(err.token.line, 3);
            assert.strictEqual(err.token.col, 1);
            return true;
        });
});
