/**
 * 通用的"点击页面元素"逻辑，供 extension（chrome.scripting / chrome.debugger）
 * 与 native-host（CDP Runtime.evaluate / callFunctionOn）共享。
 *
 * ⚠️ 重要约束（与 domTyping.ts 相同）：
 *   1. 导出的函数会被 .toString() 序列化后注入到目标页面执行
 *   2. 不能引用任何外部作用域的变量或 import
 *   3. 不能使用 async / generator / 装饰器 / enum / 私有字段等会引入 TS helper 的语法
 *   4. 所有依赖必须通过参数显式传入
 */

export type PageClickTargetStrategy =
  | 'self'
  | 'actionable-ancestor'
  | 'single-child-descendant'
  | 'exact-text-descendant'
  | 'accessible-option';

export interface PageClickRequestedTarget {
  kind: 'ref' | 'selector' | 'text' | 'point';
  selector?: string;
  name?: string;
  role?: string;
  scope?: string;
  point?: { x: number; y: number };
}

export type PageClickMode = 'auto' | 'dom' | 'mouse' | 'touch';
export type PageClickPointerType = 'mouse' | 'touch';
export type PageClickDispatchMode = 'trusted-input' | 'dom';
export type PageClickFallbackReason = 'page-hidden';
export const PAGE_CLICK_INPUT_TIMEOUT_MS = 10_000;
export const PAGE_CLICK_HIDDEN_TOUCH_ERROR =
  'page_click: clickMode "touch" requires a visible page, but the target is hidden or in a background tab. ' +
  'Use clickMode "auto" for DOM fallback, or call tab_open for the same URL with reuse "require" and active true. ' +
  'Extension activation uses background focus emulation while Do not disturb is enabled; check activation.visibilityState before retrying trusted input; use "mouse" only when touch semantics are not required.';

export interface PageClickDispatchTarget {
  tag: string;
  text: string;
  sourceTarget?: {
    tag: string;
    text: string;
  };
  strategy?: PageClickTargetStrategy;
  distance?: number;
  actionableAncestorCandidates?: PageClickAncestorCandidate[];
  hitTarget?: PageClickHitTarget;
  frame?: PageClickFrameTarget;
  coordinates?: PageClickCoordinates;
  controlState?: PageClickControlState;
  selectionState?: PageClickSelectionState;
  dispatchMode?: PageClickDispatchMode;
  pointerType?: PageClickPointerType;
}

export interface PageClickAncestorCandidate {
  selector: string;
  tag: string;
  text: string;
  distance: number;
  reason: 'cursor-pointer' | 'containing-block';
}

export interface PageClickHitTarget {
  tag: string;
  text: string;
  selector?: string;
}

export interface PageClickFrameTarget {
  frameId: string;
  frameUrl?: string;
  context: 'app-content' | 'frame';
}

export interface PageClickCoordinates {
  coordinateSpace: 'outer-viewport' | 'active-frame';
  outerPoint: { x: number; y: number };
  framePoint?: { x: number; y: number };
  frameOffset?: { x: number; y: number };
  frameScale?: { x: number; y: number };
}

export interface PageClickControlState {
  type: 'checkbox' | 'radio';
  checkedBefore: boolean;
  checkedAfter: boolean;
}

export interface PageClickSelectionState {
  valueBefore: string;
  valueAfter: string;
  selectedAfter: boolean;
}

/** Native options need value selection; clicking their select only opens the menu. */
export function isStateAwareClickTarget(
  target: PageClickDispatchTarget & { inputType?: string },
): boolean {
  return (
    target.tag === 'option' ||
    target.sourceTarget?.tag === 'option' ||
    /^(checkbox|radio)$/i.test(target.inputType ?? '')
  );
}

export interface PageClickResolvedTarget {
  tag: string;
  text: string;
  strategy: PageClickTargetStrategy;
  distance: number;
}

export interface PageClickResultData {
  clicked: true;
  tag: string;
  text: string;
  requestedTarget: PageClickRequestedTarget;
  resolvedTarget?: PageClickResolvedTarget;
  dispatchTarget?: PageClickDispatchTarget;
  hitTarget?: PageClickHitTarget;
  frame?: PageClickFrameTarget;
  coordinates?: PageClickCoordinates;
  actionableAncestorCandidates?: PageClickAncestorCandidate[];
  controlState?: PageClickControlState;
  selectionState?: PageClickSelectionState;
  dispatchMode?: PageClickDispatchMode;
  pointerType?: PageClickPointerType;
  fallbackReason?: PageClickFallbackReason;
}

export type PageClickDispatchEvidence = Omit<
  PageClickResultData,
  'clicked' | 'requestedTarget' | 'resolvedTarget' | 'dispatchTarget'
> & {
  resolvedTarget: PageClickResolvedTarget;
  dispatchTarget: PageClickDispatchTarget;
};

export interface PageClickDispatchAttemptEvidence {
  [key: string]: unknown;
  resolvedTarget?: {
    tag: string;
    text: string;
    strategy?: PageClickResolvedTarget['strategy'];
    distance?: number;
  };
  dispatchTarget?: { tag: string; text: string };
  hitTarget?: PageClickHitTarget;
  frame?: PageClickFrameTarget;
  coordinates?: PageClickCoordinates;
  actionableAncestorCandidates?: Array<
    Pick<PageClickAncestorCandidate, 'selector' | 'distance' | 'reason'>
  >;
  controlState?: PageClickControlState;
  selectionState?: PageClickSelectionState;
  dispatchMode?: PageClickDispatchMode;
  pointerType?: PageClickPointerType;
}

export interface PageClickDispatchPolicy {
  clickMode: Exclude<PageClickMode, 'auto'>;
  stateAwareControls: boolean;
  fallbackReason?: PageClickFallbackReason;
}

/** Resolve the click path from the requested mode, page visibility, and device emulation state. */
export function resolvePageClickDispatchPolicy(
  clickMode: PageClickMode | undefined,
  visibilityState: string | undefined,
  touchEmulationEnabled: boolean,
): PageClickDispatchPolicy {
  if (clickMode !== undefined && clickMode !== 'auto') {
    return {
      clickMode,
      stateAwareControls: clickMode === 'dom',
    };
  }
  if (visibilityState === 'hidden') {
    return {
      clickMode: 'dom',
      stateAwareControls: true,
      fallbackReason: 'page-hidden',
    };
  }
  return {
    clickMode: touchEmulationEnabled ? 'touch' : 'mouse',
    stateAwareControls: true,
  };
}

