// The template spec: a template written out for the people who own the document
// rather than the people who write Liquid. Nothing is run and no data is needed.
// Every part of the document that can vary is shown once, in place, with a
// reference (R4.2, C3.1, O7, …) and what decides it in plain words, so an owner
// can check it and point at it: "R4.2 should also apply to DC pensions".
//
// It is laid out to print to PDF, which is how it gets shared and marked up:
//   - a cover with the template's version stamp, a summary and contents;
//   - the document, with each variable part marked by a rail in the margin, or
//     by a bracketed [a / b] inside a sentence, never by boxes in boxes;
//   - a checklist of every reference, with the Liquid and line it came from and
//     a column to tick and comment in;
//   - the worked-out values: how each value set by assign or capture, and then
//     used to decide something, is worked out, and under which conditions.
//
// This module doesn't depend on VS Code; extension.js shows it in a panel and
// saves it to a file.

const crypto = require('crypto');
const { parseTagArgs, escapeHtml, pluralize, HTML_BLOCK_TAGS, HTML_VOID_TAGS } = require('./engine');

// ---------------------------------------------------------------------------
// Reading the template
// ---------------------------------------------------------------------------

// Index just past the Liquid tag or expression starting at `i`, or the end of
// the text when it is never closed.
function skipLiquid(text, i) {
    const closeSeq = text[i + 1] === '%' ? '%}' : '}}';
    i += 2;
    while (i < text.length) {
        if (text[i] === closeSeq[0] && text[i + 1] === closeSeq[1]) return i + 2;
        i++;
    }
    return text.length;
}

// Locate the HTML element tag opening at `start` (where text[start] is '<') and
// return the index of its closing '>', or -1 when this '<' does not in fact open
// a tag. Quoted attribute values and whole Liquid regions are skipped, so a '>'
// inside either (e.g. {% if x > 3 %}) does not end the tag early.
//
// Rejecting non-tags matters as much as finding real ones: a '<' that is a
// comparison ({% if a<b %}), prose ("a<b"), or an element whose '>' has not been
// typed yet must not be read as a tag, or every Liquid tag up to the next '>'
// is taken for attribute-level logic and dropped. Losing an {% endif %} that
// way leaves its block open, and it swallows the rest of the document.
function matchHtmlTag(text, start) {
    let j = start + 1;
    if (text[j] === '/') j++;
    if (!/[a-zA-Z!]/.test(text[j] || '')) return -1;

    let quote = null;
    while (j < text.length) {
        const ch = text[j];
        if (quote !== null) {
            if (ch === quote) quote = null;
            j++;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            j++;
        } else if (ch === '{' && (text[j + 1] === '%' || text[j + 1] === '{')) {
            j = skipLiquid(text, j);
        } else if (ch === '<') {
            return -1; // an unquoted '<' cannot appear inside a tag
        } else if (ch === '>') {
            return j;
        } else {
            j++;
        }
    }
    return -1; // no closing '>' — not a tag
}

// An HTML element tag with the Liquid inside it taken out. Liquid there sets an
// attribute (a class, a style) rather than writing anything a reader sees.
function stripLiquidInsideHtmlTag(tag) {
    let result = '';
    let i = 0;
    while (i < tag.length) {
        if (tag[i] === '{' && (tag[i + 1] === '%' || tag[i + 1] === '{')) {
            i = skipLiquid(tag, i);
        } else {
            result += tag[i];
            i++;
        }
    }
    return result;
}

