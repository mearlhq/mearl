/**
 * CDP accessibility tree snapshot and frame handlers.
 */

import {
  SKIP_ROLES,
  ALWAYS_SKIP_ROLES,
  buildTreesFromDOMSnapshot,
  countSnapshotNodes,
  extractAXProperties,
  filterSnapshotTree,
  filterSnapshotTreeByQuery,
  formatSnapshotNode,
  formatSnapshotWithLimits,
  hasInteractiveSnapshotNode,
  limitPageSnapshotQueryMatches,
  readDOMCheckedState as readDOMCheckedStateInPage,
  reconcileAXCheckedStates,
  resolveDOMSnapshotViewportBounds,
  resolvePageSnapshotQuery,
  type BackendNodeSnapshotRefAllocator,
  type DOMSnapshotCapture,
  type PageFramesParams,
  type PageSnapshotParams,
  type PageSnapshotQueryMatch,
} from '@mearl/browser-core';
import type { AXNodeBase, PageSnapshotMode, SnapshotNodeBase } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { registerActions } from './action-registry.js';
import { sendCdpDeviceShellPageCommand } from './device-shell.js';
import { readCdpFrameEntries } from './frame-tree.js';
import { beginPageSnapshotRefs, resolvePageRef, type PageRefEntry } from './page-refs.js';

// ─── Snapshot tree builder ────────────────────────────────────────────────────

const READ_DOM_CHECKED_STATE_SOURCE = readDOMCheckedStateInPage.toString();

async function readDOMCheckedState(
  session: PageSession,
  backendNodeId: number,
): Promise<boolean | 'mixed' | undefined> {
  const resolved = await sendCdpDeviceShellPageCommand(session, 'DOM.resolveNode', {
    backendNodeId,
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) return undefined;
  try {
    const evaluated = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: READ_DOM_CHECKED_STATE_SOURCE,
      returnByValue: true,
    });
    const value = evaluated.result?.value;
    return value === true || value === false || value === 'mixed' ? value : undefined;
  } finally {
    await sendCdpDeviceShellPageCommand(session, 'Runtime.releaseObject', { objectId }).catch(
      () => {},
    );
  }
}

/**
 * Build a pruned SnapshotNodeBase tree from a flat array of AXNodeBase nodes.
 * Mirrors the extension's buildTreeFromAXNodes but without iframe/frameId support.
 */
function buildSnapshotTree(
  nodeMap: Map<string, AXNodeBase>,
  nodeId: string,
  snapshotRefs: BackendNodeSnapshotRefAllocator<PageRefEntry>,
): SnapshotNodeBase | null {
  const node = nodeMap.get(nodeId);
  if (!node) return null;

  const role = node.role?.value ?? 'generic';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const description = node.description?.value;

  if (ALWAYS_SKIP_ROLES.has(role)) return null;
  if (role === 'StaticText' && !name) return null;

  // Collapse SvgRoot into a single leaf node
  if (role === 'SvgRoot') {
    let ref: string | undefined;
    if (node.backendDOMNodeId !== undefined) {
      ref = snapshotRefs.register({
        backendNodeId: node.backendDOMNodeId,
        role,
        name,
      });
    }
    const svgChildCount = node.childIds?.length ?? 0;
    return {
      role: 'SvgRoot',
      name: name || `(${svgChildCount} elements)`,
      backendDOMNodeId: node.backendDOMNodeId,
      ref,
    };
  }

  // Build children first
  const children: SnapshotNodeBase[] = [];
  if (node.childIds) {
    for (const childId of node.childIds) {
      const child = buildSnapshotTree(nodeMap, childId, snapshotRefs);
      if (child) children.push(child);
    }
  }

  // Ignored nodes: promote children
  if (node.ignored) {
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { role: 'group', name: '', children };
  }

  // Structural roles without name: promote children
  if (SKIP_ROLES.has(role) && !name) {
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { role: 'group', name: '', children };
  }

  // Deduplicate single StaticText child with same name
  if (
    children.length === 1 &&
    children[0].role === 'StaticText' &&
    children[0].name === name &&
    !children[0].children
  ) {
    children.length = 0;
  }

  // Assign ref for all elements with a backendDOMNodeId
  let ref: string | undefined;
  if (node.backendDOMNodeId !== undefined) {
    ref = snapshotRefs.register({
      backendNodeId: node.backendDOMNodeId,
      role,
      name,
    });
  }

  const props = extractAXProperties(node);

  const result: SnapshotNodeBase = { role, name, backendDOMNodeId: node.backendDOMNodeId };
  if (ref) result.ref = ref;
  if (value !== undefined && value !== '') result.value = String(value);
  if (description) result.description = description;
  if (props.focused) result.focused = true;
  if (props.checked !== undefined) result.checked = props.checked;
  if (props.disabled) result.disabled = true;
  if (props.required) result.required = true;
  if (props.expanded !== undefined) result.expanded = props.expanded;
  if (props.selected) result.selected = true;
  if (props.level !== undefined) result.level = props.level;
  if (children.length > 0) result.children = children;

  return result;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function resolveRootBackendNodeId(session: PageSession, selector: string): Promise<number> {
  const evaluated = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  if (evaluated.exceptionDetails) {
    const message =
      evaluated.exceptionDetails.exception?.description ??
      evaluated.exceptionDetails.text ??
      'invalid selector';
    throw new Error(`page_snapshot: invalid rootSelector "${selector}": ${message}`);
  }
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === 'null') {
    throw new Error(`page_snapshot: rootSelector not found: ${selector}`);
  }
  try {
    const described = await sendCdpDeviceShellPageCommand(session, 'DOM.describeNode', {
      objectId,
    });
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) {
      throw new Error(`page_snapshot: cannot resolve rootSelector: ${selector}`);
    }
    return backendNodeId;
  } finally {
    await sendCdpDeviceShellPageCommand(session, 'Runtime.releaseObject', { objectId }).catch(
      () => {},
    );
  }
}

