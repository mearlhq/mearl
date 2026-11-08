import { sendPageCommand, runPageScript } from '../pageDialogs';
/**
 * Agent handlers: page_click, page_type, page_scroll, page_hover, page_eval
 *
 * page_click supports selector / text / point targeting; page_type and page_hover
 * support CSS selectors and @ref selectors (e.g. @e1, @e2) from page_snapshot.
 */

import { resolvePageEvalExpression } from '@mearl/browser-core';
import {
  typeIntoElement,
  PageActionDispatchUncertainError,
  PageActionPreconditionError,
  checkPageActionPrecondition,
  matchAXNodesByText,
  formatAXTextMatchCandidates,
  clickElementViaJS,
  clickElementBySelector,
  createPageClickResult,
  isStateAwareClickTarget,
  describePageClickDispatchAttempt,
  dispatchPairedPageInputCommands,
  withPageActionDispatchAttempt,
  PAGE_CLICK_HIDDEN_TOUCH_ERROR,
  resolvePageClickDispatchPolicy,
  PAGE_CLICK_INPUT_TIMEOUT_MS,
  getClickCoordsFromSelector,
  getClickCoordsFromNode,
  getDragCoordsFromNode,
  buildPageDragPath,
  buildPageDragDomExpression,
  resolvePageDragInput,
  resolvePageDragDispatchPolicy,
  unwrapPageDragDomResult,
  buildPagePressDomExpression,
  PAGE_PRESS_INPUT_TIMEOUT_MS,
  resolvePagePressDispatchPolicy,
  resolvePagePressInput,
  unwrapPagePressDomResult,
  showClickIndicator,
  installPageObserverInPage,
  disposePageObserverInPage,
  type PageChangeSet,
  type PageNavigationChange,
  type PageObservationCheckpoint,
  type PageObservationWaitOptions,
  resolveNavigationWaitOptions,
  resolvePageObservationWaitOptions,
  type AXTextMatchNode,
  type PageClickDispatchTarget,
  type PageClickTargetStrategy,
  type PageClickControlState,
  type PageClickSelectionState,
  type PageClickAncestorCandidate,
  type PageClickCoordinates,
  type PageClickFrameTarget,
  type PageClickHitTarget,
  type PageClickParams,
  type PageClickMode,
  type PageClickPointerType,
  type PageClickRequestedTarget,
  type PageClickResultData,
  type PageDragElementCoords,
  type PageDragDomExecutionResult,
  type PageDragEndpoint,
  type PageDragParams,
  type PageDragPoint,
  type PageDragPointerType,
  type PageDragResolvedEndpoint,
  type PageDragResultData,
  type PageEvalParams,
  type PageHoverParams,
  type PageInspectParams,
  type PagePressParams,
  type PagePressResultData,
  type PageScrollParams,
  type PageTypeParams,
  type PageUploadParams,
  type PageWaitParams,
  resolvePageWaitInput,
  buildPageWaitExpression,
  readPageWaitEvaluationError,
  buildPageScrollExpression,
  resolvePageScrollInput,
  SCROLL_ELEMENT_IN_PAGE_SOURCE,
  unwrapPageScrollResult,
  validatePageElementSelector,
  INVALID_NATIVE_SELECTOR_HINT,
  type PageScrollExecutionResult,
  type PageScrollResult,
  type PageInspectExecutionResult,
  type PageInspectResult,
  buildPageInspectExpression,
  INSPECT_ELEMENTS_IN_PAGE_SOURCE,
  resolvePageInspectInput,
  unwrapPageInspectResult,
} from '@mearl/browser-core';
// showClickIndicator → passed as func ref to chrome.scripting.executeScript (non-critical)
import {
  acquireDebuggerLease,
  resolveDebuggerFrameExecutionContextId,
} from '../debuggerSessionManager';
import {
  getContainerTopFrame,
  getFrameTarget,
  getFrameViewportTransform,
  frameDebuggee,
  hitsFrameOwner,
  type ContainerFrameTarget,
  type FrameViewportTransform,
} from '../utils/containerFrameTarget';
import { getEmulationConfigForTab } from '../deviceEmulationState';
import { deleteRef, resolveRef, type RefEntry } from './pageRefs';

// 以下函数必须以源码字符串注入到目标页执行，因此在模块加载时一次性序列化备用。
const TYPE_INTO_ELEMENT_SRC = typeIntoElement.toString();
const CLICK_ELEMENT_VIA_JS_SRC = clickElementViaJS.toString();
const GET_CLICK_COORDS_FROM_NODE_SRC = getClickCoordsFromNode.toString();
const GET_DRAG_COORDS_FROM_NODE_SRC = getDragCoordsFromNode.toString();
const PAGE_OBSERVER_GLOBAL = '__MEARL_PAGE_OBSERVER__';
const BACKGROUND_PAGE_OBSERVATION_DEADLINE_MS = 1000;
const PAGE_OBSERVER_CLEANUP_DEADLINE_MS = 1000;

/**
 * Race page-context work against a service-worker-side deadline. The target
 * document can become frozen or be replaced while an action is navigating.
 */
function raceWithDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error('Page observation deadline exceeded')),
        deadlineMs,
      );
    }),
  ]).finally(() => {
    if (timerId !== undefined) clearTimeout(timerId);
  });
}

/** 在目标 tab 页面上下文中执行一段表达式并返回结果。 */
async function evalInPage<T>(tabId: number, expression: string): Promise<T> {
  const debugTarget = { tabId };
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-eval' });
  try {
    const evalResult = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: any };
    if (evalResult.exceptionDetails) {
      const msg =
        evalResult.exceptionDetails.exception?.description ??
        evalResult.exceptionDetails.text ??
        'Script evaluation failed';
      throw new Error(msg);
    }
    return evalResult.result?.value as T;
  } finally {
    await debuggerLease.release();
  }
}

/**
 * 容器感知的页内 JS 求值：当 tab 处于容器模拟态且存在栈顶 layer 时，
 * 在栈顶 frame 内求值；否则退回主 frame。
 */
async function evalInActivePage<T>(tabId: number, expression: string): Promise<T> {
  return evaluateInClickFrame<T>(tabId, expression, await getContainerTopFrame(tabId));
}

async function resolvePageRefFrame(
  tabId: number,
  ref: string,
  entry: RefEntry,
): Promise<ContainerFrameTarget | undefined> {
  const active = await getContainerTopFrame(tabId);
  const frame = entry.frameId === active?.frameId ? active : entry.frameId
    ? await getFrameTarget(tabId, entry.frameId, active?.phoneFrame ? active.frameId : undefined)
    : undefined;
  if (active?.phoneFrame && !frame) {
    throw new PageActionPreconditionError(`Ref ${ref} is outside the active preview page. Run page_snapshot again.`);
  }
  return frame && active?.phoneFrame ? { ...frame, phoneFrame: true } : frame;
}

type PageObservationWorld = 'scripting' | 'cdp';

export interface ExtensionPageObservationCheckpoint extends PageObservationCheckpoint {
  world: PageObservationWorld;
  containerFrameId?: string;
  containerSessionId?: string;
  containerUrl?: string;
  startedAt?: number;
}

function createContainerNavigationChange(
  checkpoint: ExtensionPageObservationCheckpoint,
  urlAfter: string,
  title: string,
): PageNavigationChange {
  return {
    mode: 'navigation',
    urlBefore: checkpoint.url,
    urlAfter,
    title,
    elapsed:
      checkpoint.startedAt === undefined
        ? 0
        : Math.round((performance.now() - checkpoint.startedAt) * 1000) / 1000,
    loaded: true,
    ready: true,
    settledBy: 'load',
    pendingRequests: 0,
    fullSnapshotRecommended: true,
    snapshotReasons: ['navigation'],
  };
}

function isCommittedContainerUrl(url: string): boolean {
  return url !== '' && url !== 'about:blank';
}

export async function detectExtensionContainerNavigation(
  tabId: number,
  checkpoint: ExtensionPageObservationCheckpoint,
  timeoutMs: number,
): Promise<PageNavigationChange | null> {
  if (!checkpoint.containerFrameId) return null;
  if (checkpoint.containerUrl) {
    const attempts = Math.max(1, Math.min(50, Math.ceil(Math.max(0, timeoutMs) / 50)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const tab = await chrome.tabs?.get(tabId).catch(() => null);
      if (tab?.url && tab.url !== checkpoint.containerUrl) {
        return createContainerNavigationChange(checkpoint, tab.url, tab.title ?? '');
      }
    }
    return null;
  }
  const deadline = performance.now() + Math.max(0, Math.min(timeoutMs, 5000));
  while (true) {
    const tab = await chrome.tabs?.get(tabId).catch(() => null);
    const remainingBeforeFrameQuery = deadline - performance.now();
    if (remainingBeforeFrameQuery <= 0) return null;
    const current = await raceWithDeadline(
      getContainerTopFrame(tabId),
      Math.min(250, remainingBeforeFrameQuery),
    ).catch(() => undefined);
    if (
      current &&
      current.frameId !== checkpoint.containerFrameId &&
      isCommittedContainerUrl(current.url)
    ) {
      return createContainerNavigationChange(checkpoint, current.url, tab?.title ?? '');
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
}

async function evaluatePageObserverWithCdp<T>(
  tabId: number,
  expression: string,
  requireValue = true,
  contextId?: number,
  timeoutMs?: number,
  sessionId?: string,
): Promise<T> {
  const debugTarget = frameDebuggee(tabId, { sessionId });
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-observer' });
  try {
    const result = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    })) as { result: { value: T }; exceptionDetails?: any };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Page observation evaluation failed',
      );
    }
    const value = result.result?.value;
    if (requireValue && (value === null || value === undefined)) {
      throw new Error('Page observation CDP evaluation returned no result');
    }
    return value as T;
  } finally {
    await debuggerLease.release();
  }
}

