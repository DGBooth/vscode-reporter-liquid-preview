// The rendering engine: LiquidJS with Reporter's custom tags and filters, and
// the bookkeeping that lets a warning or error say where in the template it
// came from. Nothing here touches `vscode`, so the preview (extension.js) and
// the command-line test runner (bin/liquid-test.js) render through exactly the
// same code.

const liquid = require('liquidjs');
const liquidEngine = new liquid();

// Accumulates warnings during a single render pass. Set to [] before rendering, null otherwise.
let _currentWarnings = null;

// The token of the template currently being rendered — see trackRenderPosition.
// Filters and custom tags are handed their arguments and nothing else, so this
// is the only way for a warning raised inside one to say where it came from.
let _currentToken = null;

// register custom Liquid tags used in templates
registerCustomTags(liquidEngine);
trackRenderPosition(liquidEngine);

// Parse a Liquid tag argument string into an object.
// e.g. '"fieldName", title: "My Title", lines: 1' → { name: "fieldName", title: "My Title", lines: 1 }
// An unquoted first argument is treated as a Liquid variable reference → { nameVar: "varName", ... }
function parseTagArgs(argsStr) {
    const result = {};
    if (!argsStr) return result;
    const nameMatch = argsStr.match(/^\s*['"]([^'"]+)['"]/);
    if (nameMatch) {
        result.name = nameMatch[1];
    } else {
        // Unquoted first argument (not a key:value pair) is a variable whose runtime value is the name
        const varMatch = argsStr.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)(?!\s*:)/);
        if (varMatch) result.nameVar = varMatch[1];
    }
    const kvRegex = /(\w+):\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?))/g;
    let m;
    while ((m = kvRegex.exec(argsStr)) !== null) {
        const key = m[1];
        result[key] = m[4] !== undefined ? parseFloat(m[4]) : (m[2] !== undefined ? m[2] : m[3]);
    }
    return result;
}

// Resolve the tag name from parsed args: either a literal string or a variable looked up in context.
function resolveTagName(args, ctx) {
    if (args.name) return args.name;
    if (args.nameVar) {
        const envs = (ctx && ctx.environments) || {};
        const resolved = envs[args.nameVar];
        return resolved !== undefined ? String(resolved) : '';
    }
    return '';
}

// Record a tag name into the per-render duplicate tracker (injected via render
// context), along with where each use appeared, so a clash can be pointed at
// rather than only named.
function trackTagName(name, ctx) {
    const tracker = ctx && ctx.environments && ctx.environments._rlpTracker;
    if (!tracker || !name) return;
    const uses = tracker.seen.get(name);
    if (uses) {
        uses.push(currentLocation());
        if (!tracker.dupes.includes(name)) tracker.dupes.push(name);
    } else {
        tracker.seen.set(name, [currentLocation()]);
    }
}

// Keep _currentToken pointing at the template being rendered, so warnings and
// errors raised deep inside a filter or a custom tag can name their line.
//
// The loop mirrors LiquidJS's own Render.renderTemplates rather than handing it
// the whole list at once, so each template can be bracketed individually. Error
// handling is left to the original — each single-template call still wraps its
// own RenderError — except for RenderBreakError, which carries the HTML
// rendered before a {% break %} and would otherwise only see the one template
// we passed down.
function trackRenderPosition(engine) {
    const renderTemplates = engine.renderer.renderTemplates.bind(engine.renderer);
    engine.renderer.renderTemplates = async function (templates, ctx) {
        let html = '';
        for (const template of templates) {
            const previousToken = _currentToken;
            _currentToken = template.token || previousToken;
            try {
                html += await renderTemplates([template], ctx);
            } catch (err) {
                if (err.name === 'RenderBreakError') err.resolvedHTML = html + (err.resolvedHTML || '');
                throw err;
            } finally {
                _currentToken = previousToken;
            }
        }
        return html;
    };
}

// Record a warning raised at the position currently being rendered.
function addWarning(message) {
    if (_currentWarnings) _currentWarnings.push({ message, location: currentLocation() });
}

// Where in the template rendering has reached, or null outside a render pass.
function currentLocation() {
    return tokenLocation(_currentToken);
}

