/**
 * Pure query logic for the agent-facing document actions (M3 of doc-tools):
 * ranked keyword search with a deterministic relaxation ladder, whole-table
 * reads, the persistent TOC guide message, and the sticky "found values" slot.
 *
 * Everything here is a pure function over the mirrored doc-store types in
 * `../types` (AttachedDoc / DocParseResult) — no browser, no LLM, no zod.
 * Import-free at runtime on purpose (type-only imports) so it runs under
 * plain Node with `--experimental-strip-types` for the tests in
 * `pages/side-panel/tests/docSearch.test.ts`, next to the M1/M2 doc tests.
 *
 * Design notes (each requirement is evidence-based, see the M3 spec):
 * - Matching is whitespace-insensitive (Korean "연구 책임자" must find
 *   "연구책임자") and case-insensitive for Latin: both line and terms are
 *   lowercased and de-spaced before containment checks.
 * - Scoring is ranked, not boolean: a line scores the sum of the IDF weights
 *   of the query terms it contains, so rarer terms count more than terms
 *   matching hundreds of lines. Coverage dominates rank (a 2-of-3-terms line
 *   ranks below a 3-of-3 line) and IDF orders lines with equal coverage.
 * - A line qualifies when it contains at least half the active terms
 *   (ceil(n/2)), so partial coverage is returned without flooding the result
 *   with single-common-term noise.
 * - Zero hits trigger a deterministic relaxation ladder IN CODE, because weak
 *   models cannot reformulate: (a) drop terms that match nothing, then drop
 *   the least-informative (lowest-IDF) terms one by one; (b) character-bigram
 *   fuzzy match over de-spaced text, labelled "similar"; true zero returns an
 *   explicit "0 hits" with the nearest table titles from the TOC as suggestions.
 *
 * Every string handed to the model is English — the documents themselves may be
 * Korean, but the tool's own framing must not force a non-Korean model to
 * decode it (the serialization tokens are t/r/c, see docParse.ts).
 */
import type { AttachedDoc, DocParseResult } from '../types';

/** Hard cap of rendered search hits — one block, never paginated. */
export const SEARCH_MAX_HITS = 8;
/** ABLATION switch: >0 makes the whole markdown body resident in the guide (no retrieval) when all
 * office docs together fit. 0 = the design default: outline in the guide, tables fetched by read_table. */
export const DOC_GUIDE_MD_MAX_CHARS = 0;
/** Document head shown in the outline (title/purpose), characters. */
export const DOC_HEAD_MAX_CHARS = 300;
/** Max characters of the line portion of one rendered hit. */
export const HIT_LINE_MAX_CHARS = 200;
/** read_table caps: stop after this many lines or this many characters. */
export const TABLE_MAX_LINES = 60;
export const TABLE_MAX_CHARS = 4000;
/** Sticky "found values" slot keeps the last N distinct lines (FIFO). */
export const FOUND_LINES_MAX = 30;
/** Minimum bigram containment for a fuzzy ("similar") hit. */
export const FUZZY_MIN_SIM = 0.5;
/** Minimum bigram containment for a true-zero TOC title suggestion — below
 * this the "nearest" titles are arbitrary document-order noise. */
export const SUGGEST_MIN_SIM = 0.15;

/** Lowercase + strip ALL whitespace: Korean spacing variants and Latin case must not matter. */
export function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function truncateLine(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * "a | 〃 | 〃 | 〃" → "a | 〃×3". Wide merged grids (a cover-page table has
 * 30+ cells per row) drown the truncated hit window in ditto marks that carry
 * no information beyond the anchor's merge marker; collapse runs of 2+.
 * Rendering only — the indexed lines used for matching stay unchanged.
 */
export function collapseDitto(s: string): string {
  return s.replace(/(?: \| 〃)+/g, m => {
    const n = m.length / ' | 〃'.length;
    return n > 1 ? ` | 〃×${n}` : m;
  });
}

/** Character bigrams of an already-normalized string. */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Containment coefficient |q ∩ t| / |q| — how much of the query is covered by the target. */
function bigramContainment(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;
  let hit = 0;
  for (const b of query) if (target.has(b)) hit += 1;
  return hit / query.size;
}

interface IndexedLine {
  docName: string;
  /** 1-based position of the doc among the attached docs — the id prefix. */
  docOrdinal: number;
  tableId?: string;
  line: string;
  norm: string;
}

function buildIndex(docs: AttachedDoc[]): IndexedLine[] {
  const index: IndexedLine[] = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    // PDFs are read by eye (view_doc): their text layer holds labels, not the
    // filled values, and in 13 PDF runs no model ever searched it. Keep them
    // out of the text tools so a hit can't be a label mistaken for a value.
    if (doc.parse.kind === 'pdf') continue;
    for (const block of doc.parse.blocks) {
      for (const line of block.lines) {
        index.push({
          docName: doc.name,
          docOrdinal: i + 1,
          tableId: block.tableId,
          line,
          norm: normalizeForSearch(line),
        });
      }
    }
  }
  return index;
}

