// The template spec (spec.js): the template written out for document owners,
// with every part that can vary marked once, in place, with a reference.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const spec = require('../spec');
const { stub, extension, harnessReset } = require('./harness');

test.beforeEach(() => harnessReset());

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'spec-letter.liquid'), 'utf8');

function build(text, options) {
    return spec.buildSpec(text, Object.assign({ producedOn: new Date('2026-10-27T12:00:00Z') }, options));
}

// The document part of a spec, as a browser would read it.
function documentOf(text) {
    const built = build(text);
    const dom = new JSDOM(`<body>${built.body}</body>`);
    return { built, doc: dom.window.document.getElementById('sp-document'), window: dom.window };
}

function refs(built) {
    return built.items.map(item => `${item.id}: ${item.parts.map(p => p.id).join(' ')}`);
}

test('every part that can vary gets a reference, numbered in order by kind', () => {
    const built = build([
        '{% if a %}A{% elsif b %}B{% else %}C{% endif %}',
        '{% unless d %}D{% endunless %}',
        '{% case e %}{% when 1 %}one{% when 2 %}two{% endcase %}',
        '{% for x in xs %}X{% else %}none{% endfor %}',
        '{% for y in ys %}Y{% endfor %}',
        '{% choice "c", title: "Pick" %}P{% or %}Q{% or %}R{% endchoice %}',
        '{% optional "o" %}O{% endoptional %}',
        '{% editor "e", placeholder: "Type" %}{% endeditor %}'
    ].join('\n'));
    assert.deepStrictEqual(refs(built), [
        'R1: R1.1 R1.2 R1.3',
        'R2: R2',
        'R3: R3.1 R3.2',
        'L1: L1.1 L1.2',
        'L2: L2',
        'C1: C1.1 C1.2 C1.3',
        'O1: O1',
        'E1: E1'
    ]);
});

test('conditions are written in words', () => {
    const words = expr => spec.describe(expr, name => `[${spec.humanizeName(name)}]`);
    assert.strictEqual(words("client.pensions.size > 0 and adviser.gender == 'F'"), 'the number of [client pensions] is more than 0 <b>and</b> [adviser gender] is “F”');
    assert.strictEqual(words('notes == blank or notes == nil'), '[notes] is empty <b>or</b> [notes] is missing');
    assert.strictEqual(words('hasDB'), '[has DB]');
    assert.strictEqual(words("tags contains 'vip'"), '[tags] contains “vip”');
    assert.strictEqual(words('age >= 55'), '[age] is at least 55');
});

test('alternatives inside a sentence are bracketed in it, and the sentence stays one paragraph', () => {
    const { doc } = documentOf('<p>Thank you for meeting {% if g == "F" %}her{% else %}him{% endif %} today.</p>');
    const paragraphs = doc.querySelectorAll('p');
    assert.strictEqual(paragraphs.length, 1, 'no block was put inside the paragraph, which would have split it');
    assert.strictEqual(paragraphs[0].textContent.replace(/\s+/g, ' '), 'Thank you for meeting [R1.1her / R1.2him] today.');
    assert.strictEqual(doc.querySelectorAll('div').length, 0);
});

test('a rule around whole paragraphs is marked in the margin, with what decides it', () => {
    const { doc } = documentOf('<h2>DB</h2>{% if hasDB %}<p>Specialist advice.</p>{% endif %}');
    const block = doc.querySelector('.sp-blk');
    assert.ok(block, 'a margin block');
    assert.strictEqual(block.querySelector('.sp-tag').textContent, 'R1Shown when has DB');
    assert.strictEqual(block.querySelector('.sp-body p').textContent, 'Specialist advice.');
});

