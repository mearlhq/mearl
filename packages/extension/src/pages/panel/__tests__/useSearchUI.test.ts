import { createRef } from 'react';
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSearchUI } from '../hooks/useSearchUI';

describe('useSearchUI', () => {
  it('单个匹配重复导航时应递增定位版本号', () => {
    const containerRef = createRef<HTMLDivElement>();
    containerRef.current = document.createElement('div');

    const { result } = renderHook(() => useSearchUI(containerRef));

    act(() => {
      result.current.setTotalMatches(1);
    });

    expect(result.current.currentMatchIndex).toBe(0);
    expect(result.current.matchNavigationVersion).toBe(0);

    act(() => {
      result.current.handleNextMatch();
    });

    expect(result.current.currentMatchIndex).toBe(0);
    expect(result.current.matchNavigationVersion).toBe(1);

    act(() => {
      result.current.handlePrevMatch();
    });

    expect(result.current.currentMatchIndex).toBe(0);
    expect(result.current.matchNavigationVersion).toBe(2);
  });

  it('无匹配时不应递增定位版本号', () => {
    const containerRef = createRef<HTMLDivElement>();
    containerRef.current = document.createElement('div');

    const { result } = renderHook(() => useSearchUI(containerRef));

    act(() => {
      result.current.handleNextMatch();
      result.current.handlePrevMatch();
    });

    expect(result.current.currentMatchIndex).toBe(0);
    expect(result.current.matchNavigationVersion).toBe(0);
  });

  it('流式内容增加匹配数时应保留当前匹配项', () => {
    vi.useFakeTimers();
    const containerRef = createRef<HTMLDivElement>();
    containerRef.current = document.createElement('div');

    const { result } = renderHook(() =>
      useSearchUI(containerRef, { preserveCurrentOnMatchCountChange: true }),
    );

    act(() => {
      result.current.setInputValue('test');
      vi.advanceTimersByTime(300);
      result.current.setTotalMatches(3);
    });
    act(() => {
      result.current.handleNextMatch();
    });
    expect(result.current.currentMatchIndex).toBe(1);

    act(() => {
      result.current.setTotalMatches(4);
    });

    expect(result.current.currentMatchIndex).toBe(1);
    vi.useRealTimers();
  });
});
