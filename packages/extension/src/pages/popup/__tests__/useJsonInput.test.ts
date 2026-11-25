import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJsonInput } from '../hooks/useJsonInput';

describe('useJsonInput', () => {
  let resolveStorageGet: (result: Record<string, unknown>) => void | Promise<void>;
  const readText = vi.fn<() => Promise<string>>();

  beforeEach(() => {
    readText.mockReset().mockResolvedValue('');
    vi.stubGlobal('navigator', { clipboard: { readText } });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    chrome.storage.local.get = vi.fn((_keys, callback) => {
      resolveStorageGet = callback;
    }) as unknown as typeof chrome.storage.local.get;
    chrome.tabs = {
      query: vi.fn().mockResolvedValue([{ url: 'https://example.com/current' }]),
    } as unknown as typeof chrome.tabs;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    expect(readText).not.toHaveBeenCalled();
  });

  it.each([
    [' {"from":"clipboard"}\n', { from: 'clipboard' }],
    ['[1,2]', [1, 2]],
  ])('auto-pastes JSON %s and exposes the page URL for undo', async (text, parsed) => {
    readText.mockResolvedValue(text);
    const { result } = renderHook(() => useJsonInput());
    await act(async () => {
      await resolveStorageGet({});
    });

    expect(result.current.inputText).toBe(text.trim());
    expect(result.current.parsedClipboardInput?.parsed).toEqual(parsed);
    expect(result.current.autoPasteUndoInput).toBe('https://example.com/current');
  });

  it.each([
    '',
    'plain text',
    'https://example.com/copied',
    'a=1&b=2',
    'false',
    '"https://example.com/quoted"',
    'prefix {"value":1}',
    '{"value":1,}',
  ])('keeps the current URL for non-JSON clipboard text %s', async text => {
    readText.mockResolvedValue(text);
    const { result } = renderHook(() => useJsonInput());
    await act(async () => {
      await resolveStorageGet({});
    });

    expect(result.current.inputText).toBe('https://example.com/current');
    expect(result.current.autoPasteUndoInput).toBeUndefined();
  });

  it('keeps the current URL when clipboard access is denied', async () => {
    readText.mockRejectedValue(new Error('Document is not focused'));
    const { result } = renderHook(() => useJsonInput());
    await act(async () => {
      await resolveStorageGet({});
    });

    expect(result.current.inputText).toBe('https://example.com/current');
    expect(result.current.autoPasteUndoInput).toBeUndefined();
  });

  it('reads the clipboard when the newly opened popup gets focus', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    readText.mockResolvedValue('{"from":"clipboard"}');
    const { result } = renderHook(() => useJsonInput());
    await act(async () => {
      await resolveStorageGet({});
    });
    expect(readText).not.toHaveBeenCalled();

    await act(async () => {
      vi.mocked(document.hasFocus).mockReturnValue(true);
      window.dispatchEvent(new Event('focus'));
    });

    expect(result.current.inputText).toBe('{"from":"clipboard"}');
    expect(result.current.autoPasteUndoInput).toBe('https://example.com/current');
  });

  it('uses the welcome content as the undo input when there is no page URL', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);
    readText.mockResolvedValue('{"from":"clipboard"}');
    const { result } = renderHook(() => useJsonInput());
    await act(async () => {
      await resolveStorageGet({});
    });

    expect(result.current.inputText).toBe('{"from":"clipboard"}');
    expect(JSON.parse(result.current.autoPasteUndoInput ?? '')).toMatchObject({
      name: 'mearl.welcome',
    });
  });

  it('keeps user input if the initial clipboard read resolves after a manual paste', async () => {
    let resolveClipboard!: (text: string) => void;
    readText.mockReturnValue(new Promise(resolve => (resolveClipboard = resolve)));
    const { result } = renderHook(() => useJsonInput());
    await act(async () => {
      await resolveStorageGet({});
    });
    act(() => result.current.processInputText('{"manual":true}'));
    await act(async () => resolveClipboard('{"automatic":true}'));

    expect(result.current.inputText).toBe('{"manual":true}');
    expect(result.current.autoPasteUndoInput).toBeUndefined();
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
