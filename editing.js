// Help while editing a template: what to offer at the cursor inside Liquid
// (tags, filters, the fields of the data the template is used with), what to
// insert as you type a tag, and the template
// with its Liquid blanked out so an HTML service can read the HTML around it.
// Nothing here depends on VS Code; extension.js turns these into its types.

const { liquidTags } = require('./formatter');

// ---- what the engine knows ----------------------------------------------------------

// The filters and tags the preview's engine has: LiquidJS's own, collected
// as a fresh engine registers them, and Reporter's, from the same functions
// that register them for rendering. So completions offer exactly what renders.
let _known = null;
function known() {
    if (_known) return _known;
    const liquidjs = require('liquidjs');
    const Liquid = liquidjs.Liquid || liquidjs;
    const filters = new Set();
    const tags = new Set();
    const { registerFilter, registerTag } = Liquid.prototype;
    Liquid.prototype.registerFilter = name => { filters.add(name); };
    Liquid.prototype.registerTag = name => { tags.add(name); };
    try {
        new Liquid(); // eslint-disable-line no-new
    } finally {
        Liquid.prototype.registerFilter = registerFilter;
        Liquid.prototype.registerTag = registerTag;
    }
    const engine = require('./engine');
    const recorder = { registerFilter: name => filters.add(name), registerTag: name => tags.add(name) };
    engine.registerCustomFilters(recorder);
    engine.registerCustomTags(recorder);
    _known = { filters: [...filters].sort(), tags: [...tags].sort() };
    return _known;
}

// What each filter does, as `name: arguments` and a line of description.
const FILTERS = {
    abs: ['', 'The number without its sign.'],
    append: [': "text"', 'Adds text to the end.'],
    at_least: [': 0', 'The number, or this minimum if it is smaller.'],
    at_most: [': 100', 'The number, or this maximum if it is larger.'],
    capitalize: ['', 'Makes the first character upper case.'],
    ceil: ['', 'Rounds up to a whole number.'],
    concat: [': other_list', 'Joins two lists into one.'],
    date: [': "%d %B %Y"', 'Formats a date, e.g. "%d %B %Y" for 1 October 2026.'],
    default: [': "fallback"', 'The value, or the fallback when it is empty, false or missing.'],
    divided_by: [': 2', 'Divides by a number. Whole numbers give a whole number.'],
    downcase: ['', 'Makes the text lower case.'],
    escape: ['', 'Escapes HTML characters, so the text shows as written.'],
    escape_once: ['', 'Escapes HTML characters, leaving ones already escaped.'],
    first: ['', 'The first item of a list.'],
    floor: ['', 'Rounds down to a whole number.'],
    join: [': ", "', 'Joins a list into text with a separator.'],
    json: ['', 'The value as JSON, laid out with two-space indents (Reporter).'],
    last: ['', 'The last item of a list.'],
    lstrip: ['', 'Removes whitespace from the start.'],
    map: [': "property"', 'Each item’s value of a property, as a list.'],
    markdownify: ['', 'Renders Markdown as HTML, as Reporter does: "- item" becomes a bullet.'],
    minus: [': 1', 'Subtracts a number.'],
    modulo: [': 2', 'The remainder after dividing by a number.'],
    money: ['', 'Formats a number as money with two decimals and thousands commas, e.g. 1,250.50 (Reporter).'],
    newline_to_br: ['', 'Turns each line break into <br>.'],
    plus: [': 1', 'Adds a number.'],
    prepend: [': "text"', 'Adds text to the start.'],
    remove: [': "text"', 'Removes every occurrence of the text.'],
    remove_first: [': "text"', 'Removes the first occurrence of the text.'],
    replace: [': "old", "new"', 'Replaces every occurrence of the text.'],
    replace_first: [': "old", "new"', 'Replaces the first occurrence of the text.'],
    reverse: ['', 'The list in reverse order.'],
    round: ['', 'Rounds to a whole number, or to the given number of decimals.'],
    rstrip: ['', 'Removes whitespace from the end.'],
    size: ['', 'How many items a list has, or characters a text has.'],
    slice: [': 0, 1', 'Part of a list or text: from a position, this many items. Missing data is a warning, not an error (Reporter).'],
    sort: [': "property"', 'Sorts a list, by a property if given. Missing values sort last (Reporter).'],
    sort_natural: [': "property"', 'Sorts a list ignoring case, by a property if given (Reporter).'],
    split: [': ","', 'Splits text into a list at a separator.'],
    strip: ['', 'Removes whitespace from both ends.'],
    strip_html: ['', 'Removes HTML tags, leaving their text.'],
    strip_newlines: ['', 'Removes line breaks.'],
    times: [': 2', 'Multiplies by a number.'],
    truncate: [': 50', 'Cuts text to this many characters, ending with "...".'],
    truncatewords: [': 15', 'Cuts text to this many words, ending with "...".'],
    uniq: ['', 'The list without repeats.'],
    upcase: ['', 'Makes the text upper case.'],
    url_decode: ['', 'Decodes text from a URL.'],
    url_encode: ['', 'Encodes text for use in a URL.'],
    where: [': "property", "value"', 'The items of a list whose property has the value. Missing data is a warning, not an error (Reporter).']
};

