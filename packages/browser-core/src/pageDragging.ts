import type { PageDragEndpoint, PageDragParams, PageDragPoint } from './browserActionProtocol.js';

export const PAGE_DRAG_DEFAULT_DURATION_MS = 400;
export const PAGE_DRAG_MAX_DURATION_MS = 5_000;
export const PAGE_DRAG_STEP_INTERVAL_MS = 25;
export const PAGE_DRAG_MIN_STEPS = 2;
export const PAGE_DRAG_MAX_STEPS = 60;

export type PageDragPointerType = 'mouse' | 'touch';
export type PageDragMode = 'auto' | 'dom' | PageDragPointerType;
export type PageDragDispatchMode = 'trusted-input' | 'dom';
export type PageDragFallbackReason = 'page-hidden';

export interface ResolvedPageDragInput {
  from: PageDragEndpoint;
  to: PageDragEndpoint;
  dragMode: PageDragMode;
  durationMs: number;
}

export interface PageDragPath {
  points: PageDragPoint[];
  intervalMs: number;
}

export interface PageDragResolvedEndpoint {
  requested: PageDragEndpoint;
  point: PageDragPoint;
  tag?: string;
  text?: string;
}

export interface PageDragResultData {
  dragged: true;
  from: PageDragResolvedEndpoint;
  to: PageDragResolvedEndpoint;
  dispatchMode: PageDragDispatchMode;
  pointerType: PageDragPointerType;
  durationMs: number;
  steps: number;
  fallbackReason?: PageDragFallbackReason;
}

export interface PageDragDispatchPolicy {
  dispatchMode: PageDragDispatchMode;
  pointerType: PageDragPointerType;
  fallbackReason?: PageDragFallbackReason;
}

export type PageDragDomExecutionResult =
  | { dragged: true; steps: number }
  | { dragged: false; steps: number; error: string };

export interface PageDragElementCoords {
  x: number;
  y: number;
  tag: string;
  text: string;
  error?: string;
}

export function isPageDragPoint(value: unknown): value is PageDragPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<PageDragPoint>;
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    (point.x as number) >= 0 &&
    (point.y as number) >= 0
  );
}

function resolveEndpoint(value: unknown, name: 'from' | 'to'): PageDragEndpoint {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (isPageDragPoint(value)) return { x: value.x, y: value.y };
  throw new Error(
    `page_drag: "${name}" must be a non-empty CSS/@ref selector or { x, y } viewport point.`,
  );
}

export function resolvePageDragInput(data: PageDragParams): ResolvedPageDragInput {
  if (!data || typeof data !== 'object') {
    throw new Error('page_drag: payload is required');
  }

  if (data.dragMode !== undefined && !['auto', 'dom', 'mouse', 'touch'].includes(data.dragMode)) {
    throw new Error('page_drag: "dragMode" must be one of auto, dom, mouse, touch');
  }

  const durationMs = data.durationMs ?? PAGE_DRAG_DEFAULT_DURATION_MS;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > PAGE_DRAG_MAX_DURATION_MS) {
    throw new Error(`page_drag: "durationMs" must be between 0 and ${PAGE_DRAG_MAX_DURATION_MS}.`);
  }

  return {
    from: resolveEndpoint(data.from, 'from'),
    to: resolveEndpoint(data.to, 'to'),
    dragMode: data.dragMode ?? 'auto',
    durationMs: Math.round(durationMs),
  };
}

export function resolvePageDragDispatchPolicy(
  dragMode: PageDragMode | undefined,
  visibilityState: string | undefined,
  touchEmulationEnabled: boolean,
): PageDragDispatchPolicy {
  const requestedMode = dragMode ?? 'auto';
  const pointerType =
    requestedMode === 'mouse' || requestedMode === 'touch'
      ? requestedMode
      : touchEmulationEnabled
        ? 'touch'
        : 'mouse';

  if (requestedMode === 'dom') return { dispatchMode: 'dom', pointerType };
  if (requestedMode === 'auto' && visibilityState === 'hidden') {
    return { dispatchMode: 'dom', pointerType, fallbackReason: 'page-hidden' };
  }
  return { dispatchMode: 'trusted-input', pointerType };
}

export function buildPageDragPath(
  from: PageDragPoint,
  to: PageDragPoint,
  durationMs: number,
): PageDragPath {
  const steps = Math.max(
    PAGE_DRAG_MIN_STEPS,
    Math.min(PAGE_DRAG_MAX_STEPS, Math.ceil(durationMs / PAGE_DRAG_STEP_INTERVAL_MS)),
  );
  const points = Array.from({ length: steps }, (_, index) => {
    const ratio = (index + 1) / steps;
    return {
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio,
    };
  });
  return { points, intervalMs: durationMs / steps };
}

/**
 * Dispatches a segmented, untrusted drag sequence in the page world. Both
 * pointer and device-specific compatibility events are emitted because page
 * libraries commonly subscribe to one family only. The sequence is
 * synchronous so hidden-tab timer throttling cannot stretch a short drag into
 * a long-running action.
 *
 * This function is serialized with .toString() and injected into the target
 * page, so it must not reference module scope or imported runtime values.
 */
