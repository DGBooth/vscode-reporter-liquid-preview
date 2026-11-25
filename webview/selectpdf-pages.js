// The HTML preview's "SelectPdf pages" view: the rendered template laid out and
// split into pages the way SelectPdf's HtmlToPdf converter splits it, drawn as
// numbered sheets.
//
// SelectPdf.Universal renders with Chromium, the same engine as this webview.
// It lays the page out in a window WebPageWidth px wide, scales the layout to
// the page (see selectpdf-page.js for the numbers), and lets Chromium's own
// fragmentation decide where pages end. A webview can't print, so the paging
// is done here instead, following the rules Chromium's paging follows:
//
//   - a forced break (break-before/after: page, page-break-*: always) starts a
//     new page, even in a nested element;
//   - otherwise the page ends at the last place content can break that still
//     fits: between blocks, between table rows, or between lines of text (a
//     line is never cut). A table row breaks inside too, each cell between
//     its own lines;
//   - places inside break-inside: avoid, next to break-before/after: avoid, or
//     that would leave fewer than `orphans` / `widows` lines (2) are used only
//     when nothing better fits;
//   - content that can't break at all and doesn't fit (a tall image) is cut
//     at the page end;
//   - with print media, a table's thead (display: table-header-group) repeats
//     at the top of each page the table continues onto.
//
// The page is laid out in a hidden iframe at the layout width, one page at a
// time: find where the page ends, push what follows down to the next page's
// top (a margin, or a spacer where there is no element to give one), measure
// again. Then each page is shown in its own iframe of the finished layout,
// scrolled to that page and scaled onto a sheet. Every such iframe holds the
// whole document, so only the sheets near the part of the panel in view are
// loaded; the rest are blank until they are scrolled to.
//
// The break choice itself (chooseNextBreak) and the media rewrite are plain
// functions, exported under Node for test/selectpdf-pages.test.js. In the
// webview this file is inlined as a script and wires itself to the toolbar's
// PDF preview tab.

