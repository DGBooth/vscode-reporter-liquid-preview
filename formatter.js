// Formatting a template: Liquid and HTML together, laid out by Shopify's
// Prettier plugin for Liquid, then in this project's house style, then
// checked: the formatted template must render the same page as the original
// for every set of data it's known to be used with.
//
// The plugin knows Liquid's own block tags but not Reporter's (optional,
// editor, choice), so it would leave their contents unindented. They are
// shown to it as `if` blocks, which lay out the same way, and put back after.
//
// House style is `{%-`: a tag on a line of its own trims the whitespace
// before it, so the line break and indentation that lay the template out
// don't reach the page. Where trimming would change the page (text that
// relies on the space before a tag), that tag is left as it was.

const BLOCKS = new Set(['optional', 'editor', 'choice']);
const PLACEHOLDER = '__rlp_';

let _prettier = null;
function prettier() {
    if (!_prettier) {
        _prettier = {
            format: require('prettier/standalone').format,
            plugins: [
                require('prettier/plugins/babel'),
                require('prettier/plugins/estree'),
                require('prettier/plugins/postcss'),
                liquidPlugin()
            ]
        };
    }
    return _prettier;
}

// Shopify's plugin, built to run in a browser beside Prettier's standalone
// build. Under Node its bundle asks for all of Prettier ("prettier"), though
// all it uses is in the standalone build; it's given that, so the package
// carries one copy of Prettier's core rather than two.
function liquidPlugin() {
    const file = require.resolve('@shopify/prettier-plugin-liquid/standalone');
    const code = require('fs').readFileSync(file, 'utf8');
    const loaded = { exports: {} };
    const load = new Function('module', 'exports', 'require', code); // eslint-disable-line no-new-func
    load(loaded, loaded.exports, id => require(id === 'prettier' ? 'prettier/standalone' : id));
    return loaded.exports;
}

// Every Liquid tag in `text`, in order, with where it is. The insides of raw
// and comment blocks aren't tags, so they're skipped.
function liquidTags(text) {
    const tags = [];
    const re = /\{%(-?)(\s*)(\w*)([\s\S]*?)(-?)%\}/g;
    let m;
    while ((m = re.exec(text))) {
        const tag = { start: m.index, end: re.lastIndex, open: m[1], name: m[3], markup: (m[3] + m[4]).trim(), close: m[5] };
        tags.push(tag);
        if (tag.name === 'raw' || tag.name === 'comment') {
            const end = new RegExp(`\\{%-?\\s*end${tag.name}\\s*-?%\\}`, 'g');
            end.lastIndex = re.lastIndex;
            const e = end.exec(text);
            if (!e) break;
            tags.push({ start: e.index, end: end.lastIndex, open: '', name: 'end' + tag.name, markup: 'end' + tag.name, close: '' });
            re.lastIndex = end.lastIndex;
        }
    }
    return tags;
}

function replaceTags(text, tags, replacement) {
    let out = '';
    let at = 0;
    for (const tag of tags) {
        const next = replacement(tag);
        if (next === null) continue;
        out += text.slice(at, tag.start) + next;
        at = tag.end;
    }
    return out + text.slice(at);
}

// Reporter's tags as `if` blocks the plugin can lay out: `{% optional "x" %}`
// becomes `{% if __rlp_0 %}`, `{% or %}` inside a choice `{% elsif __rlp_1 %}`
// and their end tags `{% endif %}`. Each placeholder remembers what it was.
function hideReporterTags(text) {
    const saved = [];
    const stack = [];
    const tag = (t, inner) => `{%${t.open} ${inner} ${t.close}%}`;
    const hidden = replaceTags(text, liquidTags(text), t => {
        if (BLOCKS.has(t.name)) {
            stack.push(t.name);
            saved.push(t.markup);
            return tag(t, `if ${PLACEHOLDER}${saved.length - 1}`);
        }
        if (t.name === 'or' && stack[stack.length - 1] === 'choice') {
            saved.push('or');
            return tag(t, `elsif ${PLACEHOLDER}${saved.length - 1}`);
        }
        if (t.name.startsWith('end') && BLOCKS.has(t.name.slice(3)) && stack[stack.length - 1] === t.name.slice(3)) {
            stack.pop();
            return tag(t, 'endif');
        }
        return null;
    });
    return { hidden, saved };
}

