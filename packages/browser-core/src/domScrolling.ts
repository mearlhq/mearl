import type { PageScrollParams } from './browserActionProtocol.js';
import { INVALID_NATIVE_SELECTOR_HINT, validatePageElementSelector } from './domSelectors.js';

export type PageScrollDirection = 'up' | 'down' | 'top' | 'bottom';
export type PageScrollContainerPolicy = 'self' | 'nearest';

export interface ResolvedPageScrollInput {
  direction: PageScrollDirection;
  distance: number;
  selector?: string;
  containerPolicy: PageScrollContainerPolicy;
}

export interface PageScrollResult {
  /** Backward-compatible alias for scrollYAfter. */
  scrollY: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollY: number;
  scrollYBefore: number;
  scrollYAfter: number;
  moved: boolean;
  atTop: boolean;
  atBottom: boolean;
  target: string;
  resolvedContainer:
    | 'self'
    | 'document-body'
    | 'document-descendant'
    | 'nearest-scrollable-ancestor';
  ancestorDistance: number;
  containerSelector?: string;
}

export type PageScrollExecutionResult = PageScrollResult | { error: string };

/**
 * Normalizes the public page_scroll payload consistently across extension and
 * native CDP transports.
 */
export function resolvePageScrollInput(data: PageScrollParams): ResolvedPageScrollInput {
  const { direction, distance, selector, containerPolicy = 'self' } = data;
  if (
    typeof direction !== 'string' ||
    !(['up', 'down', 'top', 'bottom'] as string[]).includes(direction)
  ) {
    throw new Error('Invalid direction: must be one of up, down, top, bottom');
  }

  if (distance !== undefined && (typeof distance !== 'number' || !Number.isFinite(distance))) {
    throw new Error('"distance" must be a finite number');
  }

  if (selector !== undefined) {
    validatePageElementSelector(selector, 'page_scroll');
  }
  if (containerPolicy !== 'self' && containerPolicy !== 'nearest') {
    throw new Error('"containerPolicy" must be one of self, nearest');
  }

  return {
    direction: direction as PageScrollDirection,
    distance: Math.abs((distance as number | undefined) ?? 600),
    containerPolicy,
    ...(selector !== undefined ? { selector: selector as string } : {}),
  };
}

/**
 * Scrolls the DOM node bound as `this`.
 *
 * This function is serialized with .toString() and injected into the target
 * page, so it must not reference module scope or imported values.
 */
