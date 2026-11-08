import type { SnapshotNodeBase } from './axSnapshot.js';

export interface DOMSnapshotRareBooleanData {
  index?: number[];
}

export interface DOMSnapshotRareStringData {
  index?: number[];
  value?: number[];
}

export interface DOMSnapshotNodeTree {
  parentIndex?: number[];
  nodeType?: number[];
  nodeName?: number[];
  nodeValue?: number[];
  backendNodeId?: number[];
  attributes?: number[][];
  isClickable?: DOMSnapshotRareBooleanData;
  inputValue?: DOMSnapshotRareStringData;
  inputChecked?: DOMSnapshotRareBooleanData;
  optionSelected?: DOMSnapshotRareBooleanData;
}

export interface DOMSnapshotDocument {
  frameId?: number;
  nodes?: DOMSnapshotNodeTree;
  layout?: {
    nodeIndex?: number[];
    bounds?: Array<[number, number, number, number]>;
    styles?: number[][];
  };
}

export interface DOMSnapshotCapture {
  strings?: string[];
  documents?: DOMSnapshotDocument[];
}

export interface DOMSnapshotRefEntry {
  backendNodeId: number;
  frameId?: string;
  role: string;
  name: string;
}

export interface DOMSnapshotTree {
  frameId?: string;
  tree: SnapshotNodeBase | null;
}

export interface BuildDOMSnapshotOptions {
  rootBackendNodeId?: number;
  frameId?: string;
  depth?: number;
  registerRef(entry: DOMSnapshotRefEntry): string;
}

const SKIPPED_DOM_TAGS = new Set([
  'head',
  'link',
  'meta',
  'noscript',
  'script',
  'style',
  'template',
]);

const ATOMIC_DOM_ROLES = new Set([
  'button',
  'checkbox',
  'clickable',
  'img',
  'link',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
]);

const DESCENDANT_NAME_DOM_ROLES = new Set([
  'button',
  'cell',
  'checkbox',
  'clickable',
  'columnheader',
  'heading',
  'link',
  'listitem',
  'option',
  'radio',
  'switch',
]);

function normalizeText(value: string, maxChars = 512): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (/^[\uE000-\uF8FF]+$/.test(normalized)) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function indexedValues(indexes: number[] | undefined, values?: number[]): Map<number, number> {
  const result = new Map<number, number>();
  for (let offset = 0; offset < (indexes?.length ?? 0); offset += 1) {
    const index = indexes?.[offset];
    if (index === undefined) continue;
    result.set(index, values?.[offset] ?? 1);
  }
  return result;
}

function attributesFor(
  strings: string[],
  encodedAttributes: number[] | undefined,
): Map<string, string> {
  const attributes = new Map<string, string>();
  for (let offset = 0; offset + 1 < (encodedAttributes?.length ?? 0); offset += 2) {
    const name = strings[encodedAttributes?.[offset] ?? -1];
    const value = strings[encodedAttributes?.[offset + 1] ?? -1];
    if (name !== undefined) attributes.set(name.toLowerCase(), value ?? '');
  }
  return attributes;
}

function ariaBooleanAttribute(attributes: ReadonlyMap<string, string>, name: string): boolean {
  return attributes.get(name)?.toLowerCase() === 'true';
}

function inferDOMRole(
  tag: string,
  attributes: ReadonlyMap<string, string>,
  clickable: boolean,
): string | undefined {
  const explicitRole = attributes.get('role')?.trim().split(/\s+/)[0];
  if (explicitRole && explicitRole !== 'none' && explicitRole !== 'presentation') {
    return explicitRole;
  }

  if (/^h[1-6]$/.test(tag)) return 'heading';
  switch (tag) {
    case 'a':
    case 'area':
      if (attributes.has('href')) return 'link';
      break;
    case 'button':
    case 'summary':
      return 'button';
    case 'dialog':
      return 'dialog';
    case 'form':
      return 'form';
    case 'iframe':
      return 'iframe';
    case 'img':
      return 'img';
    case 'input': {
      const type = (attributes.get('type') ?? 'text').toLowerCase();
      if (type === 'hidden') return undefined;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['button', 'image', 'reset', 'submit'].includes(type)) return 'button';
      return 'textbox';
    }
    case 'li':
      return 'listitem';
    case 'ol':
    case 'ul':
      return 'list';
    case 'option':
      return 'option';
    case 'select':
      return attributes.has('multiple') ? 'listbox' : 'combobox';
    case 'table':
      return 'table';
    case 'td':
      return 'cell';
    case 'textarea':
      return 'textbox';
    case 'th':
      return 'columnheader';
    case 'tr':
      return 'row';
  }

  if (attributes.has('contenteditable') && attributes.get('contenteditable') !== 'false') {
    return 'textbox';
  }
  if (clickable || attributes.has('onclick')) return 'clickable';
  return undefined;
}

