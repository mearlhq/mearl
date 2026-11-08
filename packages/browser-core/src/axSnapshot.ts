/**
 * Shared accessibility-tree snapshot constants and utilities.
 *
 * Used by both extension (agentHandlers/snapshotHandlers.ts) and
 * native-host (cdp-backend) to ensure consistent AX tree pruning.
 */

import type { PageSnapshotQuery } from './browserActionProtocol.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AXNodeBase {
  nodeId: string;
  ignored: boolean;
  role?: { type?: string; value: string };
  name?: { type?: string; value: string };
  description?: { type?: string; value: string };
  value?: { type?: string; value: any };
  properties?: Array<{ name: string; value: { type?: string; value: any } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface SnapshotNodeBase {
  role: string;
  name: string;
  /** Internal CDP identity used for snapshot filtering; never rendered. */
  backendDOMNodeId?: number;
  ref?: string;
  value?: string;
  description?: string;
  focused?: boolean;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  required?: boolean;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
  children?: SnapshotNodeBase[];
}

export type PageSnapshotMode = 'full' | 'interactive' | 'viewport' | 'dom';
export type AXPageSnapshotMode = Exclude<PageSnapshotMode, 'dom'>;

export interface PageSnapshotQueryMatch {
  ref?: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
}

export interface FilteredSnapshotQuery {
  tree: SnapshotNodeBase | null;
  matches: PageSnapshotQueryMatch[];
}

export interface LimitedSnapshotQueryMatches {
  matches: PageSnapshotQueryMatch[];
  truncated: boolean;
}

const PAGE_SNAPSHOT_QUERY_MAX_MATCHES = 100;
const PAGE_SNAPSHOT_QUERY_MAX_BYTES = 256 * 1024;
const PAGE_SNAPSHOT_QUERY_MAX_FIELD_CHARS = 2_048;

export interface SnapshotTextLimits {
  maxChars?: number;
  maxNodes?: number;
}

export interface PageViewportBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DOMSnapshotViewportMetrics {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
}

export interface DOMSnapshotLayoutMetrics {
  visualViewport?: DOMSnapshotViewportMetrics;
  cssVisualViewport?: DOMSnapshotViewportMetrics;
}

export interface FormattedSnapshot {
  snapshot: string;
  truncated: boolean;
  outputNodeCount: number;
}

// ─── Shared role sets ─────────────────────────────────────────────────────────

/** Roles that are purely structural / decorative — skip and promote children */
export const SKIP_ROLES = new Set([
  'none',
  'generic',
  'InlineTextBox',
  'LineBreak',
  'paragraph',
  'Section',
  'LabelText',
]);

/** Roles that always get skipped (even with name) — their text is redundant */
export const ALWAYS_SKIP_ROLES = new Set([
  'InlineTextBox',
  'LineBreak',
  'graphics-symbol',
  'graphics-document',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/** Whether a snapshot node exposes enough AX state to be treated as interactive. */
export function isInteractiveSnapshotNode(node: SnapshotNodeBase): boolean {
  const focusedControl =
    Boolean(node.focused) && node.role !== 'RootWebArea' && node.role !== 'WebArea';
  return (
    INTERACTIVE_ROLES.has(node.role) ||
    focusedControl ||
    node.checked !== undefined ||
    node.expanded !== undefined ||
    Boolean(node.selected)
  );
}

/** Whether a snapshot branch contains at least one semantic interactive node. */
export function hasInteractiveSnapshotNode(node: SnapshotNodeBase | null): boolean {
  if (!node) return false;
  if (isInteractiveSnapshotNode(node)) return true;
  return (node.children ?? []).some(hasInteractiveSnapshotNode);
}

// ─── Property extraction ──────────────────────────────────────────────────────

export interface ExtractedProperties {
  focused?: boolean;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  required?: boolean;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
}

export type AXCheckedState = boolean | 'mixed';

const CHECKABLE_AX_ROLES = new Set([
  'checkbox',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'switch',
]);

/**
 * DOMSnapshot layout bounds use the same coordinate space as the legacy visual
 * viewport. The CSS viewport is only a fallback because page zoom can make it
 * smaller than the captured bounds.
 */
export function resolveDOMSnapshotViewportBounds(
  metrics: DOMSnapshotLayoutMetrics,
): PageViewportBounds | null {
  const viewport = metrics.visualViewport ?? metrics.cssVisualViewport;
  return normalizePageViewportBounds({
    left: viewport?.pageX ?? 0,
    top: viewport?.pageY ?? 0,
    width: viewport?.clientWidth,
    height: viewport?.clientHeight,
  });
}

export function normalizePageViewportBounds(value: unknown): PageViewportBounds | null {
  if (!value || typeof value !== 'object') return null;
  const { left, top, width, height } = value as Partial<PageViewportBounds>;
  if (
    typeof left !== 'number' ||
    typeof top !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { left, top, width, height };
}

/**
 * Read the current checked state from a DOM node resolved from an AX node.
 *
 * This function is serialized and executed in the page, so it must not depend
 * on module-scoped values.
 */
export function readDOMCheckedState(this: any): AXCheckedState | undefined {
  const tag = String((this && this.tagName) || '').toLowerCase();
  const type = String((this && this.type) || '').toLowerCase();
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    return Boolean(this.checked);
  }
  const ariaChecked = this && this.getAttribute && this.getAttribute('aria-checked');
  if (ariaChecked === 'mixed') return 'mixed';
  if (ariaChecked === 'true') return true;
  if (ariaChecked === 'false') return false;
  return undefined;
}

/**
 * Reconcile checkable AX nodes with their live DOM state.
 *
 * Chromium's accessibility cache can lag behind the DOM property after a
 * framework-controlled checkbox changes. Snapshot consumers need the current
 * state so they do not retry an action that already succeeded.
 */
export async function reconcileAXCheckedStates(
  nodes: AXNodeBase[],
  readCheckedState: (backendDOMNodeId: number) => Promise<AXCheckedState | undefined>,
): Promise<void> {
  const candidates = nodes.filter(
    node => node.backendDOMNodeId !== undefined && CHECKABLE_AX_ROLES.has(node.role?.value ?? ''),
  );
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(8, candidates.length) },
    async (): Promise<void> => {
      while (nextIndex < candidates.length) {
        const node = candidates[nextIndex++];
        if (!node || node.backendDOMNodeId === undefined) continue;
        try {
          const checked = await readCheckedState(node.backendDOMNodeId);
          if (checked === undefined) continue;
          const properties = (node.properties ??= []);
          const existing = properties.find(property => property.name === 'checked');
          if (existing) existing.value.value = checked;
          else properties.push({ name: 'checked', value: { value: checked } });
        } catch {
          // DOM state enrichment is best-effort; the AX value remains usable when a node detaches.
        }
      }
    },
  );
  await Promise.all(workers);
}

/** Extract boolean / enumerated AX properties from an AXNode. */
export function extractAXProperties(node: AXNodeBase): ExtractedProperties {
  const result: ExtractedProperties = {};
  if (!node.properties) return result;

  for (const prop of node.properties) {
    switch (prop.name) {
      case 'focused':
        if (prop.value.value === true) result.focused = true;
        break;
      case 'checked':
        result.checked = prop.value.value === 'mixed' ? 'mixed' : prop.value.value === true;
        break;
      case 'disabled':
        if (prop.value.value === true) result.disabled = true;
        break;
      case 'required':
        if (prop.value.value === true) result.required = true;
        break;
      case 'expanded':
        result.expanded = prop.value.value === true;
        break;
      case 'selected':
        if (prop.value.value === true) result.selected = true;
        break;
      case 'level':
        result.level = prop.value.value;
        break;
    }
  }

  return result;
}

// ─── Text formatting ──────────────────────────────────────────────────────────

/** Format a SnapshotNode tree into indented text lines. */
export function formatSnapshotNode(node: SnapshotNodeBase, indent: number, lines: string[]): void {
  if (
    node.role === 'group' &&
    !node.ref &&
    !node.name &&
    node.value === undefined &&
    !node.description &&
    !node.focused &&
    node.checked === undefined &&
    !node.disabled &&
    !node.required &&
    node.expanded === undefined &&
    !node.selected &&
    node.level === undefined
  ) {
    for (const child of node.children ?? []) formatSnapshotNode(child, indent, lines);
    return;
  }
  const prefix = '  '.repeat(indent);

  let line = prefix;
  if (node.ref) {
    line += `${node.ref} `;
  }
  line += `[${node.role}`;
  if (node.name) {
    line += ` "${node.name}"`;
  }
  line += ']';

  const annotations: string[] = [];
  if (node.value !== undefined) annotations.push(`value="${node.value}"`);
  if (node.focused) annotations.push('focused');
  if (node.checked === true) annotations.push('checked');
  if (node.checked === 'mixed') annotations.push('mixed');
  if (node.disabled) annotations.push('disabled');
  if (node.required) annotations.push('required');
  if (node.expanded === true) annotations.push('expanded');
  if (node.expanded === false) annotations.push('collapsed');
  if (node.selected) annotations.push('selected');
  if (node.level !== undefined) annotations.push(`level=${node.level}`);
  if (node.description) annotations.push(`desc="${node.description}"`);

  if (annotations.length > 0) {
    line += ` (${annotations.join(', ')})`;
  }

  lines.push(line);

  if (node.children) {
    for (const child of node.children) {
      formatSnapshotNode(child, indent + 1, lines);
    }
  }
}

/** Keep only the useful branch of a snapshot for a requested output mode. */
export function filterSnapshotTree(
  node: SnapshotNodeBase | null,
  mode: AXPageSnapshotMode,
  visibleBackendNodeIds?: ReadonlySet<number>,
): SnapshotNodeBase | null {
  if (!node) return null;
  if (mode === 'full') return node;

  const keepSelf =
    mode === 'interactive'
      ? isInteractiveSnapshotNode(node)
      : node.backendDOMNodeId !== undefined &&
        Boolean(visibleBackendNodeIds?.has(node.backendDOMNodeId));

  // An interactive node's descendants usually contain its visible label and state.
  if (mode === 'interactive' && keepSelf) return node;

  const children = (node.children ?? [])
    .map(child => filterSnapshotTree(child, mode, visibleBackendNodeIds))
    .filter((child): child is SnapshotNodeBase => child !== null);

  if (!keepSelf && children.length === 0) return null;
  return {
    ...node,
    ...(children.length > 0 ? { children } : { children: undefined }),
  };
}

function snapshotNodeMatchesQuery(node: SnapshotNodeBase, query: PageSnapshotQuery): boolean {
  if (query.role && node.role !== query.role) return false;
  if (query.text === undefined) return true;
  const exact = query.exact ?? true;
  return exact ? node.name === query.text : node.name.includes(query.text);
}

/** Validate and normalize the optional public page_snapshot query. */
export function resolvePageSnapshotQuery(query: unknown): PageSnapshotQuery | undefined {
  if (query === undefined) return undefined;
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new Error('page_snapshot: query must be an object, for example {"query":{"text":"提交","exact":false}}.');
  }

  const { text, role, exact } = query as Record<string, unknown>;
  if (text !== undefined && (typeof text !== 'string' || !text.trim())) {
    throw new Error('page_snapshot: query.text must be a non-empty string');
  }
  if (role !== undefined && (typeof role !== 'string' || !role.trim())) {
    throw new Error('page_snapshot: query.role must be a non-empty string');
  }
  if (text === undefined && role === undefined) {
    throw new Error('page_snapshot: query must include text or role');
  }
  if (exact !== undefined && typeof exact !== 'boolean') {
    throw new Error('page_snapshot: query.exact must be a boolean');
  }

  return {
    ...(text !== undefined ? { text } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(exact !== undefined ? { exact } : {}),
  };
}

function snapshotQueryMatch(node: SnapshotNodeBase): PageSnapshotQueryMatch {
  return {
    ...(node.ref ? { ref: node.ref } : {}),
    role: node.role,
    name: node.name,
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.checked !== undefined ? { checked: node.checked } : {}),
    ...(node.selected ? { selected: true } : {}),
    ...(node.expanded !== undefined ? { expanded: node.expanded } : {}),
  };
}

