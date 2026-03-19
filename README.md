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

### CSS Loading

The HTML preview automatically injects stylesheets so the output matches your intended design:

- **`universal.css`** — any file with this name found at the root of your workspace folders is injected into every preview.
- **`css/` folder** — all `.css` files inside a `css/` directory that sits alongside the active template file are injected.

### Custom Liquid Tags

The extension registers several Reporter-specific Liquid tags beyond the standard set:

| Tag | Description |
|-----|-------------|
| `{% optional %}…{% endoptional %}` | Marks optional content. In preview the inner content is rendered as-is. |
| `{% editor %}…{% endeditor %}` | Marks an editable region. In preview the default text between the tags is shown. |
| `{% choice %}…{% or %}…{% endchoice %}` | Defines multiple alternatives separated by `{% or %}`. The preview renders the first alternative. |

### Status Bar Indicators

Two status bar items show the health of the active preview at a glance:

- **Template** — shows a check or error icon reflecting the last template parse attempt.
- **Data** — shows a check or error icon reflecting the last JSON data parse attempt.

## Usage

1. Open a `.liquid` file.
2. Press `ctrl+k h` to open the HTML preview (or `ctrl+k v` for the plain-text preview).
3. Select a `.json` data file when prompted.
4. Edit your template or data file — the preview updates automatically.

## Credits

This extension is based on [Shopify Liquid Preview for Visual Studio Code](https://github.com/kirchner-trevor/vscode-shopify-liquid-preview) by [kirchner-trevor](https://github.com/kirchner-trevor), which was itself inspired by:

- [Handlebars Preview for Visual Studio Code](https://github.com/chaliy/vscode-handlebars-preview/)
- [A HTML previewer for Visual Studio Code](https://marketplace.visualstudio.com/items?itemName=tht13.html-preview-vscode)

New functionality added for Reporter includes the HTML webview preview, automatic CSS injection, custom Reporter Liquid tag support (`optional`, `editor`, `choice`), and status bar indicators.

## License

MIT
