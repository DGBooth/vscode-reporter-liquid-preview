// Checks: small, named assertions about parts of a case's output.
//
// A golden file says "the whole output is exactly this", and fails on any
// change at all. A check says one thing — the heading names the customer, there
// is a row per item, the total reads 1,292.50 — and fails only when that thing
// changes. Each is reported on its own, so a failure names what broke.
//
// A check can target part of the output with a CSS selector. The output is
// parsed with parse5, the HTML parser that follows the spec browsers do, so a
// selector matches the tree the preview actually shows: markup a browser would
// move or close (text inside a <table>, a <div> inside a <p>) is moved or
// closed here too. The parser is only loaded when a case has checks.

// ---- parsing ------------------------------------------------------------------

const ASSERTIONS = ['exists', 'count', 'text', 'contains', 'notContains', 'attributes'];
// These read the matched elements, so they need a selector to say which.
const NEEDS_SELECTOR = ['exists', 'count', 'text', 'attributes'];

// Turn a case's "checks" array into checks, each with its problems recorded on
// it rather than thrown, so one bad check doesn't stop the others. `lineOf`
// finds the line a check's name is on, for jumping to it.
function parseChecks(raw, lineOf = () => null) {
    if (raw === undefined || raw === null) return { checks: [], error: null };
    if (!Array.isArray(raw)) return { checks: [], error: '"checks" must be a list.' };

    const seen = new Map();
    const checks = raw.map((item, index) => {
        const c = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
        let name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : `check ${index + 1}`;
        const count = (seen.get(name) || 0) + 1;
        seen.set(name, count);
        if (count > 1) name = `${name} (${count})`;

        const check = {
            name,
            line: lineOf(typeof c.name === 'string' ? c.name : null),
            selector: typeof c.selector === 'string' ? c.selector.trim() : null,
            error: null
        };
        for (const key of ASSERTIONS) if (c[key] !== undefined) check[key] = c[key];
        check.error = validate(c, check);

        // A selector alone asks whether anything matches it.
        if (!check.error && check.selector && !ASSERTIONS.some(key => check[key] !== undefined)) check.exists = true;
        return check;
    });
    return { checks, error: null };
}

function validate(raw, check) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'A check must be an object.';
    if (raw.selector !== undefined && (typeof raw.selector !== 'string' || !raw.selector.trim())) return '"selector" must be a CSS selector.';
    if (!check.selector && !ASSERTIONS.some(key => raw[key] !== undefined)) return 'A check needs a "selector", or something to check such as "contains".';
    const needs = NEEDS_SELECTOR.filter(key => raw[key] !== undefined && !check.selector);
    if (needs.length) return `"${needs[0]}" checks the elements a "selector" matches, so it needs one.`;
    if (raw.exists !== undefined && typeof raw.exists !== 'boolean') return '"exists" must be true or false.';
    if (raw.count !== undefined && !(Number.isInteger(raw.count) && raw.count >= 0)) return '"count" must be a whole number.';
    if (raw.exists !== undefined && raw.count !== undefined) return 'Use "exists" or "count", not both.';
    for (const key of ['text', 'contains', 'notContains']) {
        const v = raw[key];
        if (v !== undefined && typeof v !== 'string' && !(Array.isArray(v) && v.every(s => typeof s === 'string'))) {
            return `"${key}" must be text or a list of text.`;
        }
    }
    if (raw.attributes !== undefined) {
        const a = raw.attributes;
        if (!a || typeof a !== 'object' || Array.isArray(a)) return '"attributes" must map attribute names to a value, true (present) or false (absent).';
        for (const [name, value] of Object.entries(a)) {
            if (typeof value !== 'string' && typeof value !== 'boolean') return `Attribute "${name}" must be a value, true (present) or false (absent).`;
        }
    }
    return null;
}

// ---- running ------------------------------------------------------------------

// The rendered output, parsed on first use: queried by selector, or read
// whole as the page's text.
function queryable(html) {
    let fragment = null;
    // Parsed as the content of a <div>, which is where the preview puts it:
    // the context decides what survives (a stray <tr> is dropped in a div,
    // kept in a <template>, parse5's default).
    const parsed = () => {
        if (!fragment) {
            const { parse5, adapter } = domLibraries();
            const context = parse5.parseFragment('<div></div>', { treeAdapter: adapter }).children[0];
            fragment = parse5.parseFragment(context, html, { treeAdapter: adapter });
        }
        return fragment;
    };
    return {
        select: selector => domLibraries().CSSselect.selectAll(selector, parsed()),
        text: () => textOf(parsed())
    };
}

let _dom = null;
function domLibraries() {
    if (!_dom) {
        _dom = {
            parse5: require('parse5'),
            adapter: require('parse5-htmlparser2-tree-adapter').adapter,
            CSSselect: require('css-select')
        };
    }
    return _dom;
}

// An element's text as a reader sees it: entities decoded, a break between
// blocks and table cells (raw textContent would run "Engine" and "1,250.50"
// in adjacent cells together as "Engine1,250.50"), script and style left out,
// and runs of whitespace collapsed so indentation in the template doesn't
// matter. Close to what a browser's innerText gives, minus layout.
const BREAKS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'label', 'legend',
    'li', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const SILENT = new Set(['script', 'style', 'template', 'noscript']);

function textOf(node) {
    const parts = [];
    const walk = n => {
        if (n.type === 'text') { parts.push(n.data); return; }
        if (n.type === 'comment' || n.type === 'directive') return;
        if (!n.children || SILENT.has(n.name)) return;
        const breaks = BREAKS.has(n.name);
        if (breaks) parts.push(' ');
        for (const child of n.children) walk(child);
        if (breaks) parts.push(' ');
    };
    walk(node);
    return tidy(parts.join(''));
}