// A position from a LiquidJS token: 1-based line and column, plus the source
// text of the construct itself so a pane entry is recognisable without having
// to leave the preview to look it up.
function tokenLocation(token) {
    if (!token || typeof token.line !== 'number') return null;
    return {
        line: token.line,
        col: typeof token.col === 'number' ? token.col : 1,
        snippet: snippetOf(token.raw)
    };
}

// Collapse a chunk of source to a single readable line for display.
function snippetOf(text) {
    const oneLine = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? oneLine.slice(0, 119) + '\u2026' : oneLine;
}

// Convert Markdown text to HTML for the markdownify filter. Supports the
// common constructs used in Reporter templates: headings, paragraphs,
// unordered/ordered lists (nested by indentation), blockquotes, fenced code
// blocks, horizontal rules, and inline bold/italic/code/links/images.
// Raw HTML in the source passes through untouched, as in standard Markdown.
function markdownToHtml(md) {
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const out = [];

    // Inline markdown within a single block of text.
    const renderInline = text => {
        // Code spans are extracted first so their contents are not treated as markup.
        const codeSpans = [];
        text = text.replace(/`([^`]+)`/g, (_, code) => {
            codeSpans.push(`<code>${escapeHtml(code)}</code>`);
            return `\u0000${codeSpans.length - 1}\u0000`;
        });
        text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">');
        text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        // Underscore emphasis only at word boundaries, so snake_case survives.
        text = text.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
        return text.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSpans[i]);
    };

    // Stack of currently open lists: { indent, tag } from outermost to innermost.
    let listStack = [];
    const closeListsTo = depth => {
        while (listStack.length > depth) {
            out.push(`</li></${listStack.pop().tag}>`);
        }
    };

    let paragraph = [];
    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        // Two or more trailing spaces on a line force a hard break.
        const body = paragraph.map(l => l.replace(/ {2,}$/, '<br>')).join('\n');
        out.push(`<p>${renderInline(body)}</p>`);
        paragraph = [];
    };
    const flushBlocks = () => { flushParagraph(); closeListsTo(0); };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // Fenced code block: everything up to the closing fence is literal.
        const fence = line.match(/^\s*```/);
        if (fence) {
            flushBlocks();
            const body = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) {
                body.push(lines[i]);
                i++;
            }
            i++; // skip the closing fence
            out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
            continue;
        }

        // Blank line ends the current paragraph and any open lists.
        if (!line.trim()) {
            flushBlocks();
            i++;
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (heading) {
            flushBlocks();
            out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
            i++;
            continue;
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flushBlocks();
            out.push('<hr>');
            i++;
            continue;
        }

        const quote = line.match(/^\s*>\s?(.*)$/);
        if (quote) {
            flushBlocks();
            const body = [quote[1]];
            i++;
            while (i < lines.length) {
                const m = lines[i].match(/^\s*>\s?(.*)$/);
                if (!m) break;
                body.push(m[1]);
                i++;
            }
            out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
            continue;
        }

        const listItem = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (listItem) {
            flushParagraph();
            const indent = listItem[1].length;
            const tag = /\d/.test(listItem[2]) ? 'ol' : 'ul';
            // Close lists deeper than this item's indentation.
            while (listStack.length && indent < listStack[listStack.length - 1].indent) {
                out.push(`</li></${listStack.pop().tag}>`);
            }
            const top = listStack[listStack.length - 1];
            if (!top || indent > top.indent) {
                listStack.push({ indent, tag });
                out.push(`<${tag}><li>` + renderInline(listItem[3]));
            } else if (top.tag !== tag) {
                out.push(`</li></${listStack.pop().tag}>`);
                listStack.push({ indent, tag });
                out.push(`<${tag}><li>` + renderInline(listItem[3]));
            } else {
                out.push('</li><li>' + renderInline(listItem[3]));
            }
            i++;
            continue;
        }

        // A non-blank, non-marker line while a list is open continues the last item.
        if (listStack.length > 0) {
            out[out.length - 1] += ' ' + renderInline(line.trim());
            i++;
            continue;
        }

        paragraph.push(line);
        i++;
    }
    flushBlocks();
    return out.join('\n');
}

