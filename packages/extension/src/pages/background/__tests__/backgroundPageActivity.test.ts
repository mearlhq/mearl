import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  releaseBackgroundPageActivities,
  setBackgroundPageActivity,
} from '../backgroundPageActivity';
import { handleDebuggerSessionDetach } from '../debuggerSessionManager';

describe('control session background activity', () => {
  beforeEach(() => {
    chrome.tabs = { update: vi.fn() } as never;
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});
  });
  afterEach(async () => {
    await releaseBackgroundPageActivities();
  });

  it('keeps one focus lease and restores it without activating a tab or a window', async () => {
    await Promise.all([
      setBackgroundPageActivity(8801, true),
      setBackgroundPageActivity(8801, true),
    ]);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 8801 },
      'Emulation.setFocusEmulationEnabled',
      { enabled: true },
    );
    await setBackgroundPageActivity(8801, false);
    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 8801 },
      'Emulation.setFocusEmulationEnabled',
      { enabled: false },
    );
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 8801 });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('serializes release against a pending activation', async () => {
    let resolve!: () => void;
    vi.mocked(chrome.debugger.sendCommand).mockImplementationOnce(
      () =>
        new Promise<void>(r => {
          resolve = r;
        }),
    );
    const enabling = setBackgroundPageActivity(8802, true);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    const releasing = setBackgroundPageActivity(8802, false);
    resolve();
    await Promise.all([enabling, releasing]);
    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 8802 },
      'Emulation.setFocusEmulationEnabled',
      { enabled: false },
    );
  });

  it('reacquires after debugger invalidation', async () => {
    await setBackgroundPageActivity(8803, true);
    handleDebuggerSessionDetach(8803, 'target_closed');
    await setBackgroundPageActivity(8803, true);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed restoration retryable', async () => {
    await setBackgroundPageActivity(8804, true);
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(new Error('connection busy'));
    await expect(setBackgroundPageActivity(8804, false)).rejects.toThrow('connection busy');
    await setBackgroundPageActivity(8804, false);
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 8804 });
  });
});

it('rolls back a failed enable before releasing its debugger lease', async () => {
  chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.sendCommand = vi
    .fn()
    .mockRejectedValueOnce(new Error('enable failed'))
    .mockResolvedValue({});
  await expect(setBackgroundPageActivity(8805, true)).rejects.toThrow('enable failed');
  expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
    { tabId: 8805 },
    'Emulation.setFocusEmulationEnabled',
    { enabled: false },
  );
  expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 8805 });
});

it('retries enabling when both enable and rollback failed', async () => {
  chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.sendCommand = vi
    .fn()
    .mockRejectedValueOnce(new Error('enable failed'))
    .mockRejectedValueOnce(new Error('rollback failed'))
    .mockResolvedValue({});
  try {
    await expect(setBackgroundPageActivity(8806, true)).rejects.toThrow(
      'Failed to enable and restore',
    );
    await setBackgroundPageActivity(8806, true);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(3);
    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 8806 },
      'Emulation.setFocusEmulationEnabled',
      { enabled: true },
    );
  } finally {
    await releaseBackgroundPageActivities();
  }
});

it('restores an enable that completes after its connection is aborted', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.sendCommand = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({});
  const enabling = setBackgroundPageActivity(8807, true, controller.signal);
  const rejected = expect(enabling).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  const restoring = releaseBackgroundPageActivities();
  finish();
  await rejected;
  await restoring;
  expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
    { tabId: 8807 },
    'Emulation.setFocusEmulationEnabled',
    { enabled: false },
  );
  expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 8807 });
});