/**
 * The FOLLOWABLE table-id reference: every doc numbers tables t1..tN, so with
 * several docs attached a bare id is ambiguous ("t5" of doc 1 shadows "t5" of
 * doc 2). Multi-doc ids are prefixed with the 1-based doc ordinal ("2:t5");
 * a single attached doc keeps the bare id so nothing changes for that case.
 */
function prefixedId(ordinal: number, tableId: string, multiDoc: boolean): string {
  return multiDoc ? `${ordinal}:${tableId}` : tableId;
}

/** The "[tN]\n| … |" markdown block of a top-level table, undefined when the parse has none. */
export function markdownTable(parse: DocParseResult, id: string): string | undefined {
  const md = parse.markdown;
  if (!md) return undefined;
  const start = md.indexOf(`[${id}]\n`);
  if (start < 0) return undefined;
  const end = md.indexOf('\n\n', start);
  return md.slice(start, end < 0 ? undefined : end);
}

/**
 * Column names for the outline, read from the markdown table's first row so a
 * nested-container table shows its inlined labels ("Surname | Forenames …")
 * instead of "(→ t2-1)" pointers; a "Label: value" cell contributes its label.
 */
function outlineColumns(parse: DocParseResult, id: string): string[] {
  const first = markdownTable(parse, id)?.split('\n')[1] ?? '';
  return first
    .split('|')
    .map(c => c.trim())
    .filter(Boolean)
    .map(c => truncateLine(c.split(': ')[0], 30));
}

/** TOC title of a table id within one parse ('' when unknown). */
function tocTitle(parse: DocParseResult, tableId: string): string {
  return parse.toc.find(e => e.id === tableId)?.title ?? '';
}

/** One search hit, already rendered for the model (docName · tableId · line). */
export interface DocHit {
  docName: string;
  tableId?: string;
  line: string;
  rendered: string;
  matched: number;
  score: number;
}

export interface DocSearchOutcome {
  /** 'hits' = exact ranked hits; 'fuzzy' = bigram "similar" hits; 'none' = true zero. */
  status: 'hits' | 'fuzzy' | 'none';
  /** Rendered hits, capped at SEARCH_MAX_HITS. */
  hits: DocHit[];
  /** Qualifying lines before the cap (fuzzy: lines above FUZZY_MIN_SIM). */
  total: number;
  /** Terms removed by the relaxation ladder, in drop order. */
  droppedTerms: string[];
  /** The full result block to hand to the model. */
  text: string;
}

function renderHit(entry: IndexedLine, matched: number, score: number, multiDoc: boolean): DocHit {
  const ref = entry.tableId ? prefixedId(entry.docOrdinal, entry.tableId, multiDoc) : 'body';
  return {
    docName: entry.docName,
    tableId: entry.tableId,
    line: entry.line,
    rendered: `${entry.docName} · ${ref} · ${truncateLine(collapseDitto(entry.line), HIT_LINE_MAX_CHARS)}`,
    matched,
    score,
  };
}

/**
 * Ranked search over every attached document's block lines.
 * Deterministic: same docs + same query always give the same block of text.
 */
