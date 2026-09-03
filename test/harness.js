// Loads extension.js against the stubbed vscode module and offers the pieces
// tests need to drive a preview: a fake webview panel that records what is
// pushed into it, and a preview object shaped like the one createNewPreview
// builds.
//
// Requiring this module installs the stub first, so extension.js sees it.

const stub = require('./vscode-stub');
stub.install();

const extension = require('../extension');

// One diagnostic collection is created per activate() call, and extension.js
// keeps a module-level map of each preview's diagnostics. Activating once here
// means every test file shares a live extension; node --test runs each file in
// its own process, so the sharing never crosses a file boundary.
extension.activate({ subscriptions: [] });

// Previews handed out since the last reset. The extension holds a diagnostic
// entry per preview until the preview's panel is disposed, so tests have to be
// closed out the same way or one test's problems show up in the next.
const openPreviews = [];
let nextPreviewId = 1;

// A preview as the commands build it. `template` starts empty and dirty, so the
// first refresh parses the file the test has written to the stub workspace.
function makePreview({ templateUri, dataUri = null } = {}) {
    const preview = {
        id: nextPreviewId++,
        uri: () => stub.vscode.Uri.parse('reporter-liquid-preview:test'),
        templateUri,
        templateDirty: true,
        template: [],
        dataUri,
        dataDirty: Boolean(dataUri),
        data: {},
        lastRenderedHtml: ''
    };
    openPreviews.push(preview);
    return preview;
}

// A stand-in for a WebviewPanel. The first refresh sets webview.html to the
// whole document; later ones post an 'update' message carrying the two halves.
// Both are recorded, and chrome() always returns the newest of either.
//
// The panel is wired for messages exactly as the preview commands wire it, so
// send() exercises the real click-to-open path.
function makePanel() {
    const panel = {
        _rlpInitialized: false,
        documents: [],
        messages: [],
        received: [],
        webview: {
            set html(value) { panel.documents.push(value); },
            get html() { return panel.documents[panel.documents.length - 1]; },
            postMessage: message => { panel.messages.push(message); return Promise.resolve(true); },
            onDidReceiveMessage: listener => {
                panel.received.push(listener);
                return { dispose() { } };
            },
            asWebviewUri: uri => uri
        },
        // The most recent chrome half: the extension's own UI, problems pane
        // included. Falls back to the full document on the very first refresh.
        chrome() {
            const last = panel.messages[panel.messages.length - 1];
            return last ? last.chrome : chromeOf(panel.webview.html);
        },
        // Pretend a reader clicked something in the webview.
        send(message) {
            for (const listener of panel.received) listener(message);
        }
    };
    extension.wirePreviewMessages(panel);
    return panel;
}

// The #lp-chrome half of a full preview document.
function chromeOf(document) {
    const text = String(document);
    const start = text.indexOf('<div id="lp-chrome">');
    const end = text.indexOf('<div id="lp-rendered-root">');
    return start === -1 || end === -1 ? text : text.slice(start, end);
}

// Just the problems pane out of a chrome string, or '' when there isn't one.
function paneOf(chrome) {
    const start = String(chrome).indexOf('<div id="error-pane">');
    return start === -1 ? '' : String(chrome).slice(start);
}

// Drive one HTML preview refresh over the given files and hand back the pane.
async function renderPreview({ template, data, templateUri = '/w/report.liquid', dataUri = '/w/data.json' }) {
    stub.workspaceFiles.set(templateUri, template);
    if (data !== undefined) stub.workspaceFiles.set(dataUri, data);

    const preview = makePreview({ templateUri, dataUri: data === undefined ? null : dataUri });
    const panel = makePanel();
    await extension.refreshHtmlPanel(preview, panel);
    return { preview, panel, pane: paneOf(panel.chrome()) };
}

// Close every preview and forget everything the stub recorded. Call between
// tests; closing the previews is what a disposed panel does in the real thing.
function reset() {
    for (const preview of openPreviews.splice(0)) extension.clearPreviewDiagnostics(preview);
    stub.reset();
}

// Let a posted message be handled: the reveal path is async.
function settle() {
    return new Promise(resolve => setImmediate(resolve));
}

// Every data-diag-* position in a pane, in the order they are rendered.
function positionsIn(pane) {
    const positions = [];
    const pattern = /data-diag-file="([^"]*)" data-diag-line="(\d+)" data-diag-col="(\d+)"/g;
    let match;
    while ((match = pattern.exec(pane)) !== null) {
        positions.push({ file: match[1], line: Number(match[2]), col: Number(match[3]) });
    }
    return positions;
}

// The message of each row in a pane, in the order they are rendered.
function messagesIn(pane) {
    const messages = [];
    const pattern = /<pre class="diag-message">([\s\S]*?)<\/pre>/g;
    let match;
    while ((match = pattern.exec(pane)) !== null) messages.push(match[1]);
    return messages;
}

module.exports = {
    extension,
    stub,
    makePreview,
    makePanel,
    chromeOf,
    paneOf,
    renderPreview,
    harnessReset: reset,
    settle,
    positionsIn,
    messagesIn
};
