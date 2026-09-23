// CHANGELOG.md is where release notes come from: merging a version bump
// publishes that version's section as its GitHub release. A bump without a
// section would only fail at release time, after the merge, so it fails here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { notesFor } = require('../scripts/release-notes');

const root = path.join(__dirname, '..');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the version in package.json has release notes', () => {
    assert.ok(notesFor(changelog, version), `CHANGELOG.md needs a "## [${version}] - YYYY-MM-DD" section`);
});

test('versions are dated, unique and newest first', () => {
    const headings = [...changelog.matchAll(/^## \[(.+?)\](.*)$/gm)];
    assert.ok(headings.length > 0);
    const versions = headings.map(h => h[1]);
    for (const h of headings) assert.match(h[2], /^ - \d{4}-\d{2}-\d{2}$/, `## [${h[1]}] needs " - YYYY-MM-DD"`);
    assert.strictEqual(new Set(versions).size, versions.length, 'no version listed twice');

    const parse = v => v.split('.').map(Number);
    for (let i = 1; i < versions.length; i++) {
        const [a, b] = [parse(versions[i - 1]), parse(versions[i])];
        const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
        assert.ok(newer > 0, `${versions[i - 1]} should come after ${versions[i]}`);
    }
});

test('notes are one version\'s section, without its heading', () => {
    const text = '# Changelog\n\n## [1.1.0] - 2026-01-02\n\n### Added\n- b\n\n## [1.0.0] - 2026-01-01\n\n- a\n';
    assert.strictEqual(notesFor(text, '1.1.0'), '### Added\n- b');
    assert.strictEqual(notesFor(text, '1.0.0'), '- a');
    assert.strictEqual(notesFor(text, '1.0'), null, 'a prefix is not a match');
    assert.strictEqual(notesFor(text, '2.0.0'), null);
});

test('package-lock.json carries the same version as package.json', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.strictEqual(lock.version, version);
    if (lock.packages && lock.packages['']) assert.strictEqual(lock.packages[''].version, version);
});