export function searchDocs(docs: AttachedDoc[], query: string): DocSearchOutcome {
  const multiDoc = docs.length > 1;
  const index = buildIndex(docs);
  const allTerms = [...new Set(query.split(/\s+/).map(normalizeForSearch).filter(Boolean))];
  if (allTerms.length === 0 || index.length === 0) {
    return { status: 'none', hits: [], total: 0, droppedTerms: [], text: `Document search "${query}": 0 hits.` };
  }

  // Rough IDF: a term matching few lines counts more than one matching hundreds.
  const df = new Map<string, number>();
  for (const term of allTerms) {
    let n = 0;
    for (const entry of index) if (entry.norm.includes(term)) n += 1;
    df.set(term, n);
  }
  const idf = (term: string): number => Math.log(1 + index.length / (1 + (df.get(term) ?? 0)));

  interface Scored {
    entry: IndexedLine;
    matched: number;
    score: number;
    order: number;
  }
  const rank = (active: string[]): Scored[] => {
    const required = Math.max(1, Math.ceil(active.length / 2));
    const scored: Scored[] = [];
    for (let i = 0; i < index.length; i++) {
      const entry = index[i];
      let matched = 0;
      let score = 0;
      for (const term of active) {
        if (entry.norm.includes(term)) {
          matched += 1;
          score += idf(term);
        }
      }
      if (matched >= required) scored.push({ entry, matched, score, order: i });
    }
    scored.sort((a, b) => b.matched - a.matched || b.score - a.score || a.order - b.order);
    return scored;
  };

  // Relaxation ladder step (a): drop terms that match nothing, then drop the
  // least-informative (lowest-IDF = most common) terms one at a time.
  const droppedTerms: string[] = [];
  let active = [...allTerms];
  let scored = rank(active);
  if (scored.length === 0) {
    const dead = active.filter(term => (df.get(term) ?? 0) === 0);
    if (dead.length > 0 && dead.length < active.length) {
      droppedTerms.push(...dead);
      active = active.filter(term => (df.get(term) ?? 0) > 0);
      scored = rank(active);
    }
    while (scored.length === 0 && active.length > 1 && active.some(term => (df.get(term) ?? 0) > 0)) {
      const weakest = [...active].sort((a, b) => idf(a) - idf(b))[0];
      droppedTerms.push(weakest);
      active = active.filter(term => term !== weakest);
      scored = rank(active);
    }
  }

  if (scored.length > 0) {
    const total = scored.length;
    const top = scored.slice(0, SEARCH_MAX_HITS);
    const hits = top.map(s => renderHit(s.entry, s.matched, s.score, multiDoc));
    const lines: string[] = [
      `Document search "${query}": ${total} hits${total > SEARCH_MAX_HITS ? ` (top ${SEARCH_MAX_HITS} shown)` : ''}`,
    ];
    if (droppedTerms.length > 0) {
      lines.push(`Note: dropped these terms, no line contained them: ${droppedTerms.join(', ')}`);
    }
    lines.push(...hits.map(h => h.rendered));
    if (total > SEARCH_MAX_HITS) {
      // Deduped, FOLLOWABLE overflow entries: prefixed ids (+ doc name) when
      // several docs are attached, so the model can read_table any of them.
      const titles: string[] = [];
      const seen = new Set<string>();
      for (const s of scored) {
        const id = s.entry.tableId;
        let label: string;
        if (id) {
          const title = tocTitle(docs[s.entry.docOrdinal - 1].parse, id);
          label = `${prefixedId(s.entry.docOrdinal, id, multiDoc)} ${title}`.trim();
        } else {
          label = 'body';
        }
        if (multiDoc) label += ` (${s.entry.docName})`;
        if (seen.has(label)) continue;
        seen.add(label);
        titles.push(label);
      }
      const shown = titles.slice(0, 6).join(', ') + (titles.length > 6 ? ` +${titles.length - 6} more` : '');
      lines.push(
        `…and ${total - SEARCH_MAX_HITS} more. Tables matched: ${shown}. Narrow the query to 2-3 specific content words, or call read_table to read a whole table.`,
      );
    }
    return { status: 'hits', hits, total, droppedTerms, text: lines.join('\n') };
  }

  // Ladder step (b): character-bigram fuzzy match over de-spaced text ("similar").
  const qBigrams = bigrams(normalizeForSearch(query));
  if (qBigrams.size > 0) {
    const fuzzyScored: Scored[] = [];
    for (let i = 0; i < index.length; i++) {
      const sim = bigramContainment(qBigrams, bigrams(index[i].norm));
      if (sim >= FUZZY_MIN_SIM) fuzzyScored.push({ entry: index[i], matched: 0, score: sim, order: i });
    }
    fuzzyScored.sort((a, b) => b.score - a.score || a.order - b.order);
    if (fuzzyScored.length > 0) {
      const total = fuzzyScored.length;
      const hits = fuzzyScored.slice(0, SEARCH_MAX_HITS).map(s => renderHit(s.entry, 0, s.score, multiDoc));
      const text = [
        `Document search "${query}": 0 exact hits — ${Math.min(total, SEARCH_MAX_HITS)} similar lines:`,
        ...hits.map(h => h.rendered),
        'Those are approximate matches. Search again with different wording, or call read_table to read a whole table.',
      ].join('\n');
      return { status: 'fuzzy', hits, total, droppedTerms, text };
    }
  }

  // True zero: an explicit "0 hits" + nearest table titles from the TOC as suggestions.
  // Only titles above SUGGEST_MIN_SIM qualify — without the floor the "top 3"
  // at similarity ≈ 0 are just the first tables in document order.
  interface TocSuggestion {
    label: string;
    sim: number;
    order: number;
  }
  const suggestions: TocSuggestion[] = [];
  let order = 0;
  for (let i = 0; i < docs.length; i++) {
    for (const entry of docs[i].parse.toc) {
      const sim = bigramContainment(qBigrams, bigrams(normalizeForSearch(`${entry.title} ${entry.fields.join(' ')}`)));
      if (sim >= SUGGEST_MIN_SIM) {
        suggestions.push({ label: `${prefixedId(i + 1, entry.id, multiDoc)} ${entry.title}`, sim, order });
      }
      order += 1;
    }
  }
  suggestions.sort((a, b) => b.sim - a.sim || a.order - b.order);
  const nearest = suggestions.slice(0, 3).map(s => s.label);
  const text =
    nearest.length > 0
      ? `Document search "${query}": 0 hits. Tables with a similar title: ${nearest.join(', ')}. Search again with different wording, or call read_table to read a whole table.`
      : `Document search "${query}": 0 hits. No related table found — pick one from the outline yourself, or search with different wording.`;
  return { status: 'none', hits: [], total: 0, droppedTerms, text };
}