function registerCustomFilters(engine) {
    // markdownify filter: render Markdown text as HTML, as in Reporter
    // (e.g. "- Test" becomes a bullet point). The wrapper div lets the
    // preview stylesheet trim the outer margins of the first/last block, so
    // the output sits flush with surrounding content as it does in Reporter
    // instead of showing a blank line where the leading <p>'s default
    // margin-top would be.
    engine.registerFilter('markdownify', value => {
        if (value == null) {
            addWarning('markdownify filter: value is missing (returned empty)');
            return '';
        }
        return `<div class="rlp-markdown">${markdownToHtml(value)}</div>`;
    });

    // money filter: rounds to 2 decimal places or appends .00 if no decimals, with comma separators
    engine.registerFilter('money', value => {
        const num = parseFloat(value);
        if (isNaN(num)) return value;
        return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });

    // slice filter: override built-in to warn instead of error when the value is missing
    engine.registerFilter('slice', (v, begin, length = 1) => {
        if (v == null) {
            addWarning('slice filter: value is missing (returned empty)');
            return '';
        }
        begin = begin < 0 ? v.length + begin : begin;
        return v.slice(begin, begin + length);
    });

    // where filter: override built-in to warn instead of error when the value is missing
    engine.registerFilter('where', (arr, property, value) => {
        if (arr == null) {
            addWarning(`where filter: array is missing (filtering by property "${property}")`);
            return [];
        }
        return arr.filter(obj => value === undefined ? (obj[property] !== false && obj[property] !== undefined && obj[property] !== null) : obj[property] === value);
    });

    // sort filter: override built-in to warn on null and support sorting by property key
    engine.registerFilter('sort', (arr, property) => {
        if (arr == null) {
            addWarning('sort filter: array is missing (returned empty)');
            return [];
        }
        const sorted = [...arr];
        if (property) {
            sorted.sort((a, b) => {
                const av = a == null ? null : a[property];
                const bv = b == null ? null : b[property];
                if (av == null && bv == null) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                if (av < bv) return -1;
                if (av > bv) return 1;
                return 0;
            });
        } else {
            sorted.sort((a, b) => {
                if (a == null && b == null) return 0;
                if (a == null) return 1;
                if (b == null) return -1;
                if (a < b) return -1;
                if (a > b) return 1;
                return 0;
            });
        }
        return sorted;
    });

    // json filter: serialize a value as JSON, as in the LiquidJS built-in
    // (https://liquidjs.com/filters/json.html), but pretty-printed with a
    // 2-space indent by default for readability. An optional argument
    // overrides the indentation, e.g. {{ value | json: 4 }} or
    // {{ value | json: 0 }} for compact single-line output.
    engine.registerFilter('json', (value, space = 2) => JSON.stringify(value, null, space));

    // sort_natural filter: case-insensitive sort, optionally by property key
    engine.registerFilter('sort_natural', (arr, property) => {
        if (arr == null) {
            addWarning('sort_natural filter: array is missing (returned empty)');
            return [];
        }
        const sorted = [...arr];
        const cmpNatural = (a, b) => {
            if (a == null && b == null) return 0;
            if (a == null) return 1;
            if (b == null) return -1;
            return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
        };
        if (property) {
            sorted.sort((a, b) => cmpNatural(a == null ? null : a[property], b == null ? null : b[property]));
        } else {
            sorted.sort(cmpNatural);
        }
        return sorted;
    });
}

// register custom Liquid filters used in templates
registerCustomFilters(liquidEngine);

