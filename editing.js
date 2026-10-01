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

// Tags, as inserted: the tag's text after `{%-`, as a snippet. A block tag
// brings its end tag, in the house style (`{%-`).
const TAGS = {
    if: ['if ${1:condition} %}$0{%DASH endif', 'Shows its contents when the condition is true.'],
    unless: ['unless ${1:condition} %}$0{%DASH endunless', 'Shows its contents when the condition is false.'],
    elsif: ['elsif ${1:condition}', 'Another condition within an if.'],
    else: ['else', 'What to show when no condition above was true.'],
    case: ['case ${1:variable} %}\n{%DASH when ${2:"value"} %}$0\n{%DASH endcase', 'Picks the "when" that matches the value.'],
    when: ['when ${1:"value"}', 'A value within a case.'],
    for: ['for ${1:item} in ${2:list} %}$0{%DASH endfor', 'Repeats its contents once per item of a list.'],
    break: ['break', 'Stops a for loop.'],
    continue: ['continue', 'Skips to the next item of a for loop.'],
    cycle: ['cycle ${1:"odd", "even"}', 'Each time it runs, the next of its values.'],
    tablerow: ['tablerow ${1:item} in ${2:list} %}$0{%DASH endtablerow', 'Table rows and cells, one cell per item.'],
    assign: ['assign ${1:name} = ${2:value}', 'Gives a value a name.'],
    capture: ['capture ${1:name} %}$0{%DASH endcapture', 'Gives what its contents render a name.'],
    increment: ['increment ${1:counter}', 'Shows a counter, then adds one to it.'],
    decrement: ['decrement ${1:counter}', 'Takes one from a counter, then shows it.'],
    comment: ['comment %}$0{%DASH endcomment', 'Text that isn’t rendered.'],
    raw: ['raw %}$0{%DASH endraw', 'Text shown as written, Liquid included.'],
    include: ['include "${1:file}"', 'Renders another template here.'],
    layout: ['layout "${1:file}"', 'Renders this template inside another.'],
    block: ['block ${1:name} %}$0{%DASH endblock', 'A part of a layout this template fills in.'],
    optional: ['optional "${1:name}" %}$0{%DASH endoptional', 'Reporter: a part the reader can tick to include. Its field is fields.name ("true" when ticked).'],
    editor: ['editor "${1:name}"${2:, placeholder: "${3}"} %}{%DASH endeditor', 'Reporter: a text box the reader fills in. Its field is fields.name. Options: placeholder, lines, maxlength, minlength.'],
    choice: ['choice "${1:name}", title: "${2:Title}" %}${3:First option}{%DASH or %}${4:Second option}{%DASH endchoice', 'Reporter: options the reader picks one of, separated by {% or %}. Its field is fields.name ("0" for the first).'],
    or: ['or', 'Reporter: the next option within a choice.']
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
// or `{{` up to the cursor; or null when it is in HTML. Comments and raw
// blocks count as HTML: nothing in them is Liquid.
function liquidBefore(text, offset) {
    const before = text.slice(0, offset);
    const open = Math.max(before.lastIndexOf('{%'), before.lastIndexOf('{{'));
    if (open < 0) return null;
    const close = Math.max(before.lastIndexOf('%}'), before.lastIndexOf('}}'));
    if (close > open) return null;
    for (const t of liquidTags(text)) {
        if (t.start > open) break;
        if ((t.name === 'comment' || t.name === 'raw') && t.end <= open) {
            const end = text.indexOf(`end${t.name}`, t.end);
            if (end < 0 || end > open) return null;
        }
    }
    return { start: open, kind: before[open + 1] === '%' ? 'tag' : 'object', text: before.slice(open) };
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
        return [...new Set(known().tags.concat(['elsif', 'else', 'when', 'or']))].filter(n => TAGS[n]).map(name => {
            const reporter = /^(optional|editor|choice|or)$/.test(name);
            return {
                label: name,
                kind: reporter ? 'reporter' : 'keyword',
                // End tags in the house style, whatever the opening tag has.
                insert: TAGS[name][0].replace(/DASH/g, '-') + ' %}',
                detail: reporter ? 'Reporter tag' : 'Liquid tag',
                documentation: TAGS[name][1],
                replace
            };
        });
    }

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

// After a keystroke: a snippet to put in place of [start, end) of the line,
// or null. `before` and `after` are the line's text either side of the cursor,
// after the keystroke; `whole` the template's text.
//
//   `{%-` or `{% ` → the tag's `%}` after the cursor, taking in the `}` the
//   editor paired with `{`.
//   Typing the `%}` yourself types over one already there, rather than
//   doubling it, whoever put it there: in Liquid, `%` before `%}` or `}`
//   between `%}` and `}` is never meant.
//   The `%}` of a block tag, typed or typed over, with nothing after it on the
//   line → its end tag after the cursor, with the same `{%` or `{%-`.
function afterTyping(before, after, typed, whole = null) {
    if ((typed === '-' && /\{%-$/.test(before)) || (typed === ' ' && /\{% $/.test(before))) {
        const paired = /^\}(?!\})/.test(after) ? 1 : 0;
        // A `%}` further on, before another tag starts, closes a tag already there.
        if (/^[^{]*%\}/.test(after.slice(paired))) return null;
        return { start: before.length, end: before.length + paired, snippet: '$0 %}' };
    }
    if (typed === '%') {
        const closer = /^(\s*)%\}/.exec(after);
        if (!closer) return null;
        // `x %` typed before ` %}` gives `x %}`, not `x  %}`; `x -%` keeps its dash.
        const typedBefore = before.slice(0, -1);
        const spaces = /\s*$/.exec(typedBefore)[0];
        const dash = /-$/.test(typedBefore);
        return { start: typedBefore.length - spaces.length, end: before.length + closer[1].length + 1, snippet: (dash ? '' : ' ') + '%$0' };
    }
    if (typed === '}' && /%\}$/.test(before)) {
        if (/^\}/.test(after)) {
            return { start: before.length - 1, end: before.length + 1, snippet: '}' + (endTag(before, after.slice(1), whole) || '$0') };
        }
        const tail = endTag(before, after, whole);
        return tail ? { start: before.length, end: before.length, snippet: tail } : null;
    }
    return null;
}

// The end tag for the block tag `before` ends with, as a snippet to follow
// it; null if it isn't one, something follows it on the line, or the template
// already closes every such block (retyping the end of a tag that has its end
// tag shouldn't add another).
function endTag(before, after, whole) {
    if (!/^\s*$/.test(after)) return null;
    const m = /\{%(-?)\s*(if|unless|for|case|capture|tablerow|comment|raw|optional|editor|choice)\b[^%]*-?%\}$/.exec(before);
    if (!m) return null;
    if (whole !== null) {
        const tags = liquidTags(whole);
        const opened = tags.filter(t => t.name === m[2]).length;
        const closed = tags.filter(t => t.name === 'end' + m[2]).length;
        if (closed >= opened) return null;
    }
    return `$0{%${m[1]} end${m[2]} %}`;
}

// ---- for the HTML service ----------------------------------------------------------

// The template with each Liquid tag and object replaced by spaces (line
// breaks kept), so positions line up and an HTML service reads the HTML
// around the Liquid as if the Liquid weren't there.
function blankLiquid(text) {
    return text.replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, m => m.replace(/[^\n]/g, ' '));
}

module.exports = { completionsAt, afterTyping, blankLiquid, known, FILTERS, TAGS, liquidBefore };
