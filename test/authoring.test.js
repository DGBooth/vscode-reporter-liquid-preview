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
    assert.strictEqual(item('{%- ‸', 'optional').insert, 'optional "${1:name}" %}$0{%- endoptional %}');
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
    assert.strictEqual(offered('{% comment %} {{ ‸ {% endcomment %}'), null);
});

// ---- typing -------------------------------------------------------------------------------

test('typing the %} of a block tag adds its end tag, with the same dash', () => {
    assert.deepStrictEqual(editing.afterTyping('  {%- for i in items %}', '', '}'), { start: 23, end: 23, snippet: '$0{%- endfor %}' });
    assert.deepStrictEqual(editing.afterTyping('{% optional "x" %}', '  ', '}'), { start: 18, end: 18, snippet: '$0{% endoptional %}' });
    assert.strictEqual(editing.afterTyping('{%- assign a = 1 %}', '', '}'), null, 'not a block');
    assert.strictEqual(editing.afterTyping('{%- if a %}', '<p>x</p>', '}'), null, 'not with something after it');
    assert.strictEqual(editing.afterTyping('{%- if a %}', '', '}', '{%- if a %}\n<p>x</p>\n{%- endif %}'), null, 'not when the block is already closed');
    assert.ok(editing.afterTyping('{%- if b %}', '', '}', '{%- if a %}{%- endif %}\n{%- if b %}'), 'but when this one isn\u2019t');
    assert.strictEqual(editing.afterTyping('{%', '}', '%'), null, '{% is left to the editor\u2019s own brace pairing');
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

test('typing > closes the HTML element; typing %} closes the block', async () => {
    const snippets = [];
    const editorFor = (doc, cursor) => ({
        document: doc,
        selections: [{}],
        selection: { active: cursor },
        insertSnippet: async (snippet, where) => { snippets.push([snippet.value, String(where)]); return true; }
    });
    // `text` as it is after typing `typed`, its last character.
    const type = async (text, typed) => {
        const doc = documentOf(text);
        const line = 0;
        const character = text.length - 1;
        stub.vscode.window.activeTextEditor = editorFor(doc, new Position(line, character + 1));
        await authoring.closeAsYouType({ document: doc, contentChanges: [{ text: typed, range: { start: new Position(line, character) } }] });
    };
    await type('<section class="{{ c }}">', '>');
    await type('{%- for i in items %}', '}');
    await type('<br>', '>');
    stub.vscode.window.activeTextEditor = undefined;
    assert.deepStrictEqual(snippets.map(([snippet]) => snippet), ['$0</section>', '$0{%- endfor %}'], 'nothing after <br>, which has no end tag');
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
