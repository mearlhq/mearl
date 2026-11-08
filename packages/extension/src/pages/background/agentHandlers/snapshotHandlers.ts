/**
 * Agent handler: page_snapshot
 *
 * Captures either the CDP accessibility tree or an explicit rendered-DOM view,
 * then prunes it into a compact text representation with element refs (@e1, @e2...)
 * that AI agents can use to interact with the page.
 *
 * Inspired by agent-browser's snapshot-ref pattern:
 *   snapshot → get refs → click/fill by ref → re-snapshot
 */

import { acquireDebuggerLease, resolveDebuggerFrameExecutionContextId } from '../debuggerSessionManager';
import {
  findFrameNode, frameDebuggee, getContainerTopFrame, getFrameTarget, getFrameViewportTransform,
  readFrameTree, type FrameTreeNode,
} from '../utils/containerFrameTarget';
import {
  SKIP_ROLES,
  ALWAYS_SKIP_ROLES,
  buildTreesFromDOMSnapshot,
  extractAXProperties,
  filterSnapshotTree,
  filterSnapshotTreeByQuery,
  formatSnapshotNode,
  formatSnapshotWithLimits,
  countSnapshotNodes,
  hasInteractiveSnapshotNode,
  limitPageSnapshotQueryMatches,
  readDOMCheckedState as readDOMCheckedStateInPage,
  reconcileAXCheckedStates,
  resolveDOMSnapshotViewportBounds,
  resolvePageSnapshotQuery,
  type AXNodeBase,
  type BackendNodeSnapshotRefAllocator,
  type DOMSnapshotCapture,
  type PageSnapshotMode,
  type PageFramesParams,
  type PageSnapshotParams,
  type PageSnapshotQuery,
  type PageSnapshotQueryMatch,
  type SnapshotNodeBase,
} from '@mearl/browser-core';
import { beginSnapshotRefs, resolveRef, type RefEntry } from './pageRefs';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Extension-specific AXNode with optional parentId field. */
interface AXNode extends AXNodeBase {
  parentId?: string;
}

/** Alias for readability within this module. */
type SnapshotNode = SnapshotNodeBase;

// SKIP_ROLES, ALWAYS_SKIP_ROLES imported from @mearl/browser-core

// ─── CDP Frame Types ──────────────────────────────────────────────────────────

interface FrameInfo {
  id: string;
  url: string;
  name?: string;
}

interface LayoutMetrics {
  cssVisualViewport?: {
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
  visualViewport?: {
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
}

interface DomSnapshotDocument {
  nodes?: { backendNodeId?: number[] };
  frameId?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  layout?: {
    nodeIndex?: number[];
    bounds?: Array<[number, number, number, number]>;
    styles?: number[][];
  };
}

interface SnapshotViewportData {
  visibleBackendNodeIds: Set<number>;
  outerViewport: { width: number; height: number };
  contentViewport: { x: number; y: number; width: number; height: number };
  scrollX: number;
  scrollY: number;
}

const READ_DOM_CHECKED_STATE_SOURCE = readDOMCheckedStateInPage.toString();

async function readDOMCheckedState(
  debugTarget: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<boolean | 'mixed' | undefined> {
  const resolved = (await chrome.debugger.sendCommand(debugTarget, 'DOM.resolveNode', {
    backendNodeId,
  })) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) return undefined;
  try {
    const evaluated = (await chrome.debugger.sendCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: READ_DOM_CHECKED_STATE_SOURCE,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = evaluated.result?.value;
    return value === true || value === false || value === 'mixed' ? value : undefined;
  } finally {
    await chrome.debugger
      .sendCommand(debugTarget, 'Runtime.releaseObject', { objectId })
      .catch(() => {});
  }
}

async function resolveRootBackendNodeId(
  debugTarget: chrome.debugger.Debuggee,
  selector: string,
  contextId?: number,
): Promise<number> {
  const evaluated = (await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
    ...(contextId !== undefined ? { contextId } : {}),
  })) as {
    result?: { objectId?: string; subtype?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
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
    const described = (await chrome.debugger.sendCommand(debugTarget, 'DOM.describeNode', {
      objectId,
    })) as { node?: { backendNodeId?: number } };
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) {
      throw new Error(`page_snapshot: cannot resolve rootSelector: ${selector}`);
    }
    return backendNodeId;
  } finally {
    await chrome.debugger
      .sendCommand(debugTarget, 'Runtime.releaseObject', { objectId })
      .catch(() => {});
  }
}

async function resolveAncestorBackendNodeId(
  debugTarget: chrome.debugger.Debuggee,
  backendNodeId: number,
  ancestorDepth: number,
): Promise<number> {
  if (ancestorDepth === 0) return backendNodeId;

  const resolved = (await chrome.debugger.sendCommand(debugTarget, 'DOM.resolveNode', {
    backendNodeId,
  })) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error('page_snapshot: cannot resolve rootRef in the current document');
  }