test('rows that come and go stay in their table', () => {
    const { doc } = documentOf([
        '<table><tr><th>Provider</th></tr>',
        '{% for p in pensions %}<tr><td>{{ p.provider }}</td></tr>{% endfor %}',
        '{% if pensions.size > 1 %}<tr><td>Total</td></tr>{% endif %}',
        '</table><p>After</p>'
    ].join('\n'));
    const table = doc.querySelector('table');
    assert.ok(table.textContent.includes('Total'), 'the conditional row is still inside the table');
    assert.ok(table.textContent.includes('p provider'), 'and so is the repeated one');
    assert.ok(/R1\s*Shown when the number of pensions is more than 1/.test(table.textContent), 'labelled in a row of its own');
    assert.strictEqual(doc.querySelector('table').nextElementSibling.textContent, 'After', 'nothing was pushed out of the table');
    assert.strictEqual([...doc.children].filter(el => el.tagName === 'DIV').length, 0, 'no block hoisted out in front of the table');
});

test('cells that come and go are marked in the cell', () => {
    const { doc } = documentOf('<table><tr><td>Name</td>{% if showAge %}<td>Age</td>{% endif %}</tr></table>');
    const cells = doc.querySelectorAll('td');
    assert.strictEqual(cells.length, 2);
    assert.strictEqual(cells[1].textContent, 'R1Age');
});

test('logic that only works out values is left out of the document but listed', () => {
    const built = build('{% assign hasDB = false %}{% for p in ps %}{% if p.type == "DB" %}{% assign hasDB = true %}{% endif %}{% endfor %}{% if hasDB %}<p>DB</p>{% endif %}');
    const dom = new JSDOM(`<body>${built.body}</body>`).window.document;
    assert.deepStrictEqual([...dom.querySelectorAll('#sp-document .sp-tag')].map(t => t.textContent), ['R2Shown when has DBV1']);
    const checklist = dom.getElementById('sp-checklist').textContent;
    assert.ok(checklist.includes('Shows nothing; only works out values'));
    assert.match(build('{% if x %}{% assign y = 1 %}{% endif %}{% if y %}Y{% endif %}').body, /1 more rule or repeat only works out values and shows nothing itself/);
});

test('an "otherwise" whose first branch shows nothing says what it rules out', () => {
    const tags = text => [...new JSDOM(`<body>${build(text).body}</body>`).window.document.querySelectorAll('#sp-document .sp-tag')].map(t => t.textContent);
    assert.deepStrictEqual(tags('{% if paid %}{% else %}<p>Please pay.</p>{% endif %}'), ['R1.2Otherwise (not when paid)']);
    assert.deepStrictEqual(tags('{% if a %}{% elsif b %}<p>B</p>{% else %}<p>C</p>{% endif %}'), ['R1.2Otherwise, when b (and not when a)', 'R1.3Otherwise (not when a)']);
    assert.deepStrictEqual(tags('{% case r %}{% when "low" %}{% else %}<p>Not low</p>{% endcase %}'), ['R1.2Otherwise (not when r is \u201clow\u201d)']);
    assert.deepStrictEqual(tags('{% if a %}<p>A</p>{% else %}<p>B</p>{% endif %}'), ['R1.1Shown when a', 'R1.2Otherwise'], 'unchanged when nothing is left out');
});

test('a value the template works out is traced to every place it is set, and under what', () => {
    const built = build(FIXTURE);
    const byName = Object.fromEntries(built.values.map(v => [v.name, v]));
    assert.deepStrictEqual(Object.keys(byName), ['hasDB', 'totalValue', 'greeting']);

    const dom = new JSDOM(`<body>${built.body}</body>`).window.document;
    const hasDB = dom.getElementById(`sp-${byName.hasDB.id}`).textContent.replace(/\s+/g, ' ');
    assert.match(hasDB, /line 7 set to false when: always/);
    assert.match(hasDB, /line 10 set to true when: L1 repeats for each pension in client pensions › R2 shown when pension type is “DB”/);

    // A rule that reads it links to how it's worked out.
    const rule = [...dom.querySelectorAll('#sp-document .sp-tag')].find(t => t.textContent.includes('has DB'));
    assert.strictEqual(rule.querySelector('a.sp-vref').getAttribute('href'), `#sp-${byName.hasDB.id}`);
    // So does a value shown in the document.
    assert.ok(dom.querySelector(`#sp-document a.sp-vref[href="#sp-${byName.totalValue.id}"]`));
});