export interface ReadTableOutcome {
  ok: boolean;
  /** Result (or single-line error) to hand to the model. */
  text: string;
  /** Sticky-slot lines (docName · tableId · line) for the lines actually returned. */
  stickyLines: string[];
  docName?: string;
  /** Number of table lines included in the result. */
  lineCount: number;
}

/** Read one table out of one doc, undefined when the id is not in its TOC/blocks. */
function readTableFromDoc(doc: AttachedDoc, id: string): ReadTableOutcome | undefined {
  if (doc.parse.kind === 'pdf') return undefined; // PDFs: view_doc only (see buildIndex)
  const entry = doc.parse.toc.find(e => e.id === id);
  const block = doc.parse.blocks.find(b => b.tableId === id);
  if (!entry || !block) return undefined;

  // A top-level table of an office document comes back as its markdown table
  // (header line + one line per row, nested mini tables inlined as
  // "Label: value"). Same document, same model: row-intact markdown 14/39 vs
  // the split line dump 3/39. Nested ids and PDFs keep the line dump.
  const md = markdownTable(doc.parse, id);
  if (md) {
    const rows = md.split('\n').slice(1); // drop the "[tN]" id line
    const body = rows.join('\n').slice(0, TABLE_MAX_CHARS);
    return {
      ok: true,
      text: `${doc.name} · ${id} ${entry.title} · ${entry.rowCount} rows\n${body}`,
      stickyLines: rows
        .filter(r => r.startsWith('| ') && !/^\|(---\|)+$/.test(r))
        .map(r => `${doc.name} · ${id} · ${truncateLine(r, HIT_LINE_MAX_CHARS)}`),
      docName: doc.name,
      lineCount: rows.length,
    };
  }

  const included: string[] = [];
  let chars = 0;
  for (const line of block.lines) {
    if (included.length >= TABLE_MAX_LINES || chars + line.length > TABLE_MAX_CHARS) break;
    included.push(line);
    chars += line.length + 1;
  }
  const omitted = block.lines.length - included.length;
  const parts = [
    `${doc.name} · ${id} ${entry.title} · ${block.breadcrumb} · ${entry.rowCount} rows`,
    ...included.map(collapseDitto),
  ];
  if (omitted > 0) parts.push(`…${omitted} more rows — use search_doc to narrow it down`);
  return {
    ok: true,
    text: parts.join('\n'),
    stickyLines: included.map(line => `${doc.name} · ${id} · ${truncateLine(collapseDitto(line), HIT_LINE_MAX_CHARS)}`),
    docName: doc.name,
    lineCount: included.length,
  };
}

/** Single-line unknown-id error carrying the deduped list of followable ids. */
function unknownTableIdError(docs: AttachedDoc[], id: string): ReadTableOutcome {
  const multiDoc = docs.length > 1;
  const allIds = [...new Set(docs.flatMap((doc, i) => doc.parse.toc.map(e => prefixedId(i + 1, e.id, multiDoc))))];
  const shown = allIds.slice(0, 40).join(', ') + (allIds.length > 40 ? ` …+${allIds.length - 40} more` : '');
  const text =
    allIds.length > 0
      ? `No table with id "${id}". Available table ids: ${shown}`
      : `No table with id "${id}". The attached documents contain no tables.`;
  return { ok: false, text, stickyLines: [], lineCount: 0 };
}

/**
 * Whole-table read by table id ('t3', 't3-1'), the escalation path when
 * search is ambiguous. Errors are single-line on purpose: the agent memory
 * only keeps the last line of an error.
 *
 * Ids are case-insensitive ("T4" ≡ "t4"). With several docs attached the
 * multi-doc TOC prints ordinal-prefixed ids ("2:t5" = t5 of the 2nd doc);
 * those resolve within that doc. A bare id resolves only when exactly one
 * attached doc has it — otherwise the error lists the prefixed candidates,
 * because first-doc-wins silently shadowed the other docs' tables.
 */
export function readDocTable(docs: AttachedDoc[], tableId: string): ReadTableOutcome {
  const raw = tableId.trim().toLowerCase();

  // "N:tid" — explicit doc ordinal, as printed in the multi-doc TOC and hits.
  const prefixed = /^(\d+)\s*:\s*(\S+)$/.exec(raw);
  if (prefixed) {
    const ordinal = Number(prefixed[1]);
    const doc = ordinal >= 1 && ordinal <= docs.length ? docs[ordinal - 1] : undefined;
    const out = doc ? readTableFromDoc(doc, prefixed[2]) : undefined;
    return out ?? unknownTableIdError(docs, raw);
  }

  // Bare id: unique across the attached docs → use that doc; in several docs →
  // one-line disambiguation with the followable prefixed candidates.
  const owners: { doc: AttachedDoc; ordinal: number }[] = [];
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].parse.toc.some(e => e.id === raw)) owners.push({ doc: docs[i], ordinal: i + 1 });
  }
  if (owners.length > 1) {
    const candidates = owners.map(({ doc, ordinal }) => `${ordinal}:${raw} (${doc.name})`).join(', ');
    return {
      ok: false,
      text: `Table id "${raw}" exists in several documents: ${candidates} — call again with the document prefix.`,
      stickyLines: [],
      lineCount: 0,
    };
  }
  if (owners.length === 1) {
    const out = readTableFromDoc(owners[0].doc, raw);
    if (out) return out;
  }
  return unknownTableIdError(docs, raw);
}

