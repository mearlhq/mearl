/**
 * Page-side action observer shared by the extension and Native CDP backend.
 *
 * The installer is serialized with `toString()` and executed in the target page,
 * so every runtime dependency must stay inside the function body. It deliberately
 * reports only high-confidence browser signals instead of approximating an AX tree.
 */

import type { PageObservationWaitOptions } from './browserActionProtocol.js';

export interface PageEffectNode {
  ref?: string;
  selector: string;
  tag: string;
  role?: string;
  name?: string;
  value?: string;
  focused?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
}

export interface PageInteractiveEffect {
  change: 'appeared' | 'updated' | 'recreated';
  node: PageEffectNode;
}

export interface PageNotificationEffect {
  change: 'appeared' | 'updated' | 'disappeared' | 'transient';
  node: PageEffectNode;
  appearedAt?: number;
  disappearedAt?: number;
  duration?: number;
}

export interface PageTextEffect {
  selector: string;
  text: string;
}

export interface PageEffects {
  notifications: PageNotificationEffect[];
  interactives: PageInteractiveEffect[];
  /** Current text of bounded, visible leaf elements; these are not actionable controls. */
  texts?: PageTextEffect[];
  focus?: PageEffectNode;
}

export interface PageNetworkSettlingResult {
  ready: boolean;
  settledBy: 'network-idle' | 'timeout' | 'unavailable';
  pendingRequests: number;
  elapsed: number;
}

export interface PageReadinessSample {
  ready: boolean;
  meaningful: boolean;
  skeletonVisible: boolean;
  quietFor: number;
  textLength: number;
  interactiveCount: number;
}

export interface PageOpenedTab {
  tabId: number;
  openerTabId: number;
  url: string;
  title: string;
  active?: boolean;
  ready: boolean;
  settledBy: 'load' | 'timeout';
}

export type PageSnapshotReason =
  | 'navigation'
  | 'observer-unavailable'
  | 'observation-timeout'
  | 'observation-overflow'
  | 'unclassified-structure'
  | 'network-pending';

export interface PageChangeSet {
  mode: 'delta';
  scope: 'main-document';
  checkpoint: number;
  version: number;
  elapsed: number;
  settledBy: 'quiet' | 'no-change' | 'timeout';
  url: string;
  title: string;
  changed: boolean;
  effects: PageEffects;
  mutationCount: number;
  overflow: boolean;
  fullSnapshotRecommended: boolean;
  snapshotReasons: PageSnapshotReason[];
  network?: PageNetworkSettlingResult;
  openedTabs?: PageOpenedTab[];
}

export interface PageObservationCheckpoint {
  version: number;
  url: string;
  title: string;
  focus?: string;
}

export function resolvePageObservationWaitOptions(options: PageObservationWaitOptions = {}): {
  quietMs: number;
  firstChangeTimeoutMs: number;
  timeoutMs: number;
} {
  const quietMs = Math.min(Math.max(options.quietMs ?? 100, 20), 2000);
  const firstChangeTimeoutMs = Math.min(
    Math.max(options.firstChangeTimeoutMs ?? 500, quietMs),
    10000,
  );
  return {
    quietMs,
    firstChangeTimeoutMs,
    timeoutMs: Math.min(Math.max(options.timeoutMs ?? 3000, firstChangeTimeoutMs), 30000),
  };
}

export interface PageNavigationChange {
  mode: 'navigation';
  urlBefore: string;
  urlAfter: string;
  title: string;
  elapsed: number;
  loaded: boolean;
  ready: boolean;
  settledBy: 'load' | 'network-idle' | 'content-stable' | 'timeout';
  pendingRequests: number;
  content?: PageReadinessSample;
  fullSnapshotRecommended: true;
  snapshotReasons: ['navigation'];
  openedTabs?: PageOpenedTab[];
}

export type PageObservationResult = PageChangeSet | PageNavigationChange;

export function shouldWaitForPotentialNavigation(
  action: string,
  observation: {
    mode?: string;
    settledBy?: string;
    mutationCount?: number;
    effects?: Partial<PageEffects>;
  },
): boolean {
  if (action !== 'page_click' && action !== 'page_press') return false;
  if (observation.mode !== 'delta' || observation.settledBy !== 'quiet') return true;
  const hasEffect =
    (observation.effects?.notifications?.length ?? 0) > 0 ||
    (observation.effects?.interactives?.length ?? 0) > 0 ||
    observation.effects?.focus !== undefined;
  return !hasEffect && (observation.mutationCount ?? 0) <= 1;
}

