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

// ---- the module itself ----------------------------------------------------

const vscode = {
    Position,
    Range,
    Selection,
    Diagnostic,
    EventEmitter,
    Disposable,
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
        createWebviewPanel: () => { throw new Error('createWebviewPanel: tests build panels themselves'); },
        showErrorMessage: message => { shownErrors.push(message); return Promise.resolve(undefined); },
        showQuickPick: async () => undefined,
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
        openTextDocument: async target => {
            const fsPath = typeof target === 'string' ? target : target.fsPath;
            if (!workspaceFiles.has(fsPath)) throw new Error(`cannot open ${fsPath}: no such file`);
            return {
                fileName: fsPath,
                uri: vscode.Uri.file(fsPath),
                getText: () => workspaceFiles.get(fsPath)
            };
        },
        findFiles: async () => [],
        registerTextDocumentContentProvider: () => new Disposable(),
        onDidChangeTextDocument: () => new Disposable()
    },

    commands: {
        registerCommand: () => new Disposable()
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
    vscode.window.visibleTextEditors = [];
}

module.exports = {
    vscode,
    install,
    reset,
    workspaceFiles,
    publishedDiagnostics,
    revealed,
    shownErrors
};
