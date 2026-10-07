# Typing in a real editor

The unit tests model what VS Code does on each keystroke. They can't show what
only a real editor does: how typing speed changes what an extension can do.
A bug of exactly that kind (`{%- else` left as `{%- else}` when typed fast)
passed every unit test, so this checks the extension in VS Code itself, with real key
presses at 10, 30 and 150 ms apart.

It isn't part of `npm test`: it needs a few hundred MB and a browser. It runs
[code-server](https://github.com/coder/code-server) (VS Code in a web page, with the
same extension host) and drives it with Playwright.

## Setting it up

Everything goes in one scratch folder. Use Node 24: code-server needs it.

```sh
# Node 24, from the npm registry if you don't have it
npm init -y && npm install node@24 && export PATH=$PWD/node_modules/node/bin:$PATH

# code-server, without its build scripts (they compile native modules for
# terminals and remote login, which this doesn't use; one of them, kerberos,
# fails without system headers)
npm install code-server --ignore-scripts
(cd node_modules/code-server/lib/vscode && npm install --omit=dev --ignore-scripts)

# A profile. Workspace trust must be off: in Restricted Mode extensions don't run.
mkdir -p data/User ext ws
echo '{ "security.workspace.trust.enabled": false, "workbench.startupEditor": "none", "chat.disableAIFeatures": true }' > data/User/settings.json

# The extension: a built .vsix (npm run package), installed into this profile
node node_modules/code-server/out/node/entry.js --install-extension /path/to/reporter-liquid-preview-X.vsix --user-data-dir data --extensions-dir ext

# The editor, on the empty folder the driver writes into
node node_modules/code-server/out/node/entry.js --auth none --bind-addr 127.0.0.1:8085 --user-data-dir data --extensions-dir ext ws

# The driver
npm install playwright-core   # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 if a Chromium is already installed
WORKSPACE=$PWD/ws CHROMIUM=/path/to/chrome node /path/to/test/real-editor/matrix.js "10,30,150"
```

It prints PASS or FAIL for each scenario at each speed, with what the document
said and what it should have, and exits non-zero if any failed. Add scenarios to
`SCENARIOS` in `matrix.js`; `⌫` is Backspace and `⇥` is Tab in what's typed.

## Trying a change without packaging

The installed extension is a folder under `ext/`. Copy the changed files over it and
restart code-server (it reads extensions and language configurations at start), then run
the driver again.

## What it can and can't tell you

It types as a machine does: evenly. It found a failure unit tests couldn't, but a person's
bursts and pauses are different, so a pass here isn't proof for every typist. One thing it
shows that isn't a bug: at 10 ms between keys a Tab pressed straight after typing a block
tag's condition arrives before the end tag has been added (the extension waits 30 ms for
typing to stop), so it inserts a tab. People take longer than that to reach the Tab key.
