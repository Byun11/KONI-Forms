/**
 * Tests for the attach-path policy (src/lib/docAttach.ts): the inline-vs-store
 * threshold decision, the per-document payload cap, and the store-path note.
 *
 * Run (from the repo root, Node >= 22.7 — no test framework, no dependencies):
 *
 *   node --experimental-strip-types pages/side-panel/tests/docAttach.test.ts
 *
 * Exits non-zero on any failure. docAttach.ts
 * is erasable TypeScript with a type-only import, so Node's native type
 * stripping runs it directly.
 */
import {
  INLINE_MAX_LINES,
  DOC_PAYLOAD_MAX_CHARS,
  PDF_PAYLOAD_MAX_CHARS,
  countDocLines,
  shouldInlineDoc,
  isDocPayloadWithinLimit,
  formatDocNote,
} from '../src/lib/docAttach.ts';
import type { DocParseResult } from '../src/lib/docParse.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Synthetic parse with the given per-block line counts. */
function makeParse(lineCounts: number[], tables = 1): DocParseResult {
  return {
    kind: 'hwpx',
    toc: [],
    blocks: lineCounts.map((n, i) => ({
      id: `b${i + 1}`,
      breadcrumb: '본문',
      lines: Array.from({ length: n }, (_, k) => `line ${k + 1}`),
    })),
    stats: { tables, maxDepth: tables > 0 ? 1 : 0, blocks: lineCounts.length },
  };
}

console.log('# threshold decision (inline fast path vs doc store)');
{
  check('countDocLines sums lines across all blocks', countDocLines(makeParse([3, 7, 5])) === 15);
  check('empty document inlines', shouldInlineDoc(makeParse([])));
  check(
    `exactly INLINE_MAX_LINES (${INLINE_MAX_LINES}) lines still inlines`,
    shouldInlineDoc(makeParse([INLINE_MAX_LINES])),
  );
  check('one line over the threshold goes to the store', !shouldInlineDoc(makeParse([INLINE_MAX_LINES, 1])));
  check(
    'threshold counts the total across blocks, not per block',
    !shouldInlineDoc(makeParse([INLINE_MAX_LINES - 1, 2])),
  );
}

console.log('# payload cap');
{
  check('normal parse fits the payload cap', isDocPayloadWithinLimit(makeParse([10, 10])));
  const oversized = makeParse([1]);
  oversized.blocks[0].lines[0] = 'x'.repeat(DOC_PAYLOAD_MAX_CHARS);
  check('parse whose JSON exceeds the cap is rejected', !isDocPayloadWithinLimit(oversized));
}

console.log('# store-path note');
{
  const note = formatDocNote('계획서.hwpx', makeParse([30, 12], 46));
  check(
    'note carries file name, table count, line count, and the doc-tools hint',
    note === '[attached document: 계획서.hwpx — 46 tables · 42 block lines, read it with the document tools]',
    note,
  );
}

/** Synthetic PDF parse: one page per line count, plus a page image each. */
function makePdfParse(lineCounts: number[]): DocParseResult {
  return {
    kind: 'pdf',
    toc: lineCounts.map((n, i) => ({ id: `p${i + 1}`, title: `페이지 ${i + 1}`, fields: [], rowCount: n })),
    blocks: lineCounts.map((n, i) => ({
      id: `p${i + 1}`,
      tableId: `p${i + 1}`,
      breadcrumb: `페이지 ${i + 1}`,
      lines: Array.from({ length: n }, (_, k) => `line ${k + 1}`),
    })),
    stats: { tables: 0, maxDepth: 0, blocks: lineCounts.length },
    pages: lineCounts.map((_, i) => ({ index: i + 1, image: 'data:image/jpeg;base64,AAA' })),
  };
}

console.log('# PDF policy (M4)');
{
  check('a tiny PDF still never inlines (store path only)', !shouldInlineDoc(makePdfParse([1])));
  check('PDF payload budget is larger than the office budget', PDF_PAYLOAD_MAX_CHARS > DOC_PAYLOAD_MAX_CHARS);

  // A parse whose JSON is bigger than the office cap but under the PDF cap:
  // rejected as hwpx, accepted as pdf.
  const bigPdf = makePdfParse([1]);
  bigPdf.pages![0].image = 'x'.repeat(DOC_PAYLOAD_MAX_CHARS);
  check('page images may exceed the office cap within the PDF cap', isDocPayloadWithinLimit(bigPdf));
  const bigOffice = makeParse([1]);
  bigOffice.blocks[0].lines[0] = 'x'.repeat(DOC_PAYLOAD_MAX_CHARS);
  check('the same size as an office doc is rejected', !isDocPayloadWithinLimit(bigOffice));

  const oversizedPdf = makePdfParse([1]);
  oversizedPdf.pages![0].image = 'x'.repeat(PDF_PAYLOAD_MAX_CHARS);
  check('a PDF beyond the 15MB serialized cap is rejected', !isDocPayloadWithinLimit(oversizedPdf));

  const note = formatDocNote('양식.pdf', makePdfParse([10, 5, 5]));
  check(
    'PDF note carries page count instead of table count',
    note === '[attached document: 양식.pdf — 3 pages · 20 text lines, read it with the document tools]',
    note,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