function registerCustomTags(engine) {
    // optional tag: renders a checkbox wrapper with inner content
    engine.registerTag('optional', {
        parse(tagToken, remainTokens) {
            this.args = parseTagArgs(tagToken.args);
            this.templates = [];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:endoptional', () => stream.stop())
                .on('template', tpl => this.templates.push(tpl))
                .on('end', () => { throw new Error('optional tag not closed'); });
            stream.start();
        },
        async render(ctx) {
            const name = resolveTagName(this.args, ctx);
            trackTagName(name, ctx);
            const fields = (ctx.environments && ctx.environments.fields) || {};
            const checkedAttr = fields[name] === 'true' ? ' checked=""' : '';
            const inner = await this.liquid.renderer.renderTemplates(this.templates, ctx);
            return `<div id="${name}-wrapper" class="editor " data-editor-id="${name}"><label for="${name}"><input type="checkbox" id="${name}" name="${name}" data-editor-id="${name}" value="true"${checkedAttr}><span class="optional-content">${inner}</span></label></div>`;
        }
    });

    // editor tag: renders an input or textarea wrapped in a div
    engine.registerTag('editor', {
        parse(tagToken, remainTokens) {
            this.args = parseTagArgs(tagToken.args);
            this.templates = [];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:endeditor', () => stream.stop())
                .on('template', tpl => this.templates.push(tpl))
                .on('end', () => { throw new Error('editor tag not closed'); });
            stream.start();
        },
        render(ctx) {
            const name = resolveTagName(this.args, ctx);
            trackTagName(name, ctx);
            const lines = this.args.lines !== undefined ? this.args.lines : 1;
            const placeholder = this.args.placeholder || '';
            const maxlength = this.args.maxlength !== undefined ? this.args.maxlength : 100;
            const minlength = this.args.minlength !== undefined ? this.args.minlength : 0;
            const fields = (ctx.environments && ctx.environments.fields) || {};
            const value = fields[name] !== undefined ? String(fields[name]) : '';
            if (lines <= 1) {
                return `<div id="editor-wrapper-${name}" class="editor "><input type="text" id="${name}" data-editor-id="${name}" maxlength="${maxlength}" minlength="${minlength}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}"></div>`;
            } else {
                return `<div id="editor-wrapper-${name}" class="editor "><textarea id="${name}" data-editor-id="${name}" maxlength="${maxlength}" minlength="${minlength}" placeholder="${escapeHtml(placeholder)}" rows="${lines}">${escapeHtml(value)}</textarea></div>`;
            }
        }
    });

    // choice tag: renders radio buttons for each 'or'-separated block
    engine.registerTag('choice', {
        parse(tagToken, remainTokens) {
            this.args = parseTagArgs(tagToken.args);
            this.parts = [[]];
            const stream = this.liquid.parser.parseStream(remainTokens)
                .on('tag:or', () => this.parts.push([]))
                .on('tag:endchoice', () => stream.stop())
                .on('template', tpl => this.parts[this.parts.length - 1].push(tpl))
                .on('end', () => { throw new Error('choice tag not closed'); });
            stream.start();
        },
        async render(ctx) {
            const name = resolveTagName(this.args, ctx);
            trackTagName(name, ctx);
            const title = this.args.title !== undefined ? this.args.title : '';
            const fields = (ctx.environments && ctx.environments.fields) || {};
            const selectedValue = fields[name] !== undefined ? String(fields[name]) : '0';
            const titleHtml = title ? `<span class="editor-intro">${escapeHtml(title)}</span>` : '';
            let labelsHtml = '';
            for (let i = 0; i < this.parts.length; i++) {
                const checkedAttr = String(i) === selectedValue ? ' checked=""' : '';
                const inner = await this.liquid.renderer.renderTemplates(this.parts[i], ctx);
                labelsHtml += `<label for="${name}-${i + 1}"><input type="radio" id="${name}-${i + 1}" name="${name}" data-editor-id="${name}" value="${i}"${checkedAttr}><span class="choice-content">${inner}</span></label>`;
            }
            return `<div id="${name}-wrapper" class="editor " data-editor-id="${name}">${titleHtml}${labelsHtml}</div>`;
        }
    });
}

function pluralize(count, singular, plural) {
    return `${count} ${count === 1 ? singular : (plural || singular + 's')}`;
}

// Tags that get their own indented line when formatting; everything else is
// treated as inline and left verbatim.
const HTML_BLOCK_TAGS = new Set(['html', 'head', 'body', 'title', 'meta', 'link', 'style', 'script', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'form', 'fieldset', 'legend', 'blockquote', 'hr', 'details', 'summary', 'figure', 'figcaption', 'address']);
// Elements with no closing tag, so an opening tag must not increase the indent.
const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Elements whose body is whitespace-sensitive and must be kept verbatim.
const HTML_RAW_TAGS = new Set(['pre', 'textarea', 'script', 'style']);

