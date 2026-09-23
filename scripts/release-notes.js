// Print one version's section of CHANGELOG.md — the notes for its GitHub
// release. Exits non-zero when the version has no section, so a release can't
// go out without notes.
//
//   node scripts/release-notes.js            # the version in package.json
//   node scripts/release-notes.js 1.4.0

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// The body of the "## [version] - date" section, without its heading, or null.
function notesFor(changelog, version) {
    const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
    const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\](\\s|$)`);
    const start = lines.findIndex(line => heading.test(line));
    if (start === -1) return null;
    let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
    if (end === -1) end = lines.length;
    const body = lines.slice(start + 1, end).join('\n').trim();
    return body || null;
}

if (require.main === module) {
    const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const notes = notesFor(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
    if (!notes) {
        console.error(`CHANGELOG.md has no notes for ${version}. Add a "## [${version}] - YYYY-MM-DD" section.`);
        process.exit(1);
    }
    process.stdout.write(notes + '\n');
}

module.exports = { notesFor };
