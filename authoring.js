// Writing templates in VS Code: Format Document, completions, and closing
// tags as you type. The logic is in formatter.js and editing.js, which don't
// depend on VS Code; this turns it into providers and edits.
//
// Both formatting and completions use the data a template is known to be
// used with: the data file of each HTML preview open on it, and the data of
// each test case that renders it.

const path = require('path');
const vscode = require('vscode');

const { formatTemplate } = require('./formatter');
const editing = require('./editing');

const SHOPIFY_LIQUID = 'Shopify.theme-check-vscode';

let deps = null;

// `deps`: { readText(file), suiteFiles(), parseSuite(text, file), render(text,
// data, file) → html|null, previews() → [{ templateUri, dataUri }] }.
function registerAuthoring(context, dependencies) {
    deps = dependencies;
    const selector = { language: 'liquid' };
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(selector, { provideDocumentFormattingEdits: formatDocument }),
        vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: completeAt }, '.', '|', '%', '<', '/', ' ', ',', '"', '='),
        vscode.workspace.onDidChangeTextDocument(event => { closeAsYouType(event).catch(() => { }); })
    );
    offerToSwitchFromShopify(context);
}

// ---- the data a template is used with -----------------------------------------------

// [{ label, data }] for `template`: each open preview's data file and each test
// case's data, once each.
async function datasetsFor(template) {
    const seen = new Set();
    const out = [];
    const addFile = async (file, label) => {
        if (!file || seen.has(file)) return;
        seen.add(file);
        try {
            out.push({ label, data: JSON.parse(await deps.readText(file)) });
        } catch (err) {
            // Unreadable or not JSON: the preview already says so.
        }
    };
    for (const p of deps.previews()) {
        if (samePath(p.templateUri, template)) await addFile(p.dataUri, path.basename(p.dataUri || ''));
    }
    for (const suiteFile of await deps.suiteFiles()) {
        let suite;
        try {
            suite = deps.parseSuite(await deps.readText(suiteFile), suiteFile);
        } catch (err) {
            continue;
        }
        for (const c of suite.cases || []) {
            if (!samePath(c.template, template)) continue;
            if (c.dataFile) await addFile(c.dataFile, path.basename(c.dataFile));
            else if (c.data) out.push({ label: `the test “${c.name}”`, data: c.data });
        }
    }
    return out;
}

function samePath(a, b) {
    return !!a && !!b && path.resolve(a) === path.resolve(b);
}

// ---- Format Document ----------------------------------------------------------------

async function formatDocument(document, options) {
    const text = document.getText();
    const file = document.fileName;
    const settings = vscode.workspace.getConfiguration('reporterLiquidPreview');
    // Checked against every data set it's used with, and none: a template
    // rendered with no data shows what's outside its conditions and loops.
    const datasets = (await datasetsFor(file)).concat([{ label: 'no data', data: {} }]);
    const result = await formatTemplate(text, {
        datasets,
        render: (t, data) => deps.render(t, data, file),
        options: {
            tabWidth: options && options.tabSize,
            useTabs: options && options.insertSpaces === false,
            printWidth: settings.get('format.printWidth', 120)
        }
    });
    if (result.error) {
        const detail = result.difference
            ? ` Before: “${result.difference.before.trim()}”. After: “${result.difference.after.trim()}”.`
            : '';
        vscode.window.showWarningMessage(`${result.error}${detail}`);
        return [];
    }
    if (result.text === text) return [];
    const checked = result.checked === 1 ? 'with no data only. Open a preview with a data file, or add tests, to check it against real data' : `against ${result.checked} sets of data`;
    const kept = result.keptSpacing ? ` ${result.keptSpacing} ${result.keptSpacing === 1 ? 'tag keeps' : 'tags keep'} the space before ${result.keptSpacing === 1 ? 'it' : 'them'}, which the page needs.` : '';
    if (vscode.window.setStatusBarMessage) vscode.window.setStatusBarMessage(`Formatted, and checked the page is unchanged ${checked}.${kept}`, 8000);
    const whole = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
    return [vscode.TextEdit.replace(whole, result.text)];
}

// ---- completions --------------------------------------------------------------------

const KINDS = { keyword: 'Keyword', reporter: 'Snippet', function: 'Function', property: 'Property', variable: 'Variable' };

async function completeAt(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    // Data is only read when the cursor is where a name could go.
    const at = editing.liquidBefore(text, offset);
    if (!at) return htmlCompletions(document, position);
    const needsData = !/\|\s*\w*$/.test(at.text) && !/^\{%-?\s*\w*$/.test(at.text);
    const datasets = needsData ? (await datasetsFor(document.fileName)).map(d => d.data) : [];
    const items = editing.completionsAt(text, offset, datasets) || [];
    return items.map((c, i) => {
        const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind[KINDS[c.kind]] || vscode.CompletionItemKind.Text);
        item.insertText = new vscode.SnippetString(c.insert);
        item.range = new vscode.Range(document.positionAt(c.replace[0]), document.positionAt(c.replace[1]));
        item.detail = c.detail;
        if (c.documentation) item.documentation = c.documentation;
        item.sortText = String(i).padStart(4, '0');
        return item;
    });
}

