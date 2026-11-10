import { sendCdpPageCommand } from './page-dialogs.js';
/**
 * CDP page interaction handlers.
 *
 * Covers: click, type, scroll, eval, press, wait, navigate, upload, device emulation.
 */

import {
  PageActionDispatchUncertainError,
  PageActionPreconditionError,
  checkPageActionPrecondition,
  matchAXNodesByText,
  formatAXTextMatchCandidates,
  resolveEmulationConfig,
  buildEnableEmulationCommands,
  buildDisableEmulationCommands,
  createPageClickResult,
  isStateAwareClickTarget,
  describePageClickDispatchAttempt,
  withPageActionDispatchAttempt,
  PAGE_CLICK_HIDDEN_TOUCH_ERROR,
  resolvePageClickDispatchPolicy,
  resolvePageNavigateInput,
  resolvePageWaitInput,
  buildPageWaitExpression,
  readPageWaitEvaluationError,
  buildPageScrollExpression,
  buildPageInspectExpression,
  buildPageDragDomExpression,
  getDragCoordsFromNode,
  buildPageDragPath,
  resolvePageDragDispatchPolicy,
  resolvePageDragInput,
  resolvePageScrollInput,
  resolvePageInspectInput,
  SCROLL_ELEMENT_IN_PAGE_SOURCE,
  INSPECT_ELEMENTS_IN_PAGE_SOURCE,
  unwrapPageScrollResult,
  unwrapPageInspectResult,
  unwrapPageDragDomResult,
  buildPagePressDomExpression,
  PAGE_PRESS_INPUT_TIMEOUT_MS,
  resolvePagePressDispatchPolicy,
  resolvePagePressInput,
  unwrapPagePressDomResult,
  validatePageElementSelector,
  INVALID_NATIVE_SELECTOR_HINT,
  type AXTextMatchNode,
  type PageClickDispatchTarget,
  type PageClickParams,
  type PageClickMode,
  type PageClickPointerType,
  type PageClickRequestedTarget,
  type PageDragElementCoords,
  type PageDragDomExecutionResult,
  type PageDragEndpoint,
  type PageDragParams,
  type PageDragResolvedEndpoint,
  type PageDragResultData,
  type PageEvalParams,
  resolvePageEvalExpression,
  type PageUserScriptParams,
  validatePageUserScriptParams,
  type PageHoverParams,
  type PageInspectExecutionResult,
  type PageInspectParams,
  type PageInspectResult,
  type PageNavigateParams,
  type PagePressParams,
  type PageScrollParams,
  type PageScrollExecutionResult,
  type PageTypeParams,
  type PageUploadParams,
  type PageWaitParams,
  type SetDeviceEmulationParams,
} from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import {
  dispatchCdpClick,
  dispatchCdpDrag,
  resolveBackendNodeObjectId,
  waitForPageLoad,
  TYPE_INTO_ELEMENT_SRC,
  CLICK_ELEMENT_VIA_JS_SRC,
  GET_CLICK_COORDS_FROM_NODE_SRC,
} from './cdp-utils.js';
import { registerActions } from './action-registry.js';
import {
  isCdpAppProfileActive,
  updateCdpAppProfileDeviceEmulation,
  waitForCdpAppProfileLoad,
} from './app-profile-handlers.js';
import {
  applyCdpDeviceShell,
  canLoadCdpDeviceShell,
  clearCdpDeviceShell,
  getCdpDeviceShellInputOffset,
  isCdpDeviceShellActive,
  sendCdpDeviceShellPageCommand,
  setCdpDeviceShellChildEnvironmentManagedByApp,
  waitForCdpDeviceShellLoad,
} from './device-shell.js';
import { clearPageRefsForNavigation, deletePageRef, resolvePageRef } from './page-refs.js';
import { evaluateCdpFrame } from './frame-evaluation.js';

const GET_DRAG_COORDS_FROM_NODE_SRC = getDragCoordsFromNode.toString();

// ─── Click helpers ────────────────────────────────────────────────────────────

function resolveSnapshotRef(
  session: PageSession,
  ref: string,
): { backendNodeId: number; role: string; name: string } {
  const entry = resolvePageRef(session, ref);
  if (!entry) {
    throw new PageActionPreconditionError(
      `Ref ${ref} not found. Run page_snapshot first to get fresh refs.`,
    );
  }
  return entry;
}

async function withSnapshotRef<T>(
  session: PageSession,
  ref: string,
  operation: (entry: { backendNodeId: number; role: string; name: string }) => Promise<T>,
): Promise<T> {
  const entry = resolveSnapshotRef(session, ref);
  try {
    return await operation(entry);
  } catch (error) {
    deletePageRef(session, ref);
    throw error;
  }
}