async function resolveAncestorBackendNodeId(
  session: PageSession,
  backendNodeId: number,
  ancestorDepth: number,
): Promise<number> {
  if (ancestorDepth === 0) return backendNodeId;

  const resolved = await sendCdpDeviceShellPageCommand(session, 'DOM.resolveNode', {
    backendNodeId,
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error('page_snapshot: cannot resolve rootRef in the current document');
  }

  let ancestorObjectId: string | undefined;
  try {
    const ancestor = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(depth) {
        let element = this && this.nodeType === 3 ? this.parentElement : this;
        let remaining = depth;
        while (element && element.parentElement && remaining > 0) {
          element = element.parentElement;
          remaining -= 1;
        }
        return element;
      }`,
      arguments: [{ value: ancestorDepth }],
      returnByValue: false,
    });
    ancestorObjectId = ancestor.result?.objectId;
    if (!ancestorObjectId || ancestor.result?.subtype === 'null') {
      throw new Error('page_snapshot: cannot resolve an ancestor for rootRef');
    }
    const described = await sendCdpDeviceShellPageCommand(session, 'DOM.describeNode', {
      objectId: ancestorObjectId,
    });
    const ancestorBackendNodeId = described.node?.backendNodeId;
    if (ancestorBackendNodeId === undefined) {
      throw new Error('page_snapshot: cannot resolve an ancestor for rootRef');
    }
    return ancestorBackendNodeId;
  } finally {
    if (ancestorObjectId) {
      await sendCdpDeviceShellPageCommand(session, 'Runtime.releaseObject', {
        objectId: ancestorObjectId,
      }).catch(() => {});
    }
    await sendCdpDeviceShellPageCommand(session, 'Runtime.releaseObject', { objectId }).catch(
      () => {},
    );
  }
}

async function getViewportBackendNodeIds(session: PageSession): Promise<Set<number>> {
  const [metrics, captured] = await Promise.all([
    sendCdpDeviceShellPageCommand(session, 'Page.getLayoutMetrics', {}),
    sendCdpDeviceShellPageCommand(session, 'DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: false,
    }),
  ]);
  const viewport = resolveDOMSnapshotViewportBounds(metrics);
  if (!viewport) throw new Error('page_snapshot: viewport metrics are unavailable');
  const { left, top, width, height } = viewport;
  const right = left + width;
  const bottom = top + height;
  const visible = new Set<number>();

  for (const document of captured.documents ?? []) {
    const backendNodeIds: number[] = document.nodes?.backendNodeId ?? [];
    const nodeIndexes: number[] = document.layout?.nodeIndex ?? [];
    const bounds: Array<[number, number, number, number]> = document.layout?.bounds ?? [];
    for (let index = 0; index < nodeIndexes.length; index += 1) {
      const box = bounds[index];
      const backendNodeId = backendNodeIds[nodeIndexes[index]];
      if (!box || backendNodeId === undefined) continue;
      const [x, y, boxWidth, boxHeight] = box;
      if (boxWidth <= 0 || boxHeight <= 0) continue;
      if (x < right && x + boxWidth > left && y < bottom && y + boxHeight > top) {
        visible.add(backendNodeId);
      }
    }
  }
  return visible;
}

export async function cdpPageSnapshot(
  session: PageSession,
  data: PageSnapshotParams,
): Promise<any> {
  const mode: PageSnapshotMode = data?.mode ?? 'full';
  const rootSelector = data?.rootSelector;
  const rootRef = data?.rootRef;
  const ancestorDepth = data?.ancestorDepth ?? 0;
  const query = resolvePageSnapshotQuery(data?.query);
  if (!['full', 'interactive', 'viewport', 'dom'].includes(mode)) {
    throw new Error('page_snapshot: mode must be one of full, interactive, viewport, dom');
  }
  if (rootSelector !== undefined && (typeof rootSelector !== 'string' || !rootSelector.trim())) {
    throw new Error('page_snapshot: rootSelector must be a non-empty CSS selector');
  }
  if (rootRef !== undefined && (typeof rootRef !== 'string' || !/^@e\d+$/.test(rootRef))) {
    throw new Error('page_snapshot: rootRef must be a snapshot ref like "@e3"');
  }
  if (rootSelector !== undefined && rootRef !== undefined) {
    throw new Error('page_snapshot: rootSelector and rootRef are mutually exclusive');
  }
  if (!Number.isInteger(ancestorDepth) || ancestorDepth < 0 || ancestorDepth > 20) {
    throw new Error('page_snapshot: ancestorDepth must be an integer between 0 and 20');
  }
  if (ancestorDepth > 0 && rootRef === undefined) {
    throw new Error('page_snapshot: ancestorDepth requires rootRef');
  }

  let rootBackendNodeId: number | undefined;
  if (rootSelector) {
    rootBackendNodeId = await resolveRootBackendNodeId(session, rootSelector);
  } else if (rootRef) {
    const entry = resolvePageRef(session, rootRef);
    if (!entry) {
      throw new Error(`Ref ${rootRef} not found. Run page_snapshot first to get fresh refs.`);
    }
    rootBackendNodeId = await resolveAncestorBackendNodeId(
      session,
      entry.backendNodeId,
      ancestorDepth,
    );
  }

  const snapshotRefs = beginPageSnapshotRefs(session);
  if (mode === 'dom') {
    const captured = (await sendCdpDeviceShellPageCommand(session, 'DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'visibility', 'opacity'],
      includeDOMRects: true,
      includePaintOrder: false,
    })) as DOMSnapshotCapture;
    const rawTrees = buildTreesFromDOMSnapshot(captured, {
      ...(rootBackendNodeId !== undefined ? { rootBackendNodeId } : {}),
      depth: data?.depth,
      registerRef: entry =>
        snapshotRefs.register({
          backendNodeId: entry.backendNodeId,
          role: entry.role,
          name: entry.name,
        }),
    });
    const queryResults = rawTrees.map(({ tree }) =>
      query
        ? filterSnapshotTreeByQuery(tree, query)
        : { tree, matches: [] as PageSnapshotQueryMatch[] },
    );
    const allMatches = queryResults.flatMap(result => result.matches);
    const limitedMatches = query
      ? limitPageSnapshotQueryMatches(allMatches)
      : { matches: [], truncated: false };
    const lines: string[] = [];
    for (const [index, result] of queryResults.entries()) {
      if (!result.tree) continue;
      if (index > 0) lines.push('  [Frame]');
      formatSnapshotNode(result.tree, index > 0 ? 2 : 0, lines);
    }
    const formatted = formatSnapshotWithLimits(
      lines.length > 0 ? lines : [query ? '(no matches)' : '(empty page)'],
      { maxChars: data?.maxChars, maxNodes: data?.maxNodes },
    );
    const outputRefKeys = new Set(
      Array.from(formatted.snapshot.matchAll(/(?:^|\n)\s*(@e\d+)\s/g), match => match[1]),
    );
    for (const match of limitedMatches.matches) {
      if (match.ref) outputRefKeys.add(match.ref);
    }
    snapshotRefs.commit(outputRefKeys);
    return {
      snapshot: formatted.snapshot,
      elementCount: queryResults.reduce(
        (total, result) => total + countSnapshotNodes(result.tree),
        0,
      ),
      outputNodeCount: formatted.outputNodeCount,
      mode,
      ...(rootSelector ? { rootSelector } : {}),
      ...(rootRef ? { rootRef, ancestorDepth } : {}),
      ...(query
        ? {
            query,
            matches: limitedMatches.matches,
            matchCount: allMatches.length,
            ...(limitedMatches.truncated ? { matchesTruncated: true } : {}),
          }
        : {}),
      ...(formatted.truncated ? { truncated: true } : {}),
    };
  }

  const [result, visibleBackendNodeIds] = await Promise.all([
    sendCdpDeviceShellPageCommand(
      session,
      rootBackendNodeId === undefined ? 'Accessibility.getFullAXTree' : 'Accessibility.queryAXTree',
      rootBackendNodeId === undefined
        ? { depth: data?.depth }
        : { backendNodeId: rootBackendNodeId },
    ),
    mode === 'viewport' || mode === 'interactive'
      ? getViewportBackendNodeIds(session)
      : Promise.resolve(undefined),
  ]);
  const nodes: AXNodeBase[] = result.nodes ?? [];
  await reconcileAXCheckedStates(nodes, backendNodeId =>
    readDOMCheckedState(session, backendNodeId),
  );
  const nodeMap = new Map<string, AXNodeBase>();
  for (const node of nodes) nodeMap.set(node.nodeId, node);

  const rootNode = nodes[0];
  if (!rootNode) {
    snapshotRefs.commit(new Set());
    return {
      snapshot: '(empty page)',
      elementCount: 0,
      outputNodeCount: 1,
      mode,
      ...(rootSelector ? { rootSelector } : {}),
      ...(rootRef ? { rootRef, ancestorDepth } : {}),
      ...(query ? { query, matches: [], matchCount: 0 } : {}),
    };
  }

  const rawTree = buildSnapshotTree(nodeMap, rootNode.nodeId, snapshotRefs);
  const viewportFilteredTree =
    mode === 'interactive'
      ? filterSnapshotTree(rawTree, 'viewport', visibleBackendNodeIds)
      : rawTree;
  let effectiveMode = mode;
  if (mode === 'interactive' && !hasInteractiveSnapshotNode(viewportFilteredTree)) {
    effectiveMode = 'viewport';
  }
  const modeFilteredTree =
    mode === 'interactive'
      ? effectiveMode === 'interactive'
        ? filterSnapshotTree(viewportFilteredTree, 'interactive')
        : viewportFilteredTree
      : filterSnapshotTree(rawTree, effectiveMode, visibleBackendNodeIds);
  const queryResult = query
    ? filterSnapshotTreeByQuery(modeFilteredTree, query)
    : { tree: modeFilteredTree, matches: [] as PageSnapshotQueryMatch[] };
  const limitedMatches = query
    ? limitPageSnapshotQueryMatches(queryResult.matches)
    : { matches: [], truncated: false };
  const tree = queryResult.tree;

  const lines: string[] = [];
  if (tree) formatSnapshotNode(tree, 0, lines);
  const formatted = formatSnapshotWithLimits(
    lines.length > 0 ? lines : [query ? '(no matches)' : '(empty page)'],
    {
      maxChars: data?.maxChars,
      maxNodes: data?.maxNodes,
    },
  );

  const outputRefKeys = new Set(
    Array.from(formatted.snapshot.matchAll(/(?:^|\n)\s*(@e\d+)\s/g), match => match[1]),
  );
  for (const match of limitedMatches.matches) {
    if (match.ref) outputRefKeys.add(match.ref);
  }
  snapshotRefs.commit(outputRefKeys);

  return {
    snapshot: formatted.snapshot,
    elementCount: countSnapshotNodes(tree),
    outputNodeCount: formatted.outputNodeCount,
    mode,
    ...(rootSelector ? { rootSelector } : {}),
    ...(rootRef ? { rootRef, ancestorDepth } : {}),
    ...(query
      ? {
          query,
          matches: limitedMatches.matches,
          matchCount: queryResult.matches.length,
          ...(limitedMatches.truncated ? { matchesTruncated: true } : {}),
        }
      : {}),
    ...(effectiveMode !== mode ? { fallbackMode: 'viewport' } : {}),
    ...(formatted.truncated ? { truncated: true } : {}),
  };
}

export async function cdpPageFrames(session: PageSession, _data: PageFramesParams): Promise<any> {
  const frames = (await readCdpFrameEntries(session)).map(entry => entry.frame);
  return { frames, count: frames.length };
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerActions([
  { name: 'page_snapshot', session: 'page', handler: cdpPageSnapshot },
  { name: 'page_frames', session: 'page', handler: cdpPageFrames },
]);
