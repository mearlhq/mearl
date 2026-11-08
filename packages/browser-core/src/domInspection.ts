import type { PageInspectFilter, PageInspectParams } from './browserActionProtocol.js';
import { INVALID_NATIVE_SELECTOR_HINT, validatePageElementSelector } from './domSelectors.js';

export interface ResolvedPageInspectInput {
  selector?: string;
  maxResults: number;
  styles: string[];
  filter: PageInspectFilter;
  includeOuterHTML: boolean;
}

export interface PageInspectBox {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageInspectScrollContainer {
  selector: string;
  tag: string;
  ancestorDistance: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  scrollLeft: number;
  scrollTop: number;
  overflowX: string;
  overflowY: string;
}

export interface PageInspectMatch {
  selector: string;
  tag: string;
  text: string;
  visible: boolean;
  hitTest: {
    point: { x: number; y: number };
    topmost: boolean;
    receivesPointerEvents: boolean;
    target?: { selector: string; tag: string; text: string };
    occludedBy?: { selector: string; tag: string; text: string };
  };
  boundingBox: PageInspectBox;
  computedStyle: Record<string, string>;
  scroll: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    overflowX: string;
    overflowY: string;
    horizontalOverflow: number;
    verticalOverflow: number;
  };
  scrollContainer?: PageInspectScrollContainer;
  outerHTML?: string;
  attributes?: Record<string, string>;
  state?: Record<string, { value: boolean | 'mixed'; source: 'native' | 'aria' }>;
  xpath?: string;
  sourceLocation?: string;
  framework?: Record<string, unknown>;
}

export interface PageInspectResult {
  selector?: string;
  resolvedSelector?: string;
  source?: 'devtools-selection';
  filter: PageInspectFilter;
  candidateCount: number;
  count: number;
  matches: PageInspectMatch[];
  truncated: boolean;
  scanTruncated?: boolean;
}

export type PageInspectExecutionResult = PageInspectResult | { error: string };

const DEFAULT_STYLES = ['display', 'position', 'box-sizing', 'overflow-x', 'overflow-y'];

/** Validate and normalize page_inspect input for both browser backends. */
export function resolvePageInspectInput(data: PageInspectParams): ResolvedPageInspectInput {
  const selector = data?.selector;
  const filter = data?.filter ?? 'all';
  const maxResults = data?.maxResults ?? 20;
  const styles = data?.styles ?? DEFAULT_STYLES;

  if (selector !== undefined && selector !== '$0') {
    validatePageElementSelector(selector, 'page_inspect');
  }
  if (
    !['all', 'overflowing', 'horizontal-overflow', 'vertical-overflow', 'scrollable'].includes(
      filter,
    )
  ) {
    throw new Error(
      'page_inspect filter must be one of all, overflowing, horizontal-overflow, vertical-overflow, scrollable',
    );
  }
  if (selector === undefined && filter === 'all') {
    throw new Error('page_inspect requires "selector" unless an overflow filter is provided');
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new Error('page_inspect maxResults must be an integer between 1 and 100');
  }
  if (
    !Array.isArray(styles) ||
    styles.length > 32 ||
    styles.some(style => typeof style !== 'string' || !style.trim() || style.length > 128)
  ) {
    throw new Error('page_inspect styles must be an array of at most 32 non-empty property names');
  }

  return {
    ...(selector !== undefined ? { selector } : {}),
    filter,
    maxResults,
    styles: styles.map(style => style.trim()),
    includeOuterHTML: data.includeOuterHTML ?? selector === '$0',
  };
}

/**
 * Inspect elements in the target page. This function is serialized and must
 * remain self-contained; `this` is either Document or a resolved DOM node.
 */
