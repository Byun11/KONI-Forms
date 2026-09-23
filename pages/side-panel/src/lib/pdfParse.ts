/**
 * PDF ingestion (M4 of doc-tools): parse an attached PDF ONCE at attach time
 * into (a) one JPEG image per page for the view_doc sticky slot and (b) the
 * page's text-layer lines, shaped by `pdfShape.ts` into the same
 * DocParseResult model the office parser produces (search_doc/read_table work
 * over PDF text unchanged).
 *
 * Worker wiring (MV3): remote code is forbidden, so the pdf.js worker is
 * BUNDLED — the Vite `?url` import below emits `pdf.worker.min.mjs` as a
 * build asset next to the side panel's own chunks, and because the page
 * config builds with a relative base (`base: ''`), the URL resolves against
 * `import.meta.url` to `chrome-extension://<id>/side-panel/assets/...`.
 * pdf.js then spawns it as a same-origin module worker, which the extension
 * CSP (`script-src 'self'`) allows.
 */
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { DocParseResult } from './docParse';
import { buildPdfParseResult, pageLinesFromTextItems, PDF_MAX_PAGES } from './pdfShape';
import type { PdfPageData, PdfTextItem } from './pdfShape';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Target render width in CSS pixels. Government/tax forms pack tiny glyphs
 * (a Form 990 checkbox is ~8pt → only ~13px at 1000px wide, unreadable to a
 * vision model); 1600px lifts that to ~21px and scales body text up with it.
 * A US-Letter page ≈ 1600×2070 JPEG ≈ 200-350KB, so a 12-page doc (~4M base64
 * chars) stays well under PDF_PAYLOAD_MAX_CHARS (15M). */
export const PDF_TARGET_WIDTH = 1600;
/** JPEG quality of the page renders — a touch higher so thin checkmarks and
 * small digits survive compression at the fine end. */
export const PDF_JPEG_QUALITY = 0.85;

/** Thrown when the PDF exceeds {@link PDF_MAX_PAGES}; shown as its own chip error. */
export class PdfPageLimitError extends Error {
  constructor(pageCount: number) {
    super(`PDF has ${pageCount} pages; the limit is ${PDF_MAX_PAGES}`);
    this.name = 'PdfPageLimitError';
  }
}

/**
 * Parse a PDF ArrayBuffer into the structured doc-store model (kind 'pdf'):
 * per-page text lines + per-page rendered images. Rendering happens here,
 * exactly once — the agent later only reads the stored result.
 */
export async function parsePdf(buffer: ArrayBuffer): Promise<DocParseResult> {
  // pdf.js transfers the bytes to its worker; copy so the caller's buffer stays usable.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer.slice(0)),
    // Bundled standard fonts (vite.config.mts copy plugin). Form PDFs often
    // draw checkboxes with non-embedded ZapfDingbats — without this the
    // glyphs can drop out of the rendered page image.
    standardFontDataUrl:
      typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('side-panel/standard_fonts/')
        : undefined,
  });
  const doc = await loadingTask.promise;
  try {
    if (doc.numPages > PDF_MAX_PAGES) {
      throw new PdfPageLimitError(doc.numPages);
    }

    const pages: PdfPageData[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PDF_TARGET_WIDTH / baseViewport.width });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const image = canvas.toDataURL('image/jpeg', PDF_JPEG_QUALITY);

      const textContent = await page.getTextContent();
      const lines = pageLinesFromTextItems(textContent.items as PdfTextItem[]);

      page.cleanup();
      pages.push({ lines, image });
    }
    return buildPdfParseResult(pages);
  } finally {
    // v6 API: destroying the loading task tears down the document and worker.
    await loadingTask.destroy();
  }
}
