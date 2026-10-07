// Writing templates: completions inside Liquid (tags, filters, the fields of
// the data a template is used with), what typing `{%`, `{{`, `%}` and `>`
// inserts, Format Document in VS Code, and the grammar that colours it all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { stub, harnessReset } = require('./harness');
const editing = require('../editing');
const authoring = require('../authoring');

const { Position } = stub.vscode;

// ---- completions: the logic -----------------------------------------------------------

// What's offered at the `|` in `marked`, as labels.
function offered(marked, datasets = []) {
    const offset = marked.indexOf('‸');
    const items = editing.completionsAt(marked.replace('‸', ''), offset, datasets);
    return items && items.map(i => i.label);
}
function item(marked, label, datasets = []) {
    const offset = marked.indexOf('‸');
    return editing.completionsAt(marked.replace('‸', ''), offset, datasets).find(i => i.label === label);
}

const DATA = [{ customer: { name: 'Ada', address: { town: 'Leeds' } }, items: [{ description: 'Engine', price: 3 }], plans: [] }];

test('every filter and tag the engine has is offered, and described', () => {
    const { filters, tags } = editing.known();
    assert.ok(filters.includes('money') && filters.includes('where') && filters.includes('upcase'));
    assert.deepStrictEqual(filters.filter(f => !editing.FILTERS[f]), [], 'a filter with no description');
    assert.deepStrictEqual(tags.filter(t => !editing.TAGS[t]), [], 'a tag with no snippet');
});

test('in a tag, its name: a block brings its end tag in the house style, replacing a %} already there', () => {
    assert.ok(offered('{%- ‸ %}').includes('if'));
    const ifTag = item('<p>{% i‸ %}', 'if');
    assert.strictEqual(ifTag.insert, 'if ${1:condition} %}$0{%- endif %}');
    assert.deepStrictEqual(ifTag.replace, [6, 10], 'the typed "i" and the " %}" after it');
    assert.deepStrictEqual(item('<p>{%- i\u2038}', 'if').replace, [7, 9], 'or the } the editor paired with {');
    assert.strictEqual(item('{%- ‸', 'optional').insert, 'optional "${1:name}" %}\n\t$0\n{%- endoptional %}');
    assert.strictEqual(item('{%- ‸', 'optional').detail, 'Reporter tag');
    assert.strictEqual(item('{%- ‸', 'assign').insert, 'assign ${1:name} = ${2:value} %}');
});

test('after a |, the filters, with what they take and do', () => {
    const money = item('{{ total | mo‸ }}', 'money');
    assert.strictEqual(money.insert, 'money');
    assert.match(money.documentation, /two decimals/);
    assert.strictEqual(item('{{ x | ‸ }}', 'replace').insert, 'replace: ${1:"old"}, ${2:"new"}');
});

test('the data’s fields, by name and path, with an example value', () => {
    assert.deepStrictEqual(offered('{{ ‸ }}', DATA).slice(0, 3), ['customer', 'items', 'plans']);
    assert.deepStrictEqual(offered('{{ customer.‸ }}', DATA), ['name', 'address']);
    assert.strictEqual(item('{{ customer.‸ }}', 'name', DATA).detail, 'e.g. "Ada"');
    assert.deepStrictEqual(offered('{{ customer.address.t‸ }}', DATA), ['town']);
    assert.deepStrictEqual(offered('{%- if customer.‸ %}', DATA), ['name', 'address']);
    assert.deepStrictEqual(offered('{{ items.‸ }}', DATA), ['size', 'first', 'last']);
    assert.deepStrictEqual(offered('{{ items.first.‸ }}', DATA), ['description', 'price']);
});

test('a loop’s item has the fields of its list’s items, and forloop its position', () => {
    const loop = '{%- for item in items %}{{ item.‸ }}{%- endfor %}';
    assert.deepStrictEqual(offered(loop, DATA), ['description', 'price']);
    assert.ok(offered('{%- for item in items %}{{ ‸ }}', DATA).includes('forloop'));
    assert.ok(offered('{%- for item in items %}{{ forloop.‸ }}', DATA).includes('index'));
    assert.ok(!offered('{%- for item in items %}{%- endfor %}{{ ‸ }}', DATA).includes('item'), 'not after the loop');
    assert.deepStrictEqual(offered('{%- assign who = customer %}{{ who.‸ }}', DATA), ['name', 'address']);
});

