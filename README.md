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
2. Press `ctrl+k h` for the HTML preview, and pick a `.json` data file when asked (to narrow that list to your crawl results, see [Data files](#data-files)). (`ctrl+k v` gives a plain-text preview, and `ctrl+k f` the Document Options view, which needs no data.)
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
- Scripts in the template's output don't run in the preview, and neither do `onclick` and the like: it shows the HTML and CSS only. Images, fonts and stylesheets load from the workspace, from `https:` addresses and from `data:` URIs.

#### The tabs: Edit, PDF preview, HTML source

Reporter shows a document two ways: an edit mode, where the adviser ticks the optional parts, picks the choices and types the fill-ins, and the PDF made from it with those answers applied. The tabs in the preview's toolbar are those two, and the HTML behind the first.

- **Edit** (where the preview opens) shows the fields as controls. Tick, choose or type and the page is rendered again with the answer, so anything that reads it follows: `{{ fields.notes }}`, `{% if fields.includeNotes == 'true' %}`. A text box takes its answer when you leave it or press Enter.
- **PDF preview** shows the document as it is read, on the pages SelectPdf will make (see [SelectPdf pages](#selectpdf-pages)): an optional part is there or not, a choice shows the option picked, and an editor shows the text typed, with its line breaks.
- **HTML source** shows the HTML behind the Edit tab.
- Answers given in the preview are laid over the ones under `fields` in the data file and last as long as the preview does; the data file isn't changed. **Reset answers** goes back to the data file's.
- Tests render the Edit tab's document from the data file, so **Create test…** asks you to reset any answers given in the preview first.

#### HTML source

The **HTML source** tab swaps the rendered document for the HTML behind it — the same render currently in view, reflecting the selected data file and field values. This replaces the need to keep a separate text preview open alongside the HTML preview.

- The source is pretty-printed for readability: block elements are indented one per line, while inline content and the bodies of `pre`/`textarea`/`script`/`style` are left untouched, so the markup shown renders identically to the original.
- The source is syntax-highlighted like the built-in editor: colours follow VS Code's default light/dark themes, and the code is displayed in your editor's font on the editor background.
- Switching views keeps your place: the view you enter is scrolled to the same content you were looking at in the view you left, in both directions.
- Robust against imperfect template output — stray closing tags or unclosed elements in the rendered HTML cannot break the toggle or the preview's own UI.

#### SelectPdf pages

Reporter's documents become PDFs through [SelectPdf](https://selectpdf.com/), and the PDF is split into pages the preview doesn't show. The **PDF preview** tab shows the document as SelectPdf will page it: numbered sheets, with each page ending where SelectPdf's would. Use it to see a heading left alone at the foot of a page, a table split across pages, or a forced page break that lands badly, without running a conversion.

It works the way SelectPdf.Universal does, which lays the page out in Chromium (the browser VS Code is built on):

- The document is laid out in a window `webPageWidth` px wide (1024 by default) and scaled so that width fills the page between the margins. The toolbar shows the scale: `A4 portrait · 1024px at 78%`.
- Pages end where Chromium ends them when it prints: at a forced break (`break-before`/`break-after: page`, `page-break-*: always`, nested ones too), otherwise at the last place that fits between blocks, table rows or lines of text. A line is never cut. A table row that doesn't fit is broken inside, each cell between its own lines, as Chromium breaks it; add `tr { break-inside: avoid }` to keep rows whole. Places inside `break-inside: avoid`, next to `break-after: avoid`, or that would leave fewer than `orphans`/`widows` lines are passed over unless nothing else fits. Something that can't break (an image) and is taller than a page is cut.
- With `cssMediaType` set to `Print`, `@media print` styles apply, and a table's `thead` (`display: table-header-group`) repeats at the top of each page the table continues onto.
- Header and footer bands, when on, take their height off every page and are marked on the sheets. What goes in them is set in code and isn't drawn.
- The last page is shortened to where the content ends, as SelectPdf's `AllowContentHeightResize` does unless it's turned off.

Set the page to match the code that converts your documents, using the `reporterLiquidPreview.selectPdf.*` settings ([below](#settings-and-shortcuts)). They are named after the `HtmlToPdfOptions` they mirror: `PdfPageSize`, `PdfPageOrientation`, `MarginTop`…, `WebPageWidth`, `CssMediaType`, `FitWideContent`, `AllowContentHeightResize`, `CustomCSS`, and the header and footer heights. The margins default to 0: set them to whatever your conversion sets.

It's a close match, not an exact one. When it was built it was checked against Chromium's own print-to-PDF at the same scale. Page breaks matched word for word, except where a paragraph wrapped differently: Chromium measures text slightly differently when it prints, so a long paragraph can now and then wrap one word differently and move a break by a line. Some other things to know:

- Fonts are the ones on *your* machine. If the server converting the documents doesn't have a font (Arial on a Linux server, say), SelectPdf uses another and the text wraps differently. The Liberation fonts have the same widths as Arial, Times New Roman and Courier New.
- The classic Windows SelectPdf library (`Select.Pdf`) pages with WebKit by default, not Chromium, and can break pages differently.
- A grid, or a flex row taller than a page, is cut at the page end rather than broken inside.
- With print media, a row of a table whose header repeats is moved to the next page whole rather than broken inside.
- Images and stylesheets are loaded from where the preview loads them, not from the base URL your conversion passes.
- Scripts don't run (see above). SelectPdf runs them unless `JavaScriptEnabled` is off, so anything a script adds to the page isn't paged here.
- Only the sheets near the part of the panel in view are loaded, so a sheet can be blank for a moment when you scroll a long way.

To check a template against the real thing, convert it with the same data through SelectPdf and compare where the pages end.

### Template Spec (Full HTML Preview)

The template written out for the people who own the document, to check it does what it should and to ask for changes clearly. It needs no data: nothing is run. Every part of the document that can vary is shown once, in place, with a reference and what decides it in plain words, so an owner can write "R12.2 should also apply to DC pensions" and nobody has to guess what they meant.

- `ctrl+k f`, or **Reporter Liquid: Open Template Spec (Full HTML Preview) to the Side**, shows it beside the template and keeps it up to date as you type. Click a reference to go to its line.
- **Export to share or print…** (in the panel, or **Reporter Liquid: Export Template Spec to Share or Print** from the command palette or the editor's right-click menu) saves it as a single `.html` file with the template's stylesheets included. Open it in a browser and print it or save it as a PDF, then mark the PDF up.

What it contains, in this order (each section starts a new page when printed):

1. **A cover**: the template's name; its **version**, as the template sets it for itself (`{% assign SRVersion = "4.12" %}`, or `NALVersion`, `CTPVersion`: any document code in capitals followed by `Version`, set with `assign` or `capture`); a **fingerprint** of the template's text, which changes with any edit, so a spec of a template edited without a new version can still be told apart; a summary of what varies, a key, and contents taken from the document's `h1`–`h3` headings.
2. **The document**, as it looks with your stylesheets, with each part that varies marked:

| Reference | What it is | Comes from |
|-----------|------------|------------|
| **R**4, R4.1, R4.2 … | A rule: shown automatically when the case data meets the condition. Each branch has its own reference. | `if` / `elsif` / `else`, `unless`, `case` / `when` |
| **L**2 | A repeat: shown once for each item in a list, and its "when there are none" part. | `for`, `tablerow` |
| **C**1.1, C1.2 … | A choice: the adviser picks one option. | `choice` / `or` |
| **O**3 | Optional: the adviser ticks to include it. | `optional` |
| **E**1 | A fill-in: the adviser types it. | `editor` |
| **V**5 | A worked-out value (see 4). | `assign`, `capture` |

   A part made of whole paragraphs is marked by a coloured rail in the margin with its reference and condition. Alternatives inside a sentence are bracketed in it, as in "meeting with [R3.1 her / R3.2 him]", so the sentence stays a sentence. Rows of a table that come and go are labelled by rows of their own, and cells by a mark in the cell, so nothing is pushed out of its table. Values from the case data are shown as grey chips in plain words (`{{ client.pensions.size }}` is "the number of client pensions").
3. **A checklist of every reference**, in order, with what decides it, the text it shows, the Liquid and line it comes from, and a column to tick and comment in. Rules that only work out values, and show nothing themselves, are left out of the document but listed here.
4. **How values are worked out**: each value the template sets with `assign` or `capture` and then uses to decide something, or shows, with every place it's set and the conditions it's set under. For example: *has DB* is "set to false: always", then "set to true when: L1 repeats for each pension in client pensions › R2 shown when pension type is "DB"". A condition that reads such a value links to it.

Things to know:
- **References are numbered in order** in each version. Adding a rule renumbers those after it, which is why the cover carries the version and fingerprint.
- **Liquid inside an HTML tag** (a class or style set by a condition) is left out: it changes how something looks, not what it says. A rule inside `<style>` is listed in the checklist as changing the styling.
- **A missing end tag** is marked "Not closed" where the block starts, counted on the cover, and located in the problems pane.
- **Author notes** (`{% comment %}`) are shown where they are, but don't count as something the reader sees: a block that holds only notes and logic is left out of the document, and its notes are listed against it in the checklist. Two or more notes in a row, with nothing shown between them, collapse into one line ("3 author notes") that opens to show them. A note between a table's rows or cells is shown at the top of the next cell, since nothing else can go there. **Hide author notes** in the toolbar hides them all.
- Text inside HTML comments is left out, but Liquid inside them still counts, as it does in Reporter.

### Data files

A preview, and **Create Tests from Data Files…**, ask which `.json` file is the data. In a repository with a lot of `.json`, most of what's offered isn't crawl results, so two settings narrow the list. Neither is needed: with neither set, every `.json` that could be data is offered, as before. `package.json`, `tsconfig.json`, test suites (`*.liquidtest.json`), `node_modules` and `.vscode` are never offered.

**Where data lives**, `reporterLiquidPreview.dataFolders`: a list of folders or globs, from the workspace folder.

```json
{
  "reporterLiquidPreview.dataFolders": ["crawl-results", "samples/**/crawl-*.json"]
}
```

A folder is everything in it, at that path from the workspace folder; `**/crawl-results` finds it at any depth. Anything ending `.json` is a glob for files. Nothing outside these is offered. If they match nothing, you're told, with a link to the setting.

**Which data goes with which template**, `reporterLiquidPreview.dataLinks`: a list of templates and the data files they're used with.

```json
{
  "reporterLiquidPreview.dataLinks": [
    { "template": "non-advised-letter.liquid", "data": "NAL-*.json" },
    { "template": "letters/*.liquid", "data": ["AL-*.json", "NAS-*.json"] }
  ]
}
```

A template with a link is offered only the data files it names, and a last entry, **Show all data files…**, for when you want something else. That way a pattern that's a letter out can't hide the file you want with nothing to say why. A template matched by several entries is offered all of them. A template with no link, or whose link matches no file (the pick says so), is offered everything the folders allow. Linked files are always among those the folders allow.

Patterns are globs on a path from the workspace folder, using `/` whatever the system, and capitals don't matter: `*` is anything but a `/`, `**` anything including one, `?` one character, `{a,b}` either. **A pattern with no `/` is a name and matches in any folder**: `NAL-*.json` is every file so named, wherever it is, and `non-advised-letter.liquid` is that template wherever it is. One with a `/` starts at the workspace folder.

To share these with the people you work with, put them in the repository's `.vscode/settings.json`, so everyone has them. Both can also be set in your own user settings.

### CSS Loading

The HTML preview automatically injects stylesheets so the output matches your intended design:

- **`universal.css`** — any file with this name found at the root of your workspace folders is injected into every preview.
- **`css/` folder** — all `.css` files inside a `css/` directory that sits alongside the active template file are injected.

Open previews pick up a change to these files when it is saved.

The template spec's export inlines the contents of these same files.

### Custom Liquid Tags

Reporter's own tags, rendered as Reporter renders them. Each takes a field name, quoted (`"notes"`) or as a variable holding it: one from the data, or one the template sets, with `assign`, `capture` or as a loop's item (`{% choice protectionName %}`, `{% choice provision.urn %}`), so a field can be named per item in a loop. A name that comes out empty is warned about in the [Problems panel](#problems-panel): an unnamed field can't be answered, and a choice's options wouldn't clear each other. In Reporter, the reader's answer comes back as `fields.<name>`: the text typed for an `editor`, the option's number from `0` for a `choice`, and `true` or `false` for an `optional`. Until a field is answered it reads as `false`, `0`, or an editor's starting text (nothing, if it has none). To preview an answer, give it in the HTML preview's [Edit tab](#the-tabs-edit-pdf-preview-html-source); to keep one, or to test it, put it under `fields` in the data, e.g. `{ "fields": { "includeNotes": "true", "delivery": "1" } }`. The answers are text, so compare them as text: `{% if fields.delivery == "1" %}`.

| Tag | Renders | Options and answer |
|-----|---------|--------------------|
| `{% optional "name", title: "…" %}…{% endoptional %}` | Its contents with a tick box, under an optional `title`. | Ticked when `fields.name` is `"true"`. |
| `{% editor "name", title: "…", placeholder: "…" %}…{% endeditor %}` | A text box, or a text area with `lines` over 1, under an optional `title`. What's between the tags is the box's **starting text**: already in the box, for the adviser to keep or change, and the field's value (and what goes to the PDF) until they do. It can use data (`{{ client.name }}`), and is trimmed, so laying the tag out over lines adds no line break. The `placeholder` is different: greyed-out text in an empty box, such as "Type here", never part of what's typed. | `title`, `placeholder`, `lines` (1), `maxlength` (100), `minlength` (0). Its value is `fields.name`. |
| `{% choice "name", title: "…" %}…{% or %}…{% endchoice %}` | Options separated by `{% or %}`, as radio buttons, under an optional `title`. | `fields.name` is the chosen option's number, from `"0"` for the first (the default). |

A `title` is a heading for the adviser, shown above the field while it's being answered, as Reporter shows it. Like the tick boxes, radio buttons and text boxes, it isn't part of the finished document. Only a written value is read: `title: "…"`, not a variable or a filter.

Each field name should be used once per template; the [Problems panel](#problems-panel) flags a repeat. A name from a variable is checked by the value it takes as the template runs, so a clash between it and another field is caught, and so is a loop that gives every item's field the same name, or items in the data that give the same one. It only sees what the data renders: a clash in a branch the data doesn't reach, or with values it doesn't have, shows with data that reaches it. [Template tests](#template-tests) over a few data files check each of them, and fail on a duplicate.

Beyond those, `{% echo value | filter %}` is accepted as `{{ value | filter }}`. Reporter accepts it, but the engine behind the preview only gained the tag in a later version, so the extension supplies it. Values, filters and their warnings behave as they do in `{{ }}`, and the template spec shows it as a data value.

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
- **An error inside a block** (an `if`, a `for`, an `optional`...) is located at the error itself, not at the block's opening tag, however many blocks deep it is.
- Warnings raised inside a filter are traced back to the `{{ ... }}` or `{% ... %}` that ran it — including filters called from inside a loop or a nested tag, which have no way to name their own position otherwise.
- **Duplicate field names** point at the repeat and name the line it collides with, rather than just listing the names. A name from a variable says which variable, and one tag repeated by a loop is said to be that, with what to change.
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
- **Closing as you type**: VS Code closes a tag as you open it, so `{%-` gives `{%- %}` and `{{` gives `{{ }}` (it's VS Code's own auto-closing, the `editor.autoClosingBrackets` setting, so it works at any typing speed). Typing the closing `%}` yourself works too: the extra one VS Code added is removed a moment after you stop typing. Starting a block tag (`{%- if `) adds its end tag then, unless the template already closes it: type the condition, then press Tab to go between the tags. For `optional`, `editor` and `choice` that's the indented line between them. Typing an element's `>` adds its closing tag. `reporterLiquidPreview.autoClose` turns off what the extension adds: end tags, removing the extra `%}`, and closing HTML tags. Backspace right after `{%` removes only the `%`, as VS Code does with a pair of several characters.
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
npx github:DGBooth/vscode-reporter-liquid-preview#v1.14.0 [options] [paths...]
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
- run: npx --yes github:DGBooth/vscode-reporter-liquid-preview#v1.14.0 --report liquid-test-report.html --junit liquid-tests.xml
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
| `reporterLiquidPreview.dataFolders` | none | Where data files are kept: the only places [data files](#data-files) are looked for. |
| `reporterLiquidPreview.dataLinks` | none | Which data files go with which template, by name. |
| `reporterLiquidPreview.autoClose` | on | Closing as you type in `.liquid` files: the `%}` after `{%-`, block end tags, HTML closing tags. |
| `reporterLiquidPreview.format.printWidth` | 120 | Where Format Document wraps lines. |
| `reporterLiquidPreview.checkForUpdates` | on | The daily check for a new release. |
| `reporterLiquidPreview.selectPdf.pageSize` | `A4` | [SelectPdf pages](#selectpdf-pages): `PdfPageSize`. `customPageSize` (`{ "width", "height" }` in points) overrides it. |
| `reporterLiquidPreview.selectPdf.orientation` | `Portrait` | `PdfPageOrientation`. |
| `reporterLiquidPreview.selectPdf.marginTop`, `…Right`, `…Bottom`, `…Left` | 0 | `MarginTop` and the rest, in points. |
| `reporterLiquidPreview.selectPdf.webPageWidth` | 1024 | `WebPageWidth`: the width in px the document is laid out at. |
| `reporterLiquidPreview.selectPdf.cssMediaType` | `Screen` | `CssMediaType`. |
| `reporterLiquidPreview.selectPdf.fitWideContent` | off | `FitWideContent`. |
| `reporterLiquidPreview.selectPdf.allowContentHeightResize` | on | `AllowContentHeightResize`: a short last page. |
| `reporterLiquidPreview.selectPdf.customCss` | none | `CustomCSS`. |
| `reporterLiquidPreview.selectPdf.header`, `…footer` | none | `{ "display": true, "height": 50 }` in points, plus `displayOnFirstPage`, `displayOnOddPages`, `displayOnEvenPages`. |

| Shortcut (in a `.liquid` file) | |
|----------|--|
| `ctrl+k h` | HTML preview |
| `ctrl+k v` | Plain-text preview |
| `ctrl+k f` | Template spec (Full HTML Preview) |
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
| `spec.js` | The template spec: the template read into blocks, numbered, described in words, and written out as a page to print. |
| `extension.js` | The previews, the problems panel, template tests in the editor (report, Testing view, creating and editing tests), updates. |
| `template-tests.js` | Suites: reading them, running cases, the report, editing a suite in place. |
| `output-checks.js` | Checks: parsing the output as a browser would, selectors and row labels, accepting and relocating. |
| `webview/test-builder.js` | The point-and-click test builder in the HTML preview. |
| `selectpdf-page.js` | The SelectPdf page from the settings: size, margins, scale. |
| `webview/selectpdf-pages.js` | The SelectPdf pages view: lays the document out, finds where each page ends, and draws the sheets. |
| `formatter.js` | Format Document: the layout, the `{%-` house style, and the before/after rendering check. |
| `editing.js` | Completions and closing as you type. |
| `authoring.js` | Both of those as VS Code providers, and the HTML language service. |
| `syntaxes/`, `language-configuration.json` | Colouring, brackets and indentation for `.liquid` files. |
| `data-files.js` | Which `.json` files are offered as data: the `dataFolders` and `dataLinks` matching. |
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