export async function startExtensionPageObservation(
  tabId: number,
): Promise<ExtensionPageObservationCheckpoint> {
  const startedAt = performance.now();
  const containerTop = await getContainerTopFrame(tabId);
  if (containerTop) {
    const debugTarget = frameDebuggee(tabId, containerTop);
    const lease = await acquireDebuggerLease(tabId, {
      consumer: 'page-observer-start',
      domains: ['Runtime'],
    });
    try {
      const contextId = await getFrameExecutionContextId(debugTarget, containerTop.frameId);
      const checkpoint = await evaluatePageObserverWithCdp<PageObservationCheckpoint>(
        tabId,
        `(${installPageObserverInPage.toString()})()`,
        true,
        contextId,
        undefined,
        containerTop.sessionId,
      );
      assertPageObservationCheckpoint(checkpoint);
      const containerTab = await chrome.tabs?.get(tabId).catch(() => null);
      return {
        ...checkpoint,
        world: 'cdp',
        containerFrameId: containerTop.frameId,
        ...(containerTop.sessionId && { containerSessionId: containerTop.sessionId }),
        containerUrl: containerTab?.url,
        startedAt,
      };
    } finally {
      await lease.release();
    }
  }
  try {
    const [result] = await runPageScript(tabId, () => chrome.scripting.executeScript({
      target: { tabId },
      func: installPageObserverInPage,
    }));
    const checkpoint = result?.result as PageObservationCheckpoint | undefined;
    assertPageObservationCheckpoint(checkpoint);
    return { ...checkpoint, world: 'scripting', startedAt };
  } catch {
    const checkpoint = await evaluatePageObserverWithCdp<PageObservationCheckpoint>(
      tabId,
      `(${installPageObserverInPage.toString()})()`,
    );
    assertPageObservationCheckpoint(checkpoint);
    return { ...checkpoint, world: 'cdp', startedAt };
  }
}

export async function finishExtensionPageObservation(
  tabId: number,
  checkpoint: ExtensionPageObservationCheckpoint,
  options: PageObservationWaitOptions = {},
): Promise<PageChangeSet | PageNavigationChange> {
  const { quietMs, firstChangeTimeoutMs, timeoutMs } = resolvePageObservationWaitOptions(options);
  const tab = await (chrome.tabs?.get(tabId).catch(() => null) ?? Promise.resolve(null));
  const isBackgroundTab = tab !== null && !tab.active;
  const effectiveTimeoutMs = isBackgroundTab ? 0 : timeoutMs;
  const swDeadlineMs = isBackgroundTab ? BACKGROUND_PAGE_OBSERVATION_DEADLINE_MS : timeoutMs + 2000;
  if (checkpoint.containerFrameId) {
    if (checkpoint.containerUrl && tab?.url && tab.url !== checkpoint.containerUrl) {
      return createContainerNavigationChange(checkpoint, tab.url, tab.title ?? '');
    }
    const currentContainerTop = await raceWithDeadline(
      getContainerTopFrame(tabId),
      BACKGROUND_PAGE_OBSERVATION_DEADLINE_MS,
    ).catch(() => undefined);
    if (currentContainerTop && currentContainerTop.frameId !== checkpoint.containerFrameId) {
      if (isCommittedContainerUrl(currentContainerTop.url)) {
        return createContainerNavigationChange(
          checkpoint,
          currentContainerTop.url,
          tab?.title ?? '',
        );
      }
      const navigation = await detectExtensionContainerNavigation(
        tabId,
        checkpoint,
        resolveNavigationWaitOptions(options).graceMs,
      );
      if (navigation) return navigation;
      throw new Error('Container navigation did not commit within the observation grace period');
    }
  }
  let changeSet: PageChangeSet | undefined;
  if (checkpoint.world === 'scripting') {
    const scriptPromise = runPageScript(tabId, () => chrome.scripting.executeScript({
      target: { tabId },
      func: async (
        globalKey: string,
        version: number,
        focus: string | null,
        actionQuietMs: number,
        actionFirstChangeTimeoutMs: number,
        actionTimeoutMs: number,
      ) => {
        const state = (globalThis as any)[globalKey];
        if (!state || typeof state.waitSince !== 'function') {
          throw new Error('Page observer is unavailable after the action');
        }
        return state.waitSince(
          version,
          focus ?? undefined,
          actionQuietMs,
          actionFirstChangeTimeoutMs,
          actionTimeoutMs,
        );
      },
      args: [
        PAGE_OBSERVER_GLOBAL,
        checkpoint.version,
        checkpoint.focus ?? null,
        quietMs,
        firstChangeTimeoutMs,
        effectiveTimeoutMs,
      ],
    }));
    const [result] = await raceWithDeadline(scriptPromise, swDeadlineMs);
    changeSet = result?.result as PageChangeSet | undefined;
  } else {
    const expression = `(() => {
    const state = globalThis[${JSON.stringify(PAGE_OBSERVER_GLOBAL)}];
    if (!state || typeof state.waitSince !== 'function') {
      throw new Error('Page observer is unavailable after the action');
    }
    return state.waitSince(
      ${checkpoint.version},
      ${JSON.stringify(checkpoint.focus)},
      ${quietMs},
      ${firstChangeTimeoutMs},
      ${effectiveTimeoutMs}
    );
  })()`;
    const runtimeLease = checkpoint.containerFrameId
      ? await acquireDebuggerLease(tabId, {
          consumer: 'page-observer-wait',
          domains: ['Runtime'],
        })
      : null;
    try {
      let contextId: number | undefined;
      if (checkpoint.containerFrameId) {
        contextId = await getFrameExecutionContextId(
          frameDebuggee(tabId, { sessionId: checkpoint.containerSessionId }), checkpoint.containerFrameId,
        );
      }
      const cdpPromise = evaluatePageObserverWithCdp<PageChangeSet>(
        tabId,
        expression,
        true,
        contextId,
        swDeadlineMs,
        checkpoint.containerSessionId,
      );
      changeSet = await raceWithDeadline(cdpPromise, swDeadlineMs);
    } finally {
      await runtimeLease?.release();
    }
  }
  if (!changeSet || changeSet.mode !== 'delta') {
    throw new Error('Page observer did not return a change set');
  }
  return changeSet;
}

export async function disposeExtensionPageObservation(
  tabId: number,
  world: PageObservationWorld,
  containerFrameId?: string,
  containerUrl?: string,
): Promise<void> {
  let sessionId: string | undefined;
  if (world === 'scripting') {
    await raceWithDeadline(
      runPageScript(tabId, () => chrome.scripting.executeScript({ target: { tabId }, func: disposePageObserverInPage })),
      PAGE_OBSERVER_CLEANUP_DEADLINE_MS,
    ).catch(() => {});
    return;
  }
  if (containerFrameId) {
    const tab = await chrome.tabs?.get(tabId).catch(() => null);
    if (containerUrl && tab?.url && tab.url !== containerUrl) return;
    const currentContainerTop = await raceWithDeadline(
      getContainerTopFrame(tabId),
      PAGE_OBSERVER_CLEANUP_DEADLINE_MS,
    ).catch(() => undefined);
    if (!currentContainerTop || currentContainerTop.frameId !== containerFrameId) return;
    sessionId = currentContainerTop.sessionId;
  }
  const runtimeLease = containerFrameId
    ? await acquireDebuggerLease(tabId, {
        consumer: 'page-observer-dispose',
        domains: ['Runtime'],
      })
    : null;
  try {
    let contextId: number | undefined;
    if (containerFrameId) {
      contextId = await getFrameExecutionContextId(frameDebuggee(tabId, { sessionId }), containerFrameId).catch(
        () => undefined,
      );
    }
    await raceWithDeadline(
      evaluatePageObserverWithCdp<void>(
        tabId,
        `(${disposePageObserverInPage.toString()})()`,
        false,
        contextId,
        undefined,
        sessionId,
      ),
      PAGE_OBSERVER_CLEANUP_DEADLINE_MS,
    ).catch(() => {});
  } finally {
    await runtimeLease?.release();
  }
}

function assertPageObservationCheckpoint(
  checkpoint: PageObservationCheckpoint | null | undefined,
): asserts checkpoint is PageObservationCheckpoint {
  if (
    !checkpoint ||
    typeof checkpoint.version !== 'number' ||
    typeof checkpoint.url !== 'string' ||
    typeof checkpoint.title !== 'string'
  ) {
    throw new Error('Page observer did not return a checkpoint');
  }
}

/** 在页面指定坐标显示点击可视化指示器（非关键，静默失败）。 */
async function emitClickIndicator(
  tabId: number,
  x: number,
  y: number,
  mode: 'js' | 'cdp',
): Promise<void> {
  try {
    await runPageScript(tabId, () => chrome.scripting.executeScript({
      target: { tabId },
      func: showClickIndicator,
      args: [x, y, mode],
    }));
  } catch {
    // Non-critical — skip silently if injection fails (e.g. chrome:// pages)
  }
}

// ─── page_click ───────────────────────────────────────────────────────────────

interface ClickDispatchResult {
  clicked: boolean;
  tag: string;
  text: string;
  strategy?: PageClickTargetStrategy;
  distance?: number;
  sourceTarget?: { tag: string; text: string };
  actionableAncestorCandidates?: PageClickAncestorCandidate[];
  hitTarget?: PageClickHitTarget;
  frame?: PageClickFrameTarget;
  coordinates?: PageClickCoordinates;
  controlState?: PageClickControlState;
  selectionState?: PageClickSelectionState;
  dispatchMode?: 'trusted-input' | 'dom';
  pointerType?: PageClickPointerType;
}

type PageClickResult = PageClickResultData;

interface ElementClickCoords {
  x: number;
  y: number;
  tag: string;
  text: string;
  inputType?: string;
  strategy?: PageClickTargetStrategy;
  distance?: number;
  sourceTarget?: { tag: string; text: string };
  actionableAncestorCandidates?: PageClickAncestorCandidate[];
}

interface ResolvedClickFrame extends ContainerFrameTarget {
  context: PageClickFrameTarget['context'];
}

async function resolveClickFrame(
  tabId: number,
  requestedFrameId?: string,
): Promise<ResolvedClickFrame | undefined> {
  const containerTop = await getContainerTopFrame(tabId);
  if (!requestedFrameId) {
    return containerTop ? { ...containerTop, context: 'app-content' } : undefined;
  }
  const target = containerTop?.phoneFrame
    ? await getFrameTarget(tabId, requestedFrameId, containerTop.frameId)
    : await getFrameTarget(tabId, requestedFrameId);
  if (!target) {
    throw new PageActionPreconditionError(
      `page_click: frameId "${requestedFrameId}" is not present in the current page.`,
    );
  }
  return {
    ...target,
    phoneFrame: containerTop?.phoneFrame,
    context: containerTop?.frameId === requestedFrameId ? 'app-content' : 'frame',
  };
}

