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
// Every key a check is written with, in the order it's written. Saving a check
// keeps these and nothing else (template-tests' tidyCheck), so a key missing
// here is silently dropped from saved checks: add new keys here first.
const CHECK_KEYS = ['name', 'selector', 'tableWith', 'row'].concat(ASSERTIONS);
// These read particular elements, so they need a "selector" or a "row" to say which.
const NEEDS_SELECTOR = ['exists', 'count', 'text', 'attributes'];

// A row check finds a table row by its label, the text of its first cell,
// and checks the cell beside it: "the value in the row labelled Plan name".
// Reports are full of label/value tables, and a label stays put when a table
// is added above it or a row is inserted, where a position like "2nd row,
// 2nd cell" doesn't. "Plan name" and "Plan name:" are the same label.
function tidyLabel(text) {
    return tidy(text).replace(/\s*:$/, '');
}

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
            index,
            line: lineOf(typeof c.name === 'string' ? c.name : null),
            selector: typeof c.selector === 'string' ? c.selector.trim() : null,
            row: typeof c.row === 'string' && tidyLabel(c.row) ? tidyLabel(c.row) : null,
            tableWith: typeof c.tableWith === 'string' && tidyLabel(c.tableWith) ? tidyLabel(c.tableWith) : null,
            error: null
        };
        for (const key of ASSERTIONS) if (c[key] !== undefined) check[key] = c[key];
        check.error = validate(c, check);

        // A selector or row alone asks whether anything matches it.
        if (!check.error && (check.selector || check.row) && !ASSERTIONS.some(key => check[key] !== undefined)) check.exists = true;
        return check;
    });
    return { checks, error: null };
}

function validate(raw, check) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'A check must be an object.';
    if (raw.selector !== undefined && (typeof raw.selector !== 'string' || !raw.selector.trim())) return '"selector" must be a CSS selector.';
    if (raw.row !== undefined && (typeof raw.row !== 'string' || !tidyLabel(raw.row))) return '"row" must be the label a table row starts with, e.g. "Plan name".';
    if (raw.tableWith !== undefined && (typeof raw.tableWith !== 'string' || !tidyLabel(raw.tableWith))) return '"tableWith" must be the label of another row in the table, e.g. "Crystallisation amount".';
    if (raw.tableWith !== undefined && !check.row) return '"tableWith" narrows a "row" check to one table, so it needs a "row" too.';
    if (!check.selector && !check.row && !ASSERTIONS.some(key => raw[key] !== undefined)) return 'A check needs a "selector" or a "row", or something to check such as "contains".';
    const needs = NEEDS_SELECTOR.filter(key => raw[key] !== undefined && !check.selector && !check.row);
    if (needs.length) return `"${needs[0]}" checks the elements a "selector" or "row" picks out, so it needs one.`;
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
        root: parsed,
        text: () => textOf(parsed())
    };
}

// The elements a check looks at: what its selector matches, or — for a row
// check — the value cell of every row with its label, within what the
// selector matches if it has one. In page order, each once.
function targetsOf(check, output) {
    let scopes = check.selector ? output.select(check.selector) : null;
    if (!check.row) return scopes;
    // "tableWith": only tables that also have a row with that label — how a
    // check says "the Plan name in this table" without a position.
    if (check.tableWith) {
        const tables = [];
        for (const scope of scopes || [output.root()]) {
            for (const table of descendants(scope, 'table')) {
                if (!tables.includes(table) && labelledRows(table, check.tableWith).length) tables.push(table);
            }
        }
        scopes = tables;
    }
    const values = [];
    for (const scope of scopes || [output.root()]) {
        for (const cells of labelledRows(scope, check.row)) {
            if (!values.includes(cells[1])) values.push(cells[1]);
        }
    }
    return values;
}

// `scope` and everything in it named `name`, in page order.
function descendants(scope, name) {
    const found = domLibraries().CSSselect.selectAll(name, scope);
    if (scope.name === name) found.unshift(scope);
    return found;
}

// The cells of each row in `scope` whose first cell is labelled `label`.
function labelledRows(scope, label) {
    const out = [];
    for (const tr of descendants(scope, 'tr')) {
        const cells = (tr.children || []).filter(n => n.name === 'td' || n.name === 'th');
        if (cells.length >= 2 && tidyLabel(textOf(cells[0])) === label) out.push(cells);
    }
    return out;
}

