// Updates from GitHub Releases: the extension checks once a day for a newer
// release and offers to install it, and "Check for Updates" does so on demand.
// These drive it with a fake GitHub, so they need no network: which versions
// are offered, when it checks and when it keeps quiet, and that a download is
// installed only if it is the file GitHub published.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');

const { extension, stub, harnessReset } = require('./harness');
const updates = require('../updates');
const manifest = require('../package.json');

const DAY = updates.CHECK_INTERVAL_MS;

// ---- deciding ---------------------------------------------------------------------

test('versions compare as numbers, and pre-releases are never newer', () => {
    assert.strictEqual(updates.isNewer('v1.10.0', '1.9.9'), true);
    assert.strictEqual(updates.isNewer('1.6.1', '1.6.0'), true);
    assert.strictEqual(updates.isNewer('1.6.0', '1.6.0'), false);
    assert.strictEqual(updates.isNewer('1.5.9', '1.6.0'), false);
    assert.strictEqual(updates.isNewer('1.7.0-beta.1', '1.6.0'), false);
    assert.strictEqual(updates.isNewer('nonsense', '1.6.0'), false);
});

test('the release API address comes from the manifest\'s repository', () => {
    assert.strictEqual(updates.latestReleaseUrl(manifest.repository.url), 'https://api.github.com/repos/DGBooth/vscode-reporter-liquid-preview/releases/latest');
    assert.strictEqual(updates.latestReleaseUrl('git+https://github.com/a/b.git'), 'https://api.github.com/repos/a/b/releases/latest');
    assert.strictEqual(updates.latestReleaseUrl('https://gitlab.com/a/b'), null);
});

function release(version, { body = Buffer.from(`vsix ${version}`), digest, name, draft = false, prerelease = false } = {}) {
    return {
        tag_name: `v${version}`,
        draft,
        prerelease,
        html_url: `https://github.com/DGBooth/vscode-reporter-liquid-preview/releases/tag/v${version}`,
        assets: [{
            name: name || `reporter-liquid-preview-${version}.vsix`,
            browser_download_url: `https://github.com/DGBooth/vscode-reporter-liquid-preview/releases/download/v${version}/reporter-liquid-preview-${version}.vsix`,
            digest: digest === undefined ? `sha256:${crypto.createHash('sha256').update(body).digest('hex')}` : digest
        }],
        _body: body
    };
}

test('only a published release with this extension\'s .vsix for that version is usable', () => {
    assert.strictEqual(updates.describeRelease(release('9.0.0'), 'reporter-liquid-preview').version, '9.0.0');
    assert.strictEqual(updates.describeRelease(release('9.0.0', { draft: true }), 'reporter-liquid-preview'), null);
    assert.strictEqual(updates.describeRelease(release('9.0.0', { prerelease: true }), 'reporter-liquid-preview'), null);
    assert.strictEqual(updates.describeRelease(release('9.0.0', { name: 'reporter-liquid-preview-8.0.0.vsix' }), 'reporter-liquid-preview'), null, 'a mislabelled file is not taken');
    assert.strictEqual(updates.describeRelease(release('9.0.0', { name: 'other-9.0.0.vsix' }), 'reporter-liquid-preview'), null);
});

test('a download is accepted only if it is the file GitHub published', () => {
    const body = Buffer.from('the real vsix');
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    assert.deepStrictEqual(updates.verifyDownload(body, sha), { ok: true });
    assert.match(updates.verifyDownload(Buffer.from('tampered'), sha).reason, /doesn’t match the file GitHub published/);
    assert.match(updates.verifyDownload(body, null).reason, /no fingerprint/);
});

test('automatic checks are once a day; a clock that went backwards checks again', () => {
    assert.strictEqual(updates.checkIsDue({ lastChecked: undefined, now: 5 }), true);
    assert.strictEqual(updates.checkIsDue({ lastChecked: 1000, now: 1000 + DAY - 1 }), false);
    assert.strictEqual(updates.checkIsDue({ lastChecked: 1000, now: 1000 + DAY }), true);
    assert.strictEqual(updates.checkIsDue({ lastChecked: 1000, now: 500 }), true);
    assert.strictEqual(updates.checkIsDue({ lastChecked: 1000, now: 1001, manual: true }), true);
});

// ---- the extension ------------------------------------------------------------------

function context(values = {}) {
    const store = new Map(Object.entries(values));
    return { subscriptions: [], globalState: { get: k => store.get(k), update: async (k, v) => { store.set(k, v); } }, store };
}

// A fake GitHub: the latest release, and its file.
function github(latest) {
    const calls = [];
    return {
        calls,
        getJson: async url => { calls.push(url); if (latest instanceof Error) throw latest; return latest; },
        download: async url => { calls.push(url); return latest._body; }
    };
}

const NEWER = () => release('99.0.0');

test.beforeEach(() => harnessReset());

