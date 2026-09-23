/**
 * Accessibility-tree observation (observationMode: 'axtree').
 *
 * The browser keeps an accessibility tree for every page; this reads it over
 * CDP (Accessibility.getFullAXTree) and turns it into the same DOMElementNode
 * tree the DOM observation produces, so every consumer downstream (selector
 * map, element hashing, the state message, actions) is untouched. Differences
 * from the injected buildDomTree walk:
 *  - a control's accessible NAME is its text ("Receipt Date" for the textbox
 *    the label belongs to) — the DOM walk only sees text nested inside the
 *    element, so a label next to a field was lost;
 *  - visible non-interactive text (labels, headings, cells) is emitted as
 *    context lines without an index, like the AXTree observation in
 *    BrowserGym/agentlab;
 *  - an element is located by its backendDOMNodeId (Realm.adoptBackendNode),
 *    not by a rebuilt css/xpath.
 * Limits: main frame only (same-origin iframes are not walked).
 */
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { JSHandle } from 'puppeteer-core/lib/esm/puppeteer/api/JSHandle.js';
import { DOMElementNode, DOMTextNode, type DOMState } from './views';
import { createLogger } from '@src/background/log';

const logger = createLogger('AXTree');

/** Subset of the CDP Accessibility.AXNode shape this module reads. */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** What the page probe reports for one candidate node. */
export interface AXProbe {
  visible: boolean;
  inViewport: boolean;
  /** For a dropdown: what it can be set to, and what it holds now. */
  options?: string[];
  selected?: string;
  /** The control's own id/name, stable across steps; radios also carry their group. */
  field?: string;
  group?: string;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'menubutton',
  'tab',
  'treeitem',
  'disclosuretriangle',
  'popupbutton',
  'togglebutton',
  'datetime',
  'colorwell',
]);

/** Visible text worth a context line (no index). */
const TEXT_ROLES = new Set([
  'statictext',
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'labeltext',
  'alert',
  'status',
  'caption',
  'legend',
]);

/** Roles that are containers only — never interesting by themselves. */
const CONTAINER_ROLES = new Set([
  'rootwebarea',
  'document',
  'generic',
  'none',
  'presentation',
  'main',
  'region',
  'group',
  'section',
]);

const ROLE_TAG: Record<string, string> = { statictext: 'text', labeltext: 'label', rootwebarea: 'root' };

/** Attribute names the AX rendering emits (passed as includeAttributes in axtree mode). */
export const AX_INCLUDE_ATTRIBUTES = [
  'field',
  'group',
  'options',
  'type',
  'value',
  'checked',
  'aria-expanded',
  'disabled',
  'required',
  'invalid',
  'pressed',
  'selected',
  'readonly',
  'haspopup',
  'level',
  'title',
];

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function roleOf(n: AXNode): string {
  return str(n.role?.value).toLowerCase();
}

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find(p => p.name === name)?.value?.value;
}

function isInteractive(n: AXNode): boolean {
  const role = roleOf(n);
  if (INTERACTIVE_ROLES.has(role)) return true;
  // focusable generic/other nodes (custom widgets) count too, containers don't
  return prop(n, 'focusable') === true && !CONTAINER_ROLES.has(role);
}

function attributesOf(n: AXNode): Record<string, string> {
  const out: Record<string, string> = {};
  const value = str(n.value?.value);
  if (value) out.value = value;
  const map: [string, string][] = [
    ['checked', 'checked'],
    ['expanded', 'aria-expanded'],
    ['disabled', 'disabled'],
    ['required', 'required'],
    ['invalid', 'invalid'],
    ['pressed', 'pressed'],
    ['selected', 'selected'],
    ['readonly', 'readonly'],
    ['hasPopup', 'haspopup'],
    ['level', 'level'],
  ];
  // A false state is informative for checked/pressed/selected (an unticked
  // box IS a fact); for the rest, false just means "normal" and is noise.
  const KEEP_FALSE = new Set(['checked', 'pressed', 'selected']);
  for (const [axName, attr] of map) {
    const v = prop(n, axName);
    if (v === undefined || v === null) continue;
    if ((v === false || v === 'false') && !KEEP_FALSE.has(axName)) continue;
    out[attr] = str(v);
  }
  const desc = str(n.description?.value).trim();
  if (desc) out.title = desc;
  return out;
}

/**
 * Pass 1 (pure): the nodes worth probing, in document order — every
 * interactive node plus every text node not inside an interactive one.
 */