// ---------------------------------------------------------------------------
// PDF sticky page slot (view_doc, M4)
// ---------------------------------------------------------------------------

/**
 * The sticky slot state: exactly ONE page of one attached PDF, re-sent to the
 * Navigator as an image every step until view_doc replaces it (goto
 * semantics, no next/prev). `docOrdinal` is 1-based among ALL attached docs —
 * the same numbering the multi-doc table-id prefixes use — so the slot stays
 * resolvable without a second numbering scheme in the store.
 */
export interface PdfSticky {
  docOrdinal: number;
  page: number;
}

/** Attached docs that carry page images (PDFs), with their overall 1-based ordinals. */
export function listPdfDocs(docs: AttachedDoc[]): { doc: AttachedDoc; ordinal: number }[] {
  const out: { doc: AttachedDoc; ordinal: number }[] = [];
  for (let i = 0; i < docs.length; i++) {
    if ((docs[i].parse.pages?.length ?? 0) > 0) out.push({ doc: docs[i], ordinal: i + 1 });
  }
  return out;
}

export interface ViewDocOutcome {
  ok: boolean;
  /** New sticky slot value (null on error — the caller keeps the old slot). */
  sticky: PdfSticky | null;
  /** Result (or single-line error) to hand to the model. */
  text: string;
  docName?: string;
  page?: number;
  pageCount?: number;
}

/**
 * Validate a view_doc call against the doc store and produce the new sticky
 * slot. `docNum` is the 1-based ordinal among the attached PDFs (not among
 * all docs — view_doc is PDF-only), defaulting to 1; errors are single-line
 * on purpose (agent memory keeps only an error's last line) and carry the
 * valid ranges so a weak model can self-correct on the next call.
 */
export function resolveViewDoc(docs: AttachedDoc[], page: number, docNum?: number): ViewDocOutcome {
  const pdfs = listPdfDocs(docs);
  if (pdfs.length === 0) {
    return { ok: false, sticky: null, text: 'No PDF is attached — view_doc works on PDFs only.' };
  }
  const wanted = docNum ?? 1;
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > pdfs.length) {
    const list = pdfs.map((p, k) => `${k + 1}=${p.doc.name}`).join(', ');
    return { ok: false, sticky: null, text: `There is no PDF ${wanted}. Attached PDFs: ${list}.` };
  }
  const { doc, ordinal } = pdfs[wanted - 1];
  const pageCount = doc.parse.pages?.length ?? 0;
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    return {
      ok: false,
      sticky: null,
      text: `There is no page ${page}. ${doc.name} has pages 1..${pageCount}.`,
    };
  }
  return {
    ok: true,
    sticky: { docOrdinal: ordinal, page },
    text: `Pinned page ${page}/${pageCount} to the sticky slot${pdfs.length > 1 ? ` (${doc.name})` : ''} — it is sent as an image with every step.`,
    docName: doc.name,
    page,
    pageCount,
  };
}

/** The sticky page resolved for prompt injection. */
export interface StickyPageView {
  docName: string;
  page: number;
  pageCount: number;
  /** Rendered page image (data URL). */
  image: string;
}

/**
 * Resolve the sticky slot against the CURRENT doc store. Returns null when
 * the slot is empty or stale (docs replaced/reordered since it was set) — a
 * stale slot degrades to the empty-slot hint instead of showing a wrong page.
 */
export function getStickyPage(docs: AttachedDoc[], sticky: PdfSticky | null): StickyPageView | null {
  if (!sticky) return null;
  const doc = sticky.docOrdinal >= 1 && sticky.docOrdinal <= docs.length ? docs[sticky.docOrdinal - 1] : undefined;
  const pages = doc?.parse.pages;
  if (!doc || !pages || pages.length === 0) return null;
  const pageImage = pages.find(p => p.index === sticky.page);
  if (!pageImage) return null;
  return { docName: doc.name, page: sticky.page, pageCount: pages.length, image: pageImage.image };
}

