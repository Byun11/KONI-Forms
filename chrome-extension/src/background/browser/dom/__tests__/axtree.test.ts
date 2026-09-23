import { describe, it, expect } from 'vitest';
import { buildAxDomTree, collectAxCandidates, type AXNode, type AXProbe, AX_INCLUDE_ATTRIBUTES } from '../axtree';

// A small expense-style form as the CDP Accessibility.getFullAXTree would
// report it: a heading, a labelled textbox, a combobox with a value, a
// checkbox, a button, an offscreen button and an ignored wrapper.
const NODES: AXNode[] = [
  {
    nodeId: '1',
    role: { value: 'RootWebArea' },
    name: { value: 'ExpenseFlow' },
    childIds: ['2', '3', '6', '9', '11', '13'],
    backendDOMNodeId: 1,
  },
  {
    nodeId: '2',
    role: { value: 'heading' },
    name: { value: 'Step 2 Cash and Other Expenses' },
    properties: [{ name: 'level', value: { value: 2 } }],
    backendDOMNodeId: 2,
  },
  { nodeId: '3', role: { value: 'LabelText' }, name: { value: 'Receipt Date' }, childIds: ['4'], backendDOMNodeId: 3 },
  { nodeId: '4', role: { value: 'StaticText' }, name: { value: 'Receipt Date' }, backendDOMNodeId: 4 },
  {
    nodeId: '6',
    role: { value: 'textbox' },
    name: { value: 'Receipt Date' },
    value: { value: '' },
    properties: [
      { name: 'focusable', value: { value: true } },
      { name: 'required', value: { value: true } },
    ],
    backendDOMNodeId: 6,
  },
  {
    nodeId: '9',
    role: { value: 'combobox' },
    name: { value: 'Expense Type' },
    value: { value: 'Air Ticket' },
    properties: [
      { name: 'expanded', value: { value: false } },
      { name: 'hasPopup', value: { value: 'listbox' } },
    ],
    backendDOMNodeId: 9,
  },
  {
    nodeId: '11',
    role: { value: 'checkbox' },
    name: { value: 'Original receipt missing' },
    properties: [{ name: 'checked', value: { value: 'false' } }],
    backendDOMNodeId: 11,
  },
  { nodeId: '13', role: { value: 'generic' }, ignored: true, childIds: ['14', '15'], backendDOMNodeId: 13 },
  { nodeId: '14', role: { value: 'button' }, name: { value: 'Save' }, childIds: ['16'], backendDOMNodeId: 14 },
  { nodeId: '16', role: { value: 'StaticText' }, name: { value: 'Save' }, backendDOMNodeId: 16 },
  { nodeId: '15', role: { value: 'button' }, name: { value: 'Far below' }, backendDOMNodeId: 15 },
];

const shown: AXProbe = { visible: true, inViewport: true };
const PROBES = new Map<number, AXProbe>([
  [2, shown],
  [3, shown],
  [4, shown],
  [6, shown],
  [9, shown],
  [11, shown],
  [14, shown],
  [15, { visible: true, inViewport: false }],
]);

describe('axtree observation', () => {
  it('collects interactive nodes and standalone text, not text inside a control', () => {
    const ids = collectAxCandidates(NODES).map(n => n.nodeId);
    expect(ids).toEqual(['2', '3', '4', '6', '9', '11', '14', '15']);
    expect(ids).not.toContain('16'); // "Save" text lives inside the button
  });

  it('indexes visible in-viewport controls in document order and skips offscreen ones', () => {
    const { selectorMap } = buildAxDomTree(NODES, PROBES);
    expect([...selectorMap.keys()]).toEqual([0, 1, 2, 3]);
    expect(selectorMap.get(0)?.tagName).toBe('textbox');
    expect(selectorMap.get(3)?.tagName).toBe('button');
    expect([...selectorMap.values()].map(n => n.backendNodeId)).toEqual([6, 9, 11, 14]);
  });

  it('renders the accessible name as the element text and labels as context lines', () => {
    const { elementTree } = buildAxDomTree(NODES, PROBES);
    const text = elementTree.clickableElementsToString(AX_INCLUDE_ATTRIBUTES);
    expect(text).toContain('<heading>Step 2 Cash and Other Expenses');
    expect(text).toContain('<label>Receipt Date');
    expect(text).toContain('[0]<textbox required=true>Receipt Date />');
    expect(text).toContain('[1]<combobox value=Air Ticket haspopup=listbox>Expense Type />');
    expect(text).toContain('[2]<checkbox checked=false>Original receipt missing />');
    expect(text).toContain('[3]<button >Save />');
    expect(text).not.toContain('Far below');
    // the label's own StaticText child repeats the label — emitted once
    expect(text.split('Receipt Date').length - 1).toBe(2);
  });
});
