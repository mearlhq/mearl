import { expect, it, vi } from 'vitest';
import {
  DEVICE_PREVIEW_PANEL_PAGE,
  DEVICE_PREVIEW_PANEL_PORT,
  DEVICE_PREVIEW_PANEL_READY_ACTION,
  PANEL_PRESERVE_LOG_KEY,
} from '../../../shared/devicePreviewPanel';
import type { CapturedRequest } from '../../panel/types';
import { runSerializedQuickSimulationUpdate } from '../quickSimulationUpdateQueue';

const collector = vi.hoisted(() => ({
  startRequestCollection: vi.fn().mockResolvedValue(undefined),
  stopRequestCollection: vi.fn().mockResolvedValue(undefined),
  getCollectorSnapshot: vi.fn().mockReturnValue({ requests: [], events: [] }),
}));
vi.mock('../backgroundRequestCollector', () => collector);

import {
  closeDevicePreviewPanel,
  connectDevicePreviewPanel,
  getDevicePreviewPanelPort,
  getDevicePreviewPanelToken,
  navigateDevicePreviewPanel,
  updateDevicePreviewPanel,
} from '../devicePreviewPanel';

function viewer(
  tabId: number,
  token: string,
  url = chrome.runtime.getURL(DEVICE_PREVIEW_PANEL_PAGE),
  onDisconnect?: Parameters<typeof connectDevicePreviewPanel>[1],
) {
  const port = {
    name: DEVICE_PREVIEW_PANEL_PORT + token,
    sender: {
      id: chrome.runtime.id,
      tab: { id: tabId },
      frameId: 2,
      url,
      documentId: 'preview-document',
    },
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
  };
  connectDevicePreviewPanel(port as unknown as chrome.runtime.Port, onDisconnect);
  return port;
}

it('binds captured data to the granted extension frame and resets it on navigation', async () => {
  Object.assign(chrome.runtime, {
    id: 'test-extension',
    getURL: (path: string) => `chrome-extension://test-extension/${path}`,
  });
  const tabId = 17;
  const previousTabs = chrome.tabs;
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  chrome.tabs = { ...chrome.tabs, sendMessage } as typeof chrome.tabs;
  const stored = vi.mocked(
    chrome.storage.local.get as (key: string) => Promise<Record<string, unknown>>,
  );
  stored.mockResolvedValue({});
  let finishUpdate!: () => void;
  const update = runSerializedQuickSimulationUpdate(
    tabId,
    () =>
      new Promise<void>(resolve => {
        finishUpdate = resolve;
      }),
  );
  const token = getDevicePreviewPanelToken(tabId, true)!;
  try {
    expect(viewer(tabId + 1, token).disconnect).toHaveBeenCalled();
    expect(viewer(tabId, 'invalid').disconnect).toHaveBeenCalled();
    expect(viewer(tabId, token, 'https://example.test').disconnect).toHaveBeenCalled();
    const port = viewer(
      tabId,
      token,
      chrome.runtime.getURL(DEVICE_PREVIEW_PANEL_PAGE) + '?viewer=first#' + token,
    );
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'state', state: 'connecting', tabId });
    port.onMessage.addListener.mock.calls[0]![0]('ready');
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      tabId,
      {
        action: DEVICE_PREVIEW_PANEL_READY_ACTION,
        viewer: 'first',
      },
      { frameId: 0 },
    );
    expect(collector.startRequestCollection).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finishUpdate).toBeTypeOf('function'));
    finishUpdate();
    await update;
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'state', state: 'capturing', tabId }),
    );
    const timestamp = Date.now() + 100;
    await navigateDevicePreviewPanel(tabId, timestamp, 'https://example.test/');
    expect(getDevicePreviewPanelToken(tabId)).toBe(token);
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'snapshot',
      requests: [],
      events: [],
      navigation: [],
    });
    port.onDisconnect.addListener.mock.calls[0]![0]();
    const resumed = viewer(tabId, token);
    expect(resumed.postMessage.mock.calls).toEqual([
      [{ type: 'state', state: 'capturing', tabId }],
      [{ type: 'snapshot', requests: [], events: [], navigation: [] }],
    ]);
    expect(collector.startRequestCollection).toHaveBeenCalledExactlyOnceWith(
      tabId,
      'device-preview-panel',
    );
    const request: CapturedRequest = {
      id: 1,
      timestamp: new Date(timestamp - 1).toISOString(),
      timestampMs: timestamp - 1,
      method: 'GET',
      url: 'https://example.test/api/items',
      apiName: '/api/items',
      headers: [],
      responseHeaders: [],
      queryString: [],
      postData: null,
      isProxy: false,
      proxyRequestUrl: null,
      proxyData: null,
      resourceType: 'fetch',
      status: 200,
      statusText: 'OK',
      responseBody: { ok: true },
    };
    updateDevicePreviewPanel(tabId, { type: 'request', request, removedRequestIds: [] });
    expect(resumed.postMessage).toHaveBeenLastCalledWith({
      type: 'request',
      request: undefined,
      removed: [],
    });
    updateDevicePreviewPanel(tabId, {
      type: 'request',
      request: { ...request, timestampMs: timestamp + 1 },
      removedRequestIds: [],
    });
    expect(resumed.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ apiName: '/api/items', responseBody: { ok: true } }),
      }),
    );
    stored.mockResolvedValueOnce({ [PANEL_PRESERVE_LOG_KEY]: true });
    await navigateDevicePreviewPanel(tabId, timestamp + 200, 'https://example.test/next');
    expect(resumed.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        navigation: [expect.objectContaining({ url: 'https://example.test/next' })],
      }),
    );
    closeDevicePreviewPanel(tabId);
    expect(resumed.disconnect).toHaveBeenCalled();
    expect(collector.stopRequestCollection).toHaveBeenCalledWith(tabId, 'device-preview-panel');
    expect(getDevicePreviewPanelToken(tabId)).toBeNull();
  } finally {
    finishUpdate?.();
    chrome.tabs = previousTabs;
    stored.mockReset();
    closeDevicePreviewPanel(tabId);
  }
});

