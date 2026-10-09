// Which .json files are offered as data for a template. Every .json in a
// workspace is a candidate, and a repository of crawl results is mostly other
// things: configuration, package files, fixtures. Two optional settings narrow it:
//
//   reporterLiquidPreview.dataFolders  where data files live, so nothing else is offered
//   reporterLiquidPreview.dataLinks    which data files a template is used with, by name
//
// This is the matching and nothing else; extension.js reads the settings, finds
// the files and shows the pick. It doesn't depend on VS Code.
//
// Patterns are globs on a file's path relative to its workspace folder, with `/`
// as the separator whatever the system, and capitals not mattering:
//   *   anything but a `/`                  **   anything, `/` included
//   ?   one character but a `/`             {a,b}   a or b
// A pattern with no `/` in it is a name, and matches in any folder, as in a
// .gitignore: `NAL-*.json` is every file so named, wherever it is. One with a
// `/` starts at the workspace folder.

// Files that are .json but never data.
const NOT_DATA = /(^|\/)(package|package-lock|tsconfig|jsconfig)\.json$|\.liquidtest\.json$|(^|\/)(node_modules|\.vscode)\//i;

function slashes(file) {
    return String(file).replace(/\\/g, '/');
}

// The regular expression source for a glob's text, without anchors.
function source(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') {
            out += '[^/]';
        } else if (c === '{' && glob.indexOf('}', i) > i) {
            const end = glob.indexOf('}', i);
            out += `(?:${glob.slice(i + 1, end).split(',').map(source).join('|')})`;
            i = end;
        } else {
            out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
        }
    }
    return out;
}

function globToRegExp(pattern) {
    const glob = slashes(pattern).trim().replace(/^\.?\//, '');
    return new RegExp(`${glob.includes('/') ? '^' : '(?:^|/)'}${source(glob)}$`, 'i');
}

function matches(file, pattern) {
    return globToRegExp(pattern).test(slashes(file));
}

// A setting entry as a glob: anything ending `.json` is a glob for files as it
// stands, and anything else is a folder, wildcards or not, so everything in it
// (`crawl-results`, `data/crawls/`, `**/crawls`, `crawl-*`). A folder is at that
// path from the workspace folder; `**/` goes to any depth.
function folderGlob(entry) {
    const text = slashes(entry).trim();
    return /\.json$/i.test(text) ? text : `${text.replace(/\/+$/, '')}/**`;
}

// A list setting as a list of non-empty strings, whatever was written.
function strings(value) {
    return (Array.isArray(value) ? value : []).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
}

// `dataLinks` as { template, data: [patterns] }, leaving out any entry that
// isn't a template pattern with at least one data pattern. `data` may be one
// pattern or a list.
function normalizeLinks(raw) {
    return (Array.isArray(raw) ? raw : []).map(link => ({
        template: link && typeof link.template === 'string' ? link.template.trim() : '',
        data: strings(link && typeof link.data === 'string' ? [link.data] : link && link.data)
    })).filter(link => link.template && link.data.length);
}

// A .json file that could be data: not a package file, a test suite or a
// workspace setting, and in `folders` (a setting's entries) if there are any.
function isCandidate(file, folders = []) {
    const rel = slashes(file);
    if (!/\.json$/i.test(rel) || NOT_DATA.test(rel)) return false;
    const wanted = strings(folders);
    return !wanted.length || wanted.some(entry => matches(rel, folderGlob(entry)));
}

// The data files for a template, from `files` (their paths relative to their
// workspace folder), as { all, linked }: every candidate the folders allow, and
// of those the ones a link ties to this template. `linked` is empty when the
// template has no link, or none of its links match a file. `links` and
// `folders` are the settings as written.
function dataFor(templateFile, files, { folders = [], links = [] } = {}) {
    const all = files.filter(file => isCandidate(file, folders));
    const patterns = [].concat(...normalizeLinks(links).filter(link => matches(templateFile, link.template)).map(link => link.data));
    const linked = patterns.length ? all.filter(file => patterns.some(pattern => matches(file, pattern))) : [];
    return { all, linked, linkPatterns: patterns };
}

module.exports = { matches, globToRegExp, folderGlob, normalizeLinks, isCandidate, dataFor, strings };
