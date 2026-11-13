import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backgroundPageActivity', () => ({
  setBackgroundPageActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../backgroundRequestCollector', () => ({
  cleanupCollector: vi.fn(),
  listCollectingTabIds: vi.fn(() => [2]),
  stopRequestCollection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../debuggerManager', () => ({
  listDebuggerControlTabIds: vi.fn(() => []),
  releaseDebuggerControlForTab: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../debuggerSessionManager', () => ({
  listActiveDebuggerTabIds: vi.fn(() => [3]),
}));
vi.mock('../../overrideNotifier', () => ({
  notifyPanelOverrideChanged: vi.fn(),
}));
vi.mock('../../utils/appProfileRules', () => ({
  clearAppProfileForTab: vi.fn().mockResolvedValue(undefined),
  listAppProfileTabIds: vi.fn().mockResolvedValue([5]),
}));
vi.mock('../../deviceShellRules', () => ({
  clearDeviceShellForTab: vi.fn((tabId: number) => Promise.resolve(tabId === 6)),
  listDeviceShellTabIds: vi.fn().mockResolvedValue([6]),
}));
vi.mock('../../quickDeviceSimulationState', () => ({
  disableQuickDeviceSimulationState: vi.fn().mockResolvedValue(undefined),
  listActiveQuickDeviceSimulationTabIds: vi.fn().mockResolvedValue([7]),
}));
vi.mock('../controlledTabs', () => ({
  listControlledTabIds: vi.fn().mockResolvedValue([3, 1]),
  releaseControlledTab: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../tabHandlers', () => ({
  listCollectingMarkerTabIds: vi.fn(() => [2]),
  removeCollectingTab: vi.fn().mockResolvedValue(undefined),
}));

import { setBackgroundPageActivity } from '../../backgroundPageActivity';
import { cleanupCollector, stopRequestCollection } from '../../backgroundRequestCollector';
import { releaseDebuggerControlForTab } from '../../debuggerManager';
import { clearAppProfileForTab } from '../../utils/appProfileRules';
import { clearDeviceShellForTab } from '../../deviceShellRules';
import { disableQuickDeviceSimulationState } from '../../quickDeviceSimulationState';
import { releaseControlledTab } from '../controlledTabs';
import { removeCollectingTab } from '../tabHandlers';
import { handleBrowserRelease } from '../releaseHandlers';
import { runSerializedQuickSimulationUpdate } from '../../quickSimulationUpdateQueue';

describe('browser_manage release extension handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stopRequestCollection).mockResolvedValue(undefined);
    vi.mocked(removeCollectingTab).mockResolvedValue(undefined);
    chrome.tabs = { reload: vi.fn().mockResolvedValue(undefined) } as never;
  });

  it('waits for in-flight environment work before resetting its page', async () => {
    let finish!: () => void, started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    let current = 'baseline';
    const inFlight = runSerializedQuickSimulationUpdate(42, async () => {
      started();
      await gate;
      current = 'owned change';
    });
    await running;
    vi.mocked(releaseDebuggerControlForTab).mockImplementationOnce(async () => {
      current = 'reset';
      return true;
    });
    const reset = handleBrowserRelease({ tabIds: [42] });
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseDebuggerControlForTab).not.toHaveBeenCalled();
    finish();
    await inFlight;
    await reset;
    expect(current).toBe('reset');
    expect(releaseDebuggerControlForTab).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('releases every control source without closing tabs', async () => {
    await expect(handleBrowserRelease()).resolves.toEqual({
      released: true,
      hadActiveControl: true,
      affectedTabIds: [1, 2, 3, 5, 6, 7],
    });

    for (const tabId of [1, 2, 3, 5, 6, 7]) {
      expect(setBackgroundPageActivity).toHaveBeenCalledWith(tabId, false);
      expect(stopRequestCollection).toHaveBeenCalledWith(tabId);
      expect(cleanupCollector).toHaveBeenCalledWith(tabId);
      expect(removeCollectingTab).toHaveBeenCalledWith(tabId);
      expect(clearAppProfileForTab).toHaveBeenCalledWith(tabId);
      expect(clearDeviceShellForTab).toHaveBeenCalledWith(tabId);
      expect(disableQuickDeviceSimulationState).toHaveBeenCalledWith(tabId);
      expect(releaseDebuggerControlForTab).toHaveBeenCalledWith(tabId);
      expect(releaseControlledTab).toHaveBeenCalledWith(tabId);
    }
    expect(chrome.tabs.reload).toHaveBeenCalledExactlyOnceWith(6);
    expect(chrome.tabs.remove).toBeUndefined();
  });

  it('reports a failed cleanup stage after continuing the remaining release work', async () => {
    vi.mocked(removeCollectingTab).mockRejectedValueOnce(new Error('DNR unavailable'));

    const result = await handleBrowserRelease();

    expect(result.released).toBe(false);
    expect(result.failures).toEqual([
      {
        tabId: 1,
        stage: 'collection_marker',
        error: 'DNR unavailable',
      },
    ]);
    expect(releaseDebuggerControlForTab).toHaveBeenCalledWith(1);
    expect(releaseControlledTab).toHaveBeenCalledWith(1);
  });
});

it('restores temporary page activity even when the page environment is preserved', async () => {
  const result = await handleBrowserRelease({ tabIds: [42], preserveEnvironment: true });
  expect(result.released).toBe(true);
  expect(setBackgroundPageActivity).toHaveBeenCalledWith(42, false);
});
