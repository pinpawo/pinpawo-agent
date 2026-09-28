import { formatAccessibilityRef } from './accessibilityRef.js';
import type { JsonRecord } from './types.js';

/**
 * Page snapshot as an accessibility tree (issue #873, stage 3).
 *
 * Renders CDP `Accessibility.getFullAXTree` nodes as an indented outline in
 * the style of Playwright's aria snapshot: one `- role "name" [state] [ref=…]`
 * line per meaningful node and `- text: "…"` lines for page text. Roles, names
 * and states come from Chrome's own accessibility computation; this module
 * only prunes structure that carries no meaning for a reader and bounds the
 * result.
 */

export const MAX_RAW_TREE_BYTES = 1_000_000;
const MAX_NAME_LENGTH = 200;
const MAX_VALUE_LENGTH = 200;

/**
 * Roles an Agent acts on; only these carry refs. Compared lowercased: Chrome
 * reports some native controls with internal names (`DisclosureTriangle` for
 * a `<summary>`, `MenuListOption` for some `<option>`s).
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'disclosuretriangle',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'menulistoption',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/** Roles whose value is user input and may be sensitive. */
const VALUE_ROLES = new Set(['combobox', 'searchbox', 'slider', 'spinbutton', 'textbox']);

/**
 * Fields whose accessibility children are just their own value as text. The
 * value is rendered (or redacted) on the field's line, so descending would
 * repeat it — and leak a redacted one.
 */
const VALUE_LEAF_ROLES = new Set(['searchbox', 'slider', 'spinbutton', 'textbox']);

/** Layout-only roles: an unnamed one is dropped and its children lifted. */
const TRANSPARENT_ROLES = new Set([
  'generic',
  'GenericContainer',
  'none',
  'presentation',
  'Section',
  'LabelText',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  // Inline text formatting: its text reads as part of the surrounding run.
  'abbr',
  'deletion',
  'emphasis',
  'insertion',
  'mark',
  'strong',
  'subscript',
  'superscript',
  'time',
]);

/** Roles that carry nothing a reader needs. */
const SKIPPED_ROLES = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);

export type AccessibilityTreeOptions = Readonly<{
  /** Main-frame document load the nodes were read from; without it no refs are made. */
  loaderId: string | null;
  /**
   * Backend ids of inputs whose value must not leave the page (passwords,
   * card numbers, one-time codes). Null when they could not be determined:
   * then every field value is withheld.
   */
  sensitiveNodeIds: ReadonlySet<number> | null;
  /** Render only this element's subtree (its backend node id). */
  rootBackendNodeId?: number;
  /** Render nodes up to this many levels deep; deeper ones are left out. */
  maxDepth?: number;
  /** Render only interactive nodes, as a flat list without page text. */
  interactiveOnly?: boolean;
}>;

/** A scope target that has no node in the accessibility tree. */
export class AccessibilityScopeNotFoundError extends Error {
  constructor() {
    super('The snapshot target is not in the accessibility tree');
    this.name = 'AccessibilityScopeNotFoundError';
  }
}

export type AccessibilityTreeSnapshot = {
  title: string;
  url: string;
  tree: string;
  /** Length of the whole rendered tree, before the IPC bound. */
  treeLength: number;
  refCount: number;
  source: 'accessibility';
  /** Some nodes sat below `maxDepth` and were left out. */
  depthLimited: boolean;
};

type Entry =
  | { kind: 'node'; depth: number; line: string }
  | { kind: 'text'; depth: number; text: string };

function axValue(node: JsonRecord | undefined, key: string): unknown {
  const property = node?.[key];
  return property && typeof property === 'object' ? (property as JsonRecord).value : undefined;
}