// Put Reporter's tags back, matching each `endif` to the `if` it closes.
function restoreReporterTags(text, saved) {
    const stack = [];
    return replaceTags(text, liquidTags(text), t => {
        const placeholder = new RegExp(`^(?:if|elsif) ${PLACEHOLDER}(\\d+)$`).exec(t.markup);
        const tag = inner => `{%${t.open} ${inner} ${t.close}%}`;
        if (t.name === 'if') {
            stack.push(placeholder ? saved[placeholder[1]] : null);
            return placeholder ? tag(saved[placeholder[1]]) : null;
        }
        if (t.name === 'elsif' && placeholder) return tag(saved[placeholder[1]]);
        if (t.name === 'endif') {
            const opened = stack.pop();
            return opened ? tag('end' + opened.split(/\s/)[0]) : null;
        }
        return null;
    });
}

// The template laid out by the plugin, Reporter's tags included. Throws with
// the plugin's message if the template can't be read.
async function layOut(text, options = {}) {
    const { hidden, saved } = hideReporterTags(text);
    const { format, plugins } = prettier();
    const out = await format(hidden, {
        parser: 'liquid-html',
        plugins,
        printWidth: options.printWidth || 120,
        tabWidth: options.tabWidth || 2,
        useTabs: !!options.useTabs,
        // Reporter's tags are written with double quotes; Liquid's follow.
        liquidSingleQuote: false,
        embeddedSingleQuote: false
    });
    return restoreReporterTags(out, saved);
}

// Tags starting a line that don't trim the whitespace before them yet.
function untrimmedLineStarts(text) {
    return liquidTags(text).filter(t => !t.open && /(^|\n)[ \t]*$/.test(text.slice(Math.max(0, t.start - 200), t.start)));
}

function trimBefore(text, tags) {
    const at = new Set(tags.map(t => t.start));
    let out = '';
    let last = 0;
    for (const start of [...at].sort((a, b) => a - b)) {
        out += text.slice(last, start + 2) + '-';
        last = start + 2;
    }
    return out + text.slice(last);
}

// ---- comparing what two templates render ----------------------------------------

// What a page shows, as a string that two renderings can be compared by:
// its elements and attributes, its text, and the whitespace a reader would
// see. Whitespace collapses as a browser collapses it, and disappears beside
// the edges of blocks (paragraphs, table cells, divs), so laying a template out
// on more lines changes nothing here, while losing the space in "Dear Mr"
// does. Inside <pre> and <textarea> whitespace counts as written.
const BLOCK = '\u2029';
const BLOCK_ELEMENTS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'col', 'colgroup', 'dd', 'details', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'legend',
    'li', 'link', 'main', 'meta', 'nav', 'ol', 'option', 'p', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul']);
const VERBATIM = new Set(['pre', 'textarea', 'script', 'style']);

function shapeOf(html) {
    const { asPreviewShowsIt } = require('./output-checks');
    const parse5 = require('parse5');
    const fragment = parse5.parseFragment(asPreviewShowsIt(html));
    const parts = [];
    const signature = n => `<${n.nodeName}${(n.attrs || []).map(a => ` ${a.name}="${a.value.replace(/\s+/g, ' ').trim()}"`).join('')}>`;
    const walk = n => {
        if (n.nodeName === '#text') { parts.push(n.value); return; }
        if (n.nodeName === '#comment') return;
        const kids = n.nodeName === 'template' ? n.content.childNodes : n.childNodes || [];
        if (VERBATIM.has(n.nodeName)) {
            // Scripts and stylesheets are laid out by Prettier's own CSS and
            // JavaScript formatters, which add semicolons and change quotes
            // without changing what they do; only their place is compared.
            const body = n.nodeName === 'script' || n.nodeName === 'style' ? '' : kids.map(k => k.value || '').join('').replace(/^\n/, '');
            parts.push(BLOCK, signature(n), '\u0000' + body + '\u0000', `</${n.nodeName}>`, BLOCK);
            return;
        }
        const block = BLOCK_ELEMENTS.has(n.nodeName);
        if (n.nodeName !== '#document-fragment') parts.push(block ? BLOCK : '', signature(n));
        for (const k of kids) walk(k);
        if (n.nodeName !== '#document-fragment') parts.push(`</${n.nodeName}>`, block ? BLOCK : '');
    };
    // The page sits in the preview's own block, so its edges are block edges.
    parts.push(BLOCK);
    walk(fragment);
    parts.push(BLOCK);
    return parts.join('')
        .split('\u0000')
        .map((piece, i) => i % 2 ? piece : piece
            .replace(/[ \t\n\r\f]+/g, ' ')
            // A space beside a block edge isn't seen, wherever tags fall.
            .replace(/ ?((?:<\/?[a-z][^>]*>)*\u2029(?:<\/?[a-z][^>]*>)*) ?/g, '$1')
            .replace(/\u2029+/g, BLOCK))
        .join('\u0000');
}

