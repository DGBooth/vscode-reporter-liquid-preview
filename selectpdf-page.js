// The page SelectPdf prints a template onto, worked out from the converter
// settings so the HTML preview's "SelectPdf pages" view can draw it.
//
// Reporter's documents become PDFs through SelectPdf's HtmlToPdf converter,
// which (in SelectPdf.Universal) lays the page out in Chromium in a window
// WebPageWidth px wide (1024 by default), then scales that whole layout so its
// width fills the page between the left and right margins. So the scale is
//
//     s = content width of the pdf page in px / WebPageWidth
//
// (1pt = 1/72in, 1px = 1/96in), and one pdf page holds `content height / s`
// px of the layout. A4 with no margins: 793.7px / 1024 = 0.775, so each page
// takes 1448px of the 1024px-wide layout. Header and footer bands, when shown,
// come off the content height. webview/selectpdf-pages.js does the paging
// itself from the numbers worked out here.
//
// The settings are reporterLiquidPreview.selectPdf.*, named after the
// HtmlToPdfOptions they mirror, so they can be copied from the code that
// converts the documents. This doesn't depend on VS Code.

const PT_TO_PX = 96 / 72;
const MM_TO_PT = 72 / 25.4;

const mm = (w, h) => ({ width: w * MM_TO_PT, height: h * MM_TO_PT });
const inches = (w, h) => ({ width: w * 72, height: h * 72 });

// SelectPdf's PdfPageSize values, in points, portrait as SelectPdf defines them.
const PAGE_SIZES = {
    A0: mm(841, 1189), A1: mm(594, 841), A2: mm(420, 594), A3: mm(297, 420), A4: mm(210, 297),
    A5: mm(148, 210), A6: mm(105, 148), A7: mm(74, 105), A8: mm(52, 74), A9: mm(37, 52), A10: mm(26, 37),
    B0: mm(1000, 1414), B1: mm(707, 1000), B2: mm(500, 707), B3: mm(353, 500), B4: mm(250, 353), B5: mm(176, 250),
    ArchA: inches(9, 12), ArchB: inches(12, 18), ArchC: inches(18, 24), ArchD: inches(24, 36), ArchE: inches(36, 48),
    Letter: inches(8.5, 11), HalfLetter: inches(5.5, 8.5), Letter11x17: inches(11, 17),
    Note: inches(7.5, 10), Flsa: inches(8.5, 13), Ledger: inches(17, 11)
};

const DEFAULTS = {
    pageSize: 'A4',
    customPageSize: null,
    orientation: 'Portrait',
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    webPageWidth: 1024,
    cssMediaType: 'Screen',
    fitWideContent: false,
    allowContentHeightResize: true,
    customCss: '',
    header: null,
    footer: null,
    keepLinesTogether: true,
    pageMarginSides: false
};