test('a newer release is offered, and installing it installs the downloaded file and offers a reload', async () => {
    const gh = github(NEWER());
    stub.infoAnswers.push('Install', 'Reload now');
    const result = await extension.checkForUpdates(context(), { transport: gh, now: 10 * DAY });

    assert.strictEqual(result.outcome, 'installed');
    assert.strictEqual(stub.shownMessages[0], `Reporter Liquid Preview 99.0.0 is available (you have ${manifest.version}).`);
    const [install, reload] = stub.executedCommands;
    assert.strictEqual(install.command, 'workbench.extensions.installExtension');
    assert.strictEqual(install.args[0].fsPath, result.file);
    assert.strictEqual(fs.readFileSync(result.file, 'utf8'), 'vsix 99.0.0');
    assert.strictEqual(reload.command, 'workbench.action.reloadWindow');
});

test('a download that isn\'t the published file is not installed', async () => {
    const tampered = release('99.0.0', { digest: `sha256:${'0'.repeat(64)}` });
    stub.infoAnswers.push('Install');
    stub.errorAnswers.push('Open release page');
    const result = await extension.checkForUpdates(context(), { transport: github(tampered), now: 10 * DAY });

    assert.strictEqual(result.outcome, 'not-verified');
    assert.deepStrictEqual(stub.executedCommands, [], 'nothing installed');
    assert.match(stub.shownErrors[0], /doesn’t match the file GitHub published/);
    assert.deepStrictEqual(stub.openedLinks, [tampered.html_url], 'and the release page is offered instead');
});

test('"What’s new" opens the release page; "Skip this version" stops it being offered automatically', async () => {
    stub.infoAnswers.push('What’s new');
    await extension.checkForUpdates(context(), { transport: github(NEWER()), now: 10 * DAY });
    assert.deepStrictEqual(stub.openedLinks, ['https://github.com/DGBooth/vscode-reporter-liquid-preview/releases/tag/v99.0.0']);

    const ctx = context();
    stub.infoAnswers.push('Skip this version');
    await extension.checkForUpdates(ctx, { transport: github(NEWER()), now: 10 * DAY });
    const again = await extension.checkForUpdates(ctx, { transport: github(NEWER()), now: 12 * DAY });
    assert.strictEqual(again.outcome, 'up-to-date', 'the skipped version isn’t offered again automatically');

    stub.infoAnswers.push(undefined);
    const manual = await extension.checkForUpdates(ctx, { manual: true, transport: github(NEWER()), now: 12 * DAY });
    assert.strictEqual(manual.outcome, 'dismissed', 'but Check for Updates still offers it');
});

test('the automatic check runs at most once a day, even when it fails', async () => {
    const ctx = context();
    const gh = github(new Error('offline'));
    await extension.checkForUpdates(ctx, { transport: gh, now: 10 * DAY });
    await extension.checkForUpdates(ctx, { transport: gh, now: 10 * DAY + 1000 });
    assert.strictEqual(gh.calls.length, 1, 'one request, not one per start-up');
    assert.deepStrictEqual(stub.shownErrors, [], 'and a failed automatic check says nothing');
});

test('Check for Updates always asks, and always answers', async () => {
    const ctx = context({ 'reporterLiquidPreview.updates.lastChecked': 10 * DAY });
    await extension.checkForUpdates(ctx, { manual: true, transport: github(release(manifest.version)), now: 10 * DAY + 1 });
    assert.deepStrictEqual(stub.shownMessages, [`Reporter Liquid Preview is up to date (${manifest.version}).`]);

    await extension.checkForUpdates(ctx, { manual: true, transport: github(new Error('GitHub is limiting requests from this network for now; try again later')), now: 10 * DAY + 2 });
    assert.match(stub.shownErrors[0], /Couldn’t check for updates: GitHub is limiting requests/);
});

test('the setting turns the automatic check off, but not Check for Updates', async () => {
    stub.settings.set('reporterLiquidPreview.checkForUpdates', false);
    const gh = github(NEWER());
    assert.strictEqual((await extension.checkForUpdates(context(), { transport: gh, now: 10 * DAY })).outcome, 'off');
    assert.strictEqual(gh.calls.length, 0);
    stub.infoAnswers.push(undefined);
    assert.strictEqual((await extension.checkForUpdates(context(), { manual: true, transport: gh, now: 10 * DAY })).outcome, 'dismissed');
});

test('no automatic check is scheduled while developing the extension, or without storage', () => {
    const scheduled = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => { scheduled.push(ms); return 0; };
    try {
        extension.registerUpdates({ subscriptions: [] });
        extension.registerUpdates(Object.assign(context(), { extensionMode: stub.vscode.ExtensionMode.Development }));
        assert.deepStrictEqual(scheduled, []);
        extension.registerUpdates(Object.assign(context(), { extensionMode: stub.vscode.ExtensionMode.Production }));
        assert.deepStrictEqual(scheduled, [5000]);
    } finally {
        global.setTimeout = realSetTimeout;
    }
});