/** One-line empty-slot hint; null when no PDF is attached (no slot to hint at). */
export function formatStickyEmptyHint(docs: AttachedDoc[]): string | null {
  const pdfs = listPdfDocs(docs);
  if (pdfs.length === 0) return null;
  if (pdfs.length === 1) {
    return `STICKY DOC: none (pages 1..${pdfs[0].doc.parse.pages?.length ?? 0}; show one with view_doc [N])`;
  }
  const ranges = pdfs.map((p, k) => `${k + 1}=${p.doc.name} 1..${p.doc.parse.pages?.length ?? 0}`).join(', ');
  return `STICKY DOC: none (${ranges}; show one with view_doc {"page": N, "doc": K})`;
}

/**
 * Compact TOC text: one line per table (id, location, title, fields, rows).
 * Mirror of pages/side-panel/src/lib/docParse.ts formatToc() — the two
 * workspaces don't share code (same convention as the Doc types in ../types).
 * `idPrefix` ('2:' for the 2nd of several docs) keeps every printed id
 * followable by read_table; single doc passes '' and stays unchanged.
 */
export function formatDocToc(parse: DocParseResult, idPrefix: string = ''): string {
  return parse.toc
    .map(e => {
      const loc = e.parentId ? ` (inside ${idPrefix}${e.parentId})` : '';
      const fields = e.fields.length > 0 ? ` | columns: ${e.fields.join(', ')}` : '';
      return `${idPrefix}${e.id}${loc} ${e.title}${fields} | ${e.rowCount} rows`;
    })
    .join('\n');
}

/**
 * The persistent doc-guide message injected once into the task history when
 * documents are attached: line-format syntax explanation (models misread the
 * table serialization without it), per-doc TOC, and usage guidance for
 * search_doc/read_table. The TOC part is document-derived, so the caller
 * passes the untrusted-content wrapper for it; the surrounding instructions
 * must stay OUTSIDE the untrusted block or the model is told to ignore them.
 */
export function formatDocGuide(docs: AttachedDoc[], wrapUntrusted: (s: string) => string = s => s): string {
  const multiDoc = docs.length > 1;
  const hasPdf = listPdfDocs(docs).length > 0;
  const hasOffice = docs.some(d => d.parse.kind !== 'pdf');
  // Outline only — no values live in the prompt. An office document (has
  // markdown) lists its top-level tables with their column headers; nested
  // mini tables are inlined into the parent's cells by read_table, so they
  // are not listed. A PDF is one line: its page count — it is read by eye.
  const tocSections = docs
    .map((doc, i) => {
      const prefix = multiDoc ? `${i + 1}:` : '';
      // An office file attached with its own render carries both: say so, or
      // the outline reads as text-only and view_doc is never tried on it.
      const pageCount = doc.parse.pages?.length ?? 0;
      const alsoPages =
        doc.parse.kind !== 'pdf' && pageCount > 0 ? `, ${pageCount} page images — view_doc shows one` : '';
      if (doc.parse.kind === 'pdf')
        return `## ${doc.name} (${doc.parse.pages?.length ?? 0} pages — read it with view_doc)`;
      if (doc.parse.markdown) {
        // Document head: the first lines of the body, untruncated enough to
        // carry the title and purpose ("EXPENSES CLAIM FORM — TRAVEL AND
        // SUBSISTENCE"). A cover page belongs in a table of contents; without
        // it the model lost what kind of document it was holding and could
        // not pick the form's template, which gated the whole task.
        const head = doc.parse.markdown
          .split('\n')
          .filter(l => l && !/^\[t\d+\]$/.test(l) && !/^\|(---\|)+$/.test(l))
          .join(' ')
          .replace(/\s*\|\s*/g, ' | ')
          .replace(/\s+/g, ' ')
          .slice(0, DOC_HEAD_MAX_CHARS);
        const outline = doc.parse.toc
          .filter(e => !e.parentId)
          .map(e => {
            const cols = outlineColumns(doc.parse, e.id);
            return `[${prefix}${e.id}] ${e.title}${cols.length ? ` — columns: ${cols.join(' | ')}` : ''} (${e.rowCount} rows)`;
          })
          .join('\n');
        return `## ${doc.name} (${doc.parse.stats.tables} tables${alsoPages})\nDocument head: ${head}…\n${outline}`;
      }
      return `## ${doc.name} (${doc.parse.stats.tables} tables${alsoPages})\n${formatDocToc(doc.parse, prefix)}`;
    })
    .join('\n\n');
  // ABLATION ONLY (DOC_GUIDE_MD_MAX_CHARS > 0): the whole markdown body
  // resident in the guide, i.e. no retrieval. Default 0 = lazy: the outline
  // above + read_table/search_doc fetch the markdown on demand.
  const mdDocs = docs.filter(d => d.parse.markdown);
  const mdTotal = mdDocs.reduce((n, d) => n + (d.parse.markdown?.length ?? 0), 0);
  const markdownBlock =
    mdDocs.length > 0 && mdTotal <= DOC_GUIDE_MD_MAX_CHARS
      ? `\nAttached document body (tables are markdown: one line = one row, values on the same line belong to the same record):\n${wrapUntrusted(
          mdDocs
            .map(d => `## ${multiDoc ? `${docs.indexOf(d) + 1}: ` : ''}${d.name}\n${d.parse.markdown}`)
            .join('\n\n'),
        )}\n`
      : '';
  const prefixSyntax = multiDoc
    ? '\n- Several documents are attached, so every table id carries its document number: "2:t5" = table t5 of the 2nd document. Pass read_table that exact form.'
    : '';
  const viewDocUsage = hasPdf
    ? '\n- PDF: the values live in the page images. Page 1 is already pinned in the sticky slot as an image; call view_doc with a page number (e.g. {"page": 3}) to move to another page. Read the values with your eyes and type them. PDFs are NOT searchable with search_doc/read_table. An attached document is not a browser tab, so never try to switch to it or scroll it.'
    : '';
  const officeTools = hasOffice
    ? `
