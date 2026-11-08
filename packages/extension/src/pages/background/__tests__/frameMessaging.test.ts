import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendTabMessageToFrameIdsSafe, sendTabMessageToFramesSafe } from '../frameMessaging';

describe('frameMessaging', () => {
  const getAllFrames = vi.fn();
  const sendMessage = vi.fn();

  beforeEach(() => {
    getAllFrames.mockReset();
    sendMessage.mockReset();
    chrome.webNavigation = { getAllFrames } as unknown as typeof chrome.webNavigation;
    chrome.tabs = { sendMessage } as unknown as typeof chrome.tabs;
  });

  it('delivers to each current frame and preserves frame ids for aggregation', async () => {
    getAllFrames.mockImplementation((_details, callback) =>
      callback([
        { frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
        { frameId: 7, parentFrameId: 0, url: 'https://example.test/webview' },
      ]),
    );
    sendMessage.mockImplementation((_tabId, _message, options) =>
      Promise.resolve({ found: options.frameId === 7 ? 2 : 0 }),
    );

    await expect(
      sendTabMessageToFramesSafe<{ found: number }>(11, { action: 'highlightSpm' }),
    ).resolves.toEqual([
      { frameId: 0, response: { found: 0 } },
      { frameId: 7, response: { found: 2 } },
    ]);
    expect(sendMessage).toHaveBeenCalledWith(11, { action: 'highlightSpm' }, { frameId: 0 });
    expect(sendMessage).toHaveBeenCalledWith(11, { action: 'highlightSpm' }, { frameId: 7 });
  });

  it('keeps reachable frames when another frame has no content script', async () => {
    getAllFrames.mockImplementation((_details, callback) =>
      callback([
        { frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
        { frameId: 9, parentFrameId: 0, url: 'https://restricted.test/' },
      ]),
    );
    sendMessage.mockImplementation((_tabId, _message, options) =>
      options.frameId === 0
        ? Promise.resolve({ success: true })
        : Promise.reject(new Error('Could not establish connection')),
    );

    await expect(sendTabMessageToFramesSafe(11, { action: 'clearSpmHighlight' })).resolves.toEqual([
      { frameId: 0, response: { success: true } },
    ]);
  });

  it('falls back to tab broadcast when frame discovery is unavailable', async () => {
    chrome.webNavigation = {} as typeof chrome.webNavigation;
    sendMessage.mockResolvedValue({ success: true });

    await expect(sendTabMessageToFramesSafe(11, { action: 'stopHeatmap' })).resolves.toEqual([
      { frameId: 0, response: { success: true } },
    ]);
    expect(sendMessage).toHaveBeenCalledWith(11, { action: 'stopHeatmap' });
  });

  it('targets only the requested unique frame ids', async () => {
    sendMessage.mockImplementation((_tabId, _message, options) =>
      Promise.resolve({ success: options.frameId === 7 }),
    );

    await expect(
      sendTabMessageToFrameIdsSafe<{ success: boolean }>(
        11,
        [7, 7, 9],
        { action: 'startElementPicker' },
      ),
    ).resolves.toEqual([
      { frameId: 7, response: { success: true } },
      { frameId: 9, response: { success: false } },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
