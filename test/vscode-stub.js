// A stand-in for the `vscode` module, which only exists inside the extension
// host and so cannot be required from a plain `node --test` run.
//
// Only the surface extension.js actually touches is modelled, and everything it
// writes to — the files it opens, the diagnostics it publishes, the editors it
// reveals — is recorded here for tests to assert against. install() has to run
// before extension.js is first required, which harness.js takes care of.

const Module = require('module');

// ---- recorded state -------------------------------------------------------

// Contents of the "workspace", keyed by path. Tests write to it directly.
const workspaceFiles = new Map();
// The Problems panel: file path -> Diagnostic[], as last published.
const publishedDiagnostics = new Map();
// Every revealInEditor call, in order: { file, line, character, viewColumn }.
const revealed = [];
// Every window.showErrorMessage call, in order.
const shownErrors = [];
// Every showInformationMessage / showWarningMessage call, in order.
const shownMessages = [];
// Answers for the next showWarningMessage calls (a modal's chosen button).
const warningAnswers = [];
// Answers for the next showInformationMessage / showErrorMessage calls.
const infoAnswers = [];
const errorAnswers = [];
// Every commands.executeCommand call, and every env.openExternal link.
const executedCommands = [];
const openedLinks = [];
// Every window.setStatusBarMessage text, in order.
const statusMessages = [];
// Settings, by full key ("section.name").
const settings = new Map();
// Every test controller the extension created, with what its runs reported.
const testControllers = [];
// Answers for the next showQuickPick / showInputBox calls, in order. A quick
// pick answer may be a function of the items offered.
const quickPickAnswers = [];
const inputBoxAnswers = [];
// Every webview panel the extension opened itself (the report panel).
const createdPanels = [];

// ---- API types ------------------------------------------------------------

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
    translate(lines, characters) {
        return new Position(this.line + lines, this.character + characters);
    }
    isEqual(other) {
        return other.line === this.line && other.character === this.character;
    }
}

class Range {
    constructor(a, b, c, d) {
        if (typeof a === 'number') {
            this.start = new Position(a, b);
            this.end = new Position(c, d);
        } else {
            this.start = a;
            this.end = b;
        }
    }
    // Compact form for assertions: "line:char-line:char", 0-based as VS Code is.
    toString() {
        return `${this.start.line}:${this.start.character}-${this.end.line}:${this.end.character}`;
    }
}

class Selection extends Range { }

class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
    }
}

class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = listener => {
            this.listeners.push(listener);
            return { dispose: () => { } };
        };
    }
    fire(value) {
        for (const listener of this.listeners) listener(value);
    }
    dispose() { }
}

class Disposable {
    dispose() { }
}

class Location {
    constructor(uri, rangeOrPosition) {
        this.uri = uri;
        this.range = rangeOrPosition;
    }
}

// ---- the Testing API (VS Code 1.59+) ---------------------------------------

class TestMessage {
    constructor(message) {
        this.message = message;
    }
    static diff(message, expected, actual) {
        const result = new TestMessage(message);
        result.expectedOutput = expected;
        result.actualOutput = actual;
        return result;
    }
}

// A TestItemCollection: insertion-ordered, keyed by id.
function itemCollection(parent) {
    const items = new Map();
    return {
        get size() { return items.size; },
        get: id => items.get(id),
        add: item => { item.parent = parent; items.set(item.id, item); },
        delete: id => items.delete(id),
        replace: list => { items.clear(); for (const item of list) { item.parent = parent; items.set(item.id, item); } },
        forEach: fn => { for (const item of Array.from(items.values())) fn(item); }
    };
}