// Split HTML into tag/text/raw tokens. The scanner respects quoted attribute
// values (a '>' inside quotes does not end the tag), comments and doctypes,
// and captures raw-tag bodies verbatim.
function tokenizeHtml(html) {
    const tokens = [];
    let i = 0;
    let textStart = 0;
    const flushText = end => { if (end > textStart) tokens.push({ type: 'text', text: html.slice(textStart, end) }); };

    while (i < html.length) {
        if (html[i] !== '<' || !/[a-zA-Z\/!]/.test(html[i + 1] || '')) { i++; continue; }
        flushText(i);

        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i + 4);
            const close = end === -1 ? html.length : end + 3;
            tokens.push({ type: 'tag', kind: 'comment', name: '', text: html.slice(i, close) });
            i = textStart = close;
            continue;
        }

        // Scan to the matching '>', ignoring any inside quoted attribute values.
        let j = i + 1;
        let quote = null;
        while (j < html.length && (quote !== null || html[j] !== '>')) {
            if (quote === null && (html[j] === '"' || html[j] === "'")) quote = html[j];
            else if (html[j] === quote) quote = null;
            j++;
        }
        const close = j < html.length ? j + 1 : html.length;
        const text = html.slice(i, close);
        const nameMatch = text.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
        const name = nameMatch ? nameMatch[1].toLowerCase() : '';
        const kind = text[1] === '!' ? 'doctype' : (text[1] === '/' ? 'close' : 'open');
        i = textStart = close;

        if (kind === 'open' && HTML_RAW_TAGS.has(name)) {
            const closeRegex = new RegExp(`</${name}\\s*>`, 'i');
            const m = closeRegex.exec(html.slice(i));
            const bodyEnd = m ? i + m.index : html.length;
            const rawClose = m ? bodyEnd + m[0].length : html.length;
            tokens.push({ type: 'raw', name, openTag: text, body: html.slice(i, bodyEnd), closeTag: m ? m[0] : '' });
            i = textStart = rawClose;
        } else {
            tokens.push({ type: 'tag', kind, name, text });
        }
    }
    flushText(html.length);
    return tokens;
}

// Conservative HTML pretty-printer for the source views: block-level tags get
// their own indented lines and inline runs are kept together, with newlines
// inside them collapsed to a space. Only whitespace that cannot affect
// rendering is changed — inline content is otherwise verbatim and raw-tag
// bodies (pre, textarea, script, style) are untouched — so the formatted
// markup renders identically to the original.
function formatHtml(html) {
    const out = [];
    let indent = 0;
    let line = '';
    const pushLine = () => {
        const trimmed = line.replace(/\s*\n\s*/g, ' ').trim();
        if (trimmed) out.push('  '.repeat(indent) + trimmed);
        line = '';
    };

    for (const tok of tokenizeHtml(html)) {
        if (tok.type === 'text') {
            line += tok.text;
        } else if (tok.type === 'raw') {
            pushLine();
            out.push('  '.repeat(indent) + tok.openTag + tok.body + tok.closeTag);
        } else if (HTML_BLOCK_TAGS.has(tok.name) || tok.kind === 'comment' || tok.kind === 'doctype') {
            pushLine();
            if (tok.kind === 'close') {
                indent = Math.max(0, indent - 1);
                out.push('  '.repeat(indent) + tok.text);
            } else {
                out.push('  '.repeat(indent) + tok.text);
                if (tok.kind === 'open' && !HTML_VOID_TAGS.has(tok.name)) indent++;
            }
        } else {
            line += tok.text;
        }
    }
    pushLine();
    return out.join('\n');
}

// Renders run one at a time across the whole extension. Warnings are gathered
// in the module-level _currentWarnings, and a render awaits between templates,
// so two in flight at once — a preview refreshing on a keystroke while a test
// run is going, or two previews — would each collect the other's warnings.
let _renderQueue = Promise.resolve();