function joinSnapshotText(nodes: SnapshotNodeBase[]): string {
  const values: string[] = [];
  const visit = (node: SnapshotNodeBase): void => {
    if (node.role === 'StaticText' && node.name) values.push(node.name);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return normalizeText(values.join(' '));
}

function inferDOMName(
  tag: string,
  role: string,
  attributes: ReadonlyMap<string, string>,
  descendantText: string,
  inputValue: string | undefined,
): string {
  const attributeName =
    attributes.get('aria-label') ??
    attributes.get('alt') ??
    attributes.get('title') ??
    attributes.get('placeholder');
  if (attributeName) return normalizeText(attributeName);
  if (descendantText && DESCENDANT_NAME_DOM_ROLES.has(role)) return descendantText;
  if (role === 'button' && inputValue) return normalizeText(inputValue);
  if (tag === 'iframe') return normalizeText(attributes.get('name') ?? '');
  return '';
}

/**
 * Builds a compact, DOM-derived tree from CDP DOMSnapshot data.
 *
 * Only rendered text and high-confidence semantic or clickable elements are
 * represented. Generic wrapper elements are promoted so framework-heavy DOMs
 * do not consume the output budget without adding actionable information.
 */
export function buildTreesFromDOMSnapshot(
  capture: DOMSnapshotCapture,
  options: BuildDOMSnapshotOptions,
): DOMSnapshotTree[] {
  const strings = capture.strings ?? [];
  const results: DOMSnapshotTree[] = [];
  const requestedDepth =
    options.depth === undefined || !Number.isFinite(options.depth)
      ? Infinity
      : Math.max(0, Math.floor(options.depth));

  for (const [documentIndex, document] of (capture.documents ?? []).entries()) {
    const frameId =
      document.frameId === undefined ? undefined : strings[document.frameId] || undefined;
    if (options.frameId && frameId !== options.frameId) continue;

    const nodes = document.nodes;
    const backendNodeIds = nodes?.backendNodeId ?? [];
    if (backendNodeIds.length === 0) continue;
    const rootIndex =
      options.rootBackendNodeId === undefined
        ? 0
        : backendNodeIds.indexOf(options.rootBackendNodeId);
    if (rootIndex < 0) continue;

    const parentIndexes = nodes?.parentIndex ?? [];
    const childrenByParent = new Map<number, number[]>();
    for (let index = 0; index < backendNodeIds.length; index += 1) {
      const parentIndex = parentIndexes[index];
      if (parentIndex === undefined || parentIndex < 0) continue;
      const children = childrenByParent.get(parentIndex) ?? [];
      children.push(index);
      childrenByParent.set(parentIndex, children);
    }

    const clickableIndexes = new Set(nodes?.isClickable?.index ?? []);
    const inputValues = indexedValues(nodes?.inputValue?.index, nodes?.inputValue?.value);
    const checkedIndexes = new Set(nodes?.inputChecked?.index ?? []);
    const selectedIndexes = new Set(nodes?.optionSelected?.index ?? []);
    const visibleLayoutIndexes = new Set<number>();
    const hiddenLayoutIndexes = new Set<number>();
    const layoutNodeIndexes = document.layout?.nodeIndex ?? [];
    const layoutBounds = document.layout?.bounds ?? [];
    const layoutStyles = document.layout?.styles ?? [];
    const hasLayoutData = layoutNodeIndexes.length > 0;
    for (let index = 0; index < layoutNodeIndexes.length; index += 1) {
      const nodeIndex = layoutNodeIndexes[index];
      const bounds = layoutBounds[index];
      if (nodeIndex === undefined || !bounds || bounds[2] <= 0 || bounds[3] <= 0) continue;
      const [displayIndex, visibilityIndex, opacityIndex] = layoutStyles[index] ?? [];
      const display = displayIndex === undefined ? '' : strings[displayIndex];
      const visibility = visibilityIndex === undefined ? '' : strings[visibilityIndex];
      const opacity = opacityIndex === undefined ? '' : strings[opacityIndex];
      if (
        display === 'none' ||
        visibility === 'hidden' ||
        visibility === 'collapse' ||
        (opacity !== '' && Number(opacity) <= 0)
      ) {
        hiddenLayoutIndexes.add(nodeIndex);
        continue;
      }
      visibleLayoutIndexes.add(nodeIndex);
    }

    interface BuiltBranch {
      nodes: SnapshotNodeBase[];
      rendered: boolean;
    }

    const refFrameId = frameId && (documentIndex > 0 || options.frameId) ? frameId : undefined;

    const build = (nodeIndex: number): BuiltBranch => {
      const nodeType = nodes?.nodeType?.[nodeIndex];
      const nodeNameIndex = nodes?.nodeName?.[nodeIndex];
      const nodeValueIndex = nodes?.nodeValue?.[nodeIndex];
      const nodeName = strings[nodeNameIndex ?? -1] ?? '';
      const tag = nodeName.toLowerCase();
      const attributes = attributesFor(strings, nodes?.attributes?.[nodeIndex]);
      if (
        (nodeType === 1 && SKIPPED_DOM_TAGS.has(tag)) ||
        attributes.has('hidden') ||
        attributes.has('inert') ||
        hiddenLayoutIndexes.has(nodeIndex)
      ) {
        return { nodes: [], rendered: false };
      }

      const childBranches = (childrenByParent.get(nodeIndex) ?? []).map(childIndex =>
        build(childIndex),
      );
      const childNodes = childBranches.flatMap(branch => branch.nodes);
      const ownRendered = !hasLayoutData || visibleLayoutIndexes.has(nodeIndex);
      const rendered = ownRendered || childBranches.some(branch => branch.rendered);
      if (!rendered) return { nodes: [], rendered: false };

      if (nodeType === 3) {
        const text = normalizeText(strings[nodeValueIndex ?? -1] ?? '');
        if (!text || !ownRendered) return { nodes: [], rendered };
        const backendNodeId = backendNodeIds[nodeIndex];
        const result: SnapshotNodeBase = {
          role: 'StaticText',
          name: text,
          backendDOMNodeId: backendNodeId,
        };
        if (backendNodeId !== undefined) {
          result.ref = options.registerRef({
            backendNodeId,
            ...(refFrameId ? { frameId: refFrameId } : {}),
            role: result.role,
            name: result.name,
          });
        }
        return { nodes: [result], rendered: true };
      }

      if (nodeType !== 1 && nodeType !== 9 && nodeType !== 11) {
        return { nodes: childNodes, rendered };
      }

      const role =
        nodeType === 9
          ? 'document'
          : inferDOMRole(tag, attributes, clickableIndexes.has(nodeIndex));
      if (!role && nodeType !== 9) return { nodes: childNodes, rendered };

      const descendantText = joinSnapshotText(childNodes);
      const encodedInputValue = inputValues.get(nodeIndex);
      const inputValue =
        encodedInputValue === undefined ? undefined : (strings[encodedInputValue] ?? '');
      const name =
        nodeType === 9 ? '' : inferDOMName(tag, role ?? '', attributes, descendantText, inputValue);
      const backendNodeId = backendNodeIds[nodeIndex];
      const result: SnapshotNodeBase = {
        role: role ?? 'document',
        name,
        backendDOMNodeId: backendNodeId,
      };
      if (backendNodeId !== undefined && nodeType === 1) {
        result.ref = options.registerRef({
          backendNodeId,
          ...(refFrameId ? { frameId: refFrameId } : {}),
          role: result.role,
          name: result.name,
        });
      }

      const inputType = (attributes.get('type') ?? '').toLowerCase();
      if (inputValue && inputType !== 'password' && role !== 'button') {
        result.value = normalizeText(inputValue);
      }
      if (checkedIndexes.has(nodeIndex)) result.checked = true;
      if (
        selectedIndexes.has(nodeIndex) ||
        attributes.has('selected') ||
        ariaBooleanAttribute(attributes, 'aria-selected')
      ) {
        result.selected = true;
      }
      if (attributes.has('disabled') || ariaBooleanAttribute(attributes, 'aria-disabled')) {
        result.disabled = true;
      }
      if (attributes.has('required') || ariaBooleanAttribute(attributes, 'aria-required')) {
        result.required = true;
      }
      const ariaChecked = attributes.get('aria-checked');
      if (ariaChecked === 'mixed') result.checked = 'mixed';
      else if (ariaChecked === 'true') result.checked = true;
      else if (ariaChecked === 'false') result.checked = false;
      const ariaExpanded = attributes.get('aria-expanded');
      if (ariaExpanded === 'true') result.expanded = true;
      else if (ariaExpanded === 'false') result.expanded = false;
      if (role === 'heading') result.level = Number(tag.slice(1));

      const retainedChildren = ATOMIC_DOM_ROLES.has(result.role)
        ? childNodes.filter(
            child => child.role !== 'StaticText' && !(child.role === 'img' && !child.name),
          )
        : childNodes;
      if (retainedChildren.length > 0) {
        result.children = retainedChildren;
      }
      return { nodes: [result], rendered };
    };

    const built = build(rootIndex).nodes;
    const untrimmedTree =
      built.length === 0
        ? null
        : built.length === 1
          ? built[0]
          : { role: 'document', name: '', children: built };
    const trimDepth = (node: SnapshotNodeBase | null, depth: number): SnapshotNodeBase | null => {
      if (!node || requestedDepth === Infinity) return node;
      if (depth >= requestedDepth) return { ...node, children: undefined };
      return {
        ...node,
        ...(node.children
          ? { children: node.children.map(child => trimDepth(child, depth + 1)!) }
          : {}),
      };
    };
    results.push({
      ...(refFrameId ? { frameId: refFrameId } : {}),
      tree: trimDepth(untrimmedTree, 0),
    });
  }

  return results;
}
