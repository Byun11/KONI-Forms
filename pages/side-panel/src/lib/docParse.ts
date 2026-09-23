/**
 * Structured parser for .docx / .hwpx documents: turns the body XML into a
 * searchable document model (a deterministic table-of-contents plus
 * self-contained retrieval blocks) without any LLM involvement.
 *
 * Why not a plain regex over the XML? Korean government forms nest tables
 * inside table cells, and a non-greedy regex cannot find the matching close
 * tag of a nested `<w:tbl>`/`<hp:tbl>`. Instead we use a *balanced scanner*
 * that counts open/close tag depth to cut exact table spans, substitutes
 * placeholders for inner tables, and emits recursively with breadcrumb labels.
 *
 * Serialization rules (each fixes a documented LLM retrieval failure):
 * 1. Merge resolution + grid alignment — colSpan/rowSpan are resolved so every
 *    row has the full grid width; spanned positions are filled with the anchor
 *    cell's value, and the anchor keeps a compact ⟨CxR merged⟩ annotation. Rows
 *    under a vertical merge therefore still align column-wise.
 * 2. Header propagation — the first row is treated as the header row and the
 *    first column as the left-label column; each data cell additionally emits
 *    a canonical pair line "label | header: value" so label and value co-occur
 *    on ONE line even in transposed label-value grids.
 * 3. Empty-cell economy — pair lines are skipped for empty values (blank form
 *    cells), but empties are kept in the aligned raw row line.
 * 4. Plain paragraphs become paragraph blocks so search covers prose too.
 *
 * Run-joining: Word/Hangul split one word across multiple text runs, so runs
 * are joined *before* any matching ("사업자등록번호" split across 3 runs must be
 * findable whole).
 *
 * This module is also the home of the shared zero-dependency ZIP reader
 * (DataView + native DecompressionStream) that `officeText.ts` reuses; it is
 * import-free on purpose so it can run both in the extension and under plain
 * Node.
 */

// Raw uncompressed bytes are capped so a pathological file can't hang the panel.
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024; // 64MB per zip entry

