import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPageDragPath,
  dragBetweenPointsInPage,
  resolvePageDragDispatchPolicy,
  resolvePageDragInput,
} from '../pageDragging';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('page dragging', () => {
  it('normalizes selectors, points, and defaults', () => {
    expect(resolvePageDragInput({ from: '  @e3  ', to: { x: 80, y: 120 } })).toEqual({
      from: '@e3',
      to: { x: 80, y: 120 },
      dragMode: 'auto',
      durationMs: 400,
    });
  });

  it('rejects invalid endpoints and duration', () => {
    expect(() => resolvePageDragInput({ from: '', to: { x: 10, y: 20 } })).toThrow(
      '"from" must be',
    );
    expect(() =>
      resolvePageDragInput({ from: { x: 10, y: 20 }, to: { x: 30, y: 40 }, durationMs: 5001 }),
    ).toThrow('"durationMs" must be between 0 and 5000');
  });

  it('accepts an explicit DOM drag mode', () => {
    expect(
      resolvePageDragInput({
        from: { x: 10, y: 20 },
        to: { x: 30, y: 40 },
        dragMode: 'dom',
      }).dragMode,
    ).toBe('dom');
  });

  it('uses DOM simulation for hidden pages in auto mode', () => {
    expect(resolvePageDragDispatchPolicy('auto', 'hidden', true)).toEqual({
      dispatchMode: 'dom',
      pointerType: 'touch',
      fallbackReason: 'page-hidden',
    });
    expect(resolvePageDragDispatchPolicy('auto', 'visible', false)).toEqual({
      dispatchMode: 'trusted-input',
      pointerType: 'mouse',
    });
    expect(resolvePageDragDispatchPolicy('dom', 'visible', true)).toEqual({
      dispatchMode: 'dom',
      pointerType: 'touch',
    });
  });

  it('builds a bounded, interpolated path ending at the destination', () => {
    const path = buildPageDragPath({ x: 350, y: 80 }, { x: 80, y: 80 }, 400);
    expect(path.points).toHaveLength(16);
    expect(path.intervalMs).toBe(25);
    expect(path.points[0].x).toBeCloseTo(333.125);
    expect(path.points.at(-1)).toEqual({ x: 80, y: 80 });
  });

  it('dispatches an untrusted pointer and mouse sequence in the page world', () => {
    const eventTypes: string[] = [];
    class FakeEvent {
      constructor(
        readonly type: string,
        readonly init: Record<string, unknown>,
      ) {}
    }
    const view = {
      PointerEvent: FakeEvent,
      MouseEvent: FakeEvent,
      scrollX: 0,
      scrollY: 0,
    };
    const target = {
      ownerDocument: { defaultView: view },
      dispatchEvent(event: FakeEvent) {
        eventTypes.push(event.type);
        return true;
      },
    };
    vi.stubGlobal('window', view);
    vi.stubGlobal('document', { elementFromPoint: () => target });

    expect(
      dragBetweenPointsInPage(
        { x: 30, y: 20 },
        [
          { x: 20, y: 20 },
          { x: 10, y: 20 },
        ],
        'mouse',
      ),
    ).toEqual({ dragged: true, steps: 2 });
    expect(eventTypes).toEqual([
      'pointerdown',
      'mousedown',
      'pointermove',
      'mousemove',
      'pointermove',
      'mousemove',
      'mouseup',
      'pointerup',
    ]);
  });
});