// Tags, as inserted: the tag's text after `{%-` up to its `%}`, as a snippet. A
// block tag brings its end tag, in the house style (`{%-`). Reporter's tags go
// in over several lines, as a formatted template has them: what's inside each
// on its own indented line, and each choice option on its own (`\t` becomes
// the editor's own indent).
const TAGS = {
    if: ['if ${1:condition} %}$0{%DASH endif %}', 'Shows its contents when the condition is true.'],
    unless: ['unless ${1:condition} %}$0{%DASH endunless %}', 'Shows its contents when the condition is false.'],
    elsif: ['elsif ${1:condition} %}', 'Another condition within an if.'],
    else: ['else %}', 'What to show when no condition above was true.'],
    case: ['case ${1:variable} %}\n{%DASH when ${2:"value"} %}$0\n{%DASH endcase %}', 'Picks the "when" that matches the value.'],
    when: ['when ${1:"value"} %}', 'A value within a case.'],
    for: ['for ${1:item} in ${2:list} %}$0{%DASH endfor %}', 'Repeats its contents once per item of a list.'],
    break: ['break %}', 'Stops a for loop.'],
    continue: ['continue %}', 'Skips to the next item of a for loop.'],
    cycle: ['cycle ${1:"odd", "even"} %}', 'Each time it runs, the next of its values.'],
    tablerow: ['tablerow ${1:item} in ${2:list} %}$0{%DASH endtablerow %}', 'Table rows and cells, one cell per item.'],
    assign: ['assign ${1:name} = ${2:value} %}', 'Gives a value a name.'],
    capture: ['capture ${1:name} %}$0{%DASH endcapture %}', 'Gives what its contents render a name.'],
    increment: ['increment ${1:counter} %}', 'Shows a counter, then adds one to it.'],
    decrement: ['decrement ${1:counter} %}', 'Takes one from a counter, then shows it.'],
    comment: ['comment %}$0{%DASH endcomment %}', 'Text that isn’t rendered.'],
    raw: ['raw %}$0{%DASH endraw %}', 'Text shown as written, Liquid included.'],
    include: ['include "${1:file}" %}', 'Renders another template here.'],
    layout: ['layout "${1:file}" %}', 'Renders this template inside another.'],
    block: ['block ${1:name} %}$0{%DASH endblock %}', 'A part of a layout this template fills in.'],
    optional: ['optional "${1:name}" %}\n\t$0\n{%DASH endoptional %}', 'Reporter: a part the reader can tick to include. Its field is fields.name ("true" when ticked).'],
    editor: ['editor "${1:name}"${2:, placeholder: "${3}"} %}\n\t$0\n{%DASH endeditor %}', 'Reporter: a text box the reader fills in. Its field is fields.name. Options: placeholder, lines, maxlength, minlength.'],
    choice: ['choice "${1:name}", title: "${2:Title}" %}\n\t${3:First option}\n{%DASH or %}\n\t${4:Second option}\n{%DASH endchoice %}', 'Reporter: options the reader picks one of, separated by {% or %}. Its field is fields.name ("0" for the first).'],
    or: ['or %}\n\t$0', 'Reporter: the next option within a choice.']
};