/** Keep the requested semantic target separate from the DOM node that received the event. */
export function createPageClickResult(
  requestedTarget: PageClickRequestedTarget,
  dispatchTarget: PageClickDispatchTarget,
): PageClickResultData {
  const evidence = describePageClickDispatchTarget(dispatchTarget);
  const text = requestedTarget.name || evidence.text;
  const normalizedRequestedTarget = { ...requestedTarget };
  if (!normalizedRequestedTarget.name) delete normalizedRequestedTarget.name;
  const resolvedDiffers =
    evidence.resolvedTarget.tag !== evidence.tag ||
    evidence.resolvedTarget.text !== text ||
    evidence.resolvedTarget.strategy !== 'self' ||
    evidence.resolvedTarget.distance > 0;
  const dispatchDiffers =
    evidence.dispatchTarget.tag !== evidence.tag || evidence.dispatchTarget.text !== text;
  const hitDiffers =
    evidence.hitTarget !== undefined &&
    (Boolean(evidence.hitTarget.selector) ||
      evidence.hitTarget.tag !== evidence.dispatchTarget.tag ||
      evidence.hitTarget.text !== evidence.dispatchTarget.text);
  return {
    clicked: true,
    requestedTarget: normalizedRequestedTarget,
    tag: evidence.tag,
    text,
    ...(resolvedDiffers ? { resolvedTarget: evidence.resolvedTarget } : {}),
    ...(dispatchDiffers ? { dispatchTarget: evidence.dispatchTarget } : {}),
    ...(hitDiffers ? { hitTarget: evidence.hitTarget } : {}),
    ...(evidence.frame ? { frame: evidence.frame } : {}),
    ...(evidence.coordinates ? { coordinates: evidence.coordinates } : {}),
    ...(evidence.actionableAncestorCandidates?.length
      ? { actionableAncestorCandidates: evidence.actionableAncestorCandidates }
      : {}),
    ...(evidence.controlState ? { controlState: evidence.controlState } : {}),
    ...(evidence.selectionState ? { selectionState: evidence.selectionState } : {}),
    ...(evidence.dispatchMode ? { dispatchMode: evidence.dispatchMode } : {}),
    ...(evidence.pointerType ? { pointerType: evidence.pointerType } : {}),
  };
}

/** Describe the resolved and dispatched click target without claiming that input took effect. */
export function describePageClickDispatchTarget(
  dispatchTarget: PageClickDispatchTarget,
): PageClickDispatchEvidence {
  const normalizedDispatchTarget = {
    tag: dispatchTarget.tag,
    text: dispatchTarget.text,
  };
  const resolvedTarget: PageClickResolvedTarget = {
    tag: dispatchTarget.sourceTarget?.tag ?? normalizedDispatchTarget.tag,
    text: dispatchTarget.sourceTarget?.text ?? normalizedDispatchTarget.text,
    strategy: dispatchTarget.strategy ?? 'self',
    distance: dispatchTarget.distance ?? 0,
  };
  return {
    tag: normalizedDispatchTarget.tag,
    text: normalizedDispatchTarget.text,
    resolvedTarget,
    dispatchTarget: normalizedDispatchTarget,
    ...(dispatchTarget.hitTarget ? { hitTarget: dispatchTarget.hitTarget } : {}),
    ...(dispatchTarget.frame ? { frame: dispatchTarget.frame } : {}),
    ...(dispatchTarget.coordinates ? { coordinates: dispatchTarget.coordinates } : {}),
    ...(dispatchTarget.actionableAncestorCandidates?.length
      ? { actionableAncestorCandidates: dispatchTarget.actionableAncestorCandidates }
      : {}),
    ...(dispatchTarget.controlState ? { controlState: dispatchTarget.controlState } : {}),
    ...(dispatchTarget.selectionState ? { selectionState: dispatchTarget.selectionState } : {}),
    ...(dispatchTarget.dispatchMode ? { dispatchMode: dispatchTarget.dispatchMode } : {}),
    ...(dispatchTarget.pointerType ? { pointerType: dispatchTarget.pointerType } : {}),
  };
}

/** Keep uncertain-dispatch diagnostics compact while preserving every meaningful difference. */
export function describePageClickDispatchAttempt(
  dispatchTarget: PageClickDispatchTarget,
): PageClickDispatchAttemptEvidence {
  const evidence = describePageClickDispatchTarget(dispatchTarget);
  const resolved = evidence.resolvedTarget;
  const hasResolvedTarget = Boolean(resolved.tag || resolved.text);
  const dispatchDiffers =
    evidence.dispatchTarget.tag !== resolved.tag || evidence.dispatchTarget.text !== resolved.text;
  const comparisonTarget = dispatchDiffers ? evidence.dispatchTarget : resolved;
  const hitDiffers =
    evidence.hitTarget !== undefined &&
    (Boolean(evidence.hitTarget.selector) ||
      evidence.hitTarget.tag !== comparisonTarget.tag ||
      evidence.hitTarget.text !== comparisonTarget.text);

  return {
    ...(hasResolvedTarget
      ? {
          resolvedTarget: {
            tag: resolved.tag,
            text: resolved.text,
            ...(resolved.strategy !== 'self' ? { strategy: resolved.strategy } : {}),
            ...(resolved.distance > 0 ? { distance: resolved.distance } : {}),
          },
        }
      : {}),
    ...(dispatchDiffers ? { dispatchTarget: evidence.dispatchTarget } : {}),
    ...(hitDiffers ? { hitTarget: evidence.hitTarget } : {}),
    ...(evidence.frame ? { frame: evidence.frame } : {}),
    ...(evidence.coordinates ? { coordinates: evidence.coordinates } : {}),
    ...(evidence.actionableAncestorCandidates?.length
      ? {
          actionableAncestorCandidates: evidence.actionableAncestorCandidates.map(
            ({ selector, distance, reason }) => ({ selector, distance, reason }),
          ),
        }
      : {}),
    ...(evidence.controlState ? { controlState: evidence.controlState } : {}),
    ...(evidence.selectionState ? { selectionState: evidence.selectionState } : {}),
    ...(evidence.dispatchMode ? { dispatchMode: evidence.dispatchMode } : {}),
    ...(evidence.pointerType ? { pointerType: evidence.pointerType } : {}),
  };
}

/**
 * 在目标页面中执行 JS 点击：drill-down 到真正的交互元素 → scrollIntoView → touch 模拟 → click。
 *
 * 设计用于通过 Runtime.callFunctionOn (bindThis = 目标 DOM 节点) 调用。
 * 返回点击目标的 tag、text 和视口中心坐标，供调用方做 indicator 展示。
 */
