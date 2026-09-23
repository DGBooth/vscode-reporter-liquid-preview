#!/usr/bin/env node
// Run *.liquidtest.json template tests outside VS Code, for CI.
//
// It renders through engine.js, the same engine the preview uses, and judges
// cases with template-tests.js, the same runner the editor uses, so a case
// passes here exactly when it passes in the editor. The one difference: the
// editor reads unsaved edits, and this reads files as they are on disk.
//
//   liquid-test [options] [paths...]
//
// See usage() below, or the README's "Running template tests in CI".

const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const templateTests = require('../template-tests');

const EXIT_PASSED = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

function usage() {
    return `Usage: liquid-test [options] [paths...]

Runs Reporter Liquid template tests (*.liquidtest.json suites). Each path is a
suite file or a folder to search; the default is the current folder. Folders
are searched recursively, skipping node_modules and hidden folders.

Options:
  --report <file>   Also write the HTML report to <file>.
  --junit <file>    Also write JUnit XML to <file>, for CI test summaries.
  --update          Write the actual output to every expected file that is
                    missing or different, then re-run. For local use: review
                    the changes before committing them.
  --no-color        Plain output. Also off when NO_COLOR is set or output is
                    not a terminal.
  -h, --help        Show this help.

Exit status: 0 if every case passed, 1 if any failed or a suite is broken,
2 on a usage error or when no suites are found.`;
}

// ---- arguments -------------------------------------------------------------------

function parseArgs(argv) {
    const options = { paths: [], report: null, junit: null, update: false, color: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (next === undefined || next.startsWith('-')) throw new UsageError(`${arg} needs a file name.`);
            return next;
        };
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '--report') options.report = value();
        else if (arg === '--junit') options.junit = value();
        else if (arg === '--update') options.update = true;
        else if (arg === '--no-color') options.color = false;
        else if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}.`);
        else options.paths.push(arg);
    }
    if (options.paths.length === 0) options.paths.push('.');
    return options;
}

class UsageError extends Error { }

// ---- finding suites -----------------------------------------------------------------

function findSuites(paths, cwd) {
    const found = new Set();
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.liquidtest.json')) found.add(full);
        }
    };
    for (const p of paths) {
        const full = path.resolve(cwd, p);
        let stat;
        try {
            stat = fs.statSync(full);
        } catch (err) {
            throw new UsageError(`${p}: no such file or folder.`);
        }
        if (stat.isDirectory()) walk(full);
        else found.add(full);
    }
    return Array.from(found).sort();
}

// ---- running -----------------------------------------------------------------------------

const deps = {
    readText: file => fs.promises.readFile(file, 'utf8'),
    render: engine.renderForTest,
    format: engine.formatHtml
};

async function runAll(suiteFiles) {
    const startedAt = Date.now();
    const suites = [];
    for (const file of suiteFiles) {
        let suite;
        try {
            suite = templateTests.parseSuite(await deps.readText(file), file);
        } catch (err) {
            suite = { file, error: `Cannot read the suite: ${err.message}`, cases: [] };
        }
        suites.push(await templateTests.runSuite(suite, deps));
    }
    return { startedAt, durationMs: Date.now() - startedAt, suites };
}

async function acceptAll(report) {
    const results = templateTests.acceptableResults(report);
    for (const r of results) {
        await fs.promises.mkdir(path.dirname(r.expectedFile), { recursive: true });
        await fs.promises.writeFile(r.expectedFile, r.actual, 'utf8');
    }
    return results.map(r => r.expectedFile);
}

// ---- console output ---------------------------------------------------------------------

function painter(enabled) {
    const wrap = code => text => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
    return { red: wrap(31), green: wrap(32), yellow: wrap(33), dim: wrap(2), bold: wrap(1) };
}

function formatConsole(report, relative, c) {
    const lines = [];
    const mark = { passed: c.green('✓'), failed: c.red('✗'), error: c.yellow('!') };
    for (const suite of report.suites) {
        lines.push('', c.bold(relative(suite.file)));
        if (suite.error) {
            lines.push(`  ${c.yellow('!')} ${suite.error}`);
            continue;
        }
        for (const r of suite.results) {
            lines.push(`  ${mark[r.status]} ${r.name} ${c.dim(`(${r.durationMs} ms)`)}`);
            for (const f of r.failures) {
                const where = f.file && f.line ? c.dim(` — ${relative(f.file)}:${f.line}`) : '';
                lines.push(`      ${f.kind === 'error' ? c.yellow(f.message) : c.red(f.message)}${where}`);
                if (f.diff) lines.push(...formatDiff(f.diff, c).map(l => '        ' + l));
            }
        }
    }

    const t = templateTests.summarize(report.suites);
    const parts = [c.green(`${t.passed} passed`)];
    if (t.failed) parts.push(c.red(`${t.failed} failed`));
    if (t.error) parts.push(c.yellow(`${t.error} errored`));
    if (t.suiteErrors) parts.push(c.yellow(`${t.suiteErrors} broken ${t.suiteErrors === 1 ? 'suite' : 'suites'}`));
    lines.push('', `${parts.join(', ')} — ${t.total} ${t.total === 1 ? 'case' : 'cases'} in ${report.suites.length} ${report.suites.length === 1 ? 'suite' : 'suites'}, ${report.durationMs} ms`);
    return lines.join('\n');
}

function formatDiff(diff, c) {
    const out = [];
    if (diff.note) out.push(c.dim(diff.note));
    out.push(`${c.red('- expected')} ${c.green('+ actual')}`);
    diff.hunks.forEach((hunk, i) => {
        if (i > 0) out.push(c.dim('…'));
        for (const l of hunk) {
            if (l.type === '-') out.push(c.red(`- ${l.text}`));
            else if (l.type === '+') out.push(c.green(`+ ${l.text}`));
            else out.push(c.dim(`  ${l.text}`));
        }
    });
    return out;
}

// ---- JUnit ---------------------------------------------------------------------------------

// The de-facto JUnit schema most CI systems read: one <testsuite> per suite
// file, one <testcase> per case, <failure> for a failed check and <error> for
// a case (or suite) that could not run.
function buildJUnit(report, relative) {
    const seconds = ms => (ms / 1000).toFixed(3);
    const t = templateTests.summarize(report.suites);
    const body = report.suites.map(suite => {
        const name = relative(suite.file);
        if (suite.error) {
            return `  <testsuite name="${xml(name)}" file="${xml(name)}" tests="1" failures="0" errors="1" time="0">
    <testcase name="(suite)" classname="${xml(name)}" time="0"><error message="${xml(suite.error)}">${xml(suite.error)}</error></testcase>
  </testsuite>`;
        }
        const counts = templateTests.summarize([suite]);
        const time = suite.results.reduce((sum, r) => sum + r.durationMs, 0);
        const cases = suite.results.map(r => {
            const detail = r.failures.map(f => {
                const where = f.file && f.line ? ` (${relative(f.file)}:${f.line})` : '';
                const diff = f.diff ? '\n' + formatDiff(f.diff, painter(false)).join('\n') : '';
                return `${f.message}${where}${diff}`;
            }).join('\n\n');
            const tag = r.status === 'error' ? 'error' : 'failure';
            const inner = r.status === 'passed' ? '' : `<${tag} message="${xml(r.failures[0] ? r.failures[0].message : r.status)}">${xml(detail)}</${tag}>`;
            return `    <testcase name="${xml(r.name)}" classname="${xml(name)}" time="${seconds(r.durationMs)}">${inner}</testcase>`;
        }).join('\n');
        return `  <testsuite name="${xml(name)}" file="${xml(name)}" tests="${counts.total}" failures="${counts.failed}" errors="${counts.error}" time="${seconds(time)}">