async function evaluateInClickFrame<T>(
  tabId: number,
  expression: string,
  frame?: ContainerFrameTarget,
): Promise<T> {
  if (!frame) return evalInPage<T>(tabId, expression);
  const debugTarget = frameDebuggee(tabId, frame);
  const lease = await acquireDebuggerLease(tabId, {
    consumer: 'page-click-frame-eval',
    domains: ['Runtime'],
  });
  try {
    const contextId = await getFrameExecutionContextId(debugTarget, frame.frameId);
    const result = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: any };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Frame evaluation failed',
      );
    }
    return result.result?.value as T;
  } finally {
    await lease.release();
  }
}

function buildHitTestExpression(point: { x: number; y: number }): string {
  return `(() => {
    const el = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
    if (!el) return null;
    const escapeCss = value => globalThis.CSS && typeof globalThis.CSS.escape === 'function'
      ? globalThis.CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, character => '\\\\' + character);
    let selector = el.id ? '#' + escapeCss(el.id) : el.tagName.toLowerCase();
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 100),
      selector
    };
  })()`;
}

function normalizeHitTarget(value: PageClickHitTarget | null): PageClickHitTarget | null {
  return value && typeof value.tag === 'string' && typeof value.text === 'string' ? value : null;
}

async function projectFramePoint(
  tabId: number,
  transform: FrameViewportTransform,
  point: PageDragPoint,
  requirePreviewHit: boolean,
): Promise<PageDragPoint> {
  const outerPoint = {
    x: transform.offset.x + point.x * transform.scale.x,
    y: transform.offset.y + point.y * transform.scale.y,
  };
  if (requirePreviewHit) {
    const inside = point.x >= 0 && point.y >= 0 &&
      point.x < transform.viewport.width && point.y < transform.viewport.height;
    const owner = transform.outerOwnerBackendNodeId;
    const businessHit = inside && owner !== undefined &&
      await hitsFrameOwner(tabId, owner, outerPoint.x, outerPoint.y);
    if (!businessHit) {
      throw new PageActionPreconditionError('Point is outside the visible device preview page.');
    }
  }
  return outerPoint;
}

async function enrichFrameDispatchTarget(
  tabId: number,
  dispatchTarget: ClickDispatchResult,
  frame: ResolvedClickFrame | undefined,
  framePoint: { x: number; y: number },
): Promise<{ dispatchTarget: ClickDispatchResult; outerPoint: { x: number; y: number } }> {
  if (!frame) {
    const hitTarget = normalizeHitTarget(
      await evaluateInClickFrame<PageClickHitTarget | null>(
        tabId,
        buildHitTestExpression(framePoint),
      ).catch(() => null),
    );
    return {
      dispatchTarget: {
        ...dispatchTarget,
        ...(hitTarget ? { hitTarget } : {}),
        coordinates: { coordinateSpace: 'outer-viewport', outerPoint: framePoint },
      },
      outerPoint: framePoint,
    };
  }

  const transform = await getFrameViewportTransform(tabId, frame.frameId);
  const outerPoint = await projectFramePoint(tabId, transform, framePoint,
    frame.phoneFrame === true && dispatchTarget.dispatchMode === 'trusted-input');
  const hitTarget = normalizeHitTarget(
    await evaluateInClickFrame<PageClickHitTarget | null>(
      tabId,
      buildHitTestExpression(framePoint),
      frame,
    ).catch(() => null),
  );
  return {
    dispatchTarget: {
      ...dispatchTarget,
      ...(hitTarget ? { hitTarget } : {}),
      frame: { frameId: frame.frameId, frameUrl: frame.url, context: frame.context },
      coordinates: {
        coordinateSpace: 'active-frame',
        framePoint,
        outerPoint,
        frameOffset: transform.offset,
        frameScale: transform.scale,
      },
    },
    outerPoint,
  };
}

export async function handlePageClick(
  data: PageClickParams,
  getActiveTabId: () => number | null,
): Promise<PageClickResult> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  const target = checkPageActionPrecondition(() => validateClickTarget(data));
  const frame = await resolveClickFrame(tabId, data.frameId);
  const requestedMode = data.clickMode ?? 'auto';
  const [visibilityState, touchEmulationEnabled] =
    requestedMode === 'auto' || requestedMode === 'touch'
      ? await Promise.all([
          evalInPage<DocumentVisibilityState>(tabId, 'document.visibilityState'),
          prefersTouchInput(tabId),
        ])
      : [undefined, false];
  if (requestedMode === 'touch' && visibilityState === 'hidden') {
    throw new PageActionPreconditionError(PAGE_CLICK_HIDDEN_TOUCH_ERROR);
  }
  const policy = resolvePageClickDispatchPolicy(
    requestedMode,
    visibilityState,
    touchEmulationEnabled,
  );
  const effectiveClickMode = policy.clickMode;
  const finalize = (result: PageClickResult): PageClickResult =>
    policy.fallbackReason ? { ...result, fallbackReason: policy.fallbackReason } : result;
  const requestedTarget = describeRequestedClickTarget(data, target);

  try {
    switch (target) {
      case 'selector': {
        checkPageActionPrecondition(() => validatePageElementSelector(data.selector, 'page_click'));
        const selector = data.selector as string;
        if (selector.startsWith('@e')) {
          return finalize(
            await clickByRef(tabId, selector, effectiveClickMode, policy.stateAwareControls, frame),
          );
        }
        if (effectiveClickMode === 'dom') {
          const dispatchTarget = await clickViaJS(tabId, selector, frame);
          return finalize(createPageClickResult({ kind: 'selector', selector }, dispatchTarget));
        }
        const dispatchTarget = await clickViaCDP(
          tabId,
          selector,
          effectiveClickMode,
          policy.stateAwareControls,
          frame,
        );
        return finalize(createPageClickResult({ kind: 'selector', selector }, dispatchTarget));
      }
      case 'text': {
        return finalize(
          await clickByText(
            tabId,
            data.text as string,
            data.role,
            data.exact,
            data.scope,
            effectiveClickMode,
            policy.stateAwareControls,
            frame,
          ),
        );
      }
      case 'point':
        return finalize(
          await clickByPoint(
            tabId,
            data.point as { x: number; y: number },
            effectiveClickMode,
            data.coordinateSpace ?? (frame?.phoneFrame ? 'active-frame' : 'outer-viewport'),
            frame,
          ),
        );
    }
  } catch (error) {
    throw withPageActionDispatchAttempt(error, {
      action: 'page_click',
      requestedTarget,
      requestedMode,
      effectiveMode: effectiveClickMode,
      ...(visibilityState ? { visibilityState } : {}),
      ...(policy.fallbackReason ? { fallbackReason: policy.fallbackReason } : {}),
    });
  }
}

async function prefersTouchInput(tabId: number): Promise<boolean> {
  const emulationConfig = getEmulationConfigForTab(tabId);
  if (emulationConfig) return emulationConfig.touch;

  return (
    (await evalInPage<boolean>(
      tabId,
      `navigator.maxTouchPoints > 0 && (
      Boolean(navigator.userAgentData && navigator.userAgentData.mobile) ||
      /Android|Mobi|iPhone|iPad|iPod/i.test(navigator.userAgent)
    )`,
    )) === true
  );
}

/**
 * page_click 接受 selector / text / point 三选一定位。
 * 这里只校验选择器存在且只有一种；具体内容（如 selector 非空字符串）由对应分支再校验。
 */
function validateClickTarget(data: PageClickParams): 'selector' | 'text' | 'point' {
  const hasSelector = typeof data.selector === 'string' && data.selector.length > 0;
  const hasText = typeof data.text === 'string' && data.text.length > 0;
  const hasPoint =
    !!data.point &&
    Number.isFinite(data.point.x) &&
    Number.isFinite(data.point.y) &&
    data.point.x >= 0 &&
    data.point.y >= 0;

  const provided = [hasSelector && 'selector', hasText && 'text', hasPoint && 'point'].filter(
    Boolean,
  ) as string[];

  if (data.clickMode !== undefined && !['auto', 'dom', 'mouse', 'touch'].includes(data.clickMode)) {
    throw new Error('page_click: "clickMode" must be one of auto, dom, mouse, touch');
  }
  if (data.scope !== undefined && !hasText) {
    throw new Error('page_click: "scope" is only supported with the "text" target');
  }
  if (
    data.coordinateSpace !== undefined &&
    !['outer-viewport', 'active-frame'].includes(data.coordinateSpace)
  ) {
    throw new Error('page_click: "coordinateSpace" must be one of outer-viewport, active-frame');
  }
  if (data.coordinateSpace !== undefined && !hasPoint) {
    throw new Error('page_click: "coordinateSpace" is only supported with the "point" target');
  }
  if (data.scope !== undefined) {
    validatePageElementSelector(data.scope, 'page_click scope');
  }

  if (provided.length === 1) {
    return provided[0] as 'selector' | 'text' | 'point';
  }

  if (provided.length === 0) {
    throw new Error(
      'page_click: provide exactly one of "selector", "text", or "point". ' +
        'Tip: if you just ran page_snapshot, pass its "@eN" ref as "selector". ' +
        'For text matching, pass "text" (and optionally "role"/"exact" to disambiguate). ' +
        'For coordinate clicks, pass "point": { x, y } in viewport pixels.',
    );
  }

  throw new Error(
    `page_click: provide exactly one of "selector", "text", or "point" — got ${provided.length} (${provided.join(', ')}).`,
  );
}

function describeRequestedClickTarget(
  data: PageClickParams,
  target: 'selector' | 'text' | 'point',
): PageClickRequestedTarget {
  if (target === 'selector') {
    const selector = data.selector as string;
    return { kind: selector.startsWith('@e') ? 'ref' : 'selector', selector };
  }
  if (target === 'text') {
    return {
      kind: 'text',
      name: data.text,
      ...(data.role ? { role: data.role } : {}),
      ...(data.scope ? { scope: data.scope } : {}),
    };
  }
  return { kind: 'point', point: data.point };
}