export function isPotentialNavigationRequest(resourceType: string, _url = ''): boolean {
  const normalizedType = resourceType.toLowerCase();
  if (normalizedType === 'xhr' || normalizedType === 'fetch') return true;
  return false;
}

export function resolveNavigationWaitOptions(options: PageObservationWaitOptions = {}): {
  graceMs: number;
  timeoutMs: number;
  networkIdleMs: number;
  contentReadyAfterMs: number;
} {
  const timeoutMs = Math.min(Math.max(options.navigationTimeoutMs ?? 15000, 1000), 30000);
  const networkIdleMs = Math.min(Math.max(options.networkIdleMs ?? 500, 100), 3000);
  const maximumContentDelay = Math.max(0, timeoutMs - networkIdleMs - 250);
  const requestedContentDelay = options.contentReadyAfterMs ?? Math.min(5000, timeoutMs / 2);
  return {
    graceMs: Math.min(Math.max(options.navigationGraceMs ?? 1000, 0), 5000),
    timeoutMs,
    networkIdleMs,
    contentReadyAfterMs: Math.min(Math.max(requestedContentDelay, 0), maximumContentDelay),
  };
}

export function samplePageReadinessInPage(quietMs = 500): PageReadinessSample {
  const pageGlobal = globalThis as any;
  const globalKey = '__MEARL_READINESS_OBSERVER__';
  let state = pageGlobal[globalKey];
  const now = performance.now();
  if (!state || state.document !== document) {
    state = {
      document,
      lastMutation: now,
      observer: new MutationObserver(() => {
        state.lastMutation = performance.now();
      }),
    };
    const root = document.body ?? document.documentElement;
    if (root) {
      state.observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-busy', 'data-loading', 'class', 'hidden', 'style'],
      });
    }
    pageGlobal[globalKey] = state;
  }

  const isVisible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const visibleCount = (selector: string, limit: number): number => {
    let count = 0;
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!isVisible(element)) continue;
      count += 1;
      if (count >= limit) break;
    }
    return count;
  };

  const textLength = (document.body?.innerText ?? '').replace(/\s+/g, '').length;
  const interactiveCount = visibleCount(
    'a[href],button,input,select,textarea,[role="button"],[role="link"],[tabindex]',
    20,
  );
  const skeletonVisible =
    visibleCount(
      '[aria-busy="true"],[data-loading="true"],[class*="skeleton" i],[class*="shimmer" i]',
      1,
    ) > 0;
  const quietFor = Math.max(0, now - state.lastMutation);
  const meaningful = textLength >= 80 || interactiveCount >= 3;
  return {
    ready:
      document.readyState === 'complete' && meaningful && !skeletonVisible && quietFor >= quietMs,
    meaningful,
    skeletonVisible,
    quietFor: Math.round(quietFor * 1000) / 1000,
    textLength,
    interactiveCount,
  };
}

export function disposePageReadinessObserverInPage(): void {
  const pageGlobal = globalThis as any;
  const globalKey = '__MEARL_READINESS_OBSERVER__';
  const state = pageGlobal[globalKey];
  if (state?.document !== document) return;
  state.observer?.disconnect?.();
  delete pageGlobal[globalKey];
}

