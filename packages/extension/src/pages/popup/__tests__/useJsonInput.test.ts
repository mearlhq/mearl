import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useJsonInput } from '../hooks/useJsonInput';

describe('useJsonInput', () => {
  let resolveStorageGet: (result: Record<string, unknown>) => void | Promise<void>;

  beforeEach(() => {
    chrome.storage.local.get = vi.fn((_keys, callback) => {
      resolveStorageGet = callback;
    }) as unknown as typeof chrome.storage.local.get;
    chrome.tabs = {
      query: vi.fn().mockResolvedValue([{ url: 'https://example.com/current' }]),
    } as unknown as typeof chrome.tabs;
  });

  it('当前页面数据确定前保持未初始化状态', async () => {
    const { result } = renderHook(() => useJsonInput());

    expect(result.current.isInitialized).toBe(false);

    await act(async () => {
      await resolveStorageGet({});
    });

    await waitFor(() => {
      expect(result.current.inputText).toBe('https://example.com/current');
      expect(result.current.isInitialized).toBe(true);
    });
  });

  it('defers input until the formatter opens and reuses reads across view switches', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useJsonInput({ enableAutoLoad: enabled }),
      { initialProps: { enabled: false } },
    );
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(result.current.isInitialized).toBe(false);
    rerender({ enabled: true });
    rerender({ enabled: false });
    await act(async () => {
      await resolveStorageGet({ jsonFormatterData: '{"saved":1}' });
    });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    expect(result.current.inputText).toContain('saved');
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.query).toHaveBeenCalledTimes(1);
  });
});

it('renders prepared input and expansion paths without reloading or consuming another transfer', () => {
  const snapshot = {
    inputText: 'https://example.com/prepared',
    isStandalonePage: true,
    expandedPaths: { root: true },
  };
  const restore = vi.fn();
  vi.mocked(chrome.storage.local.get).mockClear();
  const { result } = renderHook(() =>
    useJsonInput({ initialInput: snapshot, onExpandedPathsRestore: restore }),
  );
  expect(result.current.inputText).toBe(snapshot.inputText);
  expect(result.current.isInitialized).toBe(true);
  expect(result.current.isStandalonePage).toBe(true);
  expect(chrome.storage.local.get).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
});