it('releases the picker owner when its embedded document is disconnected or closed', () => {
  const tabId = 19;
  const token = getDevicePreviewPanelToken(tabId, true)!;
  const disconnect = vi.fn();
  try {
    const port = viewer(tabId, token, undefined, disconnect);
    expect(getDevicePreviewPanelPort(tabId, port.sender.documentId)).toBe(port);
    expect(getDevicePreviewPanelPort(tabId, 'another-document')).toBeUndefined();
    port.onDisconnect.addListener.mock.calls[0]![0]();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(tabId, port);
    expect(getDevicePreviewPanelPort(tabId, port.sender.documentId)).toBeUndefined();

    const reopened = viewer(tabId, token, undefined, disconnect);
    closeDevicePreviewPanel(tabId);
    expect(disconnect).toHaveBeenLastCalledWith(tabId, reopened);
    expect(reopened.disconnect).toHaveBeenCalledOnce();
  } finally {
    closeDevicePreviewPanel(tabId);
  }
});

it('restarts failed capture when the outer preview requests a retry', async () => {
  const tabId = 18;
  collector.startRequestCollection.mockRejectedValueOnce(new Error('temporarily unavailable'));
  const token = getDevicePreviewPanelToken(tabId, true)!;
  try {
    const initial = viewer(tabId, token);
    await vi.waitFor(() =>
      expect(initial.postMessage).toHaveBeenCalledWith({ type: 'state', state: 'error', tabId }),
    );
    expect(getDevicePreviewPanelToken(tabId, true, true)).toBe(token);
    const replacement = viewer(tabId, token);
    await vi.waitFor(() =>
      expect(replacement.postMessage).toHaveBeenCalledWith({
        type: 'state',
        state: 'capturing',
        tabId,
      }),
    );
  } finally {
    closeDevicePreviewPanel(tabId);
  }
});