- read_table(table id, e.g. "t4"): returns that whole table as a markdown table — the first line is the column names, then one line = one row, and the values on one line belong to the same record. Before filling a form section that takes several rows, read the table whole with read_table.
- search_doc(2-3 content words, e.g. "Account No"): finds lines containing a label or a value. Use it when you do not know which table holds something. Result line formats: "[tN rM] value1 | value2 | …" = row M of table N ("|" separates cells, "〃" = same value as the merged cell to its left, "⟨CxR merged⟩" = a merged cell); "[tN] rowLabel | columnHeader: value" = a summary line pairing a row label and column header with its value; "t3-1" = a table nested inside t3.
- doc_ref on input_text: give it a cell coordinate ("t4r2c3") and the system types that cell's original text verbatim, so a value can never be mistyped. The coordinate is the row/column order shown by read_table.${prefixSyntax}`
    : '';
  const headline = markdownBlock
    ? 'The attached document body is below. Read the values from it.'
    : hasOffice
      ? "The attached document's values are NOT in this prompt — call read_table with a table id from the outline below, read the table, then type the values. Never guess or invent a value."
      : "The attached PDF's values are in the page images — read a page with view_doc and type from it. Never guess or invent a value.";
  return `[ATTACHED DOCUMENT TOOLS]
${headline}
Tools:${officeTools}${viewDocUsage}
Document outline${hasOffice ? ' ([id] title — column names (row count))' : ''}:
${wrapUntrusted(tocSections)}
${markdownBlock}`;
}

/**
 * Sticky "found values" slot: append new lines, dedupe by exact text
 * (re-finding a line moves it to the most-recent end), keep the last `max`.
 * Returns a new array; never mutates the input.
 */
export function pushFoundLines(store: string[], lines: string[], max: number = FOUND_LINES_MAX): string[] {
  const merged = [...store];
  for (const line of lines) {
    const existing = merged.indexOf(line);
    if (existing >= 0) merged.splice(existing, 1);
    merged.push(line);
  }
  return merged.slice(-max);
}

// ---------------------------------------------------------------------------
// doc_ref resolution (M5): reference-based value transfer
// ---------------------------------------------------------------------------

/**
 * "t1r2c3" / multi-doc "2:t5r1c2" — a table-cell coordinate reference.
 * The Korean spellings (표/행/칸) are still accepted: they were the emitted
 * form before the serialization went English, and a model that has seen a
 * Korean document sometimes writes them anyway.
 */
const DOC_REF_RE = /^\s*(?:(\d+)\s*:\s*)?(?:표|t)\s*(\d+(?:-\d+)*)\s*(?:행|r)\s*(\d+)\s*(?:칸|열|c)\s*(\d+)\s*$/i;

const MERGE_MARK_RE = /\s*⟨[^⟩]*⟩\s*/g;
const DITTO_RE = /^〃(×\d+)?$/;
/**
 * "(→ t9-1)" is docParse's pointer to a table nested in this cell, not a value.
 * Typing the pointer text is worse than not resolving at all — a live run pasted
 * "(→ t9-1)" into a date input and then retried the same ref for three steps.
 * Stripping it leaves the cell's own text when there is any; a cell that is ONLY
 * a pointer is then read the way read_table shows it (nestedCellAsShown), and
 * null only when that shows no value, at which point builder.ts falls back to
 * the model's literal text.
 */
const NEST_POINTER_RE = /\s*\(→\s*t[\d-]+\)\s*/g;

export interface DocRefHit {
  value: string; // original cell text — merge/ditto marks resolved, ∣ restored
  where: string; // human-readable location, e.g. 't1 r2 c3'
}

/**
 * Fallback when a ref is NOT a table-cell coordinate: match it against the form
 * field index (the value→node list docParse already builds), so a value living
 * in a BODY paragraph — which has no tNrMcK coordinate — is still resolvable
 * by its label. The model routinely emits prose refs like "body Description of
 * Business"; the field label "Description of Business" is a substring, so we
 * return that field's exact original value (reference transfer preserved, no
 * retyping). Longest matching label wins to avoid short false positives.
 */
