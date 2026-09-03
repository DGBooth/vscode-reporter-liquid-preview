const path = require('path');
const vscode = require('vscode');
const liquid = require('liquidjs');
const liquidEngine = new liquid();

// Accumulates warnings during a single render pass. Set to [] before rendering, null otherwise.
let _currentWarnings = null;

// The token of the template currently being rendered — see trackRenderPosition.
// Filters and custom tags are handed their arguments and nothing else, so this
// is the only way for a warning raised inside one to say where it came from.
let _currentToken = null;

// register custom Liquid tags used in templates
registerCustomTags(liquidEngine);
trackRenderPosition(liquidEngine);

// Parse a Liquid tag argument string into an object.
// e.g. '"fieldName", title: "My Title", lines: 1' → { name: "fieldName", title: "My Title", lines: 1 }
// An unquoted first argument is treated as a Liquid variable reference → { nameVar: "varName", ... }
function parseTagArgs(argsStr) {
    const result = {};
    if (!argsStr) return result;
    const nameMatch = argsStr.match(/^\s*['"]([^'"]+)['"]/);
    if (nameMatch) {
        result.name = nameMatch[1];
    } else {
        // Unquoted first argument (not a key:value pair) is a variable whose runtime value is the name
        const varMatch = argsStr.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)(?!\s*:)/);
        if (varMatch) result.nameVar = varMatch[1];
    }
    const kvRegex = /(\w+):\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?))/g;
    let m;
    while ((m = kvRegex.exec(argsStr)) !== null) {
        const key = m[1];
        result[key] = m[4] !== undefined ? parseFloat(m[4]) : (m[2] !== undefined ? m[2] : m[3]);
    }
    return result;
}

// Resolve the tag name from parsed args: either a literal string or a variable looked up in context.
function resolveTagName(args, ctx) {
    if (args.name) return args.name;
    if (args.nameVar) {
        const envs = (ctx && ctx.environments) || {};
        const resolved = envs[args.nameVar];
        return resolved !== undefined ? String(resolved) : '';
    }
    return '';
}

// Record a tag name into the per-render duplicate tracker (injected via render
// context), along with where each use appeared, so a clash can be pointed at
// rather than only named.
function trackTagName(name, ctx) {
    const tracker = ctx && ctx.environments && ctx.environments._rlpTracker;
    if (!tracker || !name) return;
    const uses = tracker.seen.get(name);
    if (uses) {
        uses.push(currentLocation());
        if (!tracker.dupes.includes(name)) tracker.dupes.push(name);
    } else {
        tracker.seen.set(name, [currentLocation()]);
    }
}

// Keep _currentToken pointing at the template being rendered, so warnings and
// errors raised deep inside a filter or a custom tag can name their line.
//
// The loop mirrors LiquidJS's own Render.renderTemplates rather than handing it
// the whole list at once, so each template can be bracketed individually. Error
// handling is left to the original — each single-template call still wraps its
// own RenderError — except for RenderBreakError, which carries the HTML
// rendered before a {% break %} and would otherwise only see the one template
// we passed down.
function trackRenderPosition(engine) {
    const renderTemplates = engine.renderer.renderTemplates.bind(engine.renderer);
    engine.renderer.renderTemplates = async function (templates, ctx) {
        let html = '';
        for (const template of templates) {
            const previousToken = _currentToken;
            _currentToken = template.token || previousToken;
            try {
                html += await renderTemplates([template], ctx);
            } catch (err) {
                if (err.name === 'RenderBreakError') err.resolvedHTML = html + (err.resolvedHTML || '');
                throw err;
            } finally {
                _currentToken = previousToken;
            }
        }
        return html;
    };
}

// Record a warning raised at the position currently being rendered.
function addWarning(message) {
    if (_currentWarnings) _currentWarnings.push({ message, location: currentLocation() });
}

// Where in the template rendering has reached, or null outside a render pass.
function currentLocation() {
    return tokenLocation(_currentToken);
}

// A position from a LiquidJS token: 1-based line and column, plus the source
// text of the construct itself so a pane entry is recognisable without having
// to leave the preview to look it up.
function tokenLocation(token) {
    if (!token || typeof token.line !== 'number') return null;
    return {
        line: token.line,
        col: typeof token.col === 'number' ? token.col : 1,
        snippet: snippetOf(token.raw)
    };
}

// Collapse a chunk of source to a single readable line for display.
function snippetOf(text) {
    const oneLine = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? oneLine.slice(0, 119) + '\u2026' : oneLine;
}

// Convert Markdown text to HTML for the markdownify filter. Supports the
// common constructs used in Reporter templates: headings, paragraphs,
// unordered/ordered lists (nested by indentation), blockquotes, fenced code
// blocks, horizontal rules, and inline bold/italic/code/links/images.
// Raw HTML in the source passes through untouched, as in standard Markdown.
function markdownToHtml(md) {
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const out = [];

    // Inline markdown within a single block of text.
    const renderInline = text => {
        // Code spans are extracted first so their contents are not treated as markup.
        const codeSpans = [];
        text = text.replace(/`([^`]+)`/g, (_, code) => {
            codeSpans.push(`<code>${escapeHtml(code)}</code>`);
            return `\u0000${codeSpans.length - 1}\u0000`;
        });
        text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">');
        text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        // Underscore emphasis only at word boundaries, so snake_case survives.
        text = text.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
        return text.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSpans[i]);
    };

    // Stack of currently open lists: { indent, tag } from outermost to innermost.
    let listStack = [];
    const closeListsTo = depth => {
        while (listStack.length > depth) {
            out.push(`</li></${listStack.pop().tag}>`);
        }
    };

    let paragraph = [];
    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        // Two or more trailing spaces on a line force a hard break.
        const body = paragraph.map(l => l.replace(/ {2,}$/, '<br>')).join('\n');
        out.push(`<p>${renderInline(body)}</p>`);
        paragraph = [];
    };
    const flushBlocks = () => { flushParagraph(); closeListsTo(0); };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // Fenced code block: everything up to the closing fence is literal.
        const fence = line.match(/^\s*```/);
        if (fence) {
            flushBlocks();
            const body = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) {
                body.push(lines[i]);
                i++;
            }
            i++; // skip the closing fence
            out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
            continue;
        }

        // Blank line ends the current paragraph and any open lists.
        if (!line.trim()) {
            flushBlocks();
            i++;
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (heading) {
            flushBlocks();
            out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
            i++;
            continue;
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flushBlocks();
            out.push('<hr>');
            i++;
            continue;
        }

        const quote = line.match(/^\s*>\s?(.*)$/);
        if (quote) {
            flushBlocks();
            const body = [quote[1]];
            i++;
            while (i < lines.length) {
                const m = lines[i].match(/^\s*>\s?(.*)$/);
                if (!m) break;
                body.push(m[1]);
                i++;
            }
            out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
            continue;
        }

        const listItem = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (listItem) {
            flushParagraph();
            const indent = listItem[1].length;
            const tag = /\d/.test(listItem[2]) ? 'ol' : 'ul';
            // Close lists deeper than this item's indentation.
            while (listStack.length && indent < listStack[listStack.length - 1].indent) {
                out.push(`</li></${listStack.pop().tag}>`);
            }
            const top = listStack[listStack.length - 1];
            if (!top || indent > top.indent) {
                listStack.push({ indent, tag });
                out.push(`<${tag}><li>` + renderInline(listItem[3]));
            } else if (top.tag !== tag) {
                out.push(`</li></${listStack.pop().tag}>`);
                listStack.push({ indent, tag });
                out.push(`<${tag}><li>` + renderInline(listItem[3]));
            } else {
                out.push('</li><li>' + renderInline(listItem[3]));
            }
            i++;
            continue;
        }

        // A non-blank, non-marker line while a list is open continues the last item.
        if (listStack.length > 0) {
            out[out.length - 1] += ' ' + renderInline(line.trim());
            i++;
            continue;
        }

        paragraph.push(line);
        i++;
    }
    flushBlocks();
    return out.join('\n');
}

function registerCustomFilters(engine) {
    // markdownify filter: render Markdown text as HTML, as in Reporter
    // (e.g. "- Test" becomes a bullet point). The wrapper div lets the
    // preview stylesheet trim the outer margins of the first/last block, so
    // the output sits flush with surrounding content as it does in Reporter
    // instead of showing a blank line where the leading <p>'s default
    // margin-top would be.
    engine.registerFilter('markdownify', value => {
        if (value == null) {
            addWarning('markdownify filter: value is missing (returned empty)');
            return '';
        }
        return `<div class="rlp-markdown">${markdownToHtml(value)}</div>`;
    });

    // money filter: rounds to 2 decimal places or appends .00 if no decimals, with comma separators
    engine.registerFilter('money', value => {
        const num = parseFloat(value);
        if (isNaN(num)) return value;
        return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });

    // slice filter: override built-in to warn instead of error when the value is missing
    engine.registerFilter('slice', (v, begin, length = 1) => {
        if (v == null) {
            addWarning('slice filter: value is missing (returned empty)');
            return '';
        }
        begin = begin < 0 ? v.length + begin : begin;
        return v.slice(begin, begin + length);
    });

    // where filter: override built-in to warn instead of error when the value is missing
    engine.registerFilter('where', (arr, property, value) => {
        if (arr == null) {
            addWarning(`where filter: array is missing (filtering by property "${property}")`);
            return [];
        }
        return arr.filter(obj => value === undefined ? (obj[property] !== false && obj[property] !== undefined && obj[property] !== null) : obj[property] === value);
    });

    // sort filter: override built-in to warn on null and support sorting by property key
    engine.registerFilter('sort', (arr, property) => {
        if (arr == null) {
            addWarning('sort filter: array is missing (returned empty)');
            return [];
        }
        const sorted = [...arr];
        if (property) {
            sorted.sort((a, b) => {
                const av = a == null ? null : a[property];
                const bv = b == null ? null : b[property];
                if (av == null && bv == null) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                if (av < bv) return -1;
                if (av > bv) return 1;
                return 0;
            });
        } else {
            sorted.sort((a, b) => {
                if (a == null && b == null) return 0;
                if (a == null) return 1;
                if (b == null) return -1;
                if (a < b) return -1;
                if (a > b) return 1;
                return 0;
            });
        }
        return sorted;
    });

    // json filter: serialize a value as JSON, as in the LiquidJS built-in
    // (https://liquidjs.com/filters/json.html), but pretty-printed with a
    // 2-space indent by default for readability. An optional argument
    // overrides the indentation, e.g. {{ value | json: 4 }} or
    // {{ value | json: 0 }} for compact single-line output.
    engine.registerFilter('json', (value, space = 2) => JSON.stringify(value, null, space));

    // sort_natural filter: case-insensitive sort, optionally by property key
    engine.registerFilter('sort_natural', (arr, property) => {
        if (arr == null) {
            addWarning('sort_natural filter: array is missing (returned empty)');
            return [];
        }
        const sorted = [...arr];
        const cmpNatural = (a, b) => {
            if (a == null && b == null) return 0;
            if (a == null) return 1;
            if (b == null) return -1;
            return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
        };
        if (property) {
            sorted.sort((a, b) => cmpNatural(a == null ? null : a[property], b == null ? null : b[property]));
        } else {
            sorted.sort(cmpNatural);
        }
        return sorted;
    });
}

