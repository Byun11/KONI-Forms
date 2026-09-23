// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMElementNode } from '../views';

// Load the shipped page-extractor and pull out the sentinel-wrapped KONI a11y
// helper block, so we test the EXACT code that runs in the page (not a copy).
// vitest runs with cwd = the chrome-extension package root.
const SCRIPT = readFileSync(resolve(process.cwd(), 'public/buildDomTree.js'), 'utf-8');

interface KoniHelpers {
  computeAccessibleName?: (el: Element) => string;
  isSensitive?: (el: Element) => boolean;
  computeRole?: (el: Element) => string;
  koniSelectedText?: (el: Element) => string;
}

function loadHelpers(): KoniHelpers {
  const start = SCRIPT.indexOf('// KONI_A11Y_HELPERS_START');
  const end = SCRIPT.indexOf('// KONI_A11Y_HELPERS_END');
  if (start === -1 || end === -1) throw new Error('KONI a11y helper sentinels not found in buildDomTree.js');
  const block = SCRIPT.slice(start, end);
  const ret =
    'return {' +
    'computeAccessibleName: typeof computeAccessibleName !== "undefined" ? computeAccessibleName : undefined,' +
    'isSensitive: typeof isSensitive !== "undefined" ? isSensitive : undefined,' +
    'computeRole: typeof computeRole !== "undefined" ? computeRole : undefined,' +
    'koniSelectedText: typeof koniSelectedText !== "undefined" ? koniSelectedText : undefined' +
    '};';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`${block}\n${ret}`)() as KoniHelpers;
}

const helpers = loadHelpers();

// Render HTML and return the first form control in it.
function control(html: string): Element {
  document.body.innerHTML = html;
  return document.querySelector('input, select, textarea') as Element;
}

describe('buildDomTree a11y — Item A: accessible name (<label for>, aria-labelledby, …)', () => {
  const accName = helpers.computeAccessibleName!;

  it('exposes the helper', () => {
    expect(typeof accName).toBe('function');
  });

  it('resolves a <label for> association (the key missing rule)', () => {
    const input = control('<label for="email">Email Address</label><input id="email" type="email" />');
    expect(accName(input)).toBe('Email Address');
  });

  it('resolves a wrapping <label>', () => {
    const input = control('<label>Full name <input id="fn" type="text" /></label>');
    expect(accName(input)).toBe('Full name');
  });

  it('resolves aria-labelledby by id reference', () => {
    document.body.innerHTML = '<span id="l">Phone Number</span><input id="p" type="tel" aria-labelledby="l" />';
    const input = document.getElementById('p') as Element;
    expect(accName(input)).toBe('Phone Number');
  });

  it('prefers an explicit aria-label over placeholder', () => {
    const input = control('<input aria-label="Search box" placeholder="search…" />');
    expect(accName(input)).toBe('Search box');
  });

  it('falls back to placeholder, then title', () => {
    expect(accName(control('<input placeholder="Enter city" />'))).toBe('Enter city');
    expect(accName(control('<input title="Zip code" />'))).toBe('Zip code');
  });

  it('collapses whitespace in label text', () => {
    const input = control('<label for="x">  First   name  </label><input id="x" />');
    expect(accName(input)).toBe('First name');
  });

  it('returns empty string when nothing is available', () => {
    expect(accName(control('<input type="text" name="anon" />'))).toBe('');
  });

  it('uses alt for image inputs', () => {
    expect(accName(control('<input type="image" alt="Search" src="x.png" />'))).toBe('Search');
  });

  it('uses the value of submit/button inputs as the label', () => {
    expect(accName(control('<input type="submit" value="제출" />'))).toBe('제출');
    expect(accName(control('<input type="button" value="Cancel" />'))).toBe('Cancel');
  });

  it('falls back to a short current value as a last resort', () => {
    expect(accName(control('<input type="text" value="hello world" />'))).toBe('hello world');
  });

  it('never leaks a secret value as the name', () => {
    expect(accName(control('<input type="password" value="hunter2" />'))).toBe('');
  });
});