async function clickBySelectorJs(
  session: PageSession,
  selector: string,
): Promise<PageClickDispatchTarget> {
  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `(() => {
      const sel = ${JSON.stringify(selector)};
      const el = document.querySelector(sel);
      if (!el) return { clicked: false, error: 'Element not found: ' + sel };
      const fn = (${CLICK_ELEMENT_VIA_JS_SRC});
      const r = fn.call(el);
      if (!r) return { clicked: false, error: 'Cannot resolve clickable element' };
      if (r.error) return { clicked: false, error: r.error };
      return {
        clicked: true,
        tag: r.tag,
        text: r.text,
        sourceTarget: r.sourceTarget,
        strategy: r.strategy,
        distance: r.distance,
        ...(r.actionableAncestorCandidates
          ? { actionableAncestorCandidates: r.actionableAncestorCandidates }
          : {}),
        ...(r.controlState ? { controlState: r.controlState } : {}),
        ...(r.selectionState ? { selectionState: r.selectionState } : {})
      };
    })()`,
    returnByValue: true,
  });

  const value = result.result?.value;
  if (!value) throw new Error('click evaluation returned no value');
  if (value.error) throw new PageActionPreconditionError(value.error);
  return { ...value, dispatchMode: 'dom' };
}

async function clickByBackendNodeJs(
  session: PageSession,
  backendNodeId: number,
  expectedText?: string,
): Promise<PageClickDispatchTarget> {
  const objectId = await resolveBackendNodeObjectId(session, backendNodeId);
  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: CLICK_ELEMENT_VIA_JS_SRC,
    arguments: [{ value: expectedText }],
    returnByValue: true,
  });

  const value = result.result?.value;
  if (value === null) {
    throw new PageActionPreconditionError('Cannot resolve clickable element');
  }
  if (!value) throw new Error('click evaluation returned no value');
  if (value.error) throw new PageActionPreconditionError(value.error);
  return {
    tag: value.tag,
    text: value.text,
    sourceTarget: value.sourceTarget,
    strategy: value.strategy,
    distance: value.distance,
    ...(value.actionableAncestorCandidates
      ? { actionableAncestorCandidates: value.actionableAncestorCandidates }
      : {}),
    dispatchMode: 'dom',
    ...(value.controlState ? { controlState: value.controlState } : {}),
    ...(value.selectionState ? { selectionState: value.selectionState } : {}),
  };
}

async function clickByPointJs(
  session: PageSession,
  point: { x: number; y: number },
): Promise<PageClickDispatchTarget> {
  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `(() => {
      const element = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
      if (!element) return null;
      return (${CLICK_ELEMENT_VIA_JS_SRC}).call(element);
    })()`,
    returnByValue: true,
  });

  const value = result.result?.value;
  if (value === null) {
    throw new PageActionPreconditionError(
      `page_click: no element found at point (${point.x}, ${point.y}) in the current viewport.`,
    );
  }
  if (!value) throw new Error('click evaluation returned no value');
  if (value.error) throw new PageActionPreconditionError(value.error);
  return {
    tag: value.tag,
    text: value.text,
    sourceTarget: value.sourceTarget,
    strategy: value.strategy,
    distance: value.distance,
    ...(value.actionableAncestorCandidates
      ? { actionableAncestorCandidates: value.actionableAncestorCandidates }
      : {}),
    dispatchMode: 'dom',
    ...(value.controlState ? { controlState: value.controlState } : {}),
    ...(value.selectionState ? { selectionState: value.selectionState } : {}),
  };
}

function isNativeToggleControl(role?: string, inputType?: string): boolean {
  return /^(checkbox|radio)$/i.test(role ?? '') || /^(checkbox|radio)$/i.test(inputType ?? '');
}

async function prefersTouchInput(session: PageSession): Promise<boolean> {
  if (session.emulation) return session.emulation.touch;

  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `navigator.maxTouchPoints > 0 && (
      Boolean(navigator.userAgentData && navigator.userAgentData.mobile) ||
      /Android|Mobi|iPhone|iPad|iPod/i.test(navigator.userAgent)
    )`,
    returnByValue: true,
  });
  return result.result?.value === true;
}

async function getElementCoordsBySelector(
  session: PageSession,
  selector: string,
): Promise<
  PageClickDispatchTarget & {
    x: number;
    y: number;
    inputType?: string;
  }
> {
  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'Element not found: ' + ${JSON.stringify(selector)} };
      const fn = (${GET_CLICK_COORDS_FROM_NODE_SRC});
      const r = fn.call(el);
      if (!r) return { error: 'Cannot resolve element coordinates' };
      return r;
    })()`,
    returnByValue: true,
  });

  const value = result.result?.value;
  if (!value) throw new Error('coord evaluation returned no value');
  if (value.error) throw new PageActionPreconditionError(value.error);
  return value;
}

async function getElementCoordsByBackendNodeId(
  session: PageSession,
  backendNodeId: number,
  expectedText?: string,
): Promise<
  PageClickDispatchTarget & {
    x: number;
    y: number;
    inputType?: string;
  }
> {
  const objectId = await resolveBackendNodeObjectId(session, backendNodeId);

  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: GET_CLICK_COORDS_FROM_NODE_SRC,
    arguments: [{ value: expectedText }],
    returnByValue: true,
  });

  const value = result.result?.value;
  if (value === null) {
    throw new PageActionPreconditionError(
      `Cannot resolve clickable element for backendNodeId ${backendNodeId}`,
    );
  }
  if (!value) throw new Error('coord evaluation returned no value');
  if (value.error) throw new PageActionPreconditionError(value.error);
  return value;
}

async function resolveScopeBackendNodeId(session: PageSession, scope: string): Promise<number> {
  checkPageActionPrecondition(() => validatePageElementSelector(scope, 'page_click scope'));
  if (scope.startsWith('@e')) {
    return resolveSnapshotRef(session, scope).backendNodeId;
  }

  const evaluated = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(scope)})`,
    returnByValue: false,
  });
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
    const described = await sendCdpDeviceShellPageCommand(session, 'DOM.describeNode', {
      objectId,
    });
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) {
      throw new PageActionPreconditionError(`page_click: cannot resolve scope: ${scope}`);
    }
    return backendNodeId;
  } finally {
    await sendCdpDeviceShellPageCommand(session, 'Runtime.releaseObject', { objectId }).catch(
      () => {},
    );
  }
}