  let ancestorObjectId: string | undefined;
  try {
    const ancestor = (await chrome.debugger.sendCommand(debugTarget, 'Runtime.callFunctionOn', {
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
    })) as { result?: { objectId?: string; subtype?: string } };
    ancestorObjectId = ancestor.result?.objectId;
    if (!ancestorObjectId || ancestor.result?.subtype === 'null') {
      throw new Error('page_snapshot: cannot resolve an ancestor for rootRef');
    }
    const described = (await chrome.debugger.sendCommand(debugTarget, 'DOM.describeNode', {
      objectId: ancestorObjectId,
    })) as { node?: { backendNodeId?: number } };
    const ancestorBackendNodeId = described.node?.backendNodeId;
    if (ancestorBackendNodeId === undefined) {
      throw new Error('page_snapshot: cannot resolve an ancestor for rootRef');
    }
    return ancestorBackendNodeId;
  } finally {
    if (ancestorObjectId) {
      await chrome.debugger
        .sendCommand(debugTarget, 'Runtime.releaseObject', { objectId: ancestorObjectId })
        .catch(() => {});
    }
    await chrome.debugger
      .sendCommand(debugTarget, 'Runtime.releaseObject', { objectId })
      .catch(() => {});
  }
}

async function getViewportBackendNodeIds(
  debugTarget: chrome.debugger.Debuggee & { sessionId?: string },
  frameId?: string,
): Promise<SnapshotViewportData> {
  const [metrics, captured, topMetrics] = await Promise.all([
    chrome.debugger.sendCommand(debugTarget, 'Page.getLayoutMetrics') as Promise<LayoutMetrics>,
    chrome.debugger.sendCommand(debugTarget, 'DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'visibility', 'opacity'],
      includeDOMRects: true,
      includePaintOrder: false,
    }) as Promise<{ documents?: DomSnapshotDocument[]; strings?: string[] }>,
    debugTarget.sessionId
      ? chrome.debugger.sendCommand({ tabId: debugTarget.tabId }, 'Page.getLayoutMetrics') as Promise<LayoutMetrics>
      : undefined,
  ]);
  const outerViewport = resolveDOMSnapshotViewportBounds(metrics);
  if (!outerViewport) throw new Error('page_snapshot: viewport metrics are unavailable');
  const cssViewportWidth = metrics.cssVisualViewport?.clientWidth ?? outerViewport.width;
  const cssViewportHeight = metrics.cssVisualViewport?.clientHeight ?? outerViewport.height;
  const snapshotScaleX = outerViewport.width / cssViewportWidth;
  const snapshotScaleY = outerViewport.height / cssViewportHeight;
  const tabId = debugTarget.tabId;
  const transform =
    frameId && typeof tabId === 'number'
      ? await getFrameViewportTransform(tabId, frameId)
      : undefined;
  const strings = captured.strings ?? [];
  const documents = (captured.documents ?? []).filter((document, index) => {
    if (frameId) return document.frameId !== undefined && strings[document.frameId] === frameId;
    return index === 0;
  });
  const scrollX = documents[0]?.scrollOffsetX ?? outerViewport.left;
  const scrollY = documents[0]?.scrollOffsetY ?? outerViewport.top;
  const left = frameId ? scrollX * snapshotScaleX : outerViewport.left;
  const top = frameId ? scrollY * snapshotScaleY : outerViewport.top;
  const width = transform ? transform.viewport.width * snapshotScaleX : outerViewport.width;
  const height = transform ? transform.viewport.height * snapshotScaleY : outerViewport.height;
  const right = left + width;
  const bottom = top + height;
  const visible = new Set<number>();

  for (const document of documents) {
    const backendNodeIds = document.nodes?.backendNodeId ?? [];
    const nodeIndexes = document.layout?.nodeIndex ?? [];
    const bounds = document.layout?.bounds ?? [];
    const styles = document.layout?.styles ?? [];
    for (let index = 0; index < nodeIndexes.length; index += 1) {
      const box = bounds[index];
      const backendNodeId = backendNodeIds[nodeIndexes[index]];
      if (!box || backendNodeId === undefined) continue;
      const [x, y, boxWidth, boxHeight] = box;
      if (boxWidth <= 0 || boxHeight <= 0) continue;
      const [displayIndex, visibilityIndex, opacityIndex] = styles[index] ?? [];
      const display = displayIndex === undefined ? '' : strings[displayIndex];
      const visibility = visibilityIndex === undefined ? '' : strings[visibilityIndex];
      const opacity = opacityIndex === undefined ? '' : strings[opacityIndex];
      if (
        display === 'none' ||
        visibility === 'hidden' ||
        visibility === 'collapse' ||
        (opacity !== '' && Number(opacity) <= 0)
      ) {
        continue;
      }
      if (x < right && x + boxWidth > left && y < bottom && y + boxHeight > top) {
        visible.add(backendNodeId);
      }
    }
  }
  const topViewport = topMetrics && resolveDOMSnapshotViewportBounds(topMetrics);
  return {
    visibleBackendNodeIds: visible,
    outerViewport: {
      width: topMetrics?.cssVisualViewport?.clientWidth ?? topViewport?.width ?? cssViewportWidth,
      height: topMetrics?.cssVisualViewport?.clientHeight ?? topViewport?.height ?? cssViewportHeight,
    },
    contentViewport: transform
      ? {
          x: transform.offset.x,
          y: transform.offset.y,
          width: transform.viewport.width * transform.scale.x,
          height: transform.viewport.height * transform.scale.y,
        }
      : { x: 0, y: 0, width: cssViewportWidth, height: cssViewportHeight },
    scrollX,
    scrollY,
  };
}

