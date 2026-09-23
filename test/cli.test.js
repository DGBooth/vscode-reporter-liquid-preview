// The command-line runner (bin/liquid-test.js), which runs template tests in
// CI. It has to agree with the editor on every verdict, exit non-zero on
// anything that isn't a clean pass — including finding nothing to run — and
// write reports a CI system can read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cli = require('../bin/liquid-test');

let dir;

function workspace(files) {
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
    }
}
const read = rel => fs.readFileSync(path.join(dir, rel), 'utf8');

// Run the CLI in-process against the temporary workspace.
async function run(...argv) {
    let out = '';
    let err = '';
    const code = await cli.main(argv, {
        cwd: dir,
        stdout: { write: s => { out += s; }, isTTY: false },
        stderr: { write: s => { err += s; } },
        env: {}
    });
    return { code, out, err };
}

test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-cli-')); });
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PASSING = {
    'r.liquid': '<p>{{ name }}</p>',
    'expected/ada.html': '<p>Ada</p>',
    'r.liquidtest.json': { template: 'r.liquid', cases: [{ name: 'ada', data: { name: 'Ada' }, expected: 'expected/ada.html' }] }
};

test('a clean run exits 0 and lists each case', async () => {
    workspace(PASSING);
    const { code, out } = await run();
    assert.strictEqual(code, 0);
    assert.match(out, /r\.liquidtest\.json\n {2}✓ ada/);
    assert.match(out, /1 passed — 1 case in 1 suite/);
});

test('a failing case exits 1 and prints the diff', async () => {
    workspace(Object.assign({}, PASSING, { 'expected/ada.html': '<p>Bob</p>' }));
    const { code, out } = await run();
    assert.strictEqual(code, 1);
    assert.match(out, /✗ ada/);
    assert.match(out, /- <p>Bob<\/p>\n\s+\+ <p>Ada<\/p>/);
    assert.ok(!out.includes('\x1b['), 'no colour when not writing to a terminal');
});

test('verdicts match the editor: warnings, duplicate names and parse errors all fail', async () => {
    workspace({
        'r.liquid': '{{ gone | slice: 0, 1 }}',
        'd.liquid': '{% editor "a" %}{% endeditor %}{% editor "a" %}{% endeditor %}',
        'b.liquid': '{% if x %}',
        'all.liquidtest.json': { cases: [
            { name: 'warns', template: 'r.liquid' },
            { name: 'warns, allowed', template: 'r.liquid', allowWarnings: true },
            { name: 'dupes', template: 'd.liquid' },
            { name: 'broken', template: 'b.liquid' }
        ] }
    });
    const { code, out } = await run();
    assert.strictEqual(code, 1);
    assert.match(out, /✗ warns \(/);
    assert.match(out, /✓ warns, allowed/);
    assert.match(out, /Duplicate field name/);
    assert.match(out, /! broken[\s\S]*Template error/);
});

test('finding no suites is a failure, so a misconfigured CI job cannot pass', async () => {
    workspace({ 'r.liquid': 'x' });
    const { code, err } = await run();
    assert.strictEqual(code, 2);
    assert.match(err, /no \*\.liquidtest\.json suites found/);
});

test('a broken suite fails the run', async () => {
    workspace(Object.assign({}, PASSING, { 'broken.liquidtest.json': '{ nope' }));
    const { code, out } = await run();
    assert.strictEqual(code, 1);
    assert.match(out, /1 passed, 1 broken suite/);
});

test('suites are found recursively, skipping node_modules and hidden folders', async () => {
    workspace({
        'a/b/one.liquidtest.json': '{}',
        'node_modules/pkg/two.liquidtest.json': '{}',
        '.git/three.liquidtest.json': '{}'
    });
    assert.deepStrictEqual(cli.findSuites(['.'], dir), [path.join(dir, 'a/b/one.liquidtest.json')]);
});

test('paths can name suite files and folders; a missing one is a usage error', async () => {
    workspace(Object.assign({}, PASSING, { 'other/x.liquidtest.json': '{ nope' }));
    assert.strictEqual((await run('r.liquidtest.json')).code, 0, 'only the named suite runs');
    const missing = await run('nowhere');
    assert.strictEqual(missing.code, 2);
    assert.match(missing.err, /nowhere: no such file or folder/);
});

test('bad options are usage errors, and --help explains them', async () => {
    assert.strictEqual((await run('--frobnicate')).code, 2);
    assert.strictEqual((await run('--junit')).code, 2, 'an option that needs a file name');
    const help = await run('--help');
    assert.strictEqual(help.code, 0);
    assert.match(help.out, /--junit <file>/);
});

test('--junit writes one testcase per case, failures carrying the diff', async () => {
    workspace(Object.assign({}, PASSING, {
        'expected/ada.html': '<p>Bob</p>',
        'more.liquidtest.json': { template: 'r.liquid', cases: [{ name: 'ok & fine', data: { name: 'x' }, contains: '<p>x</p>' }] }
    }));
    const { code } = await run('--junit', 'out/junit.xml');
    assert.strictEqual(code, 1);
    const xml = read('out/junit.xml');
    assert.match(xml, /<testsuites name="Liquid template tests" tests="2" failures="1" errors="0"/);
    assert.match(xml, /<testcase name="ok &amp; fine" classname="more.liquidtest.json" time="[\d.]+"><\/testcase>/);
    assert.match(xml, /<failure message="The output does not match the expected output.">[\s\S]*- &lt;p&gt;Bob&lt;\/p&gt;/);
});

test('--report writes the same standalone report the editor saves', async () => {
    workspace(PASSING);
    await run('--report', 'report.html');
    const html = read('report.html');
    assert.match(html, /All template tests passed/);
    assert.ok(!html.includes('<script>'), 'standalone: no editor script');
});

test('--update writes missing and changed expected files, then passes', async () => {
    workspace(Object.assign({}, PASSING, {
        'expected/ada.html': '<p>old</p>',
        'r.liquidtest.json': { template: 'r.liquid', cases: [
            { name: 'ada', data: { name: 'Ada' }, expected: 'expected/ada.html' },
            { name: 'new', data: { name: 'New' }, expected: 'expected/new/new.html' }
        ] }
    }));
    const { code, out } = await run('--update');
    assert.strictEqual(code, 0);
    assert.match(out, /Updated 2 expected files/);
    assert.strictEqual(read('expected/ada.html'), '<p>Ada</p>');
    assert.strictEqual(read('expected/new/new.html'), '<p>New</p>');
});

test('runs as a real process with the documented exit code', () => {
    workspace(Object.assign({}, PASSING, { 'expected/ada.html': 'nope' }));
    const script = path.join(__dirname, '..', 'bin', 'liquid-test.js');
    const status = (() => {
        try {
            execFileSync(process.execPath, [script, '--no-color'], { cwd: dir, stdio: 'pipe' });
            return 0;
        } catch (err) {
            return err.status;
        }
    })();
    assert.strictEqual(status, 1);
});

test('the runner loads in a plain Node process, where there is no vscode module', () => {
    // Anything on the runner's path that required 'vscode' would throw here.
    execFileSync(process.execPath, ['-e', "require('./bin/liquid-test')"], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
});