// A parsed check as it would be written in a suite: its name, what it looks
// at and what it expects, without the fields parsing adds or leaves empty.
function asWritten(check) {
    const out = { name: check.name };
    if (check.selector) out.selector = check.selector;
    if (check.tableWith) out.tableWith = check.tableWith;
    if (check.row) out.row = check.row;
    for (const key of ASSERTIONS) if (check[key] !== undefined) out[key] = check[key];
    return out;
}

// How a failure names what the check looked at.
function describeTarget(check, count) {
    if (!check.row) return `\u201c${check.selector}\u201d matched ${count === 0 ? 'nothing' : count === 1 ? '1 element' : `${count} elements`}`;
    const where = (check.selector ? ` in \u201c${check.selector}\u201d` : '')
        + (check.tableWith ? ` in a table with a \u201c${check.tableWith}\u201d row` : '');
    if (count === 0) return `No row${where} is labelled \u201c${check.row}\u201d`;
    return `${count === 1 ? '1 row' : `${count} rows`}${where} ${count === 1 ? 'is' : 'are'} labelled \u201c${check.row}\u201d`;
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
        const result = {
            name: check.name,
            index: check.index,
            line: check.line,
            status: 'passed',
            failures: [],
            // Whether "accept the new result" can mean something for it: a
            // check with a value to update, as opposed to one looking for a
            // phrase, where there is no single right replacement.
            canAccept: !check.error && acceptable(check)
        };
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
        // Offer "Accept new result" only where accepting would work: a check
        // whose target is now ambiguous (it matches two elements) has no
        // single new value, and a button that can only fail is noise.
        if (result.status === 'failed' && result.canAccept) result.canAccept = !acceptCheck(asWritten(check), html).error;
        return result;
    });
}

