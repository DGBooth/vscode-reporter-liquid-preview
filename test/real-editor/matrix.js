// Types tags into a real VS Code (code-server) at several speeds and checks the
// document, because how fast you type decides what the extension can do and
// the unit tests can't show it. See README.md here for setting it up.
//
//   WORKSPACE=/path/to/empty/folder node matrix.js "10,30,150" [only keys containing this]
//
// The folder is the one code-server was started on. Needs playwright-core and a
// Chromium (PLAYWRIGHT_BROWSERS_PATH, or set CHROMIUM).
const { chromium } = require('playwright-core');
const fs = require('fs');

const WORKSPACE = process.env.WORKSPACE;
const URL = process.env.URL || 'http://127.0.0.1:8085';
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
if (!WORKSPACE) { console.error('Set WORKSPACE to the folder code-server was started on.'); process.exit(2); }

const speeds = (process.argv[2] || '10,30,150').split(',').map(Number);
const only = process.argv[3];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A second line to type on; line 1 is the document's own.
const DOCUMENT = '<p>x</p>\n\n';
// [what's typed, what the document says afterwards from line 2]. ⌫ is Backspace and
// ⇥ is Tab; the indent of a Reporter tag's body is the editor's (four spaces).
const SCENARIOS = [
    ['{%- else', '{%- else %}'],
    ['{%- else %}', '{%- else %}'],
    ['{{ name }}', '{{ name }}'],
    ['{%- if a', '{%- if a %}{%- endif %}'],
    ['{%- if a %}', '{%- if a %}{%- endif %}'],
    ['{%- for i in items', '{%- for i in items %}{%- endfor %}'],
    ['{%- optional "x"', '{%- optional "x" %}\n    \n{%- endoptional %}'],
    ['{%- optional "x" %}', '{%- optional "x" %}\n    \n{%- endoptional %}'],
    ['{%- choice "d"', '{%- choice "d" %}\n    \n{%- endchoice %}'],
    ['{%- editor "x"', '{%- editor "x" %}\n    \n{%- endeditor %}'],
    ['<div>', '<div></div>'],
    ['<section class="a">', '<section class="a"></section>']
].filter(([keys]) => !only || keys.includes(only));

(async () => {
    const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
    let count = 0;
    let failed = 0;
    for (const speed of speeds) {
        for (const [keys, wanted] of SCENARIOS) {
            const file = `s${String(++count).padStart(3, '0')}.liquid`;
            fs.writeFileSync(`${WORKSPACE}/${file}`, DOCUMENT);
            const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
            let got;
            try {
                await page.goto(`${URL}/?folder=${encodeURIComponent(WORKSPACE)}`, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
                await sleep(2500);
                await page.keyboard.press('Control+p');
                await sleep(400);
                await page.keyboard.type(file);
                await sleep(900);
                await page.keyboard.press('Enter');
                await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
                await sleep(4500); // The extension host starts, and the extension with it.
                await page.mouse.click(700, 400);
                await page.keyboard.press('Control+Home');
                await page.keyboard.press('ArrowDown');
                await page.keyboard.press('End');
                await sleep(300);
                for (const part of keys.split(/(⌫|⇥)/)) {
                    if (part === '⌫') await page.keyboard.press('Backspace');
                    else if (part === '⇥') await page.keyboard.press('Tab');
                    else if (part) await page.keyboard.type(part, { delay: speed });
                }
                await sleep(900);
                got = await page.evaluate(() => [...document.querySelectorAll('.monaco-editor .view-line')]
                    .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
                    .map(line => line.innerText.replace(/ /g, ' ')).join('\n'));
            } catch (err) {
                got = `HARNESS ERROR ${err.message.split('\n')[0]}`;
            }
            await page.close();
            const typed = got.split('\n').slice(1).join('\n').replace(/\n+$/, '');
            const ok = typed === wanted;
            if (!ok) failed++;
            console.log(`${ok ? 'PASS' : 'FAIL'} @${String(speed).padStart(3)}ms  ${keys}${ok ? '' : `\n      got    ${JSON.stringify(typed)}\n      wanted ${JSON.stringify(wanted)}`}`);
        }
    }
    console.log(`\n${count - failed}/${count} passed`);
    await browser.close();
    process.exit(failed ? 1 : 0);
})();
