// Template tests: render a template against known data and check the output.
//
// A suite is a `*.liquidtest.json` file listing cases — a template, the data to
// render it with, and what the output must look like. This module parses those
// files, runs the cases and builds the HTML report. It never touches `vscode`:
// everything that reaches the editor (reading files, rendering, pretty-printing
// HTML) is passed in by extension.js, so the whole thing runs under plain Node
// and the test suite can drive it directly.

const path = require('path');
const { parseChecks, runChecks, CHECK_KEYS } = require('./output-checks');

const SUITE_GLOB = '**/*.liquidtest.json';
const WHITESPACE_MODES = ['exact', 'collapse'];

// ---- suites -----------------------------------------------------------------

// Parse a suite file into cases with every path resolved against the suite's
// own folder. Problems with the suite as a whole (bad JSON, no cases) come back
// in `error`; problems with one case are recorded on that case so the rest of
// the suite still runs.
function parseSuite(text, suiteFile) {
    const suite = { file: suiteFile, error: null, cases: [] };
    const dir = path.dirname(suiteFile);
    const resolve = p => path.resolve(dir, p);

    let json;
    try {
        json = JSON.parse(text);
    } catch (err) {
        suite.error = `Not valid JSON: ${err.message}`;
        return suite;
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.cases)) {
        suite.error = 'A suite needs a "cases" array.';
        return suite;
    }

    const defaults = {
        template: typeof json.template === 'string' ? json.template : null,
        whitespace: json.whitespace,
        allowWarnings: json.allowWarnings
    };
    const seen = new Map();

    json.cases.forEach((raw, index) => {
        const c = raw && typeof raw === 'object' ? raw : {};
        let name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : `case ${index + 1}`;
        // Names identify a case in the Test Explorer and the report, so a repeat
        // is made unique rather than letting one case shadow the other.
        const count = (seen.get(name) || 0) + 1;
        seen.set(name, count);
        if (count > 1) name = `${name} (${count})`;

        const template = typeof c.template === 'string' ? c.template : defaults.template;
        const whitespace = c.whitespace !== undefined ? c.whitespace : (defaults.whitespace !== undefined ? defaults.whitespace : 'exact');
        const allowWarnings = c.allowWarnings !== undefined ? c.allowWarnings : Boolean(defaults.allowWarnings);

        const line = lineOfCase(text, c.name, index);
        const parsedChecks = parseChecks(c.checks, checkName => lineOfName(text, checkName, line));
        const testCase = {
            name,
            index,
            suiteFile,
            line,
            template: template ? resolve(template) : null,
            dataFile: typeof c.data === 'string' ? resolve(c.data) : null,
            data: c.data && typeof c.data === 'object' ? c.data : null,
            expected: typeof c.expected === 'string' ? resolve(c.expected) : null,
            contains: toStringList(c.contains),
            notContains: toStringList(c.notContains),
            whitespace,
            allowWarnings: Boolean(allowWarnings),
            checks: parsedChecks.checks,
            error: parsedChecks.error
        };

        if (testCase.error) { /* already set: the checks list is malformed */ }
        else if (!template) testCase.error = 'No template: set "template" on the case or at the top of the suite.';
        else if (!WHITESPACE_MODES.includes(whitespace)) testCase.error = `"whitespace" must be one of ${WHITESPACE_MODES.map(m => `"${m}"`).join(', ')}.`;
        else if (c.data !== undefined && c.data !== null && typeof c.data !== 'string' && typeof c.data !== 'object') testCase.error = '"data" must be a path to a .json file or an inline object.';

        suite.cases.push(testCase);
    });

    if (suite.cases.length === 0) suite.error = 'The suite has no cases.';
    return suite;
}

function toStringList(value) {
    if (value === undefined || value === null) return [];
    return (Array.isArray(value) ? value : [value]).map(String);
}

// The 1-based line a case starts on in its suite file, so the Test Explorer and
// the report can send the reader to it. Found by the case's "name" when it has
// one, which is what a reader recognises; otherwise the suite's first line.
function lineOfCase(text, name, index) {
    if (typeof name === 'string') {
        const pattern = new RegExp(`"name"\\s*:\\s*${escapeRegExp(JSON.stringify(name))}`);
        const match = pattern.exec(text);
        if (match) return text.slice(0, match.index).split('\n').length;
    }
    return 1;
}