// ─── Exported handlers ────────────────────────────────────────────────────────

export async function cdpPageClick(session: PageSession, data: PageClickParams): Promise<any> {
  const { selector, text, role, exact, scope, clickMode, point, frameId, coordinateSpace } =
    data ?? {};

  const hasSelector = typeof selector === 'string' && selector.length > 0;
  const hasText = typeof text === 'string' && text.length > 0;
  const hasPoint =
    point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0;

  const provided = [hasSelector && 'selector', hasText && 'text', hasPoint && 'point'].filter(
    Boolean,
  ) as string[];

  if (clickMode !== undefined && !['auto', 'dom', 'mouse', 'touch'].includes(clickMode)) {
    throw new PageActionPreconditionError(
      'page_click: "clickMode" must be one of auto, dom, mouse, touch',
    );
  }
  if (scope !== undefined && !hasText) {
    throw new PageActionPreconditionError(
      'page_click: "scope" is only supported with the "text" target',
    );
  }
  if (
    coordinateSpace !== undefined &&
    !['outer-viewport', 'active-frame'].includes(coordinateSpace)
  ) {
    throw new PageActionPreconditionError(
      'page_click: "coordinateSpace" must be one of outer-viewport, active-frame',
    );
  }
  if (coordinateSpace !== undefined && !hasPoint) {
    throw new PageActionPreconditionError(
      'page_click: "coordinateSpace" is only supported with the "point" target',
    );
  }
  if (frameId !== undefined || coordinateSpace === 'active-frame') {
    throw new PageActionPreconditionError(
      'page_click: frameId and active-frame coordinates require the browser extension backend',
    );
  }
  if (scope !== undefined) {
    checkPageActionPrecondition(() => validatePageElementSelector(scope, 'page_click scope'));
  }
  if (hasSelector) {
    checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_click'));
  }

  if (provided.length === 0) {
    throw new PageActionPreconditionError(
      'page_click: provide exactly one of "selector", "text", or "point". ' +
        'For text matching, pass "text" (and optionally "role"/"exact"). ' +
        'For coordinate clicks, pass "point": { x, y } in viewport pixels.',
    );
  }
  if (provided.length > 1) {
    throw new PageActionPreconditionError(
      `page_click: provide exactly one of "selector", "text", or "point" — got ${provided.length} (${provided.join(', ')}).`,
    );
  }

  const requestedMode = (clickMode ?? 'auto') as PageClickMode;
  const [visibilityResult, touchEmulationEnabled] =
    requestedMode === 'auto' || requestedMode === 'touch'
      ? await Promise.all([
          sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
            expression: 'document.visibilityState',
            returnByValue: true,
          }),
          prefersTouchInput(session),
        ])
      : [undefined, false];
  if (requestedMode === 'touch' && visibilityResult?.result?.value === 'hidden') {
    throw new PageActionPreconditionError(PAGE_CLICK_HIDDEN_TOUCH_ERROR);
  }
  const policy = resolvePageClickDispatchPolicy(
    requestedMode,
    visibilityResult?.result?.value,
    touchEmulationEnabled,
  );
  const effectiveClickMode = policy.clickMode;
  const finalize = (result: any): any =>
    policy.fallbackReason ? { ...result, fallbackReason: policy.fallbackReason } : result;
  const dispatchTrustedClick = async (
    requestedTarget: PageClickRequestedTarget,
    coordinates: { x: number; y: number },
    target: PageClickDispatchTarget,
  ): Promise<PageClickDispatchTarget> => {
    const pointerType = effectiveClickMode as PageClickPointerType;
    const dispatchTarget: PageClickDispatchTarget = {
      ...target,
      dispatchMode: 'trusted-input',
      pointerType,
    };
    const attemptTarget: PageClickDispatchTarget = {
      ...dispatchTarget,
      coordinates: {
        coordinateSpace: 'outer-viewport',
        outerPoint: coordinates,
      },
    };
    try {
      await dispatchCdpClick(session, coordinates.x, coordinates.y, pointerType);
    } catch (error) {
      throw withPageActionDispatchAttempt(error, {
        action: 'page_click',
        requestedTarget,
        requestedMode,
        effectiveMode: effectiveClickMode,
        ...(visibilityResult?.result?.value
          ? { visibilityState: visibilityResult.result.value }
          : {}),
        ...describePageClickDispatchAttempt(attemptTarget),
      });
    }
    return dispatchTarget;
  };

  if (hasSelector) {
    if ((selector as string).startsWith('@e')) {
      const ref = selector as string;
      const result = await withSnapshotRef(session, ref, async entry => {
        const requestedTarget: PageClickRequestedTarget = {
          kind: 'ref',
          selector: ref,
          role: entry.role,
          name: entry.name,
        };
        let dispatchTarget: PageClickDispatchTarget;
        if (
          effectiveClickMode === 'dom' ||
          (policy.stateAwareControls && isNativeToggleControl(entry.role))
        ) {
          dispatchTarget = await clickByBackendNodeJs(session, entry.backendNodeId, entry.name);
        } else {
          const coord = await getElementCoordsByBackendNodeId(
            session,
            entry.backendNodeId,
            entry.name,
          );
          if (policy.stateAwareControls && isStateAwareClickTarget(coord)) {
            dispatchTarget = await clickByBackendNodeJs(session, entry.backendNodeId, entry.name);
          } else {
            dispatchTarget = await dispatchTrustedClick(
              requestedTarget,
              { x: coord.x, y: coord.y },
              coord,
            );
          }
        }
        return createPageClickResult(requestedTarget, dispatchTarget);
      });
      return finalize(result);
    }

    if (effectiveClickMode !== 'dom') {
      const coord = await getElementCoordsBySelector(session, selector as string);
      const requestedTarget: PageClickRequestedTarget = {
        kind: 'selector',
        selector: selector as string,
      };
      if (policy.stateAwareControls && isStateAwareClickTarget(coord)) {
        const dispatchTarget = await clickBySelectorJs(session, selector as string);
        return finalize(createPageClickResult(requestedTarget, dispatchTarget));
      }
      return finalize(
        createPageClickResult(
          requestedTarget,
          await dispatchTrustedClick(requestedTarget, { x: coord.x, y: coord.y }, coord),
        ),
      );
    }
    const dispatchTarget = await clickBySelectorJs(session, selector as string);
    return finalize(
      createPageClickResult({ kind: 'selector', selector: selector as string }, dispatchTarget),
    );
  }

  if (hasText) {
    const scopeBackendNodeId = scope ? await resolveScopeBackendNodeId(session, scope) : undefined;
    const axResult = await sendCdpDeviceShellPageCommand(
      session,
      scopeBackendNodeId === undefined
        ? 'Accessibility.getFullAXTree'
        : 'Accessibility.queryAXTree',
      scopeBackendNodeId === undefined ? {} : { backendNodeId: scopeBackendNodeId },
    );
    const nodes: AXTextMatchNode[] = axResult.nodes ?? [];
    const { hits } = matchAXNodesByText(nodes, { text: text as string, role, exact });

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
    const requestedTarget: PageClickRequestedTarget = {
      kind: 'text',
      name: hit.name,
      role: hit.role || undefined,
      ...(scope ? { scope } : {}),
    };
    let dispatchTarget: PageClickDispatchTarget;
    if (
      effectiveClickMode === 'dom' ||
      (policy.stateAwareControls && isNativeToggleControl(hit.role))
    ) {
      dispatchTarget = await clickByBackendNodeJs(session, hit.backendNodeId, hit.name);
    } else {
      const coord = await getElementCoordsByBackendNodeId(session, hit.backendNodeId, hit.name);
      dispatchTarget =
        policy.stateAwareControls && isStateAwareClickTarget(coord)
          ? await clickByBackendNodeJs(session, hit.backendNodeId, hit.name)
          : await dispatchTrustedClick(requestedTarget, { x: coord.x, y: coord.y }, coord);
    }
    return finalize(createPageClickResult(requestedTarget, dispatchTarget));
  }

  // hasPoint
  if (!point) throw new PageActionPreconditionError('page_click point is required');
  if (effectiveClickMode === 'dom') {
    const dispatchTarget = await clickByPointJs(session, point);
    return finalize(createPageClickResult({ kind: 'point', point }, dispatchTarget));
  }
  const requestedTarget: PageClickRequestedTarget = { kind: 'point', point };
  return finalize(
    createPageClickResult(
      requestedTarget,
      await dispatchTrustedClick(requestedTarget, point, { tag: '', text: '' }),
    ),
  );
}