// The template as a flat list of tokens, each with the line it starts on:
//   text    HTML and words, as written (Liquid inside element tags removed)
//   output  {{ expr }} and {% echo expr %}
//   tag     any other {% tag args %}
//   note    a {% comment %}, with its body
// Text inside an HTML comment is dropped, since no one sees it, but Liquid tags
// there still count: Liquid doesn't know about HTML comments, so an {% endif %}
// inside one still ends its block. Tokens inside <style> or <script> are marked
// `raw`; they are kept as they are, with no markers put in among them.
function tokenize(text) {
    const lineStarts = [0];
    for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
    const lineOf = index => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    };

    const tokens = [];
    let buf = '';
    let bufRaw = false;
    let inComment = false;
    let rawElement = null;
    const flush = () => {
        if (buf) tokens.push({ type: 'text', text: buf, raw: bufRaw });
        buf = '';
    };
    const addText = (s, raw) => {
        if (raw !== bufRaw) flush();
        bufRaw = raw;
        buf += s;
    };

    let i = 0;
    while (i < text.length) {
        if (text[i] === '{' && (text[i + 1] === '%' || text[i + 1] === '{')) {
            const isTag = text[i + 1] === '%';
            const end = skipLiquid(text, i);
            const closed = text.slice(end - 2, end) === (isTag ? '%}' : '}}');
            const inner = text.slice(i + 2, closed ? end - 2 : end).replace(/^-/, '').replace(/-$/, '').trim();
            const line = lineOf(i);
            const raw = !!rawElement;
            flush();
            if (!isTag) {
                if (!inComment) tokens.push({ type: 'output', expr: inner, line, raw });
                i = end;
                continue;
            }
            const m = inner.match(/^(\w+)\s*([\s\S]*)$/);
            const name = m ? m[1] : '';
            const args = m ? m[2].trim() : '';
            if (name === 'comment' || name === 'raw') {
                const close = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`, 'g');
                close.lastIndex = end;
                const found = close.exec(text);
                const bodyEnd = found ? found.index : text.length;
                const body = text.slice(end, bodyEnd);
                if (name === 'comment') {
                    if (!inComment) tokens.push({ type: 'note', text: body.trim(), line });
                } else if (!inComment) {
                    addText(escapeHtml(body), raw);
                }
                i = found ? found.index + found[0].length : text.length;
                continue;
            }
            if (name === 'echo') {
                if (!inComment) tokens.push({ type: 'output', expr: args, line, raw });
            } else if (name) {
                tokens.push({ type: 'tag', name, args, line, raw, source: text.slice(i, end) });
            }
            i = end;
            continue;
        }

        if (inComment) {
            if (text.startsWith('-->', i)) { inComment = false; i += 3; } else i++;
            continue;
        }
        if (rawElement) {
            if (text.slice(i, i + rawElement.length + 2).toLowerCase() === `</${rawElement}`) {
                rawElement = null;
                continue; // read the closing tag as an ordinary tag below
            }
            addText(text[i], true);
            i++;
            continue;
        }
        if (text.startsWith('<!--', i)) {
            flush();
            inComment = true;
            i += 4;
            continue;
        }
        if (text[i] === '<') {
            const end = matchHtmlTag(text, i);
            if (end !== -1) {
                const tag = stripLiquidInsideHtmlTag(text.slice(i, end + 1));
                addText(tag, false);
                const m = tag.match(/^<([a-zA-Z][\w-]*)/);
                if (m && /^(style|script)$/i.test(m[1]) && !/\/>$/.test(tag)) rawElement = m[1].toLowerCase();
                i = end + 1;
                continue;
            }
        }
        addText(text[i], false);
        i++;
    }
    flush();
    return tokens;
}

// What closes each block, and the tag it closes.
const END_TAGS = { if: 'endif', unless: 'endunless', case: 'endcase', for: 'endfor', tablerow: 'endtablerow', optional: 'endoptional', choice: 'endchoice', editor: 'endeditor', capture: 'endcapture' };
const OPENED_BY = Object.fromEntries(Object.entries(END_TAGS).map(([open, end]) => [end, open]));

// The tokens as a tree of blocks. A block is left open when the template is
// missing its end tag (or is being typed), and is marked `unclosed` rather than
// dropped: it has taken in everything after it, which is what the reader will
// see, so the spec says so. An end tag with nothing to close is ignored.
function parse(tokens) {
    const root = { type: 'root', children: [] };
    const stack = [];
    const top = () => stack[stack.length - 1];
    const into = () => (stack.length ? top().into : root.children);

    const closeBlock = tag => {
        if (!stack.some(frame => frame.tag === tag)) return;
        for (;;) {
            const frame = stack.pop();
            delete frame.into;
            if (frame.tag === tag) return;
            frame.unclosed = true;
        }
    };
    const open = node => {
        into().push(node);
        stack.push(node);
    };

    for (const token of tokens) {
        if (token.type !== 'tag') {
            into().push(token);
            continue;
        }
        const { name, args, line, raw, source } = token;
        const frame = top();
        switch (name) {
            case 'if':
            case 'unless': {
                const branch = { kind: name, cond: args, line, source, children: [] };
                open({ type: 'if', tag: name, line, raw, branches: [branch], into: branch.children });
                break;
            }
            case 'elsif':
                if (frame && frame.type === 'if') {
                    const branch = { kind: 'elsif', cond: args, line, source, children: [] };
                    frame.branches.push(branch);
                    frame.into = branch.children;
                }
                break;
            case 'else':
                if (frame && (frame.type === 'if' || frame.type === 'case')) {
                    const branch = { kind: 'else', cond: '', line, source, children: [] };
                    frame.branches.push(branch);
                    frame.into = branch.children;
                } else if (frame && frame.type === 'for' && !frame.empty) {
                    frame.empty = [];
                    frame.emptyLine = line;
                    frame.into = frame.empty;
                }
                break;
            case 'case':
                // Anything between case and the first when is never output.
                open({ type: 'case', tag: 'case', line, raw, subject: args, source, branches: [], into: [] });
                break;
            case 'when':
                if (frame && frame.type === 'case') {
                    const branch = { kind: 'when', cond: args, line, source, children: [] };
                    frame.branches.push(branch);
                    frame.into = branch.children;
                }
                break;
            case 'for':
            case 'tablerow': {
                const m = args.match(/^([\w-]+)\s+in\s+([\s\S]+)$/);
                const body = [];
                open({ type: 'for', tag: name, line, raw, source, variable: m ? m[1] : '', collection: m ? m[2].trim() : args, body, empty: null, into: body });
                break;
            }
            case 'optional':
            case 'editor': {
                const children = [];
                open({ type: name, tag: name, line, raw, source, args: parseTagArgs(args), children, into: children });
                break;
            }
            case 'choice': {
                const first = [];
                open({ type: 'choice', tag: 'choice', line, raw, source, args: parseTagArgs(args), options: [first], into: first });
                break;
            }
            case 'or':
                if (frame && frame.type === 'choice') {
                    const option = [];
                    frame.options.push(option);
                    frame.into = option;
                }
                break;
            case 'capture': {
                const children = [];
                open({ type: 'capture', tag: 'capture', line, raw, source, name: args.split(/\s/)[0].replace(/^['"]|['"]$/g, ''), children, into: children });
                break;
            }
            case 'assign': {
                const m = args.match(/^([\w.-]+)\s*=\s*([\s\S]*)$/);
                if (m) into().push({ type: 'assign', name: m[1], expr: m[2].trim(), line, source });
                break;
            }
            case 'include':
            case 'render':
                into().push({ type: 'include', args, line, raw });
                break;
            default:
                if (OPENED_BY[name]) closeBlock(OPENED_BY[name]);
                // Anything else (increment, cycle, break, layout, …) writes
                // nothing a reader needs to see.
                break;
        }
    }
    while (stack.length) {
        const frame = stack.pop();
        delete frame.into;
        frame.unclosed = true;
    }
    return root;
}

// ---------------------------------------------------------------------------
// Plain words for Liquid
// ---------------------------------------------------------------------------

// 'client.first_name' or 'ownerName' as words.
function humanizeName(name) {
    if (!name) return '';
    return String(name)
        .replace(/\[["']?/g, '.')
        .replace(/["']?\]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(word => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()))
        .join(' ');
}

const WORDS = {
    '==': 'is', '!=': 'is not', '<>': 'is not', '>=': 'is at least', '<=': 'is at most', '>': 'is more than', '<': 'is less than',
    contains: 'contains', and: 'and', or: 'or',
    blank: 'empty', empty: 'empty', nil: 'missing', null: 'missing', true: 'true', false: 'false'
};

// A Liquid expression in tokens: strings, numbers, names, operators, filters.
function lexExpression(expr) {
    const re = /\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|(==|!=|<>|>=|<=|>|<|\||:|,|\(|\)|\.\.)|([A-Za-z_][\w-]*\??(?:\.[\w-]+\??|\[[^\]]*\])*)|(\S))/g;
    const tokens = [];
    let m;
    while ((m = re.exec(expr)) !== null) {
        if (m[0].trim() === '') break;
        if (m[1] !== undefined || m[2] !== undefined) tokens.push({ kind: 'string', text: m[1] !== undefined ? m[1] : m[2] });
        else if (m[3] !== undefined) tokens.push({ kind: 'number', text: m[3] });
        else if (m[4] !== undefined) tokens.push({ kind: 'op', text: m[4] });
        else if (m[5] !== undefined) tokens.push(WORDS[m[5]] !== undefined && !m[5].includes('.') ? { kind: 'word', text: m[5] } : { kind: 'name', text: m[5] });
        else tokens.push({ kind: 'other', text: m[6] });
    }
    return tokens;
}

// The names of values an expression reads, by their first part: `pension` for
// `pension.type`. Filter names are not values.
function namesIn(expr) {
    const out = [];
    const tokens = lexExpression(expr);
    tokens.forEach((t, k) => {
        if (t.kind !== 'name') return;
        const prev = tokens[k - 1];
        if (prev && prev.kind === 'op' && prev.text === '|') return; // a filter
        out.push(t.text.split(/[.[]/)[0]);
    });
    return out;
}

// An expression as words, as HTML. `nameHtml(path)` writes a value's name; the
// spec uses it to tie names set by assign to how they're worked out.
function describe(expr, nameHtml = path => `<span class="sp-name">${escapeHtml(humanizeName(path))}</span>`) {
    const tokens = lexExpression(expr);
    const parts = [];
    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        const prev = tokens[k - 1];
        if (t.kind === 'string') parts.push(`“${escapeHtml(t.text)}”`);
        else if (t.kind === 'number') parts.push(escapeHtml(t.text));
        else if (t.kind === 'word') parts.push(t.text === 'and' || t.text === 'or' ? `<b>${t.text}</b>` : escapeHtml(WORDS[t.text]));
        else if (t.kind === 'op') {
            if (t.text === '|') parts.push(',');
            else if (t.text === ':' || t.text === ',' || t.text === '(' || t.text === ')') continue;
            else if (t.text === '..') parts.push('to');
            else parts.push(WORDS[t.text]);
        } else if (t.kind === 'name') {
            if (prev && prev.kind === 'op' && prev.text === '|') { parts.push(escapeHtml(humanizeName(t.text))); continue; }
            const m = t.text.match(/^(.+)\.(size|first|last)$/);
            if (m && m[2] === 'size') parts.push(`the number of ${nameHtml(m[1])}`);
            else if (m) parts.push(`the ${m[2]} ${nameHtml(m[1])}`);
            else parts.push(nameHtml(t.text));
        } else parts.push(escapeHtml(t.text));
    }
    return parts.join(' ').replace(/ ,/g, ',');
}

// Text with the HTML taken out, as a reader would see it, shortened.
function plainText(html, max = 120) {
    const text = String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const KINDS = {
    rule: { letter: 'R', name: 'Rule' },
    loop: { letter: 'L', name: 'Repeat' },
    optional: { letter: 'O', name: 'Optional' },
    choice: { letter: 'C', name: 'Choice' },
    editor: { letter: 'E', name: 'Fill-in' }
};

function kindOf(node) {
    if (node.type === 'if' || node.type === 'case') return 'rule';
    if (node.type === 'for') return 'loop';
    return KINDS[node.type] ? node.type : null;
}

// Number every block in the order it appears: R1, R2 … for rules, and so on.
// Rules that only set values are numbered too, so a worked-out value can say
// which rule it depends on. Their numbers are skipped in the document (they
// show nothing) but they're in the checklist.
function number(root) {
    const counts = {};
    const walk = nodes => {
        for (const node of nodes) {
            const kind = kindOf(node);
            if (kind) {
                counts[kind] = (counts[kind] || 0) + 1;
                node.kind = kind;
                node.id = KINDS[kind].letter + counts[kind];
            }
            for (const list of childLists(node)) walk(list);
        }
    };
    walk(root.children);
}

function childLists(node) {
    if (node.type === 'if' || node.type === 'case') return node.branches.map(b => b.children);
    if (node.type === 'for') return node.empty ? [node.body, node.empty] : [node.body];
    if (node.type === 'choice') return node.options;
    if (node.children) return [node.children];
    return [];
}

// The parts of a block, each with its own reference: a rule's branches, a
// choice's options, a loop's body and its "none" case. A block with one part
// uses the block's reference for it.
function partsOf(node) {
    const id = n => `${node.id}.${n}`;
    if (node.type === 'if') {
        const many = node.branches.length > 1;
        return node.branches.map((b, k) => ({ id: many ? id(k + 1) : node.id, branch: b, children: b.children, line: b.line }));
    }
    if (node.type === 'case') {
        const many = node.branches.length > 1;
        return node.branches.map((b, k) => ({ id: many ? id(k + 1) : node.id, branch: b, children: b.children, line: b.line }));
    }
    if (node.type === 'for') {
        const parts = [{ id: node.empty ? id(1) : node.id, children: node.body, line: node.line }];
        if (node.empty) parts.push({ id: id(2), empty: true, children: node.empty, line: node.emptyLine });
        return parts;
    }
    if (node.type === 'choice') return node.options.map((o, k) => ({ id: id(k + 1), option: k + 1, children: o, line: node.line }));
    return [{ id: node.id, children: node.children, line: node.line }];
}

// ---------------------------------------------------------------------------
// Worked-out values
// ---------------------------------------------------------------------------

// Every assign and capture, with the conditions it happens under: the rule
// branches, loops, options and choices around it. Then the ones that decide
// something (a rule, a loop, or another such value) or are shown in the
// document get a reference: V1, V2 …
function workOutValues(root, describeCondition) {
    const defs = new Map();
    const used = new Set();
    const walk = (nodes, context) => {
        for (const node of nodes) {
            if (node.type === 'assign' || node.type === 'capture') {
                if (!defs.has(node.name)) defs.set(node.name, []);
                defs.get(node.name).push({ node, context });
            }
            if (node.type === 'if' || node.type === 'case') {
                const subject = node.type === 'case' ? node.subject : '';
                for (const b of node.branches) namesIn(subject + ' ' + b.cond).forEach(n => used.add(n));
            }
            if (node.type === 'for') namesIn(node.collection).forEach(n => used.add(n));
            if (node.type === 'output' && !node.raw) namesIn(node.expr).forEach(n => used.add(n));
            if (!node.kind) {
                if (node.type === 'capture') walk(node.children, context);
                continue;
            }
            for (const part of partsOf(node)) {
                const reads = node.type === 'for' ? namesIn(node.collection)
                    : part.branch ? namesIn(`${node.subject || ''} ${part.branch.cond}`) : [];
                walk(part.children, context.concat({ id: part.id, words: describeCondition(node, part), reads }));
            }
        }
    };
    walk(root.children, []);

    // A value that goes into one that decides something decides it too.
    const queue = [...used];
    while (queue.length) {
        const name = queue.pop();
        for (const def of defs.get(name) || []) {
            const reads = def.node.type === 'assign' ? namesIn(def.node.expr) : [];
            for (const step of def.context) reads.push(...step.reads);
            for (const n of reads) if (!used.has(n)) { used.add(n); queue.push(n); }
        }
    }

    const values = [];
    for (const [name, list] of defs) {
        if (!used.has(name)) continue;
        values.push({ name, defs: list, line: list[0].node.line });
    }
    values.sort((a, b) => a.line - b.line);
    values.forEach((v, k) => { v.id = `V${k + 1}`; });
    return new Map(values.map(v => [v.name, v]));
}

// ---------------------------------------------------------------------------
// Writing the spec
// ---------------------------------------------------------------------------

// Where in the HTML a block sits, from the elements open around it. It decides
// how the block can be marked without breaking the page: a <div> can't go in a
// sentence, a table or a table row, and a browser that meets one there moves
// it, and the content with it, somewhere else.
class OpenElements {
    constructor(stack = []) { this.stack = stack; }
    copy() { return new OpenElements(this.stack.slice()); }
    get top() { return this.stack[this.stack.length - 1] || null; }
    feed(html) {
        const re = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const name = m[2].toLowerCase();
            if (m[1]) {
                const at = this.stack.lastIndexOf(name);
                if (at !== -1) this.stack.length = at;
            } else if (!m[3] && !HTML_VOID_TAGS.has(name)) {
                if (this.top === 'p' && HTML_BLOCK_TAGS.has(name)) this.stack.pop();
                this.stack.push(name);
            }
        }
    }
}

const INLINE_PARENTS = new Set(['p', 'span', 'a', 'b', 'strong', 'i', 'em', 'u', 'small', 'sup', 'sub', 'label', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'li', 'dt', 'dd', 'caption']);
const TABLE_PARENTS = new Set(['table', 'thead', 'tbody', 'tfoot']);
const BLOCK_CONTENT = new RegExp(`<(${[...HTML_BLOCK_TAGS].join('|')})\\b`, 'i');

function hasVisible(html) {
    return /\S/.test(html);
}

// Build the spec for a template. Options:
//   fileName     shown on the cover
//   producedOn   date shown on the cover (a Date), default now
//   revealFile   in VS Code: references become buttons that go to their line
// Returns { body, stats, items, values, stamp }: the spec as HTML for inside a
// page, the counts, every reference in order, and the template's version stamp.
function buildSpec(text, options = {}) {
    const root = parse(tokenize(text));
    number(root);

    const revealFile = options.revealFile || null;
    const items = [];
    const stats = { rules: 0, loops: 0, optionals: 0, choices: 0, options: 0, editors: 0, data: new Set(), unclosed: 0, notes: 0 };

    // How each part is decided, in words. Used for the margin labels, the
    // checklist and the conditions listed under each worked-out value.
    const describeCondition = (node, part, nameHtml) => {
        const d = expr => describe(expr, nameHtml);
        if (node.type === 'if') {
            const b = part.branch;
            if (b.kind === 'if') return { label: 'Shown when', detail: d(b.cond) };
            if (b.kind === 'unless') return { label: 'Shown unless', detail: d(b.cond) };
            if (b.kind === 'elsif') return { label: 'Otherwise, when', detail: d(b.cond) };
            return { label: 'Otherwise', detail: '' };
        }
        if (node.type === 'case') {
            const b = part.branch;
            if (b.kind === 'else') return { label: 'Otherwise', detail: '' };
            const values = b.cond.split(/\s*(?:,|\bor\b)\s*/).filter(Boolean).map(v => d(v)).join(' or ');
            return { label: 'When', detail: `${d(node.subject)} is ${values}` };
        }
        if (node.type === 'for') {
            if (part.empty) return { label: 'When there are none of', detail: d(node.collection.split('|')[0]) };
            return { label: 'Repeats', detail: `for each ${escapeHtml(humanizeName(node.variable))} in ${d(node.collection)}` };
        }
        if (node.type === 'optional') return { label: 'Optional', detail: escapeHtml(node.args.title || humanizeName(node.args.name || node.args.nameVar)) };
        if (node.type === 'choice') return { label: `Option ${part.option}`, detail: '' };
        if (node.type === 'editor') {
            const notes = [];
            if (node.args.lines > 1) notes.push(`${node.args.lines} lines`);
            if (node.args.maxlength !== undefined) notes.push(`up to ${node.args.maxlength} characters`);
            const what = node.args.placeholder || humanizeName(node.args.name || node.args.nameVar);
            return { label: 'Fill in', detail: escapeHtml(what) + (notes.length ? ` <span class="sp-quiet">(${notes.join(', ')})</span>` : '') };
        }
        return { label: '', detail: '' };
    };

    const values = workOutValues(root, (node, part) => describeCondition(node, part));

    // A value's name, tied to how it's worked out when it's one of ours.
    const nameHtml = path => {
        const value = values.get(String(path).split(/[.[]/)[0]);
        const words = `<span class="sp-name">${escapeHtml(humanizeName(path))}</span>`;
        return value ? `${words}<a class="sp-vref" href="#sp-${value.id}">${value.id}</a>` : words;
    };
    const words = (node, part) => describeCondition(node, part, nameHtml);

    const ref = (id, line) => revealFile
        ? `<span class="sp-id diag-goto" role="button" tabindex="0" title="Line ${line} of the template" data-diag-file="${escapeHtml(revealFile)}" data-diag-line="${line}" data-diag-col="1">${id}</span>`
        : `<a class="sp-id" href="#sp-i-${id}">${id}</a>`;

    const render = (nodes, where) => {
        let html = '';
        for (const node of nodes) html += renderNode(node, where);
        return html;
    };

    const renderNode = (node, where) => {
        switch (node.type) {
            case 'text':
                if (!node.raw) where.feed(node.text);
                return node.text;
            case 'output': {
                if (node.raw) return '';
                const tokens = lexExpression(node.expr.split('|')[0]);
                if (tokens.length === 1 && tokens[0].kind === 'string' && !node.expr.includes('|')) return escapeHtml(tokens[0].text);
                const name = tokens.length === 1 && tokens[0].kind === 'name' ? tokens[0].text : '';
                if (name) stats.data.add(name);
                const counted = name.match(/^(.+)\.(size|first|last)$/);
                const label = !name ? 'worked-out value'
                    : counted ? (counted[2] === 'size' ? `the number of ${humanizeName(counted[1])}` : `the ${counted[2]} ${humanizeName(counted[1])}`)
                    : humanizeName(name);
                const value = name && values.get(name.split(/[.[]/)[0]);
                const vref = value ? `<a class="sp-vref" href="#sp-${value.id}">${value.id}</a>` : '';
                return `<span class="sp-data" title="${escapeHtml(node.expr)}">${escapeHtml(label)}</span>${vref}`;
            }
            case 'note':
                stats.notes++;
                return `<div class="sp-note"><span class="sp-note-label">Author note</span> ${escapeHtml(node.text)}</div>`;
            case 'include':
                return node.raw ? '' : `<span class="sp-data">contents of ${escapeHtml(node.args.split(/[\s,]/)[0].replace(/['"]/g, ''))}</span>`;
            case 'assign':
            case 'capture':
                return '';
            default:
                return node.kind ? renderBlock(node, where) : '';
        }
    };

    const renderBlock = (node, where) => {
        const before = where.copy();
        let after = before;
        const parts = partsOf(node).map(part => {
            const inner = before.copy();
            const html = render(part.children, inner);
            after = inner;
            return Object.assign({}, part, { html, words: words(node, part), shown: hasVisible(html) });
        });
        where.stack = after.stack;

        // A branch that shows nothing is left out, so a later "Otherwise" would
        // no longer say what it is otherwise to. Say what it rules out instead.
        if (node.type === 'if' || node.type === 'case') {
            const skipped = [];
            for (const p of parts) {
                const b = p.branch;
                if (skipped.length && (b.kind === 'else' || b.kind === 'elsif')) {
                    const not = `not when ${skipped.join(' <b>or</b> ')}`;
                    p.words = b.kind === 'else'
                        ? { label: 'Otherwise', detail: `(${not})` }
                        : { label: p.words.label, detail: `${p.words.detail} (and ${not})` };
                }
                if (!p.shown && b.kind !== 'else') skipped.push(node.type === 'case' ? describeCondition(node, p, nameHtml).detail : p.words.detail);
            }
        }

        const shown = parts.filter(p => p.shown);
        const item = {
            id: node.id,
            kind: node.kind,
            line: node.line,
            source: node.source || (node.branches && node.branches[0] ? node.branches[0].source : ''),
            title: node.type === 'choice' ? (node.args.title || humanizeName(node.args.name || node.args.nameVar)) : '',
            name: node.args ? (node.args.name || node.args.nameVar || '') : '',
            unclosed: !!node.unclosed,
            parts: parts.map(p => ({ id: p.id, line: p.line, source: p.branch ? p.branch.source : '', words: p.words, shown: p.shown, text: plainText(p.html) }))
        };
        items.push(item);
        // An editor shows a box to type in even with nothing inside it.
        if (node.type === 'editor' && !shown.length) {
            parts[0].html = '';
            parts[0].shown = true;
            item.parts[0].shown = true;
            shown.push(parts[0]);
        }
        if (!shown.length) return '';
        // Inside <style> or <script> it changes how the page looks or works,
        // and there is nowhere to mark it.
        if (node.raw) {
            item.styling = true;
            return shown.map(p => p.html).join('');
        }
        item.shownInDocument = true;
        countShown(node, shown);

        const mode = modeFor(before.top, shown);
        const tag = p => `${ref(p.id, p.line)}<span class="sp-lbl">${p.words.label}</span>${p.words.detail ? ` <span class="sp-det">${p.words.detail}</span>` : ''}`;
        const unclosed = node.unclosed
            ? `<div class="sp-tag sp-unclosed">Not closed: no {% ${END_TAGS[node.tag]} %} was found, so everything after this is inside it</div>`
            : '';
        if (node.unclosed) stats.unclosed++;
        const head = node.type === 'choice'
            ? `<div class="sp-tag sp-head">${ref(node.id, node.line)}<span class="sp-lbl">Choose one</span>${item.title ? ` <span class="sp-det">${escapeHtml(item.title)}</span>` : ''}</div>`
            : '';
        const fill = p => (node.type === 'editor' && !hasVisible(p.html) ? `<span class="sp-fillbox">${escapeHtml(node.args.placeholder || '')}</span>` : p.html);

        if (mode === 'inline') {
            const mark = p => `<sup class="sp-mk" title="${escapeHtml(plainText(p.words.label + ' ' + p.words.detail, 300))}">${p.id}</sup>`;
            const alts = shown.map(p => `<span class="sp-alt">${mark(p)}${fill(p)}</span>`).join('<span class="sp-sep"> / </span>');
            const notClosed = node.unclosed ? `<span class="sp-unclosed">Not closed: no {% ${END_TAGS[node.tag]} %}</span> ` : '';
            return `<span class="sp-inl sp-k-${node.kind}" id="sp-${node.id}">${notClosed}<span class="sp-br">[</span>${alts}<span class="sp-br">]</span></span>`;
        }
        if (mode === 'rows') {
            const row = inner => `<tr class="sp-row sp-k-${node.kind}"><td colspan="100">${inner}</td></tr>`;
            let out = unclosed || head ? row(unclosed + head) : '';
            for (const p of shown) out += row(`<div class="sp-tag">${tag(p)}</div>`) + fill(p);
            return out + `<tr class="sp-row-end sp-k-${node.kind}"><td colspan="100"></td></tr>`;
        }
        if (mode === 'cells') {
            return shown.map(p => fill(p).replace(/<(t[dh])\b([^>]*)>/i, (m, t, attrs) => `<${t}${attrs}><sup class="sp-mk sp-k-${node.kind}" title="${escapeHtml(plainText(p.words.label + ' ' + p.words.detail, 300))}">${p.id}</sup>`)).join('');
        }
        const body = shown.map(p => `<div class="sp-part"><div class="sp-tag">${tag(p)}</div><div class="sp-body">${fill(p)}</div></div>`).join('');
        return `<div class="sp-blk sp-k-${node.kind}${node.unclosed ? ' sp-blk-unclosed' : ''}" id="sp-${node.id}">${unclosed}${head}${body}</div>`;
    };

    const countShown = (node, shown) => {
        if (node.kind === 'rule') stats.rules++;
        else if (node.kind === 'loop') stats.loops++;
        else if (node.kind === 'optional') stats.optionals++;
        else if (node.kind === 'editor') stats.editors++;
        else if (node.kind === 'choice') { stats.choices++; stats.options += shown.length; }
    };

    const modeFor = (parent, shown) => {
        const blocky = shown.some(p => BLOCK_CONTENT.test(p.html));
        if (TABLE_PARENTS.has(parent)) return 'rows';
        if (parent === 'tr') return shown.every(p => /<t[dh]\b/i.test(p.html)) ? 'cells' : 'inline';
        if (INLINE_PARENTS.has(parent) && !blocky) return 'inline';
        return 'block';
    };

    let documentHtml = render(root.children, new OpenElements());
    items.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));

    // Headings for the contents, each given an anchor to link to.
    const headings = [];
    documentHtml = documentHtml.replace(/<h([1-3])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (whole, level, attrs, inner) => {
        const title = plainText(inner.replace(/<sup class="sp-mk"[^>]*>[^<]*<\/sup>/g, '').replace(/<a class="sp-vref"[^>]*>[^<]*<\/a>/g, ''), 90);
        if (!title) return whole;
        headings.push({ level: Number(level), title, anchor: `sp-h-${headings.length + 1}` });
        return `<h${level}${attrs}><span class="sp-anchor" id="${headings[headings.length - 1].anchor}"></span>${inner}</h${level}>`;
    });

    const stamp = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
    const lines = text.split('\n').length;
    const producedOn = options.producedOn || new Date();

    const body = cover({ fileName: options.fileName || '', stamp, lines, producedOn, stats, headings, items, values })
        + `<section class="sp-document" id="sp-document">${documentHtml}</section>`
        + checklist(items, nameHtml, ref)
        + workedOut(values, nameHtml);

    return { body, stats: Object.assign({}, stats, { data: stats.data.size }), items, values: [...values.values()], stamp, headings };
}

function joinWithAnd(parts) {
    return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function cover({ fileName, stamp, lines, producedOn, stats, headings, items, values }) {
    const parts = [];
    if (stats.rules) parts.push(pluralize(stats.rules, 'rule that decides', 'rules that decide') + ' what is shown from the case data');
    if (stats.loops) parts.push(pluralize(stats.loops, 'repeating section'));
    if (stats.choices) parts.push(`${pluralize(stats.choices, 'choice')} for the adviser (${pluralize(stats.options, 'option')} in all)`);
    if (stats.optionals) parts.push(pluralize(stats.optionals, 'optional section'));
    if (stats.editors) parts.push(pluralize(stats.editors, 'fill-in field'));
    if (stats.data.size) parts.push(pluralize(stats.data.size, 'value') + ' filled in from the case data');
    const summary = parts.length
        ? `This document has ${joinWithAnd(parts)}.`
        : 'Nothing in this document varies: it always reads as shown.';
    const hidden = items.filter(i => !i.shownInDocument && !i.styling && i.kind !== 'editor').length;
    const unclosed = stats.unclosed
        ? `<p class="sp-warning">${pluralize(stats.unclosed, 'section is', 'sections are')} missing an end tag, so the template is broken and everything after ${stats.unclosed === 1 ? 'it' : 'them'} is drawn inside. Look for “Not closed” below.</p>`
        : '';
    const date = producedOn.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const toc = [`<li><a href="#sp-document">The document</a>`];
    if (headings.length) {
        toc.push('<ol class="sp-toc-sub">' + headings.map(h => `<li class="sp-toc-l${h.level}"><a href="#${h.anchor}">${escapeHtml(h.title)}</a></li>`).join('') + '</ol>');
    }
    toc.push('</li>');
    if (items.length) toc.push(`<li><a href="#sp-checklist">Checklist of every variable part</a></li>`);
    if (values.size) toc.push(`<li><a href="#sp-values">How values are worked out</a></li>`);

    return `<section class="sp-cover">
<div class="sp-kicker">Template specification</div>
<h1 class="sp-title">${escapeHtml(fileName || 'Template')}</h1>
<table class="sp-meta"><tr><th>Version</th><td><code>${stamp}</code> · ${lines.toLocaleString('en-GB')} lines</td></tr><tr><th>Produced</th><td>${escapeHtml(date)}</td></tr></table>
<p class="sp-summary">${summary}${hidden ? ` ${pluralize(hidden, 'more rule or repeat', 'more rules and repeats')} only work${hidden === 1 ? 's' : ''} out values and show${hidden === 1 ? 's' : ''} nothing ${hidden === 1 ? 'itself; it is' : 'themselves; they are'} in the checklist.` : ''}</p>
${unclosed}
<div class="sp-key">
<div class="sp-key-head">How to read it</div>
<p>Every part of the document that can change is marked in the margin, or in brackets inside a sentence, with a reference like <span class="sp-id-plain">R4.2</span>. Quote the reference to ask for a change.</p>
<div class="sp-key-grid">
<span class="sp-swatch sp-k-rule">R</span><span><b>Rule</b>: shown automatically when the case data meets the condition.</span>
<span class="sp-swatch sp-k-loop">L</span><span><b>Repeat</b>: shown once for each item in a list.</span>
<span class="sp-swatch sp-k-choice">C</span><span><b>Choice</b>: the adviser picks exactly one option.</span>
<span class="sp-swatch sp-k-optional">O</span><span><b>Optional</b>: the adviser ticks to include it.</span>
<span class="sp-swatch sp-k-editor">E</span><span><b>Fill-in</b>: the adviser types this.</span>
<span class="sp-swatch sp-k-value">V</span><span><b>Worked-out value</b>: calculated from the case data; see the last section.</span>
<span><span class="sp-data">client name</span></span><span>Filled in from the case data.</span>
<span><span class="sp-inl sp-k-rule"><span class="sp-br">[</span><span class="sp-alt"><sup class="sp-mk">R2.1</sup>his</span><span class="sp-sep"> / </span><span class="sp-alt"><sup class="sp-mk">R2.2</sup>her</span><span class="sp-br">]</span></span></span><span>Alternatives inside a sentence.</span>
</div>
<p class="sp-quiet">References are numbered in the order they appear in this version. Adding a rule renumbers those after it, so quote the version above with them.</p>
</div>
<nav class="sp-toc"><div class="sp-key-head">Contents</div><ol>${toc.join('')}</ol></nav>
</section>`;
}

function checklist(items, nameHtml, ref) {
    if (!items.length) return '';
    const rows = [];
    for (const item of items) {
        const kind = KINDS[item.kind].name;
        const headWords = item.kind === 'choice'
            ? `Choose one${item.title ? `: ${escapeHtml(item.title)}` : ''}`
            : '';
        const state = item.unclosed ? ' <span class="sp-flag">not closed</span>' : '';
        const many = item.parts.length > 1 || item.kind === 'choice';
        if (many) {
            rows.push(`<tr class="sp-ck-group" id="sp-i-${item.id}"><td class="sp-ck-id">${ref(item.id, item.line)}</td><td>${kind}</td><td>${headWords || (item.kind === 'rule' ? 'One of:' : item.kind === 'loop' ? 'Repeats, or when there are none:' : '')}${state}</td><td class="sp-ck-src"><code>${escapeHtml(sourceOf(item.source))}</code><span class="sp-ck-line">line ${item.line}</span></td><td class="sp-ck-tick"></td></tr>`);
        }
        for (const part of item.parts) {
            const what = `<span class="sp-lbl">${part.words.label}</span>${part.words.detail ? ` ${part.words.detail}` : ''}`;
            const shows = item.styling
                ? '<div class="sp-ck-text sp-quiet">Changes how the page looks (in its styles), so it isn’t marked in the document</div>'
                : part.shown
                ? (part.text ? `<div class="sp-ck-text">“${escapeHtml(part.text)}”</div>` : '')
                : `<div class="sp-ck-text sp-quiet">${item.kind === 'rule' || item.kind === 'loop' ? 'Shows nothing; only works out values' : 'Shows nothing'}</div>`;
            const src = many ? (part.source ? `<code>${escapeHtml(sourceOf(part.source))}</code>` : '') : `<code>${escapeHtml(sourceOf(item.source))}</code>`;
            rows.push(`<tr class="${many ? 'sp-ck-part' : ''}"${many ? ` id="sp-i-${part.id}"` : ` id="sp-i-${item.id}"`}><td class="sp-ck-id">${ref(part.id, part.line)}</td><td>${many ? '' : kind}</td><td>${what}${many ? '' : state}${shows}</td><td class="sp-ck-src">${src}<span class="sp-ck-line">line ${part.line}</span></td><td class="sp-ck-tick"></td></tr>`);
        }
    }
    return `<section class="sp-appendix" id="sp-checklist">
<h2 class="sp-h">Checklist of every variable part</h2>
<p class="sp-quiet">In the order they appear. Tick each one once you've checked it does what it should, and note any change against its reference.</p>
<table class="sp-ck"><thead><tr><th>Ref</th><th>Type</th><th>What decides it, and what it shows</th><th>In the template</th><th>Checked / comments</th></tr></thead><tbody>${rows.join('')}</tbody></table>
</section>`;
}

// A tag's source shortened to fit a table cell.
function sourceOf(source) {
    const s = String(source || '').replace(/\s+/g, ' ').trim();
    return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

function workedOut(values, nameHtml) {
    if (!values.size) return '';
    const entries = [...values.values()].map(value => {
        const defs = value.defs.map(({ node, context }) => {
            const what = node.type === 'assign'
                ? `set to ${describe(node.expr, nameHtml) || '<i>nothing</i>'}`
                : `set to the text “${escapeHtml(plainText(node.children.filter(c => c.type === 'text' || c.type === 'output').map(c => c.type === 'text' ? c.text : `[${humanizeName(c.expr.split('|')[0].trim())}]`).join(''), 140))}”`;
            const when = context.length
                ? context.map(step => `<span class="sp-step"><span class="sp-id-plain">${step.id}</span> ${step.words.label.toLowerCase()}${step.words.detail ? ` ${step.words.detail}` : ''}</span>`).join('<span class="sp-then"> › </span>')
                : 'always';
            return `<li><span class="sp-ck-line">line ${node.line}</span> ${what} <span class="sp-when">when: ${when}</span><div><code>${escapeHtml(sourceOf(node.source || `{% capture ${node.name} %}`))}</code></div></li>`;
        }).join('');
        return `<div class="sp-val" id="sp-${value.id}"><div class="sp-val-head"><span class="sp-swatch sp-k-value">${value.id}</span> <b>${escapeHtml(humanizeName(value.name))}</b> <code>${escapeHtml(value.name)}</code></div><ul>${defs}</ul></div>`;
    }).join('');
    return `<section class="sp-appendix" id="sp-values">
<h2 class="sp-h">How values are worked out</h2>
<p class="sp-quiet">Values the template calculates for itself and then uses to decide what to show. Each is listed with every place it is set, in template order, and the conditions it is set under: <span class="sp-id-plain">L2</span> › <span class="sp-id-plain">R5.1</span> means inside repeat L2, when rule R5.1 applies. Where it's set more than once, the last one that happens wins.</p>
${entries}
</section>`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const SPEC_STYLES = `
  .sp-cover, .sp-appendix, .sp-tag, .sp-key, .sp-toc, .sp-note, .sp-mk, .sp-ck { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  .sp-cover, .sp-appendix, .sp-document { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sp-k-rule { --sp: #6a1b9a; --sp-tint: #f6eef9; }
  .sp-k-loop { --sp: #00695c; --sp-tint: #e8f4f2; }
  .sp-k-choice { --sp: #1565c0; --sp-tint: #ebf3fc; }
  .sp-k-optional { --sp: #2e7d32; --sp-tint: #edf6ed; }
  .sp-k-editor { --sp: #c25e00; --sp-tint: #fff4e5; }
  .sp-k-value { --sp: #546e7a; --sp-tint: #eef2f4; }

  .sp-cover { color: #222; border-bottom: 1px solid #ddd; padding-bottom: 18px; margin-bottom: 24px; }
  .sp-kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #666; }
  .sp-cover h1.sp-title { font-size: 26px; margin: 2px 0 10px; color: #111; }
  table.sp-meta { border-collapse: collapse; font-size: 13px; margin: 0 0 10px; }
  table.sp-meta th { text-align: left; font-weight: 600; color: #555; padding: 1px 14px 1px 0; border: none; background: none; }
  table.sp-meta td { padding: 1px 0; border: none; background: none; }
  .sp-summary { font-size: 14px; line-height: 1.5; max-width: 60em; }
  .sp-warning { color: #b71c1c; background: #ffebee; border-left: 3px solid #c62828; padding: 6px 10px; font-size: 13px; }
  .sp-key, .sp-toc { font-size: 13px; line-height: 1.45; margin-top: 14px; max-width: 60em; }
  .sp-key-head { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #555; margin-bottom: 4px; }
  .sp-key p { margin: 4px 0 8px; }
  .sp-key-grid { display: grid; grid-template-columns: max-content 1fr; gap: 5px 10px; align-items: center; }
  .sp-key-grid > * { justify-self: start; }
  .sp-swatch { display: inline-block; min-width: 1.6em; text-align: center; font: 700 11px/1.6 ui-monospace, Menlo, Consolas, monospace; color: #fff; background: var(--sp); border-radius: 3px; padding: 0 4px; }
  .sp-toc ol { margin: 4px 0; padding-left: 20px; }
  .sp-toc-sub { list-style: none; padding-left: 12px !important; }
  .sp-toc-l2 { padding-left: 12px; } .sp-toc-l3 { padding-left: 24px; font-size: 12px; }
  .sp-toc a { color: #1a4f8b; text-decoration: none; }
  .sp-quiet { color: #666; font-size: 12px; }

  .sp-blk { border-left: 3px solid var(--sp); padding: 0 0 0 10px; margin: 8px 0 8px 0; }
  .sp-part + .sp-part { border-top: 1px dashed var(--sp); margin-top: 6px; padding-top: 4px; }
  .sp-tag { font-size: 11.5px; line-height: 1.5; color: var(--sp); margin: 2px 0 3px; break-after: avoid; page-break-after: avoid; }
  .sp-tag .sp-lbl { font-weight: 700; }
  .sp-tag .sp-det { color: #333; }
  .sp-id, .sp-id-plain { display: inline-block; font: 700 11px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #fff; background: var(--sp, #546e7a); border-radius: 3px; padding: 0 5px; margin-right: 6px; text-decoration: none; }
  .sp-id-plain { background: #546e7a; }
  .sp-id.diag-goto { cursor: pointer; }
  .sp-id.diag-goto:hover { filter: brightness(1.2); }
  .sp-head { margin-bottom: 4px; }
  .sp-unclosed { color: #b71c1c; font-weight: 700; }
  .sp-blk-unclosed { border-left-style: double; border-left-width: 5px; }
  .sp-name { font-style: italic; }
  .sp-vref, .sp-mk { font: 700 9px/1 ui-monospace, Menlo, Consolas, monospace; vertical-align: super; margin-left: 1px; text-decoration: none; }
  .sp-vref { color: #546e7a; }
  .sp-mk { color: var(--sp); margin: 0 2px 0 0; }
  .sp-inl { background: var(--sp-tint); border-radius: 3px; padding: 0 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .sp-br, .sp-sep { color: var(--sp); font-weight: 700; }
  .sp-row td { padding: 3px 6px !important; background: var(--sp-tint) !important; border-left: 3px solid var(--sp) !important; }
  .sp-row-end td { padding: 0 !important; height: 2px; background: var(--sp) !important; border: none !important; }
  .sp-data { background: #eceff1; border-bottom: 1px dotted #78909c; border-radius: 3px; padding: 0 4px; color: #37474f; font-style: italic; }
  .sp-fillbox { display: inline-block; min-width: 14em; min-height: 1.4em; border: 1px dashed #c25e00; background: #fff4e5; color: #8a5a2b; font-style: italic; padding: 1px 6px; border-radius: 3px; }
  .sp-note { font-size: 12px; color: #555; background: #f5f5f5; border-left: 3px solid #9e9e9e; padding: 3px 8px; margin: 6px 0; font-style: italic; }
  .sp-note-label { font-style: normal; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: .05em; color: #777; }
  body:has(#sp-hide-notes:checked) .sp-note { display: none; }

  .sp-appendix { color: #222; margin-top: 32px; border-top: 1px solid #ddd; padding-top: 12px; }
  .sp-appendix h2.sp-h { font-size: 20px; margin: 0 0 4px; color: #111; }
  table.sp-ck { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.4; margin-top: 10px; }
  table.sp-ck th { text-align: left; background: #f3f3f3; border-bottom: 2px solid #ccc; padding: 4px 6px; font-weight: 700; color: #333; }
  table.sp-ck td { border: none; border-bottom: 1px solid #e3e3e3; padding: 4px 6px; vertical-align: top; background: none; }
  table.sp-ck thead { display: table-header-group; }
  table.sp-ck tr { break-inside: avoid; page-break-inside: avoid; }
  .sp-ck-group td { border-bottom: none !important; padding-bottom: 0 !important; font-weight: 600; }
  .sp-ck-part td:first-child { padding-left: 18px; }
  .sp-ck-id { white-space: nowrap; }
  .sp-ck-id .sp-id { --sp: #546e7a; }
  .sp-ck-src { width: 30%; color: #555; }
  .sp-ck-src code { font-size: 10.5px; word-break: break-word; }
  .sp-ck-line { display: block; color: #888; font-size: 10.5px; }
  .sp-ck-text { color: #555; margin-top: 2px; }
  .sp-ck-tick { width: 18%; border-left: 1px solid #e3e3e3 !important; }
  .sp-flag { color: #b71c1c; font-weight: 700; }
  .sp-val { margin: 12px 0; break-inside: avoid; page-break-inside: avoid; font-size: 13px; }
  .sp-val ul { margin: 4px 0 0; padding-left: 20px; }
  .sp-val li { margin: 3px 0; }
  .sp-val code { font-size: 11px; color: #555; }
  .sp-when { color: #444; }
  .sp-step .sp-id-plain { font-size: 10px; margin-right: 3px; }
  .sp-then { color: #999; }

  .sp-toolbar { position: sticky; top: 0; z-index: 9000; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; background: #fff; margin: -8px -8px 12px; padding: 8px 10px; border-bottom: 1px solid #e0e0e0; font: 12px system-ui, sans-serif; color: #444; }
  .sp-toolbar label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .sp-toolbar button { font: 12px system-ui, sans-serif; color: #222; background: #f3f3f3; border: 1px solid #ccc; border-radius: 3px; padding: 2px 10px; cursor: pointer; }
  .sp-toolbar button:hover { background: #e8e8e8; }
  .sp-toolbar .sp-push { margin-left: auto; }

  @page { margin: 16mm 14mm; }
  @media print {
    .sp-toolbar { display: none !important; }
    .sp-cover { break-after: page; page-break-after: always; border: none; }
    .sp-appendix { break-before: page; page-break-before: always; border: none; margin-top: 0; }
    a { color: inherit; }
    .sp-document h1, .sp-document h2, .sp-document h3, .sp-document h4 { break-after: avoid; page-break-after: avoid; }
  }`;

// The spec as a file of its own, to open in a browser and print to PDF. The
// template's own stylesheets go in too, so the document looks as it will.
function standaloneSpec(spec, { fileName = '', css = '' } = {}) {
    const notes = spec.stats.notes
        ? `<label><input type="checkbox" id="sp-hide-notes"> Hide ${pluralize(spec.stats.notes, 'author note')}</label>`
        : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spec: ${escapeHtml(fileName)} (${spec.stamp})</title>
<style>
${css}
</style>
<style>
  body { background: white; color: black; margin: 0 auto; padding: 8px 16px 32px; max-width: 1000px; box-sizing: border-box; }${SPEC_STYLES}
</style>
</head>
<body>
<div class="sp-toolbar">${notes}<button type="button" class="sp-push" onclick="window.print()">Print or save as PDF</button></div>
${spec.body}
</body>
</html>`;
}

module.exports = {
    tokenize,
    parse,
    describe,
    humanizeName,
    namesIn,
    buildSpec,
    standaloneSpec,
    stripLiquidInsideHtmlTag,
    matchHtmlTag,
    SPEC_STYLES
};