test('fields: the names Reporter’s tags give them in this template', () => {
    const text = '{%- editor "reference" %}{% endeditor %}{%- optional "includeNotes" %}{% endoptional %}{%- if fields.‸ %}';
    assert.deepStrictEqual(offered(text), ['reference', 'includeNotes']);
    assert.strictEqual(item(text, 'includeNotes').detail, '{% optional %} field');
});

test('Reporter tags’ options', () => {
    assert.deepStrictEqual(offered('{%- editor "ref", ‸ %}'), ['placeholder', 'lines', 'maxlength', 'minlength']);
    assert.deepStrictEqual(offered('{%- choice "d", ‸ %}'), ['title']);
});

test('nothing is offered as Liquid in HTML, or in a comment', () => {
    assert.strictEqual(offered('<p>‸</p>'), null);
    assert.strictEqual(offered('{{ a }} <p>‸'), null);
    assert.deepStrictEqual(offered('{% comment %} {{ ‸ {% endcomment %}'), [], 'a stray {{ in a comment is not Liquid either');
});

test('end tags: the end of the block the cursor is in comes first, then what goes inside it', () => {
    const first = (text, n) => offered(text).slice(0, n);
    // In an if that nothing closes yet.
    assert.deepStrictEqual(first('{%- if a %}\n  <p>x</p>\n{%- ‸ %}', 4), ['endif', 'else', 'elsif', 'assign']);
    assert.deepStrictEqual(first('{%- if a %}\n  <p>x</p>\n{%- end‸ %}', 3), ['endif', 'else', 'elsif'], 'typing end changes nothing; the editor narrows the list');
    // In an if that something below already closes: what goes inside it first, its end tag after.
    assert.deepStrictEqual(first('{%- if a %}\n{%- ‸ %}\n{%- endif %}', 4), ['else', 'elsif', 'endif', 'assign']);
    // The tag being typed has no `%}` yet, and doesn't swallow the one below.
    assert.deepStrictEqual(first('{%- if a %}\n{%- ‸\n{%- endif %}', 3), ['else', 'elsif', 'endif']);
    // Nested: the innermost first, break and continue in a loop, the outer end after.
    assert.deepStrictEqual(first('{%- if a %}{%- for x in y %}\n{%- ‸ %}', 5), ['endfor', 'else', 'break', 'continue', 'endif']);
    assert.deepStrictEqual(first('{%- for x in y %}{%- if a %}\n{%- ‸ %}\n{%- endif %}{%- endfor %}', 6), ['else', 'elsif', 'break', 'continue', 'endif', 'endfor']);
    // A block that has been closed is not offered again.
    assert.deepStrictEqual(first('{%- if a %}{%- for x in y %}{%- endfor %}\n{%- ‸ %}', 3), ['endif', 'else', 'elsif']);
    assert.deepStrictEqual(first('{%- case x %}\n{%- when 1 %}\n{%- ‸ %}', 3), ['endcase', 'when', 'else']);
    assert.deepStrictEqual(first('{%- choice "d" %}\n  A\n{%- ‸ %}', 2), ['endchoice', 'or']);
    assert.deepStrictEqual(first('{%- unless a %}\n{%- ‸ %}', 2), ['endunless', 'else']);
});

test('end tags: nothing to end means no end tags, and else and the like come last', () => {
    const labels = offered('<p>x</p>\n{%- ‸ %}');
    assert.deepStrictEqual(labels.filter(l => l.startsWith('end')), []);
    assert.deepStrictEqual(labels.slice(-6), ['break', 'continue', 'elsif', 'else', 'when', 'or']);
    const closed = offered('{%- if a %}{%- endif %}\n{%- ‸ %}');
    assert.deepStrictEqual(closed.filter(l => l.startsWith('end')), [], 'an if that is closed, with the cursor after it');
});

test('end tags: a comment or raw block can only be ended', () => {
    assert.deepStrictEqual(offered('{%- comment %}\n  notes\n{%- ‸ %}'), ['endcomment']);
    assert.deepStrictEqual(offered('{%- raw %}{{ x }}\n{%- ‸ %}'), ['endraw']);
    assert.deepStrictEqual(offered('{%- comment %}\n  notes\n{%- ‸'), ['endcomment'], 'with no %} yet');
    assert.deepStrictEqual(offered('{%- comment %} {{ ‸ {%- endcomment %}'), []);
    assert.ok(offered('{%- comment %}notes{%- endcomment %}\n{%- ‸ %}').includes('if'), 'after it, tags again');
});