function compactSnapshotQueryField(value: string): { value: string; truncated: boolean } {
  if (value.length <= PAGE_SNAPSHOT_QUERY_MAX_FIELD_CHARS) {
    return { value, truncated: false };
  }
  const marker = '… [truncated] …';
  const remaining = PAGE_SNAPSHOT_QUERY_MAX_FIELD_CHARS - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return {
    value: value.slice(0, head) + marker + value.slice(-tail),
    truncated: true,
  };
}

function compactSnapshotQueryMatch(match: PageSnapshotQueryMatch): {
  match: PageSnapshotQueryMatch;
  truncated: boolean;
} {
  const role = compactSnapshotQueryField(match.role);
  const name = compactSnapshotQueryField(match.name);
  const value = match.value === undefined ? undefined : compactSnapshotQueryField(match.value);
  return {
    match: {
      ...match,
      role: role.value,
      name: name.value,
      ...(value ? { value: value.value } : {}),
    },
    truncated: role.truncated || name.truncated || Boolean(value?.truncated),
  };
}

/**
 * Bounds the structured query section independently from the formatted
 * snapshot so one broad role query cannot exceed transport limits.
 */
export function limitPageSnapshotQueryMatches(
  matches: PageSnapshotQueryMatch[],
): LimitedSnapshotQueryMatches {
  const limited: PageSnapshotQueryMatch[] = [];
  const encoder = new TextEncoder();
  let bytes = 2;
  let truncated = false;

  for (const candidate of matches) {
    if (limited.length >= PAGE_SNAPSHOT_QUERY_MAX_MATCHES) {
      truncated = true;
      break;
    }
    const compacted = compactSnapshotQueryMatch(candidate);
    const candidateBytes =
      encoder.encode(JSON.stringify(compacted.match)).byteLength + (limited.length > 0 ? 1 : 0);
    if (bytes + candidateBytes > PAGE_SNAPSHOT_QUERY_MAX_BYTES) {
      truncated = true;
      break;
    }
    limited.push(compacted.match);
    bytes += candidateBytes;
    truncated = truncated || compacted.truncated;
  }

  if (limited.length < matches.length) truncated = true;
  return { matches: limited, truncated };
}

