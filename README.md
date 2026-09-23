# Reporter Liquid Preview for Visual Studio Code

Live preview for Reporter Liquid templates. Renders templates on the fly with JSON data, updating as you type.

## Features

### Live Text Preview

Renders your Liquid template as plain text in a side panel, updated on every keystroke. Useful for checking template output without full HTML rendering.

- Use `ctrl+k v` (or **Reporter Liquid: Open Preview to the Side** from the command palette) while a `.liquid` file is active.
- Pick a `.json` file from the workspace to supply the template data context.

### Live HTML Preview

Renders your template as a styled HTML page in a VS Code webview panel, updated as you edit.

- Use `ctrl+k h` (or **Reporter Liquid: Open HTML Preview to the Side**) while a `.liquid` file is active.
- The rendered output is displayed with a white background and black text (including headings h1–h6), ensuring legibility regardless of your editor theme.
- Edits update the preview **in place** — the document is patched rather than reloaded, so your scroll position and view settings survive every keystroke. Switching to another tab and back also preserves the view exactly as you left it.

#### Show HTML source

A toolbar pinned to the top of the viewport offers a **Show HTML source** checkbox that swaps the rendered document for the HTML behind it — the same render currently in view, reflecting the selected data file and field values. This replaces the need to keep a separate text preview open alongside the HTML preview.

- The source is pretty-printed for readability: block elements are indented one per line, while inline content and the bodies of `pre`/`textarea`/`script`/`style` are left untouched, so the markup shown renders identically to the original.
- The source is syntax-highlighted like the built-in editor: colours follow VS Code's default light/dark themes, and the code is displayed in your editor's font on the editor background.
- Switching views keeps your place: the view you enter is scrolled to the same content you were looking at in the view you left, in both directions.
- Robust against imperfect template output — stray closing tags or unclosed elements in the rendered HTML cannot break the toggle or the preview's own UI.

### Full HTML Preview (Document Options view)

Renders your template as a layman-readable "document options" overview — designed to be shown to colleagues who don't know Liquid, so they can see every option, optional section and fill-in field a document offers.

- Use `ctrl+k f` (or **Reporter Liquid: Open Full HTML Preview to the Side**) while a `.liquid` file is active.
- No data file is required — Liquid logic is annotated rather than executed.
- A header at the top names the document, summarises what it contains (e.g. "2 multiple-choice sections (5 options in total), 1 optional section, 3 fill-in fields…") and includes a collapsible plain-English key to the markers.
- **Only actual outputs are shown**: loops and conditionals that exist purely to set up variables (`assign`, `capture`, etc.) and produce nothing visible are hidden entirely, as are empty branches of otherwise-visible conditionals — so readers see every possible output without the behind-the-scenes logic that makes it work.
- Liquid constructs are shown as colour-coded, plainly worded boxes:

| Construct | Colour | Shown as |
|-----------|--------|----------|
| `{% choice %}` / `{% or %}` | Blue | "Choose one" box (with the choice title) containing numbered Option 1, Option 2, … |
| `{% optional %}` | Green | "Optional" box, with the field name in readable words |
| `{% editor %}` | Amber | "Fill in" box, showing the placeholder text; inner content appears as the starting suggestion |
| `{% if %}` / `{% elsif %}` / `{% else %}` / `{% unless %}` / `{% case %}` | Purple | "Shown when …" branches with the condition translated to plain English (e.g. `patient.age > 8` → "patient age is more than 8") |
| `{% for %}` | Teal | "Repeats — once for each … " box |
| `{% comment %}` | Grey (dashed) | "Author note" box |
| `{{ variable }}` | Grey chip | Inline placeholder chip in readable words (e.g. `{{ owner.last_name }}` → "owner last name"), so sentences keep their flow |

#### Toolbar toggles

A toolbar pinned to the top of the viewport offers:

- **Show author notes** — untick to hide the `{% comment %}` boxes (and their legend entry) when the notes are only relevant to template developers. Only shown when the template contains notes.
- **Show HTML source** — swaps the view for a complete, standalone HTML document ready to publish elsewhere (e.g. paste into SharePoint or save as an `.html` file). The preview's styles and the contents of any external CSS the preview loads are inlined, so the document works entirely on its own; the toggle controls themselves are excluded. Click the code once to select all of it for copying.