async function scrollDragSourceIntoView(
  session: PageSession,
  endpoint: PageDragEndpoint,
): Promise<void> {
  if (typeof endpoint !== 'string') return;
  validatePageElementSelector(endpoint, 'page_drag from');

  if (endpoint.startsWith('@e')) {
    const entry = resolveSnapshotRef(session, endpoint);
    const objectId = await resolveBackendNodeObjectId(session, entry.backendNodeId);
    await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
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

  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `(() => {
      const selector = ${JSON.stringify(endpoint)};
      const el = document.querySelector(selector);
      if (!el) return { error: 'Element not found: ' + selector };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return { scrolled: true };
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value;
  if (value?.error) throw new Error(`page_drag: ${value.error}`);
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
  session: PageSession,
  endpoint: PageDragEndpoint,
): Promise<PageDragResolvedEndpoint> {
  if (typeof endpoint !== 'string') {
    return { requested: endpoint, point: endpoint };
  }
  validatePageElementSelector(endpoint, 'page_drag endpoint');

  let coords: PageDragElementCoords;
  if (endpoint.startsWith('@e')) {
    const entry = resolveSnapshotRef(session, endpoint);
    const objectId = await resolveBackendNodeObjectId(session, entry.backendNodeId);
    const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: GET_DRAG_COORDS_FROM_NODE_SRC,
      returnByValue: true,
    });
    coords = unwrapDragElementCoords(result.result?.value, endpoint);
  } else {
    const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: `(() => {
        const selector = ${JSON.stringify(endpoint)};
        const el = document.querySelector(selector);
        if (!el) return { error: 'Element not found: ' + selector };
        return (${GET_DRAG_COORDS_FROM_NODE_SRC}).call(el);
      })()`,
      returnByValue: true,
    });
    coords = unwrapDragElementCoords(result.result?.value, endpoint);
  }

  return {
    requested: endpoint,
    point: { x: coords.x, y: coords.y },
    tag: coords.tag,
    text: coords.text,
  };
}

export async function cdpPageDrag(
  session: PageSession,
  data: PageDragParams,
): Promise<PageDragResultData> {
  const input = checkPageActionPrecondition(() => resolvePageDragInput(data));
  const visibilityResult =
    input.dragMode === 'auto'
      ? await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
          expression: 'document.visibilityState',
          returnByValue: true,
        })
      : undefined;
  const touchEmulationEnabled =
    input.dragMode === 'auto' || input.dragMode === 'dom'
      ? await prefersTouchInput(session)
      : input.dragMode === 'touch';
  const policy = resolvePageDragDispatchPolicy(
    input.dragMode,
    visibilityResult?.result?.value,
    touchEmulationEnabled,
  );
  await scrollDragSourceIntoView(session, input.from);
  const from = await resolveDragEndpoint(session, input.from);
  const to = await resolveDragEndpoint(session, input.to);
  if (Math.hypot(to.point.x - from.point.x, to.point.y - from.point.y) < 1) {
    throw new Error('page_drag: resolved endpoints must be at least 1 viewport pixel apart');
  }

  if (policy.dispatchMode === 'dom') {
    const path = buildPageDragPath(from.point, to.point, input.durationMs);
    const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: buildPageDragDomExpression(from.point, path.points, policy.pointerType),
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'page_drag: DOM simulation failed',
      );
    }
    const { steps } = unwrapPageDragDomResult(
      result.result?.value as PageDragDomExecutionResult | undefined,
    );
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

  const { steps } = await dispatchCdpDrag(
    session,
    from.point,
    to.point,
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
}

export async function cdpPageType(session: PageSession, data: PageTypeParams): Promise<any> {
  const { selector, text, clearFirst = true } = data;
  if (!selector || typeof selector !== 'string') {
    throw new PageActionPreconditionError(
      '"selector" must be a non-empty string. ' +
        'Pass a native CSS selector (e.g. "[aria-label=\'提交\']") or a snapshot ref like "@e3". ' +
        'Note: the field name is "selector", not "ref".',
    );
  }
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_type'));
  if (typeof text !== 'string') {
    throw new PageActionPreconditionError('"text" must be a string.');
  }

  // @e ref — resolve via snapshot registry and use Runtime.callFunctionOn
  if (selector.startsWith('@e')) {
    return withSnapshotRef(session, selector, async entry => {
      const objectId = await resolveBackendNodeObjectId(session, entry.backendNodeId);
      const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(inputValue, shouldClear) {
          return (${TYPE_INTO_ELEMENT_SRC})(this, inputValue, shouldClear);
        }`,
        arguments: [{ value: text }, { value: clearFirst }],
        returnByValue: true,
      });
      const value = result.result?.value as
        { typed: boolean; tag: string; error?: string } | undefined;
      if (!value) throw new Error('cdp_page_type: evaluation returned no value');
      if (value.error) throw new PageActionPreconditionError(value.error);
      return { typed: true, tag: value.tag };
    });
  }

  // CSS selector path
  const expression = `((sel, v, c) => {
    let el;
    try { el = document.querySelector(sel); }
    catch (e) { return { typed: false, tag: '', error: 'Invalid CSS selector "' + sel + '": ' + e.message }; }
    if (!el) return { typed: false, tag: '', error: 'Element not found: ' + sel };
    const fn = (${TYPE_INTO_ELEMENT_SRC});
    return fn(el, v, c);
  })(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${JSON.stringify(clearFirst)})`;

  const r = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  const value = r.result?.value as { typed: boolean; tag: string; error?: string } | undefined;
  if (!value) throw new Error('cdp_page_type: evaluation returned no value');
  if (value.error) throw new PageActionPreconditionError(value.error);
  if (!value.typed) throw new PageActionPreconditionError('cdp_page_type: failed to type');

  return { typed: true, tag: value.tag };
}