function axString(node: JsonRecord | undefined, key: string): string {
  const value = axValue(node, key);
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function axProperty(node: JsonRecord, name: string): unknown {
  const properties = Array.isArray(node.properties) ? node.properties as JsonRecord[] : [];
  const property = properties.find((candidate) => candidate?.name === name);
  return axValue(property, 'value');
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function stateSuffix(node: JsonRecord, role: string): string {
  const states: string[] = [];
  const checked = axProperty(node, 'checked');
  if (checked === 'mixed') states.push('checked=mixed');
  else if (isTrue(checked)) states.push('checked');
  const pressed = axProperty(node, 'pressed');
  if (pressed === 'mixed') states.push('pressed=mixed');
  else if (isTrue(pressed)) states.push('pressed');
  const expanded = axProperty(node, 'expanded');
  if (expanded !== undefined) states.push(isTrue(expanded) ? 'expanded' : 'collapsed');
  if (isTrue(axProperty(node, 'selected'))) states.push('selected');
  if (isTrue(axProperty(node, 'disabled'))) states.push('disabled');
  if (isTrue(axProperty(node, 'required'))) states.push('required');
  if (isTrue(axProperty(node, 'focused'))) states.push('focused');
  // Chrome also reports list nesting as a level; only a heading's reads as one.
  const level = axProperty(node, 'level');
  if (role === 'heading' && typeof level === 'number' && Number.isInteger(level)) {
    states.push(`level=${level}`);
  }
  return states.map((state) => ` [${state}]`).join('');
}

function valueSuffix(node: JsonRecord, role: string, options: AccessibilityTreeOptions): string {
  if (!VALUE_ROLES.has(role)) return '';
  const raw = axValue(node, 'value');
  const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  const backendNodeId = node.backendDOMNodeId;
  const sensitive = options.sensitiveNodeIds === null
    || (typeof backendNodeId === 'number' && options.sensitiveNodeIds.has(backendNodeId));
  return sensitive ? ' [value=redacted]' : ` [value=${JSON.stringify(clip(value, MAX_VALUE_LENGTH))}]`;
}

function render(entries: Entry[]): string {
  const lines: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const indent = '  '.repeat(entry.depth);
    if (entry.kind === 'node') {
      lines.push(`${indent}${entry.line}`);
      continue;
    }
    // Adjacent text at one depth reads as one run (text split around inline
    // formatting, or across dropped layout containers).
    let text = entry.text;
    while (entries[index + 1]?.kind === 'text' && entries[index + 1].depth === entry.depth) {
      index += 1;
      text += ` ${(entries[index] as { text: string }).text}`;
    }
    lines.push(`${indent}- text: ${JSON.stringify(text)}`);
  }
  return lines.join('\n');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).length <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

export function buildAccessibilityTreeSnapshot(
  nodes: JsonRecord[],
  url: string,
  options: AccessibilityTreeOptions,
  maxBytes = MAX_RAW_TREE_BYTES,
): AccessibilityTreeSnapshot {
  const byId = new Map<string, JsonRecord>();
  for (const node of nodes) {
    if (node && (typeof node.nodeId === 'string' || typeof node.nodeId === 'number')) {
      byId.set(String(node.nodeId), node);
    }
  }
  const page = nodes.find((node) => axValue(node, 'role') === 'RootWebArea')
    ?? nodes.find((node) => node && !node.parentId);
  let root = page;
  if (options.rootBackendNodeId !== undefined) {
    root = nodes.find((node) => node?.backendDOMNodeId === options.rootBackendNodeId);
    if (!root) throw new AccessibilityScopeNotFoundError();
  }
  const { maxDepth, interactiveOnly = false } = options;
  const entries: Entry[] = [];
  let refCount = 0;
  let omittedByDepth = 0;
  const visited = new Set<JsonRecord>();
  const beyondDepth = (depth: number) => {
    if (maxDepth === undefined || depth < maxDepth) return false;
    omittedByDepth += 1;
    return true;
  };

  const childrenOf = (node: JsonRecord) => (Array.isArray(node.childIds) ? node.childIds : [])
    .map((id) => byId.get(String(id)))
    .filter((child): child is JsonRecord => Boolean(child));

  // `nameOfParent`: text already carried by the nearest named ancestor, whose
  // name Chrome computed from that same text (a link's label, a heading).
  // `dropText`: inside a combobox, whose text children repeat its value.
  const walk = (node: JsonRecord, depth: number, nameOfParent: string, dropText: boolean) => {
    if (visited.has(node)) return;
    visited.add(node);
    const walkChildren = (childDepth: number, parentName: string, childDropText: boolean) => {
      for (const child of childrenOf(node)) walk(child, childDepth, parentName, childDropText);
    };
    const role = String(axValue(node, 'role') ?? '');
    if (node.ignored === true) {
      walkChildren(depth, nameOfParent, dropText);
      return;
    }
    if (SKIPPED_ROLES.has(role)) return;
    const name = axString(node, 'name');
    if (role === 'StaticText') {
      if (name && !interactiveOnly && !dropText && !nameOfParent.includes(name) && !beyondDepth(depth)) {
        entries.push({ kind: 'text', depth, text: name });
      }
      return;
    }
    if (role === 'RootWebArea' || (TRANSPARENT_ROLES.has(role) && !name)) {
      walkChildren(depth, nameOfParent, dropText);
      return;
    }
    const refRole = role.toLowerCase();
    const interactive = INTERACTIVE_ROLES.has(refRole);
    // The interactive-only list is flat: structure is walked but not shown.
    if (interactiveOnly && !interactive) {
      walkChildren(depth, name, dropText);
      return;
    }
    if (beyondDepth(depth)) return;
    const ref = interactive
      ? formatAccessibilityRef(options.loaderId, node.backendDOMNodeId, refRole)
      : null;
    if (ref) refCount += 1;
    const line = `- ${role}${name ? ` ${JSON.stringify(clip(name, MAX_NAME_LENGTH))}` : ''}`
      + `${stateSuffix(node, role)}${valueSuffix(node, role, options)}${ref ? ` [ref=${ref}]` : ''}`;
    const index = entries.push({ kind: 'node', depth, line }) - 1;
    if (VALUE_LEAF_ROLES.has(role)) return;
    const omittedBefore = omittedByDepth;
    walkChildren(interactiveOnly ? depth : depth + 1, name, role === 'combobox');
    // An unnamed, non-interactive container whose children all pruned away
    // (a collapsed sublist, an empty group) says nothing — unless they were
    // only cut by the depth limit.
    if (!name && !ref && entries.length === index + 1 && omittedByDepth === omittedBefore) {
      entries.pop();
    }
  };

  if (root) walk(root, 0, '', false);
  const full = render(entries);
  return {
    title: axString(page, 'name'),
    url,
    tree: truncateUtf8(full, maxBytes),
    treeLength: full.length,
    refCount,
    source: 'accessibility',
    depthLimited: omittedByDepth > 0,
  };
}