// Null if the two outputs show the same page; otherwise where they differ.
function differenceBetween(before, after) {
    const a = shapeOf(before);
    const b = shapeOf(after);
    if (a === b) return null;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const show = s => s.slice(Math.max(0, i - 40), i + 40).replace(/\u2029/g, ' ').replace(/\u0000/g, '');
    return { before: show(a), after: show(b) };
}

// ---- formatting, checked ------------------------------------------------------------

// Format `text`, and check the result against each of `datasets` ({ label,
// data }) by rendering both with `render(text, data)` (→ html or null). A data
// set the original can't render is skipped: it says nothing either way.
//
// Returns { text, checked, trimmed, keptSpacing } where `checked` counts the
// data sets the result was compared on and `keptSpacing` the tags left
// untrimmed because trimming changed the page; or { error, difference?, label? }
// when the layout itself changes the page, or the template can't be read.
async function formatTemplate(text, { datasets = [], render, options = {} } = {}) {
    let laidOut;
    try {
        laidOut = await layOut(text, options);
    } catch (err) {
        return { error: `The template couldn’t be read for formatting: ${firstLine(err.message)}` };
    }

    const originals = [];
    for (const set of datasets) {
        const html = await render(text, set.data);
        if (html !== null && html !== undefined) originals.push({ label: set.label, data: set.data, html });
    }
    if (datasets.length && !originals.length) {
        return { error: 'The template doesn\u2019t render at the moment (see the Problems panel), so formatting it couldn\u2019t be checked. Fix that first.' };
    }
    // The first data set the candidate renders differently, or null.
    const firstDifference = async candidate => {
        for (const o of originals) {
            const html = await render(candidate, o.data);
            if (html === null || html === undefined) return { label: o.label, difference: null };
            const difference = differenceBetween(o.html, html);
            if (difference) return { label: o.label, difference };
        }
        return null;
    };

    const changed = await firstDifference(laidOut);
    if (changed) {
        return {
            error: `Formatting would change what the page shows with ${changed.label}, so the template was left as it was.`,
            label: changed.label,
            difference: changed.difference
        };
    }

    // Trim before every tag that starts a line; where that changes the page,
    // find the tags responsible by halving, and leave just those as they were.
    const candidates = untrimmedLineStarts(laidOut);
    const kept = [];
    const settle = async (group, trimmed) => {
        if (!group.length) return;
        if (!await firstDifference(trimBefore(laidOut, trimmed.concat(group)))) {
            trimmed.push(...group);
            return;
        }
        if (group.length === 1) { kept.push(group[0]); return; }
        const half = Math.ceil(group.length / 2);
        await settle(group.slice(0, half), trimmed);
        await settle(group.slice(half), trimmed);
    };
    const trimmed = [];
    if (originals.length) await settle(candidates, trimmed);
    else trimmed.push(...candidates);

    return {
        text: trimBefore(laidOut, trimmed),
        checked: originals.length,
        trimmed: trimmed.length,
        keptSpacing: kept.length
    };
}

function firstLine(message) {
    return String(message).split('\n')[0];
}

module.exports = { formatTemplate, layOut, differenceBetween, hideReporterTags, restoreReporterTags, liquidTags };
