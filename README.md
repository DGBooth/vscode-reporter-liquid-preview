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
| `slice` | Overrides the built-in to warn instead of erroring when the value is missing. |
| `where` | Overrides the built-in to warn instead of erroring when the array is missing. |
| `sort` | Overrides the built-in with null-safe sorting and property-key support. |
| `sort_natural` | Overrides the built-in with null-safe, case-insensitive sorting and property-key support. |

### Status Bar Indicators

Two status bar items show the health of the active preview at a glance:

- **Template** — shows a check or error icon reflecting the last template parse attempt.
- **Data** — shows a check or error icon reflecting the last JSON data parse attempt.

### Error Display

Parse and render errors are shown in a fixed panel at the bottom of the preview webview, so the last successfully rendered output stays visible while the error details are reported. The panel also reports warnings from the null-tolerant filters and flags field names used more than once in a template.

## Usage

1. Open a `.liquid` file.
2. Press `ctrl+k h` to open the HTML preview (or `ctrl+k v` for the plain-text preview, or `ctrl+k f` for the Full HTML Preview).
3. Select a `.json` data file when prompted (not required for Full HTML Preview).
4. Edit your template or data file — the preview updates automatically.

## Credits

This extension is based on [Shopify Liquid Preview for Visual Studio Code](https://github.com/kirchner-trevor/vscode-shopify-liquid-preview) by [kirchner-trevor](https://github.com/kirchner-trevor), which was itself inspired by:

- [Handlebars Preview for Visual Studio Code](https://github.com/chaliy/vscode-handlebars-preview/)
- [A HTML previewer for Visual Studio Code](https://marketplace.visualstudio.com/items?itemName=tht13.html-preview-vscode)

New functionality added for Reporter includes the HTML webview preview, Full HTML Preview with annotated Liquid tag visualisation and standalone HTML export, in-preview HTML source views with formatting and syntax highlighting, automatic CSS injection, custom Reporter Liquid tag support (`optional`, `editor`, `choice`), custom filters, error display, and status bar indicators.

## License

MIT