export function collectAxCandidates(nodes: AXNode[]): AXNode[] {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const out: AXNode[] = [];
  const seen = new Set<string>();
  const walk = (n: AXNode | undefined, underInteractive: boolean): void => {
    if (!n || seen.has(n.nodeId)) return;
    seen.add(n.nodeId);
    const role = roleOf(n);
    const interactive = !n.ignored && isInteractive(n);
    const text = !n.ignored && !underInteractive && TEXT_ROLES.has(role) && str(n.name?.value).trim() !== '';
    if ((interactive || text) && n.backendDOMNodeId != null) out.push(n);
    for (const id of n.childIds ?? []) walk(byId.get(id), underInteractive || interactive);
  };
  walk(nodes[0], false);
  return out;
}

/** Put a dropdown's choices (and its current pick) where the model reads them. */
function withOptions(attrs: Record<string, string>, probe: AXProbe | undefined): Record<string, string> {
  if (probe?.options?.length) attrs.options = probe.options.join(' | ');
  if (probe?.selected && !attrs.value) attrs.value = probe.selected;
  if (probe?.field) attrs.field = probe.field;
  // Radios that share a name are one choice; without the group the model reads
  // them as unrelated boxes and ticks one from a branch it never selected.
  if (probe?.group) attrs.group = probe.group;
  return attrs;
}

/**
 * Pass 2 (pure): the DOMElementNode tree. Interactive nodes that are visible
 * and in the viewport get sequential highlight indexes; visible text nodes
 * become context lines; everything else is hoisted away. A text node whose
 * name repeats its parent's name (a label's own text) is dropped.
 */
export function buildAxDomTree(nodes: AXNode[], probes: Map<number, AXProbe>): DOMState {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const selectorMap = new Map<number, DOMElementNode>();
  let nextIndex = 0;
  const seen = new Set<string>();

  const build = (n: AXNode | undefined, parent: DOMElementNode, path: string, underInteractive: boolean): void => {
    if (!n || seen.has(n.nodeId)) return;
    seen.add(n.nodeId);
    const role = roleOf(n);
    const name = str(n.name?.value).replace(/\s+/g, ' ').trim();
    const probe = n.backendDOMNodeId != null ? probes.get(n.backendDOMNodeId) : undefined;
    const shown = !!probe && probe.visible && probe.inViewport;
    const interactive = !n.ignored && isInteractive(n) && shown;
    const text = !n.ignored && !underInteractive && !interactive && TEXT_ROLES.has(role) && name !== '' && shown;

    let holder = parent;
    if (interactive || text) {
      const tag = ROLE_TAG[role] ?? role;
      const xpath = `${path}/${tag}[${name}]`;
      const node = new DOMElementNode({
        tagName: tag,
        xpath,
        attributes: interactive ? withOptions(attributesOf(n), probe) : {},
        children: [],
        isVisible: true,
        isInteractive: interactive,
        isTopElement: true,
        isInViewport: true,
        highlightIndex: interactive ? nextIndex : null,
        parent,
      });
      node.backendNodeId = n.backendDOMNodeId;
      if (interactive) {
        selectorMap.set(nextIndex, node);
        nextIndex += 1;
        if (name) node.children.push(new DOMTextNode(name, true, node));
      } else {
        // a label's text repeats the label line — skip the duplicate
        if (parent.contextText === name) return;
        node.contextText = name;
      }
      parent.children.push(node);
      holder = node;
    }
    for (const id of n.childIds ?? [])
      build(byId.get(id), holder, holder === parent ? path : (holder.xpath ?? path), underInteractive || interactive);
  };

  const root = new DOMElementNode({
    tagName: 'root',
    xpath: '',
    attributes: {},
    children: [],
    isVisible: true,
    isTopElement: true,
    isInViewport: true,
  });
  build(nodes[0], root, '', false);
  return { elementTree: root, selectorMap };
}

/** Realm surface used for backend-node adoption (puppeteer internal but stable since v20). */
interface RealmLike {
  adoptBackendNode(backendNodeId: number): Promise<JSHandle<Node>>;
}

export function mainRealm(page: PuppeteerPage): RealmLike {
  return (page.mainFrame() as unknown as { mainRealm(): RealmLike }).mainRealm();
}

/**
 * In-page probe for one node: visibility, viewport intersection, and (when
 * asked) the highlight overlay drawn into the same container the DOM
 * observation uses, so removeHighlights() clears both alike.
 */
