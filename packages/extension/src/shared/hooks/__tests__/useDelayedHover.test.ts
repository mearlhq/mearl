import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedHover } from '../useDelayedHover';

describe('useDelayedHover', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens after 200ms without restarting a pending hover and cancels closing on reentry', () => {
    const { result } = renderHook(() => useDelayedHover());
    act(() => result.current.scheduleOpen());
    act(() => vi.advanceTimersByTime(199));
    expect(result.current.open).toBe(false);
    act(() => result.current.scheduleOpen());
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(true);
    act(() => result.current.scheduleClose());
    act(() => vi.advanceTimersByTime(199));
    expect(result.current.open).toBe(true);
    act(() => result.current.scheduleOpen());
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.open).toBe(true);
    act(() => result.current.scheduleClose());
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.open).toBe(false);
  });

  it('cancels opening on leave and clears pending work on explicit dismissal or unmount', () => {
    const { result, unmount } = renderHook(() => useDelayedHover());
    act(() => result.current.scheduleOpen());
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.scheduleClose());
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.open).toBe(false);
    act(() => result.current.scheduleOpen());
    act(() => result.current.setOpen(false));
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.scheduleOpen());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports custom delays and immediate opening while a close is pending', () => {
    const { result, unmount } = renderHook(() =>
      useDelayedHover({ openDelay: 180, closeDelay: 220 }),
    );
    act(() => result.current.scheduleOpen());
    act(() => vi.advanceTimersByTime(180));
    expect(result.current.open).toBe(true);
    act(() => result.current.scheduleClose());
    act(() => result.current.setOpen(true));
    act(() => vi.advanceTimersByTime(220));
    expect(result.current.open).toBe(true);
    act(() => result.current.scheduleClose());
    act(() => vi.advanceTimersByTime(219));
    expect(result.current.open).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
