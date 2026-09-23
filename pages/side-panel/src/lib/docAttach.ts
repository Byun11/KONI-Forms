/**
 * Attach-path policy for office documents (.docx/.hwpx): pure decision logic
 * for whether a parsed document is inlined into the outgoing message (short-doc
 * fast path) or shipped separately as a structured `docs` payload on the
 * task-start port message (store path, M2 doc store).
 *
 * Kept import-free (type-only import) so it runs under plain Node with
 * `--experimental-strip-types` for the tests in
 * `pages/side-panel/tests/docAttach.test.ts`.
 */
import type { DocParseResult } from './docParse';

/** One store-path document travelling on the `new_task` / `follow_up_task` port message. */
export interface AttachedDocPayload {
  name: string;
  parse: DocParseResult;
}

/**
 * Short-doc fast path threshold: a document whose parse has at most this many
 * lines — summed over every block's `lines[]`, i.e. aligned table row lines,
 * canonical pair lines, and paragraph lines all count — keeps today's inline
 * behavior (full text inside `<nano_attached_files>`). Anything bigger goes to
 * the doc store and only a one-line note enters the message text.
 */
export const INLINE_MAX_LINES = 40;

/**
 * Safety cap for one store-path payload: the JSON-serialized parse must stay
 * under this many characters, or the attachment is rejected with a visible
 * chip error instead of being sent. Chrome port messages are JSON-serialized,
 * so this bounds what travels over (and what the background keeps in memory).
 * The plain-text extractor already caps at 500K chars; 2M chars of JSON gives
 * the structured parse (labels repeated on pair lines, JSON syntax) headroom
 * while staying far below the port message limit.
 */
export const DOC_PAYLOAD_MAX_CHARS = 2_000_000;

/**
 * PDF payload cap (M4): a PDF parse additionally carries one rendered JPEG
 * page image per page (data URLs), so it gets a bigger serialized budget.
 * Sized to the page cap: dense text pages render to ~380KB at 1600px (a
 * 36-page bundle came to 18.4M chars of base64 and was rejected under the
 * earlier 15M), so 50 pages x ~400KB x 4/3 ≈ 27M; 40M leaves headroom while
 * staying far below the port message limit. A PDF whose serialized parse
 * exceeds this is rejected with a visible chip error.
 */
export const PDF_PAYLOAD_MAX_CHARS = 40_000_000;

/** Total searchable lines of a parse, across all blocks. */
export function countDocLines(parse: DocParseResult): number {
  return parse.blocks.reduce((n, b) => n + b.lines.length, 0);
}

/** True when the document is small enough to keep the inline fast path. */
export function shouldInlineDoc(parse: DocParseResult): boolean {
  // PDFs ALWAYS take the store path: their parse carries page images for the
  // view_doc sticky slot, which only exists in the doc store — inlining would
  // strip the images and drown the message text in raw page text.
  if (parse.kind === 'pdf') return false;
  return countDocLines(parse) <= INLINE_MAX_LINES;
}

/** Serialized-payload cap for one document, by kind. */
export function docPayloadMaxChars(parse: DocParseResult): number {
  return parse.kind === 'pdf' ? PDF_PAYLOAD_MAX_CHARS : DOC_PAYLOAD_MAX_CHARS;
}

/** True when the serialized parse fits the per-document payload cap. */
export function isDocPayloadWithinLimit(parse: DocParseResult): boolean {
  return JSON.stringify(parse).length <= docPayloadMaxChars(parse);
}

/**
 * One-line note that replaces the document content in the message text for
 * store-path docs. English, like the parser's own serialization (t/r/c) — this
 * addresses the agent, not the panel UI, so it does not follow the UI locale.
 */
export function formatDocNote(name: string, parse: DocParseResult): string {
  if (parse.kind === 'pdf') {
    return `[attached document: ${name} — ${parse.pages?.length ?? 0} pages · ${countDocLines(parse)} text lines, read it with the document tools]`;
  }
  return `[attached document: ${name} — ${parse.stats.tables} tables · ${countDocLines(parse)} block lines, read it with the document tools]`;
}