// Record why a check fails, or nothing if it passes. Every assertion is judged,
// so a check with two wrong things says both.
function judge(check, html, output, fail) {
    const quote = s => `“${s}”`;

    if (!check.selector && !check.row) {
        // No selector: the page's text, as a reader sees it. Not the HTML — a
        // check that "the page doesn't mention Smith & Co" must not pass just
        // because the HTML spells it "Smith &amp; Co".
        const page = output.text();
        for (const needle of toList(check.contains)) if (!page.includes(tidy(needle))) fail(`The page should mention ${quote(needle)}.`);
        for (const needle of toList(check.notContains)) if (page.includes(tidy(needle))) fail(`The page should not mention ${quote(needle)}.`);
        return;
    }

    const matches = targetsOf(check, output);
    const found = describeTarget(check, matches.length);
    const what = check.row ? `the \u201c${check.row}\u201d row` : quote(check.selector);

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
            fail(check.row
                ? `${found}, so it's unclear which one "text" means. Give "text" as a list with one entry per row, or a "selector" to say which table.`
                : `${found}, so it's unclear which one "text" means. Narrow the selector, or give "text" as a list with one entry per element.`);
        } else if (texts[0] !== tidy(check.text)) {
            fail(`It reads ${quote(texts[0])}; expected ${quote(tidy(check.text))}.`);
        }
    }

    const combined = matches.map(textOf).join(' ');
    for (const needle of toList(check.contains)) {
        if (!combined.includes(tidy(needle))) fail(`The text of ${what} should contain ${quote(needle)}; it reads ${quote(snip(combined))}.`);
    }
    for (const needle of toList(check.notContains)) {
        if (combined.includes(tidy(needle))) fail(`The text of ${what} should not contain ${quote(needle)}.`);
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

// ---- accepting a new result -----------------------------------------------------

// Checks whose expectation is a value read off the page — text, a count,
// whether something is there, an attribute — can be updated to what the page
// shows now. A phrase to find (contains / notContains) can't: when "includes
// 'Net 30'" fails, nothing says which phrase should replace it.
function acceptable(check) {
    if (!check.selector && !check.row) return false;
    if (check.contains !== undefined || check.notContains !== undefined) return false;
    return check.text !== undefined || check.count !== undefined || check.exists !== undefined || check.attributes !== undefined;
}

// A check's expectation updated to what `html` shows, with the old and new
// values for each thing changed, so the reader can be asked to confirm. Its
// name is updated where it quoted the old value (the builder's names do), so a
// check called 'The heading reads "For Fred"' doesn't go on saying so. Returns
// { error } instead when there is no one right new value.
function acceptCheck(raw, html) {
    const { checks: [check] } = parseChecks([raw]);
    if (check.error) return { error: check.error };
    if (!acceptable(check)) {
        return { error: check.selector
            ? 'This check looks for a phrase, so there\u2019s no single new result to accept. Remove it, or edit the test and check the part again.'
            : 'This check looks for a phrase on the page, so there\u2019s no single new result to accept. Remove it, or edit the test.' };
    }

    let matches;
    try {
        matches = targetsOf(check, queryable(html));
    } catch (err) {
        return { error: `The selector "${check.selector}" is not valid CSS: ${err.message}` };
    }
    const target = check.row ? `The \u201c${check.row}\u201d row` : `\u201c${check.selector}\u201d`;
    const updated = JSON.parse(JSON.stringify(raw));
    const changes = [];
    let name = typeof raw.name === 'string' ? raw.name : '';
    const quoted = value => `\u201c${value}\u201d`;
    const renameQuoted = (from, to) => {
        // The builder quotes values whole, or cut to 40 characters with an ellipsis.
        for (const [a, b] of [[from, to], [shorten(from, 40), shorten(to, 40)]]) {
            if (name.includes(quoted(a))) { name = name.split(quoted(a)).join(quoted(b)); return; }
        }
    };

    if (check.text !== undefined) {
        const now = matches.map(textOf);
        if (Array.isArray(check.text)) {
            if (now.length === 0) return { error: `${target} matches nothing now, so there is no text to accept. Remove the check, or edit the test and check the part again.` };
            changes.push({ what: 'text', from: check.text.map(tidy), to: now });
            updated.text = now;
        } else {
            if (now.length !== 1) {
                return { error: `${target} matches ${now.length === 0 ? 'nothing' : now.length + ' elements'} now, so there is no single text to accept. Remove the check, or edit the test and check the part again.` };
            }
            changes.push({ what: 'text', from: tidy(check.text), to: now[0] });
            renameQuoted(tidy(check.text), now[0]);
            updated.text = now[0];
        }
    }
    if (check.count !== undefined) {
        changes.push({ what: 'count', from: check.count, to: matches.length });
        name = name.replace(new RegExp(`\\b${check.count}\\b`), String(matches.length));
        updated.count = matches.length;
    }
    if (check.exists !== undefined) {
        const now = matches.length > 0;
        changes.push({ what: 'shown', from: check.exists, to: now });
        if (check.exists && !now) name = name.replace(/ is shown$/, ' is not shown');
        if (!check.exists && now) name = name.replace(/ is not shown$/, ' is shown');
        // A bare selector meant exists: true; it's written out now it may be false.
        updated.exists = now;
    }
    if (check.attributes !== undefined) {
        if (matches.length !== 1) {
            return { error: `${target} matches ${matches.length === 0 ? 'nothing' : matches.length + ' elements'} now, so there is no single element to accept. Remove the check, or edit the test and check the part again.` };
        }
        const attribs = matches[0].attribs || {};
        updated.attributes = {};
        for (const [attr, want] of Object.entries(check.attributes)) {
            const has = Object.prototype.hasOwnProperty.call(attribs, attr);
            const now = typeof want === 'boolean' ? has : (has ? attribs[attr] : false);
            changes.push({ what: attr, from: want, to: now });
            updated.attributes[attr] = now;
            if (attr === 'checked' && want === true && now === false) name = name.replace(/ is ticked$/, ' is not ticked');
            if (attr === 'checked' && want === false && now === true) name = name.replace(/ is not ticked$/, ' is ticked');
            if (typeof want === 'string' && typeof now === 'string') renameQuoted(want, now);
        }
    }

    if (name) updated.name = name;
    const [after] = runChecks(parseChecks([updated]).checks, html);
    if (after.status !== 'passed') return { error: `Even updated, this check wouldn\u2019t pass: ${after.failures[0]}` };
    const changed = changes.filter(c => JSON.stringify(c.from) !== JSON.stringify(c.to));
    return { check: updated, changes: changed };
}

function shorten(text, limit) {
    return text.length > limit ? text.slice(0, limit - 1) + '\u2026' : text;
}

module.exports = { CHECK_KEYS, parseChecks, runChecks, asPreviewShowsIt, acceptCheck };