// The 1-based line of the first `"name": <name>` at or after line `from` —
// where a check sits inside its case — or null if it can't be found.
function lineOfName(text, name, from) {
    if (typeof name !== 'string') return null;
    const offset = text.split('\n').slice(0, Math.max(0, from - 1)).join('\n').length;
    const pattern = new RegExp(`"name"\\s*:\\s*${escapeRegExp(JSON.stringify(name))}`, 'g');
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    return match ? text.slice(0, match.index).split('\n').length : null;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- running ------------------------------------------------------------------

// Run one case. `deps` supplies the editor-facing pieces:
//
//   readText(file)                  → Promise<string>, rejects if missing
//   render(text, data, templateFile)→ Promise<{ html, diagnostics }>; html is
//                                     null when the template failed to parse or
//                                     render, with the error among diagnostics
//
// The result says whether the case passed and, if not, every reason why — a
// case that fails its expected output and also warns reports both, so fixing
// one doesn't reveal the other on the next run.
async function runCase(testCase, deps) {
    const started = Date.now();
    const result = {
        name: testCase.name,
        index: testCase.index,
        suiteFile: testCase.suiteFile,
        line: testCase.line,
        template: testCase.template,
        dataFile: testCase.dataFile,
        expectedFile: testCase.expected,
        status: 'passed',
        failures: [],
        diagnostics: [],
        actual: null,
        expected: null,
        checks: [],
        durationMs: 0
    };
    const finish = status => {
        if (status) result.status = status;
        result.durationMs = Date.now() - started;
        return result;
    };
    const error = (message, extra) => {
        result.failures.push(Object.assign({ kind: 'error', message }, extra));
        // Checks need output to look at; say so rather than dropping them.
        result.checks = (testCase.checks || []).map(check => ({
            name: check.name, line: check.line, status: 'skipped', failures: ['Not run: the case did not render.']
        }));
        return finish('error');
    };

    if (testCase.error) return error(testCase.error, { file: testCase.suiteFile, line: testCase.line });

    let templateText;
    try {
        templateText = await deps.readText(testCase.template);
    } catch (err) {
        return error(`Cannot read the template ${path.basename(testCase.template)}: ${err.message}`, { file: testCase.suiteFile, line: testCase.line });
    }

    let data = testCase.data || {};
    if (testCase.dataFile) {
        let dataText;
        try {
            dataText = await deps.readText(testCase.dataFile);
        } catch (err) {
            return error(`Cannot read the data file ${path.basename(testCase.dataFile)}: ${err.message}`, { file: testCase.suiteFile, line: testCase.line });
        }
        try {
            data = JSON.parse(dataText);
        } catch (err) {
            return error(`The data file ${path.basename(testCase.dataFile)} is not valid JSON: ${err.message}`, { file: testCase.dataFile, line: 1 });
        }
    }

    const { html, diagnostics } = await deps.render(templateText, data, testCase.template);
    result.diagnostics = diagnostics || [];
    result.actual = html;

    if (html === null || html === undefined) {
        const first = result.diagnostics.find(d => d.severity !== 'warning');
        return error(first ? `${first.title}: ${first.message}` : 'The template failed to render.', first ? { file: first.file, line: first.line } : {});
    }

    // Problems the preview would show. Errors (a duplicate field name) always
    // fail; warnings mean a filter met missing data, which is exactly what a
    // test with known data should catch, so they fail unless allowed.
    const errors = result.diagnostics.filter(d => d.severity !== 'warning');
    const warnings = result.diagnostics.filter(d => d.severity === 'warning');
    for (const d of errors) {
        result.failures.push({ kind: 'problem', message: `${d.title}: ${d.message}`, file: d.file, line: d.line });
    }
    if (!testCase.allowWarnings) {
        for (const d of warnings) {
            result.failures.push({ kind: 'problem', message: `${d.title}: ${d.message}`, file: d.file, line: d.line });
        }
    }

    if (testCase.expected) {
        let expectedText = null;
        try {
            expectedText = await deps.readText(testCase.expected);
        } catch (err) {
            result.failures.push({
                kind: 'missing-expected',
                message: `The expected file ${path.basename(testCase.expected)} does not exist yet. Check the actual output, then accept it to create the file.`,
                file: testCase.expected
            });
        }
        if (expectedText !== null) {
            result.expected = expectedText;
            if (normalize(expectedText, testCase.whitespace) !== normalize(html, testCase.whitespace)) {
                result.failures.push({
                    kind: 'mismatch',
                    message: testCase.whitespace === 'collapse'
                        ? 'The output does not match the expected output (ignoring whitespace).'
                        : 'The output does not match the expected output.',
                    file: testCase.expected,
                    diff: diffOutputs(expectedText, html, deps.format)
                });
            }
        }
    }

    const haystack = testCase.whitespace === 'collapse' ? normalize(html, 'collapse') : html;
    for (const needle of testCase.contains) {
        const n = testCase.whitespace === 'collapse' ? normalize(needle, 'collapse') : needle;
        if (!haystack.includes(n)) result.failures.push({ kind: 'contains', message: `The output should contain: ${needle}` });
    }
    for (const needle of testCase.notContains) {
        const n = testCase.whitespace === 'collapse' ? normalize(needle, 'collapse') : needle;
        if (haystack.includes(n)) result.failures.push({ kind: 'not-contains', message: `The output should not contain: ${needle}` });
    }

    result.checks = runChecks(testCase.checks, html);

    const failed = result.failures.length || result.checks.some(c => c.status === 'failed');
    return finish(failed ? 'failed' : 'passed');
}

// Run a whole suite, or only the cases named in `only`. `isCancelled` is polled
// between cases so a long run can be stopped from the Test Explorer; `onStart`
// and `onResult` let the caller show progress case by case.
async function runSuite(suite, deps, { only = null, isCancelled = () => false, onStart = () => { }, onResult = () => { } } = {}) {
    const results = [];
    if (suite.error) return { file: suite.file, error: suite.error, results };
    for (const testCase of suite.cases) {
        if (only && !only.has(testCase.name)) continue;
        if (isCancelled()) break;
        onStart(testCase);
        const result = await runCase(testCase, deps);
        results.push(result);
        onResult(testCase, result);
    }
    return { file: suite.file, error: null, results };
}

// Totals for the report header.
function summarize(suites) {
    const totals = { passed: 0, failed: 0, error: 0, total: 0, suiteErrors: 0, checks: 0, checksFailed: 0, checksSkipped: 0 };
    for (const suite of suites) {
        if (suite.error) totals.suiteErrors++;
        for (const r of suite.results) {
            totals[r.status]++;
            totals.total++;
            for (const c of r.checks || []) {
                totals.checks++;
                if (c.status === 'failed') totals.checksFailed++;
                if (c.status === 'skipped') totals.checksSkipped++;
            }
        }
    }
    return totals;
}

// Line endings are normalised in every mode: a golden file checked out on
// Windows with autocrlf would otherwise fail every exact comparison. A final
// newline is ignored too, since editors add one on save.
function normalize(text, whitespace) {
    const unified = String(text).replace(/\r\n?/g, '\n');
    if (whitespace === 'collapse') {
        return unified.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
    }
    return unified.replace(/\n+$/, '');
}

// ---- diffing ------------------------------------------------------------------

const DIFF_CONTEXT = 3;
// Beyond this many cells the LCS table costs more than the diff is worth; the
// changed region is shown whole instead.
const DIFF_CELL_LIMIT = 4000000;
// A changed line longer than this is almost certainly HTML rendered onto one
// line, where a line diff says only "everything changed".
const LONG_LINE = 200;

// A readable diff of expected against actual. Templates often render their
// HTML onto a handful of very long lines; when the raw diff would be that, both
// sides are pretty-printed with `format` first so the diff lands on the element
// that changed. If formatting erases the difference, it was whitespace between
// tags, and the raw diff is kept with a note saying so.
function diffOutputs(expected, actual, format) {
    const a = normalize(expected, 'exact');
    const b = normalize(actual, 'exact');
    const raw = diffLines(a, b);
    const longChange = raw.some(l => l.type !== ' ' && l.text.length > LONG_LINE);
    if (longChange && typeof format === 'function') {
        const formatted = diffLines(format(a), format(b));
        if (formatted.some(l => l.type !== ' ')) {
            return { note: 'Both sides were pretty-printed to make the difference readable.', hunks: toHunks(formatted) };
        }
        return { note: 'The outputs differ only in whitespace between tags.', hunks: toHunks(raw) };
    }
    return { note: '', hunks: toHunks(raw) };
}

// Line diff: common prefix and suffix are peeled off, and the changed middle is
// aligned with a longest-common-subsequence table.
function diffLines(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    let start = 0;
    while (start < x.length && start < y.length && x[start] === y[start]) start++;
    let endX = x.length;
    let endY = y.length;
    while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }

    const out = [];
    for (let i = 0; i < start; i++) out.push({ type: ' ', text: x[i] });

    const mx = x.slice(start, endX);
    const my = y.slice(start, endY);
    if (mx.length * my.length > DIFF_CELL_LIMIT) {
        for (const text of mx) out.push({ type: '-', text });
        for (const text of my) out.push({ type: '+', text });
    } else {
        const n = mx.length;
        const m = my.length;
        const table = new Uint32Array((n + 1) * (m + 1));
        const at = (i, j) => i * (m + 1) + j;
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                table[at(i, j)] = mx[i] === my[j]
                    ? table[at(i + 1, j + 1)] + 1
                    : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (mx[i] === my[j]) { out.push({ type: ' ', text: mx[i] }); i++; j++; }
            else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) out.push({ type: '-', text: mx[i++] });
            else out.push({ type: '+', text: my[j++] });
        }
        while (i < n) out.push({ type: '-', text: mx[i++] });
        while (j < m) out.push({ type: '+', text: my[j++] });
    }

    for (let i = endX; i < x.length; i++) out.push({ type: ' ', text: x[i] });
    return out;
}

