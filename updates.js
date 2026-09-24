// Updates from GitHub Releases, for teams that share the extension without a
// marketplace. Every merged version bump is published as a GitHub release
// with its .vsix attached (see .github/workflows/release.yml); this decides
// whether a newer one exists, which file to take, and whether a download is
// the file GitHub says it is. Nothing here touches `vscode` or the network:
// extension.js supplies the fetching and the prompts, so it can all be tested.

const crypto = require('crypto');

// Automatic checks happen at most this often. GitHub allows 60 unauthenticated
// API requests an hour per address, which a whole office behind one address
// shares; once a day per person stays well clear of it.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// "1.6.0" or "v1.6.0" → [1, 6, 0]; null if it isn't a plain release version.
// Pre-releases ("1.7.0-beta.1") are not offered to anyone.
function parseVersion(text) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
    return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

// "https://github.com/Owner/repo(.git)" → the API URL of its latest release,
// or null for anything that isn't a GitHub repository.
function latestReleaseUrl(repositoryUrl) {
    const match = /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(repositoryUrl || '').trim());
    return match ? `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest` : null;
}

// What the latest release offers, from GitHub's API answer: its version, the
// .vsix built for it and that file's SHA-256, and its page. Null when it's not
// a usable release: a draft or pre-release, a tag that isn't a version, or no
// .vsix for that version attached.
function describeRelease(release, extensionName) {
    if (!release || release.draft || release.prerelease) return null;
    const version = parseVersion(release.tag_name);
    if (!version) return null;
    const versionText = version.join('.');
    const expected = `${extensionName}-${versionText}.vsix`;
    const asset = (release.assets || []).find(a => a && a.name === expected);
    if (!asset || !/^https:\/\//.test(asset.browser_download_url || '')) return null;
    const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
    return {
        version: versionText,
        fileName: asset.name,
        downloadUrl: asset.browser_download_url,
        sha256: digest ? digest[1].toLowerCase() : null,
        pageUrl: release.html_url || null
    };
}

// Whether an automatic check is due, and whether a found version should be
// offered. A manual check ("Check for Updates") always runs and always offers,
// even a version the reader chose to skip.
function checkIsDue({ lastChecked, now, manual }) {
    if (manual) return true;
    return !lastChecked || now - lastChecked >= CHECK_INTERVAL_MS || now < lastChecked;
}

function shouldOffer({ release, current, skipped, manual }) {
    if (!release || !isNewer(release.version, current)) return false;
    return manual || release.version !== skipped;
}

// Is `buffer` the file GitHub published? Releases made before GitHub recorded
// digests have none; then the download can't be checked, and isn't installed.
function verifyDownload(buffer, sha256) {
    if (!sha256) return { ok: false, reason: 'GitHub has no fingerprint for this file, so the download can’t be checked.' };
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    return actual === sha256
        ? { ok: true }
        : { ok: false, reason: 'The download doesn’t match the file GitHub published (its SHA-256 fingerprint differs), so it wasn’t installed.' };
}

module.exports = {
    CHECK_INTERVAL_MS,
    parseVersion,
    isNewer,
    latestReleaseUrl,
    describeRelease,
    checkIsDue,
    shouldOffer,
    verifyDownload
};