const REPORTER_OPTIONS = {
    editor: { placeholder: 'Text shown in the empty box.', lines: 'How many lines the box has; more than 1 makes a text area.', maxlength: 'The most characters allowed (100 if not given).', minlength: 'The fewest characters allowed (0 if not given).' },
    choice: { title: 'A heading shown above the options.' },
    optional: {}
};

const FORLOOP = {
    index: 'The current item’s position, from 1.',
    index0: 'The current item’s position, from 0.',
    rindex: 'Positions left to the end, counting this one.',
    rindex0: 'Positions left to the end, not counting this one.',
    first: 'True for the first item.',
    last: 'True for the last item.',
    length: 'How many items the loop has.'
};

// ---- where the cursor is ------------------------------------------------------------

// The Liquid tag or object the cursor is inside, as the text from its `{%`
// or `{{` up to the cursor; or null when it is in HTML. Inside a comment or
// raw block nothing is Liquid, bar the tag that ends it, so `inside` says which
// block that is (its opening tag).
function liquidBefore(text, offset) {
    const before = text.slice(0, offset);
    const open = Math.max(before.lastIndexOf('{%'), before.lastIndexOf('{{'));
    if (open < 0) return null;
    const close = Math.max(before.lastIndexOf('%}'), before.lastIndexOf('}}'));
    if (close > open) return null;
    let inside = null;
    for (const t of liquidTags(text)) {
        if (t.start > open) break;
        if ((t.name === 'comment' || t.name === 'raw') && t.end <= open) {
            const end = text.indexOf(`end${t.name}`, t.end);
            if (end < 0 || end > open) { inside = t; break; }
        }
    }
    return { start: open, kind: before[open + 1] === '%' ? 'tag' : 'object', text: before.slice(open), inside };
}

// Blocks open at `offset` (for loops, captures, Reporter's tags...), outermost first.
function openBlocks(text, offset) {
    const stack = [];
    for (const t of liquidTags(text)) {
        if (t.end > offset) break;
        if (t.name.startsWith('end')) {
            const i = stack.map(s => s.name).lastIndexOf(t.name.slice(3));
            if (i >= 0) stack.splice(i);
        } else if (/^(if|unless|case|for|tablerow|capture|optional|editor|choice)$/.test(t.name)) {
            stack.push(t);
        }
    }
    return stack;
}

// The blocks that have an end tag, and the tags that go between a block's
// start and its end.
const END_TAGS_OF = ['if', 'unless', 'case', 'for', 'tablerow', 'capture', 'comment', 'raw', 'optional', 'editor', 'choice', 'block'];
const MIDDLE = { if: ['else', 'elsif'], unless: ['else'], for: ['else'], case: ['when', 'else'], choice: ['or'] };
const MIDDLE_TAGS = new Set(['else', 'elsif', 'when', 'or', 'break', 'continue']);

// Every block in the template, with the end tag that closes it or null. Blocks
// are matched by nesting across the whole text, so one closed further down is
// told from one that never is.
function blockRecords(text) {
    const records = [];
    const stack = [];
    for (const t of liquidTags(text)) {
        if (END_TAGS_OF.includes(t.name)) {
            const record = { tag: t, closer: null };
            records.push(record);
            stack.push(record);
        } else if (t.name.startsWith('end') && END_TAGS_OF.includes(t.name.slice(3))) {
            const i = stack.map(r => r.tag.name).lastIndexOf(t.name.slice(3));
            if (i >= 0) {
                stack[i].closer = t;
                stack.splice(i);
            }
        }
    }
    return records;
}

