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
    footer: null
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
        footer: band(raw.footer)
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
        customCss: settings.customCss
    };
}

// "A4 portrait · 1024px at 78%": what the toolbar says the pages are.
function describeGeometry(geometry) {
    const size = geometry.pageSizeName === 'Custom'
        ? `${Math.round(geometry.page.widthPt)}×${Math.round(geometry.page.heightPt)}pt`
        : geometry.pageSizeName;
    return `${size} ${geometry.orientation.toLowerCase()} · ${geometry.webPageWidth}px at ${Math.round(geometry.scale * 100)}%`
        + (geometry.cssMediaType === 'Print' ? ' · print media' : '');
}

module.exports = {
    PAGE_SIZES,
    PT_TO_PX,
    normalizeSelectPdfSettings,
    pageGeometry,
    describeGeometry
};
