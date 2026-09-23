import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveDocRef, markdownTable } from '../docSearch';
import type { AttachedDoc } from '../../types';

// ---------------------------------------------------------------------------
// doc_ref on a cell that holds nested tables. read_table shows such a cell
// inlined ("Name of Insured: Lau Ho Yin"), so the model points at it by the
// coordinate it saw; the lookup has to agree with what was shown, and a field
// the document leaves blank must not come back as its label.
// ---------------------------------------------------------------------------

function doc(parse: Record<string, unknown>): AttachedDoc {
  return { name: 'fixture.docx', parse } as unknown as AttachedDoc;
}

// Shape of insurance_03 t6/t7 and insurance_01 t12 as the side panel parses them,
// plus a plain table.
const FIXTURE = doc({
  kind: 'docx',
  toc: [],
  fields: [],
  markdown: [
    '[t1]\n| Field | Value |\n|---|---|\n| Account Name | Northwind Components Ltd. |',
    '[t6]\n| Name of Insured (Surname first): Lau Ho Yin | Date of Birth (DD/MM/YYYY): 27/07/1996 | Sex: ☒ M ☐ F | Occupation / Position: Site Engineer |\n|---|---|---|---|',
    '[t7]\n| I.D. Card / Passport Type (tick one): ☒ National ID ☐ Passport | I.D. Card / Passport No.: M3398120 | Contact No.: 5502 6647 |\n|---|---|---|',
    '[t12]\n| Diagnosis Hospital | Severity: ☒ Minor ☐ Major |\n|---|---|',
  ].join('\n\n'),
  blocks: [
    { id: 't1', tableId: 't1', lines: ['[t1 r1] Field | Value', '[t1 r2] Account Name | Northwind Components Ltd.'] },
    {
      id: 't6',
      tableId: 't6',
      lines: ['[t6 r1] (→ t6-1) | (→ t6-2) | (→ t6-3) | (→ t6-4)', '[t6] (→ t6-1): (→ t6-2)'],
    },
    { id: 't6-1', tableId: 't6-1', lines: ['[t6-1 r1] Name of Insured (Surname first)', '[t6-1 r2] Lau Ho Yin'] },
    { id: 't6-2', tableId: 't6-2', lines: ['[t6-2 r1] Date of Birth (DD/MM/YYYY)', '[t6-2 r2] 27/07/1996'] },
    { id: 't6-3', tableId: 't6-3', lines: ['[t6-3 r1] Sex', '[t6-3 r2] ☒ M ☐ F', '[t6-3 r2] checked: M'] },
    { id: 't6-4', tableId: 't6-4', lines: ['[t6-4 r1] Occupation / Position', '[t6-4 r2] Site Engineer'] },
    { id: 't7', tableId: 't7', lines: ['[t7 r1] (→ t7-1) | (→ t7-2) | (→ t7-3)'] },
    {
      id: 't7-1',
      tableId: 't7-1',
      lines: ['[t7-1 r1] I.D. Card / Passport Type (tick one)', '[t7-1 r2] ☒ National ID ☐ Passport'],
    },
    { id: 't7-2', tableId: 't7-2', lines: ['[t7-2 r1] I.D. Card / Passport No.', '[t7-2 r2] M3398120'] },
    { id: 't7-3', tableId: 't7-3', lines: ['[t7-3 r1] Contact No.', '[t7-3 r2] 5502 6647'] },
    { id: 't12', tableId: 't12', lines: ['[t12 r1] (→ t12-1) | (→ t12-2)'] },
    { id: 't12-1', tableId: 't12-1', lines: ['[t12-1 r1] Diagnosis Hospital', '[t12-1 r2] '] },
    { id: 't12-2', tableId: 't12-2', lines: ['[t12-2 r1] Severity', '[t12-2 r2] ☒ Minor ☐ Major'] },
  ],
});

