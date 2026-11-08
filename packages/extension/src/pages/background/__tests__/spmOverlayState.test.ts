import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSpmOverlayState,
  restoreSpmOverlayForFrame,
  setSpmOverlayEnabled,
} from '../spmOverlayState';

describe('spmOverlayState', () => {
  const sendMessage = vi.fn();

  beforeEach(() => {
    sendMessage.mockReset();
    chrome.tabs = { sendMessage } as unknown as typeof chrome.tabs;
    clearSpmOverlayState(11);
  });

  it('restores enabled SPM highlighting in a newly ready frame', async () => {
    sendMessage.mockResolvedValue({ success: true });
    setSpmOverlayEnabled(11, true);

    await expect(restoreSpmOverlayForFrame(11, 13)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      11,
      { action: 'toggleSpmOverlay', enabled: true },
      { frameId: 13 },
    );
  });

  it('does not contact a new frame when highlighting is disabled', async () => {
    setSpmOverlayEnabled(11, true);
    setSpmOverlayEnabled(11, false);

    await expect(restoreSpmOverlayForFrame(11, 13)).resolves.toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('clears the state when its tab is removed', async () => {
    setSpmOverlayEnabled(11, true);
    clearSpmOverlayState(11);

    await expect(restoreSpmOverlayForFrame(11, 13)).resolves.toBe(false);
  });

  it('ignores frames that become unreachable during restoration', async () => {
    sendMessage.mockRejectedValue(new Error('Frame was removed'));
    setSpmOverlayEnabled(11, true);

    await expect(restoreSpmOverlayForFrame(11, 13)).resolves.toBe(false);
  });
});