export function clickElementViaJS(
  this: any,
  expectedText?: string,
): {
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
} | null {
  const el = this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.isConnected) return null;
  const sourceTarget = {
    tag: el.tagName ? el.tagName.toLowerCase() : '',
    text: (el.textContent || '').trim().slice(0, 100),
  };

  // <option> 无法通过 click 选中（原生下拉在浏览器 UI 层渲染）：
  // 改为设置父 <select> 的值并派发 input/change，用原生 setter 兼容 React 受控组件。
  if (el.tagName === 'OPTION') {
    const select = el.closest('select');
    if (select) {
      if (select.matches(':disabled') || el.disabled || el.closest('optgroup')?.disabled) {
        return {
          tag: 'option',
          text: sourceTarget.text,
          cx: 0,
          cy: 0,
          strategy: 'self',
          distance: 0,
          sourceTarget,
          error: 'Cannot select a disabled option',
        };
      }
      const valueBefore = select.value;
      const desc = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'selectedIndex',
      );
      if (desc && desc.set) desc.set.call(select, el.index);
      else select.selectedIndex = el.index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const rect = select.getBoundingClientRect();
      return {
        tag: 'option',
        text: (el.textContent || '').trim().slice(0, 100),
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
        strategy: 'self',
        distance: 0,
        sourceTarget,
        selectionState: { valueBefore, valueAfter: select.value, selectedAfter: el.selected },
      };
    }
  }

  function isActionable(node: any): boolean {
    if (!node || node.nodeType !== 1) return false;
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|DETAILS|LABEL)$/i.test(node.tagName)) {
      return true;
    }
    if (
      /button|link|tab|menuitem|checkbox|radio|option|switch/i.test(node.getAttribute('role') || '')
    ) {
      return true;
    }
    if (node.isContentEditable || typeof node.onclick === 'function') return true;
    const tabIndexAttribute = node.getAttribute('tabindex');
    if (tabIndexAttribute === null) return false;
    const tabIndex = Number(tabIndexAttribute);
    return Number.isFinite(tabIndex) && tabIndex >= 0;
  }

  function normalizeText(value: unknown): string {
    return String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  let target = el;
  let exactTextNode: any = null;
  let strategy: PageClickTargetStrategy = 'self';
  let distance = 0;

  // Virtual listboxes expose zero-size AX options beside their visible option surfaces.
  const listbox: Element | null =
    target.getAttribute('role') === 'option' ? target.closest('[role="listbox"]') : null;
  const listboxRect = listbox?.getBoundingClientRect();
  if (listbox && listboxRect && listboxRect.width <= 1 && listboxRect.height <= 1) {
    const popup = listbox.parentElement;
    const normalize = (value: unknown): string =>
      String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');
    const name = normalize(target.getAttribute('aria-label') || target.textContent);
    const candidates = popup?.querySelectorAll('[aria-selected], [role="option"]');
    const matches =
      popup && popup !== document.body && name && candidates && candidates.length <= 1000
        ? Array.from(candidates).filter(candidate => {
            if (listbox.contains(candidate)) return false;
            const candidateName = normalize(
              candidate.getAttribute('aria-label') ||
                candidate.getAttribute('title') ||
                candidate.textContent,
            );
            if (candidateName !== name) return false;
            const bounds = candidate.getBoundingClientRect();
            if (bounds.width <= 1 || bounds.height <= 1) return false;
            let ancestor: Element | null = candidate;
            while (ancestor) {
              const style = getComputedStyle(ancestor);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse' ||
                style.opacity === '0'
              )
                return false;
              if (ancestor === popup) break;
              ancestor = ancestor.parentElement;
            }
            return true;
          })
        : [];
    if (matches.length === 1 && matches[0].getAttribute('aria-disabled') !== 'true') {
      target = matches[0];
      strategy = 'accessible-option';
    }
  }
  const normalizedExpectedText = normalizeText(expectedText);
  if (normalizedExpectedText && normalizeText(target.textContent) !== normalizedExpectedText) {
    const descendants = Array.from(target.querySelectorAll?.('*') ?? []);
    const exactMatches = descendants.filter(
      (candidate: any) => normalizeText(candidate.textContent) === normalizedExpectedText,
    );
    const exactTarget = exactMatches.find(
      (candidate: any) =>
        !Array.from(candidate.children ?? []).some(
          (child: any) => normalizeText(child.textContent) === normalizedExpectedText,
        ),
    );
    if (exactTarget) {
      target = exactTarget;
      strategy = 'exact-text-descendant';
      let cursor = target;
      while (cursor && cursor !== el && distance < 20) {
        distance += 1;
        cursor = cursor.parentElement;
      }
    } else {
      const pending = Array.from(target.childNodes ?? []);
      for (let index = 0; index < pending.length && index < 10_000; index += 1) {
        const candidate: any = pending[index];
        if (
          candidate?.nodeType === 3 &&
          normalizeText(candidate.textContent) === normalizedExpectedText
        ) {
          exactTextNode = candidate;
          target = candidate.parentElement ?? target;
          strategy = 'exact-text-descendant';
          let cursor = target;
          while (cursor && cursor !== el && distance < 20) {
            distance += 1;
            cursor = cursor.parentElement;
          }
          break;
        }
        if (candidate?.nodeType === 1) pending.push(...Array.from(candidate.childNodes ?? []));
      }
    }
  }
  if (strategy === 'self' && !isActionable(target)) {
    let ancestor = target.parentElement;
    while (ancestor && ancestor !== document.body && distance < 6) {
      distance += 1;
      if (isActionable(ancestor)) {
        target = ancestor;
        strategy = 'actionable-ancestor';
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  if (strategy === 'self' && !isActionable(target)) {
    let cursor = target;
    let descendantDistance = 0;
    while (cursor.children.length === 1) {
      const child = cursor.children[0];
      if (!child || child.nodeType !== 1) break;
      if (!(child.textContent || '').trim()) break;
      cursor = child;
      descendantDistance += 1;
    }
    if (cursor !== target) {
      target = cursor;
      strategy = 'single-child-descendant';
      distance = descendantDistance;
    } else {
      distance = 0;
    }
  }

  function findClippingAncestor(node: any, bounds: any): any {
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      const style = getComputedStyle(ancestor);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || '');
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || '');
      if (clipsX || clipsY) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const centerX = (bounds.left + bounds.right) / 2;
        const centerY = (bounds.top + bounds.bottom) / 2;
        const clippedX =
          clipsX && (centerX < ancestorRect.left - 0.5 || centerX > ancestorRect.right + 0.5);
        const clippedY =
          clipsY && (centerY < ancestorRect.top - 0.5 || centerY > ancestorRect.bottom + 0.5);
        if (clippedX || clippedY) return ancestor;
      }
      if (style.position === 'fixed') break;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  let rect = target.getBoundingClientRect();
  let clippingAncestor = findClippingAncestor(target, rect);
  if (
    rect.top < 0 ||
    rect.left < 0 ||
    rect.bottom > window.innerHeight ||
    rect.right > window.innerWidth ||
    clippingAncestor
  ) {
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    rect = target.getBoundingClientRect();
    clippingAncestor = findClippingAncestor(target, rect);
  }
  if (exactTextNode) {
    try {
      const range = document.createRange();
      range.selectNodeContents(exactTextNode);
      const textRect = range.getBoundingClientRect();
      if (textRect.width > 0 && textRect.height > 0) rect = textRect;
    } catch {}
  }

  if (clippingAncestor) {
    return {
      tag: target.tagName ? target.tagName.toLowerCase() : '',
      text: (target.textContent || '').trim().slice(0, 100),
      cx: rect.x + rect.width / 2,
      cy: rect.y + rect.height / 2,
      strategy,
      distance,
      sourceTarget,
      error:
        'page_click: target remains clipped by a scroll container or overflow ancestor (' +
        String(clippingAncestor.tagName || '').toLowerCase() +
        '). Refresh the snapshot or scroll the nearest container before retrying.',
    };
  }

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  let hitTarget: any = null;
  try {
    hitTarget = document.elementFromPoint(cx, cy);
    const visited = new Set<Element>();
    while (hitTarget?.shadowRoot?.elementFromPoint && !visited.has(hitTarget)) {
      visited.add(hitTarget);
      const inner = hitTarget.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === hitTarget) break;
      hitTarget = inner;
    }
  } catch {}
  let composedHit: any = hitTarget;
  while (composedHit && composedHit !== target) {
    composedHit = composedHit.parentElement || composedHit.getRootNode?.().host;
  }
  if (
    hitTarget &&
    !composedHit &&
    hitTarget !== target &&
    !target.contains?.(hitTarget) &&
    !hitTarget.contains?.(target)
  ) {
    return {
      tag: target.tagName ? target.tagName.toLowerCase() : '',
      text: (target.textContent || '').trim().slice(0, 100),
      cx,
      cy,
      strategy,
      distance,
      sourceTarget,
      error:
        'page_click: target is covered by another element (' +
        String(hitTarget.tagName || '').toLowerCase() +
        '). Refresh the snapshot or inspect hitTest.occludedBy before retrying.',
    };
  }

  if (target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') {
    return {
      tag: target.tagName.toLowerCase(),
      text: (target.textContent || '').trim().slice(0, 100),
      cx,
      cy,
      strategy,
      distance,
      sourceTarget,
      error: 'page_click: target is disabled.',
    };
  }

  // Dispatch touch events for mobile H5 frameworks (Rax/Weex) that only listen on touch
  try {
    const touch = new Touch({ identifier: Date.now(), target: target, clientX: cx, clientY: cy });
    target.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchend', {
        touches: [],
        targetTouches: [],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }),
    );
  } catch {}

  // Custom controls often open on mousedown; HTMLElement.click() only emits click.
  const mouseInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  const pointerInit = { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  let dispatchMouse = true;
  if (typeof PointerEvent === 'function') {
    dispatchMouse = target.dispatchEvent(
      new PointerEvent('pointerdown', { ...pointerInit, buttons: 1 }),
    );
  }
  if (dispatchMouse) {
    const focusAllowed = target.dispatchEvent(
      new MouseEvent('mousedown', { ...mouseInit, buttons: 1 }),
    );
    if (focusAllowed) {
      const focusTarget = target.closest(
        'button, input, select, textarea, a[href], [tabindex], [role="combobox"]',
      ) as HTMLElement | null;
      focusTarget?.focus({ preventScroll: true });
    }
  }
  if (typeof PointerEvent === 'function') {
    target.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
  }
  if (dispatchMouse) {
    target.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
  }

  let controlState: PageClickControlState | undefined;
  const controlType =
    target.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(target.type || '')
      ? String(target.type).toLowerCase()
      : '';
  if (controlType === 'checkbox' || controlType === 'radio') {
    const checkedBefore = Boolean(target.checked);
    target.click();
    controlState = {
      type: controlType,
      checkedBefore,
      checkedAfter: Boolean(target.checked),
    };
  } else {
    target.click();
  }

  return {
    tag: target.tagName ? target.tagName.toLowerCase() : '',
    text: (target.textContent || '').trim().slice(0, 100),
    cx: cx,
    cy: cy,
    strategy,
    distance,
    sourceTarget,
    ...(controlState ? { controlState } : {}),
  };
}

