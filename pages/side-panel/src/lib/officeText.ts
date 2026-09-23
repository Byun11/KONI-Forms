/**
 * Zero-dependency text extraction for Office Open XML (.docx) and Hancom HWPX
 * (.hwpx) documents. Both formats are ZIP packages of XML, so we unzip in-browser
 * with the native `DecompressionStream` (Chrome/Edge only — which is all this
 * extension targets) and pull the text runs out of the body XML with a small
 * regex. No npm dependency, no WASM, no server: the whole thing runs client-side
 * in the side panel where the user picks the file.
 *
 * - .docx  → text lives in `word/document.xml` inside `<w:t>` tags, paragraphs `<w:p>`.
 * - .hwpx  → text lives in `Contents/sectionN.xml` inside `<hp:t>` tags, paragraphs `<hp:p>`.
 *
 * The ZIP reader and body-XML access live in `docParse.ts` (shared with the
 * structured table parser); this module keeps the flat plain-text extraction.
 */
import { decodeXmlEntities, readDocxBodyXml, readHwpxSectionsXml } from './docParse';

// The extracted text is capped so we never shove a novel into the prompt.
const MAX_TEXT_CHARS = 500_000;

interface BodyTags {
  text: string; // text-run tag, e.g. 'w:t' / 'hp:t'
  para: string; // paragraph tag, e.g. 'w:p' / 'hp:p'
  tab?: string; // inline tab tag, e.g. 'w:tab' / 'hp:tab'
  br?: string; // inline line-break tag, e.g. 'w:br' / 'hp:lineBreak'
}

/**
 * Pull visible text out of a word-processing XML body. We scan each paragraph in
 * document order for text runs (`<w:t>…</w:t>`) and inline tab/break tags, so a
 * `<w:tab/>` between two runs becomes a real tab instead of silently gluing the
 * neighbouring text together — which matters when the text is later grepped for
 * field values. Tags carry their namespace prefix (docx: w:*, hwpx: hp:*).
 */
function xmlBodyToText(xml: string, tags: BodyTags): string {
  // Alternation, matched in order: a text run (captured), OR a self-closing tab,
  // OR a self-closing break. `(?:\s[^>]*)?` on the text tag both allows attributes
  // (xml:space="preserve") and prevents matching siblings like `<w:tab/>`.
  const alts = [`<${tags.text}(?:\\s[^>]*)?>([\\s\\S]*?)</${tags.text}>`];
  if (tags.tab) alts.push(`<${tags.tab}\\b[^>]*/?>`);
  if (tags.br) alts.push(`<${tags.br}\\b[^>]*/?>`);
  const tokenRe = new RegExp(alts.join('|'), 'g');

  const paragraphs = xml.split(new RegExp(`</${tags.para}>`));
  const lines = paragraphs.map(part => {
    let line = '';
    for (const m of part.matchAll(tokenRe)) {
      if (m[1] !== undefined) line += decodeXmlEntities(m[1]);
      else if (tags.tab && m[0].startsWith(`<${tags.tab}`)) line += '\t';
      else line += '\n';
    }
    return line;
  });
  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + '\n\n…[truncated]';
}

/** Extract plain text from a .docx (Office Open XML) ArrayBuffer. */
export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const body = await readDocxBodyXml(buffer);
  return capText(xmlBodyToText(body, { text: 'w:t', para: 'w:p', tab: 'w:tab', br: 'w:br' }));
}

/** Extract plain text from a .hwpx (Hancom OWPML) ArrayBuffer, in section order. */
export async function extractHwpxText(buffer: ArrayBuffer): Promise<string> {
  const sections = await readHwpxSectionsXml(buffer);
  const text = sections
    .map(xml => xmlBodyToText(xml, { text: 'hp:t', para: 'hp:p', tab: 'hp:tab', br: 'hp:lineBreak' }))
    .join('\n\n');
  return capText(text);
}

const EXTRACTORS: Record<string, (buffer: ArrayBuffer) => Promise<string>> = {
  '.docx': extractDocxText,
  '.hwpx': extractHwpxText,
};

/** Extensions handled by {@link extractOfficeText}. */
export const OFFICE_EXTENSIONS = Object.keys(EXTRACTORS);

/** True when the file extension is a supported ZIP+XML office document. */
export function isOfficeDocument(ext: string): boolean {
  return ext in EXTRACTORS;
}

/** Extract plain text from a supported office document File, dispatched by extension. */
export async function extractOfficeText(file: File, ext: string): Promise<string> {
  const extractor = EXTRACTORS[ext];
  if (!extractor) throw new Error(`Unsupported office document type: ${ext}`);
  const buffer = await file.arrayBuffer();
  return extractor(buffer);
}