// Group a line diff into hunks with a few lines of context either side, each
// line numbered on the side(s) it belongs to.
function toHunks(lines) {
    let oldLine = 0;
    let newLine = 0;
    const numbered = lines.map(l => {
        if (l.type !== '+') oldLine++;
        if (l.type !== '-') newLine++;
        return Object.assign({ oldLine: l.type === '+' ? null : oldLine, newLine: l.type === '-' ? null : newLine }, l);
    });

    const keep = new Array(numbered.length).fill(false);
    numbered.forEach((l, i) => {
        if (l.type === ' ') return;
        for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(numbered.length - 1, i + DIFF_CONTEXT); k++) keep[k] = true;
    });

    const hunks = [];
    let current = null;
    numbered.forEach((l, i) => {
        if (!keep[i]) { current = null; return; }
        if (!current) { current = []; hunks.push(current); }
        current.push(l);
    });
    return hunks;
}

// ---- creating cases -----------------------------------------------------------

// Where a template's suite lives unless one is chosen: beside the template,
// named after it.
function defaultSuiteFile(templateFile) {
    return path.join(path.dirname(templateFile), path.basename(templateFile, path.extname(templateFile)) + '.liquidtest.json');
}

// A file-name-safe version of a case name.
function slugify(name) {
    const slug = String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug.slice(0, 60) || 'case';
}