/**
 * 页面内 JS 点击（通过 selector 定位）。设计用于 chrome.scripting.executeScript 或
 * Runtime.evaluate 注入执行。
 *
 * @param selector - CSS 选择器
 * @param invalidSelectorHint - querySelector 报错时附带的引导文案
 */
export function clickElementBySelector(
  selector: string,
  invalidSelectorHint: string,
): {
  clicked: boolean;
  tag: string;
  text: string;
  cx: number;
  cy: number;
  strategy?: PageClickTargetStrategy;
  distance?: number;
  controlState?: PageClickControlState;
  selectionState?: PageClickSelectionState;
  error?: string;
} {
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch (e) {
    return {
      clicked: false,
      tag: '',
      text: '',
      cx: 0,
      cy: 0,
      error:
        'Invalid CSS selector "' +
        selector +
        '": ' +
        (e as Error).message +
        '. ' +
        invalidSelectorHint,
    };
  }
  if (!element) {
    return {
      clicked: false,
      tag: '',
      text: '',
      cx: 0,
      cy: 0,
      error: 'Element not found: ' + selector,
    };
  }

  // <option> 无法通过 click 选中：改为设置父 <select> 的值并派发 input/change（兼容 React）
  if (element.tagName === 'OPTION') {
    const select = element.closest('select');
    if (select) {
      const option = element as HTMLOptionElement;
      if (select.matches(':disabled') || option.disabled || option.closest('optgroup')?.disabled) {
        return {
          clicked: false,
          tag: 'option',
          text: (option.textContent || '').trim().slice(0, 100),
          cx: 0,
          cy: 0,
          error: 'Cannot select a disabled option',
        };
      }
      const valueBefore = select.value;
      const desc = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'selectedIndex',
      );
      if (desc && desc.set) desc.set.call(select, option.index);
      else select.selectedIndex = option.index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const rect = select.getBoundingClientRect();
      return {
        clicked: true,
        tag: 'option',
        text: (element.textContent || '').trim().slice(0, 100),
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
        strategy: 'self',
        distance: 0,
        selectionState: { valueBefore, valueAfter: select.value, selectedAfter: option.selected },
      };
    }
  }

  function isActionable(node: Element): boolean {
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|DETAILS|LABEL)$/i.test(node.tagName)) {
      return true;
    }
    if (
      /button|link|tab|menuitem|checkbox|radio|option|switch/i.test(node.getAttribute('role') || '')
    ) {
      return true;
    }
    if (
      (node as HTMLElement).isContentEditable ||
      typeof (node as HTMLElement).onclick === 'function'
    ) {
      return true;
    }
    const tabIndexAttribute = node.getAttribute('tabindex');
    if (tabIndexAttribute === null) return false;
    const tabIndex = Number(tabIndexAttribute);
    return Number.isFinite(tabIndex) && tabIndex >= 0;
  }

  let target: Element = element;
  let strategy: PageClickTargetStrategy = 'self';
  let distance = 0;

  // Virtual listboxes expose zero-size AX options beside their visible option surfaces.
  const listbox: Element | null =
    target.getAttribute('role') === 'option' ? target.closest('[role="listbox"]') : null;
  const listboxRect = listbox?.getBoundingClientRect();
  if (listbox && listboxRect && listboxRect.width <= 1 && listboxRect.height <= 1) {
    const popup = listbox.parentElement;
    const normalize = (value: unknown): string =>
      String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');
    const name = normalize(target.getAttribute('aria-label') || target.textContent);
    const candidates = popup?.querySelectorAll('[aria-selected], [role="option"]');
    const matches =
      popup && popup !== document.body && name && candidates && candidates.length <= 1000
        ? Array.from(candidates).filter(candidate => {
            if (listbox.contains(candidate)) return false;
            const candidateName = normalize(
              candidate.getAttribute('aria-label') ||
                candidate.getAttribute('title') ||
                candidate.textContent,
            );
            if (candidateName !== name) return false;
            const bounds = candidate.getBoundingClientRect();
            if (bounds.width <= 1 || bounds.height <= 1) return false;
            let ancestor: Element | null = candidate;
            while (ancestor) {
              const style = getComputedStyle(ancestor);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse' ||
                style.opacity === '0'
              )
                return false;
              if (ancestor === popup) break;
              ancestor = ancestor.parentElement;
            }
            return true;
          })
        : [];
    if (matches.length === 1 && matches[0].getAttribute('aria-disabled') !== 'true') {
      target = matches[0];
      strategy = 'accessible-option';
    }
  }
  if (strategy === 'self' && !isActionable(target)) {
    let ancestor = target.parentElement;
    while (ancestor && ancestor !== document.body && distance < 6) {
      distance += 1;
      if (isActionable(ancestor)) {
        target = ancestor;
        strategy = 'actionable-ancestor';
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  if (strategy === 'self' && !isActionable(target)) {
    let cursor: Element = target;
    let descendantDistance = 0;
    while (cursor.children.length === 1) {
      const child = cursor.children[0];
      if (!child || child.nodeType !== 1) break;
      if (!(child.textContent || '').trim()) break;
      cursor = child;
      descendantDistance += 1;
    }
    if (cursor !== target) {
      target = cursor;
      strategy = 'single-child-descendant';
      distance = descendantDistance;
    } else {
      distance = 0;
    }
  }

  function findClippingAncestor(node: Element, bounds: DOMRect): Element | null {
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      const style = getComputedStyle(ancestor);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || '');
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || '');
      if (clipsX || clipsY) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const centerX = (bounds.left + bounds.right) / 2;
        const centerY = (bounds.top + bounds.bottom) / 2;
        const clippedX =
          clipsX && (centerX < ancestorRect.left - 0.5 || centerX > ancestorRect.right + 0.5);
        const clippedY =
          clipsY && (centerY < ancestorRect.top - 0.5 || centerY > ancestorRect.bottom + 0.5);
        if (clippedX || clippedY) return ancestor;
      }
      if (style.position === 'fixed') break;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  let rect = target.getBoundingClientRect();
  let clippingAncestor = findClippingAncestor(target, rect);
  if (
    rect.top < 0 ||
    rect.left < 0 ||
    rect.bottom > window.innerHeight ||
    rect.right > window.innerWidth ||
    clippingAncestor
  ) {
    (target as HTMLElement).scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: 'instant',
    });
    rect = target.getBoundingClientRect();
    clippingAncestor = findClippingAncestor(target, rect);
  }

  if (clippingAncestor) {
    return {
      clicked: false,
      tag: target.tagName.toLowerCase(),
      text: (target.textContent || '').trim().slice(0, 100),
      cx: rect.x + rect.width / 2,
      cy: rect.y + rect.height / 2,
      strategy,
      distance,
      error:
        'page_click: target remains clipped by a scroll container or overflow ancestor (' +
        clippingAncestor.tagName.toLowerCase() +
        '). Refresh the snapshot or scroll the nearest container before retrying.',
    };
  }

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  let hitTarget: Element | null = null;
  try {
    hitTarget = document.elementFromPoint(cx, cy);
    const visited = new Set<Element>();
    while (hitTarget?.shadowRoot?.elementFromPoint && !visited.has(hitTarget)) {
      visited.add(hitTarget);
      const inner = hitTarget.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === hitTarget) break;
      hitTarget = inner;
    }
  } catch {}
  let composedHit: any = hitTarget;
  while (composedHit && composedHit !== target) {
    composedHit = composedHit.parentElement || composedHit.getRootNode?.().host;
  }
  if (
    hitTarget &&
    !composedHit &&
    hitTarget !== target &&
    !target.contains(hitTarget) &&
    !hitTarget.contains(target)
  ) {
    return {
      clicked: false,
      tag: target.tagName.toLowerCase(),
      text: (target.textContent || '').trim().slice(0, 100),
      cx,
      cy,
      strategy,
      distance,
      error:
        'page_click: target is covered by another element (' +
        hitTarget.tagName.toLowerCase() +
        '). Refresh the snapshot or inspect hitTest.occludedBy before retrying.',
    };
  }

  if (target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') {
    return {
      clicked: false,
      tag: target.tagName.toLowerCase(),
      text: (target.textContent || '').trim().slice(0, 100),
      cx,
      cy,
      strategy,
      distance,
      error: 'page_click: target is disabled.',
    };
  }

  // Touch + click for mobile H5 frameworks
  try {
    const touch = new Touch({ identifier: Date.now(), target: target, clientX: cx, clientY: cy });
    target.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchend', {
        touches: [],
        targetTouches: [],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }),
    );
  } catch {}

  // Custom controls often open on mousedown; HTMLElement.click() only emits click.
  const mouseInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  const pointerInit = { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  let dispatchMouse = true;
  if (typeof PointerEvent === 'function') {
    dispatchMouse = target.dispatchEvent(
      new PointerEvent('pointerdown', { ...pointerInit, buttons: 1 }),
    );
  }
  if (dispatchMouse) {
    const focusAllowed = target.dispatchEvent(
      new MouseEvent('mousedown', { ...mouseInit, buttons: 1 }),
    );
    if (focusAllowed) {
      const focusTarget = target.closest(
        'button, input, select, textarea, a[href], [tabindex], [role="combobox"]',
      ) as HTMLElement | null;
      focusTarget?.focus({ preventScroll: true });
    }
  }
  if (typeof PointerEvent === 'function') {
    target.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
  }
  if (dispatchMouse) {
    target.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
  }

  let controlState: PageClickControlState | undefined;
  const input = target.tagName === 'INPUT' ? (target as HTMLInputElement) : undefined;
  const controlType =
    input && /^(checkbox|radio)$/i.test(input.type) ? input.type.toLowerCase() : '';
  if (input && (controlType === 'checkbox' || controlType === 'radio')) {
    const checkedBefore = input.checked;
    input.click();
    controlState = {
      type: controlType,
      checkedBefore,
      checkedAfter: input.checked,
    };
  } else {
    (target as HTMLElement).click();
  }

  return {
    clicked: true,
    tag: target.tagName.toLowerCase(),
    text: (target.textContent || '').trim().slice(0, 100),
    cx: cx,
    cy: cy,
    strategy,
    distance,
    ...(controlState ? { controlState } : {}),
  };
}