test('a value that only feeds one that decides something is traced too', () => {
    const built = build('{% assign base = client.age %}{% assign older = base | plus: 10 %}{% if older > 60 %}Old{% endif %}{% assign unused = 1 %}');
    assert.deepStrictEqual(built.values.map(v => v.name), ['base', 'older']);
});

test('a block left open says so, and is counted on the cover', () => {
    const built = build('<p>Intro</p>{% if x %}<p>Swallowed</p>');
    assert.strictEqual(built.stats.unclosed, 1);
    assert.match(built.body, /Not closed: no \{% endif %\} was found/);
    assert.match(built.body, /1 section is missing an end tag/);
});

test('an HTML comment hides its text, but Liquid in it still opens and closes blocks', () => {
    const built = build('<!-- old: {{ removed }} --><p>Kept</p>{% if a %}<!-- {% endif %} -->A');
    assert.ok(!built.body.includes('removed'));
    assert.ok(!built.body.includes('old:'));
    assert.strictEqual(built.stats.unclosed, 0, 'the endif inside the comment closed the if');
});

test('Liquid inside an element tag is dropped, and doesn’t upset the blocks around it', () => {
    const { built, doc } = documentOf('{% if a %}<p class="{% if b %}bold{% endif %}" data-x="{{ y }}">Text</p>{% endif %}');
    assert.deepStrictEqual(refs(built), ['R1: R1'], 'the if inside the attribute is not a part of the document');
    assert.strictEqual(doc.querySelector('p').getAttribute('class'), 'bold', 'the words between the tags stay');
    assert.strictEqual(doc.querySelector('p').getAttribute('data-x'), '');
});

test('a rule inside the styles is listed as styling, with nothing put into the CSS', () => {
    const built = build('<style>body { color: red; }{% if big %} body { font-size: 20px; }{% endif %}</style><p>Hi {{ name }}</p>');
    const style = built.body.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.strictEqual(style, 'body { color: red; } body { font-size: 20px; }');
    assert.match(built.body, /Changes how the page looks/);
    assert.strictEqual(built.stats.rules, 0, 'not counted as something the reader sees');
});

test('the cover has contents from the document’s headings, each linked', () => {
    const built = build(FIXTURE);
    assert.deepStrictEqual(built.headings.map(h => `${h.level} ${h.title}`), [
        '1 Your pension recommendation', '2 Your plans', '2 Your defined benefit pension', '2 Our recommendation', '3 Attitude to risk'
    ]);
    const dom = new JSDOM(`<body>${built.body}</body>`).window.document;
    for (const link of dom.querySelectorAll('.sp-toc a')) {
        assert.ok(dom.getElementById(link.getAttribute('href').slice(1)), `${link.textContent} goes somewhere`);
    }
});

test('every reference in the document is in the checklist, and links to it', () => {
    const built = build(FIXTURE);
    const dom = new JSDOM(`<body>${built.body}</body>`).window.document;
    const shown = [...dom.querySelectorAll('#sp-document a.sp-id')].map(a => a.getAttribute('href'));
    assert.ok(shown.length > 10);
    for (const href of shown) assert.ok(dom.getElementById(href.slice(1)), `${href} is in the checklist`);
    const listed = [...dom.querySelectorAll('#sp-checklist .sp-ck-id')].map(td => td.textContent);
    assert.deepStrictEqual(listed.slice(0, 4), ['R1', 'L1', 'R2', 'R3']);
});

test('the version stamp follows the template text', () => {
    assert.strictEqual(build('A').stamp, build('A').stamp);
    assert.notStrictEqual(build('A').stamp, build('B').stamp);
    assert.match(build('A').body, /Produced<\/th><td>27 October 2026/);
});