export async function cdpPageScroll(session: PageSession, data: PageScrollParams): Promise<any> {
  const input = checkPageActionPrecondition(() => resolvePageScrollInput(data ?? {}));

  if (input.selector?.startsWith('@e')) {
    return withSnapshotRef(session, input.selector, async entry => {
      const objectId = await resolveBackendNodeObjectId(session, entry.backendNodeId);
      const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: SCROLL_ELEMENT_IN_PAGE_SOURCE,
        arguments: [
          { value: input.direction },
          { value: input.distance },
          { value: input.selector },
          { value: input.containerPolicy },
        ],
        returnByValue: true,
      });
      return unwrapPageScrollResult(
        result.result?.value as PageScrollExecutionResult | undefined,
        `Cannot resolve scroll container for ref ${input.selector}`,
      );
    });
  }

  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: buildPageScrollExpression(input),
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'page_scroll evaluation failed',
    );
  }
  return unwrapPageScrollResult(
    result.result?.value as PageScrollExecutionResult | undefined,
    'page_scroll evaluation returned no value',
  );
}

export async function cdpPageEval(session: PageSession, data: PageEvalParams): Promise<any> {
  let expression: string;
  try {
    expression = resolvePageEvalExpression(data);
  } catch (error) {
    throw new PageActionPreconditionError(error instanceof Error ? error.message : String(error));
  }
  if (data.executionWorld === 'isolated') {
    if (data.frameId !== undefined) throw new Error('Plugin user scripts target the top frame');
    return cdpPageUserScript(session, {
      tabId: data.tabId,
      worldId: data.worldId ?? '',
      code: expression,
    });
  }
  if (data.executionWorld !== undefined && data.executionWorld !== 'main') {
    throw new Error('Invalid page executionWorld');
  }
  const { frameId, awaitPromise = true } = data;

  const params = {
    expression,
    returnByValue: true,
    awaitPromise,
  };
  const result =
    frameId === undefined
      ? await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', params)
      : await evaluateCdpFrame(session, frameId, params);

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Evaluation error',
    );
  }

  return { result: result.result?.value };
}