async function clickByRef(
  tabId: number,
  ref: string,
  clickMode: Exclude<PageClickMode, 'auto'>,
  stateAwareControls: boolean,
  requestedFrame?: ResolvedClickFrame,
): Promise<PageClickResult> {
  const refEntry = resolveRef(tabId, ref);
  if (refEntry === undefined) {
    throw new PageActionPreconditionError(
      `Ref ${ref} not found. Run page_snapshot first to get fresh refs.`,
    );
  }

  if (requestedFrame?.phoneFrame && !refEntry.frameId) {
    throw new PageActionPreconditionError(`Ref ${ref} is outside the active preview page. Run page_snapshot again.`);
  }

  const refFrame = refEntry.frameId && refEntry.frameId !== requestedFrame?.frameId
    ? await resolveClickFrame(tabId, refEntry.frameId)
    : requestedFrame;
  if (requestedFrame && refEntry.frameId && requestedFrame.frameId !== refEntry.frameId) {
    throw new PageActionPreconditionError(
      `page_click: ref ${ref} belongs to frame ${refEntry.frameId}, not ${requestedFrame.frameId}.`,
    );
  }

  try {
    if (clickMode === 'dom' || (stateAwareControls && /^(checkbox|radio)$/i.test(refEntry.role))) {
      const dispatchTarget = await clickByRefViaJS(
        tabId,
        ref,
        refEntry.backendNodeId,
        undefined,
        refFrame,
        refEntry.name,
      );
      return createPageClickResult(
        { kind: 'ref', selector: ref, role: refEntry.role, name: refEntry.name },
        dispatchTarget,
      );
    }
    const dispatchTarget = await clickAtBackendNode(
      tabId,
      refEntry.backendNodeId,
      clickMode,
      undefined,
      refFrame,
      refEntry.name,
      stateAwareControls,
    );
    return createPageClickResult(
      { kind: 'ref', selector: ref, role: refEntry.role, name: refEntry.name },
      dispatchTarget,
    );
  } catch (error) {
    deleteRef(tabId, ref);
    throw error;
  }
}

/** 通过 Runtime.callFunctionOn 调用 `el.click()`，用于显式 JS 点击和原生选择控件。 */
async function clickByRefViaJS(
  tabId: number,
  ref: string,
  backendNodeId: number,
  attachedTarget?: chrome.debugger.Debuggee,
  frame?: ResolvedClickFrame,
  expectedText?: string,
): Promise<ClickDispatchResult> {
  const debugTarget = attachedTarget ?? frameDebuggee(tabId, frame);
  const debuggerLease = attachedTarget
    ? undefined
    : await acquireDebuggerLease(tabId, { consumer: 'page-click' });
  try {
    const resolveResult = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId,
    })) as { object: { objectId: string } };

    const clickResult = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId: resolveResult.object.objectId,
      functionDeclaration: CLICK_ELEMENT_VIA_JS_SRC,
      arguments: [{ value: expectedText }],
      returnByValue: true,
    })) as {
      result: {
        value: {
          tag: string;
          text: string;
          cx: number;
          cy: number;
          strategy: PageClickTargetStrategy;
          distance: number;
          sourceTarget: { tag: string; text: string };
          controlState?: PageClickControlState;
          selectionState?: PageClickSelectionState;
          error?: string;
        } | null;
      };
    };

    if (clickResult.result.value === null) {
      throw new PageActionPreconditionError(`Cannot resolve clickable element for ref ${ref}`);
    }
    if (!clickResult.result.value) {
      throw new Error('page_click evaluation returned no result');
    }
    if (clickResult.result.value.error) {
      throw new PageActionPreconditionError(clickResult.result.value.error);
    }

    const { tag, text, cx, cy, strategy, distance, controlState, selectionState, sourceTarget } =
      clickResult.result.value;
    emitClickIndicator(tabId, cx, cy, 'js').catch(() => {});
    return {
      clicked: true,
      tag,
      text,
      strategy,
      distance,
      sourceTarget,
      dispatchMode: 'dom',
      ...(frame
        ? { frame: { frameId: frame.frameId, frameUrl: frame.url, context: frame.context } }
        : {}),
      ...(controlState ? { controlState } : {}),
      ...(selectionState ? { selectionState } : {}),
    };
  } finally {
    await debuggerLease?.release();
  }
}

async function clickViaJS(
  tabId: number,
  selector: string,
  frame?: ResolvedClickFrame,
): Promise<ClickDispatchResult> {
  const expression = buildSelectorJsClickExpression(selector);
  const value = await evaluateInClickFrame<
    ClickDispatchResult & { error?: string; cx: number; cy: number }
  >(tabId, expression, frame);
  if (!value) throw new Error('page_type evaluation returned no result');
  if (value.error) throw new PageActionPreconditionError(value.error);
  emitClickIndicator(tabId, value.cx, value.cy, 'js').catch(() => {});
  return {
    ...value,
    dispatchMode: 'dom',
    ...(frame
      ? { frame: { frameId: frame.frameId, frameUrl: frame.url, context: frame.context } }
      : {}),
  };
}

function buildSelectorJsClickExpression(selector: string): string {
  return `(${clickElementBySelector.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(INVALID_NATIVE_SELECTOR_HINT)})`;
}

/**
 * Click via trusted CDP input events.
 *
 * The adaptive path routes hidden pages to the DOM fallback. Explicit mouse/touch
 * modes still reach this function and use bounded Input commands.
 */
async function clickViaCDP(
  tabId: number,
  selector: string,
  pointerType: PageClickPointerType,
  useStateAwareControlPath: boolean,
  frame?: ResolvedClickFrame,
): Promise<ClickDispatchResult> {
  // Coordinate resolution and trusted input dispatch share one debugger lease.
  const debugTarget = frameDebuggee(tabId, frame);
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-click' });
  try {
    const contextId = frame
      ? await getFrameExecutionContextId(debugTarget, frame.frameId)
      : undefined;
    const expression = `(${getClickCoordsFromSelector.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(INVALID_NATIVE_SELECTOR_HINT)})`;

    const result = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      ...(contextId !== undefined ? { contextId } : {}),
    })) as { result: { value: ElementClickCoords & { error?: string } } };

    const coord = result.result?.value;
    if (!coord) {
      throw new Error(`page_click: evaluation returned no result for selector "${selector}".`);
    }
    if (coord.error) throw new PageActionPreconditionError(coord.error);

    if (useStateAwareControlPath && isStateAwareClickTarget(coord)) {
      const clickResult = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
        expression: buildSelectorJsClickExpression(selector),
        returnByValue: true,
        ...(contextId !== undefined ? { contextId } : {}),
      })) as {
        result?: {
          value?: ClickDispatchResult & { error?: string; cx: number; cy: number };
        };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (clickResult.exceptionDetails) {
        throw new Error(
          clickResult.exceptionDetails.exception?.description ??
            clickResult.exceptionDetails.text ??
            'page_click evaluation failed',
        );
      }
      const value = clickResult.result?.value;
      if (!value) {
        throw new Error(`page_click: evaluation returned no result for selector "${selector}".`);
      }
      if (value.error) throw new PageActionPreconditionError(value.error);
      emitClickIndicator(tabId, value.cx, value.cy, 'js').catch(() => {});
      return {
        ...value,
        dispatchMode: 'dom',
        ...(frame
          ? { frame: { frameId: frame.frameId, frameUrl: frame.url, context: frame.context } }
          : {}),
      };
    }

    const enriched = await enrichFrameDispatchTarget(
      tabId,
      {
        clicked: true,
        tag: coord.tag,
        text: coord.text,
        sourceTarget: coord.sourceTarget,
        strategy: coord.strategy,
        distance: coord.distance,
        actionableAncestorCandidates: coord.actionableAncestorCandidates,
        dispatchMode: 'trusted-input',
        pointerType,
      },
      frame,
      { x: coord.x, y: coord.y },
    );
    try {
      await dispatchClickAtPoint(
        { tabId },
        enriched.outerPoint.x,
        enriched.outerPoint.y,
        pointerType,
      );
    } catch (error) {
      throw withPageActionDispatchAttempt(
        error,
        describePageClickDispatchAttempt(enriched.dispatchTarget),
      );
    }
    emitClickIndicator(tabId, enriched.outerPoint.x, enriched.outerPoint.y, 'cdp').catch(() => {});
    return enriched.dispatchTarget;
  } finally {
    await debuggerLease.release();
  }
}

/** 统一的"按 backendNodeId 派发真实点击事件"路径——给 @ref 和 text 分支共用。 */
async function clickAtBackendNode(
  tabId: number,
  backendNodeId: number,
  pointerType: PageClickPointerType,
  attachedTarget?: chrome.debugger.Debuggee,
  frame?: ResolvedClickFrame,
  expectedText?: string,
  useStateAwareControlPath = false,
): Promise<ClickDispatchResult> {
  const debugTarget = attachedTarget ?? frameDebuggee(tabId, frame);
  const debuggerLease = attachedTarget
    ? undefined
    : await acquireDebuggerLease(tabId, { consumer: 'page-click' });
  try {
    const resolveResult = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId,
    })) as { object: { objectId: string } };

    const coordResult = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId: resolveResult.object.objectId,
      functionDeclaration: GET_CLICK_COORDS_FROM_NODE_SRC,
      arguments: [{ value: expectedText }],
      returnByValue: true,
    })) as {
      result: {
        value: {
          x: number;
          y: number;
          tag: string;
          text: string;
          inputType?: string;
          strategy: PageClickTargetStrategy;
          distance: number;
          sourceTarget: { tag: string; text: string };
          actionableAncestorCandidates?: PageClickAncestorCandidate[];
          error?: string;
        } | null;
      };
    };

    if (coordResult.result.value === null) {
      throw new PageActionPreconditionError(
        `Cannot resolve clickable element for backendNodeId ${backendNodeId}`,
      );
    }
    if (!coordResult.result.value) {
      throw new Error('page_click coordinate evaluation returned no result');
    }
    if (coordResult.result.value.error) {
      throw new PageActionPreconditionError(coordResult.result.value.error);
    }

    if (useStateAwareControlPath && isStateAwareClickTarget(coordResult.result.value)) {
      return await clickByRefViaJS(
        tabId,
        '@target',
        backendNodeId,
        debugTarget,
        frame,
        expectedText,
      );
    }

    const { x, y, tag, text, strategy, distance, sourceTarget, actionableAncestorCandidates } =
      coordResult.result.value;
    const enriched = await enrichFrameDispatchTarget(
      tabId,
      {
        clicked: true,
        tag,
        text,
        sourceTarget,
        strategy,
        distance,
        actionableAncestorCandidates,
        dispatchMode: 'trusted-input',
        pointerType,
      },
      frame,
      { x, y },
    );
    try {
      await dispatchClickAtPoint(
        { tabId },
        enriched.outerPoint.x,
        enriched.outerPoint.y,
        pointerType,
      );
    } catch (error) {
      throw withPageActionDispatchAttempt(
        error,
        describePageClickDispatchAttempt(enriched.dispatchTarget),
      );
    }
    emitClickIndicator(tabId, enriched.outerPoint.x, enriched.outerPoint.y, 'cdp').catch(() => {});
    return enriched.dispatchTarget;
  } finally {
    await debuggerLease?.release();
  }
}

