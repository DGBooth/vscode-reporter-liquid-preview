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

    languages: {
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
        showErrorMessage: message => { shownErrors.push(message); return Promise.resolve(undefined); },
        showInformationMessage: message => { shownMessages.push(message); return Promise.resolve(undefined); },
        showWarningMessage: message => { shownMessages.push(message); return Promise.resolve(warningAnswers.shift()); },
        withProgress: (options, task) => task({ report() { } }, { isCancellationRequested: false }),
        showQuickPick: async items => {
            const answer = quickPickAnswers.shift();
            return typeof answer === 'function' ? answer(await items) : answer;
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
        registerCommand: () => new Disposable()
    },

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
    inputBoxAnswers.length = 0;
    for (const panel of createdPanels.splice(0)) if (!panel.disposed) panel.dispose();
    vscode.workspace.textDocuments = [];
    for (const controller of testControllers) controller.runs.length = 0;
    vscode.window.visibleTextEditors = [];
}

module.exports = {
    vscode,
    install,
    reset,
    workspaceFiles,
    publishedDiagnostics,
    revealed,
    shownErrors,
    shownMessages,
    warningAnswers,
    quickPickAnswers,
    inputBoxAnswers,
    createdPanels,
    testControllers
};
