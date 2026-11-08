import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupTimeForTab,
  disableTimeForTab,
  enableTimeForTab,
  getTimeOverrideForTab,
} from '../pageTimeOverride';

describe('page time override', () => {
  const sessionValues: Record<string, unknown> = {};

  beforeEach(async () => {
    vi.restoreAllMocks();
    chrome.tabs = {
      sendMessage: vi.fn(),
    } as unknown as typeof chrome.tabs;
    chrome.storage.session = {
      get: vi.fn(async (key: string) => ({ [key]: sessionValues[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(sessionValues, values);
      }),
      remove: vi.fn(async (key: string) => {
        delete sessionValues[key];
      }),
    } as unknown as typeof chrome.storage.session;
    vi.mocked(chrome.tabs.sendMessage).mockReset().mockResolvedValue(undefined);
    await cleanupTimeForTab(2001);
  });

  it('injects a running clock offset into the MAIN world', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await enableTimeForTab(2001, 6_000);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(2001, {
      action: 'pageTimeOverride',
      offsetMs: 5_000,
      revision: 1,
    });
    await expect(getTimeOverrideForTab(2001)).resolves.toEqual({
      offsetMs: 5_000,
      revision: 1,
    });
  });

  it('keeps the offset for the content-script startup handshake when direct delivery fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(new Error('No receiver'));

    await enableTimeForTab(2001, 6_000);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(2001, {
      action: 'pageTimeOverride',
      offsetMs: 5_000,
      revision: 1,
    });
    await expect(getTimeOverrideForTab(2001)).resolves.toEqual({
      offsetMs: 5_000,
      revision: 1,
    });
  });

  it('always requests native clock restoration and stores its revision', async () => {
    await disableTimeForTab(2001);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(2001, {
      action: 'pageTimeOverride',
      offsetMs: null,
      revision: 1,
    });
    await expect(getTimeOverrideForTab(2001)).resolves.toEqual({
      offsetMs: null,
      revision: 1,
    });
  });

  it('increments revisions across updates and can stage an override before notifying the page', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await enableTimeForTab(2001, 6_000, false);
    await enableTimeForTab(2001, 8_000, false);

    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    await expect(getTimeOverrideForTab(2001)).resolves.toEqual({
      offsetMs: 7_000,
      revision: 2,
    });
  });
});