describe('resolveDocRef — a cell that only holds a nested table', () => {
  it('returns the value read_table shows for that cell', () => {
    expect(resolveDocRef([FIXTURE], 't6r1c1')?.value).toBe('Lau Ho Yin');
    expect(resolveDocRef([FIXTURE], 't6r1c2')?.value).toBe('27/07/1996');
    expect(resolveDocRef([FIXTURE], 't6r1c4')?.value).toBe('Site Engineer');
    expect(resolveDocRef([FIXTURE], 't7r1c2')?.value).toBe('M3398120');
    expect(resolveDocRef([FIXTURE], 't7r1c3')?.value).toBe('5502 6647');
    expect(resolveDocRef([FIXTURE], 't12r1c2')?.value).toBe('☒ Minor ☐ Major');
  });

  it('gives no value for a field the document leaves blank (never its label)', () => {
    expect(resolveDocRef([FIXTURE], 't12r1c1')).toBeNull();
  });

  it('still resolves a nested table addressed by its own id', () => {
    expect(resolveDocRef([FIXTURE], 't6-1r2c1')?.value).toBe('Lau Ho Yin');
    expect(resolveDocRef([FIXTURE], 't7-2r2c1')?.value).toBe('M3398120');
  });

  it('leaves plain cells and out-of-range refs as they were', () => {
    expect(resolveDocRef([FIXTURE], 't1r2c2')?.value).toBe('Northwind Components Ltd.');
    expect(resolveDocRef([FIXTURE], 't1r2c1')?.value).toBe('Account Name');
    expect(resolveDocRef([FIXTURE], 't6r2c1')).toBeNull();
    expect(resolveDocRef([FIXTURE], 't6r1c9')).toBeNull();
    expect(resolveDocRef([FIXTURE], 't99r1c1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sweep over real parses (opt-in): every non-empty cell read_table shows, looked
// up by its coordinate. KONI_PARSE_DIR = folder of side-panel parse JSON files.
// ---------------------------------------------------------------------------

const PARSE_DIR = process.env.KONI_PARSE_DIR;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripPrefix = (l: string) => l.replace(/^\[[^\]]*\]\s*/, '');

describe.skipIf(!PARSE_DIR)('resolveDocRef sweep over real document parses', () => {
  it('every shown cell resolves to text in that cell; blank nested fields give nothing', () => {
    const files = fs.readdirSync(PARSE_DIR as string).filter(f => f.endsWith('.json'));
    const zero = () => ({
      shown: 0,
      ok: 0,
      notFound: 0,
      mismatch: 0,
      pointerCells: 0,
      pointerValue: 0,
      pointerBlankHeld: 0,
      pointerLabelLeak: 0,
    });
    const totals = zero();
    const examples: string[] = [];
    const rowsOut: string[] = [];
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(PARSE_DIR as string, f), 'utf-8'));
      const d = { name: raw.name, parse: raw.parse } as unknown as AttachedDoc;
      const blocks: { tableId?: string; lines: string[] }[] = raw.parse.blocks;
      const s = zero();
      const ids = [...(raw.parse.markdown as string).matchAll(/^\[(t\d+)\]$/gm)].map(m => m[1]);
      for (const id of ids) {
        const md = markdownTable(raw.parse, id) ?? '';
        const mdRows = md
          .split('\n')
          .slice(1)
          .filter(l => l.startsWith('| ') && !/^\|(---\|)+$/.test(l));
        const block = blocks.find(b => b.tableId === id);
        mdRows.forEach((line, ri) => {
          const cells = line.slice(2, -2).split(/ (?<!\\)\| /);
          const dumpLine = block?.lines.find(l => new RegExp(`^\\[[^\\]]* r${ri + 1}\\] `).test(l));
          const dumpCells = dumpLine ? stripPrefix(dumpLine).split(' | ') : [];
          cells.forEach((cell, ci) => {
            const shown = norm(cell.replace(/\\\|/g, '|'));
            if (!shown) return;
            s.shown += 1;
            const ref = `${id}r${ri + 1}c${ci + 1}`;
            const hit = resolveDocRef([d], ref);
            const dumpCell = dumpCells[ci] ?? '';
            const kids = [...dumpCell.matchAll(/\(→\s*(t[\d-]+)\)/g)].map(m => m[1]);
            const pointerOnly = kids.length > 0 && !norm(dumpCell.replace(/\(→\s*t[\d-]+\)/g, ' '));

            if (pointerOnly) {
              s.pointerCells += 1;
              const kid = kids.length === 1 ? blocks.find(b => b.tableId === kids[0]) : undefined;
              const r1 = kid?.lines.find(l => /^\[[^\]]* r1\] /.test(l));
              const label = r1 ? norm(stripPrefix(r1)) : '';
              if (label && shown === label) {
                // blank in the document: must resolve to nothing, never to the label
                if (!hit) s.pointerBlankHeld += 1;
                else {
                  s.pointerLabelLeak += 1;
                  examples.push(`label leak ${f} ${ref}  got="${hit.value}"`);
                }
                return;
              }
              if (hit && shown.includes(norm(hit.value))) s.pointerValue += 1;
            }

            if (!hit) {
              s.notFound += 1;
              if (examples.length < 12) examples.push(`not found  ${f} ${ref}  shown="${shown.slice(0, 60)}"`);
            } else if (shown.includes(norm(hit.value))) {
              s.ok += 1;
            } else {
              s.mismatch += 1;
              if (examples.length < 12)
                examples.push(`mismatch   ${f} ${ref}  got="${hit.value.slice(0, 40)}" shown="${shown.slice(0, 60)}"`);
            }
          });
        });
      }
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s[k];
      rowsOut.push(
        `${f.padEnd(26)} shown=${String(s.shown).padStart(4)} notFound=${String(s.notFound).padStart(3)} ` +
          `mismatch=${String(s.mismatch).padStart(3)} nested=${String(s.pointerCells).padStart(3)} ` +
          `(value ${s.pointerValue}, blank held ${s.pointerBlankHeld}, label leak ${s.pointerLabelLeak})`,
      );
    }
    console.log(['', ...rowsOut, `TOTAL ${JSON.stringify(totals)}`, ...examples].join('\n'));
    expect(totals.notFound).toBe(0);
    expect(totals.mismatch).toBe(0);
    expect(totals.pointerLabelLeak).toBe(0);
  });
});
