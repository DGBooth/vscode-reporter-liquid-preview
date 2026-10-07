# Reporter Liquid Preview for Visual Studio Code

Everything for writing and checking Reporter's Liquid templates in VS Code:

- **[Previews](#live-html-preview)** that render a template with JSON data as you type, plus a [Document Options view](#full-html-preview-document-options-view) that shows every option a document offers, for colleagues who don't read Liquid.
- **[Problems](#problems-panel)** located to the line, in the preview and VS Code's Problems panel.
- **[Editing support](#writing-templates)** for Liquid and HTML together: colouring, completions (including your data's field names), closing tags as you type, and a Format Document that checks it hasn't changed the page.
- **[Template tests](#template-tests)** that render templates against known data and check the output, built by clicking the preview, with a report, the Testing view and a [command-line runner for CI](#running-template-tests-in-ci).
- **[Reporter's own tags and filters](#custom-liquid-tags)** (`optional`, `editor`, `choice`, `money`, `markdownify`…), rendered as Reporter renders them.

## Getting started

Install the `.vsix` from the [latest release](https://github.com/DGBooth/vscode-reporter-liquid-preview/releases/latest) with **Extensions: Install from VSIX…**. It updates itself from then on (see [Updates](#updates)). If you have Shopify Liquid installed, disable it for Reporter templates: this extension does its job, and the two would compete.

1. Open a `.liquid` file.
2. Press `ctrl+k h` for the HTML preview, and pick a `.json` data file when asked. (`ctrl+k v` gives a plain-text preview, and `ctrl+k f` the Document Options view, which needs no data.)
3. Edit the template or the data: the preview updates as you type.
4. To keep a render you've checked, press **Create test…** in the HTML preview and click the parts that matter. Run **Reporter Liquid: Run Template Tests** whenever you change the template.

### Updates

The extension is shared through its [GitHub releases](https://github.com/DGBooth/vscode-reporter-liquid-preview/releases) rather than a marketplace, and keeps itself up to date. Once a day, a few seconds after it starts, it checks GitHub for a newer release and offers it: **Install**, **What's new** (the release notes) or **Skip this version**. **Install** downloads the release's `.vsix`, checks it's exactly the file GitHub published (its SHA-256 fingerprint), installs it, and offers to reload the window.

- **Reporter Liquid: Check for Updates** checks straight away, and also offers a version you skipped.
- The daily check can be turned off with the **Reporter Liquid Preview › Check For Updates** setting (`reporterLiquidPreview.checkForUpdates`).
- The check needs to reach `api.github.com` and GitHub's download host. It goes through VS Code's proxy settings. When it can't get through, the daily check stays quiet, and **Check for Updates** says why.
- It runs when the extension starts in a window: when you first open a `.liquid` file, a preview or a workspace with template tests, not on every VS Code launch.
- Versions before 1.7.0 can't update themselves, so anyone on those needs to install 1.7.0 by hand once.

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

Reporter's own tags, rendered as Reporter renders them. Each takes a field name, quoted (`"notes"`) or as a variable holding it. In Reporter, the reader's answer comes back as `fields.<name>`; to preview or test an answer, put it under `fields` in the data, e.g. `{ "fields": { "includeNotes": "true", "delivery": "1" } }`.

| Tag | Renders | Options and answer |
|-----|---------|--------------------|
| `{% optional "name" %}…{% endoptional %}` | Its contents with a tick box. | Ticked when `fields.name` is `"true"`. |
| `{% editor "name" %}…{% endeditor %}` | A text box, or a text area with `lines` over 1. | `placeholder`, `lines` (1), `maxlength` (100), `minlength` (0). Its value is `fields.name`. |
| `{% choice "name", title: "…" %}…{% or %}…{% endchoice %}` | Options separated by `{% or %}`, as radio buttons, under an optional `title`. | `fields.name` is the chosen option's number, from `"0"` for the first (the default). |

Each field name should be used once per template; the [Problems panel](#problems-panel) flags a repeat.

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
- **Unbalanced HTML** — a closing tag like a stray `</div>` that closes nothing the output opened — is flagged with the text that follows it, so you can find it. Put into a whole page, such a tag can close an element around the document and push everything after it out of its section. The preview displays the output without it, as the template tests read it, so what you see, what you click in the test builder and what the checks test are always the same structure.
- **Data errors** are located in the `.json` file, not the template, using the position `JSON.parse` reports.
- The **Full HTML Preview** locates a missing end tag by line, alongside the "Not closed" markers in the annotated document that show where it starts.

Identical repeats are collapsed into one entry with a count, so a warning raised on every iteration of a loop doesn't push everything else out of view, and a **Hide** checkbox collapses the panel to a one-line summary when it is covering something you want to see.

The same problems are published to VS Code's **Problems** panel and underlined in the editor, so they are visible while you are editing the template with the preview off-screen. They are cleared when the preview is closed.

While a template does not parse, the preview keeps showing the last version that did — but its warnings are suppressed, because their line numbers describe a file that is no longer on disk. Only the parse error, which is current, is reported.

### Writing Templates

`.liquid` files get Liquid and HTML support together, so you don't need Shopify Liquid or another Liquid extension. If Shopify Liquid is installed, you'll be offered a link to disable it once: the two would compete to colour, complete and format templates, and it reports Reporter's tags as unknown.

- **Colouring** for Liquid and HTML, Liquid inside attributes, `<style>` and `<script>` included. Reporter's tags (`optional`, `editor`, `choice`, `or`) are coloured as such.
- **Completions** inside Liquid:
  - After `{%`, the tags. Choosing a block tag inserts its end tag too: `if` gives `{%- if … %}{%- endif %}`.
  - Where you are in the template decides what comes first. Inside an `if`, the list starts with `endif`, then `else` and `elsif`; inside a loop, `endfor`, then `else`, `break` and `continue`; inside a `case`, `endcase`, `when` and `else`; inside a `choice`, `endchoice` and `or`. Nested blocks offer the innermost first, then the ends of the blocks around it. Typing `{%- end` leaves just those end tags, each saying which tag it ends and the line that started. A block already closed further down is told apart from one that isn't, so its end tag comes after what goes inside it. Outside any block, no end tags are offered. Inside a `comment` or `raw` block the one tag offered is the one that ends it.
  - Reporter's tags go in over several lines, as in a formatted template: what's inside on its own indented line, and each `choice` option on its own. `choice` gives two options, and `or` inside a choice adds the next. Liquid's own tags stay on one line.

    ```liquid
    {%- choice "name", title: "Title" %}
      First option
    {%- or %}
      Second option
    {%- endchoice %}
    ```
  - After `|`, the filters, with what each takes and does, Reporter's own (`money`, `markdownify`…) included.
  - Field names from the data the template is used with: the data file of each HTML preview open on it, and the data of each test case for it. `{{ customer.` offers `name` and `address`. In `{% for item in items %}`, `item.` offers the fields of the list's items; `forloop.` its position.
  - `fields.` offers the names this template's `editor`, `optional` and `choice` tags give their fields. After `{% editor "name", ` you're offered the tag's options.
- **HTML completions** outside Liquid: tags, attributes and their values, as in an `.html` file.
- **Closing as you type**: typing `{%-` (or `{% `) adds the tag's ` %}` after the cursor. Starting a block tag (`{%- if `) adds its end tag at once, unless the template already closes it: type the condition, then press Tab to go between the tags. For `optional`, `editor` and `choice` that's the indented line between them. Typing the `%}` yourself types over the one already there rather than doubling it, so you still get one `%}` and one end tag; the cursor then stays on the tag's line, with the content line already below it. Typing an element's `>` adds its closing tag. Turn all of this off with `reporterLiquidPreview.autoClose`.
- **Indentation**: Enter after an opening tag or block tag indents; a closing tag or `{%- end… %}` lines up with what it closes.
- **Format Document** (`Shift+Alt+F`) lays out the whole template: HTML, Liquid and Reporter's tags indented by nesting, `<style>` and `<script>` tidied. It uses Shopify's Liquid formatter for Prettier, taught Reporter's tags. Double quotes are kept, and a Liquid tag on its own line gets the house `{%-`, so the layout's line breaks don't reach the page.
  - **It checks it hasn't changed the page.** Before applying anything, it renders the template before and after formatting with every set of data the template is used with (its previews' and its tests'), and with no data. If the page would show anything differently, it leaves the template alone and says where. Whitespace a reader can't see, such as between blocks, doesn't count. A missing space between words does. Where `{%-` would remove a space the page needs (`<span>a</span> {% if x %}<span>b</span>`), that tag keeps its space.
  - **The check is only as good as the data.** A branch none of the data reaches isn't rendered, so it isn't checked. The status bar says how many sets of data it checked against; with no previews or tests that's none but the empty one. Add tests that reach the branches that matter.
  - `reporterLiquidPreview.format.printWidth` sets where lines wrap (120 by default). The indent follows the editor's tab settings.

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

**Checks: smaller tests within a case.** An `expected` file fails on any change to the output, including ones that don't matter. Checks are small, named assertions about parts of the output: each passes or fails on its own, and a failure says which one broke and why.

```json
{
  "name": "two items",
  "data": "data/two-items.json",
  "checks": [
    { "name": "heading names the customer", "selector": "h1", "text": "Invoice for Ada Lovelace" },
    { "name": "one row per item", "selector": "table tr", "count": 2 },
    { "name": "prices are formatted as money", "selector": "td:nth-child(2)", "text": ["1,250.50", "42.00"] },
    { "name": "notes are ticked", "selector": "#includeNotes", "attributes": { "checked": true } },
    { "name": "no empty message", "notContains": "No items." }
  ]
}
```

You don't have to write these by hand: the [test builder](#template-tests) in the HTML preview writes them for you. `selector` is a CSS selector that picks the elements to check. The output is parsed the way a browser parses it, so a selector sees the same structure as the preview, including where a browser would rearrange broken markup. Then any of:

| Key | Checks |
|-----|--------|
| `row` | Instead of (or as well as) a selector: the label a table row starts with, e.g. `"Plan name"`. The check looks at the cell beside that label, in every row that has it. A label stays put when tables are added above it or rows are inserted, where a position like "2nd row, 2nd cell" doesn't. With a `selector` too, only rows inside what it matches count. |
| `tableWith` | With `row`: look only in tables that also have a row with this label, e.g. `"Crystallisation amount"`. This is how to say "the Plan name in *this* table" when the label repeats, without depending on where the table is. |
| `exists` | `true`: the selector matches something. `false`: it matches nothing. A selector with nothing else to check means `exists: true`. |
| `count` | How many elements match. |
| `text` | The element's text as a reader sees it, with entities decoded and whitespace collapsed. Table cells and blocks read as separate words, and script and style are left out. A single value needs exactly one match: if several match, the check fails rather than guess which one you meant. Give a list to check each match in order. |
| `contains` / `notContains` | With a selector: text the matched elements' text must or must not contain. Without one: text the page must or must not mention, read as a reader sees it. (A case's own `contains` searches the HTML instead, for matching markup.) |
| `attributes` | Attributes of the one matched element: a value it must equal, `true` (present) or `false` (absent). |

A case can use checks, `expected`, or both. If the case fails to render, its checks are reported as not run. Checks appear in the report under their case, in the Testing view as children of the case (each with its own run button in the suite file), and as separate test cases in the command line's JUnit output.

**Building a test by clicking: no JSON needed.** Press **Create test…** in the HTML preview's toolbar. A panel opens beside the preview:

1. Give the test a name. It defaults to the data file's name.
2. Click any part of the page: a heading, a price, a tick box, a row. The builder offers what could be true about it, in plain words:
   - *It reads exactly "Invoice for Ada Lovelace"*
   - *It includes:* a phrase you can trim to the part that matters
   - *There are 3 of these*, with the counted parts highlighted. This is how to check a loop ran once per item: click one of the three recommendation tables, and the check says there are three. It counts that element's family, found by its class (`table.recommendation`) or a repeated container with a class around it, so other tables on the page aren't counted. Only with no class to go on does it fall back to the element's position, which works when the loop's output sits in a container of its own, such as each recommendation in its own `<div>`. It can't work when the loop's tables sit directly beside other tables with nothing to tell them apart. Give the loop's element a class then (`<table class="recommendation">`). The counted tables are highlighted before you add the check, so you'll see if it's counting too many.
   - *It is ticked*, or *It shows "PO-77"* for a text box
   - *It is shown*

   For a value in a label/value table ("Plan name | NFUM Select…"), the first offers find the cell **by its row's label**: *"'Plan name' reads '…'"*. Prefer these. They keep working when tables are added above or rows are inserted, where checks found by position break. The label can be anything in the row's first column, as long as the value is the cell right beside it. If the label repeats (a "Plan name" row in each recommendation, or in two tables), the first offer is **just this table**: the cell you clicked, in its table. The table is named by its class if it has one, otherwise by another row label only it has (*"in the table with 'Crystallisation amount'"*), so adding tables doesn't break it. Only with neither does it fall back to the table's position, and the offer says so. You're also offered all the values as a list, and *"There are 3 'Plan name' rows"*, a loop count that doesn't depend on the layout.

   For a part with no name of its own, such as a plain paragraph, the builder can only find it by position ("the 4th paragraph"). Every such check shifts onto its neighbour when a section above it is added or removed. So for these the first offer is *The page shows "…"*, which checks the text is on the page wherever it is. The position-based offers are still there, and say they're found by position. Better still, give the part a class or id in the template, and the builder will use it.

   Pick one, adjust the check's name if you like, and **Add check**. If you picked something too small, **Select the area around it** widens the selection.
3. Add *The page doesn't mention…* or *The page mentions…* checks for text anywhere on the page.
4. Tick **Also check the whole page stays exactly as it is now** only if you want a whole-page snapshot too. It fails on any change at all.
5. **Save test**.

While the builder is open, clicking the page selects rather than acts, so a tick box doesn't tick and a link doesn't open. The builder writes the checks for you, preferring names that survive layout changes (Reporter's field ids, element ids) over positions on the page. Before anything is saved, the page is rendered again and every check is run against it. If one doesn't pass, nothing is saved and the panel says which check and why, so a test built this way passes the moment it's created. Several tests can use the same data file.

Only add checks for things that are right in the preview now. The builder records what the page shows; it can't know whether that's what it *should* show.

**Editing a test.** Open the test in the builder in either of two ways: **Edit test** in the report, or **Create test…** in the HTML preview with the same data file, then pick it from **Test** at the top of the panel. You can then:

- add checks by clicking the page, as when creating one;
- remove checks with **Remove**;
- change their order with **↑** and **↓**, which is the order they're listed and reported in.

**Save changes** updates the test in place. Checks you've added are marked *new*, and only they have to pass before the test saves: a test is often opened *because* one of its checks fails, and that shouldn't stop you reordering or removing others. Any that still fail are shown in the report afterwards.

**Accepting one check's new result.** When a check fails because the page has changed on purpose (a new name, an extra row, a box now unticked), use **Accept new result** on that check in the report. You'll be asked to confirm, with the change spelled out ("it expected 'For Fred'; the page now has 'For Client4'"). The check is then updated to expect what the page shows now, and its name too, where it quoted the old value. The other checks in the test are untouched.

**Checks that shifted.** When a section of the template is removed or added, checks that find their part by position move onto the part next to it: each fails reading its neighbour's text. Don't accept those results; that would record the neighbour's text. The report spots them: when the text a failed check expects is still on the page, it says so and offers **Find it by its text**, which changes the check to look for that text anywhere on the page. **Find all N by their text** on the test does every such check at once. You'll be asked to confirm first. A check found by its text no longer notices the text moving, only it going missing. A check for the section you removed still fails, as it should: remove it.

Only checks with a value read off the page can be accepted: *reads exactly*, counts, *is ticked*, *is shown* and text-box values. When "includes 'Net 30'" or "doesn't mention…" fails, there's no single right replacement, so those offer **Remove check** instead. Rebuild them in the builder if they're still wanted. Accepting is how a real regression gets waved through, so only accept a result you've checked is right.

**Creating tests in bulk from known cases.** **Reporter Liquid: Create Tests from Data Files…** (also on the right-click menu of a `.liquid` file in the Explorer or editor) takes several data files whose output you've checked and makes one case for each, with its whole output as the expected file.

Either way, cases go into the suite beside the template (`invoice.liquidtest.json` for `invoice.liquid`, created if needed), and expected output goes under `expected/<template>/`. The new cases are run straight away, so the report shows them passing. What gets frozen is checked first:

- In bulk, a data file an existing case already uses for that template is skipped rather than duplicated. Existing expected files are never overwritten.
- A case that fails to render, or repeats a field name, is left out with the reason. It would fail the moment it was created.
- If filters warn about missing data, you choose between skipping those cases and saving them with `allowWarnings`. Allowing warnings means the test can no longer catch that data going missing.
- Unsaved edits to the template or data are saved first (after asking). A case records files on disk, so output rendered from an unsaved buffer would never match.

Cases refer to your data files rather than copying them. If you keep editing a data file while working on a template, a case built from it fails when the data changes. Copy the data somewhere dedicated to tests first if you want it frozen.

**Running them.**

- **Reporter Liquid: Run Template Tests** runs every suite in the workspace and opens the report.
- On VS Code 1.59 or newer, the suites also appear in the **Testing** view, with run buttons next to each case in the suite file. A case whose output changed opens in VS Code's diff view, expected against actual.

**The report** lists every suite and case with its verdict and timing, and for each failure says why: a line diff of expected against actual output (long single-line HTML is pretty-printed first so the diff lands on the element that changed), the problem and the line it came from, or the text that was missing. File names and positions are clickable. **Show failures only** hides the cases and suites that passed; a failing case always lists all its checks, passed ones included, so you can see what still holds. **Save report…** writes the same report as a standalone HTML file, for a ticket or a release record. A run from the Testing view refreshes the report if it is open; **Reporter Liquid: Show Template Test Report** opens it.

**Creating and updating expected output.** Point `expected` at a file that doesn't exist yet and run the case: it fails, and the report shows the actual output. If that output is right, **Accept actual output** (in the report, or **Reporter Liquid: Accept Actual Output as Expected**) writes it to the expected file — for every case in the last run whose expected file is missing or different, after asking. Review the change in source control before committing: accepting output you haven't read turns the test into a record of whatever the template does today.

See [`examples/template-tests`](examples/template-tests) for a working suite.

#### Running template tests in CI

Tests that only run when someone remembers to open the editor get skipped. `liquid-test` runs the same suites from the command line, through the same engine and the same checks as the editor, so a case passes in CI exactly when it passes in VS Code. The only difference: the editor includes unsaved edits, and `liquid-test` reads files as saved on disk.

```
npx github:DGBooth/vscode-reporter-liquid-preview#v1.12.0 [options] [paths...]
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
- run: npx --yes github:DGBooth/vscode-reporter-liquid-preview#v1.12.0 --report liquid-test-report.html --junit liquid-tests.xml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: liquid-test-report
    path: liquid-test-report.html
```

Pin the tag to the version of the extension you have installed (see [Releases](https://github.com/DGBooth/vscode-reporter-liquid-preview/releases)). The engine changes along with the extension, and an unpinned runner can disagree with the editor. `if: always()` keeps the report when the tests fail, which is when you need it.

## Settings and shortcuts

| Setting | Default | |
|---------|---------|--|
| `reporterLiquidPreview.autoClose` | on | Closing as you type in `.liquid` files: the `%}` after `{%-`, block end tags, HTML closing tags. |
| `reporterLiquidPreview.format.printWidth` | 120 | Where Format Document wraps lines. |
| `reporterLiquidPreview.checkForUpdates` | on | The daily check for a new release. |

| Shortcut (in a `.liquid` file) | |
|----------|--|
| `ctrl+k h` | HTML preview |
| `ctrl+k v` | Plain-text preview |
| `ctrl+k f` | Document Options view (Full HTML Preview) |
| `Shift+Alt+F` | Format Document (VS Code's own shortcut) |

All commands are in the command palette under **Reporter Liquid:**. **Create Tests from Data Files…** is also on the right-click menu of a `.liquid` file.

## Development

```
npm install
npm test                # the test suite
npm run package         # rebuild the committed .vsix
npm run check:package   # is the committed .vsix built from this source?
```

Where things are. Only `extension.js` and `authoring.js` load `vscode`; the
rest runs under plain Node, which is how the command-line runner and the tests
use them.

| File | |
|------|--|
| `engine.js` | The rendering engine: LiquidJS with Reporter's tags and filters, and where each problem is. Shared by the extension and the command-line runner, so the two can't drift apart. |
| `extension.js` | The previews, the problems panel, template tests in the editor (report, Testing view, creating and editing tests), updates. |
| `template-tests.js` | Suites: reading them, running cases, the report, editing a suite in place. |
| `output-checks.js` | Checks: parsing the output as a browser would, selectors and row labels, accepting and relocating. |
| `webview/test-builder.js` | The point-and-click test builder in the HTML preview. |
| `formatter.js` | Format Document: the layout, the `{%-` house style, and the before/after rendering check. |
| `editing.js` | Completions and closing as you type. |
| `authoring.js` | Both of those as VS Code providers, and the HTML language service. |
| `syntaxes/`, `language-configuration.json` | Colouring, brackets and indentation for `.liquid` files. |
| `updates.js` | Checking for and verifying a new release. |
| `bin/liquid-test.js` | The command-line runner. `npm run test:templates` runs it on the example suite. |

The test suite runs on Node's built-in runner (Node 20 or newer) against a
stubbed `vscode` module, so it needs no extension host. Beyond the extension's
own dependencies it uses jsdom (the webviews) and vscode-textmate with
vscode-oniguruma (the grammar). It covers the rendering path — including a
byte-for-byte comparison against a stock LiquidJS engine, which guards the
wrapper that lets warnings name their line — the located problems panel, the
HTML handed to the webview, template tests and the builder, editing support and
the formatter. See [`test/README.md`](test/README.md).

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

## Releasing

Every version is a tagged GitHub release with its notes and `.vsix` attached. [CHANGELOG.md](CHANGELOG.md) lists them all.

**A release happens only when a version bump is merged into `main`.** Any other change merges without releasing anything: it goes under `## [Unreleased]` at the top of the changelog, and reaches users with the next release. Until then, rebuild the `.vsix` under the current version (`npm run package`) so `npm run check:package` passes; the published release keeps its original file.

1. Bump `version` in `package.json` and `package-lock.json`.
2. Rename `## [Unreleased]` in `CHANGELOG.md` to `## [<version>] - YYYY-MM-DD`, or add that section if there are no unreleased notes. `npm test` fails until the current version has one.
3. `npm run package` to rebuild the `.vsix`, and commit it with the rest.
4. Merge into `main`. The Release workflow runs the tests and the package check, tags the commit `v<version>`, and publishes the release with that version's changelog section as its notes and the `.vsix` attached. A merge that doesn't change the version does nothing.

To install a release, download its `.vsix` and run **Extensions: Install from VSIX…**.

`node scripts/release-notes.js [version]` prints the notes a release will get.

## Credits

This extension began as a fork of [Shopify Liquid Preview for Visual Studio Code](https://github.com/kirchner-trevor/vscode-shopify-liquid-preview) by [kirchner-trevor](https://github.com/kirchner-trevor), a plain-text Liquid preview, which was itself inspired by:

- [Handlebars Preview for Visual Studio Code](https://github.com/chaliy/vscode-handlebars-preview/)
- [A HTML previewer for Visual Studio Code](https://marketplace.visualstudio.com/items?itemName=tht13.html-preview-vscode)

Little of that remains beyond the plain-text preview. Everything else was added for Reporter: the HTML preview, the Document Options view and its standalone export, the HTML source views, CSS loading, Reporter's tags and filters, the located problems panel, template tests with checks, the test builder, the report, the Testing view and the command-line runner, editing support and formatting, and updates from GitHub releases.

It is unrelated to Shopify's own **Shopify Liquid** extension, which it replaces for Reporter templates. Format Document uses Shopify's [Prettier plugin for Liquid](https://github.com/Shopify/theme-tools/tree/main/packages/prettier-plugin-liquid) (MIT), bundled at a fixed version, and HTML completions use Microsoft's [vscode-html-languageservice](https://github.com/microsoft/vscode-html-languageservice) (MIT).

## License

MIT, as the original Shopify Liquid Preview declared. See [LICENSE](LICENSE). The libraries bundled in the `.vsix` keep their own licences (MIT, BSD-2-Clause and ISC), in their folders under `node_modules`: as a licence file where the library publishes one, otherwise in its `package.json`.
