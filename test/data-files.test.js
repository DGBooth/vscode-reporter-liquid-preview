// Choosing data files: which .json files are offered for a template, narrowed by
// the dataFolders and dataLinks settings. The matching is checked on its own
// (data-files.js), then the picks the extension shows with the settings
// applied: for the preview and for creating tests, which share one.

const test = require('node:test');
const assert = require('node:assert');

const { extension, stub, harnessReset } = require('./harness');
const dataFiles = require('../data-files');

// ---- the matching ---------------------------------------------------------------------

test('a name matches in any folder, a path from the workspace folder, whatever the capitals', () => {
    const yes = (file, pattern) => assert.ok(dataFiles.matches(file, pattern), `${pattern} should match ${file}`);
    const no = (file, pattern) => assert.ok(!dataFiles.matches(file, pattern), `${pattern} should not match ${file}`);
    yes('NAL-001.json', 'NAL-*.json');
    yes('data/crawls/NAL-001.json', 'NAL-*.json');
    yes('data/nal-001.json', 'NAL-*.json');
    no('data/XNAL-001.json', 'NAL-*.json');
    no('data/NAL-001.json.bak', 'NAL-*.json');
    yes('data/crawls/a.json', 'data/crawls/*.json');
    no('other/data/crawls/a.json', 'data/crawls/*.json');
    no('data/crawls/deeper/a.json', 'data/crawls/*.json');
    yes('data/crawls/deeper/a.json', 'data/crawls/**/*.json');
    yes('data/crawls/a.json', 'data/**/a.json');
    yes('data/x/y/crawl-1.json', 'data/**/crawl-*.json');
    yes('a/b/c.json', '**/c.json');
    yes('x/NAL-1.json', 'NAL-?.json');
    no('x/NAL-12.json', 'NAL-?.json');
    yes('letters/Non-Advised.liquid', '{Non-Advised,Advised}*.liquid');
    yes('letters/advised-letter.liquid', '{Non-Advised,Advised}*.liquid');
    yes('C:\\work\\data\\NAL-2.json', 'NAL-*.json');
});

test('a setting\u2019s folder is everything in it, from the workspace folder', () => {
    assert.strictEqual(dataFiles.folderGlob('crawl-results'), 'crawl-results/**');
    assert.strictEqual(dataFiles.folderGlob('data/crawls/'), 'data/crawls/**');
    assert.strictEqual(dataFiles.folderGlob('data/**/crawl-*.json'), 'data/**/crawl-*.json');
    assert.strictEqual(dataFiles.folderGlob('crawls/one.json'), 'crawls/one.json');
    assert.strictEqual(dataFiles.folderGlob('**/crawls'), '**/crawls/**', 'wildcards in a folder\u2019s path');
    assert.strictEqual(dataFiles.folderGlob('crawl-*'), 'crawl-*/**');
    assert.ok(dataFiles.isCandidate('crawl-results/a/b.json', ['crawl-results']));
    assert.ok(!dataFiles.isCandidate('other/crawl-results/b.json', ['crawl-results']), 'a folder name is that folder at the workspace folder');
    assert.ok(dataFiles.isCandidate('other/crawl-results/b.json', ['**/crawl-results']), 'and **/ goes to any depth');
    assert.ok(!dataFiles.isCandidate('crawl-results-old/b.json', ['crawl-results']), 'not a folder that merely starts with the name');
});

test('files that are .json but never data are never offered', () => {
    for (const file of ['package.json', 'a/package-lock.json', 'tsconfig.json', 'x/jsconfig.json', 'suite.liquidtest.json', 'node_modules/a/b.json', '.vscode/settings.json', 'readme.md']) {
        assert.ok(!dataFiles.isCandidate(file), file);
    }
    assert.ok(dataFiles.isCandidate('data/a.json'));
    assert.ok(dataFiles.isCandidate('data/A.JSON'));
});