export function scrollElementInPage(
  this: any,
  direction: PageScrollDirection,
  distance: number,
  targetLabel: string,
  containerPolicy: PageScrollContainerPolicy = 'self',
): PageScrollExecutionResult {
  let element = this?.nodeType === 3 ? this.parentElement : this;
  const targetDocument = element?.nodeType === 9 ? element : null;
  if (targetDocument) element = targetDocument.scrollingElement;
  if (!element || element.isConnected === false) {
    return { error: 'Cannot resolve scroll container: ' + targetLabel };
  }

  const startingElement = element;
  let ancestorDistance = 0;

  function scrollMetrics(candidate: any): {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    maxScrollTop: number;
    isRootScroller: boolean;
    usable: boolean;
  } | null {
    const scrollTop = Number(candidate?.scrollTop);
    const scrollHeight = Number(candidate?.scrollHeight);
    const clientHeight = Number(candidate?.clientHeight);
    if (
      !Number.isFinite(scrollTop) ||
      !Number.isFinite(scrollHeight) ||
      !Number.isFinite(clientHeight)
    ) {
      return null;
    }
    const ownerDocument = candidate.ownerDocument;
    const isRootScroller = !!ownerDocument && candidate === ownerDocument.scrollingElement;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    let overflowAllowsScroll = true;
    try {
      const overflowY = ownerDocument?.defaultView?.getComputedStyle(candidate).overflowY;
      if (!isRootScroller && (overflowY === 'visible' || overflowY === 'clip')) {
        overflowAllowsScroll = false;
      }
    } catch {
      // Cross-realm or synthetic DOM nodes may not expose computed styles.
    }
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      maxScrollTop,
      isRootScroller,
      usable: isRootScroller || (maxScrollTop > 0 && overflowAllowsScroll),
    };
  }

  function documentFallback(documentRef: any): {
    element: any;
    metrics: NonNullable<ReturnType<typeof scrollMetrics>>;
    distance: number;
  } | null {
    const windowRef = documentRef.defaultView;
    const visited = new Set<any>();
    const viewportWidth = Number(windowRef?.innerWidth) || Number(element?.clientWidth) || 0;
    const viewportHeight = Number(windowRef?.innerHeight) || Number(element?.clientHeight) || 0;
    const points = [
      [viewportWidth / 2, viewportHeight / 2],
      [viewportWidth / 2, viewportHeight * 0.75],
      [viewportWidth / 2, viewportHeight * 0.25],
    ];

    function containerDepth(candidate: any): number {
      if (candidate === documentRef.body || candidate === documentRef.documentElement) return 0;
      let depth = 0;
      let cursor = candidate;
      while (cursor && cursor !== documentRef.body && cursor !== documentRef.documentElement) {
        depth += 1;
        cursor = cursor.parentElement;
      }
      return depth;
    }

    function canMove(metrics: NonNullable<ReturnType<typeof scrollMetrics>>): boolean {
      if (direction === 'up' || direction === 'top') return metrics.scrollTop > 0;
      return metrics.scrollTop < metrics.maxScrollTop;
    }

    // The nearest scrollable ancestor under representative viewport points is
    // usually the active main area or an open sheet/dialog content region.
    let sampledPageContainer:
      | {
          element: any;
          metrics: NonNullable<ReturnType<typeof scrollMetrics>>;
          distance: number;
        }
      | undefined;
    for (const [x, y] of points) {
      let candidate: any = null;
      try {
        candidate = documentRef.elementFromPoint?.(x, y) ?? null;
      } catch {}
      while (candidate && candidate.nodeType === 1) {
        if (!visited.has(candidate)) {
          visited.add(candidate);
          const candidateMetrics = scrollMetrics(candidate);
          if (
            candidateMetrics?.usable &&
            candidateMetrics.maxScrollTop > 0 &&
            canMove(candidateMetrics)
          ) {
            const resolved = {
              element: candidate,
              metrics: candidateMetrics,
              distance: containerDepth(candidate),
            };
            if (candidate === documentRef.body || candidate === documentRef.documentElement) {
              sampledPageContainer ??= resolved;
            } else {
              return resolved;
            }
          }
        }
        candidate = candidate.parentElement;
      }
    }

    if (sampledPageContainer) return sampledPageContainer;

    // If the viewport samples do not land inside a scroller, scan once and
    // select the highest-level visible candidate, breaking ties by visible area.
    let best:
      | {
          element: any;
          metrics: NonNullable<ReturnType<typeof scrollMetrics>>;
          distance: number;
          area: number;
        }
      | undefined;
    const candidates = Array.from(documentRef.querySelectorAll?.('*') ?? []).slice(0, 10_000);
    for (const candidate of candidates as any[]) {
      const candidateMetrics = scrollMetrics(candidate);
      if (
        !candidateMetrics?.usable ||
        candidateMetrics.maxScrollTop <= 0 ||
        !canMove(candidateMetrics)
      ) {
        continue;
      }
      let rect: any;
      let style: any;
      try {
        rect = candidate.getBoundingClientRect();
        style = windowRef?.getComputedStyle(candidate);
      } catch {
        continue;
      }
      if (
        !rect ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        style?.visibility === 'collapse'
      ) {
        continue;
      }
      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0),
      );
      const area = visibleWidth * visibleHeight;
      if (area <= 0) continue;
      const depth = containerDepth(candidate);
      if (!best || depth < best.distance || (depth === best.distance && area > best.area)) {
        best = { element: candidate, metrics: candidateMetrics, distance: depth, area };
      }
    }
    return best ? { element: best.element, metrics: best.metrics, distance: best.distance } : null;
  }

  function selectorFor(candidate: any): string {
    const documentRef = candidate?.ownerDocument;
    if (!documentRef || candidate.nodeType !== 1) return '';
    if (candidate === documentRef.documentElement) return 'html';
    if (candidate === documentRef.body) return 'body';
    const escapeCss = (value: string): string =>
      documentRef.defaultView?.CSS?.escape
        ? documentRef.defaultView.CSS.escape(value)
        : value.replace(/[^a-zA-Z0-9_-]/g, character => '\\' + character);
    if (candidate.id) {
      const idSelector = '#' + escapeCss(String(candidate.id));
      try {
        if (documentRef.querySelectorAll(idSelector).length === 1) return idSelector;
      } catch {}
    }
    const path: string[] = [];
    let cursor = candidate;
    while (cursor && cursor.nodeType === 1 && path.length < 8) {
      const tag = String(cursor.tagName || '').toLowerCase();
      if (!tag) break;
      const parent = cursor.parentElement;
      if (!parent) {
        path.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter(
        (sibling: any) => sibling.tagName === cursor.tagName,
      );
      const index = siblings.indexOf(cursor) + 1;
      path.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      cursor = parent;
      if (cursor === documentRef.documentElement) {
        path.unshift('html');
        break;
      }
    }
    return path.join(' > ');
  }

  let metrics = scrollMetrics(element);
  if (!metrics) return { error: 'Element is not scrollable: ' + targetLabel };

  if (targetDocument) {
    const fallback = documentFallback(targetDocument);
    if (fallback) {
      element = fallback.element;
      metrics = fallback.metrics;
      ancestorDistance = fallback.distance;
    }
  }

  if (!metrics.usable && containerPolicy === 'nearest') {
    let candidate = element.parentElement;
    while (candidate) {
      ancestorDistance += 1;
      const candidateMetrics = scrollMetrics(candidate);
      if (candidateMetrics?.usable) {
        element = candidate;
        metrics = candidateMetrics;
        break;
      }
      candidate = candidate.parentElement;
    }
  }

  if (!metrics.usable && !metrics.isRootScroller) {
    return {
      error:
        'Element is not scrollable: ' +
        targetLabel +
        (containerPolicy === 'nearest' ? ' (no scrollable ancestor found)' : ''),
    };
  }

  let targetTop: number;
  switch (direction) {
    case 'top':
      targetTop = 0;
      break;
    case 'bottom':
      targetTop = metrics.maxScrollTop;
      break;
    case 'up':
      targetTop = Math.max(0, metrics.scrollTop - Math.abs(distance));
      break;
    default:
      targetTop = Math.min(metrics.maxScrollTop, metrics.scrollTop + Math.abs(distance));
      break;
  }

  if (typeof element.scrollTo === 'function') {
    try {
      element.scrollTo({
        top: targetTop,
        left: Number(element.scrollLeft) || 0,
        behavior: 'instant',
      });
    } catch {
      element.scrollTop = targetTop;
    }
  } else {
    element.scrollTop = targetTop;
  }
  const actualScrollTop = Number(element.scrollTop);
  if (
    !metrics.isRootScroller &&
    targetTop !== metrics.scrollTop &&
    actualScrollTop === metrics.scrollTop
  ) {
    return { error: 'Element is not scrollable: ' + targetLabel };
  }

  return {
    scrollY: Math.round(actualScrollTop),
    scrollHeight: metrics.scrollHeight,
    clientHeight: metrics.clientHeight,
    maxScrollY: Math.round(metrics.maxScrollTop),
    scrollYBefore: Math.round(metrics.scrollTop),
    scrollYAfter: Math.round(actualScrollTop),
    moved: actualScrollTop !== metrics.scrollTop,
    atTop: actualScrollTop <= 0,
    atBottom: actualScrollTop >= metrics.maxScrollTop,
    target: targetLabel,
    resolvedContainer:
      targetDocument && element === targetDocument.body && element !== startingElement
        ? 'document-body'
        : targetDocument && element !== startingElement
          ? 'document-descendant'
          : element === startingElement
            ? 'self'
            : 'nearest-scrollable-ancestor',
    ancestorDistance,
    ...(targetDocument && element !== startingElement
      ? { containerSelector: selectorFor(element) }
      : {}),
  };
}

