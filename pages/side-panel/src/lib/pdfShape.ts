/**
 * Pure shaping logic for PDF ingestion (M4 of doc-tools): turns per-page text
 * items + rendered page images into the same DocParseResult model the office
 * parser produces, so search_doc/read_table work over PDF text unchanged and
 * the new view_doc action can pin any page image into the sticky slot.
 *
 * Deliberately pdfjs-free (type-only import of the doc model): pdf.js needs a
 * DOM/worker and cannot run under plain Node, but everything here is plain
 * data-in/data-out so the tests in `pages/side-panel/tests/pdfShape.test.ts`
 * run with `node --experimental-strip-types`, next to the M1-M3 doc tests.
 * The pdf.js wiring (getDocument, canvas render) lives in `pdfParse.ts`.
 *
 * Model mapping (one PDF page ≙ one table of the office model):
 * - block per page: breadcrumb '페이지 N', tableId 'pN' → read_table("pN")
 *   dumps that page's text;
 * - TOC entry per page: id 'pN', title = first non-empty text line (truncated),
 *   rowCount = line count — the model navigates pages like it navigates tables;
 * - NEW `pages` field: the rendered page images (data URLs) for view_doc.
 * - scanned pages with an EMPTY text layer carry a single placeholder line so
 *   search tells the truth instead of silently matching nothing.
 */
import type { DocBlock, DocPageImage, DocParseResult, TocEntry } from './docParse';

/** Hard page cap: a PDF beyond this is rejected at attach time (chip error). */
export const PDF_MAX_PAGES = 50;

/** Placeholder line for pages whose text layer is empty (scanned PDFs). */
export const PDF_EMPTY_TEXT_PLACEHOLDER = '(글자층 없음 — view_doc으로 보세요)';

/** Mirror of docParse.ts TITLE_MAX_CHARS — TOC titles stay one-line short. */
const TITLE_MAX_CHARS = 60;

/** Vertical tolerance factor: items whose baseline differs by more than half
 * the item height belong to different text lines. */
const LINE_BREAK_Y_FACTOR = 0.5;

/** Horizontal gap (PDF units) between items that implies a missing space. */
const WORD_GAP_MIN = 1;

/**
 * The subset of pdf.js `TextItem` this module reads. `getTextContent()` also
 * yields marked-content items without `str`; those are skipped by shape.
 */
export interface PdfTextItem {
  str?: string;
  /** pdf.js sets this on the item that ends a text line. */
  hasEOL?: boolean;
  /** Text matrix [a, b, c, d, x, y] — x/y position the item on the page. */
  transform?: number[];
  width?: number;
  height?: number;
}

/** One rendered page handed to {@link buildPdfParseResult}. */
export interface PdfPageData {
  /** Text-layer lines of the page (may be empty for scanned pages). */
  lines: string[];
  /** Rendered page image as a data URL (JPEG). */
  image: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Assemble pdf.js text items into visual text lines. pdf.js emits one item
 * per positioned text run; a line ends at `hasEOL` or when the next item's
 * baseline (transform[5]) jumps by more than half the item height. Runs on
 * the same line separated by a horizontal gap get a space (words are often
 * split into gap-separated items with no space character of their own).
 * Whitespace is collapsed and empty lines are dropped.
 */
export function pageLinesFromTextItems(items: PdfTextItem[]): string[] {
  const lines: string[] = [];
  let buf = '';
  let lastY: number | undefined;
  let lastXEnd: number | undefined;

  const flush = () => {
    const line = buf.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    buf = '';
    lastXEnd = undefined;
  };

  for (const item of items) {
    if (typeof item.str !== 'string') continue; // marked-content item
    const x = item.transform?.[4];
    const y = item.transform?.[5];

    if (lastY !== undefined && y !== undefined) {
      const tolerance = Math.max(1, (item.height ?? 8) * LINE_BREAK_Y_FACTOR);
      if (Math.abs(y - lastY) > tolerance) flush();
    }
    if (buf && x !== undefined && lastXEnd !== undefined && x - lastXEnd > WORD_GAP_MIN) {
      buf += ' ';
    }
    buf += item.str;
    if (y !== undefined) lastY = y;
    if (x !== undefined) lastXEnd = x + (item.width ?? 0);
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

/**
 * Shape rendered pages into the doc-store model with kind 'pdf'.
 * Page numbers are 1-based everywhere ('pN' ids, `pages[].index`, view_doc).
 */
export function buildPdfParseResult(pages: PdfPageData[]): DocParseResult {
  const toc: TocEntry[] = [];
  const blocks: DocBlock[] = [];
  const pageImages: DocPageImage[] = [];

  for (let i = 0; i < pages.length; i++) {
    const n = i + 1;
    const id = `p${n}`;
    // Empty text layer (scanned page): one placeholder line so search results
    // say "no text layer, look at the image" instead of silently matching nothing.
    const lines = pages[i].lines.length > 0 ? pages[i].lines : [PDF_EMPTY_TEXT_PLACEHOLDER];
    blocks.push({ id, tableId: id, breadcrumb: `페이지 ${n}`, lines });

    const firstLine = pages[i].lines.find(line => line.trim())?.trim() ?? '';
    toc.push({ id, title: truncate(firstLine, TITLE_MAX_CHARS) || `페이지 ${n}`, fields: [], rowCount: lines.length });
    pageImages.push({ index: n, image: pages[i].image });
  }

  return {
    kind: 'pdf',
    toc,
    blocks,
    stats: { tables: 0, maxDepth: 0, blocks: blocks.length },
    pages: pageImages,
  };
}
