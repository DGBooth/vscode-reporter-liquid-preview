# Tests

```
npm test
```

Runs every `test/*.test.js` with Node's built-in test runner — no dependencies
beyond the ones the extension already has. Individual files and filters work as
usual:

```
node --test test/render.test.js
node --test --test-name-pattern "duplicate" test/*.test.js
```

CI runs the suite on Node 20, 22 and 24 (see
[`.github/workflows/test.yml`](../.github/workflows/test.yml)).

**Node 20 or newer.** The suite reads the positions V8 puts in `JSON.parse`
error messages, and Node 18 leaves them out of some of them — the extension
handles that (the entry just has no position to offer), but one test asserts
that a broken data file *is* located, and it fails there. On Windows the floor
is Node 21, where Node gained glob expansion of its own; below that `cmd` leaves
the pattern alone and the run stops with `Could not find 'test/*.test.js'` rather
than quietly passing nothing.

The script names `test/*.test.js` rather than the directory on purpose: Node
treats every `.js` file inside a folder called `test` as a test file, which would
otherwise run the two support modules below as empty test files.

## How it works

`vscode` only exists inside the extension host, so it cannot be required from a
plain Node process. [`vscode-stub.js`](vscode-stub.js) stands in for it: it
models the surface `extension.js` actually touches and records everything the
extension writes out — the diagnostics it publishes, the editors it reveals, the
error messages it shows — for tests to assert against. `workspaceFiles` is the
fake workspace; tests write template and data files into it by path.

[`harness.js`](harness.js) installs the stub, loads the extension against it, and
builds the two things a test needs:

- `makePreview()` — a preview object shaped like the one `createNewPreview`
  builds, so `refreshHtmlPanel` and `refreshHtmlFullPanel` can be called
  directly.
- `makePanel()` — a stand-in for a `WebviewPanel` that records the document set
  on it and the update messages posted to it afterwards, and is wired for
  incoming messages exactly as the preview commands wire it. `panel.send(...)`
  therefore exercises the real click-to-open path.

`renderPreview({ template, data })` does all of that in one call and hands back
the problems pane.

Call `harnessReset()` in a `beforeEach`. The extension holds diagnostics per
preview until its panel is disposed, so the reset closes out every preview the
harness handed out — otherwise one test's problems appear in the next. Test
files are separate processes, so state never leaks across a file.

## What is covered

- **`render.test.js`** — the engine's template loop is wrapped so warnings can
  name the line they came from, which means reimplementing a LiquidJS internal.
  Every case is rendered by both the patched engine and a stock one carrying the
  same custom tags and filters, and has to come out byte for byte identical.
  `{% break %}` and `{% continue %}` are the ones the wrapper could plausibly
  get wrong.
- **`diagnostics.test.js`** — the position each problem lands on, for filter
  warnings, parse errors, duplicate field names and broken data files; the
  Problems-panel rows that mirror them; the cases where a position is withheld
  on purpose; and click-to-open.
- **`preview-html.test.js`** — the preview document is assembled as a string, so
  escaping, unbalanced markup and a broken inline script would all fail
  silently. These check the document actually handed to the webview.

## Adding to it

`extension.js` exports its internals below the `activate`/`deactivate` pair for
this suite. Anything you need to reach that isn't there yet goes in that list.