// The blocks `offset` is inside, outermost first: opened before it and not
// closed before it. The tag being typed, which runs from `from` to `offset`,
// is blanked out first: it names nothing yet, and without its `%}` it would
// run into the next tag and swallow it.
function enclosing(text, from, offset) {
    const masked = text.slice(0, from) + text.slice(from, offset).replace(/[^\n]/g, ' ') + text.slice(offset);
    return blockRecords(masked).filter(r => r.tag.end <= offset && (!r.closer || r.closer.start >= offset));
}

function lineOf(text, offset) {
    return text.slice(0, offset).split('\n').length;
}

// ---- completions -------------------------------------------------------------------

// What to offer at `offset` in a template: an array of { label, kind, insert
// (snippet text), detail, documentation, replace: [start, end] } — or null
// outside Liquid, where HTML completions apply. `datasets` are the data
// objects the template is used with; their fields are offered by name.
function completionsAt(text, offset, datasets = []) {
    const at = liquidBefore(text, offset);
    if (!at) return null;
    const inside = at.text;
    const after = text.slice(offset, text.indexOf('\n', offset) < 0 ? text.length : text.indexOf('\n', offset));

    // The tag's name.
    let m = at.kind === 'tag' && /^\{%-?\s*(\w*)$/.exec(inside);
    if (m) {
        const word = m[1];
        // Replace the rest of the name, and an empty `%}` already there, or
        // the `}` the editor paired with `{`.
        const rest = /^\w*(?:\s*-?%\}|\}(?!\}))?/.exec(after)[0];
        const replace = [offset - word.length, offset + rest.length];
        const reporter = name => /^(optional|editor|choice|or)$/.test(name);
        const item = name => ({
            label: name,
            kind: reporter(name) ? 'reporter' : 'keyword',
            // End tags in the house style, whatever the opening tag has.
            insert: TAGS[name][0].replace(/DASH/g, '-'),
            detail: reporter(name) ? 'Reporter tag' : 'Liquid tag',
            documentation: TAGS[name][1],
            replace
        });
        // The end tag of a block, saying which one it ends and where that starts.
        const endItem = r => {
            const opener = `{% ${r.tag.markup.length > 50 ? r.tag.markup.slice(0, 49) + '\u2026' : r.tag.markup} %}`;
            return {
                label: 'end' + r.tag.name,
                kind: reporter(r.tag.name) ? 'reporter' : 'keyword',
                insert: `end${r.tag.name} %}`,
                detail: `Ends ${opener} from line ${lineOf(text, r.tag.start)}`,
                documentation: `Closes the ${r.tag.name} block that ${opener} opens, on line ${lineOf(text, r.tag.start)}.`,
                replace
            };
        };

        // Inside a comment or raw block the one tag there is ends it.
        if (at.inside) return [endItem({ tag: at.inside })];

        // What belongs where the cursor is comes first: the end of the block
        // it's in if that block is still open, the tags that go inside that
        // kind of block (else and elsif in an if, or in a choice), the ends of
        // the blocks around that, then the tags that start something, and last
        // the ones that mean nothing here (an else outside any if).
        const around = enclosing(text, at.start, offset).reverse(); // innermost first
        const innermost = around[0];
        const open = innermost && !innermost.closer ? [innermost] : [];
        const middle = (innermost && MIDDLE[innermost.tag.name]) || [];
        const contextual = middle.concat(around.some(r => r.tag.name === 'for') ? ['break', 'continue'] : []);
        const ends = around.filter(r => !r.closer).concat(around.filter(r => r.closer)).filter(r => !open.includes(r));
        const all = [...new Set(known().tags.concat(['elsif', 'else', 'when', 'or']))].filter(n => TAGS[n]);
        return [
            ...open.map(endItem),
            ...contextual.map(item),
            ...ends.map(endItem),
            ...all.filter(n => !MIDDLE_TAGS.has(n)).map(item),
            ...all.filter(n => MIDDLE_TAGS.has(n) && !contextual.includes(n)).map(item)
        ];
    }

    // Inside a comment or raw block, only that tag.
    if (at.inside) return [];

    // A filter.
    m = /\|\s*(\w*)$/.exec(inside);
    if (m) {
        const replace = [offset - m[1].length, offset + /^\w*/.exec(after)[0].length];
        return known().filters.map(name => {
            const [args, doc] = FILTERS[name] || ['', ''];
            return { label: name, kind: 'function', insert: name + snippetArgs(args), detail: `${name}${args}`, documentation: doc, replace };
        });
    }

    // An option of one of Reporter's tags: `{% editor "name", placeholder: ...`.
    m = at.kind === 'tag' && /^\{%-?\s*(editor|choice|optional)\s+[^%]*,\s*(\w*)$/.exec(inside);
    if (m) {
        const replace = [offset - m[2].length, offset];
        return Object.entries(REPORTER_OPTIONS[m[1]]).map(([name, doc]) => ({
            label: name, kind: 'property', insert: `${name}: ${name === 'lines' || name.endsWith('length') ? '${1:1}' : '"${1}"'}`, detail: `${m[1]} option`, documentation: doc, replace
        }));
    }

    // A variable, or a field of one: `cust`, `customer.`, `customer.address.to`.
    const expr = /(?:^|[^\w.\]"'])((?:[A-Za-z_][\w-]*)?(?:(?:\.[\w-]*)|\[\d+\])*)$/.exec(inside.replace(/^\{[{%]-?/, ' '));
    if (!expr) return [];
    const typedPath = expr[1];
    const lastDot = typedPath.lastIndexOf('.');
    const word = typedPath.slice(lastDot + 1);
    const replace = [offset - word.length, offset + /^[\w-]*/.exec(after)[0].length];
    const names = lastDot < 0
        ? rootNames(text, offset, datasets)
        : memberNames(text, offset, typedPath.slice(0, lastDot), datasets);
    return names.map(([name, info]) => Object.assign({ label: name, replace, insert: name }, info));
}

function snippetArgs(args) {
    let n = 0;
    return args.replace(/"[^"]*"|[\w.]+/g, v => `\${${++n}:${v.replace(/[$}\\]/g, '\\$&')}}`);
}

// The names in scope at `offset`: the data's top-level fields, loop
// variables, assigned and captured names.
function rootNames(text, offset, datasets) {
    const names = new Map();
    for (const data of datasets) {
        for (const [key, value] of Object.entries(data || {})) if (!names.has(key)) names.set(key, describe(value, 'data'));
    }
    for (const t of openBlocks(text, offset)) {
        const loop = /^(?:for|tablerow)\s+(\w+)\s+in\s+(\S+)/.exec(t.markup);
        if (loop) {
            names.set(loop[1], { kind: 'variable', detail: `each item of ${loop[2]}` });
            names.set('forloop', { kind: 'variable', detail: 'this loop’s position' });
        }
    }
    for (const t of liquidTags(text.slice(0, offset))) {
        const named = /^(?:assign|capture)\s+(\w+)/.exec(t.markup);
        if (named) names.set(named[1], { kind: 'variable', detail: t.name === 'assign' ? t.markup.replace(/^assign\s+/, '') : 'captured text' });
    }
    if (!names.has('fields') && reporterFields(text).length) names.set('fields', { kind: 'variable', detail: 'what the reader entered in Reporter’s tags' });
    return [...names];
}

// The fields of `path` (`customer`, `item.address`, `forloop`, `fields`).
function memberNames(text, offset, path, datasets) {
    const segments = path.split(/\.|\[(\d+)\]/).filter(s => s !== undefined && s !== '');
    if (segments[0] === 'forloop' && segments.length === 1) {
        return Object.entries(FORLOOP).map(([name, doc]) => [name, { kind: 'property', detail: 'forloop', documentation: doc }]);
    }
    const values = valuesOf(text, offset, segments, datasets);
    const out = new Map();
    if (segments[0] === 'fields' && segments.length === 1) {
        for (const [name, tag] of reporterFields(text)) out.set(name, { kind: 'property', detail: `{% ${tag} %} field` });
    }
    for (const value of values) {
        if (Array.isArray(value)) {
            for (const name of ['size', 'first', 'last']) if (!out.has(name)) out.set(name, { kind: 'property', detail: `list of ${value.length}` });
        } else if (value && typeof value === 'object') {
            for (const [key, v] of Object.entries(value)) if (!out.has(key)) out.set(key, describe(v, path));
        } else if (typeof value === 'string' && !out.has('size')) {
            out.set('size', { kind: 'property', detail: 'characters in the text' });
        }
    }
    return [...out];
}

// Every value `segments` names, across all the data: a loop variable reads as
// each item of its list, an assigned name as what it was assigned (when that's
// a plain path).
function valuesOf(text, offset, segments, datasets, depth = 0) {
    if (depth > 5) return [];
    const [head, ...rest] = segments;
    let roots = null;
    const blocks = openBlocks(text, offset).reverse();
    for (const t of blocks) {
        const loop = /^(?:for|tablerow)\s+(\w+)\s+in\s+([\w.[\]]+)/.exec(t.markup);
        if (loop && loop[1] === head) {
            const lists = valuesOf(text, t.start, loop[2].split(/\.|\[(\d+)\]/).filter(s => s), datasets, depth + 1);
            roots = [].concat(...lists.filter(Array.isArray));
            break;
        }
    }
    if (!roots) {
        const assigned = liquidTags(text.slice(0, offset)).reverse().map(t => /^assign\s+(\w+)\s*=\s*([\w.[\]]+)\s*$/.exec(t.markup)).find(a => a && a[1] === head);
        roots = assigned
            ? valuesOf(text, offset, assigned[2].split(/\.|\[(\d+)\]/).filter(s => s), datasets, depth + 1)
            : datasets.map(d => d && d[head]).filter(v => v !== undefined);
    }
    let values = roots;
    for (const seg of rest) {
        const next = [];
        for (const v of values) {
            if (Array.isArray(v)) {
                if (seg === 'first') v.length && next.push(v[0]);
                else if (seg === 'last') v.length && next.push(v[v.length - 1]);
                else if (/^\d+$/.test(seg) && v[seg] !== undefined) next.push(v[seg]);
            } else if (v && typeof v === 'object' && v[seg] !== undefined) {
                next.push(v[seg]);
            }
        }
        values = next;
    }
    return values;
}

function describe(value, from) {
    if (Array.isArray(value)) return { kind: 'variable', detail: `list of ${value.length}` };
    if (value && typeof value === 'object') return { kind: 'variable', detail: 'object' };
    const shown = typeof value === 'string' ? `"${value.length > 40 ? value.slice(0, 39) + '…' : value}"` : String(value);
    return { kind: 'property', detail: `e.g. ${shown}` };
}

// The names Reporter's tags give fields in this template, with their tag.
function reporterFields(text) {
    const out = new Map();
    for (const t of liquidTags(text)) {
        const m = /^(optional|editor|choice)\s+["']([^"']+)["']/.exec(t.markup);
        if (m && !out.has(m[2])) out.set(m[2], m[1]);
    }
    return [...out];
}

// ---- as you type -------------------------------------------------------------------
//
// Opening a tag is VS Code's own work: the language configuration pairs `{%`
// with ` %}` and `{{` with ` }}`, in the same step as the keystroke, so typing
// as fast as you like can't get ahead of it. What's left for the extension
// is what a pair can't do, and it works from how the line is once typing has
// settled, not from the keystroke it saw: by then a fast typist is several
// characters on, and anything that waited for "the line as it was" gave up.
//
//   Typing the `%}` of a tag yourself leaves the pair's ` %}` after it, as
//   `{%- else %} %}`: pairs type over only a single character. That
//   duplicate goes.
//   A block tag (`{%- if a %}`) gets its end tag, whether the cursor is still
//   in its header or just past its `%}`.

// What a keystroke asks for once typing settles: a list of 'closer' (a tag
// closed by hand), 'block' (a block tag's header, whose end tag may be needed).
// `before` is the line's text up to and including the typed character.
function intentsOf(before, typed) {
    const out = [];
    if (typed === '}' && /(?:%|\})\}$/.test(before)) out.push('closer');
    if ((typed === ' ' || typed === '}') && blockHeader(before)) out.push('block');
    return out;
}