test('end tags say what they end, and take the end of the tag with them', () => {
    const endif = item('{%- if a %}\n{%- end‸ %}', 'endif');
    assert.strictEqual(endif.insert, 'endif %}');
    assert.strictEqual(endif.detail, 'Ends {% if a %} from line 1');
    assert.match(endif.documentation, /Closes the if block that \{% if a %\} opens, on line 1/);
    assert.deepStrictEqual(endif.replace, [16, 22], 'the typed "end" and the " %}" after it');
    assert.deepStrictEqual(item('{%- if a %}\n{%- end‸}', 'endif').replace, [16, 20], 'or the } the editor paired with {');
    const reporter = item('{%- optional "notes" %}\n  hi\n{%- ‸ %}', 'endoptional');
    assert.strictEqual(reporter.kind, 'reporter');
    assert.strictEqual(reporter.detail, 'Ends {% optional "notes" %} from line 1');
});

// ---- typing -------------------------------------------------------------------------------

// Type `keys` one at a time into `start` + `rest` (the cursor between them), as
// VS Code does with this extension, and give the document with ‸ at the
// cursor.
//
// VS Code pairs at once, on each keystroke, as the language configuration says:
// `{` with `}`, `{%` with ` %}`, `{{` with ` }}`, a quote with a quote (typed
// over if its pair comes next). It does not type over a pair's several
// characters: `%}` typed before a pair's ` %}` leaves both. That, and a block
// tag's end tag, are the extension's, done once typing has settled and from
// the line as it is then. `pace` is when it settles: after every key, as slow
// typing gives it time to, or only after the last, as fast typing doesn't.
// \t goes to a snippet's final tab stop.
function typeKeys(keys, { start = '', rest = '', pace = 'slow' } = {}) {
    let doc = start + rest;
    let cursor = start.length;
    let finalStop = null; // The snippet's $0, as a distance from the document's end.
    let intents = new Set();
    const lineAround = () => {
        const from = doc.lastIndexOf('\n', cursor - 1) + 1;
        const end = doc.indexOf('\n', cursor);
        return { from, before: doc.slice(from, cursor), after: doc.slice(cursor, end < 0 ? doc.length : end) };
    };
    const put = (text, replace = 0) => { doc = doc.slice(0, cursor) + text + doc.slice(cursor + replace); };

    const settle = () => {
        if (!intents.size) return;
        const { before, after } = lineAround();
        const edit = editing.settleEdit(before, after, doc, [...intents]);
        if (edit && edit.wait) return; // Not ready: look again after more typing.
        intents = new Set();
        if (!edit) return;
        if (!edit.snippet) { put('', edit.replace); return; }
        // A snippet goes in as VS Code puts it in: each later line takes the
        // cursor line's indentation, and a leading tab becomes two spaces.
        const indent = /^\s*/.exec(before)[0];
        const text = edit.snippet.split('\n').map((l, n) => n ? indent + l.replace(/^\t/, '  ') : l).join('\n');
        const inserted = doc.slice(0, cursor) + text + doc.slice(cursor + edit.replace);
        const first = inserted.indexOf(text.includes('$1') ? '$1' : '$0');
        const plain = inserted.replace(/\$[01]/g, '');
        finalStop = text.includes('$1') ? plain.length - inserted.replace(/\$1/, '').indexOf('$0') : null;
        doc = plain;
        cursor = first;
    };

    for (const key of keys) {
        if (key === '\t') {
            if (finalStop !== null) cursor = doc.length - finalStop;
            finalStop = null;
            continue;
        }
        const { before, after } = lineAround();
        const closable = /^(\s*$|[\s}\])>`<;:.,=])/.test(after);
        if (key === '{' && /\{$/.test(before) && after.startsWith('}')) { put('{ }}', 1); cursor += 1; }
        else if (key === '{' && closable) { put('{}'); cursor += 1; }
        else if (key === '%' && /\{$/.test(before) && after.startsWith('}')) { put('% %}', 1); cursor += 1; }
        else if (key === '"' && after.startsWith('"')) cursor += 1;
        else if (key === '"' && /(^|[\s=(])$/.test(before) && closable) { put('""'); cursor += 1; }
        else { put(key); cursor += 1; }
        for (const intent of editing.intentsOf(lineAround().before, key)) intents.add(intent);
        if (pace === 'slow') settle();
    }
    settle();
    return doc.slice(0, cursor) + '‸' + doc.slice(cursor);
}

// Slow and fast must come to the same document.
function typed(keys, options = {}) {
    const slow = typeKeys(keys, Object.assign({}, options, { pace: 'slow' }));
    const fast = typeKeys(keys, Object.assign({}, options, { pace: 'fast' }));
    // The text must agree. The cursor may not: typed through quickly, a block tag's end
    // tag arrives as the cursor passes its %}, which puts the cursor in the body.
    assert.strictEqual(fast.replace('\u2038', ''), slow.replace('\u2038', ''), `typing ${JSON.stringify(keys)} fast, not as slowly, gives something else`);
    return slow;
}

test('a tag opens as VS Code pairs it, and typed through gives what was typed, however fast', () => {
    assert.strictEqual(typed('{%- else'), '{%- else‸ %}');
    assert.strictEqual(typed('{%- else %}'), '{%- else %}‸');
    assert.strictEqual(typed('{{ name'), '{{ name‸ }}');
    assert.strictEqual(typed('{{ name }}'), '{{ name }}‸');
    assert.strictEqual(typed('{% assign a = 1 %}'), '{% assign a = 1 %}‸');
    assert.strictEqual(typed('{%- assign a = 1 -%}'), '{%- assign a = 1 -%}‸', 'a dash before the %}');
    assert.strictEqual(typed('{%- assign a = 1%}'), '{%- assign a = 1%}‸', 'no space before it');
    for (const tag of ['endif', 'elsif a', 'endfor', 'endchoice', 'or', 'when 1', 'break']) {
        assert.strictEqual(typed(`{%- ${tag}`), `{%- ${tag}‸ %}`, tag);
        assert.strictEqual(typed(`{%- ${tag} %}`), `{%- ${tag} %}‸`, `${tag}, closed by hand`);
    }
    assert.strictEqual(typed('<p>{%- else', { rest: '</p>' }), '<p>{%- else‸ %}</p>', 'before a tag');
    assert.strictEqual(typed('{%- a %} {%- b %}'), '{%- a %} {%- b %}‸', 'one after another');
    assert.strictEqual(typed('{%- endif', { start: '  <p>x</p>\n' }), '  <p>x</p>\n{%- endif‸ %}', 'on a line of its own');
});

test('starting a block tag adds its end tag, however fast, and Tab goes between them', () => {
    assert.strictEqual(typed('{%- if a'), '{%- if a‸ %}{%- endif %}');
    assert.strictEqual(typed('{%- for item in items'), '{%- for item in items‸ %}{%- endfor %}');
    assert.strictEqual(typed('{% unless b'), '{% unless b‸ %}{% endunless %}', 'with the dash it opens with');
    assert.strictEqual(typed('{%- capture x -%}'), '{%- capture x -%}‸{%- endcapture %}');
    assert.strictEqual(typeKeys('{%- if a\tX'), '{%- if a %}X‸{%- endif %}');
    // Typed through, with the %} by hand: one %}, one end tag, the cursor past the tag.
    assert.strictEqual(typed('{%- if a %}'), '{%- if a %}‸{%- endif %}');
    assert.strictEqual(typed('{%- for i in items %}'), '{%- for i in items %}‸{%- endfor %}');
});

test('Reporter’s tags go in over several lines, as a formatted template has them', () => {
    assert.strictEqual(typed('{%- optional "x"'), '{%- optional "x"‸ %}\n  \n{%- endoptional %}');
    assert.strictEqual(typed('{%- optional "x" %}'), '{%- optional "x" %}‸\n  \n{%- endoptional %}');
    assert.strictEqual(typed('{%- choice "d"'), '{%- choice "d"‸ %}\n  \n{%- endchoice %}');
    assert.strictEqual(typed('{%- editor "r"'), '{%- editor "r"‸ %}\n  \n{%- endeditor %}');
    assert.strictEqual(typed('{% optional "x"'), '{% optional "x"‸ %}\n  \n{% endoptional %}', 'with the dash it opens with');
    // Tab goes to the line between them.
    assert.strictEqual(typeKeys('{%- optional "x"\tHello'), '{%- optional "x" %}\n  Hello‸\n{%- endoptional %}');
    assert.strictEqual(typeKeys('{%- choice "d"\tFirst'), '{%- choice "d" %}\n  First‸\n{%- endchoice %}');
    // Inside something else, each line takes the one the tag is on.
    assert.strictEqual(typed('{%- optional "x"', { start: '    ' }), '    {%- optional "x"‸ %}\n      \n    {%- endoptional %}');
});

test('the completion list gives Reporter’s tags in the same layout', () => {
    assert.strictEqual(item('{%- ‸', 'optional').insert, 'optional "${1:name}" %}\n\t$0\n{%- endoptional %}');
    assert.strictEqual(item('{%- ‸', 'editor').insert, 'editor "${1:name}"${2:, placeholder: "${3}"} %}\n\t$0\n{%- endeditor %}');
    assert.strictEqual(item('{%- ‸', 'choice').insert, 'choice "${1:name}", title: "${2:Title}" %}\n\t${3:First option}\n{%- or %}\n\t${4:Second option}\n{%- endchoice %}');
    assert.strictEqual(item('{%- ‸', 'or').insert, 'or %}\n\t$0');
    assert.strictEqual(item('{%- ‸', 'if').insert, 'if ${1:condition} %}$0{%- endif %}', 'Liquid’s own tags stay on one line');
});

test('a closed block, or a tag with something after it, gets no end tag', () => {
    assert.strictEqual(typed('{%- if a', { rest: '\n{%- endif %}' }), '{%- if a‸ %}\n{%- endif %}', 'closed below');
    assert.strictEqual(typed('{%- if a %}', { rest: '\n{%- endif %}' }), '{%- if a %}‸\n{%- endif %}', 'typed through, closed below: just the duplicate goes');
    assert.strictEqual(typed('{%- if b', { rest: '\n{%- if a %}{%- endif %}' }), '{%- if b‸ %}\n{%- if a %}{%- endif %}'.replace('%}\n', '%}{%- endif %}\n'), 'a block closed elsewhere does not close this one');
    assert.strictEqual(typed('{%- if a', { rest: '<p>x</p>' }), '{%- if a‸ %}<p>x</p>', 'something after: the editor’s pair is left alone');
});

test('what settling does, from the line as it is', () => {
    const doc = text => text;
    // A tag typed closed by hand: the pair’s own closer goes.
    assert.deepStrictEqual(editing.settleEdit('{%- else %}', ' %}', doc('{%- else %} %}'), ['closer']), { replace: 3, snippet: '' });
    assert.deepStrictEqual(editing.settleEdit('{{ a }}', ' }}', doc('{{ a }} }}'), ['closer']), { replace: 3, snippet: '' });
    assert.strictEqual(editing.settleEdit('{%- a %}', '{%- b %}', doc('{%- a %}{%- b %}'), ['closer']), null, 'another tag next is not a duplicate');
    // A block’s header, or just past its %}.
    assert.deepStrictEqual(editing.settleEdit('{%- if a', ' %}', doc('{%- if a %}'), ['block']), { replace: 3, snippet: '$1 %}$0{%- endif %}' });
    assert.deepStrictEqual(editing.settleEdit('{%- if a -%}', '', doc('{%- if a -%}'), ['block']), { replace: 0, snippet: '$0{%- endif %}' });
    assert.deepStrictEqual(editing.settleEdit('{%- if a %}', ' %}', doc('{%- if a %} %}'), ['block', 'closer']), { replace: 3, snippet: '$0{%- endif %}' }, 'the duplicate goes, and the end tag is added');
    // Not ready: the editor has paired a quote not yet typed over.
    assert.deepStrictEqual(editing.settleEdit('{%- optional "', '" %}', doc('{%- optional "" %}'), ['block']), { wait: true });
    // Nothing to do.
    assert.strictEqual(editing.settleEdit('{%- if a', ' %}', doc('{%- if a %}'), []), null, 'nothing asked');
    assert.strictEqual(editing.settleEdit('{%- if a', ' %}', doc('{%- if a %}{%- endif %}'), ['block']), null, 'already closed');
    assert.strictEqual(editing.settleEdit('<p>hi', '</p>', doc('<p>hi</p>'), ['block']), null, 'not a tag');
    // What a keystroke asks.
    assert.deepStrictEqual(editing.intentsOf('{%- if ', ' '), ['block']);
    assert.deepStrictEqual(editing.intentsOf('{%- if a %}', '}'), ['closer', 'block']);
    assert.deepStrictEqual(editing.intentsOf('{{ a }}', '}'), ['closer']);
    assert.deepStrictEqual(editing.intentsOf('{%- else ', ' '), []);
    assert.deepStrictEqual(editing.intentsOf('<p>', 'a'), []);
});

test('Liquid is blanked out for the HTML service, keeping every position', () => {
    const text = '<div class="{{ c }}">\n{%- if a\n %}<p>';
    const blank = editing.blankLiquid(text);
    assert.strictEqual(blank.length, text.length);
    assert.strictEqual(blank, '<div class="       ">\n        \n   <p>');
});

// ---- in VS Code ---------------------------------------------------------------------------

function documentOf(text, fileName = '/w/report.liquid') {
    const lines = text.split('\n');
    return {
        fileName,
        languageId: 'liquid',
        uri: stub.vscode.Uri.file(fileName),
        getText: () => text,
        lineAt: n => ({ text: lines[n] }),
        positionAt(offset) {
            const before = text.slice(0, offset).split('\n');
            return new Position(before.length - 1, before[before.length - 1].length);
        },
        offsetAt: p => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character
    };
}

function workspace() {
    stub.workspaceFiles.set('/w/report.liquid', '<h1>{{ customer.name }}</h1>');
    stub.workspaceFiles.set('/w/data/ada.json', JSON.stringify({ customer: { name: 'Ada' }, items: [{ price: 1 }] }));
    stub.workspaceFiles.set('/w/report.liquidtest.json', JSON.stringify({
        template: 'report.liquid',
        cases: [{ name: 'Ada', data: 'data/ada.json' }, { name: 'Inline', data: { customer: { title: 'Dr' } } }, { name: 'Other', template: 'other.liquid', data: { secret: 1 } }]
    }));
}

test.beforeEach(() => { harnessReset(); workspace(); });

test('a template is used with its tests’ data and its previews’ data files', async () => {
    const sets = await authoring.datasetsFor('/w/report.liquid');
    assert.deepStrictEqual(sets.map(s => s.label), ['ada.json', 'the test “Inline”']);
});

test('completions in VS Code come with the data’s fields, and HTML outside Liquid', async () => {
    const [provider] = stub.providers.completion;
    const doc = documentOf('<h1>{{ customer. }}</h1>\n<di');
    const fields = await provider.provideCompletionItems(doc, new Position(0, 16));
    assert.deepStrictEqual(fields.map(i => i.label), ['name', 'title']);
    assert.ok(fields[0].insertText instanceof stub.vscode.SnippetString);
    const html = await provider.provideCompletionItems(doc, new Position(1, 3));
    assert.ok(html.some(i => i.label === 'div'), 'HTML tags');
});

test('Format Document lays the template out, and says what it checked', async () => {
    const [provider] = stub.providers.formatting;
    const source = '<table>{% for i in items %}<tr><td>{{ i.price }}</td></tr>{% endfor %}</table>';
    const [edit] = await provider.provideDocumentFormattingEdits(documentOf(source), { tabSize: 2, insertSpaces: true });
    assert.match(edit.newText, /\{%- for i in items %\}\n\s+<tr>/);
    assert.match(stub.statusMessages[0], /checked the page is unchanged against 3 sets of data/);
});

test('Format Document leaves a template it can’t check, and says why', async () => {
    const [provider] = stub.providers.formatting;
    const edits = await provider.provideDocumentFormattingEdits(documentOf('<p>{% if a %}x</p>'), { tabSize: 2, insertSpaces: true });
    assert.deepStrictEqual(edits, []);
    assert.match(stub.shownMessages[0], /couldn’t be read for formatting|doesn’t render/);
});

// A document whose text can change under a pending keystroke, as another
// extension's edit would, and an editor on it that records what it's asked to do.
function editableDocument(text) {
    const doc = documentOf(text);
    doc.setText = next => {
        doc.getText = () => next;
        doc.lineAt = n => ({ text: next.split('\n')[n] });
    };
    doc.setText(text);
    return doc;
}

const at = w => w.start ? `${w.start.line}:${w.start.character}-${w.end.line}:${w.end.character}` : `${w.line}:${w.character}`;

function fakeEditor(doc, line, col, answers = []) {
    const editor = {
        document: doc,
        selections: [{}],
        selection: { active: new Position(line, col), isEmpty: true },
        calls: [],
        insertSnippet: async (snippet, where) => { editor.calls.push(['snippet', snippet.value, at(where)]); return answers.length ? answers.shift() : true; },
        edit: async build => { build({ delete: range => editor.calls.push(['delete', at(range)]) }); return answers.length ? answers.shift() : true; }
    };
    stub.vscode.window.activeTextEditor = editor;
    return editor;
}
const typedChar = (doc, char, line, col) => ({ document: doc, contentChanges: [{ text: char, range: { start: new Position(line, col) } }] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test.afterEach(() => { stub.vscode.window.activeTextEditor = undefined; });

test('a block tag’s end tag is added once typing settles, to the line as it is then', async () => {
    // The space after "for" is what asked, and the typist is well past it.
    const doc = editableDocument('{%- for i in items %}');
    const editor = fakeEditor(doc, 0, 18);
    await authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    assert.deepStrictEqual(editor.calls, [['snippet', '$1 %}$0{%- endfor %}', '0:18-0:21']]);
});

test('keys still arriving put the wait off, and it is done once', async () => {
    const doc = editableDocument('{%- for i in items %}');
    const editor = fakeEditor(doc, 0, 18);
    const asking = [authoring.closeAsYouType(typedChar(doc, ' ', 0, 7))];
    for (const [char, col] of [['i', 8], [' ', 9], ['i', 10]]) {
        await sleep(10);
        asking.push(authoring.closeAsYouType(typedChar(doc, char, 0, col)));
    }
    await Promise.all(asking);
    assert.strictEqual(editor.calls.length, 1);
});

test('a tag typed closed by hand loses the pair’s duplicate', async () => {
    const doc = editableDocument('{%- else %} %}');
    const editor = fakeEditor(doc, 0, 11);
    await authoring.closeAsYouType(typedChar(doc, '}', 0, 10));
    assert.deepStrictEqual(editor.calls, [['delete', '0:11-0:14']]);
});

test('nothing is done where the cursor has gone elsewhere, or the line is not as it was', async () => {
    let doc = editableDocument('{%- for i in items %}\n');
    let editor = fakeEditor(doc, 1, 0);
    await authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    assert.deepStrictEqual(editor.calls, [], 'the cursor is on another line');

    doc = editableDocument('{%- for i in items %}');
    editor = fakeEditor(doc, 0, 20);
    const asking = authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    doc.setText('{%- while i in items %}'); // Before typing settles.
    await asking;
    assert.deepStrictEqual(editor.calls, [], 'the line says something else now');

    doc = editableDocument('{%- for i in items %}');
    editor = fakeEditor(doc, 0, 18);
    editor.selection.isEmpty = false;
    await authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    assert.deepStrictEqual(editor.calls, [], 'something is selected');
});

test('an edit the editor turns down is tried again against the line as it is', async () => {
    const doc = editableDocument('{%- for i in items %}');
    const editor = fakeEditor(doc, 0, 18, [false, true]);
    await authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    assert.strictEqual(editor.calls.length, 2);
    assert.deepStrictEqual(editor.calls[1], editor.calls[0]);
});

test('edits turned down while keys keep coming don’t use up the tries', async t => {
    // Fast typing: each attempt lands as another key changes the line, and is turned down.
    // Only attempts with no key in between count towards giving up.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const doc = editableDocument('{%- for i in items %}');
    const editor = fakeEditor(doc, 0, 18, [false, false, false, false, false, false, true]);
    authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(authoring.SETTLE_MS); await flush(); }
    authoring.closeAsYouType(typedChar(doc, 'i', 0, 8)); // A key arrives: the count starts again.
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(authoring.SETTLE_MS); await flush(); }
    assert.strictEqual(editor.calls.length, 7, 'still trying, and done on the seventh');
});

test('a line that isn’t ready is waited for, and done when typing goes on', async () => {
    // The editor has paired the quote, and the cursor is between the pair.
    const doc = editableDocument('{%- optional "" %}');
    const editor = fakeEditor(doc, 0, 14);
    await authoring.closeAsYouType(typedChar(doc, ' ', 0, 12));
    assert.deepStrictEqual(editor.calls, [], 'not ready');
    // The name goes in and the quote is typed over.
    doc.setText('{%- optional "x" %}');
    editor.selection.active = new Position(0, 16);
    await authoring.closeAsYouType(typedChar(doc, '"', 0, 15));
    assert.deepStrictEqual(editor.calls, [['snippet', '$1 %}\n\t$0\n{%- endoptional %}', '0:16-0:19']]);
});

test('an element’s closing tag goes where the cursor is, after text but not after more tags', async () => {
    let doc = editableDocument('<section class="{{ c }}">');
    let editor = fakeEditor(doc, 0, 25);
    await authoring.closeAsYouType(typedChar(doc, '>', 0, 24));
    assert.deepStrictEqual(editor.calls, [['snippet', '$0</section>', '0:25']]);

    doc = editableDocument('<p>hello');
    editor = fakeEditor(doc, 0, 8);
    await authoring.closeAsYouType(typedChar(doc, '>', 0, 2));
    assert.deepStrictEqual(editor.calls, [['snippet', '$0</p>', '0:8']], 'after text');

    doc = editableDocument('<div><p');
    editor = fakeEditor(doc, 0, 7);
    await authoring.closeAsYouType(typedChar(doc, '>', 0, 4));
    assert.deepStrictEqual(editor.calls, [], 'after another tag it would be wrong');

    doc = editableDocument('<br>');
    editor = fakeEditor(doc, 0, 4);
    await authoring.closeAsYouType(typedChar(doc, '>', 0, 3));
    assert.deepStrictEqual(editor.calls, [], '<br> has no end tag');
});

test('nothing is done with auto-closing off, or in another language', async () => {
    stub.settings.set('reporterLiquidPreview.autoClose', false);
    let doc = editableDocument('{%- for i in items %}');
    let editor = fakeEditor(doc, 0, 18);
    await authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    assert.deepStrictEqual(editor.calls, []);

    stub.settings.delete('reporterLiquidPreview.autoClose');
    doc = Object.assign(editableDocument('{%- for i in items %}'), { languageId: 'html' });
    editor = fakeEditor(doc, 0, 18);
    await authoring.closeAsYouType(typedChar(doc, ' ', 0, 7));
    assert.deepStrictEqual(editor.calls, []);
});

// ---- the grammar ---------------------------------------------------------------------------

test('the grammar colours Liquid between tags, in attributes, and not in comments', async () => {
    const textmate = require('vscode-textmate');
    const oniguruma = require('vscode-oniguruma');
    await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
    const grammars = {
        'text.html.liquid': JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'liquid.tmLanguage.json'), 'utf8')),
        // A stand-in for VS Code's own HTML grammar: tags with quoted attributes.
        'text.html.basic': { scopeName: 'text.html.basic', patterns: [{ name: 'meta.tag.html', begin: '<[a-z]+', end: '>', patterns: [{ name: 'string.quoted.double.html', begin: '"', end: '"' }] }] }
    };
    const registry = new textmate.Registry({
        onigLib: Promise.resolve({ createOnigScanner: s => new oniguruma.OnigScanner(s), createOnigString: s => new oniguruma.OnigString(s) }),
        loadGrammar: async scope => grammars[scope] ? textmate.parseRawGrammar(JSON.stringify(grammars[scope]), 'g.json') : null
    });
    const grammar = await registry.loadGrammar('text.html.liquid');
    const scopesOf = (line, word) => {
        const { tokens } = grammar.tokenizeLine(line, textmate.INITIAL);
        const at = line.indexOf(word);
        return tokens.find(t => t.startIndex <= at && at < t.endIndex).scopes;
    };
    assert.ok(scopesOf('{%- if a == "x" %}', 'if').includes('keyword.control.liquid'));
    assert.ok(scopesOf('{%- if a == "x" %}', '"x"').includes('string.quoted.double.liquid'));
    assert.ok(scopesOf('{{ total | money }}', 'money').includes('support.function.filter.liquid'));
    assert.ok(scopesOf('{%- optional "notes" %}', 'optional').includes('entity.name.tag.reporter.liquid'));
    assert.ok(scopesOf('{%- editor "r", placeholder: "x" %}', 'placeholder').includes('variable.parameter.liquid'));
    const inAttribute = scopesOf('<div class="{{ kind }}">', 'kind');
    assert.ok(inAttribute.includes('string.quoted.double.html') && inAttribute.includes('variable.other.liquid'), inAttribute.join(' '));
    assert.ok(!scopesOf('{% comment %}{{ x }}{% endcomment %}', 'x').includes('variable.other.liquid'));
});
