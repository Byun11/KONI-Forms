/**
 * Stress-test the form-field extractor (splitFields + retightenFields) against
 * a battery of edge cases, then run the full parseDocx over every campaign doc.
 *
 *   node --experimental-strip-types pages/side-panel/tests/stress_parse.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitFields, retightenFields, parseDocx } from '../src/lib/docParse.ts';

function extract(line: string): string[] {
  return retightenFields(splitFields(line)).map(f => `${f.label} = ${f.value}`);
}

// [input line, expected label=value pairs]
const CASES: [string, string[]][] = [
  ['Telephone: (555) 412-8890 Fax: (555) 412-8891', ['Telephone = (555) 412-8890', 'Fax = (555) 412-8891']],
  [
    'Industry Type: Electronics Manufacturing # of Employees: 180',
    ['Industry Type = Electronics Manufacturing', '# of Employees = 180'],
  ],
  ['Gross Annual Revenue $: 24,000,000', ['Gross Annual Revenue $ = 24,000,000']],
  ['City: Raleigh State: NC Zip: 27606 Country: USA', ['City = Raleigh', 'State = NC', 'Zip = 27606', 'Country = USA']],
  ['Legal Name: Acme Components Ltd.', ['Legal Name = Acme Components Ltd.']],
  ['Amount Due: $1,850.00', ['Amount Due = $1,850.00']],
  ['Company Website: www.example.com', ['Company Website = www.example.com']],
  ['Name: ____________', []], // blank underscore fill dropped
  ['This is plain prose with no fields at all.', []],
  ['Total number of employees . . . . . . 42', []], // dot-leader, no colon
  // --- edge cases that probably break ---
  ['Website: https://example.com/a', ['Website = https://example.com/a']], // URL has ://
  ['Incident Time: 08:35', ['Incident Time = 08:35']], // time value keeps colon
  ['The meeting at 08:35 ran long', []], // BARE time in prose — should NOT split
  ['이름: 홍길동   전화번호: 010-1234-5678', ['이름 = 홍길동', '전화번호 = 010-1234-5678']], // Korean labels
  ['Ratio 3:1 applies', []], // bare ratio in prose
  ['Policy No.: HK-4471902  Plan: Gold', ['Policy No. = HK-4471902', 'Plan = Gold']],
];

let pass = 0;
console.log('=== SYNTHETIC EDGE CASES ===');
for (const [line, want] of CASES) {
  const got = extract(line);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${line.slice(0, 55)}"`);
  if (!ok) {
    console.log('      want:', JSON.stringify(want));
    console.log('      got :', JSON.stringify(got));
  }
}
console.log(`\n${pass}/${CASES.length} edge cases pass\n`);

console.log('=== REAL DOCS (field index size + a spot sample) ===');
const DOCS = [
  'crm/crm_01',
  'crm/crm_02',
  'crm/crm_03',
  'insurance/insurance_01',
  'insurance/insurance_02',
  'insurance/insurance_03',
  'expense/expense_01',
  'expense/expense_02',
  'expense/expense_03',
];
for (const rel of DOCS) {
  const path = fileURLToPath(new URL(`../../../experiments/docs/${rel}.docx`, import.meta.url));
  const nb = readFileSync(path);
  const parse = await parseDocx(nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength));
  const fs = parse.fields ?? [];
  const sample = fs
    .slice(0, 3)
    .map(f => `${f.label}=${f.value}`.slice(0, 40))
    .join(' | ');
  console.log(
    `  ${rel.padEnd(24)} tables=${String(parse.stats.tables).padStart(2)}  fields=${String(fs.length).padStart(3)}  e.g. ${sample}`,
  );
}
