const path = require('path');
const vscode = require('vscode');
const liquid = require('liquidjs');
const templateTests = require('./template-tests');
const { parseChecks, runChecks, asPreviewShowsIt } = require('./output-checks');

// The HTML preview's test builder (see webview/test-builder.js), read once and
// inlined into each preview document.
const BUILDER_SCRIPT = require('fs').readFileSync(path.join(__dirname, 'webview', 'test-builder.js'), 'utf8');
const BUILDER_STYLES = require('fs').readFileSync(path.join(__dirname, 'webview', 'test-builder.css'), 'utf8');
const {
    liquidEngine,
    parseTagArgs,
    tokenLocation,
    snippetOf,
    markdownToHtml,
    registerCustomFilters,
    registerCustomTags,
    pluralize,
    HTML_BLOCK_TAGS,
    HTML_VOID_TAGS,
    HTML_RAW_TAGS,
    tokenizeHtml,
    formatHtml,
    strayClosingTags,
    renderWithDiagnostics,
    diagnostic,
    liquidDiagnostic,
    cleanLiquidMessage,
    jsonDiagnostic,
    duplicateNameDiagnostic,
    escapeHtml,
    renderForTest
} = require('./engine');

function activate(context) {
    let templateStatusBarItem;
    let dataStatusBarItem;

    // Backs the squiggles and Problems-panel entries that mirror each preview's
    // problems pane (see publishDiagnostics).
    _diagnosticCollection = vscode.languages.createDiagnosticCollection('reporterLiquidPreview');
    context.subscriptions.push(_diagnosticCollection);
    let previewContentProvider = new class {
        constructor() {
            this.onDidChangeEmitter = new vscode.EventEmitter();
            this.onDidChange = this.onDidChangeEmitter.event;
            this.previews = {};
        }

        dispose() {
            this.onDidChangeEmitter.dispose();
            this.previews.clear();
        }

        async provideTextDocumentContent(uri) {
            let queryParmeters = new URLSearchParams(uri.query);
            let previewId = queryParmeters.get('id');
            let preview = this.previews[previewId];

            if (preview.templateUri && preview.templateDirty) {
                try {
                    let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
                    preview.template = liquidEngine.parse(templateDocument.getText());
                    preview.templateDirty = false;
                    templateStatusBarItem.text = '$(check) Template';
                    templateStatusBarItem.tooltip = 'All good!';
                } catch (err) {
                    templateStatusBarItem.text = '$(x) Template';
                    templateStatusBarItem.tooltip = err.message;
                }
            }

            if (preview.dataUri && preview.dataDirty) {
                try {
                    let dataDocument = await vscode.workspace.openTextDocument(preview.dataUri);
                    preview.data = JSON.parse(dataDocument.getText());
                    preview.dataDirty = false;
                    dataStatusBarItem.text = '$(check) Data';
                    dataStatusBarItem.tooltip = 'All good!';
                } catch (err) {
                    dataStatusBarItem.text = '$(x) Data';
                    dataStatusBarItem.tooltip = err.message;
                }
            }

            return await liquidEngine.render(preview.template, preview.data);
        }
    }
    context.subscriptions.push(previewContentProvider);

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('reporter-liquid-preview', previewContentProvider));

    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.preview', async () => {
        let document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (document) {
            let preview = createNewPreview(document);
            await updatePreviewDataFile(preview);
            previewContentProvider.previews[preview.id] = preview;

            let doc = await vscode.workspace.openTextDocument(preview.uri());
            await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false, viewColumn: vscode.ViewColumn.Beside });
        }
    }));

    // HTML preview panels, keyed by preview id
    let htmlPreviews = {};

    // Full HTML preview panels (liquid-stripped), keyed by preview id
    let htmlFullPreviews = {};

    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.htmlPreview', async () => {
        let document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (document) {
            let preview = createNewPreview(document);
            await updatePreviewDataFile(preview);

            let workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
            let panel = vscode.window.createWebviewPanel(
                'shopifyLiquidHtmlPreview',
                'HTML Preview: ' + path.basename(document.fileName),
                vscode.ViewColumn.Beside,
                // retainContextWhenHidden keeps the webview alive when its tab is
                // hidden, preserving scroll position and toggle state on return.
                // Scripts are needed only for the in-place update listener in
                // buildPreviewHtml; the preview content itself uses none.
                { enableScripts: true, localResourceRoots: workspaceFolders, retainContextWhenHidden: true }
            );

            htmlPreviews[preview.id] = { preview, panel };
            wirePreviewMessages(panel, { saveBuiltTest: message => saveBuiltTest(preview, panel, message) });

            await queueRefresh(preview, () => refreshHtmlPanel(preview, panel));

            panel.onDidDispose(() => {
                delete htmlPreviews[preview.id];
                clearPreviewDiagnostics(preview);
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.fullHtmlPreview', async () => {
        let document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (document) {
            let preview = createNewPreview(document);

            let workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
            let panel = vscode.window.createWebviewPanel(
                'shopifyLiquidFullHtmlPreview',
                'Full HTML Preview: ' + path.basename(document.fileName),
                vscode.ViewColumn.Beside,
                // retainContextWhenHidden keeps the webview alive when its tab is
                // hidden, preserving scroll position and toggle state on return.
                // Scripts are needed only for the in-place update listener in
                // buildPreviewHtml; the preview content itself uses none.
                { enableScripts: true, localResourceRoots: workspaceFolders, retainContextWhenHidden: true }
            );

            htmlFullPreviews[preview.id] = { preview, panel };
            wirePreviewMessages(panel);

            await queueRefresh(preview, () => refreshHtmlFullPanel(preview, panel));

            panel.onDidDispose(() => {
                delete htmlFullPreviews[preview.id];
                clearPreviewDiagnostics(preview);
            });
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (textDocumentChangeEvent) => {
        // Update text previews
        let documentPreviews = getDocumentPreviews(previewContentProvider, textDocumentChangeEvent.document);
        for (let documentPreview of documentPreviews) {
            if (documentPreview.isTemplate || documentPreview.isData) {
                // OR the flags in: a template edit that failed to parse leaves
                // templateDirty set, and a later edit to the data file must not
                // clear it or the stale template is never re-parsed.
                documentPreview.preview.templateDirty = documentPreview.preview.templateDirty || documentPreview.isTemplate;
                documentPreview.preview.dataDirty = documentPreview.preview.dataDirty || documentPreview.isData;

                previewContentProvider.onDidChangeEmitter.fire(documentPreview.preview.uri());
            }
        }

        // Update HTML previews
        for (let id in htmlPreviews) {
            let { preview, panel } = htmlPreviews[id];
            let isTemplate = preview.templateUri === textDocumentChangeEvent.document.fileName;
            let isData = preview.dataUri === textDocumentChangeEvent.document.fileName;
            if (isTemplate || isData) {
                preview.templateDirty = preview.templateDirty || isTemplate;
                preview.dataDirty = preview.dataDirty || isData;
                await queueRefresh(preview, () => refreshHtmlPanel(preview, panel));
            }
        }

        // Update full HTML previews
        for (let id in htmlFullPreviews) {
            let { preview, panel } = htmlFullPreviews[id];
            if (preview.templateUri === textDocumentChangeEvent.document.fileName) {
                await queueRefresh(preview, () => refreshHtmlFullPanel(preview, panel));
            }
        }
    }));

    templateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    templateStatusBarItem.show();
    context.subscriptions.push(templateStatusBarItem);

    dataStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    dataStatusBarItem.show();
    context.subscriptions.push(dataStatusBarItem);

    registerTemplateTests(context);
}

// Index just past the Liquid tag or expression starting at `i`, or the end of
// the text when it is never closed.
function skipLiquid(text, i) {
    const closeSeq = text[i + 1] === '%' ? '%}' : '}}';
    i += 2;
    while (i < text.length) {
        if (text[i] === closeSeq[0] && text[i + 1] === closeSeq[1]) return i + 2;
        i++;
    }
    return text.length;
}

// Locate the HTML element tag opening at `start` (where text[start] is '<') and
// return the index of its closing '>', or -1 when this '<' does not in fact open
// a tag. Quoted attribute values and whole Liquid regions are skipped, so a '>'
// inside either (e.g. {% if x > 3 %}) does not end the tag early.
//
// Rejecting non-tags matters as much as finding real ones: a '<' that is a
// comparison ({% if a<b %}), prose ("a<b"), or an element whose '>' has not been
// typed yet must not put the scanner into attribute mode, or every Liquid tag up
// to the next '>' — or to the end of the file — is discarded as attribute-level
// logic. Losing an {% endfor %} or {% endif %} that way leaves the block open, so
// it swallows the rest of the document.
function matchHtmlTag(text, start) {
    let j = start + 1;
    if (text[j] === '/') j++;
    if (!/[a-zA-Z!]/.test(text[j] || '')) return -1;

    let quote = null;
    while (j < text.length) {
        const ch = text[j];
        if (quote !== null) {
            if (ch === quote) quote = null;
            j++;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            j++;
        } else if (ch === '{' && (text[j + 1] === '%' || text[j + 1] === '{')) {
            j = skipLiquid(text, j);
        } else if (ch === '<') {
            return -1; // an unquoted '<' cannot appear inside a tag
        } else if (ch === '>') {
            return j;
        } else {
            j++;
        }
    }
    return -1; // no closing '>' — not a tag
}

// Drop the Liquid tags and expressions from within a single HTML element tag,
// keeping everything else — including quoted attribute values — verbatim.
function stripLiquidInsideHtmlTag(tag) {
    let result = '';
    let i = 0;
    while (i < tag.length) {
        if (tag[i] === '{' && (tag[i + 1] === '%' || tag[i + 1] === '{')) {
            i = skipLiquid(tag, i);
        } else {
            result += tag[i];
            i++;
        }
    }
    return result;
}

function stripLiquidFromHtmlTags(text) {
    // Remove liquid tags/expressions that appear inside HTML element open/close tags
    // (attribute-level liquid). These modify HTML structure rather than producing
    // standalone output. Everything else — Liquid between elements above all — is
    // passed through untouched.
    let result = '';
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        // Liquid outside an element tag is kept, and skipped as a unit so a '<'
        // inside it is never read as markup.
        if (ch === '{' && (text[i + 1] === '%' || text[i + 1] === '{')) {
            const end = skipLiquid(text, i);
            result += text.slice(i, end);
            i = end;
            continue;
        }

        // HTML comments are copied verbatim: their body is not an element tag, so
        // any Liquid inside it is left for the caller to interpret.
        if (ch === '<' && text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i);
            const close = end === -1 ? text.length : end + 3;
            result += text.slice(i, close);
            i = close;
            continue;
        }

        if (ch === '<') {
            const end = matchHtmlTag(text, i);
            if (end !== -1) {
                result += stripLiquidInsideHtmlTag(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }

        result += ch;
        i++;
    }

    return result;
}

// Turn an identifier like 'patient.first_name' or 'ownerName' into readable words.
function humanizeName(name) {
    if (!name) return '';
    return String(name)
        .replace(/\[["']?/g, '.')
        .replace(/["']?\]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
}

// Translate a Liquid condition into plain English, e.g.
// "patient.sex == 'male' and age > 8" → 'patient sex is “male” and age is more than 8'
function humanizeCondition(cond) {
    let c = String(cond).trim();
    c = c.replace(/'([^']*)'/g, '“$1”').replace(/"([^"]*)"/g, '“$1”');
    c = c.replace(/>=/g, ' is at least ')
        .replace(/<=/g, ' is at most ')
        .replace(/!=/g, ' is not ')
        .replace(/==/g, ' is ')
        .replace(/>/g, ' is more than ')
        .replace(/</g, ' is less than ');
    // dotted / underscored / camelCase identifiers → spaced words
    c = c.replace(/\b\w+(?:[._]\w+)+\b/g, m => humanizeName(m));
    c = c.replace(/\b[a-z]+[A-Z]\w*\b/g, m => humanizeName(m));
    return c.replace(/\s+/g, ' ').trim();
}

// Build a colour-coded pill label, optionally followed by an explanatory detail.
function annotationLabel(labelText, detailText) {
    const detail = detailText ? `<span class="lp-detail">${escapeHtml(detailText)}</span>` : '';
    return `<span class="lp-label">${escapeHtml(labelText)}</span>${detail}`;
}

// Rewrite a Liquid template into an annotated, layman-readable HTML document:
// every choice, optional section, fill-in field and automatic rule is shown as a
// labelled box, and data placeholders appear inline as chips. Returns the HTML
// plus counts of each construct for the summary header.
function annotateLiquid(text) {
    const stats = { choices: 0, options: 0, optionals: 0, editors: 0, conditionals: 0, loops: 0, notes: 0, variables: 0, unclosed: 0 };

    // Protect literal text so it is not mistaken for live Liquid constructs below.
    const neutralizeBraces = s => s.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

    // Step 1: remove liquid embedded within HTML element tags (attribute-level logic).
    // These modify HTML structure rather than producing standalone output.
    text = stripLiquidFromHtmlTags(text);

    // Step 2: capture blocks store output in a variable and render nothing here.
    text = text.replace(/\{%-?\s*capture\b[\s\S]*?\{%-?\s*endcapture\s*-?%\}/g, '');

    // Step 3: comments → author-note box (processed before the tag scan so their
    // bodies are not mistaken for live Liquid constructs).
    text = text.replace(/\{%-?\s*comment\s*-?%\}([\s\S]*?)\{%-?\s*endcomment\s*-?%\}/g, (_, body) => {
        stats.notes++;
        return `<div class="lp-note">${annotationLabel('Author note')}${neutralizeBraces(escapeHtml(body.trim()))}</div>`;
    });

    // raw blocks output their body as literal text.
    text = text.replace(/\{%-?\s*raw\s*-?%\}([\s\S]*?)\{%-?\s*endraw\s*-?%\}/g, (_, body) => neutralizeBraces(body));

    // Step 4: single pass over all {% ... %} tags with a stack of frames, so
    // labels and option numbering stay correct even when constructs are nested.
    // Each frame buffers its body rather than emitting markup immediately, so
    // logic-only blocks — loops and conditionals whose bodies produce nothing
    // visible (e.g. they only set up variables) — are dropped entirely instead
    // of cluttering the document as empty boxes. Stats therefore count only
    // the constructs that remain visible.
    const root = { html: '' };
    const stack = [];
    const peek = () => stack[stack.length - 1];
    const append = s => { (peek() || root).html += s; };
    const hasVisibleContent = html => /\S/.test(html);

    // The end tag each block type expects, for the unclosed-block notice.
    const END_TAGS = { choice: 'endchoice', optional: 'endoptional', editor: 'endeditor', if: 'endif', case: 'endcase', for: 'endfor', tablerow: 'endtablerow' };

    // Render a completed frame to HTML. Returns '' for hidden logic-only blocks.
    // A frame still open at the end of the template has absorbed everything after
    // it — the usual cause of a section that appears to run on past the end of the
    // document — so it is labelled rather than rendered as if it were intentional.
    const closeFrame = frame => {
        const html = renderFrame(frame);
        if (!frame.unclosed || !html) return html;
        stats.unclosed++;
        const detail = `no {% ${END_TAGS[frame.type] || 'end'} %} was found, so the rest of the document is inside it`;
        return `<div class="lp-unclosed">${annotationLabel('Not closed', detail)}${html}</div>`;
    };

    const renderFrame = frame => {
        switch (frame.type) {
            case 'choice': {
                frame.options.push(frame.html);
                stats.choices++;
                stats.options += frame.options.length;
                const optionsHtml = frame.options
                    .map((body, i) => `<div class="lp-option"><span class="lp-opt-label">Option ${i + 1}</span>${body}</div>`)
                    .join('');
                return `<div class="lp-choice"><div class="lp-choice-head">${frame.head}</div>${optionsHtml}</div>`;
            }
            case 'optional':
                stats.optionals++;
                return `<div class="lp-optional">${frame.label}${frame.html}</div>`;
            case 'editor':
                stats.editors++;
                return `<div class="lp-editor">${frame.label}${frame.html}</div>`;
            case 'if':
            case 'case': {
                if (frame.label !== null) frame.branches.push({ label: frame.label, html: frame.html });
                const kept = frame.branches.filter(b => hasVisibleContent(b.html));
                if (kept.length === 0) return '';
                stats.conditionals++;
                return `<div class="lp-cond">${kept.map(b => `<div class="lp-branch">${b.label}${b.html}</div>`).join('')}</div>`;
            }
            case 'for':
            case 'tablerow': {
                // With {% else %}, the buffered html is the empty-collection body
                // and the repeated body was set aside when the else was reached.
                const body = frame.emptyLabel ? frame.body : frame.html;
                const empty = frame.emptyLabel ? frame.html : '';
                let out = '';
                if (hasVisibleContent(body)) {
                    stats.loops++;
                    out += `<div class="lp-loop">${frame.label}${body}</div>`;
                }
                if (hasVisibleContent(empty)) {
                    stats.conditionals++;
                    out += `<div class="lp-cond"><div class="lp-branch">${frame.emptyLabel}${empty}</div></div>`;
                }
                return out;
            }
        }
        return frame.html;
    };

    // Close the nearest open frame of `type`, rendering any frames left open
    // inside it on the way out. An end tag with no matching frame open is a
    // stray and is ignored. Closing only an exactly-matching top frame is not
    // enough: a single mismatched end tag then left its block open, so the
    // block ran on and swallowed everything after it — a loop, for instance,
    // appearing to repeat well past the end of the document.
    const closeBlock = type => {
        if (!stack.some(frame => frame.type === type)) return;
        for (;;) {
            const frame = stack.pop();
            append(closeFrame(frame));
            if (frame.type === type) return;
        }
    };

    const tagRegex = /\{%-?\s*(\w+)([\s\S]*?)-?%\}/g;
    let lastIndex = 0;
    let match;
    while ((match = tagRegex.exec(text)) !== null) {
        append(text.slice(lastIndex, match.index));
        lastIndex = tagRegex.lastIndex;
        const tag = match[1];
        const rest = match[2].trim();
        switch (tag) {
            case 'choice': {
                const args = parseTagArgs(rest);
                const what = args.title || humanizeName(args.name || args.nameVar);
                stack.push({ type: 'choice', head: annotationLabel('Choose one', what), options: [], html: '' });
                break;
            }
            case 'or': {
                const frame = peek();
                if (frame && frame.type === 'choice') {
                    frame.options.push(frame.html);
                    frame.html = '';
                }
                break;
            }
            case 'endchoice':
                closeBlock('choice');
                break;
            case 'optional': {
                const args = parseTagArgs(rest);
                stack.push({ type: 'optional', label: annotationLabel('Optional', humanizeName(args.name || args.nameVar)), html: '' });
                break;
            }
            case 'endoptional':
                closeBlock('optional');
                break;
            case 'editor': {
                const args = parseTagArgs(rest);
                const what = args.placeholder || humanizeName(args.name || args.nameVar);
                stack.push({ type: 'editor', label: annotationLabel('Fill in', what), html: '' });
                break;
            }
            case 'endeditor':
                closeBlock('editor');
                break;
            case 'if':
                stack.push({ type: 'if', branches: [], label: annotationLabel('Shown when', humanizeCondition(rest)), html: '' });
                break;
            case 'unless':
                stack.push({ type: 'if', branches: [], label: annotationLabel('Shown unless', humanizeCondition(rest)), html: '' });
                break;
            case 'elsif': {
                const frame = peek();
                if (frame && frame.type === 'if') {
                    frame.branches.push({ label: frame.label, html: frame.html });
                    frame.label = annotationLabel('Otherwise, when', humanizeCondition(rest));
                    frame.html = '';
                }
                break;
            }
            case 'else': {
                const frame = peek();
                if (frame && (frame.type === 'if' || frame.type === 'case')) {
                    if (frame.label !== null) frame.branches.push({ label: frame.label, html: frame.html });
                    frame.label = annotationLabel('Otherwise');
                    frame.html = '';
                } else if (frame && (frame.type === 'for' || frame.type === 'tablerow') && !frame.emptyLabel) {
                    // A loop's else body shows when there is nothing to repeat over,
                    // so it is a separate section rather than part of the repeated body.
                    frame.emptyLabel = annotationLabel('If there are none');
                    frame.body = frame.html;
                    frame.html = '';
                }
                break;
            }
            case 'endif':
            case 'endunless':
                closeBlock('if');
                break;
            case 'case':
                // label stays null (and the buffered text is discarded) until the
                // first 'when' — Liquid ignores content between case and when.
                stack.push({ type: 'case', subject: humanizeCondition(rest), branches: [], label: null, html: '' });
                break;
            case 'when': {
                const frame = peek();
                if (frame && frame.type === 'case') {
                    if (frame.label !== null) frame.branches.push({ label: frame.label, html: frame.html });
                    frame.label = annotationLabel('When', `${frame.subject} is ${humanizeCondition(rest)}`);
                    frame.html = '';
                }
                break;
            }
            case 'endcase':
                closeBlock('case');
                break;
            case 'for':
            case 'tablerow': {
                const m = rest.match(/^(\S+)\s+in\s+([\s\S]+)$/);
                const detail = m
                    ? `once for each ${humanizeName(m[1])} in ${humanizeCondition(m[2].split('|')[0])}`
                    : humanizeCondition(rest);
                stack.push({ type: tag, label: annotationLabel('Repeats', detail), html: '' });
                break;
            }
            case 'endfor':
                closeBlock('for');
                break;
            case 'endtablerow':
                closeBlock('tablerow');
                break;
            default:
                // assign, increment, decrement, render, include, cycle, break, … – no visible output
                break;
        }
    }
    append(text.slice(lastIndex));

    // Close any blocks left open (e.g. while the template is being edited).
    while (stack.length) {
        const frame = stack.pop();
        frame.unclosed = true;
        append(closeFrame(frame));
    }
    text = root.html;

    // Step 5: output expressions → inline data chips, so sentences stay readable
    // instead of having invisible holes where values would go.
    text = text.replace(/\{\{-?([\s\S]*?)-?\}\}/g, (_, expr) => {
        expr = expr.split('|')[0].trim();
        const literal = expr.match(/^'([^']*)'$|^"([^"]*)"$/);
        if (literal) return escapeHtml(literal[1] !== undefined ? literal[1] : literal[2]);
        if (!expr) return '';
        stats.variables++;
        return `<span class="lp-var">${escapeHtml(humanizeName(expr))}</span>`;
    });

    return { html: text, stats };
}

function joinWithAnd(parts) {
    if (parts.length <= 1) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// Header shown above the annotated document: what it is, what it contains,
// and a plain-English key to the colour-coded markers. Used both in the
// webview and in the standalone export (which is why it carries no controls).
function buildFullPreviewHeader(templateUri, stats) {
    const fileName = templateUri ? path.basename(templateUri) : '';

    const summaryParts = [];
    if (stats.choices) summaryParts.push(`${pluralize(stats.choices, 'multiple-choice section')} (${pluralize(stats.options, 'option')} in total)`);
    if (stats.optionals) summaryParts.push(pluralize(stats.optionals, 'optional section'));
    if (stats.editors) summaryParts.push(pluralize(stats.editors, 'fill-in field'));
    if (stats.conditionals) summaryParts.push(pluralize(stats.conditionals, 'automatic section'));
    if (stats.loops) summaryParts.push(pluralize(stats.loops, 'repeating section'));
    if (stats.variables) summaryParts.push(pluralize(stats.variables, 'data value', 'data values'));
    const summary = summaryParts.length
        ? `This document contains ${joinWithAnd(summaryParts)}.`
        : 'This document has no options — it always reads exactly as shown below.';

    // An unclosed block absorbs everything after it, which is why the document
    // below can appear to run on past its end. Say so up front.
    const unclosedNotice = stats.unclosed
        ? `<div class="lp-warn">${pluralize(stats.unclosed, 'section is', 'sections are')} missing an end tag, so the content after ${stats.unclosed === 1 ? 'it' : 'them'} has been drawn inside. Look for the red “Not closed” markers below.</div>`
        : '';

    const legendRows = [];
    const legendRow = (cls, label, description) =>
        `<span class="lp-label ${cls}">${label}</span><span>${description}</span>`;
    if (stats.choices) legendRows.push(legendRow('lg-choice', 'Choose one', 'The writer picks exactly one of the numbered options.'));
    if (stats.optionals) legendRows.push(legendRow('lg-optional', 'Optional', 'The writer can include this content or leave it out.'));
    if (stats.editors) legendRows.push(legendRow('lg-editor', 'Fill in', 'The writer types this in; any text shown is the starting suggestion.'));
    if (stats.conditionals) legendRows.push(legendRow('lg-cond', 'Shown when…', 'Included automatically when the stated condition applies.'));
    if (stats.loops) legendRows.push(legendRow('lg-loop', 'Repeats', 'This section appears once for each item in a list.'));
    if (stats.variables) legendRows.push(`<span class="lp-var">example value</span><span>Filled in automatically from the case data.</span>`);
    // The note legend row hides together with the notes themselves (see .lp-legend-note CSS).
    if (stats.notes) legendRows.push(`<span class="lp-legend-note">${legendRow('lg-note', 'Author note', 'Guidance for template authors — never appears in the finished document.')}</span>`);

    const legend = legendRows.length
        ? `<details class="lp-legend" open><summary>What the markers mean</summary><div class="lp-legend-grid">${legendRows.join('')}</div></details>`
        : '';

    return `<div class="lp-header">
<div class="lp-doc-title">Document options${fileName ? ' — ' + escapeHtml(fileName) : ''}</div>
<div class="lp-summary">${summary}</div>
${unclosedNotice}
${legend}
</div>`;
}

// "Show HTML source" toggle plumbing shared by both HTML previews. Webview
// scripts are disabled, so the swap is wired up purely with CSS body:has().
// The rendered document keeps its white page (it previews the finished,
// printed document), but the source view follows the VS Code theme via the
// --vscode-* variables the editor injects into webviews; the fallbacks keep
// the rules harmless outside VS Code (e.g. in the standalone export).
const viewSourceStyles = `
  #lp-chrome { display: contents; }
  .lp-toolbar { position: sticky; top: 0; z-index: 9000; display: flex; flex-wrap: wrap; gap: 6px 18px; background: white; margin: -8px -8px 10px -8px; padding: 8px 10px; border-bottom: 1px solid #e0e0e0; }
  .lp-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #444; cursor: pointer; user-select: none; }
  .lp-toggle input { margin: 0; }
  .lp-action { margin-left: auto; font: 12px sans-serif; color: #444; background: #f3f3f3; border: 1px solid #d0d0d0; border-radius: 3px; padding: 1px 8px; cursor: pointer; }
  .lp-action:hover { background: #e8e8e8; }
  .lp-source { display: none; }
  .lp-source-hint { font-family: sans-serif; font-size: 12px; color: var(--vscode-descriptionForeground, #444); margin-bottom: 8px; }
  .lp-source pre { background: none; border: none; margin: 0; padding: 2px 4px; color: var(--vscode-editor-foreground, #333); font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Menlo, Consolas, monospace); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.5; white-space: pre-wrap; word-break: break-word; cursor: text; }

  .lp-tk-tag, .lp-tk-doctype, .lp-tk-punct { color: #800000; }
  .lp-tk-attr { color: #e50000; }
  .lp-tk-str { color: #0000ff; }
  .lp-tk-comment { color: #008000; }
  body.vscode-dark .lp-tk-tag, body.vscode-dark .lp-tk-doctype,
  body.vscode-high-contrast .lp-tk-tag, body.vscode-high-contrast .lp-tk-doctype { color: #569cd6; }
  body.vscode-dark .lp-tk-punct, body.vscode-high-contrast .lp-tk-punct { color: #808080; }
  body.vscode-dark .lp-tk-attr, body.vscode-high-contrast .lp-tk-attr { color: #9cdcfe; }
  body.vscode-dark .lp-tk-str, body.vscode-high-contrast .lp-tk-str { color: #ce9178; }
  body.vscode-dark .lp-tk-comment, body.vscode-high-contrast .lp-tk-comment { color: #6a9955; }
  body:has(#lp-show-source:checked) { background-color: var(--vscode-editor-background, white); }
  body:has(#lp-show-source:checked) .lp-toggle { color: var(--vscode-foreground, #444); }
  body:has(#lp-show-source:checked) .lp-toolbar { background: var(--vscode-editor-background, white); border-bottom-color: var(--vscode-panel-border, #e0e0e0); }
  body:has(#lp-show-source:checked) #lp-rendered-root,
  body:has(#lp-show-source:checked) #lp-rendered-root ~ * { display: none; }
  body:has(#lp-show-source:checked) .lp-source { display: block; }`;

const htmlPreviewStyles = `
  .rlp-markdown > :first-child { margin-top: 0; }
  .rlp-markdown > :last-child { margin-bottom: 0; }
  .editor { border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .editor:has(input[type="checkbox"]) { border: 2px dashed #388e3c; background: #f1f8e9; }
  .editor:has(input[type="radio"]) { border: 2px solid #1976d2; background: #e3f2fd; }
  .editor:has(input[type="text"]), .editor:has(textarea) { border: 2px solid #f57c00; background: #fff8e1; }
  .editor:has(input[type="radio"]) label { display: block; padding: 6px 10px; margin: 4px 0; border: 1px solid #90caf9; border-radius: 3px; background: white; }
  .editor-intro { display: block; font-size: 11px; font-weight: bold; font-family: sans-serif; margin-bottom: 4px; }`
    + viewSourceStyles;

const fullPreviewStyles = `
  .lp-label { display: inline-block; font-family: sans-serif; font-size: 10px; font-weight: bold; line-height: 1.7; text-transform: uppercase; letter-spacing: 0.4px; color: white; padding: 0 8px; border-radius: 9px; margin-right: 8px; vertical-align: middle; }
  .lp-detail { font-family: sans-serif; font-size: 12px; font-style: italic; color: #555; margin-right: 6px; vertical-align: middle; }

  .lp-header { font-family: sans-serif; border: 1px solid #ddd; border-radius: 8px; background: #fafafa; padding: 12px 16px; margin: 0 0 18px 0; }
  .lp-doc-title { font-size: 16px; font-weight: bold; color: #222; }
  .lp-summary { font-size: 12.5px; color: #444; margin: 5px 0 4px 0; }
  .lp-legend { margin-top: 6px; }
  .lp-legend summary { font-size: 11.5px; font-weight: bold; color: #666; cursor: pointer; }
  .lp-legend-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 10px; align-items: center; font-size: 12px; color: #333; margin-top: 8px; }
  .lg-choice { background: #1976d2; }
  .lg-optional { background: #388e3c; }
  .lg-editor { background: #ef6c00; }
  .lg-cond { background: #7b1fa2; }
  .lg-loop { background: #00796b; }
  .lg-note { background: #9e9e9e; }

  .lp-choice { border: 1px solid #90caf9; border-radius: 6px; margin: 10px 0; overflow: hidden; background: white; }
  .lp-choice-head { background: #e3f2fd; border-bottom: 1px solid #bbdefb; padding: 5px 10px; }
  .lp-choice .lp-label { background: #1976d2; }
  .lp-option { padding: 6px 12px; }
  .lp-option + .lp-option { border-top: 1px dashed #90caf9; }
  .lp-opt-label { display: inline-block; font-family: sans-serif; font-size: 10px; font-weight: bold; color: #1565c0; background: #e3f2fd; border: 1px solid #90caf9; padding: 1px 8px; border-radius: 9px; margin: 2px 8px 2px 0; vertical-align: middle; }

  .lp-optional { border: 1px dashed #81c784; border-left: 4px solid #43a047; border-radius: 0 6px 6px 0; background: #f1f8e9; padding: 6px 10px; margin: 10px 0; }
  .lp-optional .lp-label { background: #388e3c; }

  .lp-editor { border: 1px solid #ffcc80; border-left: 4px solid #ef6c00; border-radius: 0 6px 6px 0; background: #fff8e1; padding: 6px 10px; margin: 10px 0; }
  .lp-editor .lp-label { background: #ef6c00; }

  .lp-cond { border: 1px solid #ce93d8; border-radius: 6px; margin: 10px 0; overflow: hidden; background: #faf5fb; }
  .lp-cond > .lp-branch { padding: 6px 12px; }
  .lp-branch + .lp-branch { border-top: 1px dashed #ce93d8; }
  .lp-cond .lp-label { background: #7b1fa2; }

  .lp-loop { border: 1px solid #80cbc4; border-left: 4px solid #00796b; border-radius: 0 6px 6px 0; background: #e0f2f1; padding: 6px 10px; margin: 10px 0; }
  .lp-loop .lp-label { background: #00796b; }

  .lp-note { border: 1px dashed #bdbdbd; border-radius: 6px; background: #f5f5f5; color: #616161; font-style: italic; font-size: 12px; padding: 4px 10px; margin: 8px 0; }
  .lp-note .lp-label { background: #9e9e9e; font-style: normal; }

  .lp-legend-note { display: contents; }
  body:has(#lp-show-notes:not(:checked)) .lp-note,
  body:has(#lp-show-notes:not(:checked)) .lp-legend-note { display: none; }

  .lp-warn { font-family: sans-serif; font-size: 12.5px; color: #b71c1c; background: #ffebee; border: 1px solid #ef9a9a; border-radius: 6px; padding: 5px 10px; margin: 6px 0 4px 0; }

  .lp-unclosed { border: 1px solid #ef9a9a; border-radius: 6px; background: #fff5f5; padding: 6px 10px; margin: 10px 0; }
  .lp-unclosed > .lp-label { background: #c62828; }

  .lp-var { display: inline; background: #eceff1; border: 1px solid #cfd8dc; border-radius: 4px; padding: 0 5px; color: #37474f; font-style: italic; white-space: nowrap; }`
    + viewSourceStyles + `
  .lp-source pre { user-select: all; }`;

// A complete standalone HTML document for the annotated view: preview styles
// and any external CSS are inlined, so the file works on its own (e.g. pasted
// into SharePoint or saved as an .html file).
function buildStandaloneHtml(content, cssText) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { background-color: white; color: black; margin: 0; padding: 16px; box-sizing: border-box; }
  h1, h2, h3, h4, h5, h6 { color: black; }${fullPreviewStyles}
${cssText}
</style>
</head>
<body>
${content}
</body>
</html>`;
}

// Syntax-highlight a tag's markup: punctuation, tag name, attribute names and
// quoted values each get a token span. All token text is escaped, and the
// combined textContent of the output equals the input exactly — the
// scroll-sync script and copy behaviour rely on that.
function highlightTagMarkup(text) {
    const m = text.match(/^(<\/?)([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!m) return `<span class="lp-tk-punct">${escapeHtml(text)}</span>`;
    let out = `<span class="lp-tk-punct">${escapeHtml(m[1])}</span><span class="lp-tk-tag">${escapeHtml(m[2])}</span>`;
    const rest = text.slice(m[0].length);
    let j = 0;
    while (j < rest.length) {
        const c = rest[j];
        if (/\s/.test(c)) {
            let k = j;
            while (k < rest.length && /\s/.test(rest[k])) k++;
            out += rest.slice(j, k);
            j = k;
        } else if (c === '"' || c === "'") {
            let k = rest.indexOf(c, j + 1);
            k = k === -1 ? rest.length : k + 1;
            out += `<span class="lp-tk-str">${escapeHtml(rest.slice(j, k))}</span>`;
            j = k;
        } else if (c === '=' || c === '>' || c === '/') {
            out += `<span class="lp-tk-punct">${escapeHtml(c)}</span>`;
            j++;
        } else {
            let k = j;
            while (k < rest.length && !/[\s=>\/"']/.test(rest[k])) k++;
            out += `<span class="lp-tk-attr">${escapeHtml(rest.slice(j, k))}</span>`;
            j = k;
        }
    }
    return out;
}

// Convert HTML source text into escaped, token-coloured markup for the source
// views, so the source reads like VS Code's own HTML highlighting. Colours
// follow the editor's default light/dark themes (see the .lp-tk-* rules).
function highlightHtml(html) {
    let out = '';
    for (const tok of tokenizeHtml(html)) {
        if (tok.type === 'text') {
            out += escapeHtml(tok.text);
        } else if (tok.type === 'raw') {
            out += highlightTagMarkup(tok.openTag) + escapeHtml(tok.body)
                + (tok.closeTag ? highlightTagMarkup(tok.closeTag) : '');
        } else if (tok.kind === 'comment') {
            out += `<span class="lp-tk-comment">${escapeHtml(tok.text)}</span>`;
        } else if (tok.kind === 'doctype') {
            out += `<span class="lp-tk-doctype">${escapeHtml(tok.text)}</span>`;
        } else {
            out += highlightTagMarkup(tok.text);
        }
    }
    return out;
}

// Content of the Full HTML Preview webview, split into two parts: 'chrome' is
// the extension's own markup — header with view toggles and the hidden panel
// holding the standalone HTML source — and 'rendered' is the annotated
// document. They are kept in separate containers (chrome first) so malformed
// HTML in the template — stray closing tags, unclosed elements — can never
// swallow or break out into the extension's UI when the browser parses it.
function buildFullPreviewContent(templateText, templateUri) {
    const { html, stats } = annotateLiquid(templateText);
    const cssText = readCssContents(templateUri);

    const exportContent = buildFullPreviewHeader(templateUri, stats) + html;
    const standalone = buildStandaloneHtml(exportContent, cssText);

    // The toggles are plain checkboxes wired up purely with CSS
    // (body:has(...) rules in fullPreviewStyles).
    const toggles = [];
    if (stats.notes) {
        toggles.push(`<label class="lp-toggle"><input type="checkbox" id="lp-show-notes" checked=""> Show ${pluralize(stats.notes, 'author note')}</label>`);
    }
    toggles.push(`<label class="lp-toggle"><input type="checkbox" id="lp-show-source"> Show HTML source</label>`);
    const toolbar = `<div class="lp-toolbar">${toggles.join('')}</div>`;

    const sourcePanel = `<div class="lp-source">
<div class="lp-source-hint">Standalone HTML for this document — styles are included, so it works on its own. Click the code below to select it all, copy, and paste into SharePoint or save as an .html file.</div>
<pre>${highlightHtml(formatHtml(standalone))}</pre>
</div>`;

    return {
        chrome: toolbar + buildFullPreviewHeader(templateUri, stats) + sourcePanel,
        rendered: html
    };
}

async function refreshHtmlFullPanel(preview, panel) {
    let diagnostics = [];
    let content = null;

    try {
        let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
        let templateText = templateDocument.getText();
        // The annotated view is built by its own scanner, which recovers from a
        // missing end tag instead of failing on it — so it can say that a
        // section is unclosed, but not which line to go and fix. Parse the
        // template as well, purely to borrow LiquidJS's exact position for the
        // first structural problem.
        try {
            liquidEngine.parse(templateText);
        } catch (err) {
            diagnostics.push(liquidDiagnostic('Template error', err, preview.templateUri));
        }
        content = buildFullPreviewContent(templateText, preview.templateUri);
        preview.lastRenderedHtml = content;
    } catch (err) {
        diagnostics.push(liquidDiagnostic('Template error', err, preview.templateUri));
        content = preview.lastRenderedHtml || { chrome: '', rendered: '' };
    }

    publishDiagnostics(preview, diagnostics);
    updatePreviewPanel(panel, preview, content.chrome + buildErrorPaneHtml(diagnostics), content.rendered, fullPreviewStyles);
}

// Run panel refreshes for one preview one at a time. The change handler is
// async and fires on every keystroke, so without a queue two refreshes overlap:
// they race on the shared warning buffer, and whichever render finishes last
// wins, which can leave the pane showing an older version of the template.
function queueRefresh(preview, run) {
    const next = (preview.refreshQueue || Promise.resolve()).then(run, run);
    preview.refreshQueue = next.catch(() => { });
    return next;
}

// Push new content into a preview panel: the first call sets the full webview
// document, later calls patch it in place via a message (see buildPreviewHtml)
// so the view isn't reloaded on every edit.
function updatePreviewPanel(panel, preview, chrome, rendered, styles, builder = null) {
    rendered = balanced(rendered);
    if (panel._rlpInitialized) {
        panel.webview.postMessage({ type: 'update', chrome, rendered });
    } else {
        let cssLinks = buildCssLinks(preview.templateUri, panel.webview);
        panel.webview.html = buildPreviewHtml(cssLinks, chrome, rendered, styles, builder);
        panel._rlpInitialized = true;
    }
}

// Output as the preview displays it (see asPreviewShowsIt): the tree the
// checks see, with every element closed and stray closing tags dropped, so no
// stray </div> can close the preview's own container. Falls back to the output
// as it is if it can't be parsed, rather than showing nothing.
function balanced(html) {
    try {
        return asPreviewShowsIt(html);
    } catch (err) {
        return html;
    }
}

// A warning for each closing tag in the output that closes nothing it opened.
// The preview drops them, but a browser showing the whole page — Reporter's —
// may let one close an element around the document, and everything after it
// falls out of its section. There is no template line to point at (the tag may
// come from anywhere, loops included), so the text after it says where.
function strayTagDiagnostics(rendered, file) {
    return strayClosingTags(rendered).map(stray => diagnostic(
        'warning',
        'Unbalanced HTML',
        `The output has a ${stray.tag} that closes nothing it opened${stray.followedBy ? `, just before \u201c${stray.followedBy}\u201d` : ', at the end'}. `
            + `The preview ignores it, but a browser showing the whole page may close the wrong element there and push the rest of the document out of its section. `
            + `Remove the extra ${stray.tag} from the template (Show HTML source shows the output around it).`,
        file,
        null
    ));
}

async function refreshHtmlPanel(preview, panel) {
    let diagnostics = [];
    // Set when the file on disk no longer parses: the render below then runs
    // against the last version that did, so anything it reports describes a
    // template that is no longer there. Those positions would send the reader
    // to whatever now sits on that line, so they are dropped and only the parse
    // error — which is current, and the thing to fix — is reported.
    let templateIsStale = false;

    if (preview.templateUri && preview.templateDirty) {
        try {
            let templateDocument = await vscode.workspace.openTextDocument(preview.templateUri);
            preview.template = liquidEngine.parse(templateDocument.getText());
            preview.templateDirty = false;
        } catch (err) {
            // Keep the previously parsed template so rendering can still proceed
            diagnostics.push(liquidDiagnostic('Template error', err, preview.templateUri));
            templateIsStale = true;
        }
    }

    if (preview.dataUri && preview.dataDirty) {
        let dataText = '';
        try {
            let dataDocument = await vscode.workspace.openTextDocument(preview.dataUri);
            dataText = dataDocument.getText();
            preview.data = JSON.parse(dataText);
            preview.dataDirty = false;
        } catch (err) {
            // Keep the previously parsed data so rendering can still proceed
            diagnostics.push(jsonDiagnostic('Data error', err, dataText, preview.dataUri));
        }
    }

    let rendered;
    try {
        const result = await renderWithDiagnostics(preview.template, preview.data, preview.templateUri);
        rendered = result.rendered;
        preview.lastRenderedHtml = rendered;
        if (!templateIsStale) diagnostics.push(...result.diagnostics, ...strayTagDiagnostics(rendered, preview.templateUri));
    } catch (err) {
        if (!templateIsStale) diagnostics.push(liquidDiagnostic('Render error', err, preview.templateUri));
        rendered = preview.lastRenderedHtml || '';
    }

    publishDiagnostics(preview, diagnostics);
    const defaultName = preview.dataUri ? path.basename(preview.dataUri, path.extname(preview.dataUri)) : '';
    updatePreviewPanel(panel, preview, buildHtmlPreviewChrome(rendered) + buildErrorPaneHtml(diagnostics), rendered, htmlPreviewStyles, { defaultName });
}

// The HTML Preview's own UI: a toolbar with a source toggle and a hidden
// panel with the document's underlying HTML — the same render currently in
// view, so it reflects the selected data and field values. Kept separate from
// the rendered document itself (see buildPreviewHtml).
function buildHtmlPreviewChrome(rendered) {
    const toolbar = `<div class="lp-toolbar"><label class="lp-toggle"><input type="checkbox" id="lp-show-source"> Show HTML source</label>`
        + `<button type="button" class="lp-action" data-lp-local="build-test" title="Build a test by clicking the parts of this page that should stay the way they are">Create test&hellip;</button></div>`;
    const sourcePanel = `<div class="lp-source">
<div class="lp-source-hint">The HTML behind the view below, as rendered with the current data and field values.</div>
<pre>${highlightHtml(formatHtml(rendered))}</pre>
</div>`;
    return toolbar + sourcePanel;
}

function findCssPaths(templateUri) {
    const fs = require('fs');
    let cssPaths = [];

    // CSS files at workspace root(s)
    for (let folder of (vscode.workspace.workspaceFolders || [])) {
        let rootCss = path.join(folder.uri.fsPath, 'universal.css');
        if (fs.existsSync(rootCss)) {
            cssPaths.push(rootCss);
        }
    }

    // CSS files in a 'css/' folder alongside the template
    if (templateUri) {
        let templateDir = path.dirname(templateUri);
        let cssDir = path.join(templateDir, 'css');
        if (fs.existsSync(cssDir) && fs.statSync(cssDir).isDirectory()) {
            for (let file of fs.readdirSync(cssDir)) {
                if (file.endsWith('.css')) {
                    cssPaths.push(path.join(cssDir, file));
                }
            }
        }
    }

    return cssPaths;
}

function buildCssLinks(templateUri, webview) {
    return findCssPaths(templateUri)
        .map(p => {
            let uri = webview.asWebviewUri(vscode.Uri.file(p));
            return `<link rel="stylesheet" href="${uri}">`;
        })
        .join('\n');
}

// Concatenated contents of the workspace/template CSS files, for inlining into
// a standalone document.
function readCssContents(templateUri) {
    const fs = require('fs');
    return findCssPaths(templateUri)
        .map(p => `/* ${path.basename(p)} */\n${fs.readFileSync(p, 'utf8')}`)
        .join('\n');
}

// Collapse identical repeats into a single row with a count. A warning raised
// by a filter inside a loop fires once per iteration, and fifty copies of the
// same line push everything else out of a pane 200px tall.
function dedupeDiagnostics(diagnostics) {
    const byKey = new Map();
    for (const item of diagnostics) {
        const key = JSON.stringify([item.severity, item.title, item.message, item.file, item.line, item.col]);
        const existing = byKey.get(key);
        if (existing) existing.count++;
        else byKey.set(key, Object.assign({ count: 1 }, item));
    }
    return Array.from(byKey.values());
}

// The pane pinned to the bottom of the preview. Errors first, then warnings,
// each row carrying the position it came from as a button: the webview posts
// the position back and the extension opens the file there (see
// wirePreviewMessages).
function buildErrorPaneHtml(diagnostics) {
    if (!diagnostics || diagnostics.length === 0) return '';
    const rows = dedupeDiagnostics(diagnostics);
    const errors = rows.filter(d => d.severity !== 'warning');
    const warnings = rows.filter(d => d.severity === 'warning');

    const counts = [];
    if (errors.length) counts.push(pluralize(errors.length, 'error'));
    if (warnings.length) counts.push(pluralize(warnings.length, 'warning'));

    return `
<div id="error-pane">
  <div class="diag-head">
    <span class="diag-head-title">${joinWithAnd(counts)}</span>
    <label class="diag-collapse"><input type="checkbox" id="lp-hide-problems"> Hide</label>
  </div>
  <div class="diag-list">
${errors.concat(warnings).map(buildDiagnosticHtml).join('\n')}
  </div>
</div>`;
}

function buildDiagnosticHtml(item) {
    const icon = item.severity === 'warning' ? '&#9432;' : '&#9888;';
    const count = item.count > 1 ? `<span class="diag-count">&times;${item.count}</span>` : '';
    const snippet = item.snippet ? `<div class="diag-snippet">${escapeHtml(item.snippet)}</div>` : '';
    return `<div class="diag diag-${item.severity}">
  <div class="diag-line"><span class="diag-title">${icon} ${escapeHtml(item.title)}</span>${buildDiagnosticLocationHtml(item)}${count}</div>
  <pre class="diag-message">${escapeHtml(item.message)}</pre>
  ${snippet}
</div>`;
}

// The clickable position. Without a line there is nowhere to jump to, so what
// we do know is rendered as plain text rather than as a button that would do
// nothing when pressed.
function buildDiagnosticLocationHtml(item) {
    const name = item.file ? path.basename(item.file) : '';
    if (!item.line) return name ? `<span class="diag-where">${escapeHtml(name)}</span>` : '';
    const label = `${name ? name + ':' : 'line '}${item.line}:${item.col || 1}`;
    if (!item.file) return `<span class="diag-where">${escapeHtml(label)}</span>`;
    return `<button type="button" class="diag-where diag-goto"`
        + ` data-diag-file="${escapeHtml(item.file)}"`
        + ` data-diag-line="${item.line}" data-diag-col="${item.col || 1}"`
        + ` title="Go to line ${item.line} in ${escapeHtml(name)}">${escapeHtml(label)}</button>`;
}

// The Problems panel mirror of the pane, so the same positions show up as
// squiggles in the editor. Rows are held per preview — closing one preview must
// not wipe another's — and the whole collection is rebuilt on every change,
// because a DiagnosticCollection is keyed by file rather than by contributor.
let _diagnosticCollection = null;
const _previewDiagnostics = new Map();

function publishDiagnostics(preview, diagnostics) {
    _previewDiagnostics.set(preview.id, diagnostics.filter(d => d.file && d.line));
    republishDiagnostics();
}

function clearPreviewDiagnostics(preview) {
    _previewDiagnostics.delete(preview.id);
    republishDiagnostics();
}

function republishDiagnostics() {
    if (!_diagnosticCollection) return;
    const all = [];
    for (const diagnostics of _previewDiagnostics.values()) all.push(...diagnostics);

    const byFile = new Map();
    for (const item of dedupeDiagnostics(all)) {
        if (!byFile.has(item.file)) byFile.set(item.file, []);
        byFile.get(item.file).push(toVsCodeDiagnostic(item));
    }

    _diagnosticCollection.clear();
    for (const [file, items] of byFile) {
        _diagnosticCollection.set(vscode.Uri.file(file), items);
    }
}

// Underline the construct itself rather than a single character, so the
// squiggle covers the tag that went wrong. VS Code clamps a range that runs
// past the end of the line, which is what happens when the original spanned
// several lines and the snippet collapsed it onto one.
function toVsCodeDiagnostic(item) {
    const line = Math.max(0, item.line - 1);
    const col = Math.max(0, (item.col || 1) - 1);
    const range = new vscode.Range(line, col, line, col + Math.max(1, item.snippet.length));
    const severity = item.severity === 'warning'
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Error;
    const result = new vscode.Diagnostic(range, `${item.title}: ${item.message}`, severity);
    result.source = 'Reporter Liquid Preview';
    return result;
}

// Listen for the position a reader clicked in the problems pane and open it.
// `actions` maps an action the webview posts to what it does, and is handed
// the whole message — the HTML preview's test builder posts the test it built.
function wirePreviewMessages(panel, actions = {}) {
    panel.webview.onDidReceiveMessage(message => {
        if (message && message.type === 'reveal' && message.file) {
            revealInEditor(message.file, message.line, message.col);
        } else if (message && message.type === 'action' && typeof actions[message.action] === 'function') {
            actions[message.action](message);
        }
    });
}

// Show `file` with the caret at the given 1-based line and column. An editor
// already showing the file keeps its column, so clicking a problem does not
// shuffle the reader's layout around; otherwise the file opens in the first
// column rather than on top of the preview.
async function revealInEditor(file, line, col) {
    try {
        const document = await vscode.workspace.openTextDocument(file);
        const visible = vscode.window.visibleTextEditors
            .filter(editor => editor.document && editor.document.uri.fsPath === document.uri.fsPath)[0];
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: visible ? visible.viewColumn : vscode.ViewColumn.One,
            preview: false
        });
        const position = new vscode.Position(Math.max(0, (line || 1) - 1), Math.max(0, (col || 1) - 1));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
        vscode.window.showErrorMessage(`Reporter Liquid Preview: could not open ${file} (${err.message})`);
    }
}

// Full webview document. chrome (the extension's own UI, including the error
// pane) and rendered (the template's output) live in separate containers,
// with chrome first: nothing that precedes the template content in the parse
// can be damaged by its malformed HTML, and content escaping #lp-rendered-root
// only ever spills into following siblings, which the source-view CSS hides
// along with the container itself.
//
// The document is set once per panel; later renders are posted as 'update'
// messages and patched into the two containers by the script below, so a live
// edit doesn't reload the document — scroll position and toggle checkboxes
// survive it. Patching each container separately via innerHTML also uses
// fragment parsing, which cannot leak content outside its container.
function buildPreviewHtml(cssLinks, chrome, rendered, extraStyles = '', builder = null) {
    // The test builder's panel is a sibling placed before the chrome, so no
    // template markup can swallow it; its styles travel as inert text and are
    // applied inside its shadow root. The overlays that mark what is hovered
    // and picked are the only builder styles in the document itself.
    const builderHost = builder
        ? `<aside id="lp-builder" hidden data-default-name="${escapeHtml(builder.defaultName || '')}"></aside>
<script type="text/plain" id="lp-builder-styles">${BUILDER_STYLES}</script>`
        : '';
    const builderStyles = builder
        ? `
  body.lp-building { margin-right: 340px; }
  body.lp-building #lp-rendered-root { cursor: crosshair; }
  #lp-builder-hover, #lp-builder-pick { position: absolute; pointer-events: none; z-index: 9998; border-radius: 3px; }
  #lp-builder-hover { outline: 2px dashed #0078d4; background: rgba(0, 120, 212, 0.06); }
  #lp-builder-pick { outline: 2px solid #0078d4; background: rgba(0, 120, 212, 0.12); }
  .lp-builder-group { position: absolute; pointer-events: none; z-index: 9997; border-radius: 3px; outline: 2px solid #d18616; background: rgba(209, 134, 22, 0.12); }
  @media (max-width: 700px) { body.lp-building { margin-right: 0; padding-bottom: 56vh; } }`
        : '';
    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { background-color: white; color: black; margin: 0; padding: 8px; box-sizing: border-box; }
  body:has(#error-pane) { padding-bottom: 230px; }
  /* Collapsing the pane frees the space it was reserving. Same specificity as
     the rule above, so it has to come after it to win. */
  body:has(#lp-hide-problems:checked) { padding-bottom: 46px; }
  h1, h2, h3, h4, h5, h6 { color: black; }
  #error-pane { position: fixed; bottom: 0; left: 0; right: 0; display: flex; flex-direction: column; max-height: 220px; background: #1e1a10; border-top: 2px solid #f14c4c; font-family: sans-serif; z-index: 9999; }
  #error-pane:has(#lp-hide-problems:checked) .diag-list { display: none; }
  .diag-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 12px; }
  .diag-head-title { font-size: 12px; font-weight: bold; color: #e8d9b0; }
  .diag-collapse { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #b9ad8e; cursor: pointer; }
  .diag-list { overflow-y: auto; padding: 0 12px 8px 12px; }
  .diag { margin-bottom: 8px; }
  .diag:last-child { margin-bottom: 0; }
  .diag-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; margin-bottom: 2px; }
  .diag-title { font-size: 12px; font-weight: bold; color: #f14c4c; }
  .diag-warning .diag-title { color: #cca700; }
  .diag-count { font-size: 11px; color: #1e1a10; background: #b9ad8e; border-radius: 8px; padding: 0 6px; }
  .diag-where { font-family: monospace; font-size: 11px; color: #9cdcfe; background: transparent; border: 1px solid #4a4130; border-radius: 4px; padding: 0 5px; }
  button.diag-goto { cursor: pointer; }
  button.diag-goto:hover, button.diag-goto:focus { background: #2d2718; color: #cfe9ff; outline: none; }
  #error-pane pre.diag-message { margin: 0; font-family: monospace; font-size: 11px; color: #d4d4d4; white-space: pre-wrap; word-break: break-word; }
  .diag-snippet { margin-top: 3px; padding-left: 6px; border-left: 2px solid #4a4130; font-family: monospace; font-size: 11px; color: #b9ad8e; white-space: pre-wrap; word-break: break-word; }${extraStyles}${builderStyles}
</style>
${cssLinks}
</head>
<body>
${builderHost}
<div id="lp-chrome">
${chrome}
</div>
<div id="lp-rendered-root">
${rendered}
</div>
<script>
    window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'update') return;
        const toggles = {};
        for (const input of document.querySelectorAll('.lp-toggle input[id], #error-pane input[id]')) {
            toggles[input.id] = input.checked;
        }
        const legend = document.querySelector('.lp-legend');
        const legendOpen = legend ? legend.open : null;
        const x = window.scrollX, y = window.scrollY;
        document.getElementById('lp-chrome').innerHTML = msg.chrome;
        document.getElementById('lp-rendered-root').innerHTML = msg.rendered;
        for (const id in toggles) {
            const input = document.getElementById(id);
            if (input) input.checked = toggles[id];
        }
        const newLegend = document.querySelector('.lp-legend');
        if (newLegend && legendOpen !== null) newLegend.open = legendOpen;
        window.scrollTo(x, y);
    });

    // ---- Jump to the source of a problem ----
    // Clicking a position in the problems pane asks the extension to open that
    // file at that line (see wirePreviewMessages). The listener is delegated so
    // it survives the content patch above, and no-ops outside VS Code, where
    // there is no extension to post to.
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    // Shared with the test builder: a webview may acquire the API only once.
    window.__rlpVsCodeApi = vscodeApi;
    document.addEventListener('click', event => {
        const action = event.target && event.target.closest && event.target.closest('[data-lp-action]');
        if (action && vscodeApi) {
            vscodeApi.postMessage({ type: 'action', action: action.getAttribute('data-lp-action') });
            return;
        }
        const button = event.target && event.target.closest && event.target.closest('.diag-goto');
        if (!button || !vscodeApi) return;
        vscodeApi.postMessage({
            type: 'reveal',
            file: button.getAttribute('data-diag-file'),
            line: Number(button.getAttribute('data-diag-line')),
            col: Number(button.getAttribute('data-diag-col'))
        });
    });

    // ---- Scroll sync between the rendered view and the HTML source view ----
    // On toggle, anchor on the text at the top of the viewport in the view
    // being left and scroll the view being entered to that same text. If the
    // anchor can't be found (e.g. entity differences), the scroll is left
    // alone rather than jumping to the top.

    const sourcePre = () => document.querySelector('.lp-source pre');
    const toolbarBottom = () => {
        const bar = document.querySelector('.lp-toolbar');
        return bar ? bar.getBoundingClientRect().bottom : 0;
    };

    const escapeRegex = s => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    // Whitespace-tolerant matcher from the first few words of a snippet.
    const snippetRegex = snippet => {
        const words = String(snippet).trim().split(/\\s+/).slice(0, 8);
        return words.length ? new RegExp(words.map(escapeRegex).join('\\\\s+')) : null;
    };

    // First meaningful text currently visible in the rendered view.
    function renderedTopSnippet() {
        const root = document.getElementById('lp-rendered-root');
        const limit = toolbarBottom() + 4;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue;
            const el = node.parentElement;
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.height > 0 && r.bottom > limit) return node.textContent.trim().slice(0, 80);
        }
        return '';
    }

    // A Range covering [start, start+1) of a container's concatenated text.
    function rangeAtOffset(container, start) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let node, pos = 0;
        while ((node = walker.nextNode())) {
            const next = pos + node.length;
            if (start < next) {
                const range = document.createRange();
                range.setStart(node, start - pos);
                range.setEnd(node, Math.min(start - pos + 1, node.length));
                return range;
            }
            pos = next;
        }
        return null;
    }

    function scrollSourceToSnippet(snippet) {
        const pre = sourcePre();
        const re = snippet && snippetRegex(snippet);
        if (!pre || !re) return;
        const m = re.exec(pre.textContent);
        if (!m) return;
        const range = rangeAtOffset(pre, m.index);
        if (!range) return;
        const rect = range.getBoundingClientRect();
        window.scrollTo(0, Math.max(0, window.scrollY + rect.top - toolbarBottom() - 16));
    }

    // Plain-text snippet (tag markup skipped) at the top of the source view.
    function sourceTopSnippet() {
        const pre = sourcePre();
        if (!pre) return '';
        const text = pre.textContent;
        let offset = 0;
        const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(24, toolbarBottom() + 12) : null;
        if (caret && pre.contains(caret.startContainer)) {
            const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode()) && node !== caret.startContainer) offset += node.length;
            offset += caret.startOffset;
        }
        // If the offset lands inside a tag, skip to the end of that tag.
        const nextLt = text.indexOf('<', offset), nextGt = text.indexOf('>', offset);
        let i = (nextGt !== -1 && (nextLt === -1 || nextGt < nextLt)) ? nextGt + 1 : offset;
        let out = '', inTag = false;
        while (i < text.length && out.length < 60) {
            const c = text[i++];
            if (c === '<') inTag = true;
            else if (c === '>') inTag = false;
            else if (!inTag) out += c;
        }
        return out;
    }

    function scrollRenderedToSnippet(snippet) {
        const root = document.getElementById('lp-rendered-root');
        const re = snippet && snippetRegex(snippet);
        if (!root || !re) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node, buf = '';
        while ((node = walker.nextNode())) {
            nodes.push({ start: buf.length, node });
            // Separate nodes with a newline: adjacent block elements have no
            // whitespace between their text nodes, but the source does, and
            // the whitespace-tolerant regex absorbs the extra separator.
            buf += node.textContent + '\\n';
        }
        const m = re.exec(buf);
        if (!m) return;
        let target = null;
        for (const entry of nodes) {
            if (entry.start <= m.index) target = entry.node; else break;
        }
        const el = target && target.parentElement;
        if (!el) return;
        window.scrollTo(0, Math.max(0, window.scrollY + el.getBoundingClientRect().top - toolbarBottom() - 16));
    }

    // Delegated so the listener survives content patches. The checkbox is
    // flipped back briefly to measure the view being left — this happens
    // within a single frame, so nothing visibly flickers.
    document.addEventListener('change', event => {
        const input = event.target;
        if (!input || input.id !== 'lp-show-source') return;
        if (input.checked) {
            input.checked = false;
            const snippet = renderedTopSnippet();
            input.checked = true;
            scrollSourceToSnippet(snippet);
        } else {
            input.checked = true;
            const snippet = sourceTopSnippet();
            input.checked = false;
            scrollRenderedToSnippet(snippet);
        }
    });
</script>
${builder ? `<script>${BUILDER_SCRIPT}</script>` : ''}
</body>
</html>`;
}

function createNewPreview(document) {
    let id = Date.now();
    let preview = {
        id: id,
        uri: function () {
            let templateFile = this.templateUri && path.basename(this.templateUri);
            let dataFile = this.dataUri && path.basename(this.dataUri);
            let dataFileString = dataFile ? dataFile + ' + ' : '';
            let previewFile = 'Preview ' + dataFileString + templateFile + '?id=' + id;

            return vscode.Uri.parse('reporter-liquid-preview:' + previewFile);
        },
        templateUri: document.fileName,
        templateDirty: true,
        template: [],
        dataUri: null,
        dataDirty: false,
        data: {},
        lastRenderedHtml: ''
    };
    return preview;
}

function getDocumentPreviews(previewContentProvider, document) {
    let documentPreviews = [];
    for (let previewId in previewContentProvider.previews) {
        let preview = previewContentProvider.previews[previewId];

        let isData = preview.dataUri === document.fileName;
        let isTemplate = preview.templateUri === document.fileName;

        if (isData || isTemplate) {
            documentPreviews.push({
                preview,
                isData,
                isTemplate
            });
        }
    }
    return documentPreviews;
}

async function updatePreviewDataFile(preview) {
    let jsonUris = await vscode.workspace.findFiles('**/*.json');
    let jsonPickItems = jsonUris.map(jsonUri => {
        return {
            label: jsonUri.fsPath && path.basename(jsonUri.fsPath),
            description: jsonUri.fsPath,
            value: jsonUri.fsPath
        };
    });
    let pickedItem = await vscode.window.showQuickPick(jsonPickItems, {
        canPickMany: false,
        placeHolder: 'Choose a file to use as fake data for your template.'
    });
    if (pickedItem) {
        preview.dataUri = pickedItem.value;
        preview.dataDirty = true;
    }
}

// ---- Template tests ---------------------------------------------------------
//
// *.liquidtest.json suites render templates against known data and check the
// output (see template-tests.js, which does the work and builds the report).
// This part connects them to the editor: commands to run them and open the
// report, and — on VS Code 1.59 or newer, which added the Testing API — the
// suites and their cases in the Test Explorer, with a diff view for a case
// whose output changed. Older editors still get the commands and the report.

// The most recent run, whichever way it was started, and the panel showing it.
let _lastTestReport = null;
let _testReportPanel = null;

// Read a file the way the preview does: through VS Code, so unsaved edits to a
// template, data file or expected output count.
async function readWorkspaceText(file) {
    const document = await vscode.workspace.openTextDocument(file);
    return document.getText();
}

const templateTestDeps = { readText: readWorkspaceText, render: renderForTest, format: formatHtml };

async function discoverSuiteFiles() {
    const uris = await vscode.workspace.findFiles(templateTests.SUITE_GLOB, '**/node_modules/**');
    return uris.map(uri => uri.fsPath).sort();
}

async function loadSuite(file) {
    try {
        return templateTests.parseSuite(await readWorkspaceText(file), file);
    } catch (err) {
        return { file, error: `Cannot read the suite: ${err.message}`, cases: [] };
    }
}

// Run template tests and record the report. `selection` lists the suites to
// run, each with the case names to limit it to (null for every case); without
// one, every suite in the workspace runs. The selection is kept on the report
// so Re-run repeats exactly the same run.
async function runTemplateTests({ selection = null, isCancelled = () => false, onStart, onResult, onSuite } = {}) {
    const startedAt = Date.now();
    const chosen = selection || (await discoverSuiteFiles()).map(file => ({ file, only: null }));
    const suites = [];
    for (const { file, only } of chosen) {
        if (isCancelled()) break;
        const suite = await loadSuite(file);
        if (onSuite) onSuite(suite);
        suites.push(await templateTests.runSuite(suite, templateTestDeps, { only, isCancelled, onStart, onResult }));
    }
    const report = { startedAt, durationMs: Date.now() - startedAt, suites, selection: chosen };
    _lastTestReport = report;
    if (_testReportPanel) _testReportPanel.webview.html = buildTestReportDocument(report);
    return report;
}

function relativePath(file) {
    return vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(file) : file;
}

function buildTestReportDocument(report) {
    return templateTests.buildReportHtml(report, { interactive: true, relative: relativePath });
}

// Open the report panel on `report`, or bring it forward if it is already open.
function showTestReport(report) {
    if (_testReportPanel) {
        _testReportPanel.webview.html = buildTestReportDocument(report);
        _testReportPanel.reveal(undefined, true);
        return _testReportPanel;
    }
    const panel = vscode.window.createWebviewPanel(
        'reporterLiquidTestReport',
        'Liquid Test Report',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [] }
    );
    panel.webview.html = buildTestReportDocument(report);
    panel.webview.onDidReceiveMessage(message => handleTestReportMessage(message));
    panel.onDidDispose(() => { _testReportPanel = null; });
    _testReportPanel = panel;
    return panel;
}

async function handleTestReportMessage(message) {
    if (!message) return;
    if (message.type === 'reveal' && message.file) {
        await revealInEditor(message.file, message.line, message.col);
    } else if (message.type === 'rerun') {
        await runTemplateTestsWithProgress(_lastTestReport && _lastTestReport.selection);
    } else if (message.type === 'save' && _lastTestReport) {
        await saveTestReport(_lastTestReport);
    } else if (message.type === 'accept' && _lastTestReport) {
        await acceptActualOutput(_lastTestReport);
    }
}

async function runTemplateTestsWithProgress(selection) {
    const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running Liquid template tests', cancellable: true },
        (progress, token) => runTemplateTests({
            selection,
            isCancelled: () => token.isCancellationRequested,
            onStart: testCase => progress.report({ message: testCase.name })
        })
    );
    showTestReport(report);
    return report;
}

// Write the report as a standalone HTML file — for attaching to a ticket or
// keeping alongside a release. Everything it needs is inline.
async function saveTestReport(report) {
    const folders = vscode.workspace.workspaceFolders || [];
    const defaultUri = folders.length
        ? vscode.Uri.file(path.join(folders[0].uri.fsPath, 'liquid-test-report.html'))
        : undefined;
    const target = await vscode.window.showSaveDialog({ defaultUri, filters: { HTML: ['html'] } });
    if (!target) return null;
    await require('fs').promises.writeFile(target.fsPath, templateTests.buildReportHtml(report, { relative: relativePath }), 'utf8');
    vscode.window.showInformationMessage(`Test report saved to ${relativePath(target.fsPath)}`);
    return target.fsPath;
}

// Snapshot workflow: write each case's actual output to its expected file,
// where that file is missing or differs, then re-run. Overwrites files, so it
// always asks first and names how many.
async function acceptActualOutput(report, { confirm = true } = {}) {
    const results = templateTests.acceptableResults(report);
    if (results.length === 0) {
        vscode.window.showInformationMessage('No expected output to update: every case with an expected file already matches.');
        return [];
    }
    if (confirm) {
        const names = results.slice(0, 5).map(r => relativePath(r.expectedFile)).join(', ') + (results.length > 5 ? ', …' : '');
        const choice = await vscode.window.showWarningMessage(
            `Overwrite ${pluralize(results.length, 'expected output file')} with the actual output from the last run? (${names})`,
            { modal: true },
            'Overwrite'
        );
        if (choice !== 'Overwrite') return [];
    }
    const fs = require('fs');
    for (const r of results) {
        await fs.promises.mkdir(path.dirname(r.expectedFile), { recursive: true });
        await fs.promises.writeFile(r.expectedFile, r.actual, 'utf8');
    }
    await runTemplateTests({ selection: report.selection });
    if (_testReportPanel) showTestReport(_lastTestReport);
    return results.map(r => r.expectedFile);
}

function registerTemplateTests(context) {
    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.runTemplateTests', () => runTemplateTestsWithProgress(null)));
    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.showTemplateTestReport', () => {
        return _lastTestReport ? showTestReport(_lastTestReport) : runTemplateTestsWithProgress(null);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.createTemplateTests', uri => createTestsFromDataFiles(uri)));
    context.subscriptions.push(vscode.commands.registerCommand('reporterLiquidPreview.acceptTemplateTestOutput', async () => {
        if (!_lastTestReport) await runTemplateTests();
        return acceptActualOutput(_lastTestReport);
    }));
    registerTestController(context);
}

// The Test Explorer side. Suites are top-level items keyed by file path; cases
// are their children, keyed "<file>::<name>"; a case's checks are its
// children in turn, keyed "<case id>::<check name>". Each sits on the line of
// its "name" so the editor shows run buttons beside it. Running a check runs
// its case — the output has to be rendered either way — and reports every
// check in it.
function registerTestController(context) {
    if (!vscode.tests || typeof vscode.tests.createTestController !== 'function') return null;

    const controller = vscode.tests.createTestController('reporterLiquidTemplateTests', 'Reporter Liquid templates');
    context.subscriptions.push(controller);

    const caseId = (file, name) => `${file}::${name}`;
    const checkId = (file, caseName, name) => `${caseId(file, caseName)}::${name}`;
    const at = line => new vscode.Range(line - 1, 0, line - 1, 0);

    const syncSuite = async file => {
        const suite = await loadSuite(file);
        const uri = vscode.Uri.file(file);
        let item = controller.items.get(file);
        if (!item) {
            item = controller.createTestItem(file, relativePath(file), uri);
            controller.items.add(item);
        }
        item.error = suite.error || undefined;
        item.children.replace(suite.cases.map(c => {
            const child = controller.createTestItem(caseId(file, c.name), c.name, uri);
            child.range = at(c.line);
            child.children.replace((c.checks || []).map(check => {
                const checkItem = controller.createTestItem(checkId(file, c.name, check.name), check.name, uri);
                if (check.line) checkItem.range = at(check.line);
                return checkItem;
            }));
            return child;
        }));
        return item;
    };

    const syncAll = async () => {
        const files = await discoverSuiteFiles();
        const keep = new Set(files);
        const stale = [];
        controller.items.forEach(item => { if (!keep.has(item.id)) stale.push(item.id); });
        for (const id of stale) controller.items.delete(id);
        for (const file of files) await syncSuite(file);
    };

    controller.resolveHandler = async item => { if (!item) await syncAll(); };
    // Newer editors show a refresh button when this is set; older ones ignore it.
    controller.refreshHandler = () => syncAll();

    const watcher = vscode.workspace.createFileSystemWatcher(templateTests.SUITE_GLOB);
    context.subscriptions.push(watcher);
    watcher.onDidCreate(uri => syncSuite(uri.fsPath));
    watcher.onDidChange(uri => syncSuite(uri.fsPath));
    watcher.onDidDelete(uri => controller.items.delete(uri.fsPath));

    controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, async (request, token) => {
        await syncAll();

        // Turn the request into the file → case-names selection the runner
        // takes, dropping anything the request excludes.
        const excluded = new Set((request.exclude || []).map(item => item.id));
        const wanted = new Map();
        const addCase = (suiteItem, child) => {
            if (excluded.has(child.id)) return;
            if (!wanted.has(suiteItem.id)) wanted.set(suiteItem.id, new Set());
            wanted.get(suiteItem.id).add(child.label);
        };
        const addSuite = suiteItem => {
            if (excluded.has(suiteItem.id)) return;
            if (!wanted.has(suiteItem.id)) wanted.set(suiteItem.id, new Set());
            suiteItem.children.forEach(child => addCase(suiteItem, child));
        };
        if (request.include) {
            for (const item of request.include) {
                // Items are re-created on every sync, so look the current one up
                // by id rather than trusting the object the request carries. A
                // check runs as part of its case.
                const caseItem = item.parent && item.parent.parent ? item.parent : item.parent ? item : null;
                if (caseItem) {
                    const suiteItem = controller.items.get(caseItem.parent.id);
                    const child = suiteItem && suiteItem.children.get(caseItem.id);
                    if (child) addCase(suiteItem, child);
                } else {
                    const suiteItem = controller.items.get(item.id);
                    if (suiteItem) addSuite(suiteItem);
                }
            }
        } else {
            controller.items.forEach(addSuite);
        }

        const run = controller.createTestRun(request);
        const itemFor = (file, name) => {
            const suiteItem = controller.items.get(file);
            return suiteItem && suiteItem.children.get(caseId(file, name));
        };
        for (const [file, names] of wanted) {
            for (const name of names) {
                const item = itemFor(file, name);
                if (item) {
                    run.enqueued(item);
                    item.children.forEach(checkItem => run.enqueued(checkItem));
                }
            }
        }

        await runTemplateTests({
            selection: Array.from(wanted, ([file, only]) => ({ file, only })),
            isCancelled: () => token.isCancellationRequested,
            onSuite: suite => {
                const suiteItem = controller.items.get(suite.file);
                if (suite.error && suiteItem) run.errored(suiteItem, new vscode.TestMessage(suite.error));
            },
            onStart: testCase => {
                const item = itemFor(testCase.suiteFile, testCase.name);
                if (item) run.started(item);
            },
            onResult: (testCase, result) => {
                const item = itemFor(testCase.suiteFile, testCase.name);
                if (!item) return;
                if (result.status === 'passed') run.passed(item, result.durationMs);
                else if (result.status === 'failed') run.failed(item, toTestMessages(result), result.durationMs);
                else run.errored(item, toTestMessages(result), result.durationMs);

                for (const check of result.checks || []) {
                    const checkItem = item.children.get(checkId(testCase.suiteFile, testCase.name, check.name));
                    if (!checkItem) continue;
                    if (check.status === 'passed') run.passed(checkItem);
                    else if (check.status === 'skipped') run.skipped(checkItem);
                    else run.failed(checkItem, check.failures.map(why => located(new vscode.TestMessage(why), result.suiteFile, check.line || result.line)));
                }
            }
        });
        run.end();
    }, true);

    return controller;
}

// One Test Explorer message per failure. An output mismatch becomes a diff
// message, which the editor opens in its own diff view; everything else points
// at the file and line the failure names, or at the case itself.
function toTestMessages(result) {
    const messages = result.failures.map(failure => {
        const message = failure.kind === 'mismatch' && result.expected !== null
            ? vscode.TestMessage.diff(failure.message, result.expected, result.actual)
            : new vscode.TestMessage(failure.message);
        const file = failure.kind === 'mismatch' ? result.suiteFile : (failure.file || result.suiteFile);
        const line = failure.kind === 'mismatch' ? result.line : (failure.file ? (failure.line || 1) : result.line);
        return located(message, file, line);
    });
    // The checks report their own failures; the case says which of them failed.
    const failedChecks = (result.checks || []).filter(c => c.status === 'failed');
    if (failedChecks.length) {
        messages.push(located(new vscode.TestMessage(
            `${pluralize(failedChecks.length, 'check')} failed: ${failedChecks.map(c => c.name).join(', ')}`
        ), result.suiteFile, result.line));
    }
    return messages;
}

function located(message, file, line) {
    message.location = new vscode.Location(vscode.Uri.file(file), new vscode.Position(Math.max(0, (line || 1) - 1), 0));
    return message;
}

// ---- Creating tests from known cases ------------------------------------------
//
// A known case is a template and a data file whose rendered output someone has
// looked at and knows to be right. These turn such cases into test cases: the
// output is rendered now, frozen as the expected file, and the case added to a
// suite (beside the template unless one exists already) — then the suite is run,
// so the reader sees the new cases pass straight away.

// Save the template and data files if they have unsaved edits. A case records
// paths, so an expected output rendered from an unsaved buffer would describe
// files that aren't on disk, and the test would fail on its first real run.
async function saveDirtyInputs(files) {
    const open = vscode.workspace.textDocuments || [];
    const dirty = open.filter(d => d.isDirty && files.includes(d.fileName));
    if (dirty.length === 0) return true;
    const choice = await vscode.window.showWarningMessage(
        `${dirty.map(d => path.basename(d.fileName)).join(', ')} ${dirty.length === 1 ? 'has' : 'have'} unsaved changes. The test records the files as saved on disk.`,
        { modal: true },
        'Save and continue'
    );
    if (choice !== 'Save and continue') return false;
    for (const document of dirty) await document.save();
    return true;
}

// Add a case for each source to the suite beside `templateFile` (or
// `suiteFile`). `sources` are { name, dataFile } or { name, data }, with
// optional `checks` and `snapshot` (false: no expected file, the checks are the
// test). Returns what was added and what was left out and why, or null if the
// reader cancelled.
async function createTestsFromCases(templateFile, sources, { suiteFile = null } = {}) {
    const fs = require('fs');
    suiteFile = suiteFile || templateTests.defaultSuiteFile(templateFile);

    if (!await saveDirtyInputs([templateFile].concat(sources.map(s => s.dataFile).filter(Boolean)))) return null;

    let templateText;
    try {
        templateText = await readWorkspaceText(templateFile);
    } catch (err) {
        vscode.window.showErrorMessage(`Cannot read ${path.basename(templateFile)}: ${err.message}`);
        return null;
    }

    // Render every case first. One that fails to render, or that breaks a rule
    // every case is held to (a duplicate field name), would be a test that
    // fails the moment it is made, so it is left out and the reason reported.
    const rendered = [];
    const rejected = [];
    for (const source of sources) {
        let data = source.data || {};
        if (source.dataFile) {
            try {
                data = JSON.parse(await readWorkspaceText(source.dataFile));
            } catch (err) {
                rejected.push({ name: source.name, reason: `the data file is not valid JSON (${err.message})` });
                continue;
            }
        }
        const { html, diagnostics } = await renderForTest(templateText, data, templateFile);
        const error = diagnostics.find(d => d.severity !== 'warning');
        if (html === null || error) {
            rejected.push({ name: source.name, reason: error ? `${error.title}: ${error.message}` : 'the template did not render' });
            continue;
        }
        // Every check must pass against the output it was built from. One that
        // doesn't would fail on its first run — and for a check made in the
        // builder, it means the builder got something wrong, which the reader
        // should hear now rather than discover later.
        if (source.checks && source.checks.length) {
            const parsed = parseChecks(source.checks);
            const failing = parsed.error
                ? [{ name: 'checks', failures: [parsed.error] }]
                : runChecks(parsed.checks, html).filter(c => c.status !== 'passed');
            if (failing.length) {
                rejected.push({ name: source.name, reason: `${failing.length === 1 ? 'a check doesn\u2019t' : 'some checks don\u2019t'} pass against the current output: ${failing.map(c => `${c.name} (${c.failures[0]})`).join('; ')}` });
                continue;
            }
        }
        rendered.push(Object.assign({}, source, { output: html, warnings: diagnostics.length }));
    }

    // Warnings mean a filter met missing data. Freezing that output as
    // "expected" would bless the gap, so the reader decides, per run.
    const warned = rendered.filter(r => r.warnings > 0);
    let entries = rendered;
    if (warned.length) {
        const choice = await vscode.window.showWarningMessage(
            `${pluralize(warned.length, 'case')} (${warned.map(r => r.name).join(', ')}) ${warned.length === 1 ? 'makes' : 'make'} filters warn about missing data. `
            + 'Saving them as they are allows warnings in those cases, so a test will no longer catch that data going missing.',
            { modal: true },
            'Skip those cases',
            'Allow warnings'
        );
        if (choice === undefined) return null;
        if (choice === 'Skip those cases') {
            for (const r of warned) rejected.push({ name: r.name, reason: 'filters warned about missing data' });
            entries = rendered.filter(r => r.warnings === 0);
        } else {
            entries = rendered.map(r => Object.assign({}, r, { allowWarnings: r.warnings > 0 }));
        }
    }

    let suiteText = null;
    try {
        suiteText = await readWorkspaceText(suiteFile);
    } catch (err) {
        // No suite yet: planNewCases starts one.
    }
    let plan;
    try {
        plan = templateTests.planNewCases({ suiteFile, suiteText, template: templateFile, entries, exists: fs.existsSync });
    } catch (err) {
        vscode.window.showErrorMessage(err.message);
        return null;
    }
    const skipped = rejected.concat(plan.skipped);

    if (plan.added.length === 0) {
        vscode.window.showWarningMessage(`No test cases were created. ${skipped.map(s => `${s.name}: ${s.reason}`).join('; ')}`);
        return { suiteFile, added: [], skipped };
    }
    if (!await saveDirtyInputs([suiteFile])) return null;

    for (const write of plan.writes) {
        await fs.promises.mkdir(path.dirname(write.file), { recursive: true });
        await fs.promises.writeFile(write.file, write.text, 'utf8');
    }
    await fs.promises.writeFile(suiteFile, plan.suiteText, 'utf8');

    const leftOut = skipped.length ? ` Left out: ${skipped.map(s => `${s.name} (${s.reason})`).join('; ')}.` : '';
    vscode.window.showInformationMessage(`Added ${pluralize(plan.added.length, 'test case')} to ${relativePath(suiteFile)}. Review the expected output before committing it.${leftOut}`);

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(suiteFile), { preview: false, viewColumn: vscode.ViewColumn.One });
    const report = await runTemplateTests({ selection: [{ file: suiteFile, only: new Set(plan.added) }] });
    showTestReport(report);
    return { suiteFile, added: plan.added, skipped, report };
}

// The HTML preview's test builder posts the test it built: a name, its checks
// and whether to also freeze the whole page. The case uses the preview's
// template and data file. The outcome goes back to the builder panel, in
// words, whether it was saved or why not.
async function saveBuiltTest(preview, panel, message) {
    const reply = (ok, text) => panel.webview.postMessage({ type: 'builderResult', ok, message: text });
    const name = typeof message.name === 'string' ? message.name.trim() : '';
    const checks = Array.isArray(message.checks) ? message.checks : [];
    const wholePage = message.wholePage === true;
    if (!name) return reply(false, 'Give the test a name first.');
    if (checks.length === 0 && !wholePage) return reply(false, 'Add at least one check, or tick \u201cAlso check the whole page\u201d.');

    const source = Object.assign(
        { name, checks, snapshot: wholePage },
        preview.dataUri ? { dataFile: preview.dataUri } : { data: {} }
    );
    let result;
    try {
        result = await createTestsFromCases(preview.templateUri, [source]);
    } catch (err) {
        return reply(false, `The test wasn\u2019t saved: ${err.message}`);
    }
    if (!result) return reply(false, 'Cancelled. Nothing was saved.');
    if (result.added.length === 0) {
        return reply(false, `The test wasn\u2019t saved: ${result.skipped.map(s => s.reason).join('; ')}`);
    }
    return reply(true, `Saved \u201c${result.added[0]}\u201d to ${relativePath(result.suiteFile)}. The test report shows it passing.`);
}

// "Create Tests from Data Files…": one template, any number of data files, a
// case each. Starts from the file right-clicked in the Explorer, the active
// editor's template, or a pick from the workspace's templates.
async function createTestsFromDataFiles(uri) {
    let templateFile = uri && uri.fsPath && /\.liquid$/i.test(uri.fsPath) ? uri.fsPath : null;
    const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    if (!templateFile && active && /\.liquid$/i.test(active.fileName)) templateFile = active.fileName;
    if (!templateFile) {
        const templates = await vscode.workspace.findFiles('**/*.liquid', '**/node_modules/**');
        const picked = await vscode.window.showQuickPick(
            templates.map(t => ({ label: path.basename(t.fsPath), description: relativePath(t.fsPath), value: t.fsPath })),
            { placeHolder: 'Choose the template to create tests for' }
        );
        if (!picked) return null;
        templateFile = picked.value;
    }

    const suiteFile = templateTests.defaultSuiteFile(templateFile);
    const jsonFiles = (await vscode.workspace.findFiles('**/*.json', '**/node_modules/**'))
        .map(u => u.fsPath)
        .filter(f => !f.endsWith('.liquidtest.json') && !/(^|[\\/])(package|package-lock|tsconfig|jsconfig)\.json$/.test(f))
        .sort();
    if (jsonFiles.length === 0) {
        vscode.window.showWarningMessage('No .json data files found in the workspace.');
        return null;
    }
    const picked = await vscode.window.showQuickPick(
        jsonFiles.map(f => ({ label: path.basename(f), description: relativePath(f), value: f })),
        { canPickMany: true, placeHolder: `Choose the data files whose output from ${path.basename(templateFile)} you know is right — one test case each` }
    );
    if (!picked || picked.length === 0) return null;

    const sources = picked.map(p => ({ name: path.basename(p.value, path.extname(p.value)), dataFile: p.value }));
    return createTestsFromCases(templateFile, sources, { suiteFile });
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};

// VS Code only ever calls activate and deactivate. The rest is exported for the
// test suite (see test/README.md), which drives the preview refreshes against a
// stubbed vscode module and checks the HTML they produce.
Object.assign(module.exports, {
    acceptActualOutput,
    annotateLiquid,
    buildErrorPaneHtml,
    buildFullPreviewContent,
    buildPreviewHtml,
    cleanLiquidMessage,
    createTestsFromCases,
    createTestsFromDataFiles,
    clearPreviewDiagnostics,
    dedupeDiagnostics,
    formatHtml,
    fullPreviewStyles,
    htmlPreviewStyles,
    jsonDiagnostic,
    liquidEngine,
    markdownToHtml,
    parseTagArgs,
    refreshHtmlFullPanel,
    refreshHtmlPanel,
    registerCustomFilters,
    registerCustomTags,
    renderForTest,
    runTemplateTests,
    saveBuiltTest,
    showTestReport,
    snippetOf,
    strayTagDiagnostics,
    stripLiquidFromHtmlTags,
    tokenLocation,
    toTestMessages,
    wirePreviewMessages
});