export const SCROLL_ELEMENT_IN_PAGE_SOURCE = scrollElementInPage.toString();

/** Builds the shared main-document expression used by both browser backends. */
export function buildPageScrollExpression(input: ResolvedPageScrollInput): string {
  return `(() => {
    const dir = ${JSON.stringify(input.direction)};
    const dist = ${JSON.stringify(input.distance)};
    const sel = ${JSON.stringify(input.selector)};
    const policy = ${JSON.stringify(input.containerPolicy)};
    const scroll = (${SCROLL_ELEMENT_IN_PAGE_SOURCE});
    if (sel === undefined) return scroll.call(document, dir, dist, 'page', policy);
    let el;
    try { el = document.querySelector(sel); }
    catch (e) { return { error: 'Invalid CSS selector "' + sel + '": ' + e.message + '. ' + ${JSON.stringify(INVALID_NATIVE_SELECTOR_HINT)} }; }
    if (!el) return { error: 'Element not found: ' + sel };
    return scroll.call(el, dir, dist, sel, policy);
  })()`;
}

export function unwrapPageScrollResult(
  result: PageScrollExecutionResult | null | undefined,
  missingResultMessage: string,
): PageScrollResult {
  if (!result) throw new Error(missingResultMessage);
  if ('error' in result) throw new Error(result.error);
  return result;
}