${cases}
  </testsuite>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Liquid template tests" tests="${t.total + t.suiteErrors}" failures="${t.failed}" errors="${t.error + t.suiteErrors}" time="${seconds(report.durationMs)}">
${body}
</testsuites>
`;
}

// XML-escape, and drop the control characters XML 1.0 cannot carry at all —
// template output can contain anything.
function xml(text) {
    return String(text)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---- main ---------------------------------------------------------------------------------------

async function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
    let options;
    let suiteFiles;
    try {
        options = parseArgs(argv);
        if (options.help) {
            stdout.write(usage() + '\n');
            return EXIT_PASSED;
        }
        suiteFiles = findSuites(options.paths, cwd);
    } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        stderr.write(`liquid-test: ${err.message}\n\n${usage()}\n`);
        return EXIT_USAGE;
    }

    // Zero suites is a failure, not a pass: a CI job pointed at the wrong
    // folder would otherwise go green forever.
    if (suiteFiles.length === 0) {
        stderr.write(`liquid-test: no *.liquidtest.json suites found in ${options.paths.join(', ')}.\n`);
        return EXIT_USAGE;
    }

    const color = options.color !== null ? options.color : Boolean(stdout.isTTY) && !('NO_COLOR' in env);
    const c = painter(color);
    const relative = file => path.relative(cwd, file).split(path.sep).join('/') || '.';

    let report = await runAll(suiteFiles);
    if (options.update) {
        const written = await acceptAll(report);
        if (written.length) {
            stdout.write(`Updated ${written.length} expected ${written.length === 1 ? 'file' : 'files'}:\n${written.map(f => '  ' + relative(f)).join('\n')}\n`);
            report = await runAll(suiteFiles);
        } else {
            stdout.write('No expected files needed updating.\n');
        }
    }

    stdout.write(formatConsole(report, relative, c) + '\n');

    if (options.report) {
        const file = path.resolve(cwd, options.report);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, templateTests.buildReportHtml(report, { relative }), 'utf8');
        stdout.write(`HTML report: ${relative(file)}\n`);
    }
    if (options.junit) {
        const file = path.resolve(cwd, options.junit);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, buildJUnit(report, relative), 'utf8');
        stdout.write(`JUnit XML: ${relative(file)}\n`);
    }

    const t = templateTests.summarize(report.suites);
    return t.failed || t.error || t.suiteErrors ? EXIT_FAILED : EXIT_PASSED;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        code => { process.exitCode = code; },
        err => { process.stderr.write(`liquid-test: ${err.stack || err.message}\n`); process.exitCode = EXIT_USAGE; }
    );
}

module.exports = { main, parseArgs, findSuites, buildJUnit };