describe('buildDomTree a11y — <select> current selection', () => {
  const selectedText = helpers.koniSelectedText!;

  it('reads the selected option text', () => {
    const sel = control(
      '<select><option value="us">USA</option><option value="kr" selected>대한민국</option></select>',
    );
    expect(selectedText(sel)).toBe('대한민국');
  });

  it('defaults to the first option when none is explicitly selected', () => {
    const sel = control('<select><option>One</option><option>Two</option></select>');
    expect(selectedText(sel)).toBe('One');
  });
});

describe('buildDomTree a11y — Item B: sensitive-field detection', () => {
  const isSensitive = helpers.isSensitive!;

  it('exposes the helper', () => {
    expect(typeof isSensitive).toBe('function');
  });

  it('flags password and hidden inputs', () => {
    expect(isSensitive(control('<input type="password" />'))).toBe(true);
    expect(isSensitive(control('<input type="hidden" value="csrf" />'))).toBe(true);
  });

  it('flags sensitive autocomplete tokens', () => {
    expect(isSensitive(control('<input autocomplete="current-password" />'))).toBe(true);
    expect(isSensitive(control('<input autocomplete="one-time-code" />'))).toBe(true);
    expect(isSensitive(control('<input autocomplete="cc-number" />'))).toBe(true);
    expect(isSensitive(control('<input autocomplete="shipping cc-exp" />'))).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(isSensitive(control('<input type="text" autocomplete="email" />'))).toBe(false);
    expect(isSensitive(control('<input type="email" name="email" />'))).toBe(false);
    expect(isSensitive(control('<input type="tel" />'))).toBe(false);
  });
});

describe('buildDomTree a11y — Item C: implicit ARIA role', () => {
  const computeRole = helpers.computeRole!;

  it('exposes the helper', () => {
    expect(typeof computeRole).toBe('function');
  });

  it('maps input types to roles', () => {
    expect(computeRole(control('<input type="text" />'))).toBe('textbox');
    expect(computeRole(control('<input type="email" />'))).toBe('textbox');
    expect(computeRole(control('<input />'))).toBe('textbox'); // default type
    expect(computeRole(control('<input type="checkbox" />'))).toBe('checkbox');
    expect(computeRole(control('<input type="radio" />'))).toBe('radio');
    expect(computeRole(control('<input type="number" />'))).toBe('spinbutton');
    expect(computeRole(control('<input type="search" />'))).toBe('searchbox');
    expect(computeRole(control('<input type="submit" />'))).toBe('button');
  });

  it('maps select and textarea', () => {
    expect(computeRole(control('<select><option>x</option></select>'))).toBe('combobox');
    expect(computeRole(control('<textarea></textarea>'))).toBe('textbox');
  });

  it('honors an explicit author role', () => {
    document.body.innerHTML = '<div role="switch" id="d"></div>';
    expect(computeRole(document.getElementById('d') as Element)).toBe('switch');
  });
});

describe('buildDomTree a11y — Item F: name-bearing attribute length cap (views.ts)', () => {
  function makeInput(attributes: Record<string, string>): DOMElementNode {
    return new DOMElementNode({
      tagName: 'input',
      xpath: '',
      attributes,
      children: [],
      isVisible: true,
      isInteractive: true,
      isTopElement: true,
      isInViewport: true,
      highlightIndex: 0,
    });
  }

  it('keeps a long aria-label (≤50 chars) instead of truncating at 15', () => {
    const node = makeInput({ 'aria-label': 'Date of birth (MM/DD/YYYY)', type: 'text' });
    expect(node.clickableElementsToString()).toContain('Date of birth (MM/DD/YYYY)');
  });

  it('still caps non-name attributes at 15 chars', () => {
    const longName = 'this_is_a_very_long_field_name_value';
    const out = makeInput({ name: longName, type: 'text' }).clickableElementsToString();
    expect(out).not.toContain(longName);
  });
});