function createTestController(id, label) {
    const controller = {
        id,
        label,
        profiles: [],
        // Every createTestRun, each with the calls made on it: { state, id, messages }.
        runs: [],
        items: itemCollection(undefined),
        createTestItem(itemId, itemLabel, uri) {
            const item = { id: itemId, label: itemLabel, uri, range: undefined, error: undefined, parent: undefined };
            item.children = itemCollection(item);
            return item;
        },
        createRunProfile(profileLabel, kind, runHandler, isDefault) {
            const profile = { label: profileLabel, kind, runHandler, isDefault, dispose() { } };
            controller.profiles.push(profile);
            return profile;
        },
        createTestRun(request) {
            const calls = [];
            const record = state => (item, messages, duration) => calls.push({
                state, id: item.id, messages: messages === undefined ? [] : [].concat(messages), duration
            });
            const run = {
                request,
                calls,
                ended: false,
                enqueued: record('enqueued'),
                started: record('started'),
                passed: (item, duration) => calls.push({ state: 'passed', id: item.id, messages: [], duration }),
                failed: record('failed'),
                errored: record('errored'),
                skipped: record('skipped'),
                appendOutput() { },
                end() { run.ended = true; }
            };
            controller.runs.push(run);
            return run;
        },
        dispose() { }
    };
    testControllers.push(controller);
    return controller;
}

// Providers the extension registers, by kind, for tests to call directly.
const providers = { formatting: [], completion: [] };

class SnippetString { constructor(value) { this.value = value; } }
class MarkdownString { constructor(value) { this.value = value; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
const TextEdit = { replace: (range, newText) => ({ range, newText }) };
const CompletionItemKind = { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18 };

// ---- the module itself ----------------------------------------------------

const vscode = {
    Position,
    Range,
    Selection,
    Diagnostic,
    EventEmitter,
    Disposable,
    Location,
    TestMessage,
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    DiagnosticSeverity: { Error: 'Error', Warning: 'Warning', Information: 'Information', Hint: 'Hint' },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },

