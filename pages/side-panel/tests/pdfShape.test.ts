/**
 * Tests for the pure PDF shaping logic (src/lib/pdfShape.ts): text-line
 * assembly from pdf.js text items, and the page-block/TOC/pages shaping into
 * the doc-store model. The pdf.js rendering itself (canvas, worker) cannot
 * run under Node and is exercised by the in-Chrome click test instead.
 *
 * Run (from the repo root, Node >= 22.7 — no test framework, no dependencies):
 *
 *   node --experimental-strip-types pages/side-panel/tests/pdfShape.test.ts
 *
 * Exits non-zero on any failure. pdfShape.ts
 * is erasable TypeScript with a type-only import, so Node's native type
 * stripping runs it directly.
 */
import {
  pageLinesFromTextItems,
  buildPdfParseResult,
  PDF_MAX_PAGES,
  PDF_EMPTY_TEXT_PLACEHOLDER,
} from '../src/lib/pdfShape.ts';
import type { PdfTextItem } from '../src/lib/pdfShape.ts';

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

/** pdf.js-like text item at (x, y) with the given advance width. */
function item(
  str: string,
  x: number,
  y: number,
  width = str.length * 5,
  extra: Partial<PdfTextItem> = {},
): PdfTextItem {
  return { str, transform: [1, 0, 0, 1, x, y], width, height: 10, ...extra };
}

console.log('# text-line assembly');
{
  const lines = pageLinesFromTextItems([item('사업', 10, 700), item('계획서', 20, 700)]);
  check('adjacent items on one baseline join without separator', lines.join('|') === '사업계획서', lines.join('|'));
}
{
  const lines = pageLinesFromTextItems([item('첫 줄', 10, 700), item('둘째 줄', 10, 680)]);
  check('a baseline jump starts a new line', lines.length === 2 && lines[1] === '둘째 줄', lines.join(' / '));
}
{
  const lines = pageLinesFromTextItems([item('제목', 10, 700, 20, { hasEOL: true }), item('본문', 10, 700)]);
  check('hasEOL ends the line even without a baseline jump', lines.length === 2, lines.join(' / '));
}
{
  // '이름' ends at x=10+10=20; '홍길동' starts at x=40 — gap 20 > 1 implies a space.
  const lines = pageLinesFromTextItems([item('이름', 10, 700, 10), item('홍길동', 40, 700)]);
  check('a horizontal gap between items becomes a space', lines[0] === '이름 홍길동', lines[0]);
}
{
  const lines = pageLinesFromTextItems([item('  값  ', 10, 700), item('   ', 10, 680), item('끝', 10, 660)]);
  check('whitespace collapses and blank lines are dropped', lines.join('|') === '값|끝', lines.join('|'));
}
{
  const lines = pageLinesFromTextItems([
    item('텍스트', 10, 700),
    { transform: [1, 0, 0, 1, 10, 700] }, // marked-content item: no str
  ]);
  check('marked-content items without str are skipped', lines.join('|') === '텍스트', lines.join('|'));
}
{
  check('empty item list yields no lines', pageLinesFromTextItems([]).length === 0);
}
{
  const lines = pageLinesFromTextItems([{ str: '변환행렬 없음' }, { str: ' 이어짐' }]);
  check('items without transform still join into a line', lines[0] === '변환행렬 없음 이어짐', lines[0]);
}

console.log('# page-block / TOC shaping');
{
  const parse = buildPdfParseResult([
    { lines: ['연구개발계획서', '1. 개요'], image: 'data:image/jpeg;base64,AAA' },
    { lines: ['2. 추진 체계'], image: 'data:image/jpeg;base64,BBB' },
  ]);
  check('kind is pdf', parse.kind === 'pdf');
  check('one block per page', parse.blocks.length === 2);
  check('block ids and tableIds are pN', parse.blocks[0].id === 'p1' && parse.blocks[1].tableId === 'p2');
  check('block breadcrumb is 페이지 N', parse.blocks[1].breadcrumb === '페이지 2', parse.blocks[1].breadcrumb);
  check('block lines pass through', parse.blocks[0].lines.join('|') === '연구개발계획서|1. 개요');
  check('one toc entry per page with id pN', parse.toc.length === 2 && parse.toc[0].id === 'p1');
  check('toc title is the first non-empty line', parse.toc[0].title === '연구개발계획서', parse.toc[0].title);
  check('toc rowCount is the line count', parse.toc[0].rowCount === 2 && parse.toc[1].rowCount === 1);
  check('toc fields stay empty for pdf pages', parse.toc[0].fields.length === 0);
  check(
    'pages carry 1-based index + image data URL',
    parse.pages?.length === 2 && parse.pages[0].index === 1 && parse.pages[1].image === 'data:image/jpeg;base64,BBB',
  );
  check('stats: no tables, block count = page count', parse.stats.tables === 0 && parse.stats.blocks === 2);
}
{
  const parse = buildPdfParseResult([{ lines: [], image: 'data:image/jpeg;base64,SCAN' }]);
  check(
    'empty text layer gets the placeholder line (search tells the truth)',
    parse.blocks[0].lines.length === 1 && parse.blocks[0].lines[0] === PDF_EMPTY_TEXT_PLACEHOLDER,
    parse.blocks[0].lines[0],
  );
  check(
    'placeholder page falls back to 페이지 N as its toc title',
    parse.toc[0].title === '페이지 1',
    parse.toc[0].title,
  );
  check('placeholder counts as the single row', parse.toc[0].rowCount === 1);
}
{
  const long = 'A'.repeat(80);
  const parse = buildPdfParseResult([{ lines: [long], image: 'i' }]);
  check(
    'toc title is truncated like the office parser titles',
    parse.toc[0].title === `${'A'.repeat(60)}…`,
    parse.toc[0].title,
  );
}

console.log('# caps');
{
  check('page cap is 50', PDF_MAX_PAGES === 50);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