export function inspectElementsInPage(
  this: any,
  selector: string | undefined,
  filter: PageInspectFilter,
  styles: string[],
  maxResults: number,
  invalidSelectorHint: string,
  includeOuterHTML = false,
): PageInspectExecutionResult {
  const context = this?.nodeType === 3 ? this.parentElement : this;
  const documentRef = context?.nodeType === 9 ? context : context?.ownerDocument;
  if (!documentRef) return { error: 'page_inspect cannot resolve the target document' };

  const scanLimit = 10_000;
  let candidates: any[];
  if (context?.nodeType === 9) {
    const effectiveSelector = selector ?? '*';
    try {
      candidates = Array.from(documentRef.querySelectorAll(effectiveSelector));
    } catch (error) {
      return {
        error:
          'Invalid CSS selector "' +
          effectiveSelector +
          '": ' +
          (error instanceof Error ? error.message : String(error)) +
          '. ' +
          invalidSelectorHint,
      };
    }
  } else if (context?.nodeType === 1 && context.isConnected !== false) {
    candidates = [context];
  } else {
    return { error: 'page_inspect target is detached from the document' };
  }

  const candidateCount = candidates.length;
  const scanTruncated = filter !== 'all' && candidateCount > scanLimit;
  candidates =
    filter === 'all'
      ? candidates.slice(0, maxResults)
      : scanTruncated
        ? candidates.slice(0, scanLimit)
        : candidates;

  const windowRef = documentRef.defaultView;
  const viewportWidth = Number(windowRef?.innerWidth) || 0;
  const viewportHeight = Number(windowRef?.innerHeight) || 0;

  function round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }

  function controlState(element: any): NonNullable<PageInspectMatch['state']> {
    const state: NonNullable<PageInspectMatch['state']> = {};
    for (const name of ['checked', 'selected', 'pressed', 'expanded', 'disabled', 'readonly']) {
      const value = element.getAttribute?.('aria-' + name);
      if (
        value === 'true' ||
        value === 'false' ||
        (value === 'mixed' && (name === 'checked' || name === 'pressed'))
      ) {
        state[name] = { value: value === 'mixed' ? 'mixed' : value === 'true', source: 'aria' };
      }
    }
    const tag = String(element.tagName || '').toLowerCase();
    const type = String(element.type || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      state.checked = {
        value: type === 'checkbox' && element.indeterminate ? 'mixed' : Boolean(element.checked),
        source: 'native',
      };
    }
    if (tag === 'option') state.selected = { value: Boolean(element.selected), source: 'native' };
    if (['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'fieldset'].includes(tag)) {
      const disabled = element.matches?.(':disabled') ?? Boolean(element.disabled);
      if (disabled || !state.disabled) state.disabled = { value: disabled, source: 'native' };
    }
    if (
      tag === 'textarea' ||
      (tag === 'input' &&
        [
          'text',
          'search',
          'tel',
          'url',
          'email',
          'password',
          'date',
          'month',
          'week',
          'time',
          'datetime-local',
          'number',
        ].includes(type))
    ) {
      if (element.readOnly || !state.readonly) {
        state.readonly = { value: Boolean(element.readOnly), source: 'native' };
      }
    }
    return state;
  }

  function escapeCss(value: string): string {
    if (windowRef?.CSS && typeof windowRef.CSS.escape === 'function') {
      return windowRef.CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, character => '\\' + character);
  }

  function selectorFor(element: any): string {
    if (element.id) {
      const idSelector = '#' + escapeCss(String(element.id));
      try {
        if (documentRef.querySelectorAll(idSelector).length === 1) return idSelector;
      } catch {}
    }
    const path: string[] = [];
    let cursor = element;
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

  function readStyle(style: any, property: string): string {
    const cssValue = style.getPropertyValue?.(property);
    if (cssValue) return String(cssValue);
    const camelName = property.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    return String(style[camelName] ?? '');
  }

  function isScrollable(element: any, style: any): boolean {
    const canScrollX =
      Number(element.scrollWidth) > Number(element.clientWidth) &&
      !['visible', 'clip'].includes(String(style.overflowX));
    const canScrollY =
      Number(element.scrollHeight) > Number(element.clientHeight) &&
      !['visible', 'clip'].includes(String(style.overflowY));
    return canScrollX || canScrollY;
  }

  function nearestScrollContainer(element: any): PageInspectScrollContainer | undefined {
    let candidate = element;
    let ancestorDistance = 0;
    while (candidate && candidate.nodeType === 1) {
      const style = windowRef.getComputedStyle(candidate);
      if (isScrollable(candidate, style)) {
        return {
          selector: selectorFor(candidate),
          tag: String(candidate.tagName || '').toLowerCase(),
          ancestorDistance,
          scrollWidth: Number(candidate.scrollWidth) || 0,
          scrollHeight: Number(candidate.scrollHeight) || 0,
          clientWidth: Number(candidate.clientWidth) || 0,
          clientHeight: Number(candidate.clientHeight) || 0,
          scrollLeft: Number(candidate.scrollLeft) || 0,
          scrollTop: Number(candidate.scrollTop) || 0,
          overflowX: String(style.overflowX || ''),
          overflowY: String(style.overflowY || ''),
        };
      }
      candidate = candidate.parentElement;
      ancestorDistance += 1;
    }
    return undefined;
  }

  function hitTargetInfo(element: any, rect: any, visible: boolean, style: any) {
    const left = Math.max(0, Number(rect.left) || 0);
    const right = Math.min(viewportWidth, Number(rect.right) || 0);
    const top = Math.max(0, Number(rect.top) || 0);
    const bottom = Math.min(viewportHeight, Number(rect.bottom) || 0);
    const x = round(left + Math.max(0, right - left) / 2);
    const y = round(top + Math.max(0, bottom - top) / 2);
    let hit: any = null;
    try {
      hit = visible ? (documentRef.elementFromPoint?.(x, y) ?? null) : null;
      const visited = new Set();
      while (hit?.shadowRoot?.elementFromPoint && !visited.has(hit)) {
        visited.add(hit);
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
    } catch {}
    let composedHit = hit;
    while (composedHit && composedHit !== element) {
      composedHit = composedHit.parentElement || composedHit.getRootNode?.().host;
    }
    const topmost = !!hit && (!!composedHit || element.contains?.(hit));
    const target = hit
      ? {
          selector: selectorFor(hit),
          tag: String(hit.tagName || '').toLowerCase(),
          text: String(hit.innerText ?? hit.textContent ?? '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 120),
        }
      : undefined;
    return {
      point: { x, y },
      topmost,
      receivesPointerEvents: visible && style.pointerEvents !== 'none' && topmost,
      ...(target ? { target } : {}),
      ...(!topmost && target ? { occludedBy: target } : {}),
    };
  }

  const matches: PageInspectMatch[] = [];
  let count = filter === 'all' ? candidateCount : 0;
  for (const element of candidates) {
    const style = windowRef.getComputedStyle(element);
    const scrollWidth = Number(element.scrollWidth) || 0;
    const scrollHeight = Number(element.scrollHeight) || 0;
    const clientWidth = Number(element.clientWidth) || 0;
    const clientHeight = Number(element.clientHeight) || 0;
    const horizontalOverflow = Math.max(0, scrollWidth - clientWidth);
    const verticalOverflow = Math.max(0, scrollHeight - clientHeight);
    const scrollable = isScrollable(element, style);
    const included =
      filter === 'all' ||
      (filter === 'overflowing' && (horizontalOverflow > 0 || verticalOverflow > 0)) ||
      (filter === 'horizontal-overflow' && horizontalOverflow > 0) ||
      (filter === 'vertical-overflow' && verticalOverflow > 0) ||
      (filter === 'scrollable' && scrollable);
    if (!included) continue;
    if (filter !== 'all') count += 1;
    if (matches.length >= maxResults) continue;

    const rect = element.getBoundingClientRect();
    const opacity = Number(style.opacity);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      (!Number.isFinite(opacity) || opacity > 0) &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;
    const computedStyle: Record<string, string> = {};
    for (const property of styles) computedStyle[property] = readStyle(style, property);
    const scrollContainer = nearestScrollContainer(element);
    const hitTest = hitTargetInfo(element, rect, visible, style);
    const state = controlState(element);

    matches.push({
      selector: selectorFor(element),
      tag: String(element.tagName || '').toLowerCase(),
      text: String(element.innerText ?? element.textContent ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 240),
      visible,
      hitTest,
      ...(Object.keys(state).length ? { state } : {}),
      boundingBox: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        left: round(rect.left),
      },
      computedStyle,
      scroll: {
        scrollWidth,
        scrollHeight,
        clientWidth,
        clientHeight,
        overflowX: String(style.overflowX || ''),
        overflowY: String(style.overflowY || ''),
        horizontalOverflow,
        verticalOverflow,
      },
      ...(scrollContainer ? { scrollContainer } : {}),
      ...(includeOuterHTML ? { outerHTML: String(element.outerHTML ?? '').slice(0, 3000) } : {}),
    });
  }

  return {
    ...(selector !== undefined ? { selector } : {}),
    filter,
    candidateCount,
    count,
    matches,
    truncated: scanTruncated || count > matches.length,
    ...(scanTruncated ? { scanTruncated: true } : {}),
  };
}

export const INSPECT_ELEMENTS_IN_PAGE_SOURCE = inspectElementsInPage.toString();

export function buildPageInspectExpression(input: ResolvedPageInspectInput): string {
  return `(() => {
    const inspect = (${INSPECT_ELEMENTS_IN_PAGE_SOURCE});
    return inspect.call(
      document,
      ${JSON.stringify(input.selector)},
      ${JSON.stringify(input.filter)},
      ${JSON.stringify(input.styles)},
      ${JSON.stringify(input.maxResults)},
      ${JSON.stringify(INVALID_NATIVE_SELECTOR_HINT)},
      ${JSON.stringify(input.includeOuterHTML)}
    );
  })()`;
}

export function unwrapPageInspectResult(
  result: PageInspectExecutionResult | null | undefined,
  missingResultMessage: string,
): PageInspectResult {
  if (!result) throw new Error(missingResultMessage);
  if ('error' in result) throw new Error(result.error);
  return result;
}
