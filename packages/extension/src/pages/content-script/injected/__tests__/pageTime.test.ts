import { describe, expect, it, vi } from 'vitest';
import { applyPageTimeOverride, listenForPageTimeOverride } from '../pageTime';

describe('page time override runtime', () => {
  it('updates and restores Date in the page world', () => {
    const NativeDate = Date;
    const timeChangeListener = vi.fn();
    window.addEventListener('mearl:page-time-change', timeChangeListener);
    vi.spyOn(NativeDate, 'now').mockReturnValue(1_000);
    listenForPageTimeOverride();
    const capturedNativeNow = NativeDate.now;
    NativeDate.now = () => Date.now();

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'mearl-content',
          type: 'PAGE_TIME_OVERRIDE',
          offsetMs: 5_000,
          revision: 1,
        },
      }),
    );

    expect(Date.now()).toBe(6_000);
    expect(new Date().getTime()).toBe(6_000);
    expect(timeChangeListener).toHaveBeenCalledTimes(1);
    NativeDate.now = capturedNativeNow;

    applyPageTimeOverride(9_000, 0);
    applyPageTimeOverride(null, 0);
    expect(Date.now()).toBe(6_000);

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'mearl-content',
          type: 'PAGE_TIME_OVERRIDE',
          offsetMs: null,
          revision: 2,
        },
      }),
    );

    expect(Date).toBe(NativeDate);
    expect(timeChangeListener).toHaveBeenCalledTimes(2);
    window.removeEventListener('mearl:page-time-change', timeChangeListener);
    vi.restoreAllMocks();
  });
});