// ─── page_snapshot ────────────────────────────────────────────────────────────

export async function handlePageSnapshot(
  data: PageSnapshotParams,
  getActiveTabId: () => number | null,
): Promise<{
  url: string;
  title: string;
  snapshot: string;
  elementCount: number;
  outputNodeCount: number;
  mode: PageSnapshotMode;
  rootSelector?: string;
  rootRef?: string;
  ancestorDepth?: number;
  query?: PageSnapshotQuery;
  matches?: PageSnapshotQueryMatch[];
  matchCount?: number;
  matchesTruncated?: boolean;
  fallbackMode?: 'viewport';
  outerViewport?: { width: number; height: number };
  contentViewport?: { x: number; y: number; width: number; height: number };
  scrollX?: number;
  scrollY?: number;
  truncated?: boolean;
}> {
  const {
    depth,
    maxChars,
    maxNodes,
    rootSelector,
    rootRef,
    ancestorDepth = 0,
    mode = 'full',
  } = data;
  const query = resolvePageSnapshotQuery(data.query);
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
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  const tab = await chrome.tabs.get(tabId);
  // Page 域：getFrameTree 的 frame tree 跟踪由 Page.enable 启动，未 enable 时只能拿到主 frame，
  // 容器栈里的业务 iframe 会漏。交给 lease 管理而不是手写 enable，否则永远不会有对应的 disable。
  const debuggerLease = await acquireDebuggerLease(tabId, {
    consumer: 'page-snapshot',
    domains: rootSelector ? ['Page', 'Runtime'] : ['Page'],
  });

  try {
    const containerTop = await getContainerTopFrame(tabId);
    let debugTarget = frameDebuggee(tabId, containerTop);
    let scopedFrameId = containerTop?.frameId;
    let rootBackendNodeId: number | undefined;
    if (rootSelector) {
      const contextId = scopedFrameId
        ? await resolveDebuggerFrameExecutionContextId(tabId, scopedFrameId, false, debugTarget.sessionId)
        : undefined;
      rootBackendNodeId = await resolveRootBackendNodeId(debugTarget, rootSelector, contextId);
    } else if (rootRef) {
      const entry = resolveRef(tabId, rootRef);
      if (!entry) {
        throw new Error(`Ref ${rootRef} not found. Run page_snapshot first to get fresh refs.`);
      }
      const refFrame = entry.frameId === scopedFrameId ? containerTop : entry.frameId
        ? await getFrameTarget(tabId, entry.frameId, containerTop?.phoneFrame ? containerTop.frameId : undefined)
        : undefined;
      if (containerTop?.phoneFrame && !refFrame) {
        throw new Error(`page_snapshot: ref ${rootRef} is outside the active preview page. Run page_snapshot again.`);
      }
      scopedFrameId = entry.frameId;
      debugTarget = frameDebuggee(tabId, refFrame);
      rootBackendNodeId = await resolveAncestorBackendNodeId(
        debugTarget,
        entry.backendNodeId,
        ancestorDepth,
      );
    }

    // Snapshot and action deltas share one monotonic ref sequence per tab.
    const snapshotRefs = beginSnapshotRefs(tabId);

    if (mode === 'dom') {
      const captured = (await chrome.debugger.sendCommand(
        debugTarget,
        'DOMSnapshot.captureSnapshot',
        {
          computedStyles: ['display', 'visibility', 'opacity'],
          includeDOMRects: true,
          includePaintOrder: false,
        },
      )) as DOMSnapshotCapture;
      const rawTrees = buildTreesFromDOMSnapshot(captured, {
        ...(rootBackendNodeId !== undefined ? { rootBackendNodeId } : {}),
        ...(scopedFrameId ? { frameId: scopedFrameId } : {}),
        depth,
        registerRef: entry => snapshotRefs.register(entry),
      });
      const queryResults = rawTrees.map(({ frameId, tree }) => {
        const result = query
          ? filterSnapshotTreeByQuery(tree, query)
          : { tree, matches: [] as PageSnapshotQueryMatch[] };
        return { frameId, ...result };
      });
      const allMatches = queryResults.flatMap(result => result.matches);
      const limitedMatches = query
        ? limitPageSnapshotQueryMatches(allMatches)
        : { matches: [], truncated: false };
      const lines: string[] = [];
      for (const [index, result] of queryResults.entries()) {
        if (!result.tree) continue;
        if (index > 0 || result.frameId) {
          lines.push(`  [Frame${result.frameId ? ` ${result.frameId}` : ''}]`);
          formatSnapshotNode(result.tree, 2, lines);
        } else {
          formatSnapshotNode(result.tree, 0, lines);
        }
      }
      const emptyLabel = query ? '(no matches)' : '(empty page)';
      const formatted = formatSnapshotWithLimits(lines.length > 0 ? lines : [emptyLabel], {
        maxChars,
        maxNodes,
      });
      const outputRefs = new Set(
        Array.from(formatted.snapshot.matchAll(/(?:^|\n)\s*(@e\d+)\s/g), match => match[1]),
      );
      for (const match of limitedMatches.matches) {
        if (match.ref) outputRefs.add(match.ref);
      }
      snapshotRefs.commit(outputRefs);
      return {
        url: containerTop?.url || tab.url || '',
        title: tab.title || '',
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

    // Discover all frames (main + iframes) via Page.getFrameTree
    const childFrames: FrameInfo[] = [];

    if (rootBackendNodeId === undefined && mode !== 'viewport' && !containerTop) {
      try {
        const frameTreeResult = (await chrome.debugger.sendCommand(
          debugTarget,
          'Page.getFrameTree',
        )) as { frameTree: FrameTreeNode };

        // Collect child frames recursively
        function collectChildFrames(node: FrameTreeNode): void {
          if (node.childFrames) {
            for (const child of node.childFrames) {
              childFrames.push({
                id: child.frame.id,
                url: child.frame.url,
                name: child.frame.name,
              });
              collectChildFrames(child);
            }
          }
        }
        collectChildFrames(frameTreeResult.frameTree);
      } catch {
        // Page.getFrameTree may fail on some pages; fall back to main frame only
      }
    }

    // ── Build tree for the main frame (container mode: 栈顶 layer) ──

    const axTreeParams = rootBackendNodeId === undefined
      ? { depth, ...(scopedFrameId ? { frameId: scopedFrameId } : {}) }
      : { backendNodeId: rootBackendNodeId };
    const axTreeMethod = rootBackendNodeId === undefined ? 'Accessibility.getFullAXTree' : 'Accessibility.queryAXTree';
    const [mainResult, viewportData] = await Promise.all([
      chrome.debugger.sendCommand(debugTarget, axTreeMethod, axTreeParams) as Promise<{
        nodes: AXNode[];
      }>,
      mode === 'viewport' || mode === 'interactive'
        ? getViewportBackendNodeIds(debugTarget, scopedFrameId)
        : Promise.resolve(undefined),
    ]);

    await reconcileAXCheckedStates(mainResult.nodes, backendNodeId =>
      readDOMCheckedState(debugTarget, backendNodeId),
    );
    const rawMainTree = buildTreeFromAXNodes(
      mainResult.nodes,
      scopedFrameId,
      snapshotRefs,
    );

    // ── Build trees for child frames (iframes) ──

    interface IframeSubtree {
      frame: FrameInfo;
      tree: SnapshotNode | null;
    }
    const rawIframeSubtrees: IframeSubtree[] = [];

    for (const frame of childFrames) {
      try {
        const frameResult = (await chrome.debugger.sendCommand(
          debugTarget,
          'Accessibility.getFullAXTree',
          { depth, frameId: frame.id },
        )) as { nodes: AXNode[] };

        await reconcileAXCheckedStates(frameResult.nodes, backendNodeId =>
          readDOMCheckedState(debugTarget, backendNodeId),
        );
        const frameTree = buildTreeFromAXNodes(frameResult.nodes, frame.id, snapshotRefs);

        if (frameTree) {
          rawIframeSubtrees.push({ frame, tree: frameTree });
        }
      } catch {
        // Some iframes may be cross-origin or inaccessible; skip silently
      }
    }

    const viewportFilteredMainTree =
      mode === 'interactive'
        ? filterSnapshotTree(rawMainTree, 'viewport', viewportData?.visibleBackendNodeIds)
        : rawMainTree;
    const viewportFilteredIframeSubtrees =
      mode === 'interactive'
        ? rawIframeSubtrees.map(({ frame, tree }) => ({
            frame,
            tree: filterSnapshotTree(tree, 'viewport', viewportData?.visibleBackendNodeIds),
          }))
        : rawIframeSubtrees;

    let effectiveMode = mode;
    if (
      mode === 'interactive' &&
      !hasInteractiveSnapshotNode(viewportFilteredMainTree) &&
      !viewportFilteredIframeSubtrees.some(({ tree }) => hasInteractiveSnapshotNode(tree))
    ) {
      effectiveMode = 'viewport';
    }

    const modeFilteredMainTree =
      mode === 'interactive'
        ? effectiveMode === 'interactive'
          ? filterSnapshotTree(viewportFilteredMainTree, 'interactive')
          : viewportFilteredMainTree
        : filterSnapshotTree(rawMainTree, effectiveMode, viewportData?.visibleBackendNodeIds);
    const modeFilteredIframeSubtrees =
      mode === 'interactive'
        ? viewportFilteredIframeSubtrees.map(({ frame, tree }) => ({
            frame,
            tree: effectiveMode === 'interactive' ? filterSnapshotTree(tree, 'interactive') : tree,
          }))
        : rawIframeSubtrees.map(({ frame, tree }) => ({
            frame,
            tree: filterSnapshotTree(tree, effectiveMode, viewportData?.visibleBackendNodeIds),
          }));
    const mainQueryResult = query
      ? filterSnapshotTreeByQuery(modeFilteredMainTree, query)
      : { tree: modeFilteredMainTree, matches: [] };
    const iframeQueryResults = modeFilteredIframeSubtrees.map(({ frame, tree }) => {
      const result = query
        ? filterSnapshotTreeByQuery(tree, query)
        : { tree, matches: [] as PageSnapshotQueryMatch[] };
      return { frame, ...result };
    });
    const mainTree = mainQueryResult.tree;
    const iframeSubtrees = iframeQueryResults.map(({ frame, tree }) => ({ frame, tree }));
    const allMatches = [
      ...mainQueryResult.matches,
      ...iframeQueryResults.flatMap(result => result.matches),
    ];
    const limitedMatches = query
      ? limitPageSnapshotQueryMatches(allMatches)
      : { matches: [], truncated: false };

    // ── Format output ──

    const lines: string[] = [];

    if (mainTree) {
      formatSnapshotNode(mainTree, 0, lines);
    }

    // Append iframe subtrees as clearly labeled sections
    for (const { frame, tree } of iframeSubtrees) {
      if (!tree) continue;
      const label = frame.name
        ? `[Iframe "${frame.name}"] (${frame.url})`
        : `[Iframe] (${frame.url})`;
      lines.push(`  ${label}`);
      formatSnapshotNode(tree, 2, lines);
    }

    const emptyLabel = query ? '(no matches)' : '(empty page)';
    const formatted = formatSnapshotWithLimits(lines.length > 0 ? lines : [emptyLabel], {
      maxChars,
      maxNodes,
    });
    const outputRefs = new Set(
      Array.from(formatted.snapshot.matchAll(/(?:^|\n)\s*(@e\d+)\s/g), match => match[1]),
    );
    for (const match of limitedMatches.matches) {
      if (match.ref) outputRefs.add(match.ref);
    }
    snapshotRefs.commit(outputRefs);
    const elementCount =
      countSnapshotNodes(mainTree) +
      iframeSubtrees.reduce((total, item) => total + countSnapshotNodes(item.tree), 0);

    return {
      url: containerTop?.url || tab.url || '',
      title: tab.title || '',
      snapshot: formatted.snapshot,
      elementCount,
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
      ...(effectiveMode !== mode ? { fallbackMode: 'viewport' as const } : {}),
      ...(viewportData
        ? {
            outerViewport: viewportData.outerViewport,
            contentViewport: viewportData.contentViewport,
            scrollX: viewportData.scrollX,
            scrollY: viewportData.scrollY,
          }
        : {}),
      ...(formatted.truncated ? { truncated: true } : {}),
    };
  } finally {
    await debuggerLease.release();
  }
}

// ─── page_frames ──────────────────────────────────────────────────────────────

export async function handlePageFrames(
  data: PageFramesParams,
  getActiveTabId: () => number | null,
): Promise<{
  frames: Array<{
    frameId: string;
    url: string;
    name: string;
    isMainFrame: boolean;
  }>;
}> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  const debuggerLease = await acquireDebuggerLease(tabId, {
    consumer: 'page-frames',
    domains: ['Page'],
  });

  try {
    const tree = await readFrameTree(tabId);

    const frames: Array<{
      frameId: string;
      url: string;
      name: string;
      isMainFrame: boolean;
    }> = [];

    function collectFrames(node: FrameTreeNode, isMain: boolean): void {
      frames.push({
        frameId: node.frame.id,
        url: node.frame.url,
        name: node.frame.name || '',
        isMainFrame: isMain,
      });
      if (node.childFrames) {
        for (const child of node.childFrames) {
          collectFrames(child, false);
        }
      }
    }

    const container = await getContainerTopFrame(tabId);
    const root = container?.phoneFrame ? findFrameNode(tree, container.frameId) : tree;
    if (root) collectFrames(root, true);

    return { frames };
  } finally {
    await debuggerLease.release();
  }
}

// ─── Tree Building Helpers ────────────────────────────────────────────────────

/**
 * Build a pruned SnapshotNode tree from a flat array of AXNodes.
 * Registers refs into the shared refRegistry with the given frameId.
 */
function buildTreeFromAXNodes(
  axNodes: AXNode[],
  frameId: string | undefined,
  snapshotRefs: BackendNodeSnapshotRefAllocator<RefEntry>,
): SnapshotNode | null {
  const nodeMap = new Map<string, AXNode>();
  for (const node of axNodes) {
    nodeMap.set(node.nodeId, node);
  }

  const rootNode = axNodes[0];
  if (!rootNode) return null;

  function buildTree(nodeId: string): SnapshotNode | null {
    const axNode = nodeMap.get(nodeId);
    if (!axNode) return null;

    const role = axNode.role?.value || '';
    const name = axNode.name?.value || '';
    const value = axNode.value?.value;
    const description = axNode.description?.value;

    if (ALWAYS_SKIP_ROLES.has(role)) return null;
    if (role === 'StaticText' && !name) return null;

    // Collapse SvgRoot into a single leaf node
    if (role === 'SvgRoot') {
      let ref: string | undefined;
      if (axNode.backendDOMNodeId !== undefined) {
        ref = snapshotRefs.register({
          backendNodeId: axNode.backendDOMNodeId,
          frameId,
          role,
          name,
        });
      }
      const svgChildCount = axNode.childIds?.length ?? 0;
      const result: SnapshotNode = {
        role: 'SvgRoot',
        name: name || `(${svgChildCount} elements)`,
        backendDOMNodeId: axNode.backendDOMNodeId,
      };
      if (ref) result.ref = ref;
      return result;
    }

    // Build children first
    const children: SnapshotNode[] = [];
    if (axNode.childIds) {
      for (const childId of axNode.childIds) {
        const child = buildTree(childId);
        if (child) children.push(child);
      }
    }

    // Ignored nodes: promote children
    if (axNode.ignored) {
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

    // Assign ref with frameId
    let ref: string | undefined;
    if (axNode.backendDOMNodeId !== undefined) {
      ref = snapshotRefs.register({
        backendNodeId: axNode.backendDOMNodeId,
        frameId,
        role,
        name,
      });
    }

    const props = extractAXProperties(axNode);

    const result: SnapshotNode = { role, name, backendDOMNodeId: axNode.backendDOMNodeId };
    if (ref) result.ref = ref;
    if (value !== undefined && value !== '') result.value = value;
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

  return buildTree(rootNode.nodeId);
}
