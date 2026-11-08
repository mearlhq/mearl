import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequestPermission } from '../permissionHandlers';
import {
  POPUP_PERMISSION_REQUEST,
  POPUP_PERMISSION_CANCEL,
  POPUP_PERMISSION_ALLOW,
} from '../../../../shared/permissionRequest';
import { grantAgentOriginPermission } from '../../../../shared/proxyPermissions';

vi.mock('../../../../shared/proxyPermissions', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../shared/proxyPermissions')>()),
  grantAgentOriginPermission: vi.fn(),
}));

const getContexts = vi.fn();
const sendMessage = vi.fn();

describe('domain permission confirmation routing', () => {
  beforeEach(() => {
    vi.mocked(grantAgentOriginPermission).mockReset();
    chrome.runtime.id = 'test-extension';
    chrome.runtime.ContextType = { POPUP: 'POPUP' } as typeof chrome.runtime.ContextType;
    chrome.runtime.getContexts = getContexts;
    getContexts.mockReset().mockResolvedValue([{ contextType: 'POPUP' }]);
    chrome.runtime.getURL = vi.fn(path => `chrome-extension://test-extension/${path}`);
    chrome.runtime.sendMessage = sendMessage;
    sendMessage.mockReset().mockResolvedValue(undefined);
    vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
    chrome.windows = {
      getLastFocused: vi.fn().mockResolvedValue({ left: 0, top: 0, width: 1000, height: 800 }),
      create: vi.fn().mockResolvedValue({ id: 7 }),
      remove: vi.fn().mockResolvedValue(undefined),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    } as never;
  });

  afterEach(() => vi.useRealTimers());

  async function windowRequest() {
    const result = handleRequestPermission({ domain: 'example.com' });
    await vi.waitFor(() => expect(chrome.windows.onRemoved.addListener).toHaveBeenCalled());
    const url = vi.mocked(chrome.windows.create).mock.calls[0][0].url as string;
    const requestId = new URL(url).searchParams.get('requestId');
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0];
    return { result, requestId, listener, url };
  }

  it.each([true, false])(
    'uses the open popup decision (%s) without opening a window',
    async granted => {
      sendMessage.mockImplementation(async message =>
        message.type === POPUP_PERMISSION_REQUEST ? { granted } : undefined,
      );
      await expect(handleRequestPermission({ domain: 'example.com' })).resolves.toEqual(
        granted
          ? { granted: true, domain: 'example.com', origin: '*://*.example.com/*' }
          : { granted: false, domain: 'example.com' },
      );
      expect(chrome.windows.create).not.toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: POPUP_PERMISSION_CANCEL }),
      );
    },
  );

  it('opens a centered window when the popup is closed and accepts its decision', async () => {
    getContexts.mockResolvedValue([]);
    const { result, listener, requestId, url } = await windowRequest();
    expect(chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'popup',
        width: 380,
        height: 300,
        left: 310,
        top: 250,
      }),
    );
    listener(
      { type: 'permission_decision', requestId, granted: true, origin: '*://*.example.com/*' },
      { id: chrome.runtime.id, url },
      vi.fn(),
    );
    await expect(result).resolves.toMatchObject({ granted: true });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['closed', 'not-ready'])('falls back when popup is %s', async state => {
    sendMessage.mockImplementation(async message => {
      if (message.type === POPUP_PERMISSION_REQUEST && state === 'closed')
        throw new Error('Channel closed');
      return undefined;
    });
    const { result } = await windowRequest();
    vi.mocked(chrome.windows.onRemoved.addListener).mock.calls[0][0](7);
    await expect(result).resolves.toEqual({ granted: false, domain: 'example.com' });
  });

  async function pendingPopupRequest() {
    let close!: () => void;
    let decide!: (decision: { granted: boolean }) => void;
    sendMessage.mockImplementation(message => {
      if (message.type !== POPUP_PERMISSION_REQUEST) return Promise.resolve();
      return new Promise((resolve, reject) => {
        decide = resolve;
        close = () => reject(new Error('Channel closed'));
      });
    });
    const result = handleRequestPermission({ domain: 'example.com' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const requestId = sendMessage.mock.calls[0][0].requestId;
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
    const allow = (respond = vi.fn()) =>
      listener(
        { type: POPUP_PERMISSION_ALLOW, requestId },
        { id: chrome.runtime.id, url: chrome.runtime.getURL('src/pages/popup/index.html') },
        respond,
      );
    return { result, close, decide, allow, listener, requestId };
  }

  it.each([true, false])(
    'finishes browser approval (%s) after the toolbar popup closes without another prompt',
    async granted => {
      let finish!: (granted: boolean) => void;
      vi.mocked(grantAgentOriginPermission).mockReturnValue(
        new Promise(resolve => {
          finish = resolve;
        }),
      );
      const { result, close, allow, listener } = await pendingPopupRequest();
      expect(allow()).toBe(true);
      // Request starts synchronously in the click message's listener.
      expect(grantAgentOriginPermission).toHaveBeenCalledWith('*://*.example.com/*');
      allow();
      expect(grantAgentOriginPermission).toHaveBeenCalledTimes(1);
      close();
      await Promise.resolve();
      expect(chrome.windows.create).not.toHaveBeenCalled();
      finish(granted);
      await expect(result).resolves.toEqual(
        granted
          ? { granted: true, domain: 'example.com', origin: '*://*.example.com/*' }
          : { granted: false, domain: 'example.com' },
      );
      expect(chrome.windows.create).not.toHaveBeenCalled();
      expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(listener);
    },
  );

  it('allows retry after browser denial while the popup remains open', async () => {
    vi.mocked(grantAgentOriginPermission).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result, allow, decide } = await pendingPopupRequest();
    const respond = vi.fn();
    allow(respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ granted: false }));
    allow(respond);
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        granted: true,
        origin: '*://*.example.com/*',
      }),
    );
    decide({ granted: true });
    await expect(result).resolves.toMatchObject({ granted: true });
    expect(grantAgentOriginPermission).toHaveBeenCalledTimes(2);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('reports storage errors without repeating confirmation after popup closure', async () => {
    vi.mocked(grantAgentOriginPermission).mockRejectedValue(new Error('Storage unavailable'));
    const { result, allow, close } = await pendingPopupRequest();
    const respond = vi.fn();
    allow(respond);
    close();
    await expect(result).resolves.toMatchObject({ granted: false });
    expect(respond).toHaveBeenCalledWith({ granted: false, error: 'Storage unavailable' });
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('ignores approval messages from content scripts, other pages and other requests', async () => {
    const { result, listener, requestId, decide } = await pendingPopupRequest();
    const popupUrl = chrome.runtime.getURL('src/pages/popup/index.html');
    for (const sender of [
      { id: chrome.runtime.id, url: 'https://example.com' },
      { id: chrome.runtime.id, url: popupUrl, tab: { id: 42 } as chrome.tabs.Tab },
      { id: 'other-extension', url: popupUrl },
    ]) {
      expect(
        listener({ type: POPUP_PERMISSION_ALLOW, requestId }, sender, vi.fn()),
      ).toBeUndefined();
    }
    listener(
      { type: POPUP_PERMISSION_ALLOW, requestId: 'other' },
      { id: chrome.runtime.id, url: popupUrl },
      vi.fn(),
    );
    expect(grantAgentOriginPermission).not.toHaveBeenCalled();
    decide({ granted: false });
    await expect(result).resolves.toMatchObject({ granted: false });
  });

  it('denies and clears an expired popup request without opening another prompt', async () => {
    vi.useFakeTimers();
    sendMessage.mockImplementation(message =>
      message.type === POPUP_PERMISSION_REQUEST ? new Promise(() => {}) : Promise.resolve(),
    );
    const result = handleRequestPermission({ domain: 'example.com' });
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(result).resolves.toEqual({ granted: false, domain: 'example.com' });
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: POPUP_PERMISSION_CANCEL }),
    );
  });

  it('ignores window decisions from web pages and other requests', async () => {
    getContexts.mockResolvedValue([]);
    const { result, requestId, listener, url } = await windowRequest();
    const response = vi.fn();
    listener(
      { type: 'permission_decision', requestId, granted: true },
      { id: chrome.runtime.id, url: 'https://example.com' },
      response,
    );
    listener(
      { type: 'permission_decision', requestId: 'other', granted: true },
      { id: chrome.runtime.id, url },
      response,
    );
    expect(response).not.toHaveBeenCalled();
    vi.mocked(chrome.windows.onRemoved.addListener).mock.calls[0][0](7);
    await expect(result).resolves.toMatchObject({ granted: false });
  });

  it('closes an expired standalone window', async () => {
    vi.useFakeTimers();
    getContexts.mockResolvedValue([]);
    const result = handleRequestPermission({ domain: 'example.com' });
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(result).resolves.toMatchObject({ granted: false });
    expect(chrome.windows.remove).toHaveBeenCalledWith(7);
  });

  it('rejects malformed domains before opening UI', async () => {
    await expect(handleRequestPermission({ domain: '' })).rejects.toThrow('Invalid domain');
    expect(chrome.runtime.getContexts).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });
});