(function (root) {
    'use strict';

    const EPS = 0.5;

    // ---- break choice -------------------------------------------------------

    // Where page that starts at `pageTop` ends. `candidates` are the places
    // content can break, in document order: { y, forced, avoid }, y being where
    // the content before the break ends. Returns
    //   { kind: 'end' }                      the rest of the content fits
    //   { kind: 'break', index, forced }     break at candidates[index]
    //   { kind: 'slice', y }                 nothing fits: cut at the page end
    function chooseNextBreak(candidates, pageTop, pageHeight, contentEnd) {
        const pageBottom = pageTop + pageHeight;
        const onPage = c => c.y > pageTop + EPS && c.y <= pageBottom + EPS;
        for (let i = 0; i < candidates.length; i++) {
            if (candidates[i].forced && onPage(candidates[i]) && candidates[i].y < contentEnd - EPS) {
                return { kind: 'break', index: i, forced: true };
            }
        }
        if (contentEnd <= pageBottom + EPS) return { kind: 'end' };
        let best = -1, fallback = -1;
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            if (!onPage(c)) continue;
            if (!c.avoid) { if (best === -1 || c.y >= candidates[best].y) best = i; }
            else if (fallback === -1 || c.y >= candidates[fallback].y) fallback = i;
        }
        if (best !== -1) return { kind: 'break', index: best, forced: false };
        if (fallback !== -1) return { kind: 'break', index: fallback, forced: false };
        return { kind: 'slice', y: pageBottom };
    }

    // The whole paging of a laid-out document, assuming that pushing content
    // after a break down moves everything after it by the same amount (true of
    // normal block flow). The webview measures again after each break instead;
    // this is for reasoning about and testing the choice. `next` on a candidate
    // is where the content after it starts (y by default).
    function chooseBreaks(candidates, pageHeight, contentEnd) {
        let list = candidates.map((c, i) => ({ ...c, index: i, next: c.next == null ? c.y : c.next }));
        let end = contentEnd;
        const pages = [];
        let pageTop = 0;
        for (let guard = 0; guard < 1000; guard++) {
            const choice = chooseNextBreak(list, pageTop, pageHeight, end);
            const nextTop = pageTop + pageHeight;
            if (choice.kind === 'end') {
                pages.push({ top: pageTop, end: 'end' });
                return { pages, contentEnd: end };
            }
            if (choice.kind === 'slice') {
                pages.push({ top: pageTop, end: 'slice' });
            } else {
                const c = list[choice.index];
                pages.push({ top: pageTop, end: 'break', at: c.index, forced: choice.forced });
                const shift = nextTop - c.next;
                list = list.map((d, i) => i > choice.index ? { ...d, y: d.y + shift, next: d.next + shift } : d);
                // The candidate itself is used up.
                list[choice.index] = { ...c, y: -Infinity };
                end += shift;
            }
            pageTop = nextTop;
        }
        return { pages, contentEnd: end };
    }

    // ---- print media --------------------------------------------------------

    const MEDIA_TYPES = /^(all|print|screen|speech|tty|tv|projection|handheld|braille|embossed|aural)$/i;

    // A media query list rewritten so it means, on a screen, what it means on
    // `medium` ('print' or 'screen'): `print` becomes `all`, `screen` becomes
    // `not all`, and so on.
    function rewriteMediaText(text, medium) {
        if (!text || !text.trim()) return text;
        return text.split(',').map(query => {
            const m = /^\s*(?:(only|not)\s+)?([a-z-]+)?\s*(.*?)\s*$/i.exec(query);
            if (!m || !m[2] || !MEDIA_TYPES.test(m[2])) return query.trim();
            const prefix = (m[1] || '').toLowerCase();
            const type = m[2].toLowerCase();
            const rest = m[3] ? ' ' + m[3] : '';
            const matches = type === 'all' || type === medium;
            if (prefix === 'not') return matches ? 'not all' + rest : 'all';
            return matches ? 'all' + rest : 'not all';
        }).join(', ');
    }

    const api = { chooseNextBreak, chooseBreaks, rewriteMediaText };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
        return;
    }
    root.__rlpSelectPdf = api;

    // ---- in the webview -----------------------------------------------------

    const document = root.document;

    function applyMedia(doc, medium) {
        if (medium !== 'print') return;
        const rewriteRules = rules => {
            for (const rule of Array.from(rules || [])) {
                try {
                    if (rule.media && rule.media.mediaText) rule.media.mediaText = rewriteMediaText(rule.media.mediaText, medium);
                    if (rule.styleSheet) rewriteRules(rule.styleSheet.cssRules);
                    if (rule.cssRules) rewriteRules(rule.cssRules);
                } catch (err) { /* a sheet from elsewhere can't be read; leave it */ }
            }
        };
        for (const sheet of Array.from(doc.styleSheets)) {
            try {
                if (sheet.media && sheet.media.mediaText) sheet.media.mediaText = rewriteMediaText(sheet.media.mediaText, medium);
                rewriteRules(sheet.cssRules);
            } catch (err) { /* as above */ }
        }
    }

    // ---- measuring ----

    const FORCED = /^(page|left|right|recto|verso|always)$/;
    const AVOID = /^(avoid|avoid-page)$/;
    const MONOLITHIC_TAGS = /^(IMG|SVG|CANVAS|VIDEO|AUDIO|IFRAME|OBJECT|EMBED|INPUT|TEXTAREA|SELECT|BUTTON|METER|PROGRESS|svg)$/;
    const SKIP_TAGS = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD|TITLE|META|LINK)$/;

    function breakValue(style, which) {
        // Chromium maps page-break-* onto break-*, but read both to be sure.
        const modern = style['break' + which] || '';
        const legacy = style['pageBreak' + which] || '';
        if (FORCED.test(modern) || legacy === 'always' || legacy === 'left' || legacy === 'right') return 'forced';
        if (AVOID.test(modern) || legacy === 'avoid') return 'avoid';
        return '';
    }

    function makeMeasurer(doc, { keepLinesTogether = true } = {}) {
        const win = doc.defaultView;
        const styleOf = el => win.getComputedStyle(el);
        const scrollY = () => win.scrollY || 0;
        const rectOf = node => {
            if (node.nodeType === 1) return node.getBoundingClientRect();
            const range = doc.createRange();
            range.selectNodeContents(node);
            return range.getBoundingClientRect();
        };
        const top = node => rectOf(node).top + scrollY();

        // The in-flow children of `el`, each a block (an element) or a run of
        // inline content (text and inline elements between blocks).
        function items(el) {
            const out = [];
            let run = null;
            const visit = parent => {
                for (const node of Array.from(parent.childNodes)) {
                    if (node.nodeType === 3) {
                        if (!node.data.trim() && !run) continue;
                        (run = run || { kind: 'run', nodes: [] }).nodes.push(node);
                        continue;
                    }
                    if (node.nodeType !== 1 || SKIP_TAGS.test(node.tagName) || node.hasAttribute('data-rlp-spacer')) continue;
                    const style = styleOf(node);
                    if (style.display === 'none') continue;
                    if (style.display === 'contents') { visit(node); continue; }
                    if (style.position === 'absolute' || style.position === 'fixed') continue;
                    if (style.float !== 'none') continue;
                    if (/^inline|^ruby/.test(style.display) || node.tagName === 'BR') {
                        (run = run || { kind: 'run', nodes: [] }).nodes.push(node);
                        continue;
                    }
                    if (run) { out.push(run); run = null; }
                    out.push({ kind: 'el', el: node, style });
                }
            };
            visit(el);
            if (run) out.push(run);
            for (const item of out) {
                if (item.kind === 'el') {
                    const r = item.el.getBoundingClientRect();
                    item.top = r.top + scrollY();
                    item.bottom = r.bottom + scrollY();
                } else {
                    const range = doc.createRange();
                    range.setStartBefore(item.nodes[0]);
                    range.setEndAfter(item.nodes[item.nodes.length - 1]);
                    const r = range.getBoundingClientRect();
                    item.top = r.top + scrollY();
                    item.bottom = r.bottom + scrollY();
                    item.empty = r.height === 0;
                }
            }
            const filtered = out.filter(item => !item.empty);
            // A table's row groups and a column flexbox's items are stacked in
            // the order they show, which needn't be the source order.
            const display = styleOf(el).display;
            if (/table|flex/.test(display)) filtered.sort((a, b) => a.top - b.top);
            return filtered;
        }

        // Whether the content inside `el` can break, and how its children
        // stack: blocks, table rows, or not at all.
        function fragmentable(el, style) {
            if (MONOLITHIC_TAGS.test(el.tagName)) return false;
            if (/^(auto|scroll)$/.test(style.overflowY)) return false;
            if (style.display === 'table-row' || /^inline/.test(style.display)) return false;
            if (/grid/.test(style.display)) return false;
            if (/flex/.test(style.display)) return /column/.test(style.flexDirection) && style.flexWrap === 'nowrap';
            return true;
        }

        // Whether `el` or the first (last) in-flow element down its first
        // (last) children starts (ends) with a break of the given kind.
        function chainBreak(el, which, kind) {
            for (let node = el, depth = 0; node && depth < 50; depth++) {
                const style = styleOf(node);
                if (breakValue(style, which) === kind) return true;
                node = edgeBlock(node, which === 'Before');
            }
            return false;
        }

        // The block that starts (ends) `el`'s content, or null when text or
        // other inline content comes first (last): a break before a block
        // that follows text falls after that text, not before `el`.
        function edgeBlock(el, first) {
            const nodes = Array.from(el.childNodes);
            if (!first) nodes.reverse();
            for (const node of nodes) {
                if (node.nodeType === 3) {
                    if (node.data.trim()) return null;
                    continue;
                }
                if (node.nodeType !== 1 || SKIP_TAGS.test(node.tagName) || node.hasAttribute('data-rlp-spacer')) continue;
                const style = styleOf(node);
                if (style.display === 'none') continue;
                if (style.position === 'absolute' || style.position === 'fixed' || style.float !== 'none') continue;
                if (style.display === 'contents') {
                    const inner = edgeBlock(node, first);
                    if (inner) return inner;
                    if (node.textContent.trim()) return null;
                    continue;
                }
                if (/^inline|^ruby/.test(style.display) || node.tagName === 'BR') return null;
                return node;
            }
            return null;
        }

        // The line boxes of a run of inline content.
        function lines(nodes) {
            const frags = [];
            const visit = node => {
                if (node.nodeType === 3) {
                    if (!node.data.length) return;
                    const range = doc.createRange();
                    range.selectNodeContents(node);
                    Array.from(range.getClientRects()).forEach((r, i) => {
                        if (r.height > 0 && r.width > 0) frags.push({ node, rectIndex: i, top: r.top + scrollY(), bottom: r.bottom + scrollY() });
                    });
                    return;
                }
                if (node.nodeType !== 1 || SKIP_TAGS.test(node.tagName) || node.hasAttribute('data-rlp-spacer')) return;
                const style = styleOf(node);
                if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') return;
                if (style.display === 'inline' || style.display === 'contents') {
                    Array.from(node.childNodes).forEach(visit);
                    return;
                }
                const r = node.getBoundingClientRect();
                if (r.height > 0) frags.push({ el: node, top: r.top + scrollY(), bottom: r.bottom + scrollY() });
            };
            nodes.forEach(visit);
            const out = [];
            for (const frag of frags) {
                const line = out[out.length - 1];
                if (line && frag.top < line.bottom - 1) {
                    line.top = Math.min(line.top, frag.top);
                    line.bottom = Math.max(line.bottom, frag.bottom);
                } else {
                    out.push({ top: frag.top, bottom: frag.bottom, start: frag });
                }
            }
            return out;
        }

        // Where the text of a line starts, as a node to insert before.
        function lineStart(frag) {
            if (frag.el) return frag.el;
            const node = frag.node;
            if (frag.rectIndex === 0) return node;
            const range = doc.createRange();
            const onLine = offset => {
                range.setStart(node, offset);
                range.setEnd(node, offset + 1);
                const rects = range.getClientRects();
                const r = rects[rects.length - 1];
                return r && r.height > 0 && r.top + scrollY() >= frag.top - 1;
            };
            let lo = 0, hi = node.data.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (onLine(mid)) hi = mid; else lo = mid + 1;
            }
            return lo > 0 ? node.splitText(lo) : node;
        }

        // The places the content between pageTop and pageBottom can break.
        function candidates(body, pageTop, pageBottom, printMedia, avoidAll = false) {
            const out = [];
            const walk = (el, avoidInside, depth) => {
                if (depth > 200) return;
                const list = items(el);
                for (let i = 0; i < list.length; i++) {
                    const item = list[i];
                    const prev = list[i - 1];
                    if (prev && prev.bottom > pageTop - EPS) {
                        const forced = (prev.kind === 'el' && chainBreak(prev.el, 'After', 'forced'))
                            || (item.kind === 'el' && chainBreak(item.el, 'Before', 'forced'));
                        const avoid = avoidInside
                            || (prev.kind === 'el' && breakValue(prev.style, 'After') === 'avoid')
                            || (item.kind === 'el' && breakValue(item.style, 'Before') === 'avoid');
                        out.push({ y: prev.bottom, next: item.top, forced, avoid, apply: { type: 'before', item, container: el, printMedia } });
                    }
                    if (item.top > pageBottom + EPS) break;
                    if (item.bottom < pageTop - EPS) continue;
                    if (item.kind === 'el') {
                        if (fragmentable(item.el, item.style)) {
                            walk(item.el, avoidInside || breakValue(item.style, 'Inside') === 'avoid', depth + 1);
                        } else if (item.style.display === 'table-row' && depth < 200 && item.top < pageBottom && item.bottom > pageBottom + EPS) {
                            const inRow = rowBreak(item, avoidInside || breakValue(item.style, 'Inside') === 'avoid', pageTop, pageBottom, printMedia);
                            if (inRow) out.push(inRow);
                        }
                    } else if (item.top < pageBottom && item.bottom > pageBottom) {
                        const style = styleOf(el);
                        // Without keeping lines together (the engine Reporter
                        // uses doesn't), one line may be left either side.
                        const orphans = keepLinesTogether ? parseInt(style.orphans, 10) || 2 : 1;
                        const widows = keepLinesTogether ? parseInt(style.widows, 10) || 2 : 1;
                        const ls = lines(item.nodes);
                        for (let j = 1; j < ls.length; j++) {
                            const boundary = (ls[j - 1].bottom + ls[j].top) / 2;
                            out.push({
                                y: boundary,
                                next: boundary,
                                forced: false,
                                avoid: avoidInside || j < orphans || ls.length - j < widows,
                                apply: { type: 'line', line: ls[j], boundary }
                            });
                        }
                    }
                }
            };
            walk(body, avoidAll, 0);
            return out;
        }

        // A break inside a table row that runs past the page end. Chromium
        // breaks each cell's content on its own, wherever that cell can break,
        // and lines the cells of a row it has broken up at the top. So the
        // break is one in each cell that needs it, taken together; a cell
        // that can't break before the page end makes it a place to avoid.
        function rowBreak(row, avoid, pageTop, pageBottom, printMedia) {
            const table = row.el.closest('table');
            // Not under a repeating header: the rest of the row would have to
            // start below a header drawn in the middle of the row. The row is
            // kept whole there (see the README).
            if (printMedia && table && repeatsHeader(table, row.el)) return null;
            const cells = Array.from(row.el.children).filter(c => styleOf(c).display === 'table-cell');
            const restore = alignTop(cells);
            const parts = [];
            let y = -Infinity;
            for (const cell of cells) {
                const range = doc.createRange();
                range.selectNodeContents(cell);
                const r = range.getBoundingClientRect();
                if (!r.height) continue;
                const end = r.bottom + scrollY();
                if (end <= pageBottom + EPS) continue;
                const style = styleOf(cell);
                if (!fragmentable(cell, style)) { avoid = true; continue; }
                const list = candidates(cell, pageTop, pageBottom, printMedia, breakValue(style, 'Inside') === 'avoid');
                const choice = chooseNextBreak(list, pageTop, pageBottom - pageTop, end);
                if (choice.kind !== 'break') { avoid = true; continue; }
                const part = list[choice.index];
                if (part.avoid) avoid = true;
                parts.push(part);
                y = Math.max(y, part.y);
            }
            restore();
            if (!parts.length) return null;
            return { y, next: y, forced: false, avoid, apply: { type: 'row', cells, parts } };
        }

        // Whether `table` has a header that repeats on each page (print
        // media), for a break before `first`.
        function repeatsHeader(table, first) {
            const thead = table.tHead;
            return !!thead && styleOf(thead).display === 'table-header-group' && !thead.contains(first) && first !== thead;
        }

        function contentEnd(doc) {
            const html = doc.documentElement.getBoundingClientRect();
            const body = doc.body ? doc.body.getBoundingClientRect() : html;
            const marginBottom = doc.body ? parseFloat(styleOf(doc.body).marginBottom) || 0 : 0;
            return Math.max(html.bottom, body.bottom + marginBottom) + scrollY();
        }

        return { styleOf, top, candidates, contentEnd, lineStart, repeatsHeader };
    }

    // Line the cells of a row up at the top, as Chromium does in a row it
    // breaks. Returns a function that puts them back.
    function alignTop(cells) {
        const before = cells.map(cell => [cell.style.getPropertyValue('vertical-align'), cell.style.getPropertyPriority('vertical-align')]);
        cells.forEach(cell => cell.style.setProperty('vertical-align', 'top', 'important'));
        return () => cells.forEach((cell, i) => {
            if (before[i][0]) cell.style.setProperty('vertical-align', before[i][0], before[i][1]);
            else cell.style.removeProperty('vertical-align');
        });
    }

    // ---- pushing content to the next page ----

    // Adjust `set(amount)` until measure() reads `target`. A few rounds, since
    // collapsing margins and table spacing make the first guess land short.
    function settle(set, measure, target, start = 0, min = 0) {
        let amount = start;
        set(amount);
        for (let round = 0; round < 4; round++) {
            const off = target - measure();
            if (Math.abs(off) <= 0.25) break;
            amount = Math.max(min, amount + off);
            set(amount);
        }
    }

    function spacerStyle(el) {
        for (const [prop, value] of [['display', 'block'], ['margin', '0'], ['padding', '0'], ['border', '0'], ['float', 'none'], ['position', 'static'], ['width', 'auto'], ['min-height', '0'], ['break-before', 'auto'], ['break-after', 'auto']]) {
            el.style.setProperty(prop, value, 'important');
        }
    }

    // Give `clone` and everything in it the look of `original`. A header row
    // repeated among the body rows is no longer matched by rules written for
    // the header ("thead th"), so what those rules gave it is copied over.
    const LOOK = /^(background|border|color|font|text|padding|vertical-align|white-space|letter-spacing|word-spacing|line-height|opacity|box-shadow|outline)/;
    function copyLook(m, original, clone) {
        const style = m.styleOf(original);
        for (let i = 0; i < style.length; i++) {
            const prop = style[i];
            if (LOOK.test(prop)) clone.style.setProperty(prop, style.getPropertyValue(prop));
        }
        for (let i = 0; i < original.children.length && i < clone.children.length; i++) copyLook(m, original.children[i], clone.children[i]);
    }

    function applyBreak(doc, m, candidate, nextPageTop) {
        const a = candidate.apply;
        if (a.type === 'row') {
            alignTop(a.cells);
            for (const part of a.parts) applyBreak(doc, m, part, nextPageTop);
            return;
        }
        if (a.type === 'line') {
            const anchor = m.lineStart(a.line.start);
            // The line moves as a whole, so its first fragment keeps the same
            // distance from the line's top. (A tall inline box can make the
            // line's top lie well above that fragment's text.)
            const offset = a.line.start.top - a.boundary;
            const spacer = doc.createElement('span');
            spacer.setAttribute('data-rlp-spacer', '');
            spacer.setAttribute('aria-hidden', 'true');
            spacerStyle(spacer);
            anchor.parentNode.insertBefore(spacer, anchor);
            // The spacer ends the line before it, and the last line of
            // justified text isn't justified. So in justified text that line
            // is ended by wrapping instead: a full-width inline box wraps onto
            // a line of its own, which the spacer's negative margin takes
            // back when the push needed is less than that line's height.
            let block = anchor.parentNode;
            while (block && block.nodeType === 1 && /^(inline|contents)$/.test(m.styleOf(block).display)) block = block.parentNode;
            const justified = block && block.nodeType === 1 && m.styleOf(block).textAlign === 'justify';
            if (justified) {
                const wrap = doc.createElement('span');
                wrap.setAttribute('data-rlp-spacer', '');
                wrap.setAttribute('aria-hidden', 'true');
                spacerStyle(wrap);
                for (const [prop, value] of [['display', 'inline-block'], ['width', '100%'], ['height', '0'], ['vertical-align', 'top']]) wrap.style.setProperty(prop, value, 'important');
                spacer.parentNode.insertBefore(wrap, spacer);
            }
            settle(h => {
                spacer.style.setProperty('height', Math.max(0, h) + 'px', 'important');
                spacer.style.setProperty('margin-top', Math.min(0, h) + 'px', 'important');
            }, () => m.top(anchor), nextPageTop + offset, 0, justified ? -1000 : 0);
            return;
        }

        const { item, container, printMedia } = a;
        const containerDisplay = m.styleOf(container).display;
        const target = item.kind === 'el' && candidate.forced
            ? nextPageTop + (parseFloat(item.style.marginTop) || 0)
            : nextPageTop;
        const first = item.kind === 'el' ? item.el : item.nodes[0];

        // Table rows: a spacer row, then (print media) the header rows again.
        const rowGroup = /^table-(row|header|footer)-group$/.test(containerDisplay);
        if (rowGroup || containerDisplay === 'table' || containerDisplay === 'inline-table') {
            const table = container.closest('table') || container;
            const thead = table.tHead;
            const repeat = printMedia && m.repeatsHeader(table, first);
            const rows = [];
            const spacerRow = doc.createElement('tr');
            spacerRow.setAttribute('data-rlp-spacer', '');
            spacerRow.setAttribute('aria-hidden', 'true');
            const cell = doc.createElement('td');
            cell.colSpan = 1000;
            for (const [prop, value] of [['padding', '0'], ['border', '0'], ['background', 'none']]) cell.style.setProperty(prop, value, 'important');
            spacerRow.appendChild(cell);
            rows.push(spacerRow);
            const headerRows = repeat ? Array.from(thead.rows).map(r => {
                const clone = r.cloneNode(true);
                clone.setAttribute('data-rlp-repeated-header', '');
                copyLook(m, r, clone);
                return clone;
            }) : [];
            rows.push(...headerRows);
            // Keep the count even, so :nth-child(odd/even) stripes don't swap.
            if (rows.length % 2) {
                const pad = doc.createElement('tr');
                pad.setAttribute('data-rlp-spacer', '');
                pad.setAttribute('aria-hidden', 'true');
                for (const [prop, value] of [['height', '0'], ['visibility', 'collapse']]) pad.style.setProperty(prop, value, 'important');
                rows.splice(1, 0, pad);
            }
            let holder = null;
            if (rowGroup) {
                for (const r of rows) container.insertBefore(r, first);
            } else {
                holder = doc.createElement('tbody');
                holder.setAttribute('data-rlp-spacer-group', '');
                rows.forEach(r => holder.appendChild(r));
                container.insertBefore(holder, first);
            }
            const measured = headerRows[0] || first;
            settle(h => cell.style.setProperty('height', h + 'px', 'important'), () => m.top(measured), headerRows.length ? nextPageTop : target);
            return;
        }

        if (item.kind === 'el') {
            // Push the block down with its own top margin: no element is added,
            // so selectors such as p + p and :nth-child still match the same.
            const start = parseFloat(item.style.marginTop) || 0;
            settle(mt => item.el.style.setProperty('margin-top', mt + 'px', 'important'), () => m.top(item.el), target, start);
            return;
        }

        const spacer = doc.createElement(/^inline/.test(containerDisplay) ? 'span' : 'div');
        spacer.setAttribute('data-rlp-spacer', '');
        spacer.setAttribute('aria-hidden', 'true');
        spacerStyle(spacer);
        first.parentNode.insertBefore(spacer, first);
        settle(h => spacer.style.setProperty('height', h + 'px', 'important'), () => m.top(first), target);
    }

    // ---- building the pages ----

    // No scrollbar to take width from the layout.
    const PAGE_STYLES = 'html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; width: 0; height: 0; }';

    function loadFrame(frame, html, isCurrent) {
        return new Promise(resolve => {
            frame.addEventListener('load', () => resolve(isCurrent()), { once: true });
            frame.srcdoc = html;
        });
    }

    async function settled(doc) {
        try {
            await Promise.race([doc.fonts && doc.fonts.ready, new Promise(r => setTimeout(r, 1500))]);
        } catch (err) { /* fonts are optional */ }
    }

    // A <style> at the start of <head> (before the template's own styles, so
    // they win) or, with `last`, at its end.
    function addStyle(doc, css, last = false) {
        if (!css) return;
        const style = doc.createElement('style');
        style.setAttribute('data-rlp-injected', '');
        style.textContent = css;
        const head = doc.head || doc.documentElement;
        head.insertBefore(style, last ? null : head.firstChild);
    }

    // Lay the document out and split it into pages. Returns the paged HTML and
    // the numbers the sheets are drawn from, or null if a newer run took over.
    async function paginate(host, config, isCurrent) {
        const g = config.geometry;
        const medium = g.cssMediaType === 'Print' ? 'print' : 'screen';
        let layoutWidth = g.webPageWidth;
        let scale = g.scale;
        let pageHeight = g.layoutPageHeight;

        const frame = document.createElement('iframe');
        frame.className = 'lp-pages-measure';
        frame.setAttribute('aria-hidden', 'true');
        frame.style.width = layoutWidth + 'px';
        frame.style.height = pageHeight + 'px';
        host.appendChild(frame);
        try {
            if (!await loadFrame(frame, config.html, isCurrent)) return null;
            const doc = frame.contentDocument;
            // The workspace CSS goes ahead of the template's own styles, as the
            // preview links it; customCss is SelectPdf's CustomCSS, which goes
            // after them.
            addStyle(doc, config.css);
            addStyle(doc, g.customCss, true);
            addStyle(doc, PAGE_STYLES, true);
            // The text spacing calibration: on the body, so an element that
            // sets its own letter-spacing keeps it.
            if (g.textSpacing) addStyle(doc, `body { letter-spacing: ${g.textSpacing}px; }`, true);
            applyMedia(doc, medium);
            await settled(doc);
            if (!isCurrent()) return null;

            // The CSS's @page left and right margins, kept clear on the
            // paper: the text is laid out in the column between them, at the
            // same scale.
            const inset = g.pageMarginSides ? pageSideMargins(doc) : { left: 0, right: 0 };
            let widened = false;
            if (inset.left || inset.right) {
                layoutWidth = Math.max(100, g.webPageWidth - (inset.left + inset.right) / scale);
                frame.style.width = layoutWidth + 'px';
                await settled(doc);
                if (!isCurrent()) return null;
            }

            // With the @page side margins, what's wider than the column is
            // fitted into it, as production evidently does: a letter whose
            // section is fixed at 1024px wraps there at the column between the
            // margins, rather than being cut off at it. Each is held to the
            // width it's in (max-width: 100%, its padding and border inside),
            // in its own style, so the pages drawn from this copy match.
            const fitted = [];
            if (inset.left || inset.right) {
                for (let round = 0; round < 5; round++) {
                    const wide = widerThanLayout(doc, layoutWidth);
                    if (!wide.length) break;
                    for (const item of wide) {
                        item.element.style.setProperty('max-width', '100%', 'important');
                        item.element.style.setProperty('box-sizing', 'border-box', 'important');
                        if (!fitted.some(f => f.element === item.element)) fitted.push(item);
                    }
                }
            }

            // What runs past the layout's right edge, before FitWideContent
            // widens the layout to take it in.
            const overflow = widerThanLayout(doc, layoutWidth);

            if (g.fitWideContent) {
                const wide = doc.documentElement.scrollWidth;
                if (wide > layoutWidth + 1) {
                    widened = true;
                    layoutWidth = Math.min(wide, 4 * g.webPageWidth);
                    scale = g.content.width / layoutWidth;
                    pageHeight = g.content.height / scale;
                    frame.style.width = layoutWidth + 'px';
                    frame.style.height = pageHeight + 'px';
                }
            }

            const m = makeMeasurer(doc, { keepLinesTogether: g.keepLinesTogether });
            let pageTop = 0;
            let pages = 1;
            for (let guard = 0; guard < 500; guard++) {
                const end = m.contentEnd(doc);
                const list = doc.body ? m.candidates(doc.body, pageTop, pageTop + pageHeight, medium === 'print') : [];
                const choice = chooseNextBreak(list, pageTop, pageHeight, end);
                if (choice.kind === 'end') break;
                if (choice.kind === 'break') applyBreak(doc, m, list[choice.index], pageTop + pageHeight);
                pageTop += pageHeight;
                pages++;
                if (guard % 10 === 9) {
                    await new Promise(r => setTimeout(r, 0));
                    if (!isCurrent()) return null;
                }
            }
            const end = m.contentEnd(doc);
            const lastHeight = g.allowContentHeightResize
                ? Math.max(1, Math.min(pageHeight, end - (pages - 1) * pageHeight))
                : pageHeight;

            // The scripts have run and their work is in the page; the copies
            // the pages are shown in mustn't run them again.
            doc.querySelectorAll('script').forEach(s => s.remove());
            const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}${doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ''}${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ''}>` : '';
            const describe = list => list.map(({ name, width, declared }) => ({ name, width, declared }));
            return { html: doctype + doc.documentElement.outerHTML, pages, pageHeight, lastHeight, scale, layoutWidth, medium, inset, widened, overflow: describe(overflow), fitted: describe(fitted) };
        } finally {
            frame.remove();
        }
    }

    // The outermost elements whose right edge runs past the layout width, as
    // { name, width, right, declared }: the ones whose own box is too wide,
    // not their children, which only follow them. A box set in a fixed width
    // doesn't narrow with the layout, so its text doesn't re-wrap, and the
    // part past the page's edge is cut off, in production as here. `declared`
    // is the width its CSS gives it (width, min-width), when not auto.
    function widerThanLayout(doc, layoutWidth) {
        if (!doc.body) return [];
        const win = doc.defaultView;
        const found = [];
        const visit = (el, parentWide) => {
            for (const child of Array.from(el.children)) {
                const rect = child.getBoundingClientRect();
                const right = rect.right + win.scrollX;
                const wide = rect.width > 0 && right > layoutWidth + 1;
                if (wide && !parentWide && found.length < 3) {
                    const style = win.getComputedStyle(child);
                    const declared = ['width', 'min-width'].map(prop => {
                        const inline = child.style && child.style.getPropertyValue(prop);
                        return inline ? `${prop}: ${inline}` : '';
                    }).filter(Boolean);
                    if (!declared.length) declared.push(...cssWidths(doc, child));
                    if (!declared.length && child.getAttribute('width')) declared.push(`width="${child.getAttribute('width')}"`);
                    if (!declared.length && style.minWidth && style.minWidth !== '0px' && style.minWidth !== 'auto') declared.push(`min-width: ${style.minWidth}`);
                    const id = child.id ? '#' + child.id : '';
                    const classes = child.classList && child.classList.length ? '.' + Array.from(child.classList).slice(0, 2).join('.') : '';
                    found.push({ element: child, name: child.tagName.toLowerCase() + id + classes, width: Math.round(rect.width), right: Math.round(right), declared: declared.join(', ') });
                }
                if (found.length < 3) visit(child, parentWide || wide);
            }
        };
        visit(doc.body, false);
        return found;
    }

    // The width and min-width the stylesheets give an element, last rule
    // winning, as "selector { width: … }".
    function cssWidths(doc, element) {
        const hits = {};
        const visit = rules => {
            for (const rule of Array.from(rules || [])) {
                try {
                    if (rule.selectorText && rule.style) {
                        if (!element.matches(rule.selectorText)) continue;
                        for (const prop of ['width', 'min-width']) {
                            const value = rule.style.getPropertyValue(prop);
                            if (value && value !== 'auto') hits[prop] = `${rule.selectorText} { ${prop}: ${value} }`;
                        }
                    } else if (rule.cssRules) {
                        visit(rule.cssRules);
                    }
                } catch (err) { /* a selector or rule this engine can't read */ }
            }
        };
        for (const sheet of Array.from(doc.styleSheets)) {
            try { visit(sheet.cssRules); } catch (err) { /* a sheet from elsewhere can't be read */ }
        }
        return Object.values(hits);
    }

    // The left and right margins of the document's @page rules (those for every
    // page: no :first, :left or :right), in px on the paper (CSS px at 96dpi,
    // as the sheets are drawn). A length is measured by the document itself, so
    // mm, pt, in and px all come out right.
    function pageSideMargins(doc) {
        const out = { left: 0, right: 0 };
        const measure = value => {
            if (!value || value === 'auto') return 0;
            const probe = doc.createElement('div');
            probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:' + value;
            (doc.body || doc.documentElement).appendChild(probe);
            const width = probe.getBoundingClientRect().width;
            probe.remove();
            return Number.isFinite(width) ? width : 0;
        };
        const visit = rules => {
            for (const rule of Array.from(rules || [])) {
                try {
                    const isPage = (root.CSSPageRule && rule instanceof doc.defaultView.CSSPageRule) || rule.type === 6;
                    if (isPage && !String(rule.selectorText || '').trim()) {
                        const left = rule.style.getPropertyValue('margin-left');
                        const right = rule.style.getPropertyValue('margin-right');
                        if (left) out.left = measure(left);
                        if (right) out.right = measure(right);
                    } else if (rule.cssRules) {
                        visit(rule.cssRules);
                    }
                } catch (err) { /* a rule that can't be read; leave it */ }
            }
        };
        for (const sheet of Array.from(doc.styleSheets)) {
            try { visit(sheet.cssRules); } catch (err) { /* a sheet from elsewhere can't be read */ }
        }
        return out;
    }

    function el(tag, className, style) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (style) Object.assign(node.style, style);
        return node;
    }

    const px = n => n + 'px';

    function bandShown(band, number) {
        if (!band) return false;
        if (number === 1) return band.displayOnFirstPage;
        return number % 2 ? band.displayOnOddPages : band.displayOnEvenPages;
    }

    function drawSheets(config, result) {
        const g = config.geometry;
        const sheets = el('div', 'lp-sheets');
        const pages = [];
        for (let k = 0; k < result.pages; k++) {
            const number = k + 1;
            const last = k === result.pages - 1;
            const windowHeight = (last ? result.lastHeight : result.pageHeight) * result.scale;
            const sheetHeight = last && g.allowContentHeightResize
                ? g.page.height - g.content.height + windowHeight
                : g.page.height;
            const sheet = el('div', 'lp-sheet', { width: px(g.page.width), height: px(sheetHeight) });
            sheet.setAttribute('aria-label', `Page ${number} of ${result.pages}`);

            const inset = result.inset || { left: 0, right: 0 };
            const win = el('div', 'lp-sheet-content', {
                left: px(g.content.left + inset.left), top: px(g.content.top),
                width: px(g.content.width - inset.left - inset.right), height: px(windowHeight)
            });
            const frame = el('iframe', null, {
                width: px(result.layoutWidth), height: px(result.pageHeight),
                transform: `scale(${result.scale})`
            });
            frame.setAttribute('scrolling', 'no');
            frame.setAttribute('tabindex', '-1');
            frame.title = `Page ${number}`;
            win.appendChild(frame);
            sheet.appendChild(win);

            const bands = [['header', g.header, g.margins.top], ['footer', g.footer, sheetHeight - g.margins.bottom - (g.footer ? g.footer.height : 0)]];
            for (const [name, band, top] of bands) {
                if (!band) continue;
                const shown = bandShown(band, number);
                const node = el('div', 'lp-band' + (shown ? '' : ' lp-band-hidden'), {
                    left: px(g.content.left), top: px(top), width: px(g.content.width), height: px(band.height)
                });
                node.textContent = shown ? `${name} · ${band.heightPt}pt` : `${name} not shown on this page`;
                sheet.appendChild(node);
            }
            const label = el('div', 'lp-sheet-number');
            label.textContent = `${number} / ${result.pages}`;
            sheet.appendChild(label);
            sheets.appendChild(sheet);

            // Not { once: true }: emptying the frame loads a blank page, and
            // that load mustn't be taken for the document's.
            const page = { sheet, frame, shown: false, loaded: null };
            frame.addEventListener('load', () => {
                if (!page.shown) return;
                try {
                    const doc = frame.contentDocument;
                    applyMedia(doc, result.medium);
                    // Room to scroll the last page to its top.
                    addStyle(doc, `html::after { content: ""; display: block; height: ${result.pageHeight}px; }`, true);
                    frame.contentWindow.scrollTo(0, k * result.pageHeight);
                } catch (err) { /* leave the page at the top */ }
                if (page.loaded) page.loaded();
            });
            pages.push(page);
        }

        // Load a sheet's page; resolves when it is in place.
        const show = page => {
            if (page.shown) return Promise.resolve();
            page.shown = true;
            return new Promise(resolve => {
                page.loaded = () => { page.loaded = null; resolve(); };
                page.frame.srcdoc = result.html;
            });
        };
        const hide = page => {
            if (!page.shown) return;
            page.shown = false;
            if (page.loaded) page.loaded();
            page.frame.removeAttribute('srcdoc');
        };

        // The sheets within two panel heights of what is in view.
        const near = () => {
            const reach = 2 * (root.innerHeight || document.documentElement.clientHeight || 800);
            return pages.filter(page => {
                const r = page.sheet.getBoundingClientRect();
                return r.bottom > -reach && r.top < (root.innerHeight || 0) + reach;
            });
        };
        let observer = null;
        // Start loading as sheets come near, and from then on keep to those.
        const watch = () => {
            if (typeof root.IntersectionObserver !== 'function') return Promise.all(pages.map(show));
            const first = Promise.all(near().map(show));
            const bySheet = new Map(pages.map(page => [page.sheet, page]));
            observer = new root.IntersectionObserver(entries => {
                for (const entry of entries) {
                    const page = bySheet.get(entry.target);
                    if (!page) continue;
                    if (entry.isIntersecting) show(page); else hide(page);
                }
            }, { rootMargin: '200% 0px' });
            pages.forEach(page => observer.observe(page.sheet));
            return first;
        };
        sheets._rlpDiscard = () => {
            if (observer) observer.disconnect();
            sheets.remove();
        };
        return { sheets, watch };
    }

    // Take sheets out of the panel, and stop loading pages into them.
    function discard(sheets) {
        if (sheets._rlpDiscard) sheets._rlpDiscard(); else sheets.remove();
    }

    // ---- the toolbar's PDF preview tab ----

    const toggle = () => document.getElementById('lp-selectpdf');
    const active = () => !!(toggle() && toggle().checked);
    const host = () => document.getElementById('lp-pages');
    let run = 0;
    let timer = null;
    let lastCount = null;

    // What to page, as the extension sent it, with the page worked out again
    // from any settings being tried in the page settings panel.
    function readConfig() {
        const node = document.getElementById('lp-selectpdf-config');
        if (!node) return null;
        let config;
        try { config = JSON.parse(node.textContent); } catch (err) { return null; }
        if (trial && config.settings && geometryApi()) {
            // A value tried and since saved is the setting now, not a trial.
            for (const name of Object.keys(trial)) {
                if (JSON.stringify(trial[name]) === JSON.stringify(config.settings[name])) delete trial[name];
            }
            if (!Object.keys(trial).length) trial = null;
            else config.geometry = geometryApi().pageGeometry(Object.assign({}, config.settings, trial));
        }
        return config;
    }

    // ---- trying page settings ----
    // The page settings panel: values tried there page this view as if they
    // were the reporterLiquidPreview.selectPdf settings, so they can be dialled
    // in beside a PDF from production, until they're saved (the extension
    // writes them to the workspace settings) or reverted. They last as long as
    // the panel does. The page is worked out by the same code the extension
    // uses (selectpdf-page.js, inlined before this script).

    let trial = null;
    // The width the docked panel takes, its margin included (see the CSS).
    const TUNE_PANEL_ROOM = 304;
    const geometryApi = () => root.__rlpPageGeometry || null;

    const TUNE_FIELDS = [
        { name: 'pageSize', label: 'Page size', kind: 'select', options: () => Object.keys(geometryApi().PAGE_SIZES) },
        { name: 'orientation', label: 'Orientation', kind: 'select', options: () => ['Portrait', 'Landscape'] },
        { name: 'webPageWidth', label: 'Layout width', unit: 'px', kind: 'number', min: 100, step: 1 },
        { name: 'marginTop', label: 'Margin top', unit: 'pt', kind: 'number', min: 0, step: 0.5 },
        { name: 'marginRight', label: 'Margin right', unit: 'pt', kind: 'number', min: 0, step: 0.5 },
        { name: 'marginBottom', label: 'Margin bottom', unit: 'pt', kind: 'number', min: 0, step: 0.5 },
        { name: 'marginLeft', label: 'Margin left', unit: 'pt', kind: 'number', min: 0, step: 0.5 },
        { name: 'header', label: 'Header height', unit: 'pt', kind: 'band', min: 0, step: 0.5 },
        { name: 'footer', label: 'Footer height', unit: 'pt', kind: 'band', min: 0, step: 0.5 },
        { name: 'cssMediaType', label: 'CSS media', kind: 'select', options: () => ['Screen', 'Print'] },
        { name: 'fitWideContent', label: 'Fit wide content', kind: 'check' },
        { name: 'allowContentHeightResize', label: 'Shorten the last page', kind: 'check' },
        { name: 'keepLinesTogether', label: 'Keep 2 lines together at a break', kind: 'check' },
        { name: 'pageMarginSides', label: 'Use @page side margins', kind: 'check' },
        { name: 'textSpacing', label: 'Text spacing', unit: 'px', kind: 'number', min: -2, step: 0.05 }
    ];

    // The toolbar's description of the page, for the values being tried.
    function showGeometry(config) {
        const node = document.getElementById('lp-selectpdf-geometry');
        if (!node || !config || !geometryApi()) return;
        node.textContent = geometryApi().describeGeometry(config.geometry)
            + (config.definition ? ' \u00b7 page from definition.json' : config.definitionError ? ' \u00b7 definition.json can\u2019t be read' : '')
            + (trial ? ' \u00b7 trying, not saved' : '');
        node.classList.toggle('lp-trying', !!trial);
    }

    const tunePanel = () => document.getElementById('lp-tune');

    function buildTunePanel() {
        const panel = document.createElement('div');
        panel.id = 'lp-tune';
        panel.className = 'lp-tune';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Page settings');
        const rows = TUNE_FIELDS.map(field => {
            const id = 'lp-tune-' + field.name;
            let control;
            if (field.kind === 'select') {
                control = `<select id="${id}" data-tune-field="${field.name}">`
                    + field.options().map(option => `<option value="${option}">${option}</option>`).join('') + '</select>';
            } else if (field.kind === 'check') {
                control = `<input type="checkbox" id="${id}" data-tune-field="${field.name}">`;
            } else {
                control = `<span class="lp-tune-number"><input type="number" id="${id}" data-tune-field="${field.name}" min="${field.min}" step="${field.step}"><span>${field.unit}</span></span>`;
            }
            return `<label for="${id}">${field.label}</label>${control}`;
        }).join('');
        panel.innerHTML = '<div class="lp-tune-head"><b>Page settings</b><button type="button" class="lp-tune-close" data-tune="close" title="Close" aria-label="Close">\u00d7</button></div>'
            + '<p class="lp-tune-hint">Change these until the pages match a PDF from production: where each line wraps and each page ends. They page this view only, until saved.</p>'
            + '<p class="lp-tune-definition" id="lp-tune-definition" hidden></p>'
            + `<div class="lp-tune-grid">${rows}</div>`
            + '<div class="lp-tune-readout" id="lp-tune-readout"></div>'
            + '<div class="lp-tune-actions"><button type="button" data-tune="save">Save to workspace settings</button><button type="button" data-tune="revert">Revert</button></div>';
        document.body.appendChild(panel);
        return panel;
    }

    // Put the values in effect (the settings, and any being tried) into the
    // panel's controls.
    function fillTunePanel(config) {
        const panel = tunePanel();
        if (!panel || !config || !geometryApi()) return;
        const settings = geometryApi().normalizeSelectPdfSettings(Object.assign({}, config.settings || {}, trial || {}));
        for (const field of TUNE_FIELDS) {
            const input = panel.querySelector(`[data-tune-field="${field.name}"]`);
            if (!input) continue;
            if (field.kind === 'check') input.checked = !!settings[field.name];
            else if (field.kind === 'band') input.value = settings[field.name] ? settings[field.name].height : 0;
            else input.value = settings[field.name];
        }
        const custom = !!settings.customPageSize;
        const size = panel.querySelector('[data-tune-field="pageSize"]');
        // A custom size is shown as itself, not as the named size it overrides.
        let customOption = size.querySelector('option[data-custom]');
        if (custom) {
            if (!customOption) {
                customOption = document.createElement('option');
                customOption.setAttribute('data-custom', '');
                customOption.value = '';
                size.insertBefore(customOption, size.firstChild);
            }
            customOption.textContent = `${settings.customPageSize.width} \u00d7 ${settings.customPageSize.height}pt`;
            size.value = '';
        } else if (customOption) {
            customOption.remove();
        }
        size.disabled = custom;
        size.title = !custom ? ''
            : config.definition ? 'The page size is the template\u2019s definition.json\u2019s (select.widthPoints \u00d7 select.heightPoints)'
            : 'reporterLiquidPreview.selectPdf.customPageSize is set, and wins over this';
        const note = document.getElementById('lp-tune-definition');
        if (note && !config.definition) {
            note.hidden = !config.definitionPath;
            note.textContent = config.definitionError
                ? `${config.definitionError}. Fix it and save, and the preview pages again.`
                : `No definition.json was found beside this template (looked for ${config.definitionPath}), so the whole page comes from the workspace settings.`;
        } else if (note) {
            note.hidden = !config.definition;
            const defaulted = config.definition && config.definition.defaulted && config.definition.defaulted.length
                ? ' ' + config.definition.defaulted.map(d => `Its ${d.band} is enabled with no height, so it is SelectPdf\u2019s default of ${d.height}pt.`).join(' ')
                : '';
            note.textContent = config.definition
                ? 'This template has a definition.json, which sets its page size, header and footer in Reporter (its select.* settings). Try them here, but change them there to keep them: Save leaves them out.' + defaulted
                : '';
        }
        showReadout(config);
    }

    function showReadout(config) {
        const node = document.getElementById('lp-tune-readout');
        if (!node || !config) return;
        const g = config.geometry;
        const pt = value => Math.round(value * 0.75 * 10) / 10;
        const off = [];
        const m = g.margins;
        if (m.top || m.right || m.bottom || m.left) off.push(`margins of ${pt(m.top)}, ${pt(m.right)}, ${pt(m.bottom)} and ${pt(m.left)}pt`);
        if (g.header) off.push(`a ${pt(g.header.height)}pt header`);
        if (g.footer) off.push(`a ${pt(g.footer.height)}pt footer`);
        node.textContent = `The page is ${pt(g.page.width)} \u00d7 ${pt(g.page.height)}pt`
            + (off.length ? `; less ${off.join(' and ')}, the content area is ${pt(g.content.width)} \u00d7 ${pt(g.content.height)}pt. ` : ', all of it content. ')
            + `The ${g.webPageWidth}px layout is shrunk to ${Math.round(g.scale * 1000) / 10}% to fit its width, so each page holds ${Math.round(g.layoutPageHeight)}px of it.`;
        const save = tunePanel() && tunePanel().querySelector('[data-tune="save"]');
        const revert = tunePanel() && tunePanel().querySelector('[data-tune="revert"]');
        if (save) save.disabled = !savable(config);
        if (revert) revert.disabled = !trial;
    }

    // What Save would write: the values tried that aren't the definition's.
    function savable(config) {
        if (!trial) return null;
        const own = config && config.definition ? config.definition.controls : [];
        const out = {};
        for (const name of Object.keys(trial)) if (!own.includes(name)) out[name] = trial[name];
        return Object.keys(out).length ? out : null;
    }

    // A control was changed: try its value.
    function tryValue(input) {
        const config = readConfig();
        const field = TUNE_FIELDS.find(f => f.name === input.getAttribute('data-tune-field'));
        if (!config || !field) return;
        let value;
        if (field.kind === 'check') value = input.checked;
        else if (field.kind === 'select') value = input.value;
        else {
            value = Number(input.value);
            if (input.value === '' || !Number.isFinite(value) || value < field.min) return;
            if (field.kind === 'band') {
                const saved = config.settings && config.settings[field.name] && typeof config.settings[field.name] === 'object' ? config.settings[field.name] : null;
                value = value > 0
                    ? Object.assign({}, saved || {}, { display: true, height: value })
                    : (saved ? Object.assign({}, saved, { display: false }) : null);
            }
        }
        trial = Object.assign({}, trial || {}, { [field.name]: value });
        const now = readConfig();
        showGeometry(now);
        showReadout(now);
        schedule(300);
    }

    // The panel is docked at the side: while it's open the pages make room
    // for it, so none of a page is hidden behind it while it's compared.
    function setTunePanelOpen(open) {
        const panel = tunePanel() || buildTunePanel();
        panel.hidden = !open;
        document.body.classList.toggle('lp-tuning', open);
        if (open) fillTunePanel(readConfig());
        refit();
    }

    function openTunePanel() {
        const panel = tunePanel();
        setTunePanelOpen(!panel || panel.hidden);
    }

    document.addEventListener('click', event => {
        const target = event.target && event.target.closest ? event.target : null;
        if (!target) return;
        if (target.closest('[data-lp-local="tune-pages"]')) { openTunePanel(); return; }
        const action = target.closest('[data-tune]');
        if (!action || !tunePanel() || !tunePanel().contains(action)) return;
        const what = action.getAttribute('data-tune');
        if (what === 'close') setTunePanelOpen(false);
        else if (what === 'revert') {
            trial = null;
            const config = readConfig();
            fillTunePanel(config);
            showGeometry(config);
            schedule(0);
        } else if (what === 'save') {
            const settings = savable(readConfig());
            const api = root.__rlpVsCodeApi;
            if (api && settings) api.postMessage({ type: 'action', action: 'saveSelectPdfSettings', settings });
        }
    });
    document.addEventListener('input', event => {
        const input = event.target;
        if (input && input.getAttribute && input.getAttribute('data-tune-field') && tunePanel() && tunePanel().contains(input)) tryValue(input);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && tunePanel() && !tunePanel().hidden) setTunePanelOpen(false);
    });

    function setStatus(text) {
        const node = document.getElementById('lp-selectpdf-pages');
        if (node) node.textContent = text;
    }

    // Sheets wider than the panel are shown smaller, never larger. With a
    // transform, not CSS zoom: zoom carries into the iframes and changes the
    // width the document is laid out at, which would move every line break.
    function fitZoom(sheets, config) {
        const docked = document.body.classList.contains('lp-tuning') ? TUNE_PANEL_ROOM : 0;
        const room = Math.max(100, document.documentElement.clientWidth - 40 - docked);
        const z = Math.min(1, room / config.geometry.page.width);
        sheets.style.transform = z < 1 ? `scale(${z})` : '';
        // A transform leaves the layout box full size; take back the height.
        sheets.style.marginBottom = z < 1 ? `${-(1 - z) * sheets.offsetHeight}px` : '';
    }

    async function render() {
        const id = ++run;
        const isCurrent = () => id === run && active();
        const config = readConfig();
        const target = host();
        if (!config || !target) return;
        showGeometry(config);
        setStatus(lastCount == null ? '· paging…' : `· ${lastCount} page${lastCount === 1 ? '' : 's'}…`);
        let result;
        try {
            result = await paginate(target, config, isCurrent);
        } catch (err) {
            if (isCurrent()) setStatus('· could not page this document: ' + err.message);
            return;
        }
        if (!result || !isCurrent()) return;
        const { sheets, watch } = drawSheets(config, result);
        // Built out of sight, then swapped in, so the scroll position holds.
        sheets.classList.add('lp-sheets-pending');
        target.appendChild(sheets);
        fitZoom(sheets, config);
        await Promise.race([watch(), new Promise(r => setTimeout(r, 4000))]);
        if (!isCurrent()) { discard(sheets); return; }
        const y = root.scrollY;
        target.querySelectorAll('.lp-sheets:not(.lp-sheets-pending)').forEach(discard);
        sheets.classList.remove('lp-sheets-pending');
        fitZoom(sheets, config);
        root.scrollTo(root.scrollX, y);
        lastCount = result.pages;
        // FitWideContent can change the scale from the one the toolbar gives.
        const fitted = result.widened
            ? ` · wide content: laid out ${Math.round(result.layoutWidth)}px wide, at ${Math.round(result.scale * 100)}%`
            : '';
        // The @page side margins narrow the column, and say by how much.
        const mm = value => Math.round(value * 25.4 / 96 * 10) / 10;
        const sides = result.inset && (result.inset.left || result.inset.right)
            ? ` · @page side margins ${mm(result.inset.left)} and ${mm(result.inset.right)}mm`
            : '';
        // Content wider than the layout is cut off at the page's edge, and
        // doesn't re-wrap to a narrower column: say what it is.
        const wide = result.overflow && result.overflow.length && !result.widened
            ? ` · wider than the ${Math.round(result.layoutWidth)}px layout, so cut off: `
                + result.overflow.map(o => `${o.name} ${o.width}px${o.declared ? ` (${o.declared})` : ''}`).join(', ')
            : '';
        const narrowed = result.fitted && result.fitted.length
            ? ` · fitted to the column: ${result.fitted.map(o => `${o.name} ${o.width}px${o.declared ? ` (${o.declared})` : ''}`).join(', ')}`
            : '';
        setStatus(`· ${result.pages} page${result.pages === 1 ? '' : 's'}${sides}${narrowed}${fitted}${wide}`);
    }

    // The view was turned off: stop any paging under way and let the pages go
    // (each is a copy of the document).
    function stop() {
        run++;
        clearTimeout(timer);
        if (host()) host().querySelectorAll('.lp-sheets').forEach(discard);
    }

    function schedule(delay) {
        clearTimeout(timer);
        if (!active()) return;
        timer = setTimeout(render, delay);
    }

    // The views are tabs (a radio group): paging starts when this one is
    // chosen and stops when another is. The test builder, which picks from
    // the Edit tab, chooses that tab itself.
    document.addEventListener('change', event => {
        const input = event.target;
        if (!input || input.name !== 'lp-view' || !input.checked) return;
        if (input.id === 'lp-selectpdf') schedule(0);
        else stop();
    });

    // A new render (see buildPreviewHtml) replaces the toolbar; the toggle's
    // state is restored by the update handler, which runs before this one.
    root.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'update') return;
        // The toolbar was replaced: describe the page being tried again, and
        // show the settings as they now are in a panel not being typed in.
        const config = readConfig();
        showGeometry(config);
        const panel = tunePanel();
        if (panel && !panel.hidden && !panel.contains(document.activeElement)) fillTunePanel(config);
        else if (panel) showReadout(config);
        if (!active()) return;
        setStatus(lastCount == null ? '' : `· ${lastCount} page${lastCount === 1 ? '' : 's'}…`);
        schedule(250);
    });

    function refit() {
        const config = readConfig();
        if (config && host()) host().querySelectorAll('.lp-sheets').forEach(sheets => fitZoom(sheets, config));
    }

    root.addEventListener('resize', refit);

    // ---- the ruler ----
    // Over a page, where the pointer is from the page's top and left edges, in
    // inches and points, as a PDF viewer's measuring tool gives them, with a
    // guide across the page: to measure the preview as a production PDF is
    // measured. The sheets may be drawn smaller to fit the panel, so the
    // distance is taken from the page's size, not the screen's.
    const PX_PER_PT = 96 / 72;
    function ruler() {
        let tip = document.getElementById('lp-ruler');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'lp-ruler';
            tip.className = 'lp-ruler';
            tip.hidden = true;
            const guide = document.createElement('div');
            guide.id = 'lp-ruler-guide';
            guide.className = 'lp-ruler-guide';
            guide.hidden = true;
            document.body.appendChild(guide);
            document.body.appendChild(tip);
        }
        return { tip, guide: document.getElementById('lp-ruler-guide') };
    }
    document.addEventListener('mousemove', event => {
        const sheet = event.target && event.target.closest ? event.target.closest('.lp-sheet') : null;
        const { tip, guide } = ruler();
        const config = sheet && active() ? readConfig() : null;
        if (!sheet || !config) { tip.hidden = true; guide.hidden = true; return; }
        const rect = sheet.getBoundingClientRect();
        const perPx = config.geometry.page.width / rect.width;
        const pt = value => value * perPx / PX_PER_PT;
        const top = pt(event.clientY - rect.top);
        const left = pt(event.clientX - rect.left);
        const at = value => `${(value / 72).toFixed(2)}in (${value.toFixed(1)}pt)`;
        const number = sheet.getAttribute('aria-label') || '';
        tip.textContent = `${at(top)} from the top · ${at(left)} from the left${number ? ' · ' + number.toLowerCase() : ''}`;
        tip.style.left = Math.min(event.clientX + 14, root.innerWidth - 330) + 'px';
        tip.style.top = (event.clientY + 16) + 'px';
        guide.style.left = rect.left + 'px';
        guide.style.width = rect.width + 'px';
        guide.style.top = event.clientY + 'px';
        tip.hidden = false;
        guide.hidden = false;
    });

    if (active()) schedule(0);
})(this);