export function dragBetweenPointsInPage(
  from: PageDragPoint,
  points: PageDragPoint[],
  pointerType: PageDragPointerType,
): PageDragDomExecutionResult {
  const target = document.elementFromPoint(from.x, from.y);
  if (!target) {
    return {
      dragged: false,
      steps: 0,
      error: `No element found at drag start point (${from.x}, ${from.y})`,
    };
  }
  if (points.length === 0) {
    return { dragged: false, steps: 0, error: 'Drag path must contain at least one point' };
  }

  const view = target.ownerDocument.defaultView ?? window;
  const realm = view as typeof window & {
    PointerEvent?: typeof PointerEvent;
    Touch?: typeof Touch;
    TouchEvent?: typeof TouchEvent;
  };
  const pointerId = 1;

  const pointerInit = (point: PageDragPoint, buttons: number, pressure: number) => ({
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: 0,
    buttons,
    pointerId,
    pointerType,
    isPrimary: true,
    pressure,
    width: 1,
    height: 1,
  });

  const dispatchPointer = (
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    point: PageDragPoint,
    buttons: number,
    pressure: number,
  ): boolean => {
    if (typeof realm.PointerEvent !== 'function') return false;
    target.dispatchEvent(new realm.PointerEvent(type, pointerInit(point, buttons, pressure)));
    return true;
  };

  const dispatchMouse = (
    type: 'mousedown' | 'mousemove' | 'mouseup',
    point: PageDragPoint,
    buttons: number,
  ): boolean => {
    if (typeof realm.MouseEvent !== 'function') return false;
    target.dispatchEvent(
      new realm.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view,
        clientX: point.x,
        clientY: point.y,
        screenX: point.x,
        screenY: point.y,
        button: 0,
        buttons,
      }),
    );
    return true;
  };

  const createTouch = (point: PageDragPoint): Touch => {
    const init = {
      identifier: pointerId,
      target,
      clientX: point.x,
      clientY: point.y,
      screenX: point.x,
      screenY: point.y,
      pageX: point.x + view.scrollX,
      pageY: point.y + view.scrollY,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
      force: 0.5,
    };
    return typeof realm.Touch === 'function' ? new realm.Touch(init) : (init as unknown as Touch);
  };

  const dispatchTouch = (
    type: 'touchstart' | 'touchmove' | 'touchend',
    point: PageDragPoint,
  ): boolean => {
    if (typeof realm.TouchEvent !== 'function') return false;
    const touch = createTouch(point);
    const activeTouches = type === 'touchend' ? [] : [touch];
    target.dispatchEvent(
      new realm.TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: activeTouches,
        targetTouches: activeTouches,
        changedTouches: [touch],
      }),
    );
    return true;
  };

  let dispatched = dispatchPointer('pointerdown', from, 1, 0.5);
  dispatched =
    pointerType === 'touch'
      ? dispatchTouch('touchstart', from) || dispatched
      : dispatchMouse('mousedown', from, 1) || dispatched;

  for (const point of points) {
    dispatched = dispatchPointer('pointermove', point, 1, 0.5) || dispatched;
    dispatched =
      pointerType === 'touch'
        ? dispatchTouch('touchmove', point) || dispatched
        : dispatchMouse('mousemove', point, 1) || dispatched;
  }

  const end = points[points.length - 1];
  dispatched =
    pointerType === 'touch'
      ? dispatchTouch('touchend', end) || dispatched
      : dispatchMouse('mouseup', end, 0) || dispatched;
  dispatched = dispatchPointer('pointerup', end, 0, 0) || dispatched;

  return dispatched
    ? { dragged: true, steps: points.length }
    : { dragged: false, steps: 0, error: 'This page does not support synthetic drag events' };
}

export const DRAG_BETWEEN_POINTS_IN_PAGE_SOURCE = dragBetweenPointsInPage.toString();

export function buildPageDragDomExpression(
  from: PageDragPoint,
  points: PageDragPoint[],
  pointerType: PageDragPointerType,
): string {
  return `(${DRAG_BETWEEN_POINTS_IN_PAGE_SOURCE})(${JSON.stringify(from)}, ${JSON.stringify(points)}, ${JSON.stringify(pointerType)})`;
}

export function unwrapPageDragDomResult(result: PageDragDomExecutionResult | null | undefined): {
  dragged: true;
  steps: number;
} {
  if (!result) throw new Error('page_drag: DOM simulation returned no result');
  if (!result.dragged) throw new Error(`page_drag: ${result.error}`);
  return result;
}

export function getDragCoordsFromNode(this: Node): PageDragElementCoords | null {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : (this as Element);
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;

  const rect = el.getBoundingClientRect();
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, tag: '', text: '', error: 'Element has no visible bounds' };
  }
  if (
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= viewportWidth ||
    rect.top >= viewportHeight
  ) {
    return {
      x: 0,
      y: 0,
      tag: '',
      text: '',
      error: 'Element is outside the current viewport; scroll it into view before dragging',
    };
  }

  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(viewportWidth - 1, 0));
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(viewportHeight - 1, 0));
  return {
    x,
    y,
    tag: el.tagName?.toLowerCase() ?? '',
    text: (el.textContent ?? '').trim().slice(0, 100),
  };
}
