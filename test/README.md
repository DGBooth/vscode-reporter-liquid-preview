# Tests

```
npm test
```

Runs every `test/*.test.js` with Node's built-in test runner — no dependencies
beyond the extension's own and its dev dependencies (jsdom for the webviews,
vscode-textmate with vscode-oniguruma for the grammar). Individual files and filters work as
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
- **`template-tests.test.js`** — `*.liquidtest.json` suites: how cases are
  parsed and resolved, every verdict (golden files, fragments, warnings,
  duplicate names, parse errors, missing files), the diff, the report's
  escaping, accepting actual output, and the Test Explorer mapping. The stub
  models just enough of the Testing API (`vscode.tests`) to record what a run
  reports for each case.
- **`create-tests.test.js`** — creating cases from known cases: the plan for
  a new or existing suite (paths, unique names, what is skipped), the guards
  against freezing bad output (render errors, duplicate names, warnings,
  unsaved edits), and both ways in: the command and the preview's
  "Save as test" button.
- **`output-checks.test.js`** — checks on parts of the output: each kind
  (`text`, `count`, `exists`, `contains`, `attributes`) and the messages it
  fails with, that the output is parsed as a browser would, that the parser
  only loads when a selector is used, and how checks appear in a case's result,
  the report, the command line's JUnit and the Test Explorer.
- **`test-builder.test.js`** — the HTML preview's point-and-click test
  builder, loaded into jsdom (whose parser is parse5, as the runner's is). The
  main test renders a realistic Reporter document and, for every element,
  runs every check the builder would offer through the real runner: all must
  pass. Also: selectors prefer names over positions, a table cell's count is its
  column, proposals read in plain words, and the builder reads text exactly as
  the runner does.
  Row checks: clicking a value cell offers a check found by its row's label;
  it keeps passing when a table is added above, where the positional one
  fails; a label repeated in a loop gives a list and a count.
- **`relocating-checks.test.js`** — checks found by position after a section
  above them is removed: those whose text is still on the page are marked as
  looking in the wrong place (a changed value or a row check isn't), the
  report offers **Find it by its text** per check and for the whole test, and
  the rewritten checks pass. The builder offers a page-text check first for a
  part found only by position.
- **`formatter.test.js`** — Format Document's logic: Reporter's tags laid out
  as blocks and put back as written, double quotes kept, `{%-` added where a
  tag starts a line except where the page needs the space before it (found by
  rendering), formatting twice changes nothing more, raw and comment blocks are
  kept, and a layout that changes the page, or a template that can't be read or
  rendered, is refused. Also how two pages are compared: whitespace a reader
  can't see doesn't count, a lost space between words does.
- **`authoring.test.js`** — writing templates: completions (every filter and
  tag the engine has is described; tags bring end tags; data fields by path,
  through loops and assigns; `fields.` names from Reporter's tags; end tags and
  what goes inside a block ranked by where the cursor is, a block closed below
  told from one that isn't, comments and raw blocks ended); typing, simulated
  key by key the way VS Code pairs it (`{` with `}`, `{%` with ` %}`, `{{` with
  ` }}`, quotes), with the extension settling after every key and after the
  last only, which must agree; what settling does (the extra `%}`, a block's end
  tag, waiting for a line that isn't ready); the editor-side handler against a
  fake editor (keys still arriving, an edit turned down, the cursor elsewhere,
  HTML closing tags); the providers as VS Code calls them (data from tests and
  previews, Format Document's edit and its refusal); and the grammar, tokenised
  with vscode-textmate against a stand-in HTML grammar.
- **`real-editor/`** — not run by `npm test`: types into a real VS Code
  (code-server) at several speeds. See its README. The unit tests can't show
  what typing speed does to an extension.
- **`unbalanced-html.test.js`** — output with a stray closing tag, loaded as
  a whole page in jsdom as a browser would: the rest of the document stays in
  the preview's container and its section, first load matches an edit, the
  builder can pick after it, and the problems pane names it.
- **`editing-tests.test.js`** — changing tests after they're made: accepting a
  check's new result (what each kind becomes, its renamed name, and where
  there's nothing to accept), removing a check, the report's buttons, and
  editing a test in the builder — reorder, remove, add, rename — including the
  panel itself in jsdom, and the guards that stop a suite edited since the run
  having the wrong test changed.
- **`updates.test.js`** — updating from GitHub releases, against a fake
  GitHub: which releases are offered, the once-a-day check (which stays quiet
  when it fails), skipping a version, the setting, and that a download is
  installed only if its SHA-256 matches the one GitHub published.
- **`cli.test.js`** — the command-line runner: exit codes (including finding
  no suites, which must not pass), verdicts that match the editor's, suite
  discovery, `--junit`, `--report` and `--update`, and that it loads in a
  plain Node process with no `vscode` module anywhere on its path.
- **`preview-html.test.js`** — the preview document is assembled as a string, so
  escaping, unbalanced markup and a broken inline script would all fail
  silently. These check the document actually handed to the webview.

## Adding to it

`extension.js` exports its internals below the `activate`/`deactivate` pair for
this suite. Anything you need to reach that isn't there yet goes in that list.