// Render a parsed template the way the HTML preview does, and hand back the
// output with the problems it raised: repeated field names and filter
// warnings, each located. A render error is thrown, not reported, so callers
// can decide what to show instead. Shared by the preview and the template
// tests, so a test sees exactly what the preview would.
function renderWithDiagnostics(template, data, file) {
    const run = async () => {
        const nameTracker = { seen: new Map(), dupes: [] };
        const dataWithTracker = Object.assign({}, data, { _rlpTracker: nameTracker });
        _currentWarnings = [];
        try {
            const rendered = await liquidEngine.render(template, dataWithTracker);
            const diagnostics = [];
            for (const name of nameTracker.dupes) {
                diagnostics.push(duplicateNameDiagnostic(name, nameTracker.seen.get(name) || [], file));
            }
            for (const warning of _currentWarnings) {
                diagnostics.push(diagnostic('warning', 'Warning', warning.message, file, warning.location));
            }
            return { rendered, diagnostics };
        } finally {
            _currentWarnings = null;
        }
    };
    const next = _renderQueue.then(run, run);
    _renderQueue = next.catch(() => { });
    return next;
}

// One row of the problems pane: what went wrong and, wherever we can work it
// out, which file, line and column to send the reader to. `location` is the
// {line, col, snippet} shape produced by tokenLocation.
function diagnostic(severity, title, message, file, location) {
    return Object.assign(
        { severity, title, message, file: file || null, line: null, col: null, snippet: '' },
        location || {}
    );
}

// A diagnostic from a LiquidJS error. Parse, tokenization and render errors all
// carry the token they failed on, which is the position the reader wants.
function liquidDiagnostic(title, err, file) {
    return diagnostic('error', title, cleanLiquidMessage(err.message), file, tokenLocation(err.token));
}

// LiquidJS appends ", file:…, line:N, col:M" to its messages. The pane shows
// that position as a link of its own, so it is stripped from the prose rather
// than repeated in it.
function cleanLiquidMessage(message) {
    return String(message).replace(/,\s*(?:file:[^,]*,\s*)?line:\d+,\s*col:\d+\s*$/, '');
}

// A diagnostic from a failed JSON.parse of the data file. JSON.parse reports
// the position inside the message text and the wording varies by Node version:
// newer ones give "(line 3 column 5)", older ones only a character offset.
// Both are turned into a real position, and the trailing position prose — now
// shown properly — is trimmed off the message.
function jsonDiagnostic(title, err, text, file) {
    const message = String(err.message);
    const lineColumn = /line (\d+) column (\d+)/.exec(message);
    const position = /position (\d+)/.exec(message);
    let line = null;
    let col = null;
    if (lineColumn) {
        line = Number(lineColumn[1]);
        col = Number(lineColumn[2]);
    } else if (position) {
        const before = text.slice(0, Number(position[1])).split('\n');
        line = before.length;
        col = before[before.length - 1].length + 1;
    }
    const location = line
        ? { line, col, snippet: snippetOf(text.split('\n')[line - 1] || '') }
        : null;
    return diagnostic('error', title, message.replace(/\s*in JSON at position \d+.*$/, ''), file, location);
}

// Reporter keys the writer's answers by field name, so a repeated name silently
// ties two fields together. Point at the repeat itself and name the line it
// collides with, rather than listing the names and leaving the hunt to the
// reader.
function duplicateNameDiagnostic(name, uses, file) {
    const located = uses.filter(Boolean);
    const first = located[0];
    const repeat = located[1] || first;
    const elsewhere = first && repeat !== first ? ` It is first used on line ${first.line}.` : '';
    return diagnostic(
        'error',
        'Duplicate field name',
        `“${name}” is used ${pluralize(uses.length, 'time')} — every field needs its own name.${elsewhere}`,
        file,
        repeat
    );
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Parse and render template text for a test case. Never throws: a template
// that fails to parse or render comes back with no html and the located error
// among its diagnostics.
async function renderForTest(text, data, file) {
    let template;
    try {
        template = liquidEngine.parse(text);
    } catch (err) {
        return { html: null, diagnostics: [liquidDiagnostic('Template error', err, file)] };
    }
    try {
        const { rendered, diagnostics } = await renderWithDiagnostics(template, data, file);
        return { html: rendered, diagnostics };
    } catch (err) {
        return { html: null, diagnostics: [liquidDiagnostic('Render error', err, file)] };
    }
}

module.exports = {
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
    renderWithDiagnostics,
    diagnostic,
    liquidDiagnostic,
    cleanLiquidMessage,
    jsonDiagnostic,
    duplicateNameDiagnostic,
    escapeHtml,
    renderForTest
};
