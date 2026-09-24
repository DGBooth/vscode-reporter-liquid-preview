# Changelog

Every release of Reporter Liquid Preview. Merging a version bump into `main`
tags it `v<version>` and publishes a GitHub release with the `.vsix` and this
version's notes (see [Releasing](README.md#releasing)).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions before 1.2.0 were written up from the commit history after the fact.
Their tags were added then too: each marks the commit that built the final
`.vsix` published under that version number, and its notes describe that
build. Early versions were sometimes rebuilt with new changes after the
version bump, so a version can include work committed before its bump.

## [1.5.1] - 2026-09-24

### Fixed
- The test builder's closed panel no longer covers the right of the HTML preview. In 1.5.0 it still took its 340px, showing as a black bar in dark themes over the page and the **Create test…** button.
- The builder panel's text follows the theme's panel colours, so it can't end up dark on dark.

## [1.5.0] - 2026-09-24

### Added
- Checks: small, named tests within a case. Each targets part of the output with a CSS selector and checks its text, how many elements match, whether any exist, what their text contains, or their attributes. Each passes or fails on its own, with a message saying what was found. Checks appear in the report, as children of their case in the Testing view, and as separate JUnit test cases from `liquid-test`.
- The output is parsed with parse5, following the same HTML rules as browsers and in the same place the preview puts it (inside a `<div>`), so selectors see the structure the preview shows. The parser only loads when a case has checks.
- **Create test…** in the HTML preview opens a test builder: click part of the page and choose what should be true about it in plain words ("It reads exactly…", "There are 3 of these", "It is ticked"). The builder writes the checks, preferring stable names such as Reporter's field ids over positions. Before saving it re-renders the page and runs every check, and refuses to save any that don't pass. A whole-page snapshot is an option rather than the default.

### Changed
- **Create test…** replaces **Save as test…**, which could only save a whole-page snapshot. The builder offers the same snapshot as an option.
- Several tests can now be built from the same data file.

## [1.4.0] - 2026-09-23

### Added
- `liquid-test`, a command-line runner for template tests, for CI. It runs the same suites through the same engine as the editor. It writes an HTML report (`--report`) and JUnit XML (`--junit`), and can accept actual output (`--update`). It exits non-zero on any failure, and also when it finds no suites.

### Changed
- The rendering engine moved from `extension.js` into `engine.js`, which doesn't depend on VS Code, so the editor and the runner can't drift apart.

## [1.3.0] - 2026-09-23

### Added
- **Save as test…** in the HTML preview toolbar turns the template and data file on screen into a test case, with the output shown as its expected output.
- **Reporter Liquid: Create Tests from Data Files…** (also on the right-click menu of `.liquid` files) makes one test case per chosen data file.
- Before anything is saved, cases that fail to render or repeat a field name are left out. Output with filter warnings is only kept if you allow warnings for it. Unsaved template or data edits are saved first.

## [1.2.0] - 2026-09-23

### Added
- Template tests: `*.liquidtest.json` suites render templates against known data and check the output against an expected file, text it must or must not contain, and any problems the preview would report.
- **Reporter Liquid: Run Template Tests** and a report panel: result per case, line diffs, clickable locations, a failures-only filter, and **Save report…** as standalone HTML.
- **Accept Actual Output as Expected** to create or update expected files.
- Suites and cases appear in VS Code's Testing view on VS Code 1.59 or newer, with a diff view for changed output.
- Completion and validation in `*.liquidtest.json` files.

### Fixed
- Renders now run one at a time, so two previews (or a preview and a test run) can't record each other's warnings.

## [1.1.20] - 2026-09-03

### Added
- `npm run check:package` checks that the committed `.vsix` is built from the source.

## [1.1.19] - 2026-09-03

### Added
- A test suite for the preview and its problems panel, run on every push.

## [1.1.18] - 2026-09-03

### Changed
- Every problem in the preview says where it is: a clickable file, line and column, and the offending source. The same problems appear in VS Code's Problems panel and as squiggles in the editor.

## [1.1.17] - 2026-09-03

### Fixed
- An unbalanced block no longer swallows the rest of the document in the Full HTML Preview.

## [1.1.16] - 2026-07-14

### Changed
- `markdownify` output has its outer margins trimmed, to match Reporter.

## [1.1.15] - 2026-07-14

### Added
- `markdownify` filter.

## [1.1.14] - 2026-07-09

### Changed
- `json` filter output is pretty-printed by default.

## [1.1.13] - 2026-07-09

### Added
- `json` filter, matching the LiquidJS built-in.

## [1.1.12] - 2026-07-03

### Changed
- README covers the new preview features, and the package is slimmer.

## [1.1.11] - 2026-07-03

### Changed
- The HTML source views are rendered like the VS Code editor.

## [1.1.10] - 2026-07-03

### Changed
- The preview toolbar floats, and scroll position is kept in sync across views.

## [1.1.9] - 2026-07-03

### Fixed
- Malformed template HTML can no longer break the preview's own UI.

## [1.1.8] - 2026-07-03

### Changed
- The HTML source views are pretty-printed.

## [1.1.7] - 2026-07-03

### Changed
- Edits patch the preview in place instead of reloading it.

## [1.1.6] - 2026-07-03

### Changed
- The HTML source view follows VS Code's dark or light theme.

## [1.1.5] - 2026-07-03

### Changed
- Preview panels stay alive when their tab is hidden.

## [1.1.4] - 2026-07-03

### Added
- **Show HTML source** toggle in the regular HTML preview.

## [1.1.3] - 2026-07-03

### Added
- **Show HTML source** toggle in the Full HTML Preview, for publishing the output elsewhere.

## [1.1.2] - 2026-07-03

### Added
- A toggle to hide author notes in the Full HTML Preview.

## [1.1.1] - 2026-07-03

### Changed
- Logic-only blocks are hidden from the Full HTML Preview.

## [1.1.0] - 2026-07-02

### Changed
- The Full HTML Preview is rewritten as a readable view of the document's options.

## [1.0.7] - 2026-06-09

### Fixed
- Packaging no longer drops liquidjs from the extension. Without it, activation failed and every command reported "command not found". Earlier builds had to be rebuilt by hand to include it.

## [1.0.6] - 2026-06-09

### Added
- `sort` and `sort_natural` overrides with null-safe sorting and property-key support.

### Changed
- Unchecked optional blocks and unselected choices are shown again (reverts 1.0.5).

## [1.0.5] - 2026-04-30

### Changed
- Unchecked optional blocks and unselected choices are hidden, to match Reporter.

## [1.0.4] - 2026-04-28

### Changed
- Warnings are grouped under one header, with clearer messages.

## [1.0.3] - 2026-04-28

### Changed
- `where` on a missing variable is a warning, not a blocking error.

## [1.0.2] - 2026-04-28

### Changed
- `slice` on a missing variable is a warning, not a blocking error.

### Fixed
- The package includes liquidjs, which the extension needs to run.

## [1.0.1] - 2026-04-27

### Changed
- No changes from the final 1.0.0 build; the same code under a new version number.

## [1.0.0] - 2026-04-23

### Added
- Duplicate field name detection in the HTML preview.
- Styling for editor, optional and choice output in the HTML preview, with each choice option boxed.

### Fixed
- `money` adds comma separators to numbers of 1,000 or more.

## [0.9.0] - 2026-03-24

### Added
- First release as Reporter Liquid Preview.
- HTML preview in a webview. Errors are shown in a pane below the last successful render.
- Full HTML Preview: the template with its CSS, and Liquid constructs shown as styled boxes, including the `optional`, `editor` and `choice` tags.
- `money` filter.
