import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExtensionConfig } from '../useExtensionConfig';
import {
  DEFAULT_CONFIG,
  getConfig,
  onConfigChange,
  type ExtensionConfig,
} from '../../utils/config';

vi.mock('../../utils/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/config')>()),
  getConfig: vi.fn(),
  onConfigChange: vi.fn(),
}));

let listener: (changes: Partial<ExtensionConfig>) => void;
let unsubscribe = vi.fn<() => void>();

beforeEach(() => {
  unsubscribe = vi.fn<() => void>();
  vi.mocked(onConfigChange).mockImplementation(callback => {
    listener = callback;
    return unsubscribe;
  });
  vi.mocked(getConfig).mockResolvedValue(DEFAULT_CONFIG);
});

describe('configuration bootstrap and subscription', () => {
  it('keeps updates that arrive before an older initial snapshot finishes loading', async () => {
    let finish!: (config: ExtensionConfig) => void;
    vi.mocked(getConfig).mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(() => useExtensionConfig());
    act(() => listener({ requestCasesEnabled: true, trackingMetadataEnabled: true }));
    await act(async () => finish(DEFAULT_CONFIG));
    expect(result.current[0].requestCasesEnabled).toBe(true);
    expect(result.current[0].trackingMetadataEnabled).toBe(true);
    expect(result.current[1]).toBe(true);
  });

  it('does not reread a supplied bootstrap and continues to receive changes', () => {
    vi.mocked(getConfig).mockClear();
    const { result } = renderHook(() => useExtensionConfig(DEFAULT_CONFIG));
    act(() => listener({ accountsEnabled: true }));
    expect(result.current[0].accountsEnabled).toBe(true);
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('drops a late initial snapshot after unmounting and removes its subscription', async () => {
    let finish!: (config: ExtensionConfig) => void;
    vi.mocked(getConfig).mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const { unmount } = renderHook(() => useExtensionConfig());
    unmount();
    await act(async () => finish(DEFAULT_CONFIG));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('merges normal updates after initialization without losing other fields', async () => {
    const { result } = renderHook(() => useExtensionConfig());
    await waitFor(() => expect(result.current[1]).toBe(true));
    act(() => listener({ language: 'en', trackingMetadataEnabled: true }));
    expect(result.current[0]).toEqual({ ...DEFAULT_CONFIG, language: 'en', trackingMetadataEnabled: true });
  });

  it('applies service updates to a preview initialized with local preferences', async () => {
    const { result } = renderHook(() => useExtensionConfig(undefined, { localOnly: true }));
    await waitFor(() => expect(result.current[1]).toBe(true));
    expect(getConfig).toHaveBeenCalledWith({ localOnly: true });
    act(() => listener({ requestMetadataEnabled: true }));
    expect(result.current[0].requestMetadataEnabled).toBe(true);
  });
});