// register custom Liquid filters used in templates
registerCustomFilters(liquidEngine);

function registerCustomTags(engine) {
    // optional tag: renders a checkbox wrapper with inner content
    engine.registerTag('optional', {
        parse(tagToken, remainTokens) {
            this.args = parseTagArgs(tagToken.args);
            this.templates = [];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:endoptional', () => stream.stop())
                .on('template', tpl => this.templates.push(tpl))
                .on('end', () => { throw new Error('optional tag not closed'); });
            stream.start();
        },
        async render(ctx) {
            const name = resolveTagName(this.args, ctx);
            trackTagName(name, ctx);
            const fields = (ctx.environments && ctx.environments.fields) || {};
            const checkedAttr = fields[name] === 'true' ? ' checked=""' : '';
            const inner = await this.liquid.renderer.renderTemplates(this.templates, ctx);
            return `<div id="${name}-wrapper" class="editor " data-editor-id="${name}"><label for="${name}"><input type="checkbox" id="${name}" name="${name}" data-editor-id="${name}" value="true"${checkedAttr}><span class="optional-content">${inner}</span></label></div>`;
        }
    });

    // editor tag: renders an input or textarea wrapped in a div
    engine.registerTag('editor', {
        parse(tagToken, remainTokens) {
            this.args = parseTagArgs(tagToken.args);
            this.templates = [];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:endeditor', () => stream.stop())
                .on('template', tpl => this.templates.push(tpl))
                .on('end', () => { throw new Error('editor tag not closed'); });
            stream.start();
        },
        render(ctx) {
            const name = resolveTagName(this.args, ctx);
            trackTagName(name, ctx);
            const lines = this.args.lines !== undefined ? this.args.lines : 1;
            const placeholder = this.args.placeholder || '';
            const maxlength = this.args.maxlength !== undefined ? this.args.maxlength : 100;
            const minlength = this.args.minlength !== undefined ? this.args.minlength : 0;
            const fields = (ctx.environments && ctx.environments.fields) || {};
            const value = fields[name] !== undefined ? String(fields[name]) : '';
            if (lines <= 1) {
                return `<div id="editor-wrapper-${name}" class="editor "><input type="text" id="${name}" data-editor-id="${name}" maxlength="${maxlength}" minlength="${minlength}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}"></div>`;
            } else {
                return `<div id="editor-wrapper-${name}" class="editor "><textarea id="${name}" data-editor-id="${name}" maxlength="${maxlength}" minlength="${minlength}" placeholder="${escapeHtml(placeholder)}" rows="${lines}">${escapeHtml(value)}</textarea></div>`;
            }
        }
    });

    // choice tag: renders radio buttons for each 'or'-separated block
    engine.registerTag('choice', {
        parse(tagToken, remainTokens) {
            this.args = parseTagArgs(tagToken.args);
            this.parts = [[]];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:or', () => this.parts.push([]))
                .on('tag:endchoice', () => stream.stop())
                .on('template', tpl => this.parts[this.parts.length - 1].push(tpl))
                .on('end', () => { throw new Error('choice tag not closed'); });
            stream.start();
        },
        async render(ctx) {
            const name = resolveTagName(this.args, ctx);
            trackTagName(name, ctx);
            const title = this.args.title !== undefined ? this.args.title : '';
            const fields = (ctx.environments && ctx.environments.fields) || {};
            const selectedValue = fields[name] !== undefined ? String(fields[name]) : '0';
            const titleHtml = title ? `<span class="editor-intro">${escapeHtml(title)}</span>` : '';
            let labelsHtml = '';
            for (let i = 0; i < this.parts.length; i++) {
                const checkedAttr = String(i) === selectedValue ? ' checked=""' : '';
                const inner = await this.liquid.renderer.renderTemplates(this.parts[i], ctx);
                labelsHtml += `<label for="${name}-${i + 1}"><input type="radio" id="${name}-${i + 1}" name="${name}" data-editor-id="${name}" value="${i}"${checkedAttr}><span class="choice-content">${inner}</span></label>`;
            }
            return `<div id="${name}-wrapper" class="editor " data-editor-id="${name}">${titleHtml}${labelsHtml}</div>`;
        }
    });
}

