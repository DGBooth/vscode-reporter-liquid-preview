const path = require('path');
const vscode = require('vscode');
const liquid = require('liquidjs');
const liquidEngine = new liquid();

// register custom Liquid tags used in templates
registerCustomTags(liquidEngine);

function registerCustomFilters(engine) {
    // money filter: rounds to 2 decimal places or appends .00 if no decimals
    engine.registerFilter('money', value => {
        const num = parseFloat(value);
        if (isNaN(num)) return value;
        return num.toFixed(2);
    });
}

// register custom Liquid filters used in templates
registerCustomFilters(liquidEngine);

function registerCustomTags(engine) {
    // optional tag simply renders its inner content
    engine.registerTag('optional', {
        parse(tagToken, remainTokens) {
            this.templates = [];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:endoptional', () => stream.stop())
                .on('template', tpl => this.templates.push(tpl))
                .on('end', () => { throw new Error('optional tag not closed'); });
            stream.start();
        },
        render(ctx) {
            return this.liquid.renderer.renderTemplates(this.templates, ctx);
        }
    });

    // editor tag renders the default text between editor/endeditor
    engine.registerTag('editor', {
        parse(tagToken, remainTokens) {
            this.templates = [];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:endeditor', () => stream.stop())
                .on('template', tpl => this.templates.push(tpl))
                .on('end', () => { throw new Error('editor tag not closed'); });
            stream.start();
        },
        render(ctx) {
            return this.liquid.renderer.renderTemplates(this.templates, ctx);
        }
    });

    // choice tag supports multiple blocks separated by 'or'.
    // The preview simply renders the first block.
    engine.registerTag('choice', {
        parse(tagToken, remainTokens) {
            this.parts = [[]];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:or', () => this.parts.push([]))
                .on('tag:endchoice', () => stream.stop())
                .on('template', tpl => this.parts[this.parts.length - 1].push(tpl))
                .on('end', () => { throw new Error('choice tag not closed'); });
            stream.start();
            this.templates = this.parts[0];
        },
        render(ctx) {
            return this.liquid.renderer.renderTemplates(this.templates, ctx);
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

function stripLiquid(text) {
    let optionCount = 0;

    // choice / or / endchoice → numbered option boxes
    text = text.replace(/\{%-?\s*(choice|or|endchoice)\s*-?%\}/g, (_, tag) => {
        if (tag === 'choice') {
            optionCount = 1;
            return '<div class="lp-choice-block"><div class="lp-option"><span class="lp-label">Option 1</span>';
        } else if (tag === 'or') {
            optionCount++;
            return `</div><div class="lp-option"><span class="lp-label">Option ${optionCount}</span>`;
        } else {
            return '</div></div>';
        }
    });

    // optional / endoptional → styled optional box
    text = text.replace(/\{%-?\s*optional\s*-?%\}/g,
        '<div class="lp-optional"><span class="lp-label">Optional</span>');
    text = text.replace(/\{%-?\s*endoptional\s*-?%\}/g, '</div>');

    // editor / endeditor → styled editor box
    text = text.replace(/\{%-?\s*editor\s*-?%\}/g,
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

    // comment / endcomment → muted comment box (content preserved but visually distinct)
    text = text.replace(/\{%-?\s*comment\s*-?%\}([\s\S]*?)\{%-?\s*endcomment\s*-?%\}/g, (_, body) =>
        `<div class="lp-comment"><span class="lp-label">Comment</span>${escapeHtml(body.trim())}</div>`);

    // Strip all remaining liquid tags and output expressions
    text = text.replace(/\{%-?[\s\S]*?-?%\}/g, '');
    text = text.replace(/\{\{-?[\s\S]*?-?\}\}/g, '');

    return text;
}

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
        rendered = await liquidEngine.render(preview.template, preview.data);
        preview.lastRenderedHtml = rendered;
    } catch (err) {
        errors.push({ title: 'Render error', message: err.message });
        rendered = preview.lastRenderedHtml || '';
    }

    let cssLinks = buildCssLinks(preview.templateUri, panel.webview);
    panel.webview.html = buildPreviewHtml(cssLinks, rendered, errors);
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
    const errorPaneHtml = haserrors ? `
<div id="error-pane">
  ${errors.map(e => `<div class="error-block"><span class="error-title">&#9888; ${escapeHtml(e.title)}</span><pre>${escapeHtml(e.message)}</pre></div>`).join('')}
</div>` : '';

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { background-color: white; color: black; margin: 0; padding: 8px; ${haserrors ? 'padding-bottom: 160px;' : ''} box-sizing: border-box; }
  h1, h2, h3, h4, h5, h6 { color: black; }
  #error-pane { position: fixed; bottom: 0; left: 0; right: 0; background: #2d1515; border-top: 2px solid #f14c4c; padding: 6px 12px; max-height: 150px; overflow-y: auto; z-index: 9999; }
  .error-block { margin-bottom: 6px; }
  .error-block:last-child { margin-bottom: 0; }
  .error-title { display: block; font-family: sans-serif; font-weight: bold; font-size: 12px; color: #f14c4c; margin-bottom: 2px; }
  #error-pane pre { margin: 0; font-family: monospace; font-size: 11px; color: #f48771; white-space: pre-wrap; word-break: break-word; }${extraStyles}
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