### CSS Loading

The HTML preview automatically injects stylesheets so the output matches your intended design:

- **`universal.css`** — any file with this name found at the root of your workspace folders is injected into every preview.
- **`css/` folder** — all `.css` files inside a `css/` directory that sits alongside the active template file are injected.

The Full HTML Preview's standalone export inlines the contents of these same files.

### Custom Liquid Tags

The extension registers several Reporter-specific Liquid tags beyond the standard set:

| Tag | Description |
|-----|-------------|
| `{% optional %}…{% endoptional %}` | Marks optional content with a checkbox wrapper. |
| `{% editor %}…{% endeditor %}` | Marks an editable region, rendering an input or textarea from data. |
| `{% choice %}…{% or %}…{% endchoice %}` | Defines multiple alternatives separated by `{% or %}`, rendered as radio buttons. |

### Custom Liquid Filters

| Filter | Description |
|--------|-------------|
| `money` | Formats a number to two decimal places with comma separators (e.g. `1234.5` → `1,234.50`). |
| `markdownify` | Renders Markdown text as HTML, as in Reporter (e.g. `- Test` becomes a bullet point). Supports headings, paragraphs, nested bullet/numbered lists, blockquotes, fenced code blocks, horizontal rules, and inline bold/italic/code/links/images; raw HTML passes through untouched. Warns instead of erroring when the value is missing. The output is wrapped in a `<div class="rlp-markdown">` whose first/last block margins the HTML preview trims, so the content sits flush with its surroundings as it does in Reporter. |
| `json` | Serialises a value as JSON, as in [LiquidJS](https://liquidjs.com/filters/json.html), pretty-printed with a 2-space indent by default. An optional argument overrides the indentation (e.g. `{{ value \| json: 4 }}`, or `{{ value \| json: 0 }}` for compact single-line output). |
| `slice` | Overrides the built-in to warn instead of erroring when the value is missing. |
| `where` | Overrides the built-in to warn instead of erroring when the array is missing. |
| `sort` | Overrides the built-in with null-safe sorting and property-key support. |
| `sort_natural` | Overrides the built-in with null-safe, case-insensitive sorting and property-key support. |

### Status Bar Indicators

Two status bar items show the health of the active preview at a glance:

- **Template** — shows a check or error icon reflecting the last template parse attempt.
- **Data** — shows a check or error icon reflecting the last JSON data parse attempt.

### Problems Panel

Parse and render errors are shown in a panel pinned to the bottom of the preview webview, so the last successfully rendered output stays visible while the details are reported. The panel also reports warnings from the null-tolerant filters and flags field names used more than once in a template.

Every entry says **where** the problem is, not just what it is:

- **A file, line and column**, shown as a button — click it and the file opens with the caret on that spot. A file already open keeps its editor column, so clicking a problem doesn't rearrange your layout.
- **The offending source**, quoted underneath, so you can recognise the construct without leaving the preview.
- Warnings raised inside a filter are traced back to the `{{ ... }}` or `{% ... %}` that ran it — including filters called from inside a loop or a nested tag, which have no way to name their own position otherwise.
- **Duplicate field names** point at the repeat and name the line it collides with, rather than just listing the names.
- **Data errors** are located in the `.json` file, not the template, using the position `JSON.parse` reports.
- The **Full HTML Preview** locates a missing end tag by line, alongside the "Not closed" markers in the annotated document that show where it starts.

Identical repeats are collapsed into one entry with a count, so a warning raised on every iteration of a loop doesn't push everything else out of view, and a **Hide** checkbox collapses the panel to a one-line summary when it is covering something you want to see.

The same problems are published to VS Code's **Problems** panel and underlined in the editor, so they are visible while you are editing the template with the preview off-screen. They are cleared when the preview is closed.

While a template does not parse, the preview keeps showing the last version that did — but its warnings are suppressed, because their line numbers describe a file that is no longer on disk. Only the parse error, which is current, is reported.

### Template Tests

Check that templates still render what they should, against data you control. A test suite is a `*.liquidtest.json` file anywhere in the workspace; each case renders a template with some data and checks the output. Cases render through exactly the same engine as the preview, custom tags, filters and warnings included, so a test sees what the preview would.

```json
{
  "template": "invoice.liquid",
  "cases": [
    {
      "name": "two items",
      "data": "data/two-items.json",
      "expected": "expected/two-items.html"
    },
    {
      "name": "no items shows the empty message",
      "data": { "customer": { "name": "Ada" }, "items": [] },
      "contains": "<p>No items.</p>",
      "notContains": "<table>"
    }
  ]
}
```

Paths are relative to the suite file. A case can use any mix of checks:

| Key | Meaning |
|-----|---------|
| `template` | The template to render. Set it once at the top of the suite, or per case. |
| `data` | A path to a `.json` file, or the data inline as an object. Put editor/choice/optional answers under `fields`, as for the preview. |
| `expected` | A file with the exact expected output (a *golden file*). Line-ending style and a final newline are ignored, so a checkout on Windows still matches. |
| `contains` / `notContains` | A string, or a list of strings, that the output must / must not contain. |
| `whitespace` | `"exact"` (default) or `"collapse"`, which ignores whitespace between tags and treats any run of whitespace as one space. Can be set suite-wide. |
| `allowWarnings` | Let the case pass while filters warn about missing data. Off by default: with known data, a warning usually means the data or the template is wrong. Can be set suite-wide. |

Every case also fails on a render error or a **duplicate field name**, and on filter warnings unless they are allowed. The editor offers completion and validation for these keys in any `*.liquidtest.json` file.

**Creating them from known cases.** Most tests start as a case you have already checked by eye: a template and a data file whose output you know is right. Two ways to turn those into tests:

- **Save as test…** in the HTML preview's toolbar adds the template and data file you're looking at as a case, with the output on screen as its expected output. You're asked for a name, defaulting to the data file's.
- **Reporter Liquid: Create Tests from Data Files…** (also on the right-click menu of a `.liquid` file in the Explorer or editor) takes several data files at once and makes one case for each.

Either way, cases go into the suite beside the template (`invoice.liquidtest.json` for `invoice.liquid`, created if needed), and expected output goes under `expected/<template>/`. The new cases are run straight away, so the report shows them passing. What gets frozen is checked first:

- A data file an existing case already uses for that template is skipped rather than duplicated. Existing expected files are never overwritten.
- A case that fails to render, or repeats a field name, is left out with the reason. It would fail the moment it was created.
- If filters warn about missing data, you choose between skipping those cases and saving them with `allowWarnings`. Allowing warnings means the test can no longer catch that data going missing.
- Unsaved edits to the template or data are saved first (after asking). A case records files on disk, so output rendered from an unsaved buffer would never match.

Cases refer to your data files rather than copying them. If you keep editing a data file while working on a template, a case built from it fails when the data changes. Copy the data somewhere dedicated to tests first if you want it frozen.

**Running them.**

- **Reporter Liquid: Run Template Tests** runs every suite in the workspace and opens the report.
- On VS Code 1.59 or newer, the suites also appear in the **Testing** view, with run buttons next to each case in the suite file. A case whose output changed opens in VS Code's diff view, expected against actual.

**The report** lists every suite and case with its verdict and timing, and for each failure says why: a line diff of expected against actual output (long single-line HTML is pretty-printed first so the diff lands on the element that changed), the problem and the line it came from, or the text that was missing. File names and positions are clickable. **Show failures only** hides what passed. **Save report…** writes the same report as a standalone HTML file, for a ticket or a release record. A run from the Testing view refreshes the report if it is open; **Reporter Liquid: Show Template Test Report** opens it.

**Creating and updating expected output.** Point `expected` at a file that doesn't exist yet and run the case: it fails, and the report shows the actual output. If that output is right, **Accept actual output** (in the report, or **Reporter Liquid: Accept Actual Output as Expected**) writes it to the expected file — for every case in the last run whose expected file is missing or different, after asking. Review the change in source control before committing: accepting output you haven't read turns the test into a record of whatever the template does today.

See [`examples/template-tests`](examples/template-tests) for a working suite.

#### Running template tests in CI

Tests that only run when someone remembers to open the editor get skipped. `liquid-test` runs the same suites from the command line, through the same engine and the same checks as the editor, so a case passes in CI exactly when it passes in VS Code. The only difference: the editor includes unsaved edits, and `liquid-test` reads files as saved on disk.

```
npx github:DGBooth/vscode-reporter-liquid-preview#<tag or commit> [options] [paths...]
```

With no paths it searches the current folder recursively for `*.liquidtest.json`, skipping `node_modules` and hidden folders. It needs Node 20 or newer.

| Option | |
|--------|--|
| `--report <file>` | Also write the HTML report (the same one **Save report…** produces). |
| `--junit <file>` | Also write JUnit XML, which most CI systems can show as a test summary. |
| `--update` | Write the actual output to every expected file that is missing or different, then re-run. For local use. Review the changes before committing them. |
| `--no-color` | Plain output. Colour is also off when `NO_COLOR` is set or output isn't a terminal. |

It exits with **0** when every case passes, **1** when any case fails or a suite is broken, and **2** on a usage error. Finding no suites at all also exits 2, so a job pointed at the wrong folder can't pass by running nothing.

In a GitHub Actions workflow in your templates repository:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npx --yes github:DGBooth/vscode-reporter-liquid-preview#<commit-sha> --report liquid-test-report.html --junit liquid-tests.xml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: liquid-test-report
    path: liquid-test-report.html
```

Pin the reference to the version of the extension your team has installed: a commit SHA, or a tag once releases are tagged (e.g. `#v1.4.0`). The engine changes along with the extension, and an unpinned runner can disagree with the editor. `if: always()` keeps the report when the tests fail, which is when you need it.

## Usage

1. Open a `.liquid` file.
2. Press `ctrl+k h` to open the HTML preview (or `ctrl+k v` for the plain-text preview, or `ctrl+k f` for the Full HTML Preview).
3. Select a `.json` data file when prompted (not required for Full HTML Preview).
4. Edit your template or data file — the preview updates automatically.
5. To keep a render you've checked, press **Save as test…** in the HTML preview, then run **Reporter Liquid: Run Template Tests** whenever you change the template (see [Template Tests](#template-tests)).

## Development

```
npm install
npm test                # the test suite
npm run package         # rebuild the committed .vsix
npm run check:package   # is the committed .vsix built from this source?
```

The rendering engine (LiquidJS with the custom tags and filters, and the
problem locations) lives in `engine.js`, which never loads `vscode`. Both the
extension and the command-line runner in `bin/liquid-test.js` use it, so the
two cannot drift apart. `npm run test:templates` runs the runner on the
example suite.

The test suite runs on Node's built-in runner (Node 20 or newer) against a
stubbed `vscode` module, so it needs no dependencies beyond the extension's own
and no extension host. It covers the rendering path — including a byte-for-byte
comparison against a stock LiquidJS engine, which guards the wrapper that lets
warnings name their line — the located problems panel, and the HTML handed to
the webview. See [`test/README.md`](test/README.md).

The `.vsix` is committed alongside the source, so it can go stale when a change
lands without a repackage — and the stale one is what gets installed.
`npm run check:package` builds a fresh package and compares it with the
committed one entry by entry, naming any file that differs. Two builds of the
same source are not byte-identical as archives, so it compares what the entries
hold rather than the file itself.

`npm run package` pins the vsce version and passes explicit base URLs: vsce
rewrites relative links in the README, and would otherwise infer where they
point from whatever the checkout looks like.

Both checks run on every push and pull request via GitHub Actions, the test
suite (and the example template suite) across all three Node versions.

## Credits

This extension is based on [Shopify Liquid Preview for Visual Studio Code](https://github.com/kirchner-trevor/vscode-shopify-liquid-preview) by [kirchner-trevor](https://github.com/kirchner-trevor), which was itself inspired by:

- [Handlebars Preview for Visual Studio Code](https://github.com/chaliy/vscode-handlebars-preview/)
- [A HTML previewer for Visual Studio Code](https://marketplace.visualstudio.com/items?itemName=tht13.html-preview-vscode)

New functionality added for Reporter includes the HTML webview preview, Full HTML Preview with annotated Liquid tag visualisation and standalone HTML export, in-preview HTML source views with formatting and syntax highlighting, automatic CSS injection, custom Reporter Liquid tag support (`optional`, `editor`, `choice`), custom filters, the located problems panel with editor navigation and Problems-panel integration, template tests with a results report and Test Explorer integration, and status bar indicators.

## License

MIT