/**
 * 获取元素坐标（用于 CDP 真实事件派发路径）。通过 querySelector 定位后返回中心点。
 */
export function getClickCoordsFromSelector(
  selector: string,
  invalidSelectorHint: string,
): {
  x: number;
  y: number;
  tag: string;
  text: string;
  inputType?: string;
  strategy?: PageClickTargetStrategy;
  distance?: number;
  sourceTarget?: { tag: string; text: string };
  actionableAncestorCandidates?: PageClickAncestorCandidate[];
  error?: string;
} {
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch (e) {
    return {
      x: 0,
      y: 0,
      tag: '',
      text: '',
      error:
        'Invalid CSS selector "' +
        selector +
        '": ' +
        (e as Error).message +
        '. ' +
        invalidSelectorHint,
    };
  }
  if (!element) {
    return {
      x: 0,
      y: 0,
      tag: '',
      text: '',
      error: 'Element not found: ' + selector,
    };
  }

  const sourceTarget = {
    tag: element.tagName.toLowerCase(),
    text: (element.textContent || '').trim().slice(0, 100),
  };

  function isActionable(node: Element): boolean {
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|DETAILS|LABEL)$/i.test(node.tagName)) {
      return true;
    }
    if (
      /button|link|tab|menuitem|checkbox|radio|option|switch/i.test(node.getAttribute('role') || '')
    ) {
      return true;
    }
    if (
      (node as HTMLElement).isContentEditable ||
      typeof (node as HTMLElement).onclick === 'function'
    ) {
      return true;
    }
    const tabIndexAttribute = node.getAttribute('tabindex');
    if (tabIndexAttribute === null) return false;
    const tabIndex = Number(tabIndexAttribute);
    return Number.isFinite(tabIndex) && tabIndex >= 0;
  }

  let target = element;
  let strategy: PageClickTargetStrategy = 'self';
  let distance = 0;

  // Virtual listboxes expose zero-size AX options beside their visible option surfaces.
  const listbox: Element | null =
    target.getAttribute('role') === 'option' ? target.closest('[role="listbox"]') : null;
  const listboxRect = listbox?.getBoundingClientRect();
  if (listbox && listboxRect && listboxRect.width <= 1 && listboxRect.height <= 1) {
    const popup = listbox.parentElement;
    const normalize = (value: unknown): string =>
      String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');
    const name = normalize(target.getAttribute('aria-label') || target.textContent);
    const candidates = popup?.querySelectorAll('[aria-selected], [role="option"]');
    const matches =
      popup && popup !== document.body && name && candidates && candidates.length <= 1000
        ? Array.from(candidates).filter(candidate => {
            if (listbox.contains(candidate)) return false;
            const candidateName = normalize(
              candidate.getAttribute('aria-label') ||
                candidate.getAttribute('title') ||
                candidate.textContent,
            );
            if (candidateName !== name) return false;
            const bounds = candidate.getBoundingClientRect();
            if (bounds.width <= 1 || bounds.height <= 1) return false;
            let ancestor: Element | null = candidate;
            while (ancestor) {
              const style = getComputedStyle(ancestor);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse' ||
                style.opacity === '0'
              )
                return false;
              if (ancestor === popup) break;
              ancestor = ancestor.parentElement;
            }
            return true;
          })
        : [];
    if (matches.length === 1 && matches[0].getAttribute('aria-disabled') !== 'true') {
      target = matches[0];
      strategy = 'accessible-option';
    }
  }
  if (strategy === 'self' && !isActionable(target)) {
    let ancestor = target.parentElement;
    while (ancestor && ancestor !== document.body && distance < 6) {
      distance += 1;
      if (isActionable(ancestor)) {
        target = ancestor;
        strategy = 'actionable-ancestor';
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (strategy === 'self') distance = 0;
  }

  const actionableAncestorCandidates: PageClickAncestorCandidate[] = [];
  if (strategy === 'self' && !isActionable(target)) {
    const sourceRect = element.getBoundingClientRect();
    let ancestor = element.parentElement;
    let candidateDistance = 0;
    while (ancestor && ancestor !== document.body && candidateDistance < 6) {
      candidateDistance += 1;
      const rect = ancestor.getBoundingClientRect();
      const style = getComputedStyle(ancestor);
      const reason =
        style.cursor === 'pointer'
          ? 'cursor-pointer'
          : rect.width * rect.height > sourceRect.width * sourceRect.height * 1.5
            ? 'containing-block'
            : null;
      if (reason) {
        const escapeCss = (value: string): string =>
          globalThis.CSS && typeof globalThis.CSS.escape === 'function'
            ? globalThis.CSS.escape(value)
            : value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
        let candidateSelector = ancestor.id ? `#${escapeCss(ancestor.id)}` : '';
        if (!candidateSelector) {
          const path: string[] = [];
          let cursor: Element | null = ancestor;
          while (cursor && cursor !== document.documentElement && path.length < 5) {
            const parent: Element | null = cursor.parentElement;
            const tag = cursor.tagName.toLowerCase();
            if (!parent) {
              path.unshift(tag);
              break;
            }
            const siblings: Element[] = Array.from(parent.children).filter(
              item => item.tagName === cursor!.tagName,
            );
            const index = siblings.indexOf(cursor) + 1;
            path.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
            cursor = parent;
          }
          candidateSelector = path.join(' > ');
        }
        if (candidateSelector) {
          actionableAncestorCandidates.push({
            selector: candidateSelector,
            tag: ancestor.tagName.toLowerCase(),
            text: (ancestor.textContent || '').trim().slice(0, 100),
            distance: candidateDistance,
            reason,
          });
        }
      }
      if (actionableAncestorCandidates.length >= 3) break;
      ancestor = ancestor.parentElement;
    }
  }

  function findClippingAncestor(node: Element, bounds: DOMRect): Element | null {
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      const style = getComputedStyle(ancestor);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || '');
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || '');
      if (clipsX || clipsY) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const centerX = (bounds.left + bounds.right) / 2;
        const centerY = (bounds.top + bounds.bottom) / 2;
        const clippedX =
          clipsX && (centerX < ancestorRect.left - 0.5 || centerX > ancestorRect.right + 0.5);
        const clippedY =
          clipsY && (centerY < ancestorRect.top - 0.5 || centerY > ancestorRect.bottom + 0.5);
        if (clippedX || clippedY) return ancestor;
      }
      if (style.position === 'fixed') break;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  let rect = target.getBoundingClientRect();
  let clippingAncestor = findClippingAncestor(target, rect);
  if (
    rect.top < 0 ||
    rect.left < 0 ||
    rect.bottom > window.innerHeight ||
    rect.right > window.innerWidth ||
    clippingAncestor
  ) {
    (target as HTMLElement).scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: 'instant',
    });
    rect = target.getBoundingClientRect();
    clippingAncestor = findClippingAncestor(target, rect);
  }

  if (clippingAncestor) {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      tag: target.tagName.toLowerCase(),
      text: (target.textContent || '').trim().slice(0, 100),
      strategy,
      distance,
      sourceTarget,
      error:
        'page_click: target remains clipped by a scroll container or overflow ancestor (' +
        clippingAncestor.tagName.toLowerCase() +
        '). Refresh the snapshot or scroll the nearest container before retrying.',
    };
  }

  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  let hitTarget: Element | null = null;
  try {
    hitTarget = document.elementFromPoint(x, y);
    const visited = new Set<Element>();
    while (hitTarget?.shadowRoot?.elementFromPoint && !visited.has(hitTarget)) {
      visited.add(hitTarget);
      const inner = hitTarget.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hitTarget) break;
      hitTarget = inner;
    }
  } catch {}
  let composedHit: any = hitTarget;
  while (composedHit && composedHit !== target) {
    composedHit = composedHit.parentElement || composedHit.getRootNode?.().host;
  }
  if (
    hitTarget &&
    !composedHit &&
    hitTarget !== target &&
    !target.contains(hitTarget) &&
    !hitTarget.contains(target)
  ) {
    return {
      x,
      y,
      tag: target.tagName.toLowerCase(),
      text: (target.textContent || '').trim().slice(0, 100),
      strategy,
      distance,
      sourceTarget,
      error:
        'page_click: target is covered by another element (' +
        hitTarget.tagName.toLowerCase() +
        '). Refresh the snapshot or inspect hitTest.occludedBy before retrying.',
    };
  }

  return {
    x,
    y,
    tag: target.tagName.toLowerCase(),
    text: (target.textContent || '').trim().slice(0, 100),
    ...(target.tagName === 'INPUT'
      ? { inputType: ((target as HTMLInputElement).type || '').toLowerCase() }
      : {}),
    strategy,
    distance,
    sourceTarget,
    ...(actionableAncestorCandidates.length > 0 ? { actionableAncestorCandidates } : {}),
  };
}

