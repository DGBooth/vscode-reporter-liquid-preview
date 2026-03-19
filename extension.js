const path = require('path');
const vscode = require('vscode');
const liquid = require('liquidjs');
const liquidEngine = new liquid();

// register custom Liquid tags used in templates
registerCustomTags(liquidEngine);

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

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('shopify-liquid-preview', previewContentProvider));

    context.subscriptions.push(vscode.commands.registerCommand('shopifyLiquidPreview.preview', async () => {
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

    context.subscriptions.push(vscode.commands.registerCommand('shopifyLiquidPreview.htmlPreview', async () => {
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
    }));

    templateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    templateStatusBarItem.show();
    context.subscriptions.push(templateStatusBarItem);

    dataStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    dataStatusBarItem.show();
    context.subscriptions.push(dataStatusBarItem);
}

async function refreshHtmlPanel(preview, panel) {
    if (preview.templateUri && preview.templateDirty) {
        try {
            let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
            preview.template = liquidEngine.parse(templateDocument.getText());
            preview.templateDirty = false;
        } catch (err) {
            panel.webview.html = buildErrorHtml('Template error', err.message);
            return;
        }
    }

    if (preview.dataUri && preview.dataDirty) {
        try {
            let dataDocument = await vscode.workspace.openTextDocument(preview.dataUri);
            preview.data = JSON.parse(dataDocument.getText());
            preview.dataDirty = false;
        } catch (err) {
            panel.webview.html = buildErrorHtml('Data error', err.message);
            return;
        }
    }

    try {
        let rendered = await liquidEngine.render(preview.template, preview.data);
        let cssLinks = buildCssLinks(preview.templateUri, panel.webview);
        panel.webview.html = cssLinks + rendered;
    } catch (err) {
        panel.webview.html = buildErrorHtml('Render error', err.message);
    }
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

function buildErrorHtml(title, message) {
    return `<!DOCTYPE html><html><body><h3 style="color:red">${title}</h3><pre>${message}</pre></body></html>`;
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

            return vscode.Uri.parse('shopify-liquid-preview:' + previewFile);
        },
        templateUri: document.fileName,
        templateDirty: true,
        template: [],
        dataUri: null,
        dataDirty: false,
        data: {}
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