function probeAndHighlight(
  node: Node,
  index: number,
  showHighlight: boolean,
  expansion: number,
): { visible: boolean; inViewport: boolean; options?: string[]; selected?: string; field?: string; group?: string } {
  const rectOf = (): DOMRect | null => {
    if (node instanceof Element) {
      const rects = Array.from(node.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      return rects[0] ?? null;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const rect = rectOf();
  if (!rect) return { visible: false, inViewport: false };
  const el = node instanceof Element ? node : node.parentElement;
  const cssVisible = el
    ? ((el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility?.({
        checkOpacity: true,
        checkVisibilityCSS: true,
      }) ?? true)
    : true;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const inViewport = rect.bottom >= -expansion && rect.top <= vh + expansion && rect.right >= 0 && rect.left <= vw;
  if (cssVisible && inViewport && index >= 0 && showHighlight && node instanceof Element) {
    const CONTAINER_ID = 'playwright-highlight-container';
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      Object.assign(container.style, {
        position: 'fixed',
        pointerEvents: 'none',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        zIndex: '2147483647',
        backgroundColor: 'transparent',
      });
      document.body.appendChild(container);
    }
    const colors = [
      '#FF0000',
      '#00FF00',
      '#0000FF',
      '#FFA500',
      '#800080',
      '#008080',
      '#FF69B4',
      '#4B0082',
      '#FF4500',
      '#2E8B57',
      '#DC143C',
      '#4682B4',
    ];
    const color = colors[index % colors.length];
    for (const r of Array.from(node.getClientRects())) {
      if (r.width === 0 || r.height === 0) continue;
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed',
        border: `2px solid ${color}`,
        backgroundColor: `${color}1A`,
        pointerEvents: 'none',
        boxSizing: 'border-box',
        top: `${r.top}px`,
        left: `${r.left}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      container.appendChild(overlay);
    }
    const label = document.createElement('div');
    label.className = 'playwright-highlight-label';
    Object.assign(label.style, {
      position: 'fixed',
      background: color,
      color: 'white',
      padding: '1px 4px',
      borderRadius: '4px',
      fontSize: `${Math.min(12, Math.max(8, rect.height / 2))}px`,
      top: `${Math.max(0, rect.top - 2)}px`,
      left: `${Math.max(0, rect.right - 22)}px`,
    });
    label.textContent = String(index);
    container.appendChild(label);
  }
  // A closed dropdown hides its choices, so the model has to guess the exact
  // string — and "HKD" is not "HKD - Hong Kong Dollar". Hand it the list.
  let options: string[] | undefined;
  let selected: string | undefined;
  if (el) {
    const OPTION_CAP = 40;
    if (el instanceof HTMLSelectElement) {
      options = Array.from(el.options)
        .map(o => (o.text || o.value).trim())
        .filter(t => t !== '');
      selected = (el.selectedOptions[0]?.text || '').trim() || undefined;
    } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'listbox') {
      const owned = `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`
        .split(/\s+/)
        .map(id => id && document.getElementById(id))
        .filter((n): n is HTMLElement => !!n);
      const scope = owned.length > 0 ? owned : [el];
      const found = scope.flatMap(sc => Array.from(sc.querySelectorAll('option, [role="option"]')));
      options = found.map(o => (o.textContent ?? '').trim()).filter(t => t !== '');
    }
    if (options && options.length > OPTION_CAP)
      options = [...options.slice(0, OPTION_CAP), `…+${options.length - OPTION_CAP}`];
    if (options && options.length === 0) options = undefined;
  }
  // The page's own name for this control. A highlight index is a position and
  // moves the moment anything above it appears; "insured-name" does not, so the
  // model can address the same field across steps and the log stays readable.
  let field: string | undefined;
  let group: string | undefined;
  const control =
    el instanceof HTMLLabelElement ? ((el.control as HTMLElement | null) ?? el) : (el as HTMLElement | null);
  if (
    control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLTextAreaElement
  ) {
    field = control.id || control.name || undefined;
    if (control instanceof HTMLInputElement && control.type === 'radio') group = control.name || undefined;
  }
  return { visible: cssVisible, inViewport, options, selected, field, group };
}

/** Hard cap on nodes probed per state (one CDP round-trip each). */
export const AX_PROBE_CAP = 600;

/** Marker attribute used only between the sweep and the node lookup below. */
const STANDIN_ATTR = 'data-koni-standin';

/** Page-side sweep: labels whose control is present but not clickable. */
function markStandinLabels(attr: string): { role: string; name: string; checked: boolean }[] {
  const shown = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    return el.getClientRects().length > 0 && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.05;
  };
  const out: { role: string; name: string; checked: boolean }[] = [];
  for (const label of Array.from(document.querySelectorAll('label'))) {
    const control = (label as HTMLLabelElement).control as HTMLInputElement | null;
    if (!control || shown(control) || !shown(label)) continue;
    label.setAttribute(attr, '1');
    const type = control.type || control.tagName.toLowerCase();
    out.push({
      role: type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'button',
      name: (label.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      checked: !!control.checked,
    });
  }
  return out;
}

/**
 * A control styled by hiding the real input — `display:none` (or opacity 0)
 * plus a decorative span, the usual way a checkbox is made to look designed —
 * is not in the accessibility tree at all, so nothing at that spot carries an
 * index and the agent has no way to tick it. What a person clicks there is the
 * <label>, and the browser forwards that to the control.
 *
 * So splice one node per such label into the tree, standing in for the control
 * it drives. Found through HTMLLabelElement.control, which resolves both the
 * wrapping form and for=, so this is the pattern in general and not one site.
 */
async function addStandinLabels(
  page: PuppeteerPage,
  client: { send(m: string, p?: object): Promise<unknown> },
  nodes: AXNode[],
): Promise<void> {
  const found = await page.evaluate(markStandinLabels, STANDIN_ATTR);
  if (found.length === 0) return;
  try {
    const { root } = (await client.send('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } };
    const { nodeIds } = (await client.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: `[${STANDIN_ATTR}]`,
    })) as { nodeIds: number[] };
    const byId = new Map(nodes.map(n => [n.nodeId, n]));

    for (const [i, nodeId] of nodeIds.entries()) {
      const hit = found[i];
      if (!hit) continue;
      const { nodes: partial } = (await client.send('Accessibility.getPartialAXTree', {
        nodeId,
        fetchRelatives: true,
      })) as { nodes: (AXNode & { parentId?: string })[] };
      const self = partial[0]; // CDP returns the resolved node first, then its ancestors
      if (!self?.backendDOMNodeId) continue;

      const target = byId.get(self.nodeId) ?? self;
      target.role = { value: hit.role };
      target.name = { value: hit.name };
      target.ignored = false;
      target.backendDOMNodeId = self.backendDOMNodeId;
      if (hit.role !== 'button') target.properties = [{ name: 'checked', value: { value: hit.checked } }];

      if (!byId.has(self.nodeId)) {
        const parent = self.parentId ? byId.get(self.parentId) : undefined;
        if (!parent) continue; // nowhere to hang it; leave the tree untouched
        parent.childIds = [...(parent.childIds ?? []), self.nodeId];
        nodes.push(target);
        byId.set(self.nodeId, target);
      }
      logger.info('stand-in label for a hidden control', hit.role, hit.name.slice(0, 40));
    }
  } finally {
    await page.evaluate(
      (attr: string) => document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr)),
      STANDIN_ATTR,
    );
  }
}

/**
 * Fetch the accessibility tree of the main frame and build the observation.
 * Highlight indexes are assigned in document order among the interactive
 * nodes that are visible and inside the (expanded) viewport.
 */
export async function getAxTreeElements(
  page: PuppeteerPage,
  showHighlights: boolean,
  viewportExpansion: number,
): Promise<DOMState> {
  const client = (page.mainFrame() as unknown as { client: { send(m: string, p?: object): Promise<unknown> } }).client;
  await client.send('Accessibility.enable');
  const { nodes } = (await client.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] };
  await addStandinLabels(page, client, nodes);
  const candidates = collectAxCandidates(nodes).slice(0, AX_PROBE_CAP);
  const realm = mainRealm(page);

  const probes = new Map<number, AXProbe>();
  let index = 0;
  for (const n of candidates) {
    const id = n.backendDOMNodeId as number;
    let handle: JSHandle<Node> | null = null;
    try {
      handle = await realm.adoptBackendNode(id);
      const interactive = isInteractive(n);
      // the index is only consumed if the node turns out to be shown
      const probe = await handle.evaluate(
        probeAndHighlight,
        interactive ? index : -1,
        showHighlights,
        viewportExpansion,
      );
      probes.set(id, probe);
      if (interactive && probe.visible && probe.inViewport) index += 1;
    } catch (error) {
      logger.debug('probe failed', id, error);
    } finally {
      await handle?.dispose().catch(() => {});
    }
  }
  const state = buildAxDomTree(nodes, probes);
  logger.info(
    'axtree observation',
    `${nodes.length} nodes, ${candidates.length} probed, ${state.selectorMap.size} interactive`,
  );
  return state;
}