/**
 * 通过 callFunctionOn 获取 backendNode 的坐标（含 drill-down）。
 * 用于 CDP 真实事件派发路径（clickAtBackendNode）。
 */
export function getClickCoordsFromNode(
  this: any,
  expectedText?: string,
): {
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
} | null {
  const el = this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.isConnected || !el.getBoundingClientRect) return null;
  const sourceTarget = {
    tag: el.tagName ? el.tagName.toLowerCase() : '',
    text: (el.textContent || '').trim().slice(0, 100),
  };

  function isActionable(node: any): boolean {
    if (!node || node.nodeType !== 1) return false;
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|DETAILS|LABEL)$/i.test(node.tagName)) {
      return true;
    }
    if (
      /button|link|tab|menuitem|checkbox|radio|option|switch/i.test(node.getAttribute('role') || '')
    ) {
      return true;
    }
    if (node.isContentEditable || typeof node.onclick === 'function') return true;
    const tabIndexAttribute = node.getAttribute('tabindex');
    if (tabIndexAttribute === null) return false;
    const tabIndex = Number(tabIndexAttribute);
    return Number.isFinite(tabIndex) && tabIndex >= 0;
  }

  function normalizeText(value: unknown): string {
    return String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  let target = el;
  let exactTextNode: any = null;
  let strategy: PageClickTargetStrategy = 'self';
  let distance = 0;

  // Virtual listboxes expose zero-size AX options beside their visible option surfaces.
  const listbox: Element | null =
    target.getAttribute('role') === 'option' ? target.closest('[role="listbox"]') : null;
  const listboxRect = listbox?.getBoundingClientRect();
  if (listbox && listboxRect && listboxRect.width <= 1 && listboxRect.height <= 1) {
    const popup = listbox.parentElement;
    const normalize = (value: unknown): string =>
      String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');
    const name = normalize(target.getAttribute('aria-label') || target.textContent);
    const candidates = popup?.querySelectorAll('[aria-selected], [role="option"]');
    const matches =
      popup && popup !== document.body && name && candidates && candidates.length <= 1000
        ? Array.from(candidates).filter(candidate => {
            if (listbox.contains(candidate)) return false;
            const candidateName = normalize(
              candidate.getAttribute('aria-label') ||
                candidate.getAttribute('title') ||
                candidate.textContent,
            );
            if (candidateName !== name) return false;
            const bounds = candidate.getBoundingClientRect();
            if (bounds.width <= 1 || bounds.height <= 1) return false;
            let ancestor: Element | null = candidate;
            while (ancestor) {
              const style = getComputedStyle(ancestor);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse' ||
                style.opacity === '0'
              )
                return false;
              if (ancestor === popup) break;
              ancestor = ancestor.parentElement;
            }
            return true;
          })
        : [];
    if (matches.length === 1 && matches[0].getAttribute('aria-disabled') !== 'true') {
      target = matches[0];
      strategy = 'accessible-option';
    }
  }
  const normalizedExpectedText = normalizeText(expectedText);
  if (normalizedExpectedText && normalizeText(target.textContent) !== normalizedExpectedText) {
    const descendants = Array.from(target.querySelectorAll?.('*') ?? []);
    const exactMatches = descendants.filter(
      (candidate: any) => normalizeText(candidate.textContent) === normalizedExpectedText,
    );
    const exactTarget = exactMatches.find(
      (candidate: any) =>
        !Array.from(candidate.children ?? []).some(
          (child: any) => normalizeText(child.textContent) === normalizedExpectedText,
        ),
    );
    if (exactTarget) {
      target = exactTarget;
      strategy = 'exact-text-descendant';
      let cursor = target;
      while (cursor && cursor !== el && distance < 20) {
        distance += 1;
        cursor = cursor.parentElement;
      }
    } else {
      const pending = Array.from(target.childNodes ?? []);
      for (let index = 0; index < pending.length && index < 10_000; index += 1) {
        const candidate: any = pending[index];
        if (
          candidate?.nodeType === 3 &&
          normalizeText(candidate.textContent) === normalizedExpectedText
        ) {
          exactTextNode = candidate;
          target = candidate.parentElement ?? target;
          strategy = 'exact-text-descendant';
          let cursor = target;
          while (cursor && cursor !== el && distance < 20) {
            distance += 1;
            cursor = cursor.parentElement;
          }
          break;
        }
        if (candidate?.nodeType === 1) pending.push(...Array.from(candidate.childNodes ?? []));
      }
    }
  }
  if (strategy === 'self' && !isActionable(target)) {
    let ancestor = target.parentElement;
    while (ancestor && ancestor !== document.body && distance < 6) {
      distance += 1;
      if (isActionable(ancestor)) {
        target = ancestor;
        strategy = 'actionable-ancestor';
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  if (strategy === 'self' && !isActionable(target)) {
    let cursor = target;
    let descendantDistance = 0;
    while (cursor.children.length === 1) {
      const child = cursor.children[0];
      if (!child || child.nodeType !== 1) break;
      if (!(child.textContent || '').trim()) break;
      cursor = child;
      descendantDistance += 1;
    }
    if (cursor !== target) {
      target = cursor;
      strategy = 'single-child-descendant';
      distance = descendantDistance;
    } else {
      distance = 0;
    }
  }

  function findClippingAncestor(node: any, bounds: any): any {
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      const style = getComputedStyle(ancestor);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || '');
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || '');
      if (clipsX || clipsY) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const centerX = (bounds.left + bounds.right) / 2;
        const centerY = (bounds.top + bounds.bottom) / 2;
        const clippedX =
          clipsX && (centerX < ancestorRect.left - 0.5 || centerX > ancestorRect.right + 0.5);
        const clippedY =
          clipsY && (centerY < ancestorRect.top - 0.5 || centerY > ancestorRect.bottom + 0.5);
        if (clippedX || clippedY) return ancestor;
      }
      if (style.position === 'fixed') break;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  const actionableAncestorCandidates: PageClickAncestorCandidate[] = [];
  if (strategy === 'self' && !isActionable(target)) {
    const sourceRect = el.getBoundingClientRect();
    let ancestor = el.parentElement;
    let candidateDistance = 0;
    while (ancestor && ancestor !== document.body && candidateDistance < 6) {
      candidateDistance += 1;
      const rect = ancestor.getBoundingClientRect();
      const style = getComputedStyle(ancestor);
      const reason =
        style.cursor === 'pointer'
          ? 'cursor-pointer'
          : rect.width * rect.height > sourceRect.width * sourceRect.height * 1.5
            ? 'containing-block'
            : null;
      if (reason) {
        const escapeCss = (value: string): string =>
          globalThis.CSS && typeof globalThis.CSS.escape === 'function'
            ? globalThis.CSS.escape(value)
            : value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
        let candidateSelector = ancestor.id ? `#${escapeCss(ancestor.id)}` : '';
        if (!candidateSelector) {
          const path: string[] = [];
          let cursor: Element | null = ancestor;
          while (cursor && cursor !== document.documentElement && path.length < 5) {
            const parent: Element | null = cursor.parentElement;
            const tag = cursor.tagName.toLowerCase();
            if (!parent) {
              path.unshift(tag);
              break;
            }
            const siblings: Element[] = Array.from(parent.children).filter(
              item => item.tagName === cursor!.tagName,
            );
            const index = siblings.indexOf(cursor) + 1;
            path.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
            cursor = parent;
          }
          candidateSelector = path.join(' > ');
        }
        if (candidateSelector) {
          actionableAncestorCandidates.push({
            selector: candidateSelector,
            tag: ancestor.tagName.toLowerCase(),
            text: (ancestor.textContent || '').trim().slice(0, 100),
            distance: candidateDistance,
            reason,
          });
        }
      }
      if (actionableAncestorCandidates.length >= 3) break;
      ancestor = ancestor.parentElement;
    }
  }

  let rect = target.getBoundingClientRect();
  let clippingAncestor = findClippingAncestor(target, rect);
  if (
    rect.top < 0 ||
    rect.left < 0 ||
    rect.bottom > window.innerHeight ||
    rect.right > window.innerWidth ||
    clippingAncestor
  ) {
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    rect = target.getBoundingClientRect();
    clippingAncestor = findClippingAncestor(target, rect);
  }
  if (exactTextNode) {
    try {
      const range = document.createRange();
      range.selectNodeContents(exactTextNode);
      const textRect = range.getBoundingClientRect();
      if (textRect.width > 0 && textRect.height > 0) rect = textRect;
    } catch {}
  }

  if (clippingAncestor) {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      tag: target.tagName ? target.tagName.toLowerCase() : '',
      text: (target.textContent || '').trim().slice(0, 100),
      ...(target.tagName === 'INPUT' ? { inputType: String(target.type || '').toLowerCase() } : {}),
      strategy,
      distance,
      sourceTarget,
      error:
        'page_click: target remains clipped by a scroll container or overflow ancestor (' +
        String(clippingAncestor.tagName || '').toLowerCase() +
        '). Refresh the snapshot or scroll the nearest container before retrying.',
    };
  }

  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  let hitTarget: any = null;
  try {
    hitTarget = document.elementFromPoint(x, y);
    const visited = new Set<Element>();
    while (hitTarget?.shadowRoot?.elementFromPoint && !visited.has(hitTarget)) {
      visited.add(hitTarget);
      const inner = hitTarget.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hitTarget) break;
      hitTarget = inner;
    }
  } catch {}
  let composedHit: any = hitTarget;
  while (composedHit && composedHit !== target) {
    composedHit = composedHit.parentElement || composedHit.getRootNode?.().host;
  }
  if (
    hitTarget &&
    !composedHit &&
    hitTarget !== target &&
    !target.contains?.(hitTarget) &&
    !hitTarget.contains?.(target)
  ) {
    return {
      x,
      y,
      tag: target.tagName ? target.tagName.toLowerCase() : '',
      text: (target.textContent || '').trim().slice(0, 100),
      ...(target.tagName === 'INPUT' ? { inputType: String(target.type || '').toLowerCase() } : {}),
      strategy,
      distance,
      sourceTarget,
      error:
        'page_click: target is covered by another element (' +
        String(hitTarget.tagName || '').toLowerCase() +
        '). Refresh the snapshot or inspect hitTest.occludedBy before retrying.',
    };
  }

  return {
    x,
    y,
    tag: target.tagName ? target.tagName.toLowerCase() : '',
    text: (target.textContent || '').trim().slice(0, 100),
    ...(target.tagName === 'INPUT' ? { inputType: String(target.type || '').toLowerCase() } : {}),
    strategy,
    distance,
    sourceTarget,
    ...(actionableAncestorCandidates.length > 0 ? { actionableAncestorCandidates } : {}),
  };
}