async function cdpPageUserScript(session: PageSession, data: PageUserScriptParams): Promise<any> {
  validatePageUserScriptParams(data);
  const tree = await sendCdpPageCommand(session, session.client, 'Page.getFrameTree', {});
  const world = await sendCdpPageCommand(session, session.client, 'Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: `mearl-${data.worldId}`,
  });
  const result = await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    expression: data.code,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return { result: result.result?.value ?? null };
}

export async function cdpPagePress(session: PageSession, data: PagePressParams): Promise<any> {
  const input = checkPageActionPrecondition(() => resolvePagePressInput(data));
  const visibilityResult =
    input.pressMode === 'auto'
      ? await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
          expression: 'document.visibilityState',
          returnByValue: true,
        })
      : undefined;
  const policy = resolvePagePressDispatchPolicy(input.pressMode, visibilityResult?.result?.value);

  if (policy.dispatchMode === 'dom') {
    const evaluated = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: buildPagePressDomExpression(input),
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(
        evaluated.exceptionDetails.exception?.description ??
          evaluated.exceptionDetails.text ??
          'page_press DOM simulation failed',
      );
    }
    const result = unwrapPagePressDomResult(evaluated.result?.value);
    return {
      ...result,
      key: input.key,
      dispatchMode: 'dom',
      ...(policy.fallbackReason ? { fallbackReason: policy.fallbackReason } : {}),
    };
  }

  const baseParams = {
    key: input.descriptor.key,
    code: input.descriptor.code,
    windowsVirtualKeyCode: input.descriptor.keyCode,
    nativeVirtualKeyCode: input.descriptor.keyCode,
    modifiers: input.modifierFlags,
  };
  const dispatch = async (params: Record<string, unknown>): Promise<void> => {
    try {
      await sendCdpDeviceShellPageCommand(
        session,
        'Input.dispatchKeyEvent',
        params,
        PAGE_PRESS_INPUT_TIMEOUT_MS,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'CDP command timeout: Input.dispatchKeyEvent'
      ) {
        throw new PageActionDispatchUncertainError(
          `CDP Input.dispatchKeyEvent (${String(params.type ?? 'unknown')}) timed out after ${PAGE_PRESS_INPUT_TIMEOUT_MS}ms. ` +
            'The page may already have changed; verify its current state before retrying.',
          { cause: error },
        );
      }
      throw error;
    }
  };
  const [down, up] = await Promise.allSettled([
    dispatch({
      type: 'keyDown',
      ...baseParams,
      ...(input.descriptor.text ? { text: input.descriptor.text } : {}),
    }),
    dispatch({ type: 'keyUp', ...baseParams }),
  ]);
  if (down.status === 'rejected') throw down.reason;
  if (up.status === 'rejected') throw up.reason;

  return { pressed: true, key: input.key, dispatchMode: 'trusted-input' };
}

export async function cdpPageWait(session: PageSession, data: PageWaitParams): Promise<any> {
  const options = resolvePageWaitInput(data);
  const startedAt = Date.now();

  if (options.mode === 'time') {
    await new Promise(resolve => setTimeout(resolve, options.time));
    return { success: true, waited: true, elapsed: options.time, mode: options.mode };
  }

  const expression = buildPageWaitExpression(options);

  while (Date.now() - startedAt < options.timeout) {
    const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.mode === 'condition',
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          `page_wait ${options.mode} evaluation failed`,
      );
    }

    const value = result.result?.value;
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

  if (options.mode === 'selector') {
    throw new Error(
      `page_wait selector ${JSON.stringify(options.selector)} did not reach state ${JSON.stringify(options.state)} after ${options.timeout}ms.`,
    );
  }
  if (options.mode === 'text') {
    throw new Error(
      `page_wait text ${JSON.stringify(options.text)} was not found after ${options.timeout}ms.`,
    );
  }
  throw new Error(`page_wait condition was not met after ${options.timeout}ms.`);
}

