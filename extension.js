const path = require('path');
const vscode = require('vscode');
const liquid = require('liquidjs');
const liquidEngine = new liquid();

// Accumulates warnings during a single render pass. Set to [] before rendering, null otherwise.
let _currentWarnings = null;

// register custom Liquid tags used in templates
registerCustomTags(liquidEngine);

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

// Record a tag name into the per-render duplicate tracker (injected via render context).
function trackTagName(name, ctx) {
    const tracker = ctx && ctx.environments && ctx.environments._rlpTracker;
    if (!tracker || !name) return;
    if (tracker.seen.includes(name)) {
        if (!tracker.dupes.includes(name)) tracker.dupes.push(name);
    } else {
        tracker.seen.push(name);
    }
}

function registerCustomFilters(engine) {
    // money filter: rounds to 2 decimal places or appends .00 if no decimals, with comma separators
    engine.registerFilter('money', value => {
        const num = parseFloat(value);
        if (isNaN(num)) return value;
        return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });

    // slice filter: override built-in to warn instead of error when the value is missing
    engine.registerFilter('slice', (v, begin, length = 1) => {
        if (v == null) {
            if (_currentWarnings) _currentWarnings.push(`slice filter: value is missing (returned empty)`);
            return '';
        }
        begin = begin < 0 ? v.length + begin : begin;
        return v.slice(begin, begin + length);
    });

    // where filter: override built-in to warn instead of error when the value is missing
    engine.registerFilter('where', (arr, property, value) => {
        if (arr == null) {
            if (_currentWarnings) _currentWarnings.push(`where filter: array is missing (filtering by property "${property}")`);
            return [];
        }
        return arr.filter(obj => value === undefined ? (obj[property] !== false && obj[property] !== undefined && obj[property] !== null) : obj[property] === value);
    });

    // sort filter: override built-in to warn on null and support sorting by property key
    engine.registerFilter('sort', (arr, property) => {
        if (arr == null) {
            if (_currentWarnings) _currentWarnings.push(`sort filter: array is missing (returned empty)`);
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

    // sort_natural filter: case-insensitive sort, optionally by property key
    engine.registerFilter('sort_natural', (arr, property) => {
        if (arr == null) {
            if (_currentWarnings) _currentWarnings.push(`sort_natural filter: array is missing (returned empty)`);
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

            await refreshHtmlPanel(preview, panel);

            panel.onDidDispose(() => {
                delete htmlPreviews[preview.id];
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

            await refreshHtmlFullPanel(preview, panel);

            panel.onDidDispose(() => {
                delete htmlFullPreviews[preview.id];
            });
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (textDocumentChangeEvent) => {
        // Update text previews
        let documentPreviews = getDocumentPreviews(previewContentProvider, textDocumentChangeEvent.document);
        for (let documentPreview of documentPreviews) {
            if (documentPreview.isTemplate || documentPreview.isData) {
                documentPreview.preview.templateDirty = documentPreview.isTemplate;
                documentPreview.preview.dataDirty = documentPreview.isData;

                previewContentProvider.onDidChangeEmitter.fire(documentPreview.preview.uri());
            }
        }

        // Update HTML previews
        for (let id in htmlPreviews) {
            let { preview, panel } = htmlPreviews[id];
            let isTemplate = preview.templateUri === textDocumentChangeEvent.document.fileName;
            let isData = preview.dataUri === textDocumentChangeEvent.document.fileName;
            if (isTemplate || isData) {
                preview.templateDirty = isTemplate;
                preview.dataDirty = isData;
                await refreshHtmlPanel(preview, panel);
            }
        }

        // Update full HTML previews
        for (let id in htmlFullPreviews) {
            let { preview, panel } = htmlFullPreviews[id];
            if (preview.templateUri === textDocumentChangeEvent.document.fileName) {
                await refreshHtmlFullPanel(preview, panel);
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

function stripLiquidFromHtmlTags(text) {
    // Remove liquid tags/expressions that appear inside HTML element open/close tags
    // (attribute-level liquid). Uses a character scanner so that '>' inside liquid
    // conditions (e.g. {% if x > 3 %}) does not prematurely end the HTML tag match.
    let result = '';
    let i = 0;
    let inHtmlTag = false;
    let inQuote = null; // '"' or "'" when inside a quoted attribute value

    while (i < text.length) {
        const ch = text[i];
        if (!inHtmlTag && ch === '<' && /[a-zA-Z\/!]/.test(text[i + 1] || '')) {
            inHtmlTag = true;
            result += ch; i++;
        } else if (inHtmlTag && inQuote === null && ch === '>') {
            inHtmlTag = false;
            result += ch; i++;
        } else if (inHtmlTag && inQuote === null && (ch === '"' || ch === "'")) {
            inQuote = ch;
            result += ch; i++;
        } else if (inHtmlTag && inQuote !== null && ch === inQuote) {
            inQuote = null;
            result += ch; i++;
        } else if (inHtmlTag && ch === '{' && (text[i + 1] === '%' || text[i + 1] === '{')) {
            // Liquid tag or expression inside an HTML tag – discard it entirely
            const closeSeq = text[i + 1] === '%' ? '%}' : '}}';
            i += 2;
            if (text[i] === '-') i++; // optional leading whitespace-strip dash
            while (i < text.length) {
                if (text[i] === '-' && text[i + 1] === closeSeq[0] && text[i + 2] === closeSeq[1]) { i += 3; break; }
                if (text[i] === closeSeq[0] && text[i + 1] === closeSeq[1]) { i += 2; break; }
                i++;
            }
        } else {
            result += ch; i++;
        }
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
//
// With includeNotes: false, {% comment %} blocks are removed instead of shown
// as author-note boxes. Loops and conditionals whose body then has no visible
// content (e.g. it was only a comment) are dropped by the same logic that
// hides logic-only blocks, and the stats reflect what actually remains.
function annotateLiquid(text, { includeNotes = true } = {}) {
    const stats = { choices: 0, options: 0, optionals: 0, editors: 0, conditionals: 0, loops: 0, notes: 0, variables: 0 };

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
        if (!includeNotes) return '';
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

    // Render a completed frame to HTML. Returns '' for hidden logic-only blocks.
    const closeFrame = frame => {
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
            case 'tablerow':
                if (!hasVisibleContent(frame.html)) return '';
                stats.loops++;
                return `<div class="lp-loop"><div class="lp-loop-head">${frame.label}</div>${frame.html}</div>`;
        }
        return frame.html;
    };

    // Pop the top frame if it matches and append its rendered form.
    const closeIf = type => {
        const frame = peek();
        if (frame && frame.type === type) {
            stack.pop();
            append(closeFrame(frame));
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
                closeIf('choice');
                break;
            case 'optional': {
                const args = parseTagArgs(rest);
                stack.push({ type: 'optional', label: annotationLabel('Optional', humanizeName(args.name || args.nameVar)), html: '' });
                break;
            }
            case 'endoptional':
                closeIf('optional');
                break;
            case 'editor': {
                const args = parseTagArgs(rest);
                const what = args.placeholder || humanizeName(args.name || args.nameVar);
                stack.push({ type: 'editor', label: annotationLabel('Fill in', what), html: '' });
                break;
            }
            case 'endeditor':
                closeIf('editor');
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
                }
                break;
            }
            case 'endif':
            case 'endunless':
                closeIf('if');
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
                closeIf('case');
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
                closeIf('for');
                break;
            case 'endtablerow':
                closeIf('tablerow');
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

  /* Documents often cap their width (e.g. section { max-width: 1024px }), so
     an annotated table can be wider than the box it sits in. Boxes clip at
     rounded corners (overflow: hidden), which would make the table's right
     edge unreachable — the inner branch/option containers scroll horizontally
     instead, so every column can still be read. */
  .lp-choice { border: 1px solid #90caf9; border-radius: 6px; margin: 10px 0; overflow: hidden; background: white; }
  .lp-choice-head { background: #e3f2fd; border-bottom: 1px solid #bbdefb; padding: 5px 10px; }
  .lp-choice .lp-label { background: #1976d2; }
  .lp-option { padding: 6px 12px; overflow-x: auto; }
  .lp-option + .lp-option { border-top: 1px dashed #90caf9; }
  .lp-opt-label { display: inline-block; font-family: sans-serif; font-size: 10px; font-weight: bold; color: #1565c0; background: #e3f2fd; border: 1px solid #90caf9; padding: 1px 8px; border-radius: 9px; margin: 2px 8px 2px 0; vertical-align: middle; }

  .lp-optional { border: 1px dashed #81c784; border-left: 4px solid #43a047; border-radius: 0 6px 6px 0; background: #f1f8e9; padding: 6px 10px; margin: 10px 0; overflow-x: auto; }
  .lp-optional .lp-label { background: #388e3c; }

  .lp-editor { border: 1px solid #ffcc80; border-left: 4px solid #ef6c00; border-radius: 0 6px 6px 0; background: #fff8e1; padding: 6px 10px; margin: 10px 0; overflow-x: auto; }
  .lp-editor .lp-label { background: #ef6c00; }

  .lp-cond { border: 1px solid #ce93d8; border-radius: 6px; margin: 10px 0; overflow: hidden; background: #faf5fb; }
  .lp-cond > .lp-branch { padding: 6px 12px; overflow-x: auto; }
  .lp-branch + .lp-branch { border-top: 1px dashed #ce93d8; }
  .lp-cond .lp-label { background: #7b1fa2; }

  /* Loops are marked with a left rail and a label strip rather than a full
     box: they nest inside one another, and a padded box on both sides quickly
     narrows the usable width until tables inside deep loops get crushed.
     The rail costs 13px on the left per level and nothing on the right. */
  .lp-loop { border-left: 3px solid #00796b; padding: 0 0 0 10px; margin: 10px 0; overflow-x: auto; }
  .lp-loop-head { display: inline-block; background: #e0f2f1; border: 1px solid #80cbc4; border-left: none; border-radius: 0 9px 9px 0; padding: 2px 8px 2px 6px; margin: 0 0 4px -10px; }
  .lp-loop .lp-label { background: #00796b; }

  .lp-note { border: 1px dashed #bdbdbd; border-radius: 6px; background: #f5f5f5; color: #616161; font-style: italic; font-size: 12px; padding: 4px 10px; margin: 8px 0; }
  .lp-note .lp-label { background: #9e9e9e; font-style: normal; }

  .lp-legend-note { display: contents; }
  body:has(#lp-show-notes:not(:checked)) .lp-note,
  body:has(#lp-show-notes:not(:checked)) .lp-legend-note { display: none; }

  .lp-var { display: inline; background: #eceff1; border: 1px solid #cfd8dc; border-radius: 4px; padding: 0 5px; color: #37474f; font-style: italic; white-space: nowrap; }
  /* Inside table cells, long chip names must wrap: a nowrap chip sets the
     column's minimum width, and on a width-limited page that forces the
     whole table wider than its container. */
  td .lp-var, th .lp-var { white-space: normal; }`
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

    // The standalone export is the publishable document, so author notes are
    // left out of it entirely — a second annotation pass without notes also
    // drops any loop or conditional that held nothing but a note, and its
    // stats keep the export's own summary header accurate.
    const exported = annotateLiquid(templateText, { includeNotes: false });
    const exportContent = buildFullPreviewHeader(templateUri, exported.stats) + exported.html;
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
    let errors = [];
    let content = null;

    try {
        let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
        content = buildFullPreviewContent(templateDocument.getText(), preview.templateUri);
        preview.lastRenderedHtml = content;
    } catch (err) {
        errors.push({ title: 'Template error', message: err.message });
        content = preview.lastRenderedHtml || { chrome: '', rendered: '' };
    }

    updatePreviewPanel(panel, preview, content.chrome + buildErrorPaneHtml(errors), content.rendered, fullPreviewStyles);
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
    let errors = [];

    if (preview.templateUri && preview.templateDirty) {
        try {
            let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
            preview.template = liquidEngine.parse(templateDocument.getText());
            preview.templateDirty = false;
        } catch (err) {
            // Keep the previously parsed template so rendering can still proceed
            errors.push({ title: 'Template error', message: err.message });
        }
    }

    if (preview.dataUri && preview.dataDirty) {
        try {
            let dataDocument = await vscode.workspace.openTextDocument(preview.dataUri);
            preview.data = JSON.parse(dataDocument.getText());
            preview.dataDirty = false;
        } catch (err) {
            // Keep the previously parsed data so rendering can still proceed
            errors.push({ title: 'Data error', message: err.message });
        }
    }

    let rendered;
    try {
        const nameTracker = { seen: [], dupes: [] };
        const dataWithTracker = Object.assign({}, preview.data, { _rlpTracker: nameTracker });
        _currentWarnings = [];
        rendered = await liquidEngine.render(preview.template, dataWithTracker);
        preview.lastRenderedHtml = rendered;
        if (nameTracker.dupes.length > 0) {
            errors.push({
                title: 'Duplicate field names',
                message: `The following field names are used more than once: ${nameTracker.dupes.join(', ')}`
            });
        }
        for (const w of _currentWarnings) {
            errors.push({ title: 'Warning', message: w, isWarning: true });
        }
    } catch (err) {
        errors.push({ title: 'Render error', message: err.message });
        rendered = preview.lastRenderedHtml || '';
    } finally {
        _currentWarnings = null;
    }

    updatePreviewPanel(panel, preview, buildHtmlPreviewChrome(rendered) + buildErrorPaneHtml(errors), rendered, htmlPreviewStyles);
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

function buildErrorPaneHtml(errors) {
    if (errors.length === 0) return '';
    const warnings = errors.filter(e => e.isWarning);
    const nonWarnings = errors.filter(e => !e.isWarning);

    const errorBlocks = nonWarnings.map(e =>
        `<div class="error-block"><span class="error-block-title">&#9888; ${escapeHtml(e.title)}</span><pre>${escapeHtml(e.message)}</pre></div>`
    );

    if (warnings.length > 0) {
        const items = warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('');
        errorBlocks.push(`<div class="warning-block"><span class="warning-block-title">&#9432; Warning</span><ul class="warning-list">${items}</ul></div>`);
    }

    return `
<div id="error-pane">
  ${errorBlocks.join('')}
</div>`;
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
  body:has(#error-pane) { padding-bottom: 160px; }
  h1, h2, h3, h4, h5, h6 { color: black; }
  #error-pane { position: fixed; bottom: 0; left: 0; right: 0; background: #1e1a10; border-top: 2px solid #f14c4c; padding: 6px 12px; max-height: 150px; overflow-y: auto; z-index: 9999; }
  .error-block, .warning-block { margin-bottom: 6px; }
  .error-block:last-child, .warning-block:last-child { margin-bottom: 0; }
  .error-block-title { display: block; font-family: sans-serif; font-weight: bold; font-size: 12px; color: #f14c4c; margin-bottom: 2px; }
  .warning-block-title { display: block; font-family: sans-serif; font-weight: bold; font-size: 12px; color: #cca700; margin-bottom: 2px; }
  #error-pane pre { margin: 0; font-family: monospace; font-size: 11px; color: #d4d4d4; white-space: pre-wrap; word-break: break-word; }
  .warning-list { margin: 2px 0 0 0; padding-left: 16px; }
  .warning-list li { font-family: monospace; font-size: 11px; color: #d4d4d4; }${extraStyles}
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
        for (const input of document.querySelectorAll('.lp-toggle input[id]')) {
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