// The block tag `before` (a line's text up to the cursor) is the header of,
// with its dash: the cursor in it, past the name (`{%- if a`), or just past
// its `%}`.
function blockHeader(before) {
    const ended = new RegExp(`\\{%(-?)\\s*(${BLOCK_TAGS})\\b[^%{}]*-?%\\}$`).exec(before);
    if (ended) return { dash: ended[1], name: ended[2], ended: true };
    const open = new RegExp(`\\{%(-?)\\s*(${BLOCK_TAGS})\\s[^%{}]*$`).exec(before);
    return open ? { dash: open[1], name: open[2], ended: false } : null;
}

// How many characters after the cursor are second `%}` or `}}`s for the tag
// the cursor has just closed.
function duplicateCloser(before, after) {
    // One for each tag typed closed by hand since the last time typing settled.
    const m = (/\{%[^%{}]*%\}$/.test(before) && /^(?:\s*%\})+/.exec(after))
        || (/\{\{[^{}]*\}\}$/.test(before) && /^(?:\s*\}\})+/.exec(after));
    return m ? m[0].length : 0;
}

// The end tag for the block `before` is the header of, as a snippet for the
// cursor (`$1`) to stay in the header and Tab to go between the tags; or, past
// the `%}`, for the cursor to go between them. { replace, snippet }: the snippet
// goes in place of `replace` characters after the cursor (the tag's ` %}`, which
// it supplies again). Null if it isn't a block or the template already closes
// every block of that name; 'wait' if the header isn't ready for it yet.
function blockEnd(before, after, whole) {
    const header = blockHeader(before);
    if (!header || closedAlready(header.name, whole)) return null;
    const end = `{%${header.dash} end${header.name} %}`;
    if (header.ended) {
        return /^\s*$/.test(after) ? { replace: 0, snippet: inside(header.name) + end } : null;
    }
    const closer = /^\s*-?%\}/.exec(after);
    // Something else after the cursor: most likely a quote the editor paired
    // and the cursor hasn't yet typed over. 'wait' says to look again.
    if (!/^\s*$/.test(closer ? after.slice(closer[0].length) : after)) return 'wait';
    return {
        replace: closer ? closer[0].length : 0,
        snippet: `$1${closer ? ' ' + closer[0].trim() : ' %}'}${inside(header.name)}${end}`
    };
}

