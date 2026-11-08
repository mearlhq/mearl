import { act, fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAutoScroll } from '../useAutoScroll';

describe('useAutoScroll', () => {
  it('follows asynchronous content growth only while near the bottom', () => {
    const scrollContainer = document.createElement('div');
    const contentElement = document.createElement('div');
    let scrollHeight = 500;
    let onResize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        onResize = callback;
      }
      observe() {}
      disconnect = disconnect;
    });
    try {
      Object.defineProperties(scrollContainer, {
        scrollHeight: { get: () => scrollHeight },
        clientHeight: { value: 200 },
      });
      const { result, unmount } = renderHook(() => useAutoScroll(1, { contentElement }));
      act(() => result.current(scrollContainer));
      scrollHeight = 800;
      onResize();
      expect(scrollContainer.scrollTop).toBe(800);

      scrollContainer.scrollTop = 100;
      fireEvent.scroll(scrollContainer);
      scrollHeight = 1_000;
      onResize();
      expect(scrollContainer.scrollTop).toBe(100);
      unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores each context before paint without carrying over another context state', () => {
    const scrollContainer = document.createElement('div');
    let scrollHeight = 1_000;
    Object.defineProperty(scrollContainer, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollContainer, 'clientHeight', {
      configurable: true,
      value: 200,
    });
    const initialProps: {
      contentVersion: number | null;
      contextKey: number | null;
    } = {
      contentVersion: null,
      contextKey: null,
    };

    const { result, rerender } = renderHook(
      ({
        contentVersion,
        contextKey,
      }: {
        contentVersion: number | null;
        contextKey: number | null;
      }) => useAutoScroll(contentVersion, { contextKey }),
      {
        initialProps,
      },
    );

    act(() => result.current(scrollContainer));
    rerender({ contentVersion: 1, contextKey: 11 });
    expect(scrollContainer.scrollTop).toBe(1_000);

    scrollContainer.scrollTop = 250;
    fireEvent.scroll(scrollContainer);

    scrollHeight = 2_000;
    rerender({ contentVersion: 2, contextKey: 22 });
    expect(scrollContainer.scrollTop).toBe(2_000);

    scrollContainer.scrollTop = 1_800;
    fireEvent.scroll(scrollContainer);

    scrollHeight = 1_200;
    rerender({ contentVersion: 3, contextKey: 11 });
    expect(scrollContainer.scrollTop).toBe(250);

    scrollHeight = 2_200;
    rerender({ contentVersion: 4, contextKey: 22 });
    expect(scrollContainer.scrollTop).toBe(2_200);
  });
});