// Suite paths are written relative to the suite with forward slashes, so a
// suite made on Windows still works when checked out elsewhere.
function relativeTo(suiteFile, file) {
    let rel = path.relative(path.dirname(suiteFile), file).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = rel || '.';
    return rel;
}

// Work out what adding cases to a suite involves, without writing anything:
// the suite's new text, and the expected-output files to create.
//
//   suiteFile, suiteText  the suite to add to; suiteText is null if it doesn't
//                         exist yet
//   template              the template the new cases render
//   entries               [{ name, dataFile | data, output, allowWarnings,
//                            checks, snapshot }]
//                         output is the rendered HTML to freeze as expected;
//                         snapshot: false leaves the expected file out, so
//                         the checks are the whole test
//   exists(file)          whether a file is already on disk, so no expected
//                         file is overwritten
//
// A snapshot-only entry whose template and data file an existing case already
// covers is skipped rather than duplicated; an entry with checks is not, since
// several tests with different checks on one data file is the point of them.
// Names are made unique against the suite.
function planNewCases({ suiteFile, suiteText, template, entries, exists = () => false }) {
    let json;
    if (suiteText === null || suiteText === undefined || !suiteText.trim()) {
        json = { template: relativeTo(suiteFile, template), cases: [] };
    } else {
        try {
            json = JSON.parse(suiteText);
        } catch (err) {
            throw new Error(`${path.basename(suiteFile)} is not valid JSON, so cases can't be added to it: ${err.message}`);
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${path.basename(suiteFile)} is not a test suite.`);
        if (!Array.isArray(json.cases)) json.cases = [];
    }

    const dir = path.dirname(suiteFile);
    const suiteTemplate = typeof json.template === 'string' ? path.resolve(dir, json.template) : null;
    const templateOf = c => (typeof c.template === 'string' ? path.resolve(dir, c.template) : suiteTemplate);
    const covered = new Set(json.cases
        .filter(c => c && typeof c.data === 'string')
        .map(c => `${templateOf(c)}\n${path.resolve(dir, c.data)}`));
    const names = new Set(json.cases.map(c => c && c.name).filter(Boolean));
    const claimed = new Set();

    const added = [];
    const skipped = [];
    const writes = [];
    const templateBase = path.basename(template, path.extname(template));

    for (const entry of entries) {
        const hasChecks = Array.isArray(entry.checks) && entry.checks.length > 0;
        const snapshot = entry.snapshot !== false;
        if (!hasChecks && entry.dataFile && covered.has(`${template}\n${entry.dataFile}`)) {
            skipped.push({ name: entry.name, reason: 'a case in the suite already uses this data file' });
            continue;
        }

        let name = entry.name;
        for (let n = 2; names.has(name); n++) name = `${entry.name} (${n})`;
        names.add(name);

        let expected = null;
        if (snapshot) {
            for (let n = 1; ; n++) {
                const candidate = path.join(dir, 'expected', templateBase, `${slugify(name)}${n > 1 ? '-' + n : ''}.html`);
                if (!claimed.has(candidate) && !exists(candidate)) { expected = candidate; break; }
            }
            claimed.add(expected);
        }

        const testCase = { name };
        if (suiteTemplate !== template) testCase.template = relativeTo(suiteFile, template);
        testCase.data = entry.dataFile ? relativeTo(suiteFile, entry.dataFile) : (entry.data || {});
        if (expected) testCase.expected = relativeTo(suiteFile, expected);
        if (entry.allowWarnings) testCase.allowWarnings = true;
        if (hasChecks) testCase.checks = entry.checks.map(tidyCheck);

        json.cases.push(testCase);
        if (expected) writes.push({ file: expected, text: entry.output });
        if (entry.dataFile) covered.add(`${template}\n${entry.dataFile}`);
        added.push(name);
    }

    return { suiteText: JSON.stringify(json, null, 2) + '\n', writes, added, skipped };
}

// Change one case in a suite and hand back the suite's new text. The case is
// found by its position, then confirmed by its name — as parseSuite names it,
// which is what a report or the builder holds — so a suite edited since the
// tests ran can't have the wrong case changed. `mutate(raw)` edits the case's
// JSON in place; every other case, and the suite's own settings, are kept.
function editCase(suiteText, suiteFile, caseIndex, expectedName, mutate) {
    const parsed = parseSuite(suiteText, suiteFile);
    if (parsed.error) throw new Error(`${path.basename(suiteFile)} can't be edited: ${parsed.error}`);
    const found = parsed.cases[caseIndex];
    if (!found || found.name !== expectedName) {
        throw new Error(`${path.basename(suiteFile)} has changed since the tests ran, so \u201c${expectedName}\u201d isn't where it was. Run the tests again, then try once more.`);
    }
    const json = JSON.parse(suiteText);
    mutate(json.cases[caseIndex], found, json);
    return JSON.stringify(json, null, 2) + '\n';
}

// A check as written to a suite: its name and the keys a check understands, in
// a fixed order, and nothing else — whatever built it.
function tidyCheck(check) {
    const out = {};
    for (const key of CHECK_KEYS) {
        if (check[key] !== undefined) out[key] = check[key];
    }
    return out;
}

// ---- the report ---------------------------------------------------------------

const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', error: 'Error' };
const STATUS_ICON = { passed: '&#10003;', failed: '&#10007;', error: '&#9888;' };

// The report as a complete HTML document. The same document is shown in the
// report panel and written out by “Save report”, so it has to stand on its own:
// styles are inline, expanding a case is a <details> element and the failures
// filter is pure CSS. With `interactive` set it also gets the toolbar and the
// script that talks back to the extension — re-run, save, accept output and
// jump-to-file — which only mean something inside VS Code.
//
// `relative(file)` shortens a path for display; the full path stays in the
// title attribute and in the jump-to-file button.
function buildReportHtml(report, { interactive = false, relative = f => f } = {}) {
    const totals = summarize(report.suites);
    const overall = totals.failed || totals.error || totals.suiteErrors ? 'failed' : 'passed';
    const acceptable = acceptableResults(report).length;

    const chips = [
        `<span class="chip chip-passed">${totals.passed} passed</span>`,
        totals.failed ? `<span class="chip chip-failed">${totals.failed} failed</span>` : '',
        totals.error ? `<span class="chip chip-error">${totals.error} ${totals.error === 1 ? 'error' : 'errors'}</span>` : '',
        totals.suiteErrors ? `<span class="chip chip-error">${totals.suiteErrors} broken ${totals.suiteErrors === 1 ? 'suite' : 'suites'}</span>` : ''
    ].join('');

    const toolbar = interactive
        ? `<div class="toolbar">
  <button type="button" data-action="rerun">Re-run</button>
  <button type="button" data-action="save">Save report&hellip;</button>
  ${acceptable ? `<button type="button" data-action="accept" title="Write the actual output of every case whose expected output is missing or different to its expected file">Accept actual output (${acceptable})</button>` : ''}
</div>`
        : '';

    const body = report.suites.length
        ? report.suites.map(s => buildSuiteHtml(s, relative, interactive)).join('\n')
        : `<p class="empty">No test suites found. Add a <code>*.liquidtest.json</code> file to the workspace — see the README for the format.</p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Liquid template test report</title>
<style>${REPORT_STYLES}</style>
</head>
<body>
<header class="head head-${overall}">
  <h1>${overall === 'passed' ? 'All template tests passed' : 'Template tests failed'}</h1>
  <div class="meta">${totals.total} ${totals.total === 1 ? 'case' : 'cases'}${totals.checks ? ` (${totals.checks} ${totals.checks === 1 ? 'check' : 'checks'}${totals.checksFailed ? `, ${totals.checksFailed} failing` : ''})` : ''} in ${report.suites.length} ${report.suites.length === 1 ? 'suite' : 'suites'} &middot; ${escapeHtml(formatDuration(report.durationMs))} &middot; ${escapeHtml(new Date(report.startedAt).toLocaleString())}</div>
  <div class="chips">${chips}</div>
  <label class="filter" title="Hide the cases and suites that passed. A failing case still shows all its checks, passed ones included."><input type="checkbox" id="only-failures"> Show failures only</label>
  ${toolbar}
</header>
<main>
${body}
</main>
${interactive ? `<script>${REPORT_SCRIPT}</script>` : ''}
</body>
</html>`;
}

function buildSuiteHtml(suite, relative, interactive) {
    const counts = summarize([suite]);
    const status = suite.error || counts.failed || counts.error ? 'failed' : 'passed';
    const head = `<h2>${gotoButton(suite.file, 1, relative(suite.file))}<span class="suite-counts">${counts.passed}/${counts.total} passed</span></h2>`;
    if (suite.error) {
        return `<section class="suite suite-${status}">${head}<div class="failure failure-error">${escapeHtml(suite.error)}</div></section>`;
    }
    return `<section class="suite suite-${status}">${head}
${suite.results.map(r => buildCaseHtml(r, relative, interactive)).join('\n')}
</section>`;
}

// Where a case is, for the buttons that change it: its suite, position and
// name, which the extension checks still match before changing anything.
function caseAttrs(r) {
    return ` data-suite="${escapeHtml(r.suiteFile)}" data-case="${r.index}" data-case-name="${escapeHtml(r.name)}"`;
}

function buildCaseHtml(r, relative, interactive) {
    const failures = r.failures.map(f => buildFailureHtml(f, relative)).join('\n');
    const checkCount = r.checks && r.checks.length
        ? `<span class="check-count">${r.checks.filter(c => c.status === 'passed').length}/${r.checks.length} checks</span>`
        : '';
    const warnings = r.diagnostics.filter(d => d.severity === 'warning' && !r.failures.some(f => f.kind === 'problem' && f.message === `${d.title}: ${d.message}`));
    const allowed = warnings.length
        ? `<div class="allowed">Allowed ${warnings.length === 1 ? 'warning' : 'warnings'}:<ul>${warnings.map(d => `<li>${escapeHtml(d.message)} ${d.line ? gotoButton(d.file, d.line, `line ${d.line}`) : ''}</li>`).join('')}</ul></div>`
        : '';
    const facts = [
        ['Template', r.template ? gotoButton(r.template, 1, relative(r.template)) : '&mdash;'],
        ['Data', r.dataFile ? gotoButton(r.dataFile, 1, relative(r.dataFile)) : 'inline'],
        ['Expected', r.expectedFile ? gotoButton(r.expectedFile, 1, relative(r.expectedFile)) : '&mdash;']
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const checks = r.checks && r.checks.length ? buildChecksHtml(r, relative, interactive) : '';
    // Editing opens the test in the HTML preview, which needs a data file.
    const edit = interactive && r.dataFile && r.template
        ? `<div class="case-actions"><button type="button" class="act" data-action="edit-test"${caseAttrs(r)} title="Open this test in the HTML preview to add, remove or reorder its checks">Edit test</button></div>`
        : '';
    const output = r.actual !== null && r.actual !== undefined
        ? `<details class="output"><summary>Actual output</summary><pre>${escapeHtml(r.actual)}</pre></details>`
        : '';
    return `<details class="case case-${r.status}"${r.status === 'passed' ? '' : ' open'}>
  <summary><span class="icon icon-${r.status}" title="${STATUS_LABEL[r.status]}">${STATUS_ICON[r.status]}</span><span class="case-name">${escapeHtml(r.name)}</span>${checkCount}<span class="duration">${escapeHtml(formatDuration(r.durationMs))}</span>${gotoButton(r.suiteFile, r.line, 'definition')}</summary>
  <div class="case-body">
    <dl class="facts">${facts}</dl>
    ${edit}
    ${failures}
    ${checks}
    ${allowed}
    ${output}
  </div>
</details>`;
}

// A case's checks, one row each: passed ones compact, failed ones with why.
function buildChecksHtml(r, relative, interactive) {
    const rows = r.checks.map(c => {
        // A failed check can be updated to the page's new result, where that
        // means something (see acceptCheck), or taken out of the test.
        const attrs = `${caseAttrs(r)} data-check="${c.index}" data-check-name="${escapeHtml(c.name)}"`;
        const actions = interactive && c.status === 'failed' && c.index !== undefined
            ? `<div class="check-actions">${c.canAccept ? `<button type="button" class="act" data-action="accept-check"${attrs} title="Update this check to expect what the page shows now">Accept new result</button>` : ''}`
                + `<button type="button" class="act secondary" data-action="remove-check"${attrs} title="Take this check out of the test">Remove check</button></div>`
            : '';
        const icon = c.status === 'passed' ? STATUS_ICON.passed : c.status === 'skipped' ? '&ndash;' : STATUS_ICON.failed;
        const where = c.line ? gotoButton(r.suiteFile, c.line, 'definition') : '';
        const why = c.failures.length
            ? `<ul class="check-why">${c.failures.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
            : '';
        return `<li class="check check-${c.status}"><div class="check-line"><span class="icon icon-${c.status === 'passed' ? 'passed' : c.status === 'skipped' ? 'error' : 'failed'}">${icon}</span><span class="check-name">${escapeHtml(c.name)}</span>${where}</div>${why}${actions}</li>`;
    }).join('');
    return `<div class="checks"><div class="checks-head">Checks</div><ul>${rows}</ul></div>`;
}

function buildFailureHtml(f, relative) {
    const where = f.file && f.line ? ` ${gotoButton(f.file, f.line, `${path.basename(f.file)}:${f.line}`)}` : '';
    const diff = f.diff ? buildDiffHtml(f.diff) : '';
    return `<div class="failure failure-${f.kind === 'error' ? 'error' : 'failed'}"><div class="failure-message">${escapeHtml(f.message)}${where}</div>${diff}</div>`;
}

function buildDiffHtml(diff) {
    const note = diff.note ? `<div class="diff-note">${escapeHtml(diff.note)}</div>` : '';
    const legend = '<div class="diff-legend"><span class="diff-del">&minus; expected</span> <span class="diff-add">+ actual</span></div>';
    const hunks = diff.hunks.map(hunk => `<table class="diff">${hunk.map(l => {
        const cls = l.type === '-' ? 'diff-del' : l.type === '+' ? 'diff-add' : 'diff-ctx';
        return `<tr class="${cls}"><td class="ln">${l.oldLine || ''}</td><td class="ln">${l.newLine || ''}</td><td class="sign">${l.type === ' ' ? '' : l.type === '-' ? '&minus;' : '+'}</td><td class="code">${escapeHtml(l.text)}</td></tr>`;
    }).join('')}</table>`).join('<div class="diff-gap">&hellip;</div>');
    return `${note}${legend}<div class="diff-wrap">${hunks}</div>`;
}

// A path the reader can click to open. Outside VS Code the report's script is
// absent and the button is inert, but the label still says where to look.
function gotoButton(file, line, label) {
    if (!file) return '';
    return `<button type="button" class="goto" data-file="${escapeHtml(file)}" data-line="${line || 1}" title="${escapeHtml(file)}${line > 1 ? ':' + line : ''}">${escapeHtml(label)}</button>`;
}

// Cases whose actual output can be written to their expected file: they
// rendered, have an expected path, and that file is missing or different.
function acceptableResults(report) {
    const out = [];
    for (const suite of report.suites) {
        for (const r of suite.results) {
            if (r.expectedFile && r.actual !== null && r.actual !== undefined
                && r.failures.some(f => f.kind === 'mismatch' || f.kind === 'missing-expected')) {
                out.push(r);
            }
        }
    }
    return out;
}

function formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Light by default, dark when the OS asks for it, and VS Code's own theme when
// shown in a webview, which marks <body> with vscode-light / vscode-dark.
const REPORT_STYLES = `
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --panel: #f6f8fa;
  --pass: #1a7f37; --fail: #cf222e; --err: #9a6700;
  --add-bg: #dafbe1; --del-bg: #ffebe9; --link: #0969da;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not(.force-light) {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --panel: #151b23;
    --pass: #3fb950; --fail: #f85149; --err: #d29922;
    --add-bg: rgba(46,160,67,0.18); --del-bg: rgba(248,81,73,0.18); --link: #4493f8;
  }
}
body.vscode-light, body.vscode-dark, body.vscode-high-contrast {
  --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground);
  --muted: var(--vscode-descriptionForeground); --border: var(--vscode-panel-border, var(--vscode-widget-border, #8884));
  --panel: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --link: var(--vscode-textLink-foreground);
  --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
}
body.vscode-light { --pass: #1a7f37; --fail: #cf222e; --err: #9a6700; --add-bg: #dafbe1; --del-bg: #ffebe9; }
body.vscode-dark, body.vscode-high-contrast { --pass: #3fb950; --fail: #f85149; --err: #d29922; --add-bg: rgba(46,160,67,0.18); --del-bg: rgba(248,81,73,0.18); }
* { box-sizing: border-box; }
body { margin: 0; padding: 0 16px 32px; background: var(--bg); color: var(--fg); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.head { position: sticky; top: 0; z-index: 1; background: var(--bg); padding: 16px 0 12px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.head h1 { margin: 0; font-size: 18px; flex-basis: 100%; }
.head-passed h1 { color: var(--pass); }
.head-failed h1 { color: var(--fail); }
.meta { color: var(--muted); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { border-radius: 10px; padding: 0 8px; font-weight: 600; font-variant-numeric: tabular-nums; border: 1px solid currentColor; }
.chip-passed { color: var(--pass); }
.chip-failed { color: var(--fail); }
.chip-error { color: var(--err); }
.filter { color: var(--muted); display: flex; align-items: center; gap: 4px; cursor: pointer; }
.toolbar { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.toolbar button { font: inherit; padding: 3px 10px; border-radius: 2px; border: 1px solid transparent; cursor: pointer;
  background: var(--vscode-button-secondaryBackground, var(--panel)); color: var(--vscode-button-secondaryForeground, var(--fg)); }
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--border)); }
.toolbar button[data-action="accept"] { background: var(--vscode-button-background, var(--link)); color: var(--vscode-button-foreground, #fff); }
.suite { margin-top: 20px; }
.suite h2 { font-size: 14px; margin: 0 0 8px; display: flex; align-items: baseline; gap: 10px; }
.suite-counts { color: var(--muted); font-weight: normal; font-size: 12px; font-variant-numeric: tabular-nums; }
.case { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; background: var(--bg); }
.case > summary { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; list-style: none; }
.case > summary::-webkit-details-marker { display: none; }
.case > summary::before { content: '\\25B8'; color: var(--muted); width: 10px; }
.case[open] > summary::before { content: '\\25BE'; }
.case-name { font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.duration { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
.icon { width: 16px; text-align: center; font-weight: bold; }
.icon-passed { color: var(--pass); }
.icon-failed { color: var(--fail); }
.icon-error { color: var(--err); }
.case-failed { border-left: 3px solid var(--fail); }
.case-error { border-left: 3px solid var(--err); }
.case-body { padding: 4px 12px 12px 28px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 8px; color: var(--muted); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.failure { margin: 8px 0; }
.failure-message { font-weight: 600; }
.failure-failed .failure-message { color: var(--fail); }
.failure-error .failure-message, .suite > .failure-error { color: var(--err); }
.checks { margin: 10px 0; }
.checks-head { font-weight: 600; margin-bottom: 4px; }
.checks > ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 4px; }
.check { padding: 4px 8px; border-top: 1px solid var(--border); }
.check:first-child { border-top: none; }
.check-line { display: flex; align-items: baseline; gap: 8px; }
.check-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.check-failed .check-name { color: var(--fail); font-weight: 600; }
.check-skipped .check-name { color: var(--muted); }
.check-why { margin: 2px 0 2px 24px; padding-left: 16px; color: var(--fg); }
.case-actions { margin: 4px 0 8px; }
.check-actions { display: flex; gap: 6px; margin: 4px 0 2px 24px; flex-wrap: wrap; }
/* All secondary: accepting a new result should be a decision, not the
   obvious next click. The confirmation says exactly what changes. */
button.act { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 2px; cursor: pointer; border: 1px solid var(--border);
  background: var(--vscode-button-secondaryBackground, var(--panel)); color: var(--vscode-button-secondaryForeground, var(--fg)); }
button.act:hover { background: var(--vscode-button-secondaryHoverBackground, var(--border)); }
.check-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.case-failed .check-count { color: var(--fail); }
.allowed { color: var(--muted); margin: 8px 0; }
.allowed ul { margin: 2px 0; padding-left: 20px; }
button.goto { font: 12px var(--mono); color: var(--link); background: none; border: none; padding: 0; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
button.goto:hover { text-decoration: underline; }
.diff-note { color: var(--muted); font-style: italic; margin: 4px 0; }
.diff-legend { font: 12px var(--mono); margin: 4px 0; }
.diff-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; }
table.diff { border-collapse: collapse; width: 100%; font: 12px/1.45 var(--mono); }
table.diff td { padding: 0 6px; vertical-align: top; }
table.diff td.ln { color: var(--muted); text-align: right; user-select: none; width: 1%; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.diff td.sign { width: 1%; user-select: none; }
table.diff td.code { white-space: pre-wrap; word-break: break-all; }
tr.diff-add, span.diff-add { background: var(--add-bg); }
tr.diff-del, span.diff-del { background: var(--del-bg); }
.diff-gap { text-align: center; color: var(--muted); border-top: 1px dashed var(--border); border-bottom: 1px dashed var(--border); }
.output summary { cursor: pointer; color: var(--muted); }
.output pre { font: 12px/1.45 var(--mono); background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 8px; overflow: auto; max-height: 400px; white-space: pre-wrap; word-break: break-all; }
.empty { color: var(--muted); margin-top: 24px; }
/* The filter hides what passed as a whole: cases and suites. Never the passed
   checks of a failing case — they are the context for judging its failure. */
body:has(#only-failures:checked) .case-passed,
body:has(#only-failures:checked) .suite-passed { display: none; }
@media (max-width: 600px) { .case-body { padding-left: 12px; } .toolbar { margin-left: 0; } }
`;

// Only included in the panel: forwards clicks to the extension.
const REPORT_SCRIPT = `
(function () {
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  if (!api) return;
  document.addEventListener('click', event => {
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    const goto = target.closest('button.goto');
    if (goto) {
      event.preventDefault();
      event.stopPropagation();
      api.postMessage({ type: 'reveal', file: goto.getAttribute('data-file'), line: Number(goto.getAttribute('data-line')), col: 1 });
      return;
    }
    const action = target.closest('button[data-action]');
    if (action) {
      const message = { type: action.getAttribute('data-action') };
      if (action.hasAttribute('data-suite')) {
        message.suiteFile = action.getAttribute('data-suite');
        message.caseIndex = Number(action.getAttribute('data-case'));
        message.caseName = action.getAttribute('data-case-name');
      }
      if (action.hasAttribute('data-check')) {
        message.checkIndex = Number(action.getAttribute('data-check'));
        message.checkName = action.getAttribute('data-check-name');
      }
      api.postMessage(message);
    }
  });
})();
`;

module.exports = {
    SUITE_GLOB,
    parseSuite,
    runCase,
    runSuite,
    summarize,
    normalize,
    diffLines,
    diffOutputs,
    toHunks,
    buildReportHtml,
    acceptableResults,
    editCase,
    tidyCheck,
    defaultSuiteFile,
    slugify,
    planNewCases
};