    Uri: {
        file: fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => 'file://' + fsPath }),
        parse: value => ({ scheme: value.split(':')[0], fsPath: value, path: value, toString: () => value })
    },

    SnippetString,
    MarkdownString,
    CompletionItem,
    CompletionItemKind,
    TextEdit,

    languages: {
        registerDocumentFormattingEditProvider: (selector, provider) => { providers.formatting.push(provider); return new Disposable(); },
        registerCompletionItemProvider: (selector, provider) => { providers.completion.push(provider); return new Disposable(); },
        createDiagnosticCollection: () => ({
            name: 'stub',
            clear: () => publishedDiagnostics.clear(),
            set: (uri, items) => publishedDiagnostics.set(uri.fsPath, items),
            delete: uri => publishedDiagnostics.delete(uri.fsPath),
            dispose: () => publishedDiagnostics.clear()
        })
    },

    window: {
        // Tests push fake editors here to exercise the "file is already open"
        // path in revealInEditor.
        visibleTextEditors: [],
        activeTextEditor: undefined,
        createStatusBarItem: () => ({ text: '', tooltip: '', show() { }, hide() { }, dispose() { } }),
        // Preview tests build their panels themselves (harness.makePanel); this
        // serves the panels the extension opens on its own, like the report.
        createWebviewPanel: (viewType, title) => {
            const panel = {
                viewType,
                title,
                disposed: false,
                webview: { html: '', onDidReceiveMessage: () => new Disposable(), postMessage: () => Promise.resolve(true) },
                reveal() { },
                onDidDispose: listener => { panel._onDispose = listener; return new Disposable(); },
                dispose() { panel.disposed = true; if (panel._onDispose) panel._onDispose(); }
            };
            createdPanels.push(panel);
            return panel;
        },
        setStatusBarMessage: message => { statusMessages.push(message); return new Disposable(); },
        showErrorMessage: message => { shownErrors.push(message); return Promise.resolve(errorAnswers.shift()); },
        showInformationMessage: message => { shownMessages.push(message); return Promise.resolve(infoAnswers.shift()); },
        showWarningMessage: message => { shownMessages.push(message); return Promise.resolve(warningAnswers.shift()); },
        withProgress: (options, task) => task({ report() { } }, { isCancellationRequested: false }),
        showQuickPick: async (items, options) => {
            const answer = quickPickAnswers.shift();
            return typeof answer === 'function' ? answer(await items, options) : answer;
        },
        showInputBox: async () => inputBoxAnswers.shift(),
        showTextDocument: async (document, options) => {
            const editor = {
                document,
                viewColumn: options && options.viewColumn,
                selection: null,
                revealRange(range) {
                    revealed.push({
                        file: document.uri.fsPath,
                        line: range.start.line,
                        character: range.start.character,
                        viewColumn: editor.viewColumn
                    });
                }
            };
            return editor;
        }
    },

    workspace: {
        workspaceFolders: [],
        // Open documents; tests push { fileName, isDirty, save() } to model
        // unsaved edits.
        textDocuments: [],
        getConfiguration: section => ({
            get: (name, fallback) => (settings.has(`${section}.${name}`) ? settings.get(`${section}.${name}`) : fallback)
        }),
        // workspaceFiles stands in for open editors and wins; anything else is
        // read from disk, as VS Code would, so files the extension writes with
        // fs can be read back.
        openTextDocument: async target => {
            const fsPath = typeof target === 'string' ? target : target.fsPath;
            let text = workspaceFiles.get(fsPath);
            if (text === undefined) {
                try {
                    text = require('fs').readFileSync(fsPath, 'utf8');
                } catch (err) {
                    throw new Error(`cannot open ${fsPath}: no such file`);
                }
            }
            return {
                fileName: fsPath,
                uri: vscode.Uri.file(fsPath),
                getText: () => text
            };
        },
        // Every workspace file whose name matches the pattern's final segment —
        // enough for the extension's '**/*.ext' globs.
        findFiles: async pattern => {
            const suffix = String(pattern).replace(/^.*\*/, '');
            return Array.from(workspaceFiles.keys())
                .filter(fsPath => fsPath.endsWith(suffix))
                .map(fsPath => vscode.Uri.file(fsPath));
        },
        asRelativePath: fsPath => String(fsPath).replace(/^\/w\//, ''),
        createFileSystemWatcher: () => ({
            onDidCreate: () => new Disposable(),
            onDidChange: () => new Disposable(),
            onDidDelete: () => new Disposable(),
            dispose() { }
        }),
        registerTextDocumentContentProvider: () => new Disposable(),
        onDidChangeTextDocument: () => new Disposable()
    },

    commands: {
        registerCommand: () => new Disposable(),
        executeCommand: async (command, ...args) => { executedCommands.push({ command, args }); }
    },

    env: {
        openExternal: async uri => { openedLinks.push(String(uri)); return true; }
    },

    ExtensionMode: { Production: 1, Development: 2, Test: 3 },

    tests: {
        createTestController
    }
};

// ---- installation ---------------------------------------------------------

let installed = false;

// Make require('vscode') resolve to the stub. Safe to call more than once.
function install() {
    if (installed) return vscode;
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return load.apply(this, arguments);
    };
    installed = true;
    return vscode;
}

// Forget everything recorded so far. Call between tests.
function reset() {
    workspaceFiles.clear();
    publishedDiagnostics.clear();
    revealed.length = 0;
    shownErrors.length = 0;
    shownMessages.length = 0;
    warningAnswers.length = 0;
    quickPickAnswers.length = 0;
    infoAnswers.length = 0;
    errorAnswers.length = 0;
    executedCommands.length = 0;
    statusMessages.length = 0;
    openedLinks.length = 0;
    settings.clear();
    inputBoxAnswers.length = 0;
    for (const panel of createdPanels.splice(0)) if (!panel.disposed) panel.dispose();
    vscode.workspace.textDocuments = [];
    for (const controller of testControllers) controller.runs.length = 0;
    vscode.window.visibleTextEditors = [];
}

module.exports = {
    vscode,
    providers,
    statusMessages,
    install,
    reset,
    workspaceFiles,
    publishedDiagnostics,
    revealed,
    shownErrors,
    shownMessages,
    warningAnswers,
    quickPickAnswers,
    infoAnswers,
    errorAnswers,
    executedCommands,
    openedLinks,
    settings,
    inputBoxAnswers,
    createdPanels,
    testControllers
};