test('dataLinks: a linked template is tied to its data, others to nothing', () => {
    const files = ['crawls/NAL-1.json', 'crawls/NAL-2.json', 'crawls/AL-1.json', 'other/nal-9.json'];
    const links = [{ template: 'non-advised-letter.liquid', data: 'NAL-*.json' }];
    const nal = dataFiles.dataFor('letters/non-advised-letter.liquid', files, { links });
    assert.deepStrictEqual(nal.linked, ['crawls/NAL-1.json', 'crawls/NAL-2.json', 'other/nal-9.json']);
    assert.deepStrictEqual(nal.all, files, 'all of them are still known');
    assert.deepStrictEqual(nal.linkPatterns, ['NAL-*.json']);
    assert.deepStrictEqual(dataFiles.dataFor('letters/advised-letter.liquid', files, { links }).linked, [], 'no link, nothing linked');
    assert.deepStrictEqual(dataFiles.dataFor('letters/non-advised-letter.liquid', files, { links: [{ template: 'non-advised-letter.liquid', data: 'ZZZ-*.json' }] }).linked, [], 'a link that matches nothing');
});

test('dataLinks: several entries and several patterns add up, and the folders still limit the files', () => {
    const files = ['crawls/NAL-1.json', 'crawls/NAS-1.json', 'crawls/AL-1.json', 'old/NAL-7.json'];
    const links = [
        { template: 'letters/*.liquid', data: ['NAL-*.json', 'NAS-*.json'] },
        { template: 'non-advised-letter.liquid', data: 'AL-*.json' }
    ];
    const both = dataFiles.dataFor('letters/non-advised-letter.liquid', files, { links, folders: ['crawls'] });
    assert.deepStrictEqual(both.linked, ['crawls/NAL-1.json', 'crawls/NAS-1.json', 'crawls/AL-1.json']);
    assert.deepStrictEqual(both.all, ['crawls/NAL-1.json', 'crawls/NAS-1.json', 'crawls/AL-1.json'], 'old/ is outside the folders');
    assert.deepStrictEqual(dataFiles.dataFor('elsewhere/other.liquid', files, { links }).linked, []);
});

test('settings written wrongly are ignored, not fatal', () => {
    assert.deepStrictEqual(dataFiles.normalizeLinks('nonsense'), []);
    assert.deepStrictEqual(dataFiles.normalizeLinks([null, 3, { template: 'a.liquid' }, { data: 'x.json' }, { template: '', data: 'x.json' }, { template: 'a.liquid', data: [] }, { template: ' a.liquid ', data: [' NAL-*.json ', 5, ''] }]),
        [{ template: 'a.liquid', data: ['NAL-*.json'] }]);
    assert.deepStrictEqual(dataFiles.strings(['a', '', ' b ', 3, null]), ['a', 'b']);
    assert.strictEqual(dataFiles.isCandidate('data/a.json', 'not a list'), true, 'folders that aren\u2019t a list limit nothing');
});

// ---- the picks -------------------------------------------------------------------------

const FILES = [
    'crawl-results/NAL-1.json', 'crawl-results/NAL-2.json', 'crawl-results/AL-1.json',
    'config/app.json', 'package.json', 'node_modules/x/y.json', '.vscode/settings.json', 'crawl-results/old.liquidtest.json'
];
const TEMPLATE = '/w/letters/non-advised-letter.liquid';

test.beforeEach(() => {
    harnessReset();
    for (const rel of FILES) stub.workspaceFiles.set(`/w/${rel}`, '{}');
});

// Answer the next pick by looking at what's offered.
function pick(choose) {
    const seen = {};
    stub.quickPickAnswers.push((items, options) => { Object.assign(seen, { items, options }); return choose(items); });
    return seen;
}
const labels = items => items.map(i => i.label);

test('without settings, every .json that could be data is offered, from the workspace', async () => {
    const seen = pick(items => items[0]);
    const picked = await extension.pickDataFiles(TEMPLATE);
    assert.deepStrictEqual(labels(seen.items), ['app.json', 'AL-1.json', 'NAL-1.json', 'NAL-2.json']);
    assert.deepStrictEqual(seen.items.map(i => i.description), ['config/app.json', 'crawl-results/AL-1.json', 'crawl-results/NAL-1.json', 'crawl-results/NAL-2.json'], 'from the workspace folder, not the whole path');
    assert.strictEqual(picked.value, '/w/config/app.json');
});

test('dataFolders limits what is offered to those folders', async () => {
    stub.settings.set('reporterLiquidPreview.dataFolders', ['crawl-results']);
    const seen = pick(items => items[1]);
    const picked = await extension.pickDataFiles(TEMPLATE);
    assert.deepStrictEqual(labels(seen.items), ['AL-1.json', 'NAL-1.json', 'NAL-2.json']);
    assert.strictEqual(picked.value, '/w/crawl-results/NAL-1.json');
});