/**
 * 在页面指定坐标显示点击可视化指示器。
 * 设计用于 chrome.scripting.executeScript 注入执行。
 *
 * @param px - 视口 X 坐标
 * @param py - 视口 Y 坐标
 * @param mode - 'js' = 蓝色, 'cdp' = 红色
 */
export function showClickIndicator(px: number, py: number, mode: string): void {
  const color = mode === 'js' ? 'rgba(59,130,246,0.8)' : 'rgba(239,68,68,0.8)';
  const ring = mode === 'js' ? 'rgba(59,130,246,0.3)' : 'rgba(239,68,68,0.3)';
  const dot = document.createElement('div');
  dot.setAttribute('data-mearl-overlay', 'click-indicator');
  dot.style.cssText =
    'position:fixed; left:' +
    px +
    'px; top:' +
    py +
    'px; width:12px; height:12px;' +
    'margin-left:-6px; margin-top:-6px; border-radius:50%;' +
    'background:' +
    color +
    '; box-shadow:0 0 0 4px ' +
    ring +
    ';' +
    'pointer-events:none; z-index:2147483647;' +
    'animation:__mearl_click_fade 600ms ease-out forwards;';
  if (!document.getElementById('__mearl_click_style')) {
    const style = document.createElement('style');
    style.id = '__mearl_click_style';
    style.textContent =
      '@keyframes __mearl_click_fade {' +
      '0% { opacity:1; transform:scale(1); }' +
      '50% { opacity:0.8; transform:scale(1.8); }' +
      '100% { opacity:0; transform:scale(2.2); }' +
      '}';
    document.head.appendChild(style);
  }
  document.body.appendChild(dot);
  setTimeout(function () {
    dot.remove();
  }, 700);
}