async function clickByPoint(
  tabId: number,
  point: { x: number; y: number },
  clickMode: Exclude<PageClickMode, 'auto'>,
  coordinateSpace: 'outer-viewport' | 'active-frame',
  frame?: ResolvedClickFrame,
): Promise<PageClickResult> {
  if (coordinateSpace === 'active-frame' && !frame) {
    coordinateSpace = 'outer-viewport';
  }
  const targetFrame = coordinateSpace === 'active-frame' || frame?.phoneFrame ? frame : undefined;
  const originalPoint = point;
  if (frame?.phoneFrame && coordinateSpace === 'outer-viewport') {
    const transform = await getFrameViewportTransform(tabId, frame.frameId);
    point = {
      x: (point.x - transform.offset.x) / transform.scale.x,
      y: (point.y - transform.offset.y) / transform.scale.y,
    };
  }
  if (clickMode === 'dom') {
    const expression = `(() => {
      const element = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
      if (!element) return null;
      return (${CLICK_ELEMENT_VIA_JS_SRC}).call(element);
    })()`;
    const value = await evaluateInClickFrame<
      | (ClickDispatchResult & {
          cx: number;
          cy: number;
          error?: string;
        })
      | null
    >(tabId, expression, targetFrame);
    if (value === null) {
      throw new PageActionPreconditionError(
        `page_click: no element found at point (${point.x}, ${point.y}) in the current viewport.`,
      );
    }
    if (!value) throw new Error('page_click evaluation returned no result');
    if (value.error) throw new PageActionPreconditionError(value.error);
    emitClickIndicator(tabId, value.cx, value.cy, 'js').catch(() => {});
    const enriched = await enrichFrameDispatchTarget(
      tabId,
      { ...value, dispatchMode: 'dom' },
      targetFrame,
      point,
    );
    return createPageClickResult({ kind: 'point', point: originalPoint }, enriched.dispatchTarget);
  }

  const debugTarget = { tabId };
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-click' });
  try {
    const enriched = await enrichFrameDispatchTarget(
      tabId,
      {
        clicked: true,
        tag: '',
        text: '',
        dispatchMode: 'trusted-input',
        pointerType: clickMode,
      },
      targetFrame,
      point,
    );
    try {
      await dispatchClickAtPoint(
        debugTarget,
        enriched.outerPoint.x,
        enriched.outerPoint.y,
        clickMode,
      );
    } catch (error) {
      throw withPageActionDispatchAttempt(
        error,
        describePageClickDispatchAttempt(enriched.dispatchTarget),
      );
    }
    return createPageClickResult({ kind: 'point', point: originalPoint }, enriched.dispatchTarget);
  } finally {
    await debuggerLease.release();
  }
}

async function clickByText(
  tabId: number,
  text: string,
  role: string | undefined,
  exact: boolean | undefined,
  scope: string | undefined,
  clickMode: Exclude<PageClickMode, 'auto'>,
  stateAwareControls: boolean,
  frame?: ResolvedClickFrame,
): Promise<PageClickResult> {
  const debugTarget = frameDebuggee(tabId, frame);
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-click' });
  try {
    const scopeBackendNodeId = scope
      ? await resolveScopeBackendNodeId(tabId, debugTarget, scope, frame)
      : undefined;
    const axResult = (await sendPageCommand(
      debugTarget,
      scopeBackendNodeId === undefined
        ? 'Accessibility.getFullAXTree'
        : 'Accessibility.queryAXTree',
      scopeBackendNodeId === undefined
        ? frame
          ? { frameId: frame.frameId }
          : {}
        : { backendNodeId: scopeBackendNodeId },
    )) as { nodes: AXTextMatchNode[] };

    const { hits } = matchAXNodesByText(axResult.nodes, { text, role, exact });

    if (hits.length === 0) {
      const exactSuffix = exact === false ? ' (substring match)' : '';
      const roleSuffix = role ? ` with role "${role}"` : '';
      throw new PageActionPreconditionError(
        `page_click: text "${text}"${roleSuffix}${exactSuffix}${scope ? ` in scope "${scope}"` : ''} not found. ` +
          `Run page_snapshot to inspect the page, or try exact: false for substring matching.`,
      );
    }

    if (hits.length > 1) {
      const candidates = formatAXTextMatchCandidates(hits);
      throw new PageActionPreconditionError(
        `page_click: text "${text}"${scope ? ` in scope "${scope}"` : ''} matched ${hits.length} elements. ` +
          `Refine with "role" or "exact: true", or run page_snapshot and use an "@eN" ref:\n${candidates}`,
      );
    }

    const hit = hits[0];
    const backendNodeId = hit.backendNodeId;
    const dispatchTarget: PageClickDispatchTarget =
      clickMode === 'dom' || (stateAwareControls && /^(checkbox|radio)$/i.test(hit.role))
        ? await clickByRefViaJS(tabId, '@text', backendNodeId, debugTarget, frame, hit.name)
        : await clickAtBackendNode(
            tabId,
            backendNodeId,
            clickMode,
            debugTarget,
            frame,
            hit.name,
            stateAwareControls,
          );
    return createPageClickResult(
      {
        kind: 'text',
        name: hit.name,
        role: hit.role || undefined,
        ...(scope ? { scope } : {}),
      },
      dispatchTarget,
    );
  } finally {
    await debuggerLease.release();
  }
}

async function resolveScopeBackendNodeId(
  tabId: number,
  debugTarget: chrome.debugger.Debuggee,
  scope: string,
  frame?: ResolvedClickFrame,
): Promise<number> {
  checkPageActionPrecondition(() => validatePageElementSelector(scope, 'page_click scope'));
  if (scope.startsWith('@e')) {
    const entry = resolveRef(tabId, scope);
    if (!entry)
      throw new PageActionPreconditionError(
        `Ref ${scope} not found. Run page_snapshot first to get fresh refs.`,
      );
    if (frame && (entry.frameId || frame.phoneFrame) && frame.frameId !== entry.frameId) {
      throw new PageActionPreconditionError(
        `page_click: scope ${scope} belongs to frame ${entry.frameId}, not ${frame.frameId}.`,
      );
    }
    return entry.backendNodeId;
  }

  const contextId = frame
    ? await getFrameExecutionContextId(frameDebuggee(tabId, frame), frame.frameId)
    : undefined;
  const evaluated = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(scope)})`,
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
    throw new PageActionPreconditionError(`page_click: invalid scope "${scope}": ${message}`);
  }
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === 'null') {
    throw new PageActionPreconditionError(`page_click: scope not found: ${scope}`);
  }
  try {
    const described = (await sendPageCommand(debugTarget, 'DOM.describeNode', {
      objectId,
    })) as { node?: { backendNodeId?: number } };
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) {
      throw new PageActionPreconditionError(`page_click: cannot resolve scope: ${scope}`);
    }
    return backendNodeId;
  } finally {
    await sendPageCommand(debugTarget, 'Runtime.releaseObject', { objectId })
      .catch(() => {});
  }
}

/** 把“按 viewport 坐标派发点击事件”封装一下，三个分支共用。 */
async function dispatchClickAtPoint(
  debugTarget: chrome.debugger.Debuggee,
  x: number,
  y: number,
  pointerType: PageClickPointerType,
): Promise<void> {
  const point = await toCdpInputPoint(debugTarget, x, y);

  if (pointerType === 'touch') {
    await dispatchPairedPageInputCommands(
      () =>
        sendCdpInputCommand(debugTarget, 'Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point],
        }),
      () =>
        sendCdpInputCommand(debugTarget, 'Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        }),
    );
    return;
  }

  await sendCdpInputCommand(debugTarget, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  });
  await dispatchPairedPageInputCommands(
    () =>
      sendCdpInputCommand(debugTarget, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      }),
    () =>
      sendCdpInputCommand(debugTarget, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      }),
  );
}

async function dispatchDragBetweenPoints(
  debugTarget: chrome.debugger.Debuggee,
  from: PageDragPoint,
  to: PageDragPoint,
  pointerType: PageDragPointerType,
  durationMs: number,
): Promise<{ steps: number }> {
  const [start, end] = await Promise.all([
    toCdpInputPoint(debugTarget, from.x, from.y),
    toCdpInputPoint(debugTarget, to.x, to.y),
  ]);
  const path = buildPageDragPath(start, end, durationMs);
  const waitForNextPoint = async (): Promise<void> => {
    if (path.intervalMs <= 0) return;
    await new Promise(resolve => setTimeout(resolve, path.intervalMs));
  };

  if (pointerType === 'touch') {
    await sendCdpInputCommand(debugTarget, 'Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    let primaryError: unknown;
    try {
      for (const point of path.points) {
        await waitForNextPoint();
        await sendCdpInputCommand(debugTarget, 'Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point],
        });
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await sendCdpInputCommand(debugTarget, 'Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      }).catch(error => {
        if (primaryError === undefined) throw error;
      });
    }
    return { steps: path.points.length };
  }

  await sendCdpInputCommand(debugTarget, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: start.x,
    y: start.y,
  });
  await sendCdpInputCommand(debugTarget, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  let primaryError: unknown;
  let lastPoint = start;
  try {
    for (const point of path.points) {
      await waitForNextPoint();
      await sendCdpInputCommand(debugTarget, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
      }, () => { lastPoint = point; });
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await sendCdpInputCommand(debugTarget, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: lastPoint.x,
      y: lastPoint.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    }).catch(error => {
      if (primaryError === undefined) throw error;
    });
  }
  return { steps: path.points.length };
}

async function sendCdpInputCommand(
  debugTarget: chrome.debugger.Debuggee,
  method: 'Input.dispatchTouchEvent' | 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent',
  params: Record<string, unknown>,
  onDispatch?: () => void,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs =
    method === 'Input.dispatchKeyEvent' ? PAGE_PRESS_INPUT_TIMEOUT_MS : PAGE_CLICK_INPUT_TIMEOUT_MS;
  const eventType = typeof params.type === 'string' ? ` (${params.type})` : '';
  const targetHint =
    method === 'Input.dispatchTouchEvent'
      ? 'Touch input can stall on a hidden, background, or headless target; use clickMode "auto" or make the target visible. '
      : '';

  try {
    await Promise.race([
      sendPageCommand(debugTarget, method, params, onDispatch),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const message =
            `CDP ${method}${eventType} timed out after ${timeoutMs}ms. ` +
            targetHint +
            'The page may already have changed; verify its current state before retrying.';
          const inputMayHaveBeenDelivered =
            method === 'Input.dispatchKeyEvent' ||
            /^(mousePressed|mouseReleased|touchStart|touchEnd)$/.test(String(params.type ?? ''));
          reject(
            inputMayHaveBeenDelivered
              ? new PageActionDispatchUncertainError(message, {
                  attempt: {
                    inputCommand: {
                      method,
                      type: String(params.type ?? ''),
                    },
                  },
                })
              : new Error(message),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function toCdpInputPoint(
  debugTarget: chrome.debugger.Debuggee,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  void debugTarget;
  // DOM client rects and CDP Input commands both use main-frame CSS viewport pixels. Layout and
  // visual viewport widths may legitimately differ under zoom or emulation and must not rescale input.
  return Promise.resolve({ x, y });
}

// ─── page_drag ────────────────────────────────────────────────────────────────

async function scrollDragSourceIntoView(
  tabId: number,
  debugTarget: chrome.debugger.Debuggee,
  endpoint: PageDragEndpoint,
  frame?: ContainerFrameTarget,
  contextId?: number,
): Promise<void> {
  if (typeof endpoint !== 'string') return;
  validatePageElementSelector(endpoint, 'page_drag from');

  if (endpoint.startsWith('@e')) {
    const entry = resolveRef(tabId, endpoint);
    if (!entry)
      throw new Error(`Ref ${endpoint} not found. Run page_snapshot first to get fresh refs.`);
    if (frame && entry.frameId !== frame.frameId)
      throw new PageActionPreconditionError(`Ref ${endpoint} is outside the active preview frame.`);
    const resolved = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId: entry.backendNodeId,
    })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`page_drag: cannot resolve element for ${endpoint}`);
    await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return true;
      }`,
      returnByValue: true,
    });
    return;
  }

  const result = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
    ...(contextId !== undefined ? { contextId } : {}),
    expression: `(() => {
      const selector = ${JSON.stringify(endpoint)};
      let el;
      try { el = document.querySelector(selector); }
      catch (error) { return { error: 'Invalid selector "' + selector + '": ' + error.message }; }
      if (!el) return { error: 'Element not found: ' + selector };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return { scrolled: true };
    })()`,
    returnByValue: true,
  })) as { result?: { value?: { error?: string } } };
  const error = result.result?.value?.error;
  if (error) throw new Error(`page_drag: ${error}`);
}