interface ZipEntry {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50; // End Of Central Directory
const SIG_CENTRAL = 0x02014b50; // Central directory file header
const SIG_LOCAL = 0x04034b50; // Local file header

/** Inflate a raw DEFLATE stream using the native DecompressionStream. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Locate and parse the End Of Central Directory record, then the central directory. */
function readCentralDirectory(view: DataView): ZipEntry[] {
  const len = view.byteLength;
  // EOCD is 22 bytes + an optional trailing comment (<= 65535). Scan backwards.
  const minEocd = 22;
  const scanStart = Math.max(0, len - (minEocd + 0xffff));
  let eocd = -1;
  for (let i = len - minEocd; i >= scanStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP: End Of Central Directory not found');

  const entryCount = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true); // central directory offset

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(ptr, true) !== SIG_CENTRAL) break;
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + ptr + 46, nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read (and inflate if needed) the bytes of one zip entry. */
async function readEntryBytes(view: DataView, entry: ZipEntry): Promise<Uint8Array> {
  const base = entry.localHeaderOffset;
  if (view.getUint32(base, true) !== SIG_LOCAL) {
    throw new Error(`Corrupt ZIP: bad local header for ${entry.name}`);
  }
  const nameLen = view.getUint16(base + 26, true);
  const extraLen = view.getUint16(base + 28, true);
  const dataStart = base + 30 + nameLen + extraLen;
  const compressed = new Uint8Array(view.buffer, view.byteOffset + dataStart, entry.compressedSize);
  if (entry.method === 0) return compressed; // stored
  if (entry.method === 8) {
    const out = await inflateRaw(compressed);
    if (out.byteLength > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP entry ${entry.name} expands beyond the size limit`);
    }
    return out;
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/** Parse a ZIP archive into a map of entry-name → decoded UTF-8 text (only matching entries). */
async function unzipTextEntries(buffer: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(buffer);
  const entries = readCentralDirectory(view);
  const decoder = new TextDecoder('utf-8');
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (!want(entry.name)) continue;
    const bytes = await readEntryBytes(view, entry);
    out.set(entry.name, decoder.decode(bytes));
  }
  return out;
}

/** Decode the five predefined XML entities plus numeric character references. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // must be last so we don't double-decode
}

/** Body XML of a .docx (word/document.xml). */
export async function readDocxBodyXml(buffer: ArrayBuffer): Promise<string> {
  const files = await unzipTextEntries(buffer, name => name === 'word/document.xml');
  const body = files.get('word/document.xml');
  if (!body) throw new Error('Not a valid .docx: word/document.xml missing');
  return body;
}

/** Section XMLs of a .hwpx (Contents/sectionN.xml), in numeric section order. */
export async function readHwpxSectionsXml(buffer: ArrayBuffer): Promise<string[]> {
  const sectionRe = /^Contents\/section\d+\.xml$/;
  const files = await unzipTextEntries(buffer, name => sectionRe.test(name));
  if (files.size === 0) throw new Error('Not a valid .hwpx: no Contents/sectionN.xml found');
  const ordered = [...files.keys()].sort((a, b) => {
    const na = Number(a.match(/section(\d+)/)?.[1] ?? 0);
    const nb = Number(b.match(/section(\d+)/)?.[1] ?? 0);
    return na - nb;
  });
  return ordered.map(name => files.get(name) ?? '');
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

export interface DocParseResult {
  kind: 'docx' | 'hwpx' | 'pdf';
  toc: TocEntry[]; // navigation index, one per table (incl. nested) — deterministic, no LLM
  blocks: DocBlock[]; // self-contained retrieval units
  // Form field index (schema layer): every "Label: value" pair found in the
  // paragraphs and table pair-lines, grouped by the section header it sits
  // under. Additive over `blocks` (nothing is lost); it makes a form document's
  // values discoverable up front instead of only via a blind keyword search,
  // and the section disambiguates repeated labels (a company Telephone vs a
  // billing-contact Primary Phone).
  fields?: FieldEntry[];
  // The whole document as markdown in reading order: paragraphs as text, each
  // top-level table as a markdown table (one line per row, nested tables
  // inlined into their cell). This is what the model reads best — a row-intact
  // table beat the label:value index 14/39 vs 3/39 on the same document —
  // and it is the inline/guide payload for office documents.
  markdown?: string;
  stats: { tables: number; maxDepth: number; blocks: number };
  // PDF only (M4): one rendered image per page, produced ONCE at attach time,
  // for the view_doc sticky slot. Office documents leave this undefined.
  pages?: DocPageImage[];
}

/** One rendered PDF page image for the view_doc sticky slot. */
export interface DocPageImage {
  index: number; // 1-based page number — matches the 'pN' toc/block ids
  image: string; // data URL (JPEG)
}

export interface TocEntry {
  id: string; // 't1', 't1-2' (nested), stable
  title: string; // nearest preceding paragraph text, else first-row cells joined
  fields: string[]; // header-row cell texts
  rowCount: number;
  parentId?: string; // for nested tables
}

export interface DocBlock {
  id: string;
  tableId?: string; // undefined for plain paragraph blocks
  breadcrumb: string; // e.g. 't1-2 = inside a cell of t1 r4'
  lines: string[]; // searchable lines
}

/** One "Label: value" pair from the form, tagged with its section and origin block. */
export interface FieldEntry {
  label: string;
  value: string;
  section?: string; // the ALL-CAPS header this field sits under
  ref: string; // origin block id ('p4', 't6') for traceability
}

const TITLE_MAX_CHARS = 60;
const FIELD_MAX_CHARS = 30;

interface FormatTags {
  tbl: string;
  tr: string;
  tc: string;
  t: string;
  para: string;
}

const DOCX_TAGS: FormatTags = { tbl: 'w:tbl', tr: 'w:tr', tc: 'w:tc', t: 'w:t', para: 'w:p' };
const HWPX_TAGS: FormatTags = { tbl: 'hp:tbl', tr: 'hp:tr', tc: 'hp:tc', t: 'hp:t', para: 'hp:p' };

// Placeholder elements substituted for already-cut table spans. A raw '<' can
// never occur in well-formed XML text content (it is always escaped as &lt;),
// so these pseudo-tags can never collide with document text.
const NEST_PLACEHOLDER_RE = /<NEST(\d+)\/>/g;

// ---------------------------------------------------------------------------
// Balanced scanner
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

/**
 * Top-level `<tag …>…</tag>` spans of `xml`, skipping inner nesting by depth
 * counting. The `(?=[ >])` lookahead keeps `<w:t` from matching `<w:tc>` /
 * `<w:tcPr>` / `<w:tbl>`. Self-closing tags (`<hp:tbl …/>`) do not change the
 * depth; a self-closing tag at the root position yields an empty block.
 */
function findBalanced(xml: string, tag: string): Span[] {
  const spans: Span[] = [];
  const openRe = new RegExp(`<${tag}(?=[ >])`, 'g');
  const tokenSrc = `<${tag}(?=[ >])[^>]*?(\\/?)>|<\\/${tag}>`;
  let i = 0;
  for (;;) {
    openRe.lastIndex = i;
    const m = openRe.exec(xml);
    if (!m) return spans;
    const start = m.index;
    let depth = 0;
    let end = start;
    const tokenRe = new RegExp(tokenSrc, 'g');
    tokenRe.lastIndex = start;
    let tok: RegExpExecArray | null;
    while ((tok = tokenRe.exec(xml)) !== null) {
      const text = tok[0];
      if (text.startsWith('</')) {
        depth -= 1;
      } else if (text.endsWith('/>')) {
        if (tok.index === start) {
          end = tok.index + text.length; // self-closing at root: empty block
          break;
        }
        continue; // self-closing elsewhere: no depth change
      } else {
        depth += 1;
      }
      if (depth === 0) {
        end = tok.index + text.length;
        break;
      }
    }
    if (end <= start) end = start + m[0].length; // unbalanced: skip past the open tag
    spans.push({ start, end });
    i = end;
  }
}

// ---------------------------------------------------------------------------
// Text extraction (run-joining)
// ---------------------------------------------------------------------------

/**
 * Visible text of an XML fragment. Runs inside one paragraph are joined with
 * NO separator (Word splits one word across runs mid-word); separate
 * paragraphs are joined with a single space; whitespace is collapsed.
 *
 * Literal '|' in document text is replaced with '∣' (U+2223 DIVIDES): '|' is
 * the column separator of every serialized row/pair line, so a cell that
 * contains pipes would otherwise fake extra columns. This is the single
 * point where cell/paragraph text is produced, so the search index and the
 * rendered lines change consistently and matching is unaffected.
 */
function fragmentText(fragment: string, tags: FormatTags): string {
  const runRe = new RegExp(`<${tags.t}(?:\\s[^>]*)?>([\\s\\S]*?)</${tags.t}>`, 'g');
  const paraTexts: string[] = [];
  for (const para of fragment.split(`</${tags.para}>`)) {
    let text = '';
    for (const m of para.matchAll(runRe)) {
      text += decodeXmlEntities(m[1].replace(/<[^>]+>/g, ''));
    }
    if (text.trim()) paraTexts.push(text);
  }
  return paraTexts.join(' ').replace(/\s+/g, ' ').trim().replace(/\|/g, '∣');
}

/** Read an attribute value out of a single already-matched XML tag string. */
function attrValue(tag: string | undefined, name: string): string | undefined {
  if (!tag) return undefined;
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

// ---------------------------------------------------------------------------
// Cells and grid resolution
// ---------------------------------------------------------------------------

/** One table cell with its grid anchor position and spans. */
interface CellInfo {
  row: number;
  col: number;
  colSpan: number;
  rowSpan: number;
  text: string;
}

/** One resolved grid position (spanned positions carry their anchor's value). */
interface GridCell {
  text: string;
  colSpan: number;
  rowSpan: number;
  anchorRow: number;
  anchorCol: number;
}

/** Where a nested table sits inside its parent, plus a title hint from the cell text before it. */
interface NestInfo {
  parentRow: number; // 1-based row of the containing cell
  titleHint: string;
}

/**
 * Parse the rows/cells of one table body (inner tables already replaced by
 * placeholders) into anchored cells. hwpx cells carry exact grid coordinates
 * (`hp:cellAddr` colAddr/rowAddr) and spans (`hp:cellSpan` colSpan/rowSpan);
 * covered cells are simply absent. docx cells use a column cursor plus
 * `w:gridSpan` (horizontal) and `w:vMerge` chains (vertical: restart = anchor,
 * bare/continue = covered continuation cells that are physically present).
 */
function collectCells(
  body: string,
  tags: FormatTags,
  childLabel: (nestIndex: number) => string,
  nests: Map<number, NestInfo>,
): CellInfo[] {
  const isHwpx = tags.tbl === HWPX_TAGS.tbl;
  interface RawCell {
    row: number;
    col: number;
    colSpan: number;
    rowSpan: number;
    text: string;
    vMerge?: 'restart' | 'continue';
  }
  const rows: RawCell[][] = [];

  for (const trSpan of findBalanced(body, tags.tr)) {
    const r = rows.length;
    const rowXml = body.slice(trSpan.start, trSpan.end);
    const rowCells: RawCell[] = [];
    let cursor = 0;
    for (const tcSpan of findBalanced(rowXml, tags.tc)) {
      const cellXml = rowXml.slice(tcSpan.start, tcSpan.end);
      let row = r;
      let col = cursor;
      let colSpan = 1;
      let rowSpan = 1;
      let vMerge: RawCell['vMerge'];
      if (isHwpx) {
        const addrTag = /<hp:cellAddr\b[^>]*>/.exec(cellXml)?.[0];
        const spanTag = /<hp:cellSpan\b[^>]*>/.exec(cellXml)?.[0];
        row = Number(attrValue(addrTag, 'rowAddr') ?? r);
        col = Number(attrValue(addrTag, 'colAddr') ?? cursor);
        colSpan = Math.max(1, Number(attrValue(spanTag, 'colSpan') ?? 1));
        rowSpan = Math.max(1, Number(attrValue(spanTag, 'rowSpan') ?? 1));
      } else {
        const tcPr = /<w:tcPr>[\s\S]*?<\/w:tcPr>/.exec(cellXml)?.[0] ?? '';
        colSpan = Math.max(1, Number(attrValue(/<w:gridSpan\b[^>]*>/.exec(tcPr)?.[0], 'w:val') ?? 1));
        const vm = /<w:vMerge\b[^>]*>/.exec(tcPr)?.[0];
        if (vm) vMerge = vm.includes('restart') ? 'restart' : 'continue';
      }

      // Nested-table placeholders in this cell: record location + title hint,
      // and leave a human-readable pointer in the cell text.
      let text = fragmentText(cellXml, tags);
      NEST_PLACEHOLDER_RE.lastIndex = 0;
      let nm: RegExpExecArray | null;
      while ((nm = NEST_PLACEHOLDER_RE.exec(cellXml)) !== null) {
        const k = Number(nm[1]);
        nests.set(k, { parentRow: row + 1, titleHint: fragmentText(cellXml.slice(0, nm.index), tags) });
        text = (text ? `${text} ` : '') + `(→ ${childLabel(k)})`;
        if (vMerge === 'continue') vMerge = undefined; // never drop a cell that owns a nested table
      }

      rowCells.push({ row, col, colSpan, rowSpan, text, vMerge });
      cursor = col + colSpan;
    }
    rows.push(rowCells);
  }

  // Resolve docx vertical-merge chains into a rowSpan on the anchor cell and
  // drop the covered continuation cells (grid fill re-creates them below).
  const cells: CellInfo[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (const cell of rows[r]) {
      if (cell.vMerge === 'continue' && r > 0 && rows[r - 1].some(p => p.col === cell.col)) continue;
      let rowSpan = cell.rowSpan;
      if (!isHwpx) {
        let rr = r + 1;
        while (rr < rows.length && rows[rr].some(p => p.col === cell.col && p.vMerge === 'continue')) {
          rowSpan += 1;
          rr += 1;
        }
      }
      cells.push({ row: cell.row, col: cell.col, colSpan: cell.colSpan, rowSpan, text: cell.text });
    }
  }
  return cells;
}

/** Fill every grid position: anchors keep their span, covered positions get the anchor's value. */
function resolveGrid(cells: CellInfo[]): GridCell[][] {
  let width = 0;
  let height = 0;
  for (const c of cells) {
    width = Math.max(width, c.col + c.colSpan);
    height = Math.max(height, c.row + c.rowSpan);
  }
  const grid: (GridCell | null)[][] = Array.from({ length: height }, () =>
    new Array<GridCell | null>(width).fill(null),
  );
  for (const c of cells) {
    for (let r = c.row; r < c.row + c.rowSpan; r++) {
      for (let col = c.col; col < c.col + c.colSpan; col++) {
        if (!grid[r][col]) {
          grid[r][col] = { text: c.text, colSpan: c.colSpan, rowSpan: c.rowSpan, anchorRow: c.row, anchorCol: c.col };
        }
      }
    }
  }
  // Unclaimed holes become empty 1x1 cells so every row has the full grid width.
  return grid.map((row, r) =>
    row.map((cell, col) => cell ?? { text: '', colSpan: 1, rowSpan: 1, anchorRow: r, anchorCol: col }),
  );
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

interface EmitCtx {
  tags: FormatTags;
  toc: TocEntry[];
  blocks: DocBlock[];
  stats: { tables: number; maxDepth: number };
  lastInline: string; // inline text of the table emitTable just finished (for the parent's cell)
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Label printed for a table id — the id itself ('t1-2'). Serialization is
 *  English so a non-Korean model never has to decode the coordinate tokens. */
function tableLabel(id: string): string {
  return id;
}

/**
 * Emit one table (recursively for nested tables) as a TOC entry plus one
 * retrieval block of aligned raw row lines and canonical pair lines.
 */
/** Pointer left in a cell for a nested table: "(→ t2-1)" → child index 0. */
const NEST_POINTER_RE = /\s*\(→ t[\d-]*?(\d+)\)/g;

/**
 * One table as a markdown table: first grid row as the header, one line per
 * row, spanned positions left blank (the anchor carries the value once), a
 * nested table replaced by its inline rendering. Row cohesion is the point —
 * a line-item row stays one line.
 */
function tableToMarkdown(grid: GridCell[][], inline: (k: number) => string): string {
  const cellText = (cell: GridCell, r: number, c: number): string => {
    if (cell.anchorRow !== r || cell.anchorCol !== c) return '';
    return cell.text
      .replace(NEST_POINTER_RE, (_m, n) => ` ${inline(Number(n) - 1)}`)
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  };
  const rows = grid.map((row, r) => `| ${row.map((cell, c) => cellText(cell, r, c)).join(' | ')} |`);
  if (rows.length === 0) return '';
  const sep = `|${grid[0].map(() => '---').join('|')}|`;
  return [rows[0], sep, ...rows.slice(1)].join('\n');
}

/** A nested table as one cell's text: "label: value" for a 2x1 mini table, else rows joined. */
function tableToInline(grid: GridCell[][]): string {
  const rowTexts = grid.map(row =>
    row
      .filter((cell, c) => cell.anchorCol === c)
      .map(cell => cell.text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' | '),
  );
  if (grid.length === 2 && grid[0].length === 1 && rowTexts[0] && rowTexts[1]) return `${rowTexts[0]}: ${rowTexts[1]}`;
  return rowTexts.filter(Boolean).join(' / ');
}

function emitTable(
  tblXml: string,
  id: string,
  title: string | undefined,
  parentId: string | undefined,
  breadcrumb: string,
  ctx: EmitCtx,
): string {
  const { tags } = ctx;
  const label = tableLabel(id);
  ctx.stats.tables += 1;
  ctx.stats.maxDepth = Math.max(ctx.stats.maxDepth, id.split('-').length);

  const openEnd = tblXml.indexOf('>') + 1;
  const closeIdx = tblXml.lastIndexOf(`</${tags.tbl}>`);
  let body = closeIdx > openEnd ? tblXml.slice(openEnd, closeIdx) : '';

  // 1) Replace inner tables with placeholders, back to front so indices hold.
  const innerSpans = findBalanced(body, tags.tbl);
  const inners = innerSpans.map(s => body.slice(s.start, s.end));
  for (let k = innerSpans.length - 1; k >= 0; k--) {
    body = `${body.slice(0, innerSpans[k].start)}<NEST${k}/>${body.slice(innerSpans[k].end)}`;
  }

  // 2) Now every row/cell in `body` belongs to THIS table — cut and resolve.
  const nests = new Map<number, NestInfo>();
  const grid = resolveGrid(collectCells(body, tags, k => tableLabel(`${id}-${k + 1}`), nests));
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;

  const headerCells: string[] = [];
  for (let c = 0; c < width; c++) {
    const cell = grid[0][c];
    if (cell.anchorRow === 0 && cell.anchorCol === c && cell.text.trim()) {
      headerCells.push(truncate(cell.text.trim(), FIELD_MAX_CHARS));
    }
  }
  const tocTitle = truncate(title?.trim() || headerCells.join(' | ') || label, TITLE_MAX_CHARS);
  ctx.toc.push({ id, title: tocTitle, fields: headerCells, rowCount: height, ...(parentId ? { parentId } : {}) });

  // Aligned raw row lines (rule 1): full grid width, compact merge annotation
  // on the anchor. Each row segment of a merge starts with the anchor's value
  // (so rows under a vertical merge still carry their context), and further
  // horizontal repeats within the row collapse to a ditto mark to keep lines
  // compact. Empties stay so columns keep aligning (rule 3).
  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const parts: string[] = [];
    for (let c = 0; c < width; c++) {
      const cell = grid[r][c];
      const prev = c > 0 ? grid[r][c - 1] : undefined;
      if (prev && prev.anchorRow === cell.anchorRow && prev.anchorCol === cell.anchorCol) {
        parts.push('〃');
        continue;
      }
      let s = cell.text;
      if ((cell.colSpan > 1 || cell.rowSpan > 1) && cell.anchorRow === r && cell.anchorCol === c) {
        const mark = `⟨${cell.colSpan}x${cell.rowSpan} merged⟩`;
        s = s ? `${s} ${mark}` : mark;
      }
      parts.push(s);
    }
    lines.push(`[${label} r${r + 1}] ${parts.join(' | ')}`);
  }

  // Canonical pair lines (rule 2): "leftLabel | topHeader: value", additive
  // and deduped. Heuristic: a table 3+ columns wide is assumed to have a
  // header first row; a 2-column table is a label-value list (first row is data).
  const hasHeader = width >= 3 && height >= 2;
  const seenPairs = new Set<string>();
  for (let r = hasHeader ? 1 : 0; r < height; r++) {
    const leftLabel = grid[r][0].text.trim();
    for (let c = 1; c < width; c++) {
      const cell = grid[r][c];
      const value = cell.text.trim();
      if (!value) continue; // empty-cell economy (rule 3)
      if (cell.anchorCol === 0) continue; // spill-over of the label cell itself
      if (hasHeader && cell.anchorRow === 0) continue; // header cell itself
      const header = hasHeader ? grid[0][c].text.trim() : '';
      let pair: string;
      if (leftLabel && header) pair = `${leftLabel} | ${header}: ${value}`;
      else if (leftLabel) pair = `${leftLabel}: ${value}`;
      else if (header) pair = `${header}: ${value}`;
      else continue;
      const line = `[${label}] ${pair}`;
      if (!seenPairs.has(line)) {
        seenPairs.add(line);
        lines.push(line);
      }
    }
  }

  // Boxed and ticked values (rule 5): a value split one glyph per cell
  // ("1|4|0|1|2|0|2|6" = a DD/MM/YYYY date box) is invisible to keyword search
  // — the digits match no query and the model has to reassemble them; a
  // checkbox row's value is *which* option carries the tick, not the glyph.
  // Emit an additive, deduped summary line per row so search_doc and read_table
  // surface the whole value. The raw cell lines above are untouched, so a
  // doc_ref cell coordinate still resolves to the original cell.
  const CHECKED = /[☑☒■✓✔]/;
  const UNCHECKED = /[☐□]/g;
  for (let r = 0; r < height; r++) {
    const texts = grid[r]
      .filter((cell, c) => cell.anchorRow === r && cell.anchorCol === c)
      .map(cell => cell.text.trim())
      .filter(Boolean);

    // (a) glyph run: 3+ cells that are each a single character → one value.
    const glyphs = texts.filter(t => t.length === 1);
    if (glyphs.length >= 3 && glyphs.length >= texts.length - 1) {
      lines.push(`[${label} r${r + 1} joined] ${glyphs.join('')}`);
    }

    // (b) ticked options: take the label after each checked mark, not the
    // whole cell (a cell holds every option, only one is ticked).
    const picked: string[] = [];
    for (const t of texts) {
      if (!CHECKED.test(t)) continue;
      for (const seg of t.split(/(?=[☑☒■✓✔☐□])/)) {
        const m = seg.trim();
        if (m && CHECKED.test(m[0])) {
          const opt = m.slice(1).replace(UNCHECKED, '').replace(/\s+/g, ' ').trim();
          if (opt) picked.push(opt);
        }
      }
    }
    if (picked.length > 0) {
      lines.push(`[${label} r${r + 1}] checked: ${[...new Set(picked)].join(', ')}`);
    }
  }

  ctx.blocks.push({ id, tableId: id, breadcrumb, lines });

  // 3) Recurse into inner tables, labelling which cell they came from. Each
  // child returns its inline text so the parent's markdown can embed it.
  const childInline: string[] = [];
  for (let k = 0; k < inners.length; k++) {
    const childId = `${id}-${k + 1}`;
    const info = nests.get(k);
    const childBreadcrumb = `${tableLabel(childId)} = inside a cell of ${label} r${info?.parentRow ?? '?'}`;
    emitTable(inners[k], childId, info?.titleHint || undefined, id, childBreadcrumb, ctx);
    childInline.push(ctx.lastInline);
  }
  ctx.lastInline = tableToInline(grid).replace(NEST_POINTER_RE, (_m, n) => ` ${childInline[Number(n) - 1] ?? ''}`);
  return tableToMarkdown(grid, k => childInline[k] ?? '');
}

// ---------------------------------------------------------------------------
// Body walk: paragraphs + top-level tables, in document order
// ---------------------------------------------------------------------------

// A short ALL-CAPS line with no colon is a section header bar ("BUSINESS
// PROFILE", "BILLING CONTACT"); it scopes the fields that follow it.
export // A section header is an ALL-CAPS word phrase ("BUSINESS PROFILE") — no digits,
// which keeps a code value like "HK-MED-4471902" from being read as a header.
const SECTION_RE = /^[A-Z][A-Z &()/#'’.-]{2,44}$/;
// A label anchor: a word starting after start/space/pipe/slash and ending in
// ": " — deliberately requiring a letter/# start so clock times ("08:35") and
// bare numbers are never mistaken for labels.
export const LABEL_ANCHOR = /(?:^|[\s|/])([#A-Za-z가-힣][A-Za-z0-9가-힣 #/$'.()&+-]{0,38}?):\s/g;

/** Drop the "[t3 r1] " / "[t6] " render prefix so only the cell text remains. */
export function stripLinePrefix(line: string): string {
  const m = /^\[[^\]]*\]\s*/.exec(line);
  return m ? line.slice(m[0].length) : line;
}

/** Split one line into every "Label: value" it carries (a form line often
 *  packs several: "Telephone: X  Fax: Y  Website: Z"). General, not per-doc. */
export function splitFields(text: string): { label: string; value: string }[] {
  const anchors: { matchStart: number; label: string; valStart: number }[] = [];
  LABEL_ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_ANCHOR.exec(text)) !== null) {
    anchors.push({ matchStart: m.index, label: m[1].trim(), valStart: m.index + m[0].length });
    LABEL_ANCHOR.lastIndex = m.index + m[0].length;
  }
  const out: { label: string; value: string }[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const end = i + 1 < anchors.length ? anchors[i + 1].matchStart : text.length;
    // Drop trailing blank-fill underscores ("____") — an unfilled form slot.
    const value = text
      .slice(anchors[i].valStart, end)
      .replace(/[_]{3,}.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (value && value.length <= 120) out.push({ label: anchors[i].label, value });
  }
  return out;
}

/** A single-spaced form line hides the value→label boundary: "Electronics
 *  Manufacturing # of Employees: 180" grabs "Manufacturing" into the next
 *  label. When a label starts with a capitalised word and then carries a "#"
 *  (the "# of ..." idiom), re-anchor at the "#" and hand the leading words
 *  back to the previous value. General to the "#"/"No." count idiom, not a
 *  per-document rule. */
export function retightenFields(pairs: { label: string; value: string }[]): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const p of pairs) {
    const hash = p.label.search(/\s#|\sNo\.?\s/);
    if (hash > 0 && out.length > 0) {
      out[out.length - 1].value = `${out[out.length - 1].value} ${p.label.slice(0, hash)}`.trim();
      out.push({ label: p.label.slice(hash).trim(), value: p.value });
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Build the form-field index over the assembled blocks (document order). */
/** The "caption above value" field cell: a nested 2-row single-column table
 *  whose first row is the label and second is the value (python-docx
 *  labelled_cell / the boxed HK-insurer field block). General to that layout,
 *  not to any one form. Returns [] for anything that is not that shape. */
export function tableFields(block: DocBlock): { label: string; value: string }[] {
  const rows: string[] = [];
  for (const line of block.lines) {
    const m = /^\[[^\]]*r\d+\]\s*(.*)$/.exec(line);
    if (m) rows.push(m[1].trim());
  }
  if (rows.length !== 2) return [];
  if (rows[0].includes(' | ') || rows[1].includes(' | ')) return []; // multi-column, not a caption cell
  const label = rows[0].replace(/[*]+$/, '').trim();
  const value = rows[1]
    .replace(/[_]{3,}.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label || !value || label.length > 44 || /^[☐☒■✓✔]$/.test(value)) return [];
  return [{ label, value }];
}

/** A header + data-rows table (e.g. "Category | Item | Amount HK$") where one
 *  column is the value (numeric, or a value-word header) and another is the
 *  descriptive label. Emits {descriptive cell: value cell} per data row — the
 *  amount/line-item shape the caption cell reader misses. General table
 *  semantics, not a per-form rule; the exact grid comes straight from the XML,
 *  so nothing is inferred. */
export function dataTableFields(block: DocBlock): { label: string; value: string }[] {
  const rows = block.lines
    .map(l => /^\[[^\]]*r\d+\]\s*(.*)$/.exec(l)?.[1])
    .filter((r): r is string => r != null)
    .map(r => r.split(' | ').map(c => c.replace(/⟨[^⟩]*⟩/g, '').trim()));
  if (rows.length < 2) return [];
  const ncol = Math.max(...rows.map(r => r.length));
  if (ncol < 2) return [];
  const header = rows[0];
  const body = rows.slice(1);
  const NUM = /^[$₩€£]?\s?[\d,]+(\.\d+)?%?$/;
  const VALHDR = /amount|value|fee|total|금액|값|price|rate|qty|수량|\$/i;
  // value column: value-word header, else the column that is mostly numeric.
  let valCol = -1;
  for (let c = ncol - 1; c >= 0; c--) {
    const cells = body.map(r => r[c] ?? '');
    const numFrac = cells.filter(x => NUM.test(x)).length / Math.max(1, cells.length);
    if (VALHDR.test(header[c] ?? '') || numFrac >= 0.5) {
      valCol = c;
      break;
    }
  }
  if (valCol < 0) return [];
  // label column: the non-value column with the longest, non-constant text
  // (skips a "Category" column whose value repeats every row).
  let labCol = -1;
  let best = -1;
  for (let c = 0; c < ncol; c++) {
    if (c === valCol) continue;
    const distinct = new Set(body.map(r => r[c] ?? '')).size;
    if (distinct < 2) continue;
    const avg = body.reduce((s, r) => s + (r[c]?.length ?? 0), 0) / body.length;
    if (avg > best) {
      best = avg;
      labCol = c;
    }
  }
  if (labCol < 0) return [];
  const out: { label: string; value: string }[] = [];
  for (const r of body) {
    const label = (r[labCol] ?? '').replace(/[*#^]+$/, '').trim();
    const value = (r[valCol] ?? '').trim();
    if (label && value && value.length <= 40 && !/not applicable|^n\/?a$/i.test(value)) {
      out.push({ label, value });
    }
  }
  return out;
}

/** A wide line-item grid (ncol>=4 with a value column) where every ROW is one
 *  entity and every COLUMN one of its attributes. Emits every non-empty cell as
 *  {header: cell} tagged with its 1-based data-row number, so all attributes of
 *  a line — date, type, amount, currency, rate — become discoverable, not just
 *  the one label→value pair dataTableFields keeps. Generic grid semantics; the
 *  rows come straight from the XML. Narrow (2-3 col) tables are left to
 *  tableFields / dataTableFields. */
export function tableRowFields(block: DocBlock): { label: string; value: string; row: number }[] {
  const rows = block.lines
    .map(l => /^\[[^\]]*r\d+\]\s*(.*)$/.exec(l)?.[1])
    .filter((r): r is string => r != null)
    .map(r => r.split(' | ').map(c => c.replace(/⟨[^⟩]*⟩/g, '').trim()));
  if (rows.length < 2) return [];
  const ncol = Math.max(...rows.map(r => r.length));
  if (ncol < 4) return []; // narrow tables: caption-cell / 2-col amount grid handle them
  const header = rows[0];
  const body = rows.slice(1);
  // A real line-item grid is well-formed: most data rows span the full width. A
  // summary/category table with merged or split cells (ragged rows) is not one —
  // exploding it row-wise only yields misaligned junk, so skip it.
  const aligned = body.filter(r => r.length === ncol).length;
  if (aligned < Math.max(1, body.length * 0.5)) return [];
  const NUM = /^[$₩€£]?\s?[\d,]+(\.\d+)?%?$/;
  const VALHDR = /amount|value|fee|total|금액|값|price|rate|qty|수량|\$/i;
  // Only fire on a genuine data grid: some column must read as a value column.
  const hasValueCol = header.some((h, c) => {
    if (VALHDR.test(h ?? '')) return true;
    const cells = body.map(r => r[c] ?? '');
    return cells.filter(x => NUM.test(x)).length / Math.max(1, cells.length) >= 0.5;
  });
  if (!hasValueCol) return [];
  const out: { label: string; value: string; row: number }[] = [];
  body.forEach((r, i) => {
    for (let c = 0; c < ncol; c++) {
      const label = (header[c] ?? '').replace(/[*#^]+$/, '').trim();
      const value = (r[c] ?? '').trim();
      if (!label || !value || label.length > 44 || value.length > 80) continue;
      if (value.includes('|') || value.includes('∣')) continue; // merged/misaligned cell artifact
      if (/^[☐☒■✓✔]$/.test(value) || /not applicable|^n\/?a$/i.test(value)) continue;
      out.push({ label, value, row: i + 1 });
    }
  });
  return out;
}

export function extractFields(blocks: DocBlock[]): FieldEntry[] {
  const fields: FieldEntry[] = [];
  const seen = new Set<string>();
  let section: string | undefined;
  const add = (label: string, value: string, ref: string, sec: string | undefined = section) => {
    // Drop confirmed guide junk: a label starting with a stray cell pipe is a
    // split-summary merge artifact whose value is the cents fragment
    // ("| Air travel: 00"); "(→ tN)" is a nested-table pointer, not a value.
    if (/^\s*\|/.test(label) || /\(→\s*t\d/.test(label) || /\(→\s*t\d/.test(value)) return;
    const key = `${sec ?? ''}|${label}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    fields.push({ label, value, ...(sec ? { section: sec } : {}), ref });
  };
  for (const b of blocks) {
    // Section header bars (ALL-CAPS one-cell rows) scope the fields that follow.
    for (const raw of b.lines) {
      const line = stripLinePrefix(raw).trim();
      if (line && !line.includes(':') && SECTION_RE.test(line)) section = line;
    }
    if (b.tableId) {
      // Tables: the caption-above-value cell (label over value) and the
      // header+data amount grid. A wide line-item grid (ncol>=4, a value column)
      // is emitted row-wise so every attribute of a line — date, type, amount,
      // currency — is discoverable, each row scoped to its own "…rN" section;
      // narrow grids fall back to the single label→value amount reader.
      for (const { label, value } of tableFields(b)) add(label, value, b.id);
      const grid = tableRowFields(b);
      if (grid.length > 0) {
        // Scope each line to its own table+row so rows never collide across two
        // line-item tables (e.g. expenditure r1 vs subsistence r1) and the
        // group header is honest rather than an inherited, possibly-wrong bar.
        const gridSec = b.tableId ? tableLabel(b.tableId) : (section ?? 'table');
        for (const { label, value, row } of grid) {
          add(label, value, b.id, `${gridSec} r${row}`);
        }
      } else {
        for (const { label, value } of dataTableFields(b)) add(label, value, b.id);
      }
    } else {
      for (const raw of b.lines) {
        const line = stripLinePrefix(raw).trim();
        if (!line || (!line.includes(':') && SECTION_RE.test(line))) continue;
        for (const { label, value } of retightenFields(splitFields(line))) add(label, value, b.id);
      }
    }
  }
  return fields;
}

function parseBodyXml(xml: string, kind: 'docx' | 'hwpx'): DocParseResult {
  const tags = kind === 'docx' ? DOCX_TAGS : HWPX_TAGS;
  const ctx: EmitCtx = { tags, toc: [], blocks: [], stats: { tables: 0, maxDepth: 0 }, lastInline: '' };
  const md: string[] = [];

  const topSpans = findBalanced(xml, tags.tbl);
  const tables = topSpans.map(s => xml.slice(s.start, s.end));
  let outer = xml;
  for (let k = topSpans.length - 1; k >= 0; k--) {
    outer = `${outer.slice(0, topSpans[k].start)}<TBL${k}/>${outer.slice(topSpans[k].end)}`;
  }

  let lastParaText = '';
  let paraCount = 0;
  let paraLines: string[] = [];
  const flushParas = () => {
    if (paraLines.length > 0) {
      paraCount += 1;
      ctx.blocks.push({ id: `p${paraCount}`, breadcrumb: 'body', lines: paraLines });
      paraLines = [];
    }
  };

  // Walk paragraph by paragraph; a table placeholder flushes the pending prose
  // block (rule 4) and emits its table at the right position, with the nearest
  // preceding paragraph text as the table's title.
  const tblRe = /<TBL(\d+)\/>/g;
  for (const frag of outer.split(`</${tags.para}>`)) {
    tblRe.lastIndex = 0;
    let sliceStart = 0;
    let m: RegExpExecArray | null;
    while ((m = tblRe.exec(frag)) !== null) {
      const beforeText = fragmentText(frag.slice(sliceStart, m.index), tags);
      if (beforeText) {
        paraLines.push(beforeText);
        md.push(beforeText);
        lastParaText = beforeText;
      }
      flushParas();
      const k = Number(m[1]);
      const id = `t${k + 1}`;
      const title = lastParaText || undefined;
      const breadcrumb = title ? `${tableLabel(id)} · ${truncate(title, TITLE_MAX_CHARS)}` : tableLabel(id);
      // The id line keeps read_table / doc_ref addressable without a TOC.
      md.push(`[${id}]\n${emitTable(tables[k], id, title, undefined, breadcrumb, ctx)}`);
      sliceStart = m.index + m[0].length;
    }
    const tailText = fragmentText(frag.slice(sliceStart), tags);
    if (tailText) {
      paraLines.push(tailText);
      md.push(tailText);
      lastParaText = tailText;
    }
  }
  flushParas();

  return {
    kind,
    toc: ctx.toc,
    blocks: ctx.blocks,
    fields: extractFields(ctx.blocks),
    markdown: md.filter(Boolean).join('\n\n'),
    stats: { tables: ctx.stats.tables, maxDepth: ctx.stats.maxDepth, blocks: ctx.blocks.length },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a .docx ArrayBuffer into the structured document model. */
export async function parseDocx(buffer: ArrayBuffer): Promise<DocParseResult> {
  return parseBodyXml(await readDocxBodyXml(buffer), 'docx');
}

/** Parse a .hwpx ArrayBuffer into the structured document model. */
export async function parseHwpx(buffer: ArrayBuffer): Promise<DocParseResult> {
  return parseBodyXml((await readHwpxSectionsXml(buffer)).join('\n'), 'hwpx');
}

/** Parse a supported office document, dispatched by file extension ('.docx' | '.hwpx'). */
export async function parseOfficeDocument(buffer: ArrayBuffer, ext: string): Promise<DocParseResult> {
  if (ext === '.docx') return parseDocx(buffer);
  if (ext === '.hwpx') return parseHwpx(buffer);
  throw new Error(`Unsupported office document type: ${ext}`);
}

/** Compact TOC text for prompt injection: one line per table (id, location, title, fields, rows). */
export function formatToc(result: DocParseResult): string {
  return result.toc
    .map(e => {
      const loc = e.parentId ? ` (inside ${e.parentId})` : '';
      const fields = e.fields.length > 0 ? ` | columns: ${e.fields.join(', ')}` : '';
      return `${e.id}${loc} ${e.title}${fields} | ${e.rowCount} rows`;
    })
    .join('\n');
}