// ---- HTML -----------------------------------------------------------------------------

// VS Code's HTML language service, reading the template with its Liquid
// blanked out (see editing.blankLiquid): HTML tags, attributes and their
// values, and the closing tag for what's open.
let _html = null;
function htmlService() {
    if (!_html) {
        const { getLanguageService, TextDocument } = require('vscode-html-languageservice');
        _html = { service: getLanguageService(), TextDocument };
    }
    return _html;
}

function htmlDocumentFor(document) {
    const { service, TextDocument } = htmlService();
    const doc = TextDocument.create(document.uri.toString(), 'html', 1, editing.blankLiquid(document.getText()));
    return { service, doc, parsed: service.parseHTMLDocument(doc) };
}

function htmlCompletions(document, position) {
    const { service, doc, parsed } = htmlDocumentFor(document);
    const list = service.doComplete(doc, { line: position.line, character: position.character }, parsed);
    return list.items.map(c => {
        // The service speaks the language server protocol, whose kinds are
        // VS Code's plus one.
        const item = new vscode.CompletionItem(c.label, typeof c.kind === 'number' ? c.kind - 1 : undefined);
        const edit = c.textEdit;
        const newText = edit ? edit.newText : c.insertText || c.label;
        item.insertText = c.insertTextFormat === 2 ? new vscode.SnippetString(newText) : newText;
        if (edit && edit.range) item.range = toRange(edit.range);
        if (c.documentation) item.documentation = typeof c.documentation === 'string' ? c.documentation : new vscode.MarkdownString(c.documentation.value);
        if (c.filterText) item.filterText = c.filterText;
        if (c.sortText) item.sortText = c.sortText;
        if (c.command) item.command = c.command;
        return item;
    });
}

function toRange(r) {
    return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

// ---- as you type ----------------------------------------------------------------------

// After a single keystroke in the active template: the end tag after a block
// tag's `%}`, and an HTML element's closing tag after its `>` (or after `</`).
async function closeAsYouType(event) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document || event.document.languageId !== 'liquid') return;
    if (!vscode.workspace.getConfiguration('reporterLiquidPreview').get('autoClose', true)) return;
    // Not on undo or redo, which would otherwise put back what was undone.
    if (vscode.TextDocumentChangeReason && event.reason) return;
    if (event.contentChanges.length !== 1 || editor.selections.length !== 1) return;
    const change = event.contentChanges[0];
    const typed = change.text;
    if (typed.length !== 1) return;
    const cursor = change.range.start.translate(0, 1);
    if (!editor.selection.active.isEqual(cursor)) return;

    const line = event.document.lineAt(cursor.line).text;
    const edit = editing.afterTyping(line.slice(0, cursor.character), line.slice(cursor.character), typed, event.document.getText());
    if (edit) {
        const range = new vscode.Range(cursor.line, edit.start, cursor.line, edit.end);
        await editor.insertSnippet(new vscode.SnippetString(edit.snippet), range, { undoStopBefore: false, undoStopAfter: false });
        return;
    }
    if (typed === '>' || typed === '/') {
        const { service, doc, parsed } = htmlDocumentFor(event.document);
        const close = service.doTagComplete(doc, { line: cursor.line, character: cursor.character }, parsed);
        if (close) await editor.insertSnippet(new vscode.SnippetString(close), cursor, { undoStopBefore: false, undoStopAfter: false });
    }
}

// ---- Shopify Liquid -------------------------------------------------------------------

// Shopify Liquid also handles .liquid files: two extensions then compete to
// colour, complete and format them, and it reports Reporter's own tags as
// unknown. Offer, once, to show it so it can be disabled.
async function offerToSwitchFromShopify(context) {
    if (!vscode.extensions || !vscode.extensions.getExtension(SHOPIFY_LIQUID)) return;
    const state = context.globalState;
    if (!state || state.get('shopifyLiquidNoticeShown')) return;
    await state.update('shopifyLiquidNoticeShown', true);
    const choice = await vscode.window.showInformationMessage(
        'Shopify Liquid is also installed. It handles .liquid files too, so the two extensions compete to colour, complete and format templates, and it reports Reporter’s tags as unknown. Reporter Liquid Preview now does all of this itself. Disable Shopify Liquid?',
        'Show Shopify Liquid'
    );
    if (choice === 'Show Shopify Liquid') await vscode.commands.executeCommand('extension.open', SHOPIFY_LIQUID);
}

module.exports = { registerAuthoring, datasetsFor, formatDocument, completeAt, closeAsYouType, offerToSwitchFromShopify };