function number(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// A header or footer band: shown only when display is on and it has height.
function band(raw) {
    if (!raw || typeof raw !== 'object' || !raw.display) return null;
    const height = number(raw.height, 0, 0, 2000);
    if (!height) return null;
    return {
        height,
        displayOnFirstPage: raw.displayOnFirstPage !== false,
        displayOnOddPages: raw.displayOnOddPages !== false,
        displayOnEvenPages: raw.displayOnEvenPages !== false
    };
}

// Settings as read from VS Code (anything missing or out of range falls back
// to SelectPdf's own default) in the shape pageGeometry expects.
function normalizeSelectPdfSettings(raw = {}) {
    raw = raw || {};
    const pageSize = Object.prototype.hasOwnProperty.call(PAGE_SIZES, raw.pageSize) ? raw.pageSize : DEFAULTS.pageSize;
    const custom = raw.customPageSize;
    const customPageSize = custom && Number(custom.width) > 0 && Number(custom.height) > 0
        ? { width: number(custom.width, 0, 1, 14400), height: number(custom.height, 0, 1, 14400) }
        : null;
    return {
        pageSize,
        customPageSize,
        orientation: String(raw.orientation).toLowerCase() === 'landscape' ? 'Landscape' : 'Portrait',
        marginTop: number(raw.marginTop, DEFAULTS.marginTop, 0, 2000),
        marginRight: number(raw.marginRight, DEFAULTS.marginRight, 0, 2000),
        marginBottom: number(raw.marginBottom, DEFAULTS.marginBottom, 0, 2000),
        marginLeft: number(raw.marginLeft, DEFAULTS.marginLeft, 0, 2000),
        webPageWidth: Math.round(number(raw.webPageWidth, DEFAULTS.webPageWidth, 100, 10000)),
        cssMediaType: String(raw.cssMediaType).toLowerCase() === 'print' ? 'Print' : 'Screen',
        fitWideContent: raw.fitWideContent === true,
        allowContentHeightResize: raw.allowContentHeightResize !== false,
        customCss: typeof raw.customCss === 'string' ? raw.customCss : '',
        header: band(raw.header),
        footer: band(raw.footer),
        keepLinesTogether: raw.keepLinesTogether !== false,
        pageMarginSides: raw.pageMarginSides === true
    };
}

// Everything the pages view needs to know about the page, in CSS px. The page
// is the sheet; the content box is where the layout is printed (inside the
// margins and below the header, above the footer). SelectPdf reserves a band
// on every page when it is displayed at all, so the content box is the same
// on every page; the band is just not drawn on the pages it is hidden on.
function pageGeometry(rawSettings) {
    const settings = normalizeSelectPdfSettings(rawSettings);
    let { width, height } = settings.customPageSize || PAGE_SIZES[settings.pageSize];
    if (settings.orientation === 'Landscape') [width, height] = [height, width];

    const px = pt => pt * PT_TO_PX;
    const margins = {
        top: px(settings.marginTop), right: px(settings.marginRight),
        bottom: px(settings.marginBottom), left: px(settings.marginLeft)
    };
    const header = settings.header ? { ...settings.header, height: px(settings.header.height), heightPt: settings.header.height } : null;
    const footer = settings.footer ? { ...settings.footer, height: px(settings.footer.height), heightPt: settings.footer.height } : null;

    const page = { width: px(width), height: px(height), widthPt: width, heightPt: height };
    // At least a pixel each way, so margins wider than the page can't give a
    // zero or negative scale.
    const content = {
        left: margins.left,
        top: margins.top + (header ? header.height : 0),
        width: Math.max(1, page.width - margins.left - margins.right),
        height: Math.max(1, page.height - margins.top - margins.bottom - (header ? header.height : 0) - (footer ? footer.height : 0))
    };
    const scale = content.width / settings.webPageWidth;

    return {
        pageSizeName: settings.customPageSize ? 'Custom' : settings.pageSize,
        orientation: settings.orientation,
        page,
        margins,
        header,
        footer,
        content,
        webPageWidth: settings.webPageWidth,
        scale,
        // One page's worth of the layout, in layout px.
        layoutPageHeight: content.height / scale,
        cssMediaType: settings.cssMediaType,
        fitWideContent: settings.fitWideContent,
        allowContentHeightResize: settings.allowContentHeightResize,
        customCss: settings.customCss,
        // How the engine pages, where Reporter's (selectwin8) differs from
        // Chromium's (see the README): whether a break keeps the CSS's
        // orphans and widows (2 lines each side unless set), and whether the
        // CSS's @page left and right margins narrow the text column.
        keepLinesTogether: settings.keepLinesTogether,
        pageMarginSides: settings.pageMarginSides
    };
}

// Reporter sets a template's page in the definition.json beside it, as a list
// of { key, value } under "settings". Its select.* keys are the page (see
// Reporter's "Getting started" docs on the Select PDF engine):
//
//   select.widthPoints, select.heightPoints        595 x 842 unless set
//   select.header.enabled, .height, .displayOnFirstPage   off, unset, true
//   select.footer.enabled, .height, .displayOnFirstPage   off, unset, true
//
// A template with a definition.json is converted with these, Reporter's
// defaults filling in what it leaves out, whatever the workspace settings say;
// so they are laid over them. A band that's enabled with no height is
// SelectPdf's own default height: Reporter's docs give the height as 0 unless
// set, but a letter whose header is enabled with none set breaks its pages in
// production as if it had a header near that height, and nowhere near as if it
// had none, so Reporter evidently leaves the height to SelectPdf. What goes in
// the bands (.html, page numbers) and a contents page don't change where pages
// end, and aren't read. Returns the settings, the select.* keys that were set
// and the bands given SelectPdf's height, or null for a file that isn't a
// definition (see readDefinition for the reason).
const DEFINITION_SETTINGS = ['pageSize', 'customPageSize', 'orientation', 'header', 'footer'];

// SelectPdf's PdfHeader.Height and PdfFooter.Height when they aren't set, in
// points (its .NET library's documentation).
const SELECTPDF_BAND_HEIGHT = { header: 45, footer: 35 };

// A definition.json's text as an object, or { error } saying why it isn't one.
// Files saved by Windows tools often start with a byte-order mark, and a
// hand-edited one may carry comments or trailing commas; JSON.parse takes
// none of them, so they are taken out first.
function readDefinition(text) {
    const source = String(text).replace(/^\uFEFF/, '');
    let value;
    try {
        value = JSON.parse(source);
    } catch (first) {
        try {
            value = JSON.parse(withoutCommentsAndTrailingCommas(source));
        } catch (err) {
            return { error: first.message };
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'it is not a JSON object' };
    return { value };
}

// JSON text with // and /* */ comments and trailing commas removed, leaving
// strings alone.
function withoutCommentsAndTrailingCommas(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 1;
        } else {
            out += c;
        }
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
}

function definitionPageSettings(json) {
    let definition = json;
    if (typeof json === 'string') {
        const read = readDefinition(json);
        if (read.error) return null;
        definition = read.value;
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
    const values = {};
    for (const setting of Array.isArray(definition.settings) ? definition.settings : []) {
        if (setting && typeof setting.key === 'string' && setting.key.startsWith('select.')) values[setting.key] = setting.value;
    }
    const given = key => values[key] !== undefined && values[key] !== null && values[key] !== '';
    const num = (key, fallback) => (given(key) && Number.isFinite(Number(values[key])) ? Number(values[key]) : fallback);
    const bool = (key, fallback) => (given(key) ? values[key] === true || String(values[key]).toLowerCase() === 'true' : fallback);
    const defaulted = [];
    const band = name => {
        if (!bool(`select.${name}.enabled`, false)) return null;
        if (!given(`select.${name}.height`)) defaulted.push(name);
        return {
            display: true,
            height: num(`select.${name}.height`, SELECTPDF_BAND_HEIGHT[name]),
            displayOnFirstPage: bool(`select.${name}.displayOnFirstPage`, true)
        };
    };
    const header = band('header');
    const footer = band('footer');
    return {
        settings: {
            customPageSize: { width: num('select.widthPoints', 595), height: num('select.heightPoints', 842) },
            orientation: 'Portrait',
            header,
            footer
        },
        keys: Object.keys(values),
        defaulted
    };
}

// "A4 portrait · 1024px layout at 78% on the page": what the toolbar says the
// pages are. The percentage is how much the layout is shrunk to fit between
// the margins, not how large the view is drawn.
function describeGeometry(geometry) {
    const size = geometry.pageSizeName === 'Custom'
        ? `${Math.round(geometry.page.widthPt)}×${Math.round(geometry.page.heightPt)}pt`
        : geometry.pageSizeName;
    return `${size} ${geometry.orientation.toLowerCase()} · ${geometry.webPageWidth}px layout at ${Math.round(geometry.scale * 100)}% on the page`
        + (geometry.cssMediaType === 'Print' ? ' · print media' : '');
}

module.exports = {
    PAGE_SIZES,
    PT_TO_PX,
    normalizeSelectPdfSettings,
    pageGeometry,
    describeGeometry,
    definitionPageSettings,
    readDefinition,
    DEFINITION_SETTINGS,
    SELECTPDF_BAND_HEIGHT
};