function resolveByLabel(docs: AttachedDoc[], ref: string): DocRefHit | null {
  const norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  const q = norm(ref);
  if (q.length < 3) return null;
  let best: { value: string; where: string; len: number } | null = null;
  for (const doc of docs) {
    for (const f of doc.parse.fields ?? []) {
      const nl = norm(f.label);
      if (nl.length < 3 || !f.value) continue;
      if (q.includes(nl) || nl.includes(q)) {
        if (!best || nl.length > best.len) {
          best = { value: f.value, where: `${f.section ? `${f.section} ` : ''}${f.label}`, len: nl.length };
        }
      }
    }
  }
  return best ? { value: best.value, where: best.where } : null;
}

/**
 * read_table shows a top-level table as markdown with each nested table inlined
 * into its cell ("Name of Insured: Lau Ho Yin"), so the model points at such a
 * cell by the coordinate it saw there. In the line dump that same cell is only
 * "(→ t6-1)", which resolves to nothing. Read the cell from the markdown
 * read_table shows instead, so what the model saw and what the ref returns are
 * the same text: a single label-over-value child gives its value, anything else
 * gives the cell as shown.
 */
function nestedCellAsShown(
  doc: AttachedDoc,
  tableId: string,
  row: number,
  col: number,
  dumpCell: string,
): string | null {
  const md = markdownTable(doc.parse, tableId);
  if (!md) return null;
  const rows = md
    .split('\n')
    .slice(1)
    .filter(l => l.startsWith('| ') && !/^\|(---\|)+$/.test(l));
  const line = rows[row - 1];
  if (!line) return null;
  const cells = line.slice(2, -2).split(/ (?<!\\)\| /);
  let shown = (cells[col - 1] ?? '').replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();
  if (!shown) return null;
  const children = [...dumpCell.matchAll(/\(→\s*(t[\d-]+)\)/g)].map(p => p[1]);
  if (children.length === 1) {
    const child = doc.parse.blocks.find(b => b.tableId === children[0]);
    const labelLine = child?.lines.find(l => /^\[[^\]]* r1\] /.test(l));
    const label = labelLine
      ?.replace(/^\[[^\]]*\]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (label && shown.startsWith(`${label}: `)) shown = shown.slice(label.length + 2).trim();
    // The child's value row is empty (a field the document leaves blank): the cell
    // shows only its label, and returning that would type the label into the form.
    else if (label && shown === label) return null;
  }
  return shown || null;
}

/**
 * Resolve a cell reference against the rendered table lines of the attached
 * docs. SmartResume-style reference transfer: the model POINTS at a cell
 * instead of retyping it, so transcription drift (fabricated values, comma
 * format errors, truncation) cannot occur on the pasted value. Validated on
 * the Python harness before porting: value-cell accuracy 11.3% → 14.5%,
 * fabrications 89 → 79 (same 5 documents, same model).
 */
export function resolveDocRef(docs: AttachedDoc[], ref: string): DocRefHit | null {
  const m = DOC_REF_RE.exec(ref ?? '');
  if (!m) return resolveByLabel(docs, ref); // body-paragraph value: resolve via the field index
  const docOrdinal = m[1] ? Number(m[1]) : null;
  const tableId = `t${m[2]}`;
  const row = Number(m[3]);
  const col = Number(m[4]);
  const candidates = docOrdinal === null ? docs : docs.slice(docOrdinal - 1, docOrdinal);
  for (const doc of candidates) {
    for (const block of doc.parse.blocks) {
      if (block.tableId !== tableId) continue;
      // Accepts the old Korean prefix too, so a doc parsed before the token
      // switch (a persisted session) still resolves.
      const rowRe = new RegExp('^\\[[^\\]]* (?:행|r)' + row + '\\] ');
      const line = block.lines.find(l => rowRe.test(l));
      if (!line) return null;
      const cells = line.replace(rowRe, '').split(' | ');
      if (col < 1 || col > cells.length) return null;
      const cellValue = (c: string) => c.replace(MERGE_MARK_RE, '').replace(NEST_POINTER_RE, ' ').trim();
      let value = cellValue(cells[col - 1]);
      // '〃' / '〃×N' = same as the nearest real cell to the left
      for (let i = col - 1; DITTO_RE.test(value) && i > 0; i--) {
        value = cellValue(cells[i - 1]);
      }
      value = value.replace(/∣/g, '|');
      // A cell that only points at nested tables: take it as read_table shows it.
      if (!value && /\(→\s*t[\d-]+\)/.test(cells[col - 1])) {
        const shown = nestedCellAsShown(doc, tableId, row, col, cells[col - 1]);
        if (shown) return { value: shown, where: `t${m[2]} r${row} c${col}` };
      }
      return value && !DITTO_RE.test(value) ? { value, where: `t${m[2]} r${row} c${col}` } : null;
    }
  }
  return null;
}
