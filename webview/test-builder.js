// The test builder in the HTML preview: click part of the rendered document,
// pick what should be true about it in plain words, and save the result as a
// test case with checks — no JSON or CSS selectors needed.
//
// Runs inside the preview webview. The pure parts (reading text, writing a
// selector, proposing checks) are exposed on window.RLPTestBuilder so the test
// suite can drive them in jsdom and confirm every proposal passes when the
// runner checks it against the same output.
//
// The panel is built in a shadow root, so the template's own stylesheets
// (universal.css and friends are injected into this page) can't restyle it,
// and its styles can't leak into the document being checked. Hover and
// selection are drawn as overlays rather than classes on the template's
// elements, so building a test never changes what is being tested.

(function () {
    'use strict';

    // ---- reading text: must match textOf in output-checks.js ---------------

    // The same element lists as output-checks.js (a test keeps them identical),
    // so the text proposed here is the text the runner will read.
    const BREAKS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
        'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'label', 'legend',
        'li', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
    const SILENT = new Set(['script', 'style', 'template', 'noscript']);

    function readableText(node) {
        const parts = [];
        const walk = n => {
            if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
            if (n.nodeType !== 1 && n.nodeType !== 11) return;
            const name = n.nodeType === 1 ? n.tagName.toLowerCase() : '';
            if (SILENT.has(name)) return;
            const breaks = BREAKS.has(name);
            if (breaks) parts.push(' ');
            // <template> content and the like aside, childNodes is what the
            // runner's tree holds too.
            for (const child of n.childNodes) walk(child);
            if (breaks) parts.push(' ');
        };
        walk(node);
        return parts.join('').replace(/\s+/g, ' ').trim();
    }

    // ---- selectors -----------------------------------------------------------

    // CSS.escape, which not every host provides.
    function cssEscape(value) {
        const s = String(value);
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const ch = s.charAt(i);
            const code = s.charCodeAt(i);
            if (code === 0) out += '�';
            else if ((code >= 1 && code <= 31) || code === 127 || (i === 0 && code >= 48 && code <= 57)
                || (i === 1 && code >= 48 && code <= 57 && s.charAt(0) === '-')) out += '\\' + code.toString(16) + ' ';
            else if (i === 0 && ch === '-' && s.length === 1) out += '\\-';
            else if (/[A-Za-z0-9_\-\u0080-￿]/.test(ch)) out += ch;
            else out += '\\' + ch;
        }
        return out;
    }

    function quoteAttr(value) {
        return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    function tagOf(el) {
        return el.tagName.toLowerCase();
    }

    // Which elements of the output a selector matches — as the test runner
    // will see it. The runner parses the output on its own, with nothing
    // around it; here it sits inside the preview's container, a <div>, inside
    // the page. Matched in place, "div > table" would also match a table at
    // the top of the output, whose parent is that container, and the builder
    // would count or pick things the runner never will. So selectors are run
    // against a detached copy of the output, shaped as the runner parses it,
    // and the matches mapped back to the elements on the page.
    const scopes = new WeakMap();

    function scopeOf(root) {
        let scope = scopes.get(root);
        if (scope && scope.observer && scope.observer.takeRecords().length) scope = null;
        if (scope) return scope;
        // The copy goes in the body of a separate, inert document (nothing in
        // it runs). Its top-level elements have <body> as their parent, which
        // no selector here ever names, so they match as the runner's parentless
        // top-level elements do. A bare DocumentFragment would be closer still,
        // but selector engines disagree about child combinators under one.
        const doc = root.ownerDocument.implementation.createHTMLDocument('');
        const copy = doc.body;
        for (const child of Array.from(root.childNodes)) copy.appendChild(doc.importNode(child, true));
        const toPage = new Map();
        const pair = (original, clone) => {
            for (let i = 0; i < clone.children.length; i++) {
                toPage.set(clone.children[i], original.children[i]);
                pair(original.children[i], clone.children[i]);
            }
        };
        pair(root, copy);
        const previous = scopes.get(root);
        const observer = previous && previous.observer
            || (typeof MutationObserver === 'function' ? new MutationObserver(() => { }) : null);
        if (observer && !(previous && previous.observer)) observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        scope = { copy, toPage, observer };
        scopes.set(root, scope);
        return scope;
    }

    function matches(root, selector) {
        try {
            const scope = scopeOf(root);
            return Array.from(scope.copy.querySelectorAll(selector)).map(el => scope.toPage.get(el));
        } catch (err) {
            return null;
        }
    }

    function selectsOnly(root, selector, el) {
        const m = matches(root, selector);
        return Boolean(m) && m.length === 1 && m[0] === el;
    }

    // Selectors that name an element by what it is rather than where it sits:
    // an id, Reporter's field ids, a form name. These survive layout changes,
    // so they are tried first.
    function namedSelectors(el) {
        const tag = tagOf(el);
        const out = [];
        if (el.id) out.push('#' + cssEscape(el.id));
        for (const attr of ['data-editor-id', 'name', 'for']) {
            const v = el.getAttribute(attr);
            if (v) out.push(tag + '[' + attr + '=' + quoteAttr(v) + ']');
        }
        return out;
    }

    // One step of a positional path: the tag, and its place among same-tag
    // siblings when it has any.
    function step(el) {
        const tag = tagOf(el);
        const parent = el.parentNode;
        if (!parent || !parent.children) return tag;
        const same = Array.from(parent.children).filter(c => tagOf(c) === tag);
        return same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(el) + 1) + ')' : tag;
    }

    // The path from just inside `root` down to `el`, stopping early at an
    // ancestor that can be named on its own.
    function pathTo(el, root) {
        const steps = [];
        let node = el;
        while (node && node !== root && node.nodeType === 1) {
            if (node !== el) {
                const named = namedSelectors(node).find(sel => selectsOnly(root, sel, node));
                if (named) { steps.unshift(named); break; }
            }
            steps.unshift(step(node));
            node = node.parentNode;
        }
        return steps;
    }

    // Drop leading steps while the selector still picks exactly what it did —
    // a shorter selector depends on less of the page's structure.
    function shorten(steps, root, stillRight) {
        let best = steps;
        for (let i = 1; i < steps.length; i++) {
            const candidate = steps.slice(i);
            if (stillRight(candidate.join(' > '))) best = candidate;
            else break;
        }
        return best.join(' > ');
    }

    // A selector that picks `el` and nothing else, preferring names over
    // positions and short over long. Null if none can be found.
    function selectorFor(el, root) {
        for (const sel of namedSelectors(el)) if (selectsOnly(root, sel, el)) return sel;
        const tag = tagOf(el);
        if (selectsOnly(root, tag, el)) return tag;
        for (const cls of Array.from(el.classList || [])) {
            const sel = tag + '.' + cssEscape(cls);
            if (selectsOnly(root, sel, el)) return sel;
        }
        const steps = pathTo(el, root);
        const full = steps.join(' > ');
        if (!selectsOnly(root, full, el)) return null;
        return shorten(steps, root, sel => selectsOnly(root, sel, el));
    }

    // A selector for `el` and the others like it, and how many there are —
    // what "There are 3 of these" counts. The others like it are its family,
    // found by name before position, since a loop in a template usually gives
    // what it repeats a class:
    //
    //   1. its own class, e.g. table.recommendation — the narrowest of its
    //      classes that still repeats;
    //   2. a repeated container with a class around it, e.g. the table in
    //      each section.recommendation;
    //   3. failing a name, its position: the nearest repeating step of its
    //      path, a repeated ancestor first (a price cell's likes are the prices
    //      in the other rows, not the other cells of its own row), then its
    //      own siblings.
    //
    // Counting by position alone would count every table at that level —
    // a plans table above the recommendations included — so the count could
    // stay right while a recommendation went missing. Null when it has no like.
    // `likeThis` says the family is narrower than every element of its kind.
    function groupSelectorFor(el, root) {
        const repeats = sel => {
            const m = matches(root, sel);
            return m && m.length >= 2 && m.indexOf(el) !== -1 ? m.length : 0;
        };
        const narrowest = candidates => candidates
            .map(selector => ({ selector, count: repeats(selector) }))
            .filter(c => c.count)
            .sort((x, y) => x.count - y.count)[0];

        const tag = tagOf(el);
        const own = narrowest(Array.from(el.classList || []).map(cls => tag + '.' + cssEscape(cls)));
        if (own) return { selector: own.selector, count: own.count, likeThis: true };

        const inner = [];
        for (let node = el; node && node.parentElement && node !== root; node = node.parentElement) {
            inner.unshift(step(node));
            const container = node.parentElement;
            if (container === root || !root.contains(container)) break;
            const within = inner.join(' > ');
            const byContainer = narrowest(Array.from(container.classList || [])
                .map(cls => tagOf(container) + '.' + cssEscape(cls) + ' > ' + within));
            if (byContainer) return { selector: byContainer.selector, count: byContainer.count, likeThis: true };
        }

        const steps = pathTo(el, root);
        if (!steps.length) return null;
        const order = [];
        for (let i = steps.length - 2; i >= 0; i--) order.push(i);
        order.push(steps.length - 1);
        for (const i of order) {
            if (!/:nth-of-type\(\d+\)$/.test(steps[i])) continue;
            const general = steps.slice();
            general[i] = steps[i].replace(/:nth-of-type\(\d+\)$/, '');
            const group = matches(root, general.join(' > '));
            if (!group || group.length < 2 || group.indexOf(el) === -1) continue;
            const count = group.length;
            const selector = shorten(general, root, sel => {
                const m = matches(root, sel);
                return Boolean(m) && m.length === count && m.indexOf(el) !== -1;
            });
            return { selector, count, likeThis: i < steps.length - 1 };
        }
        return null;
    }

    // ---- proposals -------------------------------------------------------------

    const NOUNS = {
        h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
        p: 'paragraph', td: 'table cell', th: 'table heading', tr: 'table row', table: 'table',
        li: 'list item', ul: 'list', ol: 'list', a: 'link', button: 'button', img: 'image',
        label: 'label', textarea: 'text box', select: 'drop-down'
    };

    function nounFor(el) {
        const tag = tagOf(el);
        if (tag === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'checkbox') return 'tick box';
            if (type === 'radio') return 'option';
            return 'text box';
        }
        return NOUNS[tag] || 'text';
    }

    function plural(noun) {
        if (noun === 'text') return 'blocks like this';
        if (noun === 'box' || /x$/.test(noun)) return noun + 'es';
        return noun + 's';
    }

    function short(text, max) {
        const limit = max || 60;
        return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
    }

    // The words a reader would use for a tick box or option: its label's text.
    function labelFor(el, root) {
        const label = el.closest('label') || (el.id ? root.querySelector('label[for=' + quoteAttr(el.id) + ']') : null);
        const text = label ? readableText(label) : '';
        return text || el.getAttribute('data-editor-id') || el.getAttribute('name') || el.id || '';
    }

    // ---- rows found by their label ----------------------------------------------
    //
    // Must match targetsOf in output-checks.js: a row's label is its first
    // cell's text ("Plan name:" and "Plan name" are the same label), and the
    // row check looks at the cell beside it.

    function tidyLabel(text) {
        return String(text).replace(/\s+/g, ' ').trim().replace(/\s*:$/, '');
    }

    function cellsOf(tr) {
        return Array.from(tr.children).filter(c => tagOf(c) === 'td' || tagOf(c) === 'th');
    }

    // The value cell of every row labelled `label`, in page order.
    function rowValueCells(root, label) {
        const out = [];
        for (const tr of matches(root, 'tr') || []) {
            const cells = cellsOf(tr);
            if (cells.length >= 2 && tidyLabel(readableText(cells[0])) === label && out.indexOf(cells[1]) === -1) out.push(cells[1]);
        }
        return out;
    }

    // Checks that find `el`'s row by its label — offered first, because they
    // survive tables being added and rows being inserted, where a position
    // like "2nd row, 2nd cell" breaks. Only for a value cell (or something in
    // one) sitting right after its row's label.
    function rowProposals(el, root) {
        const cell = el.closest && el.closest('td, th');
        if (!cell || !root.contains(cell) || !cell.parentElement || tagOf(cell.parentElement) !== 'tr') return [];
        const cells = cellsOf(cell.parentElement);
        if (cells.indexOf(cell) !== 1) return [];
        const label = tidyLabel(readableText(cells[0]));
        if (!label || label.length > 60) return [];
        const values = rowValueCells(root, label);
        if (values.indexOf(cell) === -1) return [];
        const quoted = '\u201c' + short(label, 40) + '\u201d';
        const text = readableText(cell);
        const out = [];
        if (values.length === 1) {
            if (text) {
                out.push({
                    kind: 'reads', label: 'It reads exactly \u201c' + short(text, 120) + '\u201d (the ' + quoted + ' row)',
                    name: quoted + ' reads \u201c' + short(text, 40) + '\u201d',
                    check: { row: label, text }
                });
                out.push({
                    kind: 'includes', label: 'It includes (the ' + quoted + ' row):', editable: text,
                    name: quoted + ' includes \u201c' + short(text, 40) + '\u201d',
                    nameFor: value => quoted + ' includes \u201c' + short(value, 40) + '\u201d',
                    check: { row: label, contains: text }
                });
                if (text.length > 80) out.unshift(out.splice(1, 1)[0]);
            }
            out.push({ kind: 'shown', label: 'The ' + quoted + ' row is shown', name: 'The ' + quoted + ' row is shown', check: { row: label, exists: true } });
        } else {
            const texts = values.map(readableText);
            out.push({
                kind: 'reads', label: 'The ' + values.length + ' ' + quoted + ' rows read ' + texts.map(t => '\u201c' + short(t, 30) + '\u201d').join(', '),
                name: 'The ' + quoted + ' rows read ' + texts.map(t => '\u201c' + short(t, 24) + '\u201d').join(', '),
                check: { row: label, text: texts }
            });
            out.push({
                kind: 'count', label: 'There are ' + values.length + ' ' + quoted + ' rows (highlighted)',
                name: 'There are ' + values.length + ' ' + quoted + ' rows',
                check: { row: label, count: values.length }
            });
        }
        return out;
    }

    // What could be true about `el`, in plain words, each with the check that
    // proves it and a suggested name. The first is the one to preselect.
    function proposalsFor(el, root) {
        const out = [];
        const selector = selectorFor(el, root);
        const noun = nounFor(el);
        const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
        const tag = tagOf(el);
        const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';

        if (selector && (type === 'checkbox' || type === 'radio')) {
            const ticked = el.hasAttribute('checked');
            const what = labelFor(el, root);
            const subject = what ? '“' + short(what, 40) + '”' : 'The ' + noun;
            out.push({
                kind: 'ticked',
                label: ticked ? 'It is ticked' : 'It is not ticked',
                name: subject + (ticked ? ' is ticked' : ' is not ticked'),
                check: { selector, attributes: { checked: ticked } }
            });
        } else if (selector && tag === 'input') {
            const value = el.getAttribute('value') || '';
            out.push({
                kind: 'value',
                label: value ? 'It shows “' + short(value) + '”' : 'It is empty',
                name: 'The ' + noun + (value ? ' shows “' + short(value, 40) + '”' : ' is empty'),
                check: { selector, attributes: { value } }
            });
        }

        // Found by its row's label, ahead of anything found by position. Where
        // there is one, the positional versions of the same checks aren't
        // offered at all: two near-identical choices, one of which breaks when
        // a table is added above, is a trap for a reader who can't tell them
        // apart.
        const byRow = tag !== 'input' ? rowProposals(el, root) : [];
        out.push(...byRow);

        const text = readableText(el);
        if (selector && text && tag !== 'input' && !byRow.length) {
            out.push({
                kind: 'reads',
                label: 'It reads exactly “' + short(text, 120) + '”',
                name: 'The ' + noun + ' reads “' + short(text, 40) + '”',
                check: { selector, text }
            });
            out.push({
                kind: 'includes',
                label: 'It includes:',
                editable: text,
                name: 'The ' + noun + ' includes “' + short(text, 40) + '”',
                nameFor: value => 'The ' + noun + ' includes “' + short(value, 40) + '”',
                check: { selector, contains: text }
            });
            // Long text rarely needs checking word for word: start with the
            // part to keep, which the reader can trim.
            if (text.length > 80) out.unshift(out.splice(out.length - 1, 1)[0]);
        }

        const group = groupSelectorFor(el, root);
        if (group) {
            out.push({
                kind: 'count',
                label: 'There are ' + group.count + ' of these (highlighted)',
                name: 'There are ' + group.count + ' ' + plural(noun) + (group.likeThis ? ' like this' : ''),
                check: { selector: group.selector, count: group.count }
            });
        }

        if (selector && !byRow.length) {
            out.push({
                kind: 'shown',
                label: 'It is shown',
                name: 'The ' + noun + (text ? ' “' + short(text, 40) + '”' : '') + ' is shown',
                check: { selector, exists: true }
            });
        }
        for (const p of out) p.noun = Noun;
        return out;
    }

    const api = { rowValueCells, tidyLabel, readableText, cssEscape, selectorFor, groupSelectorFor, proposalsFor, nounFor };
    if (typeof window !== 'undefined') window.RLPTestBuilder = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    // ---- the panel ------------------------------------------------------------

    if (typeof document === 'undefined') return;
    const host = document.getElementById('lp-builder');
    if (!host) return;
    // A webview may call acquireVsCodeApi only once; the preview's own script
    // does, and shares the handle. Without it (outside VS Code) the builder
    // still works, it just can't save.
    const vscodeApi = window.__rlpVsCodeApi || null;

    const root = () => document.getElementById('lp-rendered-root');
    const shadow = host.attachShadow({ mode: 'open' });
    const styles = document.getElementById('lp-builder-styles');
    shadow.innerHTML = '<style>' + (styles ? styles.textContent : '') + '</style><div class="panel" role="dialog" aria-label="Create a test" hidden></div>';
    const panel = shadow.querySelector('.panel');

    const hoverBox = overlay('lp-builder-hover');
    const pickBox = overlay('lp-builder-pick');
    // One box per element a count would count, so "of these" can be seen.
    let groupBoxes = [];

    function overlay(id) {
        const box = document.createElement('div');
        box.id = id;
        box.hidden = true;
        document.body.appendChild(box);
        return box;
    }

    function showGroup(selector) {
        for (const box of groupBoxes) box.remove();
        groupBoxes = [];
        if (!selector) return;
        for (const el of matches(root(), selector) || []) {
            const box = document.createElement('div');
            box.className = 'lp-builder-group';
            document.body.appendChild(box);
            place(box, el);
            groupBoxes.push(box);
        }
    }

    function syncGroup() {
        const p = state.picked && state.proposals[state.choice];
        if (p && p.kind === 'count' && p.check.row) return showCells(rowValueCells(root(), p.check.row));
        showGroup(p && p.kind === 'count' ? p.check.selector : null);
    }

    function showCells(cells) {
        for (const box of groupBoxes) box.remove();
        groupBoxes = cells.map(el => {
            const box = document.createElement('div');
            box.className = 'lp-builder-group';
            document.body.appendChild(box);
            place(box, el);
            return box;
        });
    }

    function place(box, el) {
        if (!el || !el.isConnected) { box.hidden = true; return; }
        const r = el.getBoundingClientRect();
        box.style.top = (r.top + window.scrollY - 2) + 'px';
        box.style.left = (r.left + window.scrollX - 2) + 'px';
        box.style.width = (r.width + 4) + 'px';
        box.style.height = (r.height + 4) + 'px';
        box.hidden = false;
    }

    const state = {
        open: false,
        name: host.getAttribute('data-default-name') || '',
        picked: null,
        proposals: [],
        choice: 0,
        editable: '',
        checkName: '',
        checks: [],
        wholePage: false,
        pageMode: 'not',
        pageText: '',
        busy: false,
        notice: null,
        // The tests this template and data file already have (from the
        // extension), and the one being edited, if any: { suiteFile, index,
        // name }. Null means a new test.
        tests: [],
        editing: null
    };

    // Load an existing test into the panel. Its checks are marked as not new:
    // only checks added now have to pass before saving (see updateBuiltTest).
    function edit(test) {
        state.editing = { suiteFile: test.suiteFile, index: test.index, name: test.name };
        state.name = test.name;
        state.checks = test.checks.map(c => {
            const check = Object.assign({}, c);
            delete check.name;
            return { name: c.name, check, isNew: false };
        });
        state.wholePage = false;
        state.picked = null;
        state.proposals = [];
        pickBox.hidden = true;
        state.notice = null;
        render();
    }

    function startNew() {
        state.editing = null;
        state.name = host.getAttribute('data-default-name') || '';
        state.checks = [];
        state.notice = null;
        render();
    }

    function move(index, by) {
        const to = index + by;
        if (to < 0 || to >= state.checks.length) return;
        const [item] = state.checks.splice(index, 1);
        state.checks.splice(to, 0, item);
        render();
        // Keep focus on the moved check's button, so it can be moved again
        // from the keyboard.
        const again = shadow.querySelector('[data-do="' + (by < 0 ? 'up' : 'down') + '"][data-index="' + to + '"]');
        if (again && !again.disabled) again.focus();
    }

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function open() {
        state.open = true;
        document.body.classList.add('lp-building');
        const source = document.getElementById('lp-show-source');
        if (source && source.checked) source.click();
        render();
        // Ask which tests this page already has, for the test picker.
        if (vscodeApi) vscodeApi.postMessage({ type: 'action', action: 'listBuiltTests' });
    }

    function close() {
        state.open = false;
        state.picked = null;
        document.body.classList.remove('lp-building');
        hoverBox.hidden = true;
        pickBox.hidden = true;
        render();
    }

    function pick(el) {
        state.picked = el;
        state.proposals = proposalsFor(el, root());
        state.choice = 0;
        const first = state.proposals[0];
        state.editable = first && first.editable !== undefined ? first.editable : '';
        state.checkName = first ? first.name : '';
        state.notice = state.proposals.length ? null : { ok: false, text: 'This part can’t be checked on its own. Try the area around it.' };
        place(pickBox, el);
        render();
    }

    function chosen() {
        const p = state.proposals[state.choice];
        if (!p) return null;
        const check = JSON.parse(JSON.stringify(p.check));
        if (p.kind === 'includes') check.contains = state.editable.trim();
        return { name: state.checkName.trim() || p.name, check };
    }

    function addChosen() {
        const c = chosen();
        if (!c) return;
        if (c.check.contains !== undefined && !c.check.contains) {
            state.notice = { ok: false, text: 'Type the text it should include.' };
            return render();
        }
        state.checks.push(Object.assign(c, { isNew: true }));
        state.picked = null;
        state.proposals = [];
        pickBox.hidden = true;
        state.notice = { ok: true, text: 'Added. Click another part to check it too, or save the test.' };
        render();
    }

    function addPageCheck() {
        const text = state.pageText.trim();
        if (!text) return;
        const must = state.pageMode === 'must';
        state.checks.push({
            name: must ? 'The page mentions “' + short(text, 40) + '”' : 'The page doesn’t mention “' + short(text, 40) + '”',
            check: must ? { contains: text } : { notContains: text },
            isNew: true
        });
        state.pageText = '';
        render();
    }

    function save() {
        const name = state.name.trim();
        if (!name) { state.notice = { ok: false, text: 'Give the test a name first.' }; return render(); }
        if (!state.checks.length && !state.wholePage && !state.editing) {
            state.notice = { ok: false, text: 'Add at least one check, or tick “Also check the whole page”.' };
            return render();
        }
        if (!vscodeApi) return;
        state.busy = true;
        state.notice = { ok: true, text: 'Checking and saving…' };
        render();
        vscodeApi.postMessage({
            type: 'action',
            action: 'saveBuiltTest',
            name,
            wholePage: !state.editing && state.wholePage,
            checks: state.checks.map(c => Object.assign({ name: c.name }, c.check)),
            newChecks: state.checks.map((c, i) => (c.isNew ? i : -1)).filter(i => i !== -1),
            editing: state.editing
                ? { suiteFile: state.editing.suiteFile, caseIndex: state.editing.index, originalName: state.editing.name }
                : null
        });
    }

    function render() {
        syncGroup();
        // Both the host and the panel are hidden while closed: the panel is
        // fixed over the right of the page, so if either rule were ever lost it
        // would cover the preview.
        host.hidden = !state.open;
        panel.hidden = !state.open;
        if (!state.open) { panel.innerHTML = ''; return; }
        const p = state.proposals;
        const pickedPart = state.picked
            ? '<section class="picked"><div class="row"><strong>' + esc(p[0] ? p[0].noun : 'Selected') + '</strong>'
                + '<button type="button" class="link" data-do="wider" title="Select the part around this one">Select the area around it</button></div>'
                + (p.length ? '<fieldset><legend>What should be true about it?</legend>'
                    + p.map((q, i) => '<label class="choice"><input type="radio" name="choice" value="' + i + '"' + (i === state.choice ? ' checked' : '') + '> <span>' + esc(q.label) + '</span></label>'
                        + (q.kind === 'includes' && i === state.choice ? '<textarea data-field="editable" rows="2">' + esc(state.editable) + '</textarea>' : '')).join('')
                    + '</fieldset>'
                    + '<label class="field">Name of this check<input type="text" data-field="checkName" value="' + esc(state.checkName) + '"></label>'
                    + '<div class="row end"><button type="button" class="secondary" data-do="cancel-pick">Cancel</button><button type="button" data-do="add">Add check</button></div>'
                    : '')
                + '</section>'
            : '<p class="hint">Click any part of the page to check it.</p>';

        // Each check can be moved up or down — the order they're listed and
        // reported in — or removed. Checks added since the test was opened say so.
        const last = state.checks.length - 1;
        const list = state.checks.length
            ? '<ol class="checks">' + state.checks.map((c, i) => '<li><div class="check-row"><span class="check-text">' + esc(c.name)
                + (state.editing && c.isNew ? ' <em class="new">new</em>' : '') + '</span>'
                + '<span class="check-buttons">'
                + '<button type="button" class="icon" data-do="up" data-index="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move ' + esc(c.name) + ' up" title="Move up">\u2191</button>'
                + '<button type="button" class="icon" data-do="down" data-index="' + i + '"' + (i === last ? ' disabled' : '') + ' aria-label="Move ' + esc(c.name) + ' down" title="Move down">\u2193</button>'
                + '<button type="button" class="link" data-do="remove" data-index="' + i + '" aria-label="Remove ' + esc(c.name) + '">Remove</button>'
                + '</span></div></li>').join('') + '</ol>'
            : '<p class="hint">No checks yet.</p>';

        // Which test the panel is working on: a new one, or one this page
        // already has.
        const picker = state.tests.length
            ? '<label class="field">Test<select data-field="test">'
                + '<option value="new"' + (state.editing ? '' : ' selected') + '>A new test</option>'
                + state.tests.map((t, i) => '<option value="' + i + '"' + (state.editing && state.editing.suiteFile === t.suiteFile && state.editing.index === t.index ? ' selected' : '') + '>Edit \u201c' + esc(t.name) + '\u201d</option>').join('')
                + '</select></label>'
            : '';

        const notice = state.notice ? '<p class="notice ' + (state.notice.ok ? 'ok' : 'bad') + '">' + esc(state.notice.text) + '</p>' : '';

        panel.innerHTML =
            '<header><h2>' + (state.editing ? 'Edit a test' : 'Create a test') + '</h2><button type="button" class="link" data-do="close" aria-label="Close the test builder">Close</button></header>'
            + picker
            + '<label class="field">Test name<input type="text" data-field="name" value="' + esc(state.name) + '" placeholder="e.g. Invoice with two items"></label>'
            + '<p class="hint small">Only add checks for things that are right in the preview now. The test will then catch them changing.</p>'
            + pickedPart
            + '<h3>Checks in this test</h3>' + list
            + '<div class="page-check"><select data-field="pageMode" aria-label="Whether the page should mention the text"><option value="not"' + (state.pageMode === 'not' ? ' selected' : '') + '>The page doesn’t mention</option><option value="must"' + (state.pageMode === 'must' ? ' selected' : '') + '>The page mentions</option></select>'
            + '<input type="text" data-field="pageText" value="' + esc(state.pageText) + '" placeholder="some text"><button type="button" class="secondary" data-do="add-page">Add</button></div>'
            + (state.editing
                ? ''
                : '<label class="choice"><input type="checkbox" data-field="wholePage"' + (state.wholePage ? ' checked' : '') + '> <span>Also check the whole page stays exactly as it is now <em>(fails on any change at all)</em></span></label>')
            + notice
            + '<div class="row end"><button type="button" data-do="save"' + (state.busy ? ' disabled' : '') + '>' + (state.editing ? 'Save changes' : 'Save test') + '</button></div>';
    }

    shadow.addEventListener('input', event => {
        const field = event.target.getAttribute && event.target.getAttribute('data-field');
        if (!field || field === 'test' || field === 'pageMode') return;
        if (field === 'wholePage') state.wholePage = event.target.checked;
        else state[field] = event.target.value;
        if (field === 'editable') {
            const p = state.proposals[state.choice];
            if (p && p.nameFor) {
                state.checkName = p.nameFor(state.editable.trim());
                const nameInput = shadow.querySelector('[data-field="checkName"]');
                if (nameInput) nameInput.value = state.checkName;
            }
        }
    });
    shadow.addEventListener('change', event => {
        if (event.target.name === 'choice') {
            state.choice = Number(event.target.value);
            const p = state.proposals[state.choice];
            state.checkName = p.name;
            if (p.editable !== undefined) state.editable = p.editable;
            render();
        } else if (event.target.getAttribute('data-field') === 'pageMode') {
            state.pageMode = event.target.value;
        } else if (event.target.getAttribute('data-field') === 'test') {
            const value = event.target.value;
            if (value === 'new') startNew();
            else edit(state.tests[Number(value)]);
        }
    });
    shadow.addEventListener('click', event => {
        const button = event.target.closest && event.target.closest('[data-do]');
        if (!button) return;
        const what = button.getAttribute('data-do');
        if (what === 'close') close();
        else if (what === 'add') addChosen();
        else if (what === 'add-page') addPageCheck();
        else if (what === 'save') save();
        else if (what === 'cancel-pick') { state.picked = null; state.proposals = []; pickBox.hidden = true; render(); }
        else if (what === 'remove') { state.checks.splice(Number(button.getAttribute('data-index')), 1); render(); }
        else if (what === 'up') move(Number(button.getAttribute('data-index')), -1);
        else if (what === 'down') move(Number(button.getAttribute('data-index')), 1);
        else if (what === 'wider' && state.picked) {
            const parent = state.picked.parentElement;
            if (parent && parent !== root() && root().contains(parent)) pick(parent);
        }
    });

    // "Edit test" in the report opens the preview with the test to edit in the
    // page itself; the panel opens on it straight away, and the extension's
    // list of tests confirms it (see the builderTests message).
    let pendingEdit = null;
    try {
        pendingEdit = host.getAttribute('data-edit') ? JSON.parse(host.getAttribute('data-edit')) : null;
    } catch (err) {
        pendingEdit = null;
    }
    if (pendingEdit) {
        open();
        edit(pendingEdit);
        if (!vscodeApi) pendingEdit = null;
    }

    // Opening: the toolbar button lives in the preview's chrome, which is
    // replaced on every edit, so the listener is delegated.
    document.addEventListener('click', event => {
        const opener = event.target.closest && event.target.closest('[data-lp-local="build-test"]');
        if (opener) { event.preventDefault(); open(); }
    });

    // Picking: while the builder is open, clicks inside the rendered document
    // select instead of acting — a tick box must not tick, a link must not go.
    document.addEventListener('click', event => {
        if (!state.open || state.busy) return;
        const r = root();
        const target = event.target;
        if (!r || !target || !r.contains(target) || target === r) return;
        event.preventDefault();
        event.stopPropagation();
        pick(target.nodeType === 1 ? target : target.parentElement);
    }, true);
    document.addEventListener('mouseover', event => {
        if (!state.open) return;
        const r = root();
        if (r && event.target !== r && r.contains(event.target)) place(hoverBox, event.target);
        else hoverBox.hidden = true;
    });
    window.addEventListener('scroll', () => { if (state.picked) place(pickBox, state.picked); }, { passive: true });

    // An edit re-renders the document and the picked element goes with it.
    window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'update' && state.picked) {
            setTimeout(() => {
                if (state.picked && !state.picked.isConnected) {
                    state.picked = null;
                    state.proposals = [];
                    pickBox.hidden = true;
                    state.notice = { ok: false, text: 'The preview changed. Click the part again.' };
                    render();
                }
            }, 0);
        } else if (msg.type === 'builderTests') {
            state.tests = Array.isArray(msg.tests) ? msg.tests : [];
            // Opened by "Edit test" in the report: go straight to that test.
            if (pendingEdit) {
                const test = state.tests.find(t => t.suiteFile === pendingEdit.suiteFile && t.index === pendingEdit.index) || pendingEdit;
                pendingEdit = null;
                edit(test);
            } else {
                render();
            }
        } else if (msg.type === 'builderResult') {
            state.busy = false;
            state.notice = { ok: Boolean(msg.ok), text: String(msg.message || '') };
            if (msg.ok) {
                state.picked = null;
                state.proposals = [];
                pickBox.hidden = true;
                if (state.editing) {
                    // Still editing the same test, now as saved.
                    state.editing.name = state.name.trim();
                    for (const c of state.checks) c.isNew = false;
                } else {
                    state.checks = [];
                    state.wholePage = false;
                }
                if (vscodeApi) vscodeApi.postMessage({ type: 'action', action: 'listBuiltTests' });
            }
            render();
        }
    });
})();