export async function cdpPageNavigate(
  session: PageSession,
  data: PageNavigateParams,
): Promise<any> {
  const timeout = 30000;
  const input = resolvePageNavigateInput(data);

  if (input.mode === 'refresh') {
    clearPageRefsForNavigation(session);
    await sendCdpDeviceShellPageCommand(session, 'Page.reload', {}, timeout + 5000);
    if (isCdpAppProfileActive(session)) await waitForCdpAppProfileLoad(session, timeout);
    else await waitForPageLoad(session, timeout);
    const state = await readPageIdentity(session);
    return { success: true, ...state, refreshed: true };
  }

  if (input.mode === 'history') {
    const navigationHistory = await sendCdpDeviceShellPageCommand(
      session,
      'Page.getNavigationHistory',
    );
    const targetIndex = navigationHistory.currentIndex + (input.history === 'back' ? -1 : 1);
    const targetEntry = navigationHistory.entries?.[targetIndex];
    if (!targetEntry) {
      throw new Error(
        `page_navigate: no ${input.history === 'back' ? 'previous' : 'next'} history entry`,
      );
    }
    clearPageRefsForNavigation(session);
    await sendCdpDeviceShellPageCommand(
      session,
      'Page.navigateToHistoryEntry',
      { entryId: targetEntry.id },
      timeout + 5000,
    );
    await waitForHistoryIndex(session, targetIndex, timeout);
    const state = await readPageIdentity(session);
    return { success: true, ...state, history: input.history };
  }

  clearPageRefsForNavigation(session);
  const result = await sendCdpDeviceShellPageCommand(
    session,
    'Page.navigate',
    { url: input.url },
    timeout + 5000,
  );
  if (isCdpDeviceShellActive(session)) await waitForCdpDeviceShellLoad(session);
  else if (isCdpAppProfileActive(session)) await waitForCdpAppProfileLoad(session, timeout);
  else await waitForPageLoad(session, timeout);
  return { success: true, url: result.url ?? input.url, frameId: result.frameId };
}

async function readPageIdentity(session: PageSession): Promise<{ url: string; title: string }> {
  const evaluated = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: '({ url: location.href, title: document.title })',
    returnByValue: true,
  });
  return {
    url: evaluated.result?.value?.url ?? '',
    title: evaluated.result?.value?.title ?? '',
  };
}

async function waitForHistoryIndex(
  session: PageSession,
  targetIndex: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const history = await sendCdpDeviceShellPageCommand(session, 'Page.getNavigationHistory');
      if (history.currentIndex === targetIndex) {
        const ready = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        if (ready.result?.value !== 'loading') return;
      }
    } catch {
      // Cross-document navigation briefly replaces the execution context.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Page history navigation timeout after ${timeoutMs}ms`);
}

export async function cdpPageUpload(session: PageSession, data: PageUploadParams): Promise<any> {
  const { selector, filePaths } = data ?? {};
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new PageActionPreconditionError(
      'page_upload: "selector" is required (CSS selector or @eN snapshot ref)',
    );
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

  let described: any;
  if (selector.startsWith('@e')) {
    described = await withSnapshotRef(session, selector, entry =>
      sendCdpDeviceShellPageCommand(session, 'DOM.describeNode', {
        backendNodeId: entry.backendNodeId,
      }),
    );
  } else {
    const evaluated = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    });
    const objectId = evaluated.result?.objectId;
    if (!objectId || evaluated.result?.subtype === 'null') {
      throw new PageActionPreconditionError(`Element not found: ${selector}`);
    }
    try {
      described = await sendCdpDeviceShellPageCommand(session, 'DOM.describeNode', { objectId });
    } finally {
      await sendCdpDeviceShellPageCommand(session, 'Runtime.releaseObject', { objectId }).catch(
        () => {},
      );
    }
  }

  const backendNodeId = described.node?.backendNodeId;
  const tag = String(described.node?.nodeName ?? '').toLowerCase();
  if (backendNodeId === undefined) {
    throw new PageActionPreconditionError(`Cannot resolve file input: ${selector}`);
  }
  if (tag !== 'input') {
    throw new PageActionPreconditionError(
      `Element <${tag || 'unknown'}> is not a file input. selector must point to an <input type="file"> element.`,
    );
  }

  await sendCdpDeviceShellPageCommand(session, 'DOM.setFileInputFiles', {
    files: filePaths,
    backendNodeId,
  });

  return { uploaded: true, fileCount: filePaths.length, tag };
}