function unwrapDragElementCoords(
  value: PageDragElementCoords | null | undefined,
  endpoint: string,
): PageDragElementCoords {
  if (!value) throw new Error(`page_drag: cannot resolve element coordinates for "${endpoint}"`);
  if (value.error) throw new Error(`page_drag: ${value.error}: "${endpoint}"`);
  return value;
}

async function resolveDragEndpoint(
  tabId: number,
  debugTarget: chrome.debugger.Debuggee,
  endpoint: PageDragEndpoint,
  frame?: ContainerFrameTarget,
  contextId?: number,
): Promise<PageDragResolvedEndpoint> {
  if (typeof endpoint !== 'string') {
    return { requested: endpoint, point: endpoint };
  }
  validatePageElementSelector(endpoint, 'page_drag endpoint');

  let coords: PageDragElementCoords;
  if (endpoint.startsWith('@e')) {
    const entry = resolveRef(tabId, endpoint);
    if (!entry)
      throw new Error(`Ref ${endpoint} not found. Run page_snapshot first to get fresh refs.`);
    if (frame && entry.frameId !== frame.frameId)
      throw new PageActionPreconditionError(`Ref ${endpoint} is outside the active preview frame.`);
    const resolved = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId: entry.backendNodeId,
    })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`page_drag: cannot resolve element for ${endpoint}`);
    const result = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: GET_DRAG_COORDS_FROM_NODE_SRC,
      returnByValue: true,
    })) as { result?: { value?: PageDragElementCoords | null } };
    coords = unwrapDragElementCoords(result.result?.value, endpoint);
  } else {
    const result = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
      ...(contextId !== undefined ? { contextId } : {}),
      expression: `(() => {
        const selector = ${JSON.stringify(endpoint)};
        let el;
        try { el = document.querySelector(selector); }
        catch (error) { return { error: 'Invalid selector "' + selector + '": ' + error.message }; }
        if (!el) return { error: 'Element not found: ' + selector };
        return (${GET_DRAG_COORDS_FROM_NODE_SRC}).call(el);
      })()`,
      returnByValue: true,
    })) as { result?: { value?: PageDragElementCoords | null } };
    coords = unwrapDragElementCoords(result.result?.value, endpoint);
  }

  return {
    requested: endpoint,
    point: { x: coords.x, y: coords.y },
    tag: coords.tag,
    text: coords.text,
  };
}

export async function handlePageDrag(
  data: PageDragParams,
  getActiveTabId: () => number | null,
): Promise<PageDragResultData> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  const input = checkPageActionPrecondition(() => resolvePageDragInput(data));
  const visibilityState =
    input.dragMode === 'auto'
      ? await evalInPage<DocumentVisibilityState>(tabId, 'document.visibilityState')
      : undefined;
  const touchEmulationEnabled =
    input.dragMode === 'auto' || input.dragMode === 'dom'
      ? await prefersTouchInput(tabId)
      : input.dragMode === 'touch';
  const policy = resolvePageDragDispatchPolicy(
    input.dragMode,
    visibilityState,
    touchEmulationEnabled,
  );
  const debugTarget = { tabId };
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-drag' });
  try {
    const container = await getContainerTopFrame(tabId);
    const frame = container?.phoneFrame ? container : undefined;
    const contentTarget = frameDebuggee(tabId, frame);
    const contextId = frame ? await getFrameExecutionContextId(contentTarget, frame.frameId) : undefined;
    await scrollDragSourceIntoView(tabId, contentTarget, input.from, frame, contextId);
    const from = await resolveDragEndpoint(tabId, contentTarget, input.from, frame, contextId);
    const to = await resolveDragEndpoint(tabId, contentTarget, input.to, frame, contextId);
    if (Math.hypot(to.point.x - from.point.x, to.point.y - from.point.y) < 1) {
      throw new Error('page_drag: resolved endpoints must be at least 1 viewport pixel apart');
    }

    if (policy.dispatchMode === 'dom') {
      if (frame) {
        const transform = await getFrameViewportTransform(tabId, frame.frameId);
        await projectFramePoint(tabId, transform, to.point, true);
      }
      const path = buildPageDragPath(from.point, to.point, input.durationMs);
      const result = (await sendPageCommand(contentTarget, 'Runtime.evaluate', {
        ...(contextId !== undefined ? { contextId } : {}),
        expression: buildPageDragDomExpression(from.point, path.points, policy.pointerType),
        returnByValue: true,
      })) as {
        result?: { value?: PageDragDomExecutionResult };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            'page_drag: DOM simulation failed',
        );
      }
      const { steps } = unwrapPageDragDomResult(result.result?.value);
      return {
        dragged: true,
        from,
        to,
        dispatchMode: 'dom',
        pointerType: policy.pointerType,
        durationMs: input.durationMs,
        steps,
        ...(policy.fallbackReason ? { fallbackReason: policy.fallbackReason } : {}),
      };
    }

    const transform = frame ? await getFrameViewportTransform(tabId, frame.frameId) : undefined;
    const start = transform ? await projectFramePoint(tabId, transform, from.point, true) : from.point;
    const end = transform ? await projectFramePoint(tabId, transform, to.point, true) : to.point;
    const { steps } = await dispatchDragBetweenPoints(
      debugTarget,
      start,
      end,
      policy.pointerType,
      input.durationMs,
    );
    return {
      dragged: true,
      from,
      to,
      dispatchMode: 'trusted-input',
      pointerType: policy.pointerType,
      durationMs: input.durationMs,
      steps,
    };
  } catch (error) {
    if (typeof input.from === 'string' && input.from.startsWith('@e')) deleteRef(tabId, input.from);
    if (typeof input.to === 'string' && input.to.startsWith('@e')) deleteRef(tabId, input.to);
    throw error;
  } finally {
    await debuggerLease.release();
  }
}

// ─── page_type ────────────────────────────────────────────────────────────────

export async function handlePageType(
  data: PageTypeParams,
  getActiveTabId: () => number | null,
): Promise<{ typed: boolean; tag: string }> {
  const { selector, text, clearFirst = true } = data;
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_type'));
  if (typeof text !== 'string') {
    throw new PageActionPreconditionError('"text" must be a string.');
  }

  // @ref selector — use CDP to resolve and type
  if (selector.startsWith('@e')) {
    return typeByRef(tabId, selector, text, clearFirst);
  }

  const expression = `(() => {
    const sel = ${JSON.stringify(selector)};
    let el;
    try { el = document.querySelector(sel); }
    catch (e) { return { typed: false, tag: '', error: 'Invalid CSS selector "' + sel + '": ' + e.message + '. ' + ${JSON.stringify(INVALID_NATIVE_SELECTOR_HINT)} }; }
    if (!el) return { typed: false, tag: '', error: 'Element not found: ' + sel };
    const fn = (${TYPE_INTO_ELEMENT_SRC});
    return fn(el, ${JSON.stringify(text)}, ${JSON.stringify(clearFirst)});
  })()`;

  const value = await evalInActivePage<{ typed: boolean; tag: string; error?: string }>(
    tabId,
    expression,
  );
  if (value.error) throw new PageActionPreconditionError(value.error);
  return value;
}