export function installPageObserverInPage(maxBatches = 50): PageObservationCheckpoint {
  const globalKey = '__MEARL_PAGE_OBSERVER__';
  const pageGlobal = globalThis as any;
  const existing = pageGlobal[globalKey];
  if (
    existing &&
    existing.schemaVersion === 7 &&
    existing.document === document &&
    existing.version >= 0
  ) {
    existing.captureBaseline?.();
    return {
      version: existing.version,
      url: location.href,
      title: document.title,
      focus: existing.selectorFor(document.activeElement),
    };
  }
  existing?.observer?.disconnect?.();

  const interactiveSelector = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[contenteditable="true"]',
    '[tabindex]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="textbox"]',
  ].join(',');
  const notificationSelector = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live]:not([aria-live="off"])',
    '[class*="toast" i]',
    '[class*="snackbar" i]',
  ].join(',');
  const recordBudget = 160;
  const signalLimit = 12;
  const notificationLimit = 8;
  const textLimit = 8;
  const lifecycleNodeIds = new WeakMap<Element, number>();
  const notificationVisibility = new WeakMap<Element, boolean>();
  let nextLifecycleNodeId = 1;

  const escapeCss = (value: string): string => {
    if (pageGlobal.CSS && typeof pageGlobal.CSS.escape === 'function') {
      return pageGlobal.CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
  };
  const escapeAttribute = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const isInternal = (input: Node | null): boolean => {
    const element =
      input?.nodeType === Node.ELEMENT_NODE ? (input as Element) : (input?.parentElement ?? null);
    return Boolean(element?.closest('[data-mearl-overlay], #__mearl_click_style'));
  };
  const isVisible = (element: Element): boolean => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    try {
      let current: Element | null = element;
      while (current) {
        const style = getComputedStyle(current);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.opacity === '0'
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    } catch {
      return true;
    }
  };
  const selectorFor = (input: Element | null): string | undefined => {
    if (!input || input === document.documentElement || input === document.body) return undefined;
    if (input.id) return `#${escapeCss(input.id)}`;
    const tag = input.tagName.toLowerCase();
    for (const attribute of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const value = input.getAttribute(attribute);
      if (value && value.length <= 80) {
        const candidate = `${tag}[${attribute}="${escapeAttribute(value)}"]`;
        try {
          if (!input.isConnected || document.querySelectorAll(candidate).length === 1) {
            return candidate;
          }
        } catch {}
      }
    }
    const path: string[] = [];
    let current: Element | null = input;
    while (current && current !== document.documentElement && path.length < 6) {
      const parent: Element | null = current.parentElement;
      const currentTag = current.tagName.toLowerCase();
      if (!parent) {
        path.unshift(currentTag);
        break;
      }
      const siblings = Array.from(parent.children).filter(
        item => item.tagName === current!.tagName,
      );
      const position = siblings.indexOf(current) + 1;
      path.unshift(siblings.length > 1 ? `${currentTag}:nth-of-type(${position})` : currentTag);
      const candidate = path.join(' > ');
      if (input.isConnected) {
        try {
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        } catch {}
      }
      current = parent;
    }
    return path.join(' > ') || undefined;
  };
  const inferredRole = (element: Element): string | undefined => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag !== 'input') return undefined;
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  };
  const ariaBoolean = (element: Element, name: string): boolean | undefined => {
    const value = element.getAttribute(name);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  };
  const describe = (element: Element | null): PageEffectNode | null => {
    if (!element || isInternal(element)) return null;
    const selector = selectorFor(element);
    if (!selector) return null;
    const tag = element.tagName.toLowerCase();
    const role = inferredRole(element);
    const inputType = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : '';
    const isPassword = tag === 'input' && inputType === 'password';
    const name = (
      element.getAttribute('aria-label') ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      (isPassword ? '' : element.textContent || '')
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    const valueElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const value =
      !isPassword && (tag === 'input' || tag === 'textarea' || tag === 'select')
        ? String(valueElement.value ?? '').slice(0, 160)
        : '';
    const checked =
      tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')
        ? (element as HTMLInputElement).checked
        : ariaBoolean(element, 'aria-checked');
    const disabled =
      element.hasAttribute('disabled') || ariaBoolean(element, 'aria-disabled') === true;
    const expanded = ariaBoolean(element, 'aria-expanded');
    return {
      selector,
      tag,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(value ? { value } : {}),
      ...(document.activeElement === element ? { focused: true } : {}),
      ...(checked !== undefined ? { checked } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(expanded !== undefined ? { expanded } : {}),
    };
  };
  const isInteractive = (element: Element): boolean => {
    try {
      return element.matches(interactiveSelector);
    } catch {
      return false;
    }
  };
  const isNotification = (element: Element): boolean => {
    try {
      return element.matches(notificationSelector);
    } catch {
      return false;
    }
  };
  const nearestNotification = (input: Node | null): Element | null => {
    const element =
      input?.nodeType === Node.ELEMENT_NODE ? (input as Element) : (input?.parentElement ?? null);
    return element?.closest(notificationSelector) ?? null;
  };
  const notificationId = (element: Element): number => {
    let id = lifecycleNodeIds.get(element);
    if (id === undefined) {
      id = nextLifecycleNodeId;
      nextLifecycleNodeId += 1;
      lifecycleNodeIds.set(element, id);
    }
    return id;
  };
  const candidates = (root: Node, selector: string): Element[] => {
    if (root.nodeType !== Node.ELEMENT_NODE) return [];
    const element = root as Element;
    const result: Element[] = [];
    try {
      if (element.matches(selector)) result.push(element);
      for (const descendant of Array.from(element.querySelectorAll(selector))) {
        result.push(descendant);
        if (result.length >= signalLimit) break;
      }
    } catch {}
    return result;
  };
  const collectUnclassifiedTexts = (
    root: Node,
    budget: { visited: number; truncated: boolean },
  ): string[] => {
    const texts: string[] = [];
    const visit = (node: Node): void => {
      if (budget.visited >= recordBudget) {
        budget.truncated = true;
        return;
      }
      if (isInternal(node)) return;
      budget.visited += 1;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        const text = node.textContent?.replace(/\s+/g, ' ').trim();
        if (text && parent && isVisible(parent)) texts.push(text.slice(0, 512));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (isInteractive(element) || isNotification(element)) return;
      for (const child of Array.from(node.childNodes)) visit(child);
    };
    visit(root);
    return texts;
  };

  const readPlainText = (element: Element): PageTextEffect | null => {
    try {
      if (
        !element.isConnected ||
        isInternal(element) ||
        !isVisible(element) ||
        element.closest(
          `${interactiveSelector},${notificationSelector},script,style,template,noscript`,
        ) ||
        element.childNodes.length > 1 ||
        (element.firstChild && element.firstChild.nodeType !== Node.TEXT_NODE)
      )
        return null;
      const style = getComputedStyle(element);
      const textSecurity = style.getPropertyValue('-webkit-text-security');
      if (textSecurity && textSecurity !== 'none') return null;
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 160) return null;
      let left = 0;
      let top = 0;
      let right = innerWidth;
      let bottom = innerHeight;
      const clippingOverflow = ['hidden', 'clip', 'scroll', 'auto'];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = ancestor === element ? style : getComputedStyle(ancestor);
        const clipsX = clippingOverflow.includes(ancestorStyle.overflowX);
        const clipsY = clippingOverflow.includes(ancestorStyle.overflowY);
        if (!clipsX && !clipsY) continue;
        const box = ancestor.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, box.left);
          right = Math.min(right, box.right);
        }
        if (clipsY) {
          top = Math.max(top, box.top);
          bottom = Math.min(bottom, box.bottom);
        }
      }
      // Text can be indented or clipped independently of its element's box.
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = text ? Array.from(range.getClientRects()) : [element.getBoundingClientRect()];
      if (rects.length === 0 || rects.length > 8) return null;
      for (const rect of rects) {
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.left < left ||
          rect.top < top ||
          rect.right > right ||
          rect.bottom > bottom
        )
          return null;
        const hit = document.elementFromPoint(
          (rect.left + rect.right) / 2,
          (rect.top + rect.bottom) / 2,
        );
        if (
          !hit ||
          (!element.contains(hit) && !(style.pointerEvents === 'none' && hit.contains(element)))
        )
          return null;
      }
      const selector = selectorFor(element);
      if (!selector || selector.length > 512) return null;
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1 || matches[0] !== element) return null;
      return { selector, text };
    } catch {
      return null;
    }
  };

  const captureInteractiveBaseline = (): Map<string, PageEffectNode> => {
    const baseline = new Map<string, PageEffectNode>();
    let visited = 0;
    for (const element of Array.from(document.querySelectorAll(interactiveSelector))) {
      if (visited >= recordBudget) break;
      visited += 1;
      if (!isVisible(element)) continue;
      const node = describe(element);
      if (node) baseline.set(node.selector, node);
    }
    return baseline;
  };

  const sameInteractiveState = (left: PageEffectNode, right: PageEffectNode): boolean =>
    left.tag === right.tag &&
    left.role === right.role &&
    left.name === right.name &&
    left.value === right.value &&
    left.checked === right.checked &&
    left.disabled === right.disabled &&
    left.expanded === right.expanded;

  const compactUnchangedRecreation = (
    effect: PageInteractiveEffect,
    baseline: Map<string, PageEffectNode> | undefined,
  ): PageInteractiveEffect => {
    if (effect.change !== 'appeared' && effect.change !== 'recreated') return effect;
    const previous = baseline?.get(effect.node.selector);
    if (!previous || !sameInteractiveState(previous, effect.node)) return effect;
    return {
      change: 'recreated',
      node: {
        selector: effect.node.selector,
        tag: effect.node.tag,
        ...(effect.node.role ? { role: effect.node.role } : {}),
        ...(effect.node.name ? { name: effect.node.name } : {}),
      },
    };
  };

  for (const notification of Array.from(document.querySelectorAll(notificationSelector))) {
    notificationVisibility.set(notification, isVisible(notification));
    notificationId(notification);
  }
  const state: any = {
    schemaVersion: 7,
    document,
    version: 0,
    batches: [],
    lastChangeAt: performance.now(),
    listeners: new Set<() => void>(),
    selectorFor,
  };
  state.captureBaseline = () => {
    state.baselineVersion = state.version;
    state.baseline = captureInteractiveBaseline();
  };
  state.captureBaseline();

  const observer = new MutationObserver(records => {
    const notifications: Array<{
      nodeId: number;
      phase: 'appeared' | 'updated' | 'disappeared';
      node: PageEffectNode;
      at: number;
    }> = [];
    const interactives: PageInteractiveEffect[] = [];
    const texts = new Map<Element, PageTextEffect>();
    let mutationCount = 0;
    let structuralMutationCount = 0;
    let unclassifiedStructuralMutationCount = 0;
    let unclassifiedNonTextMutationCount = 0;
    let overflow = records.length > recordBudget;
    let processedNodes = 0;
    const removedInteractiveCounts = new Map<string, number>();
    const addedTextCounts = new Map<string, number>();
    const removedTextCounts = new Map<string, number>();
    const unclassifiedTraversalBudget = { visited: 0, truncated: false };

    const addTextCounts = (counts: Map<string, number>, texts: string[]): void => {
      for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    };

    const interactiveSemanticKey = (node: PageEffectNode): string =>
      [node.tag, node.role || '', node.name || ''].join('\u0000');

    for (const record of records.slice(0, recordBudget)) {
      if (record.type !== 'childList' || isInternal(record.target)) continue;
      for (const removedNode of Array.from(record.removedNodes)) {
        if (isInternal(removedNode)) continue;
        for (const interactive of candidates(removedNode, interactiveSelector)) {
          const node = describe(interactive);
          if (!node || (!node.role && !node.name)) continue;
          const key = interactiveSemanticKey(node);
          removedInteractiveCounts.set(key, (removedInteractiveCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const pushNotification = (
      element: Element,
      phase: 'appeared' | 'updated' | 'disappeared',
    ): boolean => {
      const node = describe(element);
      if (!node || notifications.length >= notificationLimit * 3) return false;
      notifications.push({ nodeId: notificationId(element), phase, node, at: performance.now() });
      return true;
    };
    const pushInteractive = (
      element: Element,
      change: PageInteractiveEffect['change'],
    ): boolean => {
      if (interactives.length >= signalLimit || !isVisible(element)) return false;
      const node = describe(element);
      if (!node) return false;
      let resolvedChange = change;
      if (change === 'appeared') {
        const key = interactiveSemanticKey(node);
        const removedCount = removedInteractiveCounts.get(key) ?? 0;
        if (removedCount > 0) {
          resolvedChange = 'recreated';
          if (removedCount === 1) removedInteractiveCounts.delete(key);
          else removedInteractiveCounts.set(key, removedCount - 1);
        }
      }
      interactives.push({ change: resolvedChange, node });
      return true;
    };

    const pushTextUpdate = (input: Node): boolean => {
      const notification = nearestNotification(input);
      const element =
        input.nodeType === Node.ELEMENT_NODE ? (input as Element) : input.parentElement;
      if (!element?.isConnected || !isVisible(element)) return false;
      const target = notification ?? element.closest(interactiveSelector);
      if (!target?.isConnected || !isVisible(target)) return false;
      // Overridden or truncated names do not account for all changed text.
      const text = target.textContent?.replace(/\s+/g, ' ').trim();
      if (!text || text.length > 160 || describe(target)?.name !== text) return false;
      return notification
        ? pushNotification(target, 'updated')
        : pushInteractive(target, 'updated');
    };

    const pushPlainTextUpdate = (input: Node): boolean => {
      const element =
        input.nodeType === Node.ELEMENT_NODE ? (input as Element) : input.parentElement;
      if (!element) return false;
      if (texts.has(element)) return true;
      if (texts.size >= textLimit) {
        overflow = true;
        return false;
      }
      const effect = readPlainText(element);
      if (!effect) return false;
      texts.set(element, effect);
      return true;
    };

    for (const record of records.slice(0, recordBudget)) {
      if (isInternal(record.target)) continue;
      if (record.type === 'childList') {
        const addedNodes = Array.from(record.addedNodes).filter(node => !isInternal(node));
        const removedNodes = Array.from(record.removedNodes).filter(node => !isInternal(node));
        if (addedNodes.length === 0 && removedNodes.length === 0) continue;
        mutationCount += 1;
        structuralMutationCount += 1;
        if (
          [...addedNodes, ...removedNodes].every(node => node.nodeType === Node.TEXT_NODE) &&
          (pushTextUpdate(record.target) || pushPlainTextUpdate(record.target))
        )
          continue;
        let classified = false;
        for (const node of addedNodes) {
          if (processedNodes >= recordBudget) {
            overflow = true;
            break;
          }
          processedNodes += 1;
          for (const notification of candidates(node, notificationSelector)) {
            if (!isVisible(notification)) continue;
            notificationVisibility.set(notification, true);
            classified = pushNotification(notification, 'appeared') || classified;
          }
          for (const interactive of candidates(node, interactiveSelector)) {
            classified = pushInteractive(interactive, 'appeared') || classified;
          }
        }
        for (const node of removedNodes) {
          if (processedNodes >= recordBudget) {
            overflow = true;
            break;
          }
          processedNodes += 1;
          for (const notification of candidates(node, notificationSelector)) {
            notificationVisibility.set(notification, false);
            classified = pushNotification(notification, 'disappeared') || classified;
          }
        }
        const notification = nearestNotification(record.target);
        if (notification && isVisible(notification)) {
          classified = pushNotification(notification, 'updated') || classified;
        }
        const addedTexts = addedNodes.flatMap(node =>
          collectUnclassifiedTexts(node, unclassifiedTraversalBudget),
        );
        const removedTexts = removedNodes.flatMap(node =>
          collectUnclassifiedTexts(node, unclassifiedTraversalBudget),
        );
        if (unclassifiedTraversalBudget.truncated) overflow = true;
        if (!classified && addedTexts.length === 0 && removedTexts.length === 0)
          unclassifiedNonTextMutationCount += 1;
        addTextCounts(addedTextCounts, addedTexts);
        addTextCounts(removedTextCounts, removedTexts);
        continue;
      }
      if (record.type === 'characterData') {
        mutationCount += 1;
        structuralMutationCount += 1;
        if (!pushTextUpdate(record.target) && !pushPlainTextUpdate(record.target))
          unclassifiedStructuralMutationCount += 1;
        continue;
      }

      mutationCount += 1;
      const target = record.target as Element;
      const notification = isNotification(target) ? target : nearestNotification(target);
      if (notification) {
        const visible = isVisible(notification);
        const previous = notificationVisibility.get(notification);
        notificationVisibility.set(notification, visible);
        if (previous === true && !visible) pushNotification(notification, 'disappeared');
        else if (previous === false && visible) pushNotification(notification, 'appeared');
        else if (visible) pushNotification(notification, 'updated');
      }
      if (isInteractive(target)) pushInteractive(target, 'updated');
      if (
        ['hidden', 'aria-hidden', 'style', 'class'].includes(record.attributeName || '') &&
        isVisible(target)
      ) {
        for (const interactive of candidates(target, interactiveSelector)) {
          pushInteractive(interactive, 'appeared');
        }
      }
    }

    const textKeys = new Set([...addedTextCounts.keys(), ...removedTextCounts.keys()]);
    for (const text of textKeys) {
      unclassifiedStructuralMutationCount += Math.abs(
        (addedTextCounts.get(text) ?? 0) - (removedTextCounts.get(text) ?? 0),
      );
    }
    unclassifiedStructuralMutationCount += unclassifiedNonTextMutationCount;

    if (mutationCount === 0) return;
    state.version += 1;
    state.lastChangeAt = performance.now();
    state.batches.push({
      version: state.version,
      mutationCount,
      structuralMutationCount,
      unclassifiedStructuralMutationCount,
      notifications,
      interactives,
      texts: Array.from(texts, ([element, effect]) => ({ element, effect })),
      overflow,
    });
    if (state.batches.length > Math.max(10, maxBatches)) state.batches.shift();
    for (const listener of Array.from(state.listeners) as Array<() => void>) listener();
  });

  observer.observe(document.documentElement || document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      'role',
      'aria-live',
      'aria-hidden',
      'hidden',
      'style',
      'class',
      'disabled',
      'aria-disabled',
      'aria-expanded',
      'aria-selected',
      'aria-checked',
      'value',
    ],
  });

  state.waitSince = (
    checkpoint: number,
    checkpointFocus: string | undefined,
    quietMs: number,
    firstChangeTimeoutMs: number,
    timeoutMs: number,
  ): Promise<PageChangeSet> => {
    const startedAt = performance.now();
    const visualSettleDeadline = startedAt + Math.min(timeoutMs, 750);
    return new Promise(resolve => {
      let completed = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      let firstChangeTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;

      const remainingVisualAnimationMs = (): number => {
        const remainingBudget = visualSettleDeadline - performance.now();
        if (remainingBudget <= 0 || typeof document.getAnimations !== 'function') return 0;
        let maximumRemaining = 0;
        try {
          for (const animation of document.getAnimations()) {
            if (animation.playState !== 'running' && !animation.pending) continue;
            const target = (animation.effect as KeyframeEffect | null)?.target;
            if (target instanceof Element && target.closest('[data-mearl-overlay]')) continue;
            const timing = animation.effect?.getComputedTiming?.();
            if (timing?.iterations === Infinity) continue;
            const currentTime = Number(animation.currentTime);
            const endTime = Number(timing?.endTime);
            const remaining =
              Number.isFinite(currentTime) && Number.isFinite(endTime)
                ? Math.max(0, endTime - currentTime)
                : 50;
            maximumRemaining = Math.max(maximumRemaining, remaining);
          }
        } catch {
          return 0;
        }
        return Math.min(maximumRemaining, remainingBudget);
      };

      const finish = (settledBy: PageChangeSet['settledBy']) => {
        if (completed) return;
        if (settledBy === 'quiet') {
          const animationDelay = remainingVisualAnimationMs();
          if (animationDelay > 0) {
            if (quietTimer) clearTimeout(quietTimer);
            quietTimer = setTimeout(() => finish('quiet'), Math.max(16, animationDelay));
            return;
          }
        }
        completed = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (firstChangeTimer) clearTimeout(firstChangeTimer);
        if (hardTimer) clearTimeout(hardTimer);
        state.listeners.delete(onChange);

        const available = state.batches.filter((batch: any) => batch.version > checkpoint);
        const oldestVersion = state.batches[0]?.version ?? state.version;
        const batchOverflow =
          (available.length > 0 && checkpoint < oldestVersion - 1) ||
          available.some((batch: any) => batch.overflow);
        const mutationCount = available.reduce(
          (total: number, batch: any) => total + batch.mutationCount,
          0,
        );
        const structuralMutationCount = available.reduce(
          (total: number, batch: any) => total + batch.structuralMutationCount,
          0,
        );
        const unclassifiedStructuralMutationCount = available.reduce(
          (total: number, batch: any) =>
            total + (batch.unclassifiedStructuralMutationCount ?? batch.structuralMutationCount),
          0,
        );

        const latestInteractives = new Map<string, PageInteractiveEffect>();
        for (const effect of available.flatMap((batch: any) => batch.interactives)) {
          latestInteractives.set(effect.node.selector, effect);
        }
        const baseline =
          state.baselineVersion === checkpoint
            ? (state.baseline as Map<string, PageEffectNode>)
            : undefined;
        const interactives = Array.from(latestInteractives.values())
          .map(effect => compactUnchangedRecreation(effect, baseline))
          .slice(-signalLimit);

        const latestTexts = new Map<Element, PageTextEffect>();
        for (const batch of available) {
          for (const entry of batch.texts ?? []) latestTexts.set(entry.element, entry.effect);
        }
        const texts: PageTextEffect[] = [];
        let incompleteText = latestTexts.size > textLimit;
        for (const [element, effect] of latestTexts) {
          let current = readPlainText(element);
          // Frameworks can replace a just-observed text leaf with an equivalent node.
          // Only reuse its stable selector when the replacement is unique and passes
          // the same visibility, clipping and text-completeness checks.
          if (!element.isConnected) {
            try {
              const matches = document.querySelectorAll(effect.selector);
              if (matches.length === 1) current = readPlainText(matches[0]!);
            } catch {
              // Preserve the fallback when the recorded selector cannot be resolved.
            }
          }
          if (!current || current.selector !== effect.selector || current.text !== effect.text) {
            incompleteText = true;
            continue;
          }
          if (texts.length < textLimit) texts.push(current);
        }

        const notificationStates = new Map<
          number,
          {
            appeared?: any;
            updated?: any;
            disappeared?: any;
            lastAt: number;
          }
        >();
        for (const event of available.flatMap((batch: any) => batch.notifications)) {
          const entry: {
            appeared?: any;
            updated?: any;
            disappeared?: any;
            lastAt: number;
          } = notificationStates.get(event.nodeId) ?? { lastAt: event.at };
          const phase = event.phase as 'appeared' | 'updated' | 'disappeared';
          entry[phase] = event;
          if (phase === 'updated' && entry.appeared) {
            entry.appeared = { ...entry.appeared, node: event.node };
          }
          entry.lastAt = event.at;
          notificationStates.set(event.nodeId, entry);
        }
        const roundTime = (value: number): number => Math.round(value * 1000) / 1000;
        const notifications = Array.from(notificationStates.values())
          .sort((left, right) => left.lastAt - right.lastAt)
          .map(entry => {
            if (entry.appeared && entry.disappeared) {
              const appearedAt = Math.max(0, entry.appeared.at - startedAt);
              const disappearedAt = Math.max(appearedAt, entry.disappeared.at - startedAt);
              return {
                change: 'transient' as const,
                node: entry.disappeared.node.name ? entry.disappeared.node : entry.appeared.node,
                appearedAt: roundTime(appearedAt),
                disappearedAt: roundTime(disappearedAt),
                duration: roundTime(Math.max(0, entry.disappeared.at - entry.appeared.at)),
              };
            }
            if (entry.disappeared) {
              return { change: 'disappeared' as const, node: entry.disappeared.node };
            }
            if (entry.appeared) return { change: 'appeared' as const, node: entry.appeared.node };
            return { change: 'updated' as const, node: entry.updated.node };
          })
          .slice(-notificationLimit);

        const currentFocus = document.activeElement as Element | null;
        const currentFocusSelector = selectorFor(currentFocus);
        const focus =
          currentFocusSelector && currentFocusSelector !== checkpointFocus
            ? describe(currentFocus)
            : null;
        const distinctInteractives = focus
          ? interactives.filter(effect => effect.node.selector !== focus.selector)
          : interactives;
        const overflow =
          batchOverflow ||
          latestInteractives.size > signalLimit ||
          notificationStates.size > notificationLimit ||
          latestTexts.size > textLimit;
        const snapshotReasons: PageSnapshotReason[] = [];
        if (settledBy === 'timeout') snapshotReasons.push('observation-timeout');
        if (overflow) snapshotReasons.push('observation-overflow');
        if (
          (structuralMutationCount > 0 && unclassifiedStructuralMutationCount > 0) ||
          incompleteText
        ) {
          snapshotReasons.push('unclassified-structure');
        }

        resolve({
          mode: 'delta',
          scope: 'main-document',
          checkpoint,
          version: state.version,
          elapsed: roundTime(performance.now() - startedAt),
          settledBy,
          url: location.href,
          title: document.title,
          changed: mutationCount > 0 || Boolean(focus),
          effects: {
            notifications,
            interactives: distinctInteractives,
            ...(texts.length > 0 ? { texts } : {}),
            ...(focus ? { focus } : {}),
          },
          mutationCount,
          overflow,
          fullSnapshotRecommended: snapshotReasons.length > 0,
          snapshotReasons,
        });
      };
      const scheduleQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        const remaining = Math.max(0, quietMs - (performance.now() - state.lastChangeAt));
        quietTimer = setTimeout(() => finish('quiet'), remaining);
      };
      const onChange = () => {
        if (state.version <= checkpoint) return;
        if (firstChangeTimer) clearTimeout(firstChangeTimer);
        scheduleQuiet();
      };
      if (timeoutMs <= 0) {
        finish(state.version > checkpoint ? 'quiet' : 'no-change');
      } else {
        hardTimer = setTimeout(() => finish('timeout'), timeoutMs);
        state.listeners.add(onChange);
        if (state.version > checkpoint) scheduleQuiet();
        else firstChangeTimer = setTimeout(() => finish('no-change'), firstChangeTimeoutMs);
      }
    });
  };

  state.observer = observer;
  pageGlobal[globalKey] = state;
  return {
    version: state.version,
    url: location.href,
    title: document.title,
    focus: selectorFor(document.activeElement),
  };
}

export function disposePageObserverInPage(): void {
  const pageGlobal = globalThis as any;
  const globalKey = '__MEARL_PAGE_OBSERVER__';
  const state = pageGlobal[globalKey];
  if (state?.document !== document) return;
  state.observer?.disconnect?.();
  state.listeners?.clear?.();
  delete pageGlobal[globalKey];
}
