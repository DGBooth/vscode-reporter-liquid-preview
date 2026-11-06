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
//     line is never cut);
//   - places inside break-inside: avoid, next to break-before/after: avoid, or
//     that would leave fewer than `orphans` / `widows` lines (2) are used only
//     when nothing better fits;
//   - content that can't break at all and doesn't fit (a tall image, a table
//     row taller than a page) is cut at the page end;
//   - with print media, a table's thead (display: table-header-group) repeats
//     at the top of each page the table continues onto.
//
// The page is laid out in a hidden iframe at the layout width, one page at a
// time: find where the page ends, push what follows down to the next page's
// top (a margin, or a spacer where there is no element to give one), measure
// again. Then each page is shown in its own iframe of the finished layout,
// scrolled to that page and scaled onto a sheet.
//
// The break choice itself (chooseNextBreak) and the media rewrite are plain
// functions, exported under Node for test/selectpdf-pages.test.js. In the
// webview this file is inlined as a script and wires itself to the toolbar's
// "SelectPdf pages" toggle.

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

    function makeMeasurer(doc) {
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
                let next = null;
                const children = Array.from(node.children).filter(c => !SKIP_TAGS.test(c.tagName) && styleOf(c).display !== 'none');
                next = which === 'Before' ? children[0] : children[children.length - 1];
                node = next;
            }
            return false;
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
        function candidates(body, pageTop, pageBottom, printMedia) {
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
                        }
                    } else if (item.top < pageBottom && item.bottom > pageBottom) {
                        const style = styleOf(el);
                        const orphans = parseInt(style.orphans, 10) || 2;
                        const widows = parseInt(style.widows, 10) || 2;
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
            walk(body, false, 0);
            return out;
        }

        function contentEnd(doc) {
            const html = doc.documentElement.getBoundingClientRect();
            const body = doc.body ? doc.body.getBoundingClientRect() : html;
            const marginBottom = doc.body ? parseFloat(styleOf(doc.body).marginBottom) || 0 : 0;
            return Math.max(html.bottom, body.bottom + marginBottom) + scrollY();
        }

        return { styleOf, top, candidates, contentEnd, lineStart };
    }

    // ---- pushing content to the next page ----

    // Adjust `set(amount)` until measure() reads `target`. A few rounds, since
    // collapsing margins and table spacing make the first guess land short.
    function settle(set, measure, target, start = 0) {
        let amount = start;
        set(amount);
        for (let round = 0; round < 4; round++) {
            const off = target - measure();
            if (Math.abs(off) <= 0.25) break;
            amount = Math.max(0, amount + off);
            set(amount);
        }
    }

    function spacerStyle(el) {
        for (const [prop, value] of [['display', 'block'], ['margin', '0'], ['padding', '0'], ['border', '0'], ['float', 'none'], ['position', 'static'], ['width', 'auto'], ['min-height', '0'], ['break-before', 'auto'], ['break-after', 'auto']]) {
            el.style.setProperty(prop, value, 'important');
        }
    }

    function applyBreak(doc, m, candidate, nextPageTop) {
        const a = candidate.apply;
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
            settle(h => spacer.style.setProperty('height', h + 'px', 'important'), () => m.top(anchor), nextPageTop + offset);
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
            const repeat = printMedia && thead && m.styleOf(thead).display === 'table-header-group' && !thead.contains(first) && first !== thead;
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
            applyMedia(doc, medium);
            await settled(doc);
            if (!isCurrent()) return null;

            if (g.fitWideContent) {
                const wide = doc.documentElement.scrollWidth;
                if (wide > layoutWidth + 1) {
                    layoutWidth = Math.min(wide, 4 * g.webPageWidth);
                    scale = g.content.width / layoutWidth;
                    pageHeight = g.content.height / scale;
                    frame.style.width = layoutWidth + 'px';
                    frame.style.height = pageHeight + 'px';
                }
            }

            const m = makeMeasurer(doc);
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
            return { html: doctype + doc.documentElement.outerHTML, pages, pageHeight, lastHeight, scale, layoutWidth, medium };
        } finally {
            frame.remove();
        }
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
        const loads = [];
        for (let k = 0; k < result.pages; k++) {
            const number = k + 1;
            const last = k === result.pages - 1;
            const windowHeight = (last ? result.lastHeight : result.pageHeight) * result.scale;
            const sheetHeight = last && g.allowContentHeightResize
                ? g.page.height - g.content.height + windowHeight
                : g.page.height;
            const sheet = el('div', 'lp-sheet', { width: px(g.page.width), height: px(sheetHeight) });
            sheet.setAttribute('aria-label', `Page ${number} of ${result.pages}`);

            const win = el('div', 'lp-sheet-content', {
                left: px(g.content.left), top: px(g.content.top),
                width: px(g.content.width), height: px(windowHeight)
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

            loads.push(new Promise(resolve => {
                frame.addEventListener('load', () => {
                    try {
                        const doc = frame.contentDocument;
                        applyMedia(doc, result.medium);
                        // Room to scroll the last page to its top.
                        addStyle(doc, `html::after { content: ""; display: block; height: ${result.pageHeight}px; }`, true);
                        frame.contentWindow.scrollTo(0, k * result.pageHeight);
                    } catch (err) { /* leave the page at the top */ }
                    resolve();
                }, { once: true });
            }));
            frame.srcdoc = result.html;
        }
        return { sheets, loads };
    }

    // ---- the toolbar toggle ----

    const toggle = () => document.getElementById('lp-selectpdf');
    const active = () => !!(toggle() && toggle().checked);
    const host = () => document.getElementById('lp-pages');
    let run = 0;
    let timer = null;
    let lastCount = null;

    function readConfig() {
        const node = document.getElementById('lp-selectpdf-config');
        if (!node) return null;
        try { return JSON.parse(node.textContent); } catch (err) { return null; }
    }

    function setStatus(text) {
        const node = document.getElementById('lp-selectpdf-pages');
        if (node) node.textContent = text;
    }

    // Sheets wider than the panel are shown smaller, never larger. With a
    // transform, not CSS zoom: zoom carries into the iframes and changes the
    // width the document is laid out at, which would move every line break.
    function fitZoom(sheets, config) {
        const room = Math.max(100, document.documentElement.clientWidth - 40);
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
        setStatus(lastCount == null ? '· paging…' : `· ${lastCount} page${lastCount === 1 ? '' : 's'}…`);
        let result;
        try {
            result = await paginate(target, config, isCurrent);
        } catch (err) {
            if (isCurrent()) setStatus('· could not page this document: ' + err.message);
            return;
        }
        if (!result || !isCurrent()) return;
        const { sheets, loads } = drawSheets(config, result);
        // Built out of sight, then swapped in, so the scroll position holds.
        sheets.classList.add('lp-sheets-pending');
        target.appendChild(sheets);
        fitZoom(sheets, config);
        await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, 4000))]);
        if (!isCurrent()) { sheets.remove(); return; }
        const y = root.scrollY;
        target.querySelectorAll('.lp-sheets:not(.lp-sheets-pending)').forEach(old => old.remove());
        sheets.classList.remove('lp-sheets-pending');
        fitZoom(sheets, config);
        root.scrollTo(root.scrollX, y);
        lastCount = result.pages;
        // FitWideContent can change the scale from the one the toolbar gives.
        const fitted = result.layoutWidth !== config.geometry.webPageWidth
            ? ` · wide content: laid out ${Math.round(result.layoutWidth)}px wide, at ${Math.round(result.scale * 100)}%`
            : '';
        setStatus(`· ${result.pages} page${result.pages === 1 ? '' : 's'}${fitted}`);
    }

    function schedule(delay) {
        clearTimeout(timer);
        if (!active()) return;
        timer = setTimeout(render, delay);
    }

    document.addEventListener('change', event => {
        const input = event.target;
        if (!input || !input.id) return;
        if (input.id === 'lp-selectpdf') {
            if (input.checked) {
                const source = document.getElementById('lp-show-source');
                if (source) source.checked = false;
                schedule(0);
            } else {
                run++;
            }
        } else if (input.id === 'lp-show-source' && input.checked && toggle()) {
            toggle().checked = false;
            run++;
        }
    });

    // The test builder picks from the rendered view, not the pages.
    document.addEventListener('click', event => {
        const button = event.target && event.target.closest && event.target.closest('[data-lp-local="build-test"]');
        if (button && toggle()) { toggle().checked = false; run++; }
    }, true);

    // A new render (see buildPreviewHtml) replaces the toolbar; the toggle's
    // state is restored by the update handler, which runs before this one.
    root.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'update' || !active()) return;
        setStatus(lastCount == null ? '' : `· ${lastCount} page${lastCount === 1 ? '' : 's'}…`);
        schedule(250);
    });

    root.addEventListener('resize', () => {
        const config = readConfig();
        if (config && host()) host().querySelectorAll('.lp-sheets').forEach(sheets => fitZoom(sheets, config));
    });

    if (active()) schedule(0);
})(this);