export async function cdpSetDeviceEmulation(
  session: PageSession,
  data: SetDeviceEmulationParams,
): Promise<any> {
  const { enabled } = data ?? {};
  if (typeof enabled !== 'boolean') {
    throw new Error('set_device_emulation: "enabled" is required (true to enable, false to clear)');
  }

  if (enabled === false) {
    const hadDeviceShell = await clearCdpDeviceShell(session);
    const appEnvironment = await updateCdpAppProfileDeviceEmulation(session, null);
    for (const { method, params } of buildDisableEmulationCommands()) {
      await sendCdpPageCommand(session, session.client, method, params).catch(() => {});
    }
    if (appEnvironment) {
      await sendCdpPageCommand(session, session.client, 'Emulation.setUserAgentOverride', {
        userAgent: appEnvironment.userAgent,
        platform: appEnvironment.platform,
      });
    }
    session.emulation = undefined;
    let reloaded = false;
    if (hadDeviceShell) {
      clearPageRefsForNavigation(session);
      try {
        await sendCdpPageCommand(session, session.client, 'Page.reload', {});
        await waitForPageLoad(session, 30000);
        reloaded = true;
      } catch {
        // 清除命令已经生效，reload 失败不回滚设备状态。
      }
    }
    return { enabled: false, deviceShell: false, splitScreen: false, reloaded };
  }

  const config = resolveEmulationConfig(data);
  const deviceShell = data.deviceShell === true;
  const splitScreen =
    deviceShell &&
    isCdpAppProfileActive(session) &&
    data.splitScreen === true &&
    config.orientation === 'landscape';
  const hadDeviceShell = isCdpDeviceShellActive(session);
  const appEnvironment = await updateCdpAppProfileDeviceEmulation(
    session,
    config,
    deviceShell,
    splitScreen,
  );
  const commands = buildEnableEmulationCommands(config).map(command =>
    command.method === 'Emulation.setUserAgentOverride' && appEnvironment
      ? { ...command, params: { userAgent: appEnvironment.userAgent, platform: config.platform } }
      : command,
  );
  for (const { method, params, optional } of commands) {
    await sendCdpPageCommand(session, session.client, method, params).catch(error => {
      if (!optional) throw error;
    });
  }
  session.emulation = {
    mobile: config.mobile,
    touch: config.touch,
    config,
    deviceShell,
    splitScreen,
  };
  const deviceShellChanged = deviceShell
    ? await applyCdpDeviceShell(session, config, {
        rootContainerManagedByApp: splitScreen,
      })
    : await clearCdpDeviceShell(session);
  if (deviceShell && appEnvironment) {
    setCdpDeviceShellChildEnvironmentManagedByApp(session, true);
  }

  let reloaded = false;
  if (
    (data?.reload !== false || deviceShellChanged || hadDeviceShell !== deviceShell) &&
    (!deviceShell || (await canLoadCdpDeviceShell(session)))
  ) {
    clearPageRefsForNavigation(session);
    try {
      await sendCdpPageCommand(session, session.client, 'Page.reload', {});
      if (deviceShell) await waitForCdpDeviceShellLoad(session);
      else if (isCdpAppProfileActive(session)) await waitForCdpAppProfileLoad(session);
      else await waitForPageLoad(session, 30000);
      reloaded = true;
    } catch {
      // reload 失败不致命，emulation 已生效
    }
  }

  return {
    enabled: true,
    preset: config.presetName,
    viewport: {
      width: config.width,
      height: config.height,
      deviceScaleFactor: config.deviceScaleFactor,
      scale: config.scale ?? 1,
    },
    userAgent: config.userAgent,
    mobile: config.mobile,
    touch: config.touch,
    orientation: config.orientation,
    deviceShell,
    splitScreen,
    reloaded,
  };
}

export async function cdpPageHover(session: PageSession, data: PageHoverParams): Promise<any> {
  const { selector } = data ?? {};
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new PageActionPreconditionError(
      'page_hover: "selector" is required (CSS selector or @eN snapshot ref)',
    );
  }
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_hover'));

  const coord = selector.startsWith('@e')
    ? await withSnapshotRef(session, selector, entry =>
        getElementCoordsByBackendNodeId(session, entry.backendNodeId),
      )
    : await getElementCoordsBySelector(session, selector);
  const offset = await getCdpDeviceShellInputOffset(session);

  await sendCdpPageCommand(session, session.client, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: coord.x + offset.x,
    y: coord.y + offset.y,
  });

  return { hovered: true, tag: coord.tag, text: coord.text };
}

export async function cdpPageInspect(
  session: PageSession,
  data: PageInspectParams,
): Promise<PageInspectResult> {
  const input = checkPageActionPrecondition(() => resolvePageInspectInput(data));
  if (input.selector === '$0') {
    throw new PageActionPreconditionError(
      'page_inspect selector "$0" requires the browser extension and an element selected in DevTools.',
    );
  }
  if (!input.selector?.startsWith('@e')) {
    const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: buildPageInspectExpression(input),
      returnByValue: true,
    });
    return unwrapPageInspectResult(
      result.result?.value as PageInspectExecutionResult | undefined,
      'page_inspect evaluation returned no value',
    );
  }

  const ref = input.selector;
  return withSnapshotRef(session, ref, async entry => {
    const objectId = await resolveBackendNodeObjectId(session, entry.backendNodeId);
    const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.callFunctionOn', {
      objectId,
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
    });
    return unwrapPageInspectResult(
      result.result?.value as PageInspectExecutionResult | undefined,
      `Cannot inspect element for ref ${ref}`,
    );
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerActions([
  { name: 'page_click', session: 'page', handler: cdpPageClick },
  { name: 'page_drag', session: 'page', handler: cdpPageDrag },
  { name: 'page_type', session: 'page', handler: cdpPageType },
  { name: 'page_hover', session: 'page', handler: cdpPageHover },
  { name: 'page_scroll', session: 'page', handler: cdpPageScroll },
  { name: 'page_eval', session: 'page', handler: cdpPageEval },
  { name: 'page_inspect', session: 'page', handler: cdpPageInspect },
  { name: 'page_press', session: 'page', handler: cdpPagePress },
  { name: 'page_wait', session: 'page', handler: cdpPageWait },
  { name: 'page_navigate', session: 'page', handler: cdpPageNavigate },
  { name: 'page_upload', session: 'page', handler: cdpPageUpload },
  { name: 'set_device_emulation', session: 'page', handler: cdpSetDeviceEmulation },
]);
