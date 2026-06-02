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
                { enableScripts: false, localResourceRoots: workspaceFolders }
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
                { enableScripts: false, localResourceRoots: workspaceFolders }
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
        } else if (inHtmlTag && inQuote === null && ch === '{' && (text[i + 1] === '%' || text[i + 1] === '{')) {
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

function stripLiquid(text) {
    let optionCount = 0;

    // Step 1: remove liquid embedded within HTML element tags (attribute-level logic).
    // These modify HTML structure rather than producing standalone output.
    text = stripLiquidFromHtmlTags(text);

    // Step 2: remove non-output block tags that never produce HTML content directly.
    // capture/endcapture – captures rendered output into a variable
    text = text.replace(/\{%-?\s*capture\b.*?-?%\}[\s\S]*?\{%-?\s*endcapture\s*-?%\}/g, '');
    // assign, increment, decrement – variable manipulation, no output
    // render, include – render a sub-template; its output isn't meaningful here
    text = text.replace(/\{%-?\s*(assign|increment|decrement|render|include)\b.*?-?%\}/g, '');

    // comment / endcomment → muted comment box (processed first so its body is not
    // mistaken for other liquid constructs)
    text = text.replace(/\{%-?\s*comment\s*-?%\}([\s\S]*?)\{%-?\s*endcomment\s*-?%\}/g, (_, body) =>
        `<div class="lp-comment"><span class="lp-label">Comment</span>${escapeHtml(body.trim())}</div>`);

    // choice / or / endchoice → numbered option boxes
    // 'choice' can have arguments; 'or' and 'endchoice' do not
    text = text.replace(/\{%-?\s*choice\b.*?-?%\}/g, () => {
        optionCount = 1;
        return '<div class="lp-choice-block"><div class="lp-option"><span class="lp-label">Option 1</span>';
    });
    text = text.replace(/\{%-?\s*or\s*-?%\}/g, () => {
        optionCount++;
        return `</div><div class="lp-option"><span class="lp-label">Option ${optionCount}</span>`;
    });
    text = text.replace(/\{%-?\s*endchoice\s*-?%\}/g, '</div></div>');

    // optional / endoptional → styled optional box
    text = text.replace(/\{%-?\s*optional\b.*?-?%\}/g,
        '<div class="lp-optional"><span class="lp-label">Optional</span>');
    text = text.replace(/\{%-?\s*endoptional\s*-?%\}/g, '</div>');

    // editor / endeditor → styled editor box
    text = text.replace(/\{%-?\s*editor\b.*?-?%\}/g,
        '<div class="lp-editor"><span class="lp-label">Editable</span>');
    text = text.replace(/\{%-?\s*endeditor\s*-?%\}/g, '</div>');

    // if / elsif / else / endif → styled branch boxes
    text = text.replace(/\{%-?\s*if\s+(.*?)-?%\}/g, (_, cond) =>
        `<div class="lp-if-block"><div class="lp-branch"><span class="lp-label">If: ${escapeHtml(cond.trim())}</span>`);
    text = text.replace(/\{%-?\s*elsif\s+(.*?)-?%\}/g, (_, cond) =>
        `</div><div class="lp-branch"><span class="lp-label">Else if: ${escapeHtml(cond.trim())}</span>`);
    text = text.replace(/\{%-?\s*else\s*-?%\}/g,
        '</div><div class="lp-branch"><span class="lp-label">Else</span>');
    text = text.replace(/\{%-?\s*endif\s*-?%\}/g, '</div></div>');

    // unless / endunless → styled branch box
    text = text.replace(/\{%-?\s*unless\s+(.*?)-?%\}/g, (_, cond) =>
        `<div class="lp-if-block"><div class="lp-branch"><span class="lp-label">Unless: ${escapeHtml(cond.trim())}</span>`);
    text = text.replace(/\{%-?\s*endunless\s*-?%\}/g, '</div></div>');

    // for / endfor → styled loop box
    text = text.replace(/\{%-?\s*for\s+(.*?)-?%\}/g, (_, expr) =>
        `<div class="lp-loop"><span class="lp-label">For: ${escapeHtml(expr.trim())}</span>`);
    text = text.replace(/\{%-?\s*endfor\s*-?%\}/g, '</div>');

    // Strip all remaining liquid tags and output expressions
    text = text.replace(/\{%-?[\s\S]*?-?%\}/g, '');
    text = text.replace(/\{\{-?[\s\S]*?-?\}\}/g, '');

    return text;
}

const htmlPreviewStyles = `
  .editor { border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .editor:has(input[type="checkbox"]) { border: 2px dashed #388e3c; background: #f1f8e9; }
  .editor:has(input[type="radio"]) { border: 2px solid #1976d2; background: #e3f2fd; }
  .editor:has(input[type="text"]), .editor:has(textarea) { border: 2px solid #f57c00; background: #fff8e1; }
  .editor:has(input[type="radio"]) label { display: block; padding: 6px 10px; margin: 4px 0; border: 1px solid #90caf9; border-radius: 3px; background: white; }
  .editor-intro { display: block; font-size: 11px; font-weight: bold; font-family: sans-serif; margin-bottom: 4px; }
  .editor input[type="checkbox"]:not(:checked) ~ .optional-content { display: none; }
  .editor input[type="radio"]:not(:checked) ~ .choice-content { display: none; }`;

const fullPreviewStyles = `
  .lp-choice-block { border: 2px solid #1976d2; border-radius: 4px; margin: 8px 0; overflow: hidden; }
  .lp-option { border-left: 4px solid #1976d2; background: #e3f2fd; padding: 6px 10px; }
  .lp-option + .lp-option { border-top: 1px dashed #90caf9; }
  .lp-optional { border: 2px dashed #388e3c; border-radius: 4px; padding: 6px 10px; margin: 8px 0; background: #f1f8e9; }
  .lp-editor { border: 2px solid #f57c00; border-radius: 4px; padding: 6px 10px; margin: 8px 0; background: #fff8e1; }
  .lp-if-block { border: 2px solid #7b1fa2; border-radius: 4px; margin: 8px 0; overflow: hidden; }
  .lp-branch { border-left: 4px solid #7b1fa2; background: #f3e5f5; padding: 6px 10px; }
  .lp-branch + .lp-branch { border-top: 1px dashed #ce93d8; }
  .lp-loop { border: 2px solid #00796b; border-radius: 4px; padding: 6px 10px; margin: 8px 0; background: #e0f2f1; }
  .lp-label { display: inline-block; font-size: 10px; font-weight: bold; font-family: sans-serif; color: white; padding: 1px 6px; border-radius: 3px; margin-right: 6px; vertical-align: middle; }
  .lp-choice-block .lp-label { background: #1976d2; }
  .lp-optional .lp-label { background: #388e3c; }
  .lp-editor .lp-label { background: #f57c00; }
  .lp-if-block .lp-label { background: #7b1fa2; }
  .lp-loop .lp-label { background: #00796b; }
  .lp-comment { border: 1px dashed #9e9e9e; border-radius: 4px; padding: 4px 10px; margin: 4px 0; background: #f5f5f5; color: #616161; font-style: italic; }
  .lp-comment .lp-label { background: #9e9e9e; font-style: normal; }`;

async function refreshHtmlFullPanel(preview, panel) {
    let errors = [];
    let content = '';

    try {
        let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
        content = stripLiquid(templateDocument.getText());
        preview.lastRenderedHtml = content;
    } catch (err) {
        errors.push({ title: 'Template error', message: err.message });
        content = preview.lastRenderedHtml || '';
    }

    let cssLinks = buildCssLinks(preview.templateUri, panel.webview);
    panel.webview.html = buildPreviewHtml(cssLinks, content, errors, fullPreviewStyles);
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

    let cssLinks = buildCssLinks(preview.templateUri, panel.webview);
    panel.webview.html = buildPreviewHtml(cssLinks, rendered, errors, htmlPreviewStyles);
}

function buildCssLinks(templateUri, webview) {
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

    return cssPaths
        .map(p => {
            let uri = webview.asWebviewUri(vscode.Uri.file(p));
            return `<link rel="stylesheet" href="${uri}">`;
        })
        .join('\n');
}

function buildPreviewHtml(cssLinks, rendered, errors, extraStyles = '') {
    const haserrors = errors.length > 0;
    const warnings = errors.filter(e => e.isWarning);
    const nonWarnings = errors.filter(e => !e.isWarning);

    const errorBlocks = nonWarnings.map(e =>
        `<div class="error-block"><span class="error-block-title">&#9888; ${escapeHtml(e.title)}</span><pre>${escapeHtml(e.message)}</pre></div>`
    );

    if (warnings.length > 0) {
        const items = warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('');
        errorBlocks.push(`<div class="warning-block"><span class="warning-block-title">&#9432; Warning</span><ul class="warning-list">${items}</ul></div>`);
    }

    const errorPaneHtml = haserrors ? `
<div id="error-pane">
  ${errorBlocks.join('')}
</div>` : '';

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { background-color: white; color: black; margin: 0; padding: 8px; ${haserrors ? 'padding-bottom: 160px;' : ''} box-sizing: border-box; }
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
${rendered}
${errorPaneHtml}
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