function tidy(text) {
    return String(text).replace(/\s+/g, ' ').trim();
}

// Run every check against one render. Each comes back passed or failed with
// its reasons; a check that is itself malformed fails with what's wrong with it.
function runChecks(checks, html) {
    const output = queryable(html);
    return checks.map(check => {
        const result = { name: check.name, line: check.line, status: 'passed', failures: [] };
        const fail = message => { result.failures.push(message); };
        if (check.error) {
            fail(check.error);
        } else {
            try {
                judge(check, html, output, fail);
            } catch (err) {
                fail(check.selector ? `The selector "${check.selector}" is not valid CSS: ${err.message}` : err.message);
            }
        }
        if (result.failures.length) result.status = 'failed';
        return result;
    });
}

// Record why a check fails, or nothing if it passes. Every assertion is judged,
// so a check with two wrong things says both.
function judge(check, html, output, fail) {
    const quote = s => `“${s}”`;

    if (!check.selector) {
        // No selector: the page's text, as a reader sees it. Not the HTML — a
        // check that "the page doesn't mention Smith & Co" must not pass just
        // because the HTML spells it "Smith &amp; Co".
        const page = output.text();
        for (const needle of toList(check.contains)) if (!page.includes(tidy(needle))) fail(`The page should mention ${quote(needle)}.`);
        for (const needle of toList(check.notContains)) if (page.includes(tidy(needle))) fail(`The page should not mention ${quote(needle)}.`);
        return;
    }

    const matches = output.select(check.selector);
    const found = `“${check.selector}” matched ${matches.length === 0 ? 'nothing' : matches.length === 1 ? '1 element' : `${matches.length} elements`}`;

    if (check.exists === true && matches.length === 0) return fail(`${found}; expected at least one.`);
    if (check.exists === false && matches.length > 0) fail(`${found}; expected none.`);
    if (check.count !== undefined && matches.length !== check.count) {
        fail(`${found}; expected ${check.count}.`);
    }

    // Text and attribute checks read the matched elements, so there must be
    // some — and for a single expected value, exactly one, or which element is
    // meant would be a guess.
    const readsElements = check.text !== undefined || check.attributes !== undefined
        || check.contains !== undefined || check.notContains !== undefined;
    if (!readsElements) return;
    if (matches.length === 0) {
        if (check.notContains !== undefined && check.text === undefined && check.attributes === undefined && check.contains === undefined) return;
        return fail(`${found}, so there is no text to check.`);
    }

    if (check.text !== undefined) {
        const texts = matches.map(textOf);
        if (Array.isArray(check.text)) {
            const expected = check.text.map(tidy);
            if (texts.length !== expected.length) {
                fail(`${found}, but ${expected.length} ${expected.length === 1 ? 'text was' : 'texts were'} given.`);
            }
            expected.forEach((want, i) => {
                if (i < texts.length && texts[i] !== want) fail(`Element ${i + 1} reads ${quote(texts[i])}; expected ${quote(want)}.`);
            });
        } else if (matches.length > 1) {
            fail(`${found}, so it's unclear which one "text" means. Narrow the selector, or give "text" as a list with one entry per element.`);
        } else if (texts[0] !== tidy(check.text)) {
            fail(`It reads ${quote(texts[0])}; expected ${quote(tidy(check.text))}.`);
        }
    }

    const combined = matches.map(textOf).join(' ');
    for (const needle of toList(check.contains)) {
        if (!combined.includes(tidy(needle))) fail(`The text of ${quote(check.selector)} should contain ${quote(needle)}; it reads ${quote(snip(combined))}.`);
    }
    for (const needle of toList(check.notContains)) {
        if (combined.includes(tidy(needle))) fail(`The text of ${quote(check.selector)} should not contain ${quote(needle)}.`);
    }

    if (check.attributes !== undefined) {
        if (matches.length > 1) {
            fail(`${found}, so it's unclear which one "attributes" means. Narrow the selector.`);
        } else {
            const attribs = matches[0].attribs || {};
            for (const [name, want] of Object.entries(check.attributes)) {
                const has = Object.prototype.hasOwnProperty.call(attribs, name);
                if (want === true && !has) fail(`It has no ${quote(name)} attribute; expected one.`);
                else if (want === false && has) fail(`It has a ${quote(name)} attribute; expected none.`);
                else if (typeof want === 'string') {
                    if (!has) fail(`It has no ${quote(name)} attribute; expected ${name}=${quote(want)}.`);
                    else if (attribs[name] !== want) fail(`Its ${quote(name)} is ${quote(attribs[name])}; expected ${quote(want)}.`);
                }
            }
        }
    }
}

function toList(value) {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

function snip(text) {
    return text.length > 80 ? text.slice(0, 79) + '…' : text;
}

// Output as the preview should display it: parsed exactly as the checks parse
// it — a fragment inside a <div> — and written back out, so every element it
// opens is closed and every stray closing tag is gone. Put straight into a page,
// raw output with a stray </div> would close the preview's own container and
// cut the rest of the document loose: laid out outside the template's sections,
// and out of reach of the test builder, which only looks inside the container.
// It would also disagree with the checks, which never see that tree. The
// displayed document and the checked one are the same tree this way.
function asPreviewShowsIt(html) {
    const { parse5, adapter } = domLibraries();
    const context = parse5.parseFragment('<div></div>', { treeAdapter: adapter }).children[0];
    const fragment = parse5.parseFragment(context, String(html), { treeAdapter: adapter });
    return parse5.serialize(fragment, { treeAdapter: adapter });
}

module.exports = { parseChecks, runChecks, asPreviewShowsIt };