function activate(context) {
    let templateStatusBarItem;
    let dataStatusBarItem;

    // Backs the squiggles and Problems-panel entries that mirror each preview's
    // problems pane (see publishDiagnostics).
    _diagnosticCollection = vscode.languages.createDiagnosticCollection('reporterLiquidPreview');
    context.subscriptions.push(_diagnosticCollection);
    let previewContentProvider = new class {
        constructor() {
            this.onDidChangeEmitter = new vscode.EventEmitter();
            this.onDidChange = this.onDidChangeEmitter.event;
            this.previews = {};
        }

        dispose() {
            this.onDidChangeEmitter.dispose();
            this.previews.clear();
        }

        async provideTextDocumentContent(uri) {
            let queryParmeters = new URLSearchParams(uri.query);
            let previewId = queryParmeters.get('id');
            let preview = this.previews[previewId];

            if (preview.templateUri && preview.templateDirty) {
                try {
                    let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
                    preview.template = liquidEngine.parse(templateDocument.getText());
                    preview.templateDirty = false;
                    templateStatusBarItem.text = '$(check) Template';
                    templateStatusBarItem.tooltip = 'All good!';
                } catch (err) {
                    templateStatusBarItem.text = '$(x) Template';
                    templateStatusBarItem.tooltip = err.message;
                }
            }

            if (preview.dataUri && preview.dataDirty) {
                try {
                    let dataDocument = await vscode.workspace.openTextDocument(preview.dataUri);
                    preview.data = JSON.parse(dataDocument.getText());
                    preview.dataDirty = false;
                    dataStatusBarItem.text = '$(check) Data';
                    dataStatusBarItem.tooltip = 'All good!';
                } catch (err) {
                    dataStatusBarItem.text = '$(x) Data';
                    dataStatusBarItem.tooltip = err.message;
                }
            }

            return await liquidEngine.render(preview.template, preview.data);
        }
    }
    context.subscriptions.push(previewContentProvider);

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('reporter-liquid-preview', previewContentProvider));

    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.preview', async () => {
        let document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (document) {
            let preview = createNewPreview(document);
            await updatePreviewDataFile(preview);
            previewContentProvider.previews[preview.id] = preview;

            let doc = await vscode.workspace.openTextDocument(preview.uri());
            await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false, viewColumn: vscode.ViewColumn.Beside });
        }
    }));

    // HTML preview panels, keyed by preview id
    let htmlPreviews = {};

    // Full HTML preview panels (liquid-stripped), keyed by preview id
    let htmlFullPreviews = {};

    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.htmlPreview', async () => {
        let document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (document) {
            let preview = createNewPreview(document);
            await updatePreviewDataFile(preview);

            let workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
            let panel = vscode.window.createWebviewPanel(
                'shopifyLiquidHtmlPreview',
                'HTML Preview: ' + path.basename(document.fileName),
                vscode.ViewColumn.Beside,
                // retainContextWhenHidden keeps the webview alive when its tab is
                // hidden, preserving scroll position and toggle state on return.
                // Scripts are needed only for the in-place update listener in
                // buildPreviewHtml; the preview content itself uses none.
                { enableScripts: true, localResourceRoots: workspaceFolders, retainContextWhenHidden: true }
            );

            htmlPreviews[preview.id] = { preview, panel };
            wirePreviewMessages(panel);

            await queueRefresh(preview, () => refreshHtmlPanel(preview, panel));

            panel.onDidDispose(() => {
                delete htmlPreviews[preview.id];
                clearPreviewDiagnostics(preview);
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.fullHtmlPreview', async () => {
        let document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (document) {
            let preview = createNewPreview(document);

            let workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
            let panel = vscode.window.createWebviewPanel(
                'shopifyLiquidFullHtmlPreview',
                'Full HTML Preview: ' + path.basename(document.fileName),
                vscode.ViewColumn.Beside,
                // retainContextWhenHidden keeps the webview alive when its tab is
                // hidden, preserving scroll position and toggle state on return.
                // Scripts are needed only for the in-place update listener in
                // buildPreviewHtml; the preview content itself uses none.
                { enableScripts: true, localResourceRoots: workspaceFolders, retainContextWhenHidden: true }
            );

            htmlFullPreviews[preview.id] = { preview, panel };
            wirePreviewMessages(panel);

            await queueRefresh(preview, () => refreshHtmlFullPanel(preview, panel));

            panel.onDidDispose(() => {
                delete htmlFullPreviews[preview.id];
                clearPreviewDiagnostics(preview);
            });
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (textDocumentChangeEvent) => {
        // Update text previews
        let documentPreviews = getDocumentPreviews(previewContentProvider, textDocumentChangeEvent.document);
        for (let documentPreview of documentPreviews) {
            if (documentPreview.isTemplate || documentPreview.isData) {
                // OR the flags in: a template edit that failed to parse leaves
                // templateDirty set, and a later edit to the data file must not
                // clear it or the stale template is never re-parsed.
                documentPreview.preview.templateDirty = documentPreview.preview.templateDirty || documentPreview.isTemplate;
                documentPreview.preview.dataDirty = documentPreview.preview.dataDirty || documentPreview.isData;

                previewContentProvider.onDidChangeEmitter.fire(documentPreview.preview.uri());
            }
        }

        // Update HTML previews
        for (let id in htmlPreviews) {
            let { preview, panel } = htmlPreviews[id];
            let isTemplate = preview.templateUri === textDocumentChangeEvent.document.fileName;
            let isData = preview.dataUri === textDocumentChangeEvent.document.fileName;
            if (isTemplate || isData) {
                preview.templateDirty = preview.templateDirty || isTemplate;
                preview.dataDirty = preview.dataDirty || isData;
                await queueRefresh(preview, () => refreshHtmlPanel(preview, panel));
            }
        }

        // Update full HTML previews
        for (let id in htmlFullPreviews) {
            let { preview, panel } = htmlFullPreviews[id];
            if (preview.templateUri === textDocumentChangeEvent.document.fileName) {
                await queueRefresh(preview, () => refreshHtmlFullPanel(preview, panel));
            }
        }
    }));

    templateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    templateStatusBarItem.show();
    context.subscriptions.push(templateStatusBarItem);

    dataStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    dataStatusBarItem.show();
    context.subscriptions.push(dataStatusBarItem);
}

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
// typed yet must not put the scanner into attribute mode, or every Liquid tag up
// to the next '>' — or to the end of the file — is discarded as attribute-level
// logic. Losing an {% endfor %} or {% endif %} that way leaves the block open, so
// it swallows the rest of the document.
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

// Drop the Liquid tags and expressions from within a single HTML element tag,
// keeping everything else — including quoted attribute values — verbatim.
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

function stripLiquidFromHtmlTags(text) {
    // Remove liquid tags/expressions that appear inside HTML element open/close tags
    // (attribute-level liquid). These modify HTML structure rather than producing
    // standalone output. Everything else — Liquid between elements above all — is
    // passed through untouched.
    let result = '';
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        // Liquid outside an element tag is kept, and skipped as a unit so a '<'
        // inside it is never read as markup.
        if (ch === '{' && (text[i + 1] === '%' || text[i + 1] === '{')) {
            const end = skipLiquid(text, i);
            result += text.slice(i, end);
            i = end;
            continue;
        }

        // HTML comments are copied verbatim: their body is not an element tag, so
        // any Liquid inside it is left for the caller to interpret.
        if (ch === '<' && text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i);
            const close = end === -1 ? text.length : end + 3;
            result += text.slice(i, close);
            i = close;
            continue;
        }

        if (ch === '<') {
            const end = matchHtmlTag(text, i);
            if (end !== -1) {
                result += stripLiquidInsideHtmlTag(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }

        result += ch;
        i++;
    }

    return result;
}

// Turn an identifier like 'patient.first_name' or 'ownerName' into readable words.
function humanizeName(name) {
    if (!name) return '';
    return String(name)
        .replace(/\[["']?/g, '.')
        .replace(/["']?\]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
}

// Translate a Liquid condition into plain English, e.g.
// "patient.sex == 'male' and age > 8" → 'patient sex is “male” and age is more than 8'
function humanizeCondition(cond) {
    let c = String(cond).trim();
    c = c.replace(/'([^']*)'/g, '“$1”').replace(/"([^"]*)"/g, '“$1”');
    c = c.replace(/>=/g, ' is at least ')
        .replace(/<=/g, ' is at most ')
        .replace(/!=/g, ' is not ')
        .replace(/==/g, ' is ')
        .replace(/>/g, ' is more than ')
        .replace(/</g, ' is less than ');
    // dotted / underscored / camelCase identifiers → spaced words
    c = c.replace(/\b\w+(?:[._]\w+)+\b/g, m => humanizeName(m));
    c = c.replace(/\b[a-z]+[A-Z]\w*\b/g, m => humanizeName(m));
    return c.replace(/\s+/g, ' ').trim();
}

// Build a colour-coded pill label, optionally followed by an explanatory detail.
function annotationLabel(labelText, detailText) {
    const detail = detailText ? `<span class="lp-detail">${escapeHtml(detailText)}</span>` : '';
    return `<span class="lp-label">${escapeHtml(labelText)}</span>${detail}`;
}

// Rewrite a Liquid template into an annotated, layman-readable HTML document:
// every choice, optional section, fill-in field and automatic rule is shown as a
// labelled box, and data placeholders appear inline as chips. Returns the HTML
// plus counts of each construct for the summary header.
function annotateLiquid(text) {
    const stats = { choices: 0, options: 0, optionals: 0, editors: 0, conditionals: 0, loops: 0, notes: 0, variables: 0, unclosed: 0 };

    // Protect literal text so it is not mistaken for live Liquid constructs below.
    const neutralizeBraces = s => s.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

    // Step 1: remove liquid embedded within HTML element tags (attribute-level logic).
    // These modify HTML structure rather than producing standalone output.
    text = stripLiquidFromHtmlTags(text);

    // Step 2: capture blocks store output in a variable and render nothing here.
    text = text.replace(/\{%-?\s*capture\b[\s\S]*?\{%-?\s*endcapture\s*-?%\}/g, '');

    // Step 3: comments → author-note box (processed before the tag scan so their
    // bodies are not mistaken for live Liquid constructs).
    text = text.replace(/\{%-?\s*comment\s*-?%\}([\s\S]*?)\{%-?\s*endcomment\s*-?%\}/g, (_, body) => {
        stats.notes++;
        return `<div class="lp-note">${annotationLabel('Author note')}${neutralizeBraces(escapeHtml(body.trim()))}</div>`;
    });

    // raw blocks output their body as literal text.
    text = text.replace(/\{%-?\s*raw\s*-?%\}([\s\S]*?)\{%-?\s*endraw\s*-?%\}/g, (_, body) => neutralizeBraces(body));

    // Step 4: single pass over all {% ... %} tags with a stack of frames, so
    // labels and option numbering stay correct even when constructs are nested.
    // Each frame buffers its body rather than emitting markup immediately, so
    // logic-only blocks — loops and conditionals whose bodies produce nothing
    // visible (e.g. they only set up variables) — are dropped entirely instead
    // of cluttering the document as empty boxes. Stats therefore count only
    // the constructs that remain visible.
    const root = { html: '' };
    const stack = [];
    const peek = () => stack[stack.length - 1];
    const append = s => { (peek() || root).html += s; };
    const hasVisibleContent = html => /\S/.test(html);

    // The end tag each block type expects, for the unclosed-block notice.
    const END_TAGS = { choice: 'endchoice', optional: 'endoptional', editor: 'endeditor', if: 'endif', case: 'endcase', for: 'endfor', tablerow: 'endtablerow' };

    // Render a completed frame to HTML. Returns '' for hidden logic-only blocks.
    // A frame still open at the end of the template has absorbed everything after
    // it — the usual cause of a section that appears to run on past the end of the
    // document — so it is labelled rather than rendered as if it were intentional.
    const closeFrame = frame => {
        const html = renderFrame(frame);
        if (!frame.unclosed || !html) return html;
        stats.unclosed++;
        const detail = `no {% ${END_TAGS[frame.type] || 'end'} %} was found, so the rest of the document is inside it`;
        return `<div class="lp-unclosed">${annotationLabel('Not closed', detail)}${html}</div>`;
    };

    const renderFrame = frame => {
        switch (frame.type) {
            case 'choice': {
                frame.options.push(frame.html);
                stats.choices++;
                stats.options += frame.options.length;
                const optionsHtml = frame.options
                    .map((body, i) => `<div class="lp-option"><span class="lp-opt-label">Option ${i + 1}</span>${body}</div>`)
                    .join('');
                return `<div class="lp-choice"><div class="lp-choice-head">${frame.head}</div>${optionsHtml}</div>`;
            }
            case 'optional':
                stats.optionals++;
                return `<div class="lp-optional">${frame.label}${frame.html}</div>`;
            case 'editor':
                stats.editors++;
                return `<div class="lp-editor">${frame.label}${frame.html}</div>`;
            case 'if':
            case 'case': {
                if (frame.label !== null) frame.branches.push({ label: frame.label, html: frame.html });
                const kept = frame.branches.filter(b => hasVisibleContent(b.html));
                if (kept.length === 0) return '';
                stats.conditionals++;
                return `<div class="lp-cond">${kept.map(b => `<div class="lp-branch">${b.label}${b.html}</div>`).join('')}</div>`;
            }
            case 'for':
            case 'tablerow': {
                // With {% else %}, the buffered html is the empty-collection body
                // and the repeated body was set aside when the else was reached.
                const body = frame.emptyLabel ? frame.body : frame.html;
                const empty = frame.emptyLabel ? frame.html : '';
                let out = '';
                if (hasVisibleContent(body)) {
                    stats.loops++;
                    out += `<div class="lp-loop">${frame.label}${body}</div>`;
                }
                if (hasVisibleContent(empty)) {
                    stats.conditionals++;
                    out += `<div class="lp-cond"><div class="lp-branch">${frame.emptyLabel}${empty}</div></div>`;
                }
                return out;
            }
        }
        return frame.html;
    };

    // Close the nearest open frame of `type`, rendering any frames left open
    // inside it on the way out. An end tag with no matching frame open is a
    // stray and is ignored. Closing only an exactly-matching top frame is not
    // enough: a single mismatched end tag then left its block open, so the
    // block ran on and swallowed everything after it — a loop, for instance,
    // appearing to repeat well past the end of the document.
    const closeBlock = type => {
        if (!stack.some(frame => frame.type === type)) return;
        for (;;) {
            const frame = stack.pop();
            append(closeFrame(frame));
            if (frame.type === type) return;
        }
    };

    const tagRegex = /\{%-?\s*(\w+)([\s\S]*?)-?%\}/g;
    let lastIndex = 0;
    let match;
    while ((match = tagRegex.exec(text)) !== null) {
        append(text.slice(lastIndex, match.index));
        lastIndex = tagRegex.lastIndex;
        const tag = match[1];
        const rest = match[2].trim();
        switch (tag) {
            case 'choice': {
                const args = parseTagArgs(rest);
                const what = args.title || humanizeName(args.name || args.nameVar);
                stack.push({ type: 'choice', head: annotationLabel('Choose one', what), options: [], html: '' });
                break;
            }
            case 'or': {
                const frame = peek();
                if (frame && frame.type === 'choice') {
                    frame.options.push(frame.html);
                    frame.html = '';
                }
                break;
            }
            case 'endchoice':
                closeBlock('choice');
                break;
            case 'optional': {
                const args = parseTagArgs(rest);
                stack.push({ type: 'optional', label: annotationLabel('Optional', humanizeName(args.name || args.nameVar)), html: '' });
                break;
            }
            case 'endoptional':
                closeBlock('optional');
                break;
            case 'editor': {
                const args = parseTagArgs(rest);
                const what = args.placeholder || humanizeName(args.name || args.nameVar);
                stack.push({ type: 'editor', label: annotationLabel('Fill in', what), html: '' });
                break;
            }
            case 'endeditor':
                closeBlock('editor');
                break;
            case 'if':
                stack.push({ type: 'if', branches: [], label: annotationLabel('Shown when', humanizeCondition(rest)), html: '' });
                break;
            case 'unless':
                stack.push({ type: 'if', branches: [], label: annotationLabel('Shown unless', humanizeCondition(rest)), html: '' });
                break;
            case 'elsif': {
                const frame = peek();
                if (frame && frame.type === 'if') {
                    frame.branches.push({ label: frame.label, html: frame.html });
                    frame.label = annotationLabel('Otherwise, when', humanizeCondition(rest));
                    frame.html = '';
                }
                break;
            }
            case 'else': {
                const frame = peek();
                if (frame && (frame.type === 'if' || frame.type === 'case')) {
                    if (frame.label !== null) frame.branches.push({ label: frame.label, html: frame.html });
                    frame.label = annotationLabel('Otherwise');
                    frame.html = '';
                } else if (frame && (frame.type === 'for' || frame.type === 'tablerow') && !frame.emptyLabel) {
                    // A loop's else body shows when there is nothing to repeat over,
                    // so it is a separate section rather than part of the repeated body.
                    frame.emptyLabel = annotationLabel('If there are none');
                    frame.body = frame.html;
                    frame.html = '';
                }
                break;
            }
            case 'endif':
            case 'endunless':
                closeBlock('if');
                break;
            case 'case':
                // label stays null (and the buffered text is discarded) until the
                // first 'when' — Liquid ignores content between case and when.
                stack.push({ type: 'case', subject: humanizeCondition(rest), branches: [], label: null, html: '' });
                break;
            case 'when': {
                const frame = peek();
                if (frame && frame.type === 'case') {
                    if (frame.label !== null) frame.branches.push({ label: frame.label, html: frame.html });
                    frame.label = annotationLabel('When', `${frame.subject} is ${humanizeCondition(rest)}`);
                    frame.html = '';
                }
                break;
            }
            case 'endcase':
                closeBlock('case');
                break;
            case 'for':
            case 'tablerow': {
                const m = rest.match(/^(\S+)\s+in\s+([\s\S]+)$/);
                const detail = m
                    ? `once for each ${humanizeName(m[1])} in ${humanizeCondition(m[2].split('|')[0])}`
                    : humanizeCondition(rest);
                stack.push({ type: tag, label: annotationLabel('Repeats', detail), html: '' });
                break;
            }
            case 'endfor':
                closeBlock('for');
                break;
            case 'endtablerow':
                closeBlock('tablerow');
                break;
            default:
                // assign, increment, decrement, render, include, cycle, break, … – no visible output
                break;
        }
    }
    append(text.slice(lastIndex));

    // Close any blocks left open (e.g. while the template is being edited).
    while (stack.length) {
        const frame = stack.pop();
        frame.unclosed = true;
        append(closeFrame(frame));
    }
    text = root.html;

    // Step 5: output expressions → inline data chips, so sentences stay readable
    // instead of having invisible holes where values would go.
    text = text.replace(/\{\{-?([\s\S]*?)-?\}\}/g, (_, expr) => {
        expr = expr.split('|')[0].trim();
        const literal = expr.match(/^'([^']*)'$|^"([^"]*)"$/);
        if (literal) return escapeHtml(literal[1] !== undefined ? literal[1] : literal[2]);
        if (!expr) return '';
        stats.variables++;
        return `<span class="lp-var">${escapeHtml(humanizeName(expr))}</span>`;
    });

    return { html: text, stats };
}

function pluralize(count, singular, plural) {
    return `${count} ${count === 1 ? singular : (plural || singular + 's')}`;
}

function joinWithAnd(parts) {
    if (parts.length <= 1) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// Header shown above the annotated document: what it is, what it contains,
// and a plain-English key to the colour-coded markers. Used both in the
// webview and in the standalone export (which is why it carries no controls).
function buildFullPreviewHeader(templateUri, stats) {
    const fileName = templateUri ? path.basename(templateUri) : '';

    const summaryParts = [];
    if (stats.choices) summaryParts.push(`${pluralize(stats.choices, 'multiple-choice section')} (${pluralize(stats.options, 'option')} in total)`);
    if (stats.optionals) summaryParts.push(pluralize(stats.optionals, 'optional section'));
    if (stats.editors) summaryParts.push(pluralize(stats.editors, 'fill-in field'));
    if (stats.conditionals) summaryParts.push(pluralize(stats.conditionals, 'automatic section'));
    if (stats.loops) summaryParts.push(pluralize(stats.loops, 'repeating section'));
    if (stats.variables) summaryParts.push(pluralize(stats.variables, 'data value', 'data values'));
    const summary = summaryParts.length
        ? `This document contains ${joinWithAnd(summaryParts)}.`
        : 'This document has no options — it always reads exactly as shown below.';

    // An unclosed block absorbs everything after it, which is why the document
    // below can appear to run on past its end. Say so up front.
    const unclosedNotice = stats.unclosed
        ? `<div class="lp-warn">${pluralize(stats.unclosed, 'section is', 'sections are')} missing an end tag, so the content after ${stats.unclosed === 1 ? 'it' : 'them'} has been drawn inside. Look for the red “Not closed” markers below.</div>`
        : '';

    const legendRows = [];
    const legendRow = (cls, label, description) =>
        `<span class="lp-label ${cls}">${label}</span><span>${description}</span>`;
    if (stats.choices) legendRows.push(legendRow('lg-choice', 'Choose one', 'The writer picks exactly one of the numbered options.'));
    if (stats.optionals) legendRows.push(legendRow('lg-optional', 'Optional', 'The writer can include this content or leave it out.'));
    if (stats.editors) legendRows.push(legendRow('lg-editor', 'Fill in', 'The writer types this in; any text shown is the starting suggestion.'));
    if (stats.conditionals) legendRows.push(legendRow('lg-cond', 'Shown when…', 'Included automatically when the stated condition applies.'));
    if (stats.loops) legendRows.push(legendRow('lg-loop', 'Repeats', 'This section appears once for each item in a list.'));
    if (stats.variables) legendRows.push(`<span class="lp-var">example value</span><span>Filled in automatically from the case data.</span>`);
    // The note legend row hides together with the notes themselves (see .lp-legend-note CSS).
    if (stats.notes) legendRows.push(`<span class="lp-legend-note">${legendRow('lg-note', 'Author note', 'Guidance for template authors — never appears in the finished document.')}</span>`);

    const legend = legendRows.length
        ? `<details class="lp-legend" open><summary>What the markers mean</summary><div class="lp-legend-grid">${legendRows.join('')}</div></details>`
        : '';

    return `<div class="lp-header">
<div class="lp-doc-title">Document options${fileName ? ' — ' + escapeHtml(fileName) : ''}</div>
<div class="lp-summary">${summary}</div>
${unclosedNotice}
${legend}
</div>`;
}

// "Show HTML source" toggle plumbing shared by both HTML previews. Webview
// scripts are disabled, so the swap is wired up purely with CSS body:has().
// The rendered document keeps its white page (it previews the finished,
// printed document), but the source view follows the VS Code theme via the
// --vscode-* variables the editor injects into webviews; the fallbacks keep
// the rules harmless outside VS Code (e.g. in the standalone export).
const viewSourceStyles = `
  #lp-chrome { display: contents; }
  .lp-toolbar { position: sticky; top: 0; z-index: 9000; display: flex; flex-wrap: wrap; gap: 6px 18px; background: white; margin: -8px -8px 10px -8px; padding: 8px 10px; border-bottom: 1px solid #e0e0e0; }
  .lp-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #444; cursor: pointer; user-select: none; }
  .lp-toggle input { margin: 0; }
  .lp-source { display: none; }
  .lp-source-hint { font-family: sans-serif; font-size: 12px; color: var(--vscode-descriptionForeground, #444); margin-bottom: 8px; }
  .lp-source pre { background: none; border: none; margin: 0; padding: 2px 4px; color: var(--vscode-editor-foreground, #333); font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Menlo, Consolas, monospace); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.5; white-space: pre-wrap; word-break: break-word; cursor: text; }

  .lp-tk-tag, .lp-tk-doctype, .lp-tk-punct { color: #800000; }
  .lp-tk-attr { color: #e50000; }
  .lp-tk-str { color: #0000ff; }
  .lp-tk-comment { color: #008000; }
  body.vscode-dark .lp-tk-tag, body.vscode-dark .lp-tk-doctype,
  body.vscode-high-contrast .lp-tk-tag, body.vscode-high-contrast .lp-tk-doctype { color: #569cd6; }
  body.vscode-dark .lp-tk-punct, body.vscode-high-contrast .lp-tk-punct { color: #808080; }
  body.vscode-dark .lp-tk-attr, body.vscode-high-contrast .lp-tk-attr { color: #9cdcfe; }
  body.vscode-dark .lp-tk-str, body.vscode-high-contrast .lp-tk-str { color: #ce9178; }
  body.vscode-dark .lp-tk-comment, body.vscode-high-contrast .lp-tk-comment { color: #6a9955; }
  body:has(#lp-show-source:checked) { background-color: var(--vscode-editor-background, white); }
  body:has(#lp-show-source:checked) .lp-toggle { color: var(--vscode-foreground, #444); }
  body:has(#lp-show-source:checked) .lp-toolbar { background: var(--vscode-editor-background, white); border-bottom-color: var(--vscode-panel-border, #e0e0e0); }
  body:has(#lp-show-source:checked) #lp-rendered-root,
  body:has(#lp-show-source:checked) #lp-rendered-root ~ * { display: none; }
  body:has(#lp-show-source:checked) .lp-source { display: block; }`;

const htmlPreviewStyles = `
  .rlp-markdown > :first-child { margin-top: 0; }
  .rlp-markdown > :last-child { margin-bottom: 0; }
  .editor { border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .editor:has(input[type="checkbox"]) { border: 2px dashed #388e3c; background: #f1f8e9; }
  .editor:has(input[type="radio"]) { border: 2px solid #1976d2; background: #e3f2fd; }
  .editor:has(input[type="text"]), .editor:has(textarea) { border: 2px solid #f57c00; background: #fff8e1; }
  .editor:has(input[type="radio"]) label { display: block; padding: 6px 10px; margin: 4px 0; border: 1px solid #90caf9; border-radius: 3px; background: white; }
  .editor-intro { display: block; font-size: 11px; font-weight: bold; font-family: sans-serif; margin-bottom: 4px; }`
    + viewSourceStyles;

const fullPreviewStyles = `
  .lp-label { display: inline-block; font-family: sans-serif; font-size: 10px; font-weight: bold; line-height: 1.7; text-transform: uppercase; letter-spacing: 0.4px; color: white; padding: 0 8px; border-radius: 9px; margin-right: 8px; vertical-align: middle; }
  .lp-detail { font-family: sans-serif; font-size: 12px; font-style: italic; color: #555; margin-right: 6px; vertical-align: middle; }

  .lp-header { font-family: sans-serif; border: 1px solid #ddd; border-radius: 8px; background: #fafafa; padding: 12px 16px; margin: 0 0 18px 0; }
  .lp-doc-title { font-size: 16px; font-weight: bold; color: #222; }
  .lp-summary { font-size: 12.5px; color: #444; margin: 5px 0 4px 0; }
  .lp-legend { margin-top: 6px; }
  .lp-legend summary { font-size: 11.5px; font-weight: bold; color: #666; cursor: pointer; }
  .lp-legend-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 10px; align-items: center; font-size: 12px; color: #333; margin-top: 8px; }
  .lg-choice { background: #1976d2; }
  .lg-optional { background: #388e3c; }
  .lg-editor { background: #ef6c00; }
  .lg-cond { background: #7b1fa2; }
  .lg-loop { background: #00796b; }
  .lg-note { background: #9e9e9e; }

  .lp-choice { border: 1px solid #90caf9; border-radius: 6px; margin: 10px 0; overflow: hidden; background: white; }
  .lp-choice-head { background: #e3f2fd; border-bottom: 1px solid #bbdefb; padding: 5px 10px; }
  .lp-choice .lp-label { background: #1976d2; }
  .lp-option { padding: 6px 12px; }
  .lp-option + .lp-option { border-top: 1px dashed #90caf9; }
  .lp-opt-label { display: inline-block; font-family: sans-serif; font-size: 10px; font-weight: bold; color: #1565c0; background: #e3f2fd; border: 1px solid #90caf9; padding: 1px 8px; border-radius: 9px; margin: 2px 8px 2px 0; vertical-align: middle; }

  .lp-optional { border: 1px dashed #81c784; border-left: 4px solid #43a047; border-radius: 0 6px 6px 0; background: #f1f8e9; padding: 6px 10px; margin: 10px 0; }
  .lp-optional .lp-label { background: #388e3c; }

  .lp-editor { border: 1px solid #ffcc80; border-left: 4px solid #ef6c00; border-radius: 0 6px 6px 0; background: #fff8e1; padding: 6px 10px; margin: 10px 0; }
  .lp-editor .lp-label { background: #ef6c00; }

  .lp-cond { border: 1px solid #ce93d8; border-radius: 6px; margin: 10px 0; overflow: hidden; background: #faf5fb; }
  .lp-cond > .lp-branch { padding: 6px 12px; }
  .lp-branch + .lp-branch { border-top: 1px dashed #ce93d8; }
  .lp-cond .lp-label { background: #7b1fa2; }

  .lp-loop { border: 1px solid #80cbc4; border-left: 4px solid #00796b; border-radius: 0 6px 6px 0; background: #e0f2f1; padding: 6px 10px; margin: 10px 0; }
  .lp-loop .lp-label { background: #00796b; }

  .lp-note { border: 1px dashed #bdbdbd; border-radius: 6px; background: #f5f5f5; color: #616161; font-style: italic; font-size: 12px; padding: 4px 10px; margin: 8px 0; }
  .lp-note .lp-label { background: #9e9e9e; font-style: normal; }

  .lp-legend-note { display: contents; }
  body:has(#lp-show-notes:not(:checked)) .lp-note,
  body:has(#lp-show-notes:not(:checked)) .lp-legend-note { display: none; }

  .lp-warn { font-family: sans-serif; font-size: 12.5px; color: #b71c1c; background: #ffebee; border: 1px solid #ef9a9a; border-radius: 6px; padding: 5px 10px; margin: 6px 0 4px 0; }

  .lp-unclosed { border: 1px solid #ef9a9a; border-radius: 6px; background: #fff5f5; padding: 6px 10px; margin: 10px 0; }
  .lp-unclosed > .lp-label { background: #c62828; }

  .lp-var { display: inline; background: #eceff1; border: 1px solid #cfd8dc; border-radius: 4px; padding: 0 5px; color: #37474f; font-style: italic; white-space: nowrap; }`
    + viewSourceStyles + `
  .lp-source pre { user-select: all; }`;

// A complete standalone HTML document for the annotated view: preview styles
// and any external CSS are inlined, so the file works on its own (e.g. pasted
// into SharePoint or saved as an .html file).
function buildStandaloneHtml(content, cssText) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { background-color: white; color: black; margin: 0; padding: 16px; box-sizing: border-box; }
  h1, h2, h3, h4, h5, h6 { color: black; }${fullPreviewStyles}
${cssText}
</style>
</head>
<body>
${content}
</body>
</html>`;
}

// Tags that get their own indented line when formatting; everything else is
// treated as inline and left verbatim.
const HTML_BLOCK_TAGS = new Set(['html', 'head', 'body', 'title', 'meta', 'link', 'style', 'script', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'form', 'fieldset', 'legend', 'blockquote', 'hr', 'details', 'summary', 'figure', 'figcaption', 'address']);
// Elements with no closing tag, so an opening tag must not increase the indent.
const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Elements whose body is whitespace-sensitive and must be kept verbatim.
const HTML_RAW_TAGS = new Set(['pre', 'textarea', 'script', 'style']);

// Split HTML into tag/text/raw tokens. The scanner respects quoted attribute
// values (a '>' inside quotes does not end the tag), comments and doctypes,
// and captures raw-tag bodies verbatim.
function tokenizeHtml(html) {
    const tokens = [];
    let i = 0;
    let textStart = 0;
    const flushText = end => { if (end > textStart) tokens.push({ type: 'text', text: html.slice(textStart, end) }); };

    while (i < html.length) {
        if (html[i] !== '<' || !/[a-zA-Z\/!]/.test(html[i + 1] || '')) { i++; continue; }
        flushText(i);

        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i + 4);
            const close = end === -1 ? html.length : end + 3;
            tokens.push({ type: 'tag', kind: 'comment', name: '', text: html.slice(i, close) });
            i = textStart = close;
            continue;
        }

        // Scan to the matching '>', ignoring any inside quoted attribute values.
        let j = i + 1;
        let quote = null;
        while (j < html.length && (quote !== null || html[j] !== '>')) {
            if (quote === null && (html[j] === '"' || html[j] === "'")) quote = html[j];
            else if (html[j] === quote) quote = null;
            j++;
        }
        const close = j < html.length ? j + 1 : html.length;
        const text = html.slice(i, close);
        const nameMatch = text.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
        const name = nameMatch ? nameMatch[1].toLowerCase() : '';
        const kind = text[1] === '!' ? 'doctype' : (text[1] === '/' ? 'close' : 'open');
        i = textStart = close;

        if (kind === 'open' && HTML_RAW_TAGS.has(name)) {
            const closeRegex = new RegExp(`</${name}\\s*>`, 'i');
            const m = closeRegex.exec(html.slice(i));
            const bodyEnd = m ? i + m.index : html.length;
            const rawClose = m ? bodyEnd + m[0].length : html.length;
            tokens.push({ type: 'raw', name, openTag: text, body: html.slice(i, bodyEnd), closeTag: m ? m[0] : '' });
            i = textStart = rawClose;
        } else {
            tokens.push({ type: 'tag', kind, name, text });
        }
    }
    flushText(html.length);
    return tokens;
}

// Conservative HTML pretty-printer for the source views: block-level tags get
// their own indented lines and inline runs are kept together, with newlines
// inside them collapsed to a space. Only whitespace that cannot affect
// rendering is changed — inline content is otherwise verbatim and raw-tag
// bodies (pre, textarea, script, style) are untouched — so the formatted
// markup renders identically to the original.
function formatHtml(html) {
    const out = [];
    let indent = 0;
    let line = '';
    const pushLine = () => {
        const trimmed = line.replace(/\s*\n\s*/g, ' ').trim();
        if (trimmed) out.push('  '.repeat(indent) + trimmed);
        line = '';
    };

    for (const tok of tokenizeHtml(html)) {
        if (tok.type === 'text') {
            line += tok.text;
        } else if (tok.type === 'raw') {
            pushLine();
            out.push('  '.repeat(indent) + tok.openTag + tok.body + tok.closeTag);
        } else if (HTML_BLOCK_TAGS.has(tok.name) || tok.kind === 'comment' || tok.kind === 'doctype') {
            pushLine();
            if (tok.kind === 'close') {
                indent = Math.max(0, indent - 1);
                out.push('  '.repeat(indent) + tok.text);
            } else {
                out.push('  '.repeat(indent) + tok.text);
                if (tok.kind === 'open' && !HTML_VOID_TAGS.has(tok.name)) indent++;
            }
        } else {
            line += tok.text;
        }
    }
    pushLine();
    return out.join('\n');
}

// Syntax-highlight a tag's markup: punctuation, tag name, attribute names and
// quoted values each get a token span. All token text is escaped, and the
// combined textContent of the output equals the input exactly — the
// scroll-sync script and copy behaviour rely on that.
function highlightTagMarkup(text) {
    const m = text.match(/^(<\/?)([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!m) return `<span class="lp-tk-punct">${escapeHtml(text)}</span>`;
    let out = `<span class="lp-tk-punct">${escapeHtml(m[1])}</span><span class="lp-tk-tag">${escapeHtml(m[2])}</span>`;
    const rest = text.slice(m[0].length);
    let j = 0;
    while (j < rest.length) {
        const c = rest[j];
        if (/\s/.test(c)) {
            let k = j;
            while (k < rest.length && /\s/.test(rest[k])) k++;
            out += rest.slice(j, k);
            j = k;
        } else if (c === '"' || c === "'") {
            let k = rest.indexOf(c, j + 1);
            k = k === -1 ? rest.length : k + 1;
            out += `<span class="lp-tk-str">${escapeHtml(rest.slice(j, k))}</span>`;
            j = k;
        } else if (c === '=' || c === '>' || c === '/') {
            out += `<span class="lp-tk-punct">${escapeHtml(c)}</span>`;
            j++;
        } else {
            let k = j;
            while (k < rest.length && !/[\s=>\/"']/.test(rest[k])) k++;
            out += `<span class="lp-tk-attr">${escapeHtml(rest.slice(j, k))}</span>`;
            j = k;
        }
    }
    return out;
}

// Convert HTML source text into escaped, token-coloured markup for the source
// views, so the source reads like VS Code's own HTML highlighting. Colours
// follow the editor's default light/dark themes (see the .lp-tk-* rules).
function highlightHtml(html) {
    let out = '';
    for (const tok of tokenizeHtml(html)) {
        if (tok.type === 'text') {
            out += escapeHtml(tok.text);
        } else if (tok.type === 'raw') {
            out += highlightTagMarkup(tok.openTag) + escapeHtml(tok.body)
                + (tok.closeTag ? highlightTagMarkup(tok.closeTag) : '');
        } else if (tok.kind === 'comment') {
            out += `<span class="lp-tk-comment">${escapeHtml(tok.text)}</span>`;
        } else if (tok.kind === 'doctype') {
            out += `<span class="lp-tk-doctype">${escapeHtml(tok.text)}</span>`;
        } else {
            out += highlightTagMarkup(tok.text);
        }
    }
    return out;
}

// Content of the Full HTML Preview webview, split into two parts: 'chrome' is
// the extension's own markup — header with view toggles and the hidden panel
// holding the standalone HTML source — and 'rendered' is the annotated
// document. They are kept in separate containers (chrome first) so malformed
// HTML in the template — stray closing tags, unclosed elements — can never
// swallow or break out into the extension's UI when the browser parses it.
function buildFullPreviewContent(templateText, templateUri) {
    const { html, stats } = annotateLiquid(templateText);
    const cssText = readCssContents(templateUri);

    const exportContent = buildFullPreviewHeader(templateUri, stats) + html;
    const standalone = buildStandaloneHtml(exportContent, cssText);

    // The toggles are plain checkboxes wired up purely with CSS
    // (body:has(...) rules in fullPreviewStyles).
    const toggles = [];
    if (stats.notes) {
        toggles.push(`<label class="lp-toggle"><input type="checkbox" id="lp-show-notes" checked=""> Show ${pluralize(stats.notes, 'author note')}</label>`);
    }
    toggles.push(`<label class="lp-toggle"><input type="checkbox" id="lp-show-source"> Show HTML source</label>`);
    const toolbar = `<div class="lp-toolbar">${toggles.join('')}</div>`;

    const sourcePanel = `<div class="lp-source">
<div class="lp-source-hint">Standalone HTML for this document — styles are included, so it works on its own. Click the code below to select it all, copy, and paste into SharePoint or save as an .html file.</div>
<pre>${highlightHtml(formatHtml(standalone))}</pre>
</div>`;

    return {
        chrome: toolbar + buildFullPreviewHeader(templateUri, stats) + sourcePanel,
        rendered: html
    };
}

async function refreshHtmlFullPanel(preview, panel) {
    let diagnostics = [];
    let content = null;

    try {
        let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
        let templateText = templateDocument.getText();
        // The annotated view is built by its own scanner, which recovers from a
        // missing end tag instead of failing on it — so it can say that a
        // section is unclosed, but not which line to go and fix. Parse the
        // template as well, purely to borrow LiquidJS's exact position for the
        // first structural problem.
        try {
            liquidEngine.parse(templateText);
        } catch (err) {
            diagnostics.push(liquidDiagnostic('Template error', err, preview.templateUri));
        }
        content = buildFullPreviewContent(templateText, preview.templateUri);
        preview.lastRenderedHtml = content;
    } catch (err) {
        diagnostics.push(liquidDiagnostic('Template error', err, preview.templateUri));
        content = preview.lastRenderedHtml || { chrome: '', rendered: '' };
    }

    publishDiagnostics(preview, diagnostics);
    updatePreviewPanel(panel, preview, content.chrome + buildErrorPaneHtml(diagnostics), content.rendered, fullPreviewStyles);
}

// Run panel refreshes for one preview one at a time. The change handler is
// async and fires on every keystroke, so without a queue two refreshes overlap:
// they race on the shared warning buffer, and whichever render finishes last
// wins, which can leave the pane showing an older version of the template.
function queueRefresh(preview, run) {
    const next = (preview.refreshQueue || Promise.resolve()).then(run, run);
    preview.refreshQueue = next.catch(() => { });
    return next;
}

// Push new content into a preview panel: the first call sets the full webview
// document, later calls patch it in place via a message (see buildPreviewHtml)
// so the view isn't reloaded on every edit.
function updatePreviewPanel(panel, preview, chrome, rendered, styles) {
    if (panel._rlpInitialized) {
        panel.webview.postMessage({ type: 'update', chrome, rendered });
    } else {
        let cssLinks = buildCssLinks(preview.templateUri, panel.webview);
        panel.webview.html = buildPreviewHtml(cssLinks, chrome, rendered, styles);
        panel._rlpInitialized = true;
    }
}

async function refreshHtmlPanel(preview, panel) {
    let diagnostics = [];
    // Set when the file on disk no longer parses: the render below then runs
    // against the last version that did, so anything it reports describes a
    // template that is no longer there. Those positions would send the reader
    // to whatever now sits on that line, so they are dropped and only the parse
    // error — which is current, and the thing to fix — is reported.
    let templateIsStale = false;

    if (preview.templateUri && preview.templateDirty) {
        try {
            let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
            preview.template = liquidEngine.parse(templateDocument.getText());
            preview.templateDirty = false;
        } catch (err) {
            // Keep the previously parsed template so rendering can still proceed
            diagnostics.push(liquidDiagnostic('Template error', err, preview.templateUri));
            templateIsStale = true;
        }
    }

    if (preview.dataUri && preview.dataDirty) {
        let dataText = '';
        try {
            let dataDocument = await vscode.workspace.openTextDocument(preview.dataUri);
            dataText = dataDocument.getText();
            preview.data = JSON.parse(dataText);
            preview.dataDirty = false;
        } catch (err) {
            // Keep the previously parsed data so rendering can still proceed
            diagnostics.push(jsonDiagnostic('Data error', err, dataText, preview.dataUri));
        }
    }

    let rendered;
    try {
        const nameTracker = { seen: new Map(), dupes: [] };
        const dataWithTracker = Object.assign({}, preview.data, { _rlpTracker: nameTracker });
        _currentWarnings = [];
        rendered = await liquidEngine.render(preview.template, dataWithTracker);
        preview.lastRenderedHtml = rendered;
        if (!templateIsStale) {
            for (const name of nameTracker.dupes) {
                diagnostics.push(duplicateNameDiagnostic(name, nameTracker.seen.get(name) || [], preview.templateUri));
            }
            for (const warning of _currentWarnings) {
                diagnostics.push(diagnostic('warning', 'Warning', warning.message, preview.templateUri, warning.location));
            }
        }
    } catch (err) {
        if (!templateIsStale) diagnostics.push(liquidDiagnostic('Render error', err, preview.templateUri));
        rendered = preview.lastRenderedHtml || '';
    } finally {
        _currentWarnings = null;
    }

    publishDiagnostics(preview, diagnostics);
    updatePreviewPanel(panel, preview, buildHtmlPreviewChrome(rendered) + buildErrorPaneHtml(diagnostics), rendered, htmlPreviewStyles);
}

// The HTML Preview's own UI: a toolbar with a source toggle and a hidden
// panel with the document's underlying HTML — the same render currently in
// view, so it reflects the selected data and field values. Kept separate from
// the rendered document itself (see buildPreviewHtml).
function buildHtmlPreviewChrome(rendered) {
    const toolbar = `<div class="lp-toolbar"><label class="lp-toggle"><input type="checkbox" id="lp-show-source"> Show HTML source</label></div>`;
    const sourcePanel = `<div class="lp-source">
<div class="lp-source-hint">The HTML behind the view below, as rendered with the current data and field values.</div>
<pre>${highlightHtml(formatHtml(rendered))}</pre>
</div>`;
    return toolbar + sourcePanel;
}

function findCssPaths(templateUri) {
    const fs = require('fs');
    let cssPaths = [];

    // CSS files at workspace root(s)
    for (let folder of (vscode.workspace.workspaceFolders || [])) {
        let rootCss = path.join(folder.uri.fsPath, 'universal.css');
        if (fs.existsSync(rootCss)) {
            cssPaths.push(rootCss);
        }
    }

    // CSS files in a 'css/' folder alongside the template
    if (templateUri) {
        let templateDir = path.dirname(templateUri);
        let cssDir = path.join(templateDir, 'css');
        if (fs.existsSync(cssDir) && fs.statSync(cssDir).isDirectory()) {
            for (let file of fs.readdirSync(cssDir)) {
                if (file.endsWith('.css')) {
                    cssPaths.push(path.join(cssDir, file));
                }
            }
        }
    }

    return cssPaths;
}

function buildCssLinks(templateUri, webview) {
    return findCssPaths(templateUri)
        .map(p => {
            let uri = webview.asWebviewUri(vscode.Uri.file(p));
            return `<link rel="stylesheet" href="${uri}">`;
        })
        .join('\n');
}

// Concatenated contents of the workspace/template CSS files, for inlining into
// a standalone document.
function readCssContents(templateUri) {
    const fs = require('fs');
    return findCssPaths(templateUri)
        .map(p => `/* ${path.basename(p)} */\n${fs.readFileSync(p, 'utf8')}`)
        .join('\n');
}

// One row of the problems pane: what went wrong and, wherever we can work it
// out, which file, line and column to send the reader to. `location` is the
// {line, col, snippet} shape produced by tokenLocation.
function diagnostic(severity, title, message, file, location) {
    return Object.assign(
        { severity, title, message, file: file || null, line: null, col: null, snippet: '' },
        location || {}
    );
}

// A diagnostic from a LiquidJS error. Parse, tokenization and render errors all
// carry the token they failed on, which is the position the reader wants.
function liquidDiagnostic(title, err, file) {
    return diagnostic('error', title, cleanLiquidMessage(err.message), file, tokenLocation(err.token));
}

// LiquidJS appends ", file:…, line:N, col:M" to its messages. The pane shows
// that position as a link of its own, so it is stripped from the prose rather
// than repeated in it.
function cleanLiquidMessage(message) {
    return String(message).replace(/,\s*(?:file:[^,]*,\s*)?line:\d+,\s*col:\d+\s*$/, '');
}

// A diagnostic from a failed JSON.parse of the data file. JSON.parse reports
// the position inside the message text and the wording varies by Node version:
// newer ones give "(line 3 column 5)", older ones only a character offset.
// Both are turned into a real position, and the trailing position prose — now
// shown properly — is trimmed off the message.
function jsonDiagnostic(title, err, text, file) {
    const message = String(err.message);
    const lineColumn = /line (\d+) column (\d+)/.exec(message);
    const position = /position (\d+)/.exec(message);
    let line = null;
    let col = null;
    if (lineColumn) {
        line = Number(lineColumn[1]);
        col = Number(lineColumn[2]);
    } else if (position) {
        const before = text.slice(0, Number(position[1])).split('\n');
        line = before.length;
        col = before[before.length - 1].length + 1;
    }
    const location = line
        ? { line, col, snippet: snippetOf(text.split('\n')[line - 1] || '') }
        : null;
    return diagnostic('error', title, message.replace(/\s*in JSON at position \d+.*$/, ''), file, location);
}

// Reporter keys the writer's answers by field name, so a repeated name silently
// ties two fields together. Point at the repeat itself and name the line it
// collides with, rather than listing the names and leaving the hunt to the
// reader.
function duplicateNameDiagnostic(name, uses, file) {
    const located = uses.filter(Boolean);
    const first = located[0];
    const repeat = located[1] || first;
    const elsewhere = first && repeat !== first ? ` It is first used on line ${first.line}.` : '';
    return diagnostic(
        'error',
        'Duplicate field name',
        `“${name}” is used ${pluralize(uses.length, 'time')} — every field needs its own name.${elsewhere}`,
        file,
        repeat
    );
}

// Collapse identical repeats into a single row with a count. A warning raised
// by a filter inside a loop fires once per iteration, and fifty copies of the
// same line push everything else out of a pane 200px tall.
function dedupeDiagnostics(diagnostics) {
    const byKey = new Map();
    for (const item of diagnostics) {
        const key = JSON.stringify([item.severity, item.title, item.message, item.file, item.line, item.col]);
        const existing = byKey.get(key);
        if (existing) existing.count++;
        else byKey.set(key, Object.assign({ count: 1 }, item));
    }
    return Array.from(byKey.values());
}

// The pane pinned to the bottom of the preview. Errors first, then warnings,
// each row carrying the position it came from as a button: the webview posts
// the position back and the extension opens the file there (see
// wirePreviewMessages).
function buildErrorPaneHtml(diagnostics) {
    if (!diagnostics || diagnostics.length === 0) return '';
    const rows = dedupeDiagnostics(diagnostics);
    const errors = rows.filter(d => d.severity !== 'warning');
    const warnings = rows.filter(d => d.severity === 'warning');

    const counts = [];
    if (errors.length) counts.push(pluralize(errors.length, 'error'));
    if (warnings.length) counts.push(pluralize(warnings.length, 'warning'));

    return `
<div id="error-pane">
  <div class="diag-head">
    <span class="diag-head-title">${joinWithAnd(counts)}</span>
    <label class="diag-collapse"><input type="checkbox" id="lp-hide-problems"> Hide</label>
  </div>
  <div class="diag-list">
${errors.concat(warnings).map(buildDiagnosticHtml).join('\n')}
  </div>
</div>`;
}

function buildDiagnosticHtml(item) {
    const icon = item.severity === 'warning' ? '&#9432;' : '&#9888;';
    const count = item.count > 1 ? `<span class="diag-count">&times;${item.count}</span>` : '';
    const snippet = item.snippet ? `<div class="diag-snippet">${escapeHtml(item.snippet)}</div>` : '';
    return `<div class="diag diag-${item.severity}">
  <div class="diag-line"><span class="diag-title">${icon} ${escapeHtml(item.title)}</span>${buildDiagnosticLocationHtml(item)}${count}</div>
  <pre class="diag-message">${escapeHtml(item.message)}</pre>
  ${snippet}
</div>`;
}

// The clickable position. Without a line there is nowhere to jump to, so what
// we do know is rendered as plain text rather than as a button that would do
// nothing when pressed.
function buildDiagnosticLocationHtml(item) {
    const name = item.file ? path.basename(item.file) : '';
    if (!item.line) return name ? `<span class="diag-where">${escapeHtml(name)}</span>` : '';
    const label = `${name ? name + ':' : 'line '}${item.line}:${item.col || 1}`;
    if (!item.file) return `<span class="diag-where">${escapeHtml(label)}</span>`;
    return `<button type="button" class="diag-where diag-goto"`
        + ` data-diag-file="${escapeHtml(item.file)}"`
        + ` data-diag-line="${item.line}" data-diag-col="${item.col || 1}"`
        + ` title="Go to line ${item.line} in ${escapeHtml(name)}">${escapeHtml(label)}</button>`;
}

// The Problems panel mirror of the pane, so the same positions show up as
// squiggles in the editor. Rows are held per preview — closing one preview must
// not wipe another's — and the whole collection is rebuilt on every change,
// because a DiagnosticCollection is keyed by file rather than by contributor.
let _diagnosticCollection = null;
const _previewDiagnostics = new Map();

function publishDiagnostics(preview, diagnostics) {
    _previewDiagnostics.set(preview.id, diagnostics.filter(d => d.file && d.line));
    republishDiagnostics();
}

function clearPreviewDiagnostics(preview) {
    _previewDiagnostics.delete(preview.id);
    republishDiagnostics();
}

function republishDiagnostics() {
    if (!_diagnosticCollection) return;
    const all = [];
    for (const diagnostics of _previewDiagnostics.values()) all.push(...diagnostics);

    const byFile = new Map();
    for (const item of dedupeDiagnostics(all)) {
        if (!byFile.has(item.file)) byFile.set(item.file, []);
        byFile.get(item.file).push(toVsCodeDiagnostic(item));
    }

    _diagnosticCollection.clear();
    for (const [file, items] of byFile) {
        _diagnosticCollection.set(vscode.Uri.file(file), items);
    }
}

// Underline the construct itself rather than a single character, so the
// squiggle covers the tag that went wrong. VS Code clamps a range that runs
// past the end of the line, which is what happens when the original spanned
// several lines and the snippet collapsed it onto one.
function toVsCodeDiagnostic(item) {
    const line = Math.max(0, item.line - 1);
    const col = Math.max(0, (item.col || 1) - 1);
    const range = new vscode.Range(line, col, line, col + Math.max(1, item.snippet.length));
    const severity = item.severity === 'warning'
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Error;
    const result = new vscode.Diagnostic(range, `${item.title}: ${item.message}`, severity);
    result.source = 'Reporter Liquid Preview';
    return result;
}

// Listen for the position a reader clicked in the problems pane and open it.
function wirePreviewMessages(panel) {
    panel.webview.onDidReceiveMessage(message => {
        if (message && message.type === 'reveal' && message.file) {
            revealInEditor(message.file, message.line, message.col);
        }
    });
}

// Show `file` with the caret at the given 1-based line and column. An editor
// already showing the file keeps its column, so clicking a problem does not
// shuffle the reader's layout around; otherwise the file opens in the first
// column rather than on top of the preview.
async function revealInEditor(file, line, col) {
    try {
        const document = await vscode.workspace.openTextDocument(file);
        const visible = vscode.window.visibleTextEditors
            .filter(editor => editor.document && editor.document.uri.fsPath === document.uri.fsPath)[0];
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: visible ? visible.viewColumn : vscode.ViewColumn.One,
            preview: false
        });
        const position = new vscode.Position(Math.max(0, (line || 1) - 1), Math.max(0, (col || 1) - 1));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
        vscode.window.showErrorMessage(`Reporter Liquid Preview: could not open ${file} (${err.message})`);
    }
}

// Full webview document. chrome (the extension's own UI, including the error
// pane) and rendered (the template's output) live in separate containers,
// with chrome first: nothing that precedes the template content in the parse
// can be damaged by its malformed HTML, and content escaping #lp-rendered-root
// only ever spills into following siblings, which the source-view CSS hides
// along with the container itself.
//
// The document is set once per panel; later renders are posted as 'update'
// messages and patched into the two containers by the script below, so a live
// edit doesn't reload the document — scroll position and toggle checkboxes
// survive it. Patching each container separately via innerHTML also uses
// fragment parsing, which cannot leak content outside its container.
function buildPreviewHtml(cssLinks, chrome, rendered, extraStyles = '') {
    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { background-color: white; color: black; margin: 0; padding: 8px; box-sizing: border-box; }
  body:has(#error-pane) { padding-bottom: 230px; }
  /* Collapsing the pane frees the space it was reserving. Same specificity as
     the rule above, so it has to come after it to win. */
  body:has(#lp-hide-problems:checked) { padding-bottom: 46px; }
  h1, h2, h3, h4, h5, h6 { color: black; }
  #error-pane { position: fixed; bottom: 0; left: 0; right: 0; display: flex; flex-direction: column; max-height: 220px; background: #1e1a10; border-top: 2px solid #f14c4c; font-family: sans-serif; z-index: 9999; }
  #error-pane:has(#lp-hide-problems:checked) .diag-list { display: none; }
  .diag-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 12px; }
  .diag-head-title { font-size: 12px; font-weight: bold; color: #e8d9b0; }
  .diag-collapse { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #b9ad8e; cursor: pointer; }
  .diag-list { overflow-y: auto; padding: 0 12px 8px 12px; }
  .diag { margin-bottom: 8px; }
  .diag:last-child { margin-bottom: 0; }
  .diag-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; margin-bottom: 2px; }
  .diag-title { font-size: 12px; font-weight: bold; color: #f14c4c; }
  .diag-warning .diag-title { color: #cca700; }
  .diag-count { font-size: 11px; color: #1e1a10; background: #b9ad8e; border-radius: 8px; padding: 0 6px; }
  .diag-where { font-family: monospace; font-size: 11px; color: #9cdcfe; background: transparent; border: 1px solid #4a4130; border-radius: 4px; padding: 0 5px; }
  button.diag-goto { cursor: pointer; }
  button.diag-goto:hover, button.diag-goto:focus { background: #2d2718; color: #cfe9ff; outline: none; }
  #error-pane pre.diag-message { margin: 0; font-family: monospace; font-size: 11px; color: #d4d4d4; white-space: pre-wrap; word-break: break-word; }
  .diag-snippet { margin-top: 3px; padding-left: 6px; border-left: 2px solid #4a4130; font-family: monospace; font-size: 11px; color: #b9ad8e; white-space: pre-wrap; word-break: break-word; }${extraStyles}
</style>
${cssLinks}
</head>
<body>
<div id="lp-chrome">
${chrome}
</div>
<div id="lp-rendered-root">
${rendered}
</div>
<script>
    window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'update') return;
        const toggles = {};
        for (const input of document.querySelectorAll('.lp-toggle input[id], #error-pane input[id]')) {
            toggles[input.id] = input.checked;
        }
        const legend = document.querySelector('.lp-legend');
        const legendOpen = legend ? legend.open : null;
        const x = window.scrollX, y = window.scrollY;
        document.getElementById('lp-chrome').innerHTML = msg.chrome;
        document.getElementById('lp-rendered-root').innerHTML = msg.rendered;
        for (const id in toggles) {
            const input = document.getElementById(id);
            if (input) input.checked = toggles[id];
        }
        const newLegend = document.querySelector('.lp-legend');
        if (newLegend && legendOpen !== null) newLegend.open = legendOpen;
        window.scrollTo(x, y);
    });

    // ---- Jump to the source of a problem ----
    // Clicking a position in the problems pane asks the extension to open that
    // file at that line (see wirePreviewMessages). The listener is delegated so
    // it survives the content patch above, and no-ops outside VS Code, where
    // there is no extension to post to.
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    document.addEventListener('click', event => {
        const button = event.target && event.target.closest && event.target.closest('.diag-goto');
        if (!button || !vscodeApi) return;
        vscodeApi.postMessage({
            type: 'reveal',
            file: button.getAttribute('data-diag-file'),
            line: Number(button.getAttribute('data-diag-line')),
            col: Number(button.getAttribute('data-diag-col'))
        });
    });

    // ---- Scroll sync between the rendered view and the HTML source view ----
    // On toggle, anchor on the text at the top of the viewport in the view
    // being left and scroll the view being entered to that same text. If the
    // anchor can't be found (e.g. entity differences), the scroll is left
    // alone rather than jumping to the top.

    const sourcePre = () => document.querySelector('.lp-source pre');
    const toolbarBottom = () => {
        const bar = document.querySelector('.lp-toolbar');
        return bar ? bar.getBoundingClientRect().bottom : 0;
    };

    const escapeRegex = s => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    // Whitespace-tolerant matcher from the first few words of a snippet.
    const snippetRegex = snippet => {
        const words = String(snippet).trim().split(/\\s+/).slice(0, 8);
        return words.length ? new RegExp(words.map(escapeRegex).join('\\\\s+')) : null;
    };

    // First meaningful text currently visible in the rendered view.
    function renderedTopSnippet() {
        const root = document.getElementById('lp-rendered-root');
        const limit = toolbarBottom() + 4;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue;
            const el = node.parentElement;
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.height > 0 && r.bottom > limit) return node.textContent.trim().slice(0, 80);
        }
        return '';
    }

    // A Range covering [start, start+1) of a container's concatenated text.
    function rangeAtOffset(container, start) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let node, pos = 0;
        while ((node = walker.nextNode())) {
            const next = pos + node.length;
            if (start < next) {
                const range = document.createRange();
                range.setStart(node, start - pos);
                range.setEnd(node, Math.min(start - pos + 1, node.length));
                return range;
            }
            pos = next;
        }
        return null;
    }

    function scrollSourceToSnippet(snippet) {
        const pre = sourcePre();
        const re = snippet && snippetRegex(snippet);
        if (!pre || !re) return;
        const m = re.exec(pre.textContent);
        if (!m) return;
        const range = rangeAtOffset(pre, m.index);
        if (!range) return;
        const rect = range.getBoundingClientRect();
        window.scrollTo(0, Math.max(0, window.scrollY + rect.top - toolbarBottom() - 16));
    }

    // Plain-text snippet (tag markup skipped) at the top of the source view.
    function sourceTopSnippet() {
        const pre = sourcePre();
        if (!pre) return '';
        const text = pre.textContent;
        let offset = 0;
        const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(24, toolbarBottom() + 12) : null;
        if (caret && pre.contains(caret.startContainer)) {
            const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode()) && node !== caret.startContainer) offset += node.length;
            offset += caret.startOffset;
        }
        // If the offset lands inside a tag, skip to the end of that tag.
        const nextLt = text.indexOf('<', offset), nextGt = text.indexOf('>', offset);
        let i = (nextGt !== -1 && (nextLt === -1 || nextGt < nextLt)) ? nextGt + 1 : offset;
        let out = '', inTag = false;
        while (i < text.length && out.length < 60) {
            const c = text[i++];
            if (c === '<') inTag = true;
            else if (c === '>') inTag = false;
            else if (!inTag) out += c;
        }
        return out;
    }

    function scrollRenderedToSnippet(snippet) {
        const root = document.getElementById('lp-rendered-root');
        const re = snippet && snippetRegex(snippet);
        if (!root || !re) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node, buf = '';
        while ((node = walker.nextNode())) {
            nodes.push({ start: buf.length, node });
            // Separate nodes with a newline: adjacent block elements have no
            // whitespace between their text nodes, but the source does, and
            // the whitespace-tolerant regex absorbs the extra separator.
            buf += node.textContent + '\\n';
        }
        const m = re.exec(buf);
        if (!m) return;
        let target = null;
        for (const entry of nodes) {
            if (entry.start <= m.index) target = entry.node; else break;
        }
        const el = target && target.parentElement;
        if (!el) return;
        window.scrollTo(0, Math.max(0, window.scrollY + el.getBoundingClientRect().top - toolbarBottom() - 16));
    }

    // Delegated so the listener survives content patches. The checkbox is
    // flipped back briefly to measure the view being left — this happens
    // within a single frame, so nothing visibly flickers.
    document.addEventListener('change', event => {
        const input = event.target;
        if (!input || input.id !== 'lp-show-source') return;
        if (input.checked) {
            input.checked = false;
            const snippet = renderedTopSnippet();
            input.checked = true;
            scrollSourceToSnippet(snippet);
        } else {
            input.checked = true;
            const snippet = sourceTopSnippet();
            input.checked = false;
            scrollRenderedToSnippet(snippet);
        }
    });
</script>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function createNewPreview(document) {
    let id = Date.now();
    let preview = {
        id: id,
        uri: function () {
            let templateFile = this.templateUri && path.basename(this.templateUri);
            let dataFile = this.dataUri && path.basename(this.dataUri);
            let dataFileString = dataFile ? dataFile + ' + ' : '';
            let previewFile = 'Preview ' + dataFileString + templateFile + '?id=' + id;

            return vscode.Uri.parse('reporter-liquid-preview:' + previewFile);
        },
        templateUri: document.fileName,
        templateDirty: true,
        template: [],
        dataUri: null,
        dataDirty: false,
        data: {},
        lastRenderedHtml: ''
    };
    return preview;
}

function getDocumentPreviews(previewContentProvider, document) {
    let documentPreviews = [];
    for (let previewId in previewContentProvider.previews) {
        let preview = previewContentProvider.previews[previewId];

        let isData = preview.dataUri === document.fileName;
        let isTemplate = preview.templateUri === document.fileName;

        if (isData || isTemplate) {
            documentPreviews.push({
                preview,
                isData,
                isTemplate
            });
        }
    }
    return documentPreviews;
}

async function updatePreviewDataFile(preview) {
    let jsonUris = await vscode.workspace.findFiles('**/*.json');
    let jsonPickItems = jsonUris.map(jsonUri => {
        return {
            label: jsonUri.fsPath && path.basename(jsonUri.fsPath),
            description: jsonUri.fsPath,
            value: jsonUri.fsPath
        };
    });
    let pickedItem = await vscode.window.showQuickPick(jsonPickItems, {
        canPickMany: false,
        placeHolder: 'Choose a file to use as fake data for your template.'
    });
    if (pickedItem) {
        preview.dataUri = pickedItem.value;
        preview.dataDirty = true;
    }
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
}