/**
 * Keeps matching nodes and the ancestor paths needed to understand where they
 * live. Descendants that do not match are omitted; callers can use a returned
 * ref with page_snapshot.rootRef when they need a wider local subtree.
 */
export function filterSnapshotTreeByQuery(
  node: SnapshotNodeBase | null,
  query: PageSnapshotQuery,
): FilteredSnapshotQuery {
  if (!node) return { tree: null, matches: [] };

  const matches: PageSnapshotQueryMatch[] = [];
  const children: SnapshotNodeBase[] = [];
  for (const child of node.children ?? []) {
    const childResult = filterSnapshotTreeByQuery(child, query);
    matches.push(...childResult.matches);
    if (childResult.tree) children.push(childResult.tree);
  }

  const matchesSelf = snapshotNodeMatchesQuery(node, query);
  if (matchesSelf) matches.unshift(snapshotQueryMatch(node));
  if (!matchesSelf && children.length === 0) return { tree: null, matches };

  return {
    tree: {
      ...node,
      ...(children.length > 0 ? { children } : { children: undefined }),
    },
    matches,
  };
}

export function countSnapshotNodes(node: SnapshotNodeBase | null): number {
  if (!node) return 0;
  return 1 + (node.children ?? []).reduce((total, child) => total + countSnapshotNodes(child), 0);
}