async function typeByRef(
  tabId: number,
  ref: string,
  text: string,
  clearFirst: boolean,
): Promise<{ typed: boolean; tag: string }> {
  const refEntry = resolveRef(tabId, ref);
  if (refEntry === undefined) {
    throw new PageActionPreconditionError(
      `Ref ${ref} not found. Run page_snapshot first to get fresh refs.`,
    );
  }

  const debugTarget = frameDebuggee(tabId, await resolvePageRefFrame(tabId, ref, refEntry));
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-type' });
  try {
    // Resolve backendNodeId to a RemoteObject (works across frames)
    const resolveResult = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendNodeId,
    })) as { object: { objectId: string } };

    const objectId = resolveResult.object.objectId;

    // 复用 typeIntoElement，把 this（DOM 元素）作为第一个参数传入。
    const result = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(inputValue, shouldClear) {
          const element = this.nodeType === 1 ? this : this.parentElement;
          return (${TYPE_INTO_ELEMENT_SRC})(element, inputValue, shouldClear);
        }`,
      arguments: [{ value: text }, { value: clearFirst }],
      returnByValue: true,
    })) as {
      result?: { value?: { typed: boolean; tag: string; error?: string } };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    const value = result.result?.value;
    if (!value) {
      throw new Error(result.exceptionDetails?.exception?.description ??
        result.exceptionDetails?.text ?? 'page_type evaluation returned no result');
    }
    if (value.error) throw new PageActionPreconditionError(value.error);
    return value;
  } catch (error) {
    deleteRef(tabId, ref);
    throw error;
  } finally {
    await debuggerLease.release();
  }
}

// ─── page_scroll ──────────────────────────────────────────────────────────────

export async function handlePageScroll(
  data: PageScrollParams,
  getActiveTabId: () => number | null,
): Promise<PageScrollResult> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  const input = checkPageActionPrecondition(() => resolvePageScrollInput(data));
  if (input.selector?.startsWith('@e')) {
    return scrollByRef(
      tabId,
      input.selector,
      input.direction,
      input.distance,
      input.containerPolicy,
    );
  }

  const value = await evalInActivePage<PageScrollExecutionResult>(
    tabId,
    buildPageScrollExpression(input),
  );
  return unwrapPageScrollResult(value, 'page_scroll evaluation returned no value');
}

async function scrollByRef(
  tabId: number,
  ref: string,
  direction: 'up' | 'down' | 'top' | 'bottom',
  distance: number,
  containerPolicy: 'self' | 'nearest',
): Promise<PageScrollResult> {
  const refEntry = resolveRef(tabId, ref);
  if (refEntry === undefined) {
    throw new PageActionPreconditionError(
      `Ref ${ref} not found. Run page_snapshot first to get fresh refs.`,
    );
  }

  const debugTarget = frameDebuggee(tabId, await resolvePageRefFrame(tabId, ref, refEntry));
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-scroll' });
  try {
    const resolveResult = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendNodeId,
    })) as { object: { objectId: string } };

    const result = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId: resolveResult.object.objectId,
      functionDeclaration: SCROLL_ELEMENT_IN_PAGE_SOURCE,
      arguments: [
        { value: direction },
        { value: distance },
        { value: ref },
        { value: containerPolicy },
      ],
      returnByValue: true,
    })) as {
      result: { value?: PageScrollExecutionResult };
    };

    return unwrapPageScrollResult(
      result.result.value,
      `Cannot resolve scroll container for ref ${ref}`,
    );
  } catch (error) {
    deleteRef(tabId, ref);
    throw error;
  } finally {
    await debuggerLease.release();
  }
}

// ─── page_inspect ─────────────────────────────────────────────────────────────

export async function handlePageInspect(
  data: PageInspectParams,
  getActiveTabId: () => number | null,
): Promise<PageInspectResult> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }
  const input = checkPageActionPrecondition(() => resolvePageInspectInput(data));
  if (input.selector === '$0') {
    throw new PageActionPreconditionError(
      'page_inspect selector "$0" requires the browser extension and an element selected in DevTools.',
    );
  }
  if (!input.selector?.startsWith('@e')) {
    const value = await evalInActivePage<PageInspectExecutionResult>(
      tabId,
      buildPageInspectExpression(input),
    );
    return unwrapPageInspectResult(value, 'page_inspect evaluation returned no value');
  }

  const ref = input.selector;
  const refEntry = resolveRef(tabId, ref);
  if (!refEntry) {
    throw new PageActionPreconditionError(
      `Ref ${ref} not found. Run page_snapshot first to get fresh refs.`,
    );
  }

  const debugTarget = frameDebuggee(tabId, await resolvePageRefFrame(tabId, ref, refEntry));
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-inspect' });
  try {
    const resolved = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendNodeId,
    })) as { object: { objectId: string } };
    const result = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: `function(filter, styles, maxResults, invalidSelectorHint, includeOuterHTML) {
        return (${INSPECT_ELEMENTS_IN_PAGE_SOURCE}).call(
          this,
          undefined,
          filter,
          styles,
          maxResults,
          invalidSelectorHint,
          includeOuterHTML
        );
      }`,
      arguments: [
        { value: input.filter },
        { value: input.styles },
        { value: input.maxResults },
        { value: INVALID_NATIVE_SELECTOR_HINT },
        { value: input.includeOuterHTML },
      ],
      returnByValue: true,
    })) as { result: { value?: PageInspectExecutionResult } };
    return unwrapPageInspectResult(result.result.value, `Cannot inspect element for ref ${ref}`);
  } catch (error) {
    deleteRef(tabId, ref);
    throw error;
  } finally {
    await debuggerLease.release();
  }
}

// ─── page_hover ────────────────────────────────────────────────────────────────

export async function handlePageHover(
  data: PageHoverParams,
  getActiveTabId: () => number | null,
): Promise<{ hovered: boolean; tag: string; text: string }> {
  const { selector } = data;
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_hover'));

  // @ref selector — resolve to element coordinates and dispatch hover event
  if (selector.startsWith('@e')) {
    return hoverByRef(tabId, selector);
  }

  return hoverBySelector(tabId, selector);
}

async function hoverByRef(
  tabId: number,
  ref: string,
): Promise<{ hovered: boolean; tag: string; text: string }> {
  const refEntry = resolveRef(tabId, ref);
  if (refEntry === undefined) {
    throw new PageActionPreconditionError(
      `Ref ${ref} not found. Run page_snapshot first to get fresh refs.`,
    );
  }

  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-hover' });
  try {
    const frame = await resolvePageRefFrame(tabId, ref, refEntry);
    const debugTarget = frameDebuggee(tabId, frame);
    // Resolve backendNodeId to a RemoteObject.
    // CDP DOM.resolveNode with backendNodeId works across frames automatically.
    const resolveResult = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
      backendNodeId: refEntry.backendNodeId,
    })) as { object: { objectId: string } };

    const objectId = resolveResult.object.objectId;

    // Get element coordinates and info via JS
    const coordResult = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
          var el = this.nodeType === 3 ? this.parentElement : this;
          if (!el) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const rect = el.getBoundingClientRect();
          return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            text: (el.textContent || '').trim().slice(0, 100),
          };
        }`,
      returnByValue: true,
    })) as { result: { value: { x: number; y: number; tag: string; text: string } | null } };

    if (coordResult.result.value === null) {
      throw new PageActionPreconditionError(`Cannot resolve element for ref ${ref}`);
    }
    if (!coordResult.result.value) {
      throw new Error('page_hover coordinate evaluation returned no result');
    }

    const { x, y, tag, text } = coordResult.result.value;
    const point = frame?.phoneFrame
      ? await projectFramePoint(tabId, await getFrameViewportTransform(tabId, frame.frameId), { x, y }, true)
      : { x, y };

    // Dispatch mouseMoved event via CDP to trigger hover effects
    await sendPageCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
    });

    return { hovered: true, tag, text };
  } catch (error) {
    deleteRef(tabId, ref);
    throw error;
  } finally {
    await debuggerLease.release();
  }
}

async function hoverBySelector(
  tabId: number,
  selector: string,
): Promise<{ hovered: boolean; tag: string; text: string }> {
  const expression = `(() => {
    const sel = ${JSON.stringify(selector)};
    let el;
    try { el = document.querySelector(sel); }
    catch (e) { return { error: 'Invalid CSS selector "' + sel + '": ' + e.message + '. ' + ${JSON.stringify(INVALID_NATIVE_SELECTOR_HINT)} }; }
    if (!el) return { error: 'Element not found: ' + sel };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 100) };
  })()`;

  const container = await getContainerTopFrame(tabId);
  const coord = await evaluateInClickFrame<{
    x: number;
    y: number;
    tag: string;
    text: string;
    error?: string;
  }>(tabId, expression, container);
  if (coord.error) throw new PageActionPreconditionError(coord.error);

  // Dispatch mouseMoved event via CDP to trigger hover effects
  const debugTarget = { tabId };
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-hover' });
  try {
    const point = container?.phoneFrame
      ? await projectFramePoint(tabId, await getFrameViewportTransform(tabId, container.frameId), coord, true)
      : { x: coord.x, y: coord.y };
    await sendPageCommand(debugTarget, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
    });
  } finally {
    await debuggerLease.release();
  }

  return { hovered: true, tag: coord.tag, text: coord.text };
}

// ─── page_eval ────────────────────────────────────────────────────────────────