test('in VS Code a reference goes to its line', () => {
    const built = build('line 1\n{% if a %}\n<p>A</p>\n{% endif %}', { revealFile: '/w/t.liquid' });
    assert.match(built.body, /<span class="sp-id diag-goto"[^>]*data-diag-file="\/w\/t.liquid" data-diag-line="2"[^>]*>R1<\/span>/);
});

test('the export is a page of its own, ready to print', () => {
    const built = build(FIXTURE, { fileName: 'letter.liquid' });
    const page = spec.standaloneSpec(built, { fileName: 'letter.liquid', css: '.letter { color: navy; }' });
    assert.match(page, /^<!DOCTYPE html>/);
    assert.match(page, /<title>Spec: letter.liquid \([0-9a-f]{8}\)<\/title>/);
    assert.ok(page.includes('.letter { color: navy; }'), 'with the template’s styles');
    assert.match(page, /@media print/);
    assert.match(page, /window\.print\(\)/);
});

test('Export saves the page where asked and offers to open it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-spec-'));
    const template = path.join(dir, 'letter.liquid');
    fs.writeFileSync(template, FIXTURE);
    stub.workspaceFiles.set(template, FIXTURE);
    const target = path.join(dir, 'letter.spec.html');
    stub.saveDialogAnswers.push(stub.vscode.Uri.file(target));
    stub.infoAnswers.push('Open in browser');

    await extension.exportSpec(template);

    assert.match(fs.readFileSync(target, 'utf8'), /Template specification/);
    assert.match(stub.shownMessages[0], /Saved the spec for letter.liquid \(version [0-9a-f]{8}\) to letter.spec.html/);
    assert.deepStrictEqual(stub.openedLinks.map(link => path.basename(String(link))), ['letter.spec.html']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('Export does nothing when the save is cancelled', async () => {
    stub.workspaceFiles.set('/w/t.liquid', 'A');
    await extension.exportSpec('/w/t.liquid');
    assert.deepStrictEqual(stub.shownMessages, []);
    assert.deepStrictEqual(stub.shownErrors, []);
});

test('a template the size of the largest reports is quick', () => {
    // About 7,000 lines, nested as real reports are.
    const section = n => [
        `<h2>Section ${n}</h2>`,
        `{% if client.flag${n} %}`,
        `<p>Text for ${n} with {{ client.name }} and {% if x == ${n} %}this{% else %}that{% endif %}.</p>`,
        `{% for p in client.pensions %}{% if p.kind == ${n} %}{% assign seen${n} = true %}{% endif %}{% endfor %}`,
        `{% choice "c${n}" %}<p>One</p>{% or %}<p>Two</p>{% endchoice %}`,
        '{% endif %}'
    ].join('\n');
    const text = Array.from({ length: 1200 }, (_, n) => section(n)).join('\n');
    assert.ok(text.split('\n').length >= 7000);
    const started = Date.now();
    const built = build(text);
    const took = Date.now() - started;
    assert.strictEqual(built.items.length, 1200 * 5);
    assert.ok(took < 3000, `took ${took}ms`);
});

test('notes alone don\u2019t make a block shown: they go with it to the checklist', () => {
    const built = build('{% for p in ps %}{% comment %}Count the rows{% endcomment %}{% assign rows = rows | plus: 1 %}{% endfor %}<p>Text</p>');
    const dom = new JSDOM(`<body>${built.body}</body>`).window.document;
    assert.strictEqual(dom.querySelectorAll('#sp-document .sp-blk').length, 0, 'no rail around a block that only works out values');
    assert.strictEqual(dom.querySelectorAll('#sp-document .sp-note').length, 0);
    assert.strictEqual(dom.querySelector('#sp-checklist .sp-ck-note').textContent, 'Author note: Count the rows');
    assert.strictEqual(built.stats.notes, 0, 'and the toolbar doesn\u2019t offer to hide notes that aren\u2019t there');
});

test('notes in a row, with nothing shown between them, collapse into one line', () => {
    const built = build([
        '{% comment %}One{% endcomment %}',
        '{% if a %}{% assign x = 1 %}{% endif %}',
        '{% comment %}Two{% endcomment %}',
        '{% comment %}Three{% endcomment %}',
        '<p>Shown</p>',
        '{% comment %}Alone{% endcomment %}'
    ].join('\n'));
    const dom = new JSDOM(`<body>${built.body}</body>`).window.document;
    const groups = dom.querySelectorAll('#sp-document details.sp-notes');
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].open, false, 'closed until opened');
    assert.strictEqual(groups[0].querySelector('summary').textContent, '3 author notes');
    assert.deepStrictEqual([...groups[0].querySelectorAll('.sp-note')].map(n => n.textContent), ['Author note One', 'Author note Two', 'Author note Three']);
    assert.strictEqual(dom.querySelector('#sp-document > .sp-note').textContent, 'Author note Alone', 'a note on its own stays as it is');
    assert.strictEqual(built.stats.notes, 4);
});

