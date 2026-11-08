import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeScript = vi.hoisted(() => vi.fn());
const getAllFrames = vi.hoisted(() => vi.fn());

import {
  clearActiveElementPickerSession,
  ensureElementPickerMainRuntime,
  ensureElementPickerMainRuntimeForFrames,
  getElementPickerPreviewFrameIds,
  restoreElementPickerSessionForFrame,
  selectElementPickerStartupFrames,
  selectInitialElementPickerFrame,
  setActiveElementPickerSession,
} from '../elementPickerRuntime';

describe('elementPickerRuntime', () => {
  beforeEach(() => {
    executeScript.mockReset().mockResolvedValue([]);
    clearActiveElementPickerSession(11);
    chrome.scripting = {
      executeScript,
    } as unknown as typeof chrome.scripting;
    chrome.tabs = { sendMessage: vi.fn() } as unknown as typeof chrome.tabs;
    chrome.webNavigation = { getAllFrames } as unknown as typeof chrome.webNavigation;
    getAllFrames.mockReset().mockImplementation((_details, callback) =>
      callback([
        { frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
        { frameId: 7, parentFrameId: 0, url: 'https://example.test/webview' },
      ]),
    );
  });

  it('reuses existing main-world runtimes frame by frame', async () => {
    executeScript.mockImplementation(({ target }) =>
      Promise.resolve([{ frameId: target.frameIds[0], result: true }]),
    );

    await expect(ensureElementPickerMainRuntime(11)).resolves.toBe(true);

    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 11, frameIds: [0] }, world: 'MAIN' }),
    );
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 11, frameIds: [7] }, world: 'MAIN' }),
    );
  });

  it('limits preview picking and session restore to the active business subtree', async () => {
    getAllFrames.mockResolvedValue([
      { frameId: 0, parentFrameId: -1 },
      { frameId: 7, parentFrameId: 0 },
      { frameId: 9, parentFrameId: 7 },
      { frameId: 12, parentFrameId: 0 },
    ]);
    setActiveElementPickerSession(11, { traceMode: false, commentMode: false, previewRootFrameId: 7 });
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ success: true });

    await expect(getElementPickerPreviewFrameIds(11, 7)).resolves.toEqual([7, 9]);
    await expect(restoreElementPickerSessionForFrame(11, 0)).resolves.toBe(false);
    await expect(restoreElementPickerSessionForFrame(11, 12)).resolves.toBe(false);
    await expect(restoreElementPickerSessionForFrame(11, 9)).resolves.toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(11, expect.any(Object), { frameId: 9 });
  });

  it('injects and verifies each requested frame independently', async () => {
    const readyFrames = new Set([0]);
    executeScript.mockImplementation(({ target, files }) => {
      const frameId = target.frameIds[0];
      if (files) {
        readyFrames.add(frameId);
        return Promise.resolve([]);
      }
      return Promise.resolve([{ frameId, result: readyFrames.has(frameId) }]);
    });

    await expect(ensureElementPickerMainRuntimeForFrames(11, [0, 7])).resolves.toEqual([0, 7]);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 11, frameIds: [7] },
      files: ['src/pages/content-script/element-picker-main-runtime.js'],
      world: 'MAIN',
    });
  });

  it('restores a regular picker through the frame content script without reinjection', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ success: true });
    setActiveElementPickerSession(11, {
      traceMode: false,
      commentMode: true,
      continuousCommentMode: true,
      topPage: { url: 'https://example.test/', title: 'Example' },
    });

    await expect(restoreElementPickerSessionForFrame(11, 13)).resolves.toBe(true);

    expect(executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        action: 'startElementPicker',
        commentMode: true,
        continuousCommentMode: true,
      }),
      { frameId: 13 },
    );
  });

  it('prepares the main-world tracer before restoring a trace picker', async () => {
    executeScript
      .mockResolvedValueOnce([{ frameId: 13, result: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ frameId: 13, result: true }]);
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ success: true });
    setActiveElementPickerSession(11, {
      traceMode: true,
      commentMode: false,
    });

    await expect(restoreElementPickerSessionForFrame(11, 13)).resolves.toBe(true);

    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 11, frameIds: [13] },
      files: ['src/pages/content-script/element-picker-main-runtime.js'],
      world: 'MAIN',
    });
  });

  it('requires an explicit success response from the frame runtime', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue(undefined);
    setActiveElementPickerSession(11, {
      traceMode: false,
      commentMode: false,
    });

    await expect(restoreElementPickerSessionForFrame(11, 13)).resolves.toBe(false);
  });

  it('does not contact a frame after the picker session ends', async () => {
    await expect(restoreElementPickerSessionForFrame(11, 13)).resolves.toBe(false);

    expect(executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('activates the top frame on pages and the deepest child in app simulation', () => {
    expect(selectInitialElementPickerFrame([0, 7, 13], false)).toBe(0);
    expect(selectInitialElementPickerFrame([0, 7, 13], true)).toBe(13);
  });

  it('starts app source tracing only in the preferred business frame', () => {
    expect(selectElementPickerStartupFrames([0, 7, 13], true, true)).toEqual([13]);
    expect(selectElementPickerStartupFrames([0, 7, 13], false, true)).toEqual([0, 7, 13]);
    expect(selectElementPickerStartupFrames([0, 7, 13], true, false)).toEqual([0, 7, 13]);
  });
});
