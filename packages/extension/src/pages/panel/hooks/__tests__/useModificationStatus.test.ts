import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModificationStatus } from '../useModificationStatus';
import { sendMessageSafely } from '../../utils/safeChrome';
import { showToast } from '../../utils/toast';

vi.mock('../../utils/safeChrome', () => ({ sendMessageSafely: vi.fn() }));
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));
vi.mock('../../utils/i18n', () => ({ t: (key: string) => key }));

describe('useModificationStatus failure feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(sendMessageSafely).mockReset();
    vi.mocked(showToast).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['Another debugger is already attached to the tab with id: 7.', 'Already attached'])(
    'explains how to resolve a debugger conflict: %s',
    async error => {
      vi.mocked(sendMessageSafely).mockResolvedValue({ success: false, error });
      const { result } = renderHook(() => useModificationStatus({ tabId: 7 }));

      await act(async () => result.current.toggleModification());

      expect(showToast).toHaveBeenCalledWith('responseModificationDebuggerBusy', 'error', 6000);
      expect(result.current.modificationEnabled).toBe(false);
    },
  );

  it.each([{ success: false, error: 'Cannot access this target' }, null])(
    'shows a fallback when enabling does not succeed: %j',
    async response => {
      vi.mocked(sendMessageSafely).mockResolvedValue(response);
      const { result } = renderHook(() => useModificationStatus({ tabId: 7 }));

      await act(async () => result.current.toggleModification());

      expect(showToast).toHaveBeenCalledWith('enableResponseModificationFailed', 'error', 6000);
      expect(result.current.modificationEnabled).toBe(false);
    },
  );

  it.each([
    [new Error('Another debugger is already attached'), 'responseModificationDebuggerBusy'],
    [new Error('Connection lost'), 'enableResponseModificationFailed'],
  ])('also reports rejected enable requests: %s', async (error, message) => {
    vi.mocked(sendMessageSafely).mockRejectedValue(error);
    const { result } = renderHook(() => useModificationStatus({ tabId: 7 }));

    await act(async () => result.current.toggleModification());

    expect(showToast).toHaveBeenCalledWith(message, 'error', 6000);
  });

  it('keeps successful enabling quiet and waits for the background status', async () => {
    vi.mocked(sendMessageSafely).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useModificationStatus({ tabId: 7 }));

    await act(async () => result.current.toggleModification());

    expect(sendMessageSafely).toHaveBeenCalledWith({ action: 'enableModification', tabId: 7 });
    expect(showToast).not.toHaveBeenCalled();
    expect(result.current.modificationEnabled).toBe(false);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('mearl-debugger-status-changed', {
          detail: { attached: true },
        }),
      );
    });
    expect(result.current.modificationEnabled).toBe(true);
  });
});