test('a note between table rows goes into the row it labels, not out in front of the table', () => {
    const { doc } = documentOf([
        '<p>Before</p><table>',
        '<tr><th>Feature</th><th>Detail</th></tr>',
        '{% comment %}NAV:OWNER{% endcomment %}',
        '<tr><td>Owner</td><td>{{ owner }}</td></tr>',
        '{% comment %}NAV:TERM{% endcomment %}',
        '{% if term %}<tr><td>Term</td><td>{{ term }}</td></tr>{% endif %}',
        '<tr>{% comment %}NAV:CELL{% endcomment %}<td>Last</td></tr>',
        '{% comment %}NAV:END{% endcomment %}',
        '</table><p>After</p>'
    ].join('\n'));
    assert.strictEqual(doc.querySelector('table').previousElementSibling.textContent, 'Before', 'nothing pushed out in front of the table');
    const cellNotes = [...doc.querySelectorAll('td > .sp-note')].map(n => `${n.parentElement.textContent.replace(n.textContent, '').trim()}: ${n.textContent}`);
    assert.deepStrictEqual(cellNotes, ['Owner: Author note NAV:OWNER', 'Term: Author note NAV:TERM', 'Last: Author note NAV:CELL']);
    assert.strictEqual(doc.querySelector('table').nextElementSibling.textContent, 'Author note NAV:END', 'a note with no cell after it goes after the table');
});

test('a note in table logic that shows nothing goes to the checklist, not a later cell', () => {
    const built = build('<table>{% for p in ps %}{% comment %}Count{% endcomment %}{% assign n = n | plus: 1 %}{% endfor %}<tr><td>Row</td></tr></table>');
    const dom = new JSDOM(`<body>${built.body}</body>`).window.document;
    assert.strictEqual(dom.querySelector('#sp-document td').textContent, 'Row');
    assert.strictEqual(dom.querySelector('#sp-checklist .sp-ck-note').textContent, 'Author note: Count');
});

test('collapsing notes never takes in what is shown between them', () => {
    const { built, doc } = documentOf([
        '{% comment %}NAV:A{% endcomment %}',
        '{% optional "extra", title: "Extra section" %}<p>Optional text</p>{% endoptional %}',
        '<table><tr><td>Cell</td></tr></table>',
        '{% comment %}NAV:B{% endcomment %}',
        '<div><p>Para</p></div>',
        '{% comment %}NAV:C{% endcomment %}'
    ].join('\n'));
    assert.strictEqual(doc.querySelectorAll('details.sp-notes').length, 0, 'no two of these notes are next to each other');
    assert.ok(!doc.querySelector('details.sp-notes .sp-blk, details.sp-notes table, details.sp-notes p'));
    assert.strictEqual(doc.querySelectorAll('.sp-note').length, 3);
    assert.strictEqual(built.stats.optionals, 1);
});