// What to do at the cursor once typing has settled, given what the keystrokes
// asked for: { replace, snippet } — `snippet` goes in place of `replace`
// characters after the cursor, or is empty to just delete them — or
// { wait: true } to look again after more typing, or null.
function settleEdit(before, after, whole, intents) {
    if (!intents.length) return null;
    const duplicate = duplicateCloser(before, after);
    const block = intents.includes('block') ? blockEnd(before, after.slice(duplicate), whole) : null;
    if (block === 'wait') return { wait: true };
    if (block) return { replace: duplicate + block.replace, snippet: block.snippet };
    return duplicate ? { replace: duplicate, snippet: '' } : null;
}

// What goes between a block tag and its end tag, with the cursor ($0) in it:
// beside them for Liquid's tags, on a line of its own, indented, for Reporter's.
function inside(name) {
    return /^(optional|editor|choice)$/.test(name) ? '\n\t$0\n' : '$0';
}

const BLOCK_TAGS = 'if|unless|for|case|capture|tablerow|comment|raw|optional|editor|choice';

// Whether `whole` already has an end tag for every `name` block it opens.
function closedAlready(name, whole) {
    if (whole === null) return false;
    const tags = liquidTags(whole);
    return tags.filter(t => t.name === 'end' + name).length >= tags.filter(t => t.name === name).length;
}

// ---- for the HTML service ----------------------------------------------------------

// The template with each Liquid tag and object replaced by spaces (line
// breaks kept), so positions line up and an HTML service reads the HTML
// around the Liquid as if the Liquid weren't there.
function blankLiquid(text) {
    return text.replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, m => m.replace(/[^\n]/g, ' '));
}

module.exports = { completionsAt, intentsOf, settleEdit, blankLiquid, known, FILTERS, TAGS, liquidBefore };