function takeHeadTail<T>(items: T[], limit: number): { items: T[]; headCount: number } {
  const available = Math.max(0, Math.floor(limit) - 1);
  const tailCount = available > 1 ? Math.max(1, Math.floor(available * 0.3)) : 0;
  const headCount = Math.max(0, available - tailCount);
  return {
    items: [
      ...items.slice(0, headCount),
      ...items.slice(Math.max(headCount, items.length - tailCount)),
    ],
    headCount,
  };
}

/** Format snapshot lines with bounded, head-and-tail-preserving output. */
export function formatSnapshotWithLimits(
  lines: string[],
  limits: SnapshotTextLimits = {},
): FormattedSnapshot {
  const maxNodes =
    limits.maxNodes === undefined || limits.maxNodes === 0
      ? Infinity
      : Math.max(3, Math.floor(limits.maxNodes));
  const maxChars =
    limits.maxChars === undefined
      ? 60000
      : limits.maxChars === 0
        ? Infinity
        : Math.max(200, Math.floor(limits.maxChars));
  let outputLines = lines;
  let truncated = false;

  if (outputLines.length > maxNodes) {
    const originalCount = outputLines.length;
    const selected = takeHeadTail(outputLines, maxNodes);
    outputLines = [
      ...selected.items.slice(0, selected.headCount),
      `... [snapshot nodes omitted: showing ${selected.items.length} of ${originalCount}; use rootSelector or mode:"viewport"]`,
      ...selected.items.slice(selected.headCount),
    ];
    truncated = true;
  }

  let snapshot = outputLines.join('\n');
  if (snapshot.length > maxChars) {
    const originalLength = snapshot.length;
    const marker = `\n... [snapshot content omitted: showing at most ${maxChars} of ${originalLength} chars; use rootSelector, mode:"viewport", or maxChars:0]\n`;
    const usable = Math.max(0, maxChars - marker.length);
    const headBudget = Math.ceil(usable * 0.7);
    const tailBudget = Math.max(0, usable - headBudget);
    const headCut = snapshot.lastIndexOf('\n', headBudget);
    const tailStartCandidate = Math.max(0, snapshot.length - tailBudget);
    const tailCut = snapshot.indexOf('\n', tailStartCandidate);
    const head = snapshot.slice(0, headCut > 0 ? headCut : headBudget);
    const tail = snapshot.slice(tailCut >= 0 ? tailCut + 1 : tailStartCandidate);
    snapshot = head + marker + tail;
    truncated = true;
  }

  return {
    snapshot,
    truncated,
    outputNodeCount: snapshot
      ? snapshot.split('\n').filter(line => !line.startsWith('... [')).length
      : 0,
  };
}
