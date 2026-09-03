// Is the .vsix committed next to the source actually built from it?
//
// This repository ships its build artifact, so nothing stops a change to
// extension.js or the README landing without a repackage — and the stale .vsix
// is what gets installed. This builds a fresh package into a temporary
// directory and compares it, entry by entry, with the committed one.
//
//   npm run check:package
//
// Both packages come from `npm run package`, which pins the vsce version and
// passes explicit base URLs, so the comparison is not at the mercy of what vsce
// infers from the checkout (it rewrites relative README links, and CI checks
// out a detached HEAD).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expectedName = `${manifest.name}-${manifest.version}.vsix`;

// Entries whose bytes legitimately differ between two builds of the same
// source. Nothing qualifies today; the list exists so a future exception is
// recorded here with a reason rather than by loosening the comparison.
const IGNORED = new Set();

function fail(message, detail) {
    console.error(`\n${message}\n`);
    if (detail) console.error(detail + '\n');
    console.error('Rebuild it with:\n\n    npm run package\n');
    process.exit(1);
}

// ---- a zip reader, so this needs no dependency of its own ------------------

// Map of entry name -> content hash, read from the zip's central directory.
// Timestamps, entry order and compression settings are all ignored: only the
// names and the bytes they hold are compared.
function readEntries(file) {
    const buffer = fs.readFileSync(file);

    // The end-of-central-directory record is last, after a comment of up to
    // 64KB, so it has to be found by scanning back for its signature.
    let end = -1;
    for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end === -1) throw new Error(`${file} is not a zip archive`);

    const count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);

    const entries = new Map();
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`${file}: bad central directory entry ${i}`);
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

        // The local header repeats the name and carries its own extra field,
        // whose length can differ from the central directory's.
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${file}: bad local header for ${name}`);
        const dataStart = localOffset + 30
            + buffer.readUInt16LE(localOffset + 26)
            + buffer.readUInt16LE(localOffset + 28);
        const stored = buffer.subarray(dataStart, dataStart + compressedSize);

        if (!name.endsWith('/')) {
            const content = method === 0 ? stored : zlib.inflateRawSync(stored);
            entries.set(name, require('crypto').createHash('sha256').update(content).digest('hex'));
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

// ---- checks ---------------------------------------------------------------

const committed = fs.readdirSync(root).filter(name => name.endsWith('.vsix'));

if (committed.length === 0) {
    fail(`No .vsix in the repository root. ${expectedName} should be committed alongside the source.`);
}
if (committed.length > 1) {
    fail('More than one .vsix in the repository root; only the current version should be committed.',
        committed.map(name => '  ' + name).join('\n'));
}
if (committed[0] !== expectedName) {
    fail(`The committed package is ${committed[0]}, but package.json says version ${manifest.version}.`,
        `Expected ${expectedName}.`);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlp-package-'));
const fresh = path.join(workDir, expectedName);
try {
    // Reuse the npm script so the check can never build with different options
    // from the ones a developer packages with.
    execFileSync('npm', ['run', '--silent', 'package', '--', '-o', fresh], { cwd: root, stdio: 'inherit' });

    const committedEntries = readEntries(path.join(root, committed[0]));
    const freshEntries = readEntries(fresh);

    const names = new Set([...committedEntries.keys(), ...freshEntries.keys()]);
    const differences = [];
    for (const name of [...names].sort()) {
        if (IGNORED.has(name)) continue;
        const before = committedEntries.get(name);
        const after = freshEntries.get(name);
        if (before === after) continue;
        if (before === undefined) differences.push(`  + ${name} (missing from the committed package)`);
        else if (after === undefined) differences.push(`  - ${name} (no longer part of the package)`);
        else differences.push(`  ~ ${name} (contents differ)`);
    }

    if (differences.length > 0) {
        fail(`${committed[0]} is out of date with the source.`, differences.join('\n'));
    }

    console.log(`${committed[0]} matches the source (${freshEntries.size} files).`);
} finally {
    fs.rmSync(workDir, { recursive: true, force: true });
}