test('a template with dataLinks is offered its linked data, and a way to see the rest', async () => {
    stub.settings.set('reporterLiquidPreview.dataLinks', [{ template: 'non-advised-letter.liquid', data: 'NAL-*.json' }]);
    const seen = pick(items => items[0]);
    const picked = await extension.pickDataFiles(TEMPLATE);
    assert.deepStrictEqual(labels(seen.items), ['NAL-1.json', 'NAL-2.json', '$(list-flat) Show all 4 data files\u2026']);
    assert.strictEqual(seen.items[2].alwaysShow, true, 'it is always there, whatever is typed');
    assert.match(seen.options.placeHolder, /linked to non-advised-letter\.liquid \(NAL-\*\.json\)/);
    assert.strictEqual(picked.value, '/w/crawl-results/NAL-1.json');
});

test('another template is not narrowed by a link that isn\u2019t its own', async () => {
    stub.settings.set('reporterLiquidPreview.dataLinks', [{ template: 'non-advised-letter.liquid', data: 'NAL-*.json' }]);
    const seen = pick(items => items[0]);
    await extension.pickDataFiles('/w/letters/advised-letter.liquid');
    assert.strictEqual(seen.items.length, 4);
    assert.ok(!seen.items.some(i => i.showAll));
});

test('"Show all" shows every file, and picks from them', async () => {
    stub.settings.set('reporterLiquidPreview.dataLinks', [{ template: 'non-advised-letter.liquid', data: 'NAL-*.json' }]);
    pick(items => items.find(i => i.showAll));
    const second = pick(items => items.find(i => i.label === 'AL-1.json'));
    const picked = await extension.pickDataFiles(TEMPLATE);
    assert.deepStrictEqual(labels(second.items), ['app.json', 'AL-1.json', 'NAL-1.json', 'NAL-2.json']);
    assert.strictEqual(picked.value, '/w/crawl-results/AL-1.json');
});

test('picking several, then showing all, keeps what was ticked ticked', async () => {
    stub.settings.set('reporterLiquidPreview.dataLinks', [{ template: 'non-advised-letter.liquid', data: 'NAL-*.json' }]);
    pick(items => [items[0], items.find(i => i.showAll)]);
    const second = pick(items => items.filter(i => i.picked || i.label === 'AL-1.json'));
    const picked = await extension.pickDataFiles(TEMPLATE, { many: true });
    assert.deepStrictEqual(second.items.filter(i => i.picked).map(i => i.label), ['NAL-1.json']);
    assert.deepStrictEqual(picked.map(i => i.label), ['AL-1.json', 'NAL-1.json']);
});

test('a link that matches no file says so, and offers everything', async () => {
    stub.settings.set('reporterLiquidPreview.dataLinks', [{ template: 'non-advised-letter.liquid', data: 'ZZZ-*.json' }]);
    const seen = pick(items => items[0]);
    await extension.pickDataFiles(TEMPLATE);
    assert.strictEqual(seen.items.length, 4);
    assert.match(seen.options.placeHolder, /No file matches the dataLinks for non-advised-letter\.liquid \(ZZZ-\*\.json\), so all are shown/);
});

test('folders with nothing in them are named, with a way to the setting', async () => {
    stub.settings.set('reporterLiquidPreview.dataFolders', ['crawl_results']);
    stub.warningAnswers.push('Open setting');
    assert.strictEqual(await extension.pickDataFiles(TEMPLATE), null);
    assert.match(stub.shownMessages[0], /No \.json data files found in the folders set in reporterLiquidPreview\.dataFolders \(crawl_results\)\. Check the setting\./);
    assert.deepStrictEqual(stub.executedCommands, [{ command: 'workbench.action.openSettings', args: ['reporterLiquidPreview.dataFolders'] }]);
});

test('a workspace with no data at all says so', async () => {
    harnessReset();
    stub.workspaceFiles.set('/w/package.json', '{}');
    assert.strictEqual(await extension.pickDataFiles(TEMPLATE), null);
    assert.deepStrictEqual(stub.shownMessages, ['No .json data files found in the workspace.']);
});

test('cancelling the pick returns nothing', async () => {
    pick(() => undefined);
    assert.strictEqual(await extension.pickDataFiles(TEMPLATE), null);
});