export async function handlePageEval(
  data: PageEvalParams,
  getActiveTabId: () => number | null,
): Promise<{ result: any }> {
  const { frameId, awaitPromise = true } = data;
  let expression: string;
  try {
    expression = resolvePageEvalExpression(data);
  } catch (error) {
    throw new PageActionPreconditionError(error instanceof Error ? error.message : String(error));
  }
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  // Use CDP Runtime.evaluate to bypass page CSP restrictions
  const debuggerLease = await acquireDebuggerLease(tabId, {
    consumer: 'page-eval',
    domains: ['Runtime'],
  });
  try {
    // If frameId is specified, resolve its execution context.
    // When no frameId is given, auto-resolve to container top layer if present.
    let contextId: number | undefined;
    const container = await getContainerTopFrame(tabId);
    const requestedFrame = frameId && container && frameId !== container.frameId
      ? await getFrameTarget(tabId, frameId, container.phoneFrame ? container.frameId : undefined)
      : container;
    if (container?.phoneFrame && frameId && !requestedFrame) {
      throw new PageActionPreconditionError('page_eval: frameId is outside the active preview page.');
    }
    const debugTarget = frameDebuggee(tabId, requestedFrame);
    const effectiveFrameId = frameId ?? container?.frameId;
    if (effectiveFrameId) {
      contextId = await getFrameExecutionContextId(debugTarget, effectiveFrameId);
    }

    const evaluate = async (targetContextId: number | undefined) =>
      (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
        ...(targetContextId !== undefined ? { contextId: targetContextId } : {}),
      })) as {
        result: { type: string; value?: any; description?: string };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      };

    let evalResult: Awaited<ReturnType<typeof evaluate>>;
    try {
      evalResult = await evaluate(contextId);
    } catch (error) {
      if (!effectiveFrameId || !/Cannot find context with specified id/i.test(String(error))) {
        throw error;
      }
      contextId = await getFrameExecutionContextId(debugTarget, effectiveFrameId, true);
      evalResult = await evaluate(contextId);
    }

    const typedEvalResult = evalResult as {
      result: { type: string; value?: any; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };

    if (typedEvalResult.exceptionDetails) {
      const errorMessage =
        typedEvalResult.exceptionDetails.exception?.description ||
        typedEvalResult.exceptionDetails.text;
      throw new Error(`Eval failed: ${errorMessage}`);
    }

    return {
      result: typedEvalResult.result.value ?? typedEvalResult.result.description ?? null,
    };
  } finally {
    await debuggerLease.release();
  }
}

/**
 * Resolve a CDP frameId to its JavaScript execution context ID.
 * This is needed for Runtime.evaluate to target a specific iframe.
 */
async function getFrameExecutionContextId(
  debugTarget: { tabId: number; sessionId?: string },
  frameId: string,
  refresh = false,
): Promise<number> {
  return debugTarget.sessionId
    ? resolveDebuggerFrameExecutionContextId(debugTarget.tabId, frameId, refresh, debugTarget.sessionId)
    : resolveDebuggerFrameExecutionContextId(debugTarget.tabId, frameId, refresh);
}

// ─── page_press ───────────────────────────────────────────────────────────────

export async function handlePagePress(
  data: PagePressParams,
  getActiveTabId: () => number | null,
): Promise<PagePressResultData> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }
  const input = checkPageActionPrecondition(() => resolvePagePressInput(data));
  const visibilityState =
    input.pressMode === 'auto'
      ? await evalInActivePage<DocumentVisibilityState>(tabId, 'document.visibilityState')
      : undefined;
  const policy = resolvePagePressDispatchPolicy(input.pressMode, visibilityState);

  if (policy.dispatchMode === 'dom') {
    const value = await evalInActivePage<ReturnType<typeof unwrapPagePressDomResult>>(
      tabId,
      buildPagePressDomExpression(input),
    );
    const result = unwrapPagePressDomResult(value);
    return {
      ...result,
      key: input.key,
      dispatchMode: 'dom',
      ...(policy.fallbackReason ? { fallbackReason: policy.fallbackReason } : {}),
    };
  }

  const debugTarget = { tabId };
  const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-press' });
  try {
    const container = await getContainerTopFrame(tabId);
    if (container?.phoneFrame) {
      const focused = await evaluateInClickFrame<boolean>(tabId,
        'document.hasFocus() || (window.focus(), document.hasFocus())',
        container);
      if (!focused) throw new PageActionPreconditionError('Focus the device preview page before sending keyboard input.');
    }
    const baseParams = {
      key: input.descriptor.key,
      code: input.descriptor.code,
      windowsVirtualKeyCode: input.descriptor.keyCode,
      nativeVirtualKeyCode: input.descriptor.keyCode,
      modifiers: input.modifierFlags,
    };

    await dispatchPairedPageInputCommands(
      () =>
        sendCdpInputCommand(debugTarget, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          ...baseParams,
          ...(input.descriptor.text ? { text: input.descriptor.text } : {}),
        }),
      () =>
        sendCdpInputCommand(debugTarget, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...baseParams,
        }),
    );

    return { pressed: true, key: input.key, dispatchMode: 'trusted-input' };
  } finally {
    await debuggerLease.release();
  }
}

// ─── page_wait ────────────────────────────────────────────────────────────────

export async function handlePageWait(
  data: PageWaitParams,
  getActiveTabId: () => number | null,
): Promise<{ success: true; waited: true; elapsed: number; mode: string; value?: any }> {
  const options = resolvePageWaitInput(data);
  const tabId = data.tabId ?? getActiveTabId();
  const startedAt = Date.now();

  if (options.mode === 'time') {
    await new Promise(resolve => setTimeout(resolve, options.time));
    return { success: true, waited: true, elapsed: options.time!, mode: options.mode };
  }

  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  const expression = buildPageWaitExpression(options);
  while (Date.now() - startedAt < options.timeout) {
    const value = await evalInActivePage<unknown>(tabId, expression);
    const evaluationError = readPageWaitEvaluationError(value);
    if (evaluationError) throw new PageActionPreconditionError(evaluationError);
    if (value) {
      return {
        success: true,
        waited: true,
        elapsed: Date.now() - startedAt,
        mode: options.mode,
        value,
      };
    }
    await new Promise(resolve => setTimeout(resolve, options.interval));
  }

  const target = options.mode === 'selector'
    ? `selector ${JSON.stringify(options.selector)} did not reach state ${JSON.stringify(options.state)}`
    : options.mode === 'text'
      ? `text ${JSON.stringify(options.text)} was not found`
      : 'condition was not met';
  throw new Error(`page_wait ${target} after ${options.timeout}ms.`);
}

// ─── page_upload ──────────────────────────────────────────────────────────────

export async function handlePageUpload(
  data: PageUploadParams,
  getActiveTabId: () => number | null,
): Promise<{ uploaded: boolean; fileCount: number; tag: string }> {
  const { selector, filePaths } = data;
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_upload'));
  if (
    !Array.isArray(filePaths) ||
    filePaths.length === 0 ||
    filePaths.some(filePath => typeof filePath !== 'string' || filePath.length === 0)
  ) {
    throw new PageActionPreconditionError(
      'Invalid filePaths: must be a non-empty array of file path strings',
    );
  }

  const isRef = selector.startsWith('@e');
  const refEntry = isRef ? resolveRef(tabId, selector) : undefined;
  if (isRef && !refEntry) {
    throw new PageActionPreconditionError(`Ref ${selector} not found. Run page_snapshot first to get fresh refs.`);
  }
  const frame = refEntry
    ? await resolvePageRefFrame(tabId, selector, refEntry)
    : await getContainerTopFrame(tabId);
  const debugTarget = frameDebuggee(tabId, frame);
  const debuggerLease = await acquireDebuggerLease(tabId, {
    consumer: 'page-upload',
    domains: frame && !refEntry ? ['Runtime'] : [],
  });
  let objectId: string | undefined;

  try {
    let backendNodeId = refEntry?.backendNodeId;
    if (!refEntry && frame) {
      const contextId = await getFrameExecutionContextId(debugTarget, frame.frameId);
      const evaluated = (await sendPageCommand(debugTarget, 'Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId,
        returnByValue: false,
      })) as { result?: { objectId?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
      if (evaluated.exceptionDetails) {
        throw new PageActionPreconditionError(
          evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? 'Invalid selector',
        );
      }
      objectId = evaluated.result?.objectId;
      if (!objectId) throw new PageActionPreconditionError(`Element not found: ${selector}`);
    } else if (!refEntry) {
      // CSS selector — find the element via DOM.querySelector
      const docResult = (await sendPageCommand(debugTarget, 'DOM.getDocument', {
        depth: 0,
      })) as { root: { nodeId: number } };

      const queryResult = (await sendPageCommand(debugTarget, 'DOM.querySelector', {
        nodeId: docResult.root.nodeId,
        selector,
      })) as { nodeId: number };

      if (!queryResult.nodeId) {
        throw new PageActionPreconditionError(`Element not found: ${selector}`);
      }

      // Get backendNodeId from the DOM nodeId
      const descResult = (await sendPageCommand(debugTarget, 'DOM.describeNode', {
        nodeId: queryResult.nodeId,
      })) as { node: { backendNodeId: number; nodeName: string } };

      backendNodeId = descResult.node.backendNodeId;
    }

    // Get element tag name for response
    if (!objectId) {
      const resolved = (await sendPageCommand(debugTarget, 'DOM.resolveNode', {
        backendNodeId,
      })) as { object: { objectId: string } };
      objectId = resolved.object.objectId;
    }

    const tagResult = (await sendPageCommand(debugTarget, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
          return this.tagName ? this.tagName.toLowerCase() : '';
        }`,
      returnByValue: true,
    })) as { result: { value: string } };

    const tag = tagResult.result.value;

    if (tag !== 'input') {
      throw new PageActionPreconditionError(
        `Element <${tag}> is not a file input. selector must point to an <input type="file"> element.`,
      );
    }

    // CDP writes files directly to the input, including hidden inputs behind upload controls.
    await sendPageCommand(debugTarget, 'DOM.setFileInputFiles', {
      files: filePaths,
      ...(backendNodeId !== undefined ? { backendNodeId } : { objectId }),
    });

    return { uploaded: true, fileCount: filePaths.length, tag };
  } catch (error) {
    if (isRef) deleteRef(tabId, selector);
    throw error;
  } finally {
    if (objectId) await sendPageCommand(debugTarget, 'Runtime.releaseObject', { objectId }).catch(() => {});
    await debuggerLease.release();
  }
}
