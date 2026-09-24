// Templates whose output closes an element it never opened — a stray </div>.
// Put straight into the preview page, such a tag closed the preview's own
// container: the rest of the document fell outside its section, and outside
// the test builder's reach. The preview now displays the tree the checks parse,
// and warns about the stray tag. These load the real preview document in jsdom,
// which parses a whole page the way a browser does.

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const { extension, harnessReset, renderPreview, paneOf, messagesIn } = require('./harness');
const engine = require('../engine');
const { asPreviewShowsIt, parseChecks, runChecks } = require('../output-checks');

// One stray </div> between two sections, the way it shows up in a report.
const TEMPLATE = `<section class="plans">
  <h1>Plans included</h1>
  <table><tr><td>Aviva</td><td id="sum">£60,000.00</td></tr></table>
</section>
</div>
<section class="recommendation">
  <h1>My recommendation</h1>
  <table><tr><td>Plan name</td><td id="plan">Aviva Critical Illness Plus</td></tr></table>
</section>`;

test.beforeEach(() => harnessReset());

function load(page) {
    return new JSDOM(page, { runScripts: 'dangerously', virtualConsole: new VirtualConsole(), pretendToBeVisual: true }).window.document;
}

test('a stray closing tag can\'t push the rest of the document out of the preview', async () => {
    const { panel } = await renderPreview({ template: TEMPLATE, data: '{}' });
    const document = load(panel.webview.html);
    const root = document.getElementById('lp-rendered-root');
    const plan = document.getElementById('plan');
    assert.ok(root.contains(plan), 'still inside the preview\'s container');
    assert.ok(plan.closest('section.recommendation'), 'and inside its own section');
});

test('the preview shows the same tree on first load as after an edit', async () => {
    const { panel } = await renderPreview({ template: TEMPLATE, data: '{}' });
    const first = load(panel.webview.html).getElementById('lp-rendered-root').innerHTML;

    // An edit patches the content with innerHTML, which parses it as a fragment.
    const patched = load('<div id="r"></div>');
    patched.getElementById('r').innerHTML = (await engine.renderForTest(TEMPLATE, {}, '/w/r.liquid')).html;
    assert.strictEqual(first.trim(), patched.getElementById('r').innerHTML.trim());
});

test('the test builder can pick elements after a stray closing tag', async () => {
    const { panel } = await renderPreview({ template: TEMPLATE, data: '{}' });
    const document = load(panel.webview.html);
    document.querySelector('[data-lp-local="build-test"]').click();
    document.getElementById('plan').click();
    const shown = document.getElementById('lp-builder').shadowRoot.textContent;
    assert.match(shown, /It reads exactly “Aviva Critical Illness Plus”/);
});

test('the problems pane says there is a stray tag, and what follows it', async () => {
    const { pane } = await renderPreview({ template: TEMPLATE, data: '{}' });
    assert.ok(pane.includes('Unbalanced HTML'));
    const [message] = messagesIn(pane).filter(m => m.includes('closes nothing'));
    assert.match(message, /The output has a &lt;\/div&gt; that closes nothing it opened, just before “My recommendation/);
});

test('balanced output raises no warning', async () => {
    const { pane } = await renderPreview({ template: '<div><ul><li>a<li>b</ul><p>x<br>y</p><img src="z"></div>', data: '{}' });
    assert.ok(!pane.includes('Unbalanced HTML'), 'implied closes and void elements are fine');
});

test('stray closing tags are found wherever they are', () => {
    assert.deepStrictEqual(engine.strayClosingTags('<p>a</p></p><div>b</div></span>tail').map(s => [s.tag, s.followedBy]), [
        ['</p>', 'b tail'],
        ['</span>', 'tail']
    ]);
    assert.deepStrictEqual(engine.strayClosingTags('<table><tr><td>1<td>2</table>'), [], 'closing an outer element closes the inner ones');
    assert.deepStrictEqual(engine.strayClosingTags('<script>if (a</div>b) {}</script>'), [], 'script bodies are not markup');
});

test('what the preview displays is what the checks check', async () => {
    const { html } = await engine.renderForTest(TEMPLATE, {}, '/w/r.liquid');
    const shown = asPreviewShowsIt(html);
    const check = (source, c) => runChecks(parseChecks([Object.assign({ name: 'x' }, c)]).checks, source)[0].status;
    for (const c of [{ selector: 'section.recommendation #plan', text: 'Aviva Critical Illness Plus' }, { selector: 'section', count: 2 }]) {
        assert.strictEqual(check(html, c), 'passed');
        assert.strictEqual(check(shown, c), 'passed', 'displaying the balanced tree changes nothing a check sees');
    }
});

test('balancing keeps scripts and entities intact', () => {
    const shown = asPreviewShowsIt('<p>Tom &amp; Jerry</p></div><script>if (a < b && c) { x = "</p>"; }</script>');
    assert.strictEqual(shown, '<p>Tom &amp; Jerry</p><script>if (a < b && c) { x = "</p>"; }</script>');
});
