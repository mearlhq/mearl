import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEmulationConfig } from '@mearl/browser-core';
import { applyCdpDeviceShell } from '../device-shell.js';
import { startCdpNavigationObserver } from '../navigation-observer.js';

function createSession() {
  const listeners = new Map<string, (params: any) => void>();
  const client = {
    sendCommand: vi.fn(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Runtime.evaluate') {
        return {
          result: { value: { title: 'Results', url: 'https://example.test/results' } },
        };
      }
      return {};
    }),
    on: vi.fn((method: string, callback: (params: any) => void) => {
      listeners.set(method, callback);
      return () => listeners.delete(method);
    }),
  };
  return {
    listeners,
    client,
    cdpSession: { getBrowserClient: vi.fn() } as any,
    session: { client, targetId: 'target', url: '', buffers: {} } as any,
  };
}

describe('CDP navigation adapter', () => {
  afterEach(() => vi.useRealTimers());

  it('maps main-frame events and refreshes final page metadata', async () => {
    const { cdpSession, session, client, listeners } = createSession();
    const observer = await startCdpNavigationObserver(
      cdpSession,
      session,
      'https://example.test/start',
    );
    listeners.get('Page.frameNavigated')?.({
      frame: { id: 'main', url: 'https://example.test/results' },
    });
    listeners.get('Page.loadEventFired')?.({});

    await expect(observer.waitForResult(100)).resolves.toEqual(
      expect.objectContaining({
        urlAfter: 'https://example.test/results',
        title: 'Results',
        settledBy: 'load',
      }),
    );
    expect(client.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: '({ title: document.title, url: location.href })' }),
    );
    await observer.dispose();
    expect(listeners.size).toBe(0);
  });

  it('maps relevant request events into network-idle settlement', async () => {
    vi.useFakeTimers();
    const { cdpSession, session, listeners } = createSession();
    const observer = await startCdpNavigationObserver(
      cdpSession,
      session,
      'https://example.test/start',
      {
        trackNetwork: true,
        networkIdleMs: 100,
      },
    );
    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'search',
      type: 'Fetch',
      request: { url: 'https://example.test/api/search' },
    });
    listeners.get('Page.frameNavigated')?.({
      frame: { id: 'main', url: 'https://example.test/results' },
    });
    listeners.get('Page.loadEventFired')?.({});
    const result = observer.waitForResult(1000);
    listeners.get('Network.loadingFinished')?.({ requestId: 'search' });
    await vi.advanceTimersByTimeAsync(101);

    await expect(result).resolves.toEqual(
      expect.objectContaining({ settledBy: 'network-idle', pendingRequests: 0 }),
    );
    await observer.dispose();
  });

  it('reports newly opened page targets owned by the source page', async () => {
    const { session } = createSession();
    const browserClient = {
      sendCommand: vi
        .fn()
        .mockResolvedValueOnce({
          targetInfos: [{ targetId: 'target', type: 'page', url: 'https://example.test/start' }],
        })
        .mockResolvedValueOnce({
          targetInfos: [
            { targetId: 'target', type: 'page', url: 'https://example.test/start' },
            {
              targetId: 'child',
              type: 'page',
              openerId: 'target',
              url: 'https://example.test/results',
              title: 'Results',
            },
            {
              targetId: 'unrelated',
              type: 'page',
              openerId: 'other',
              url: 'https://example.test/unrelated',
            },
          ],
        })
        .mockResolvedValueOnce({
          targetInfo: {
            targetId: 'child',
            type: 'page',
            openerId: 'target',
            url: 'https://example.test/results',
            title: 'Results',
          },
        }),
    };
    const openedClient = {
      on: vi.fn(() => vi.fn()),
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') return { result: { value: 'complete' } };
        return {};
      }),
    };
    const cdpSession = {
      getBrowserClient: vi.fn(async () => browserClient),
      ensureTargetRegistered: vi.fn(async () => 1001),
      getPageSession: vi.fn(async () => ({
        client: openedClient,
        targetId: 'child',
        url: 'https://example.test/results',
        buffers: {},
      })),
    } as any;
    const observer = await startCdpNavigationObserver(
      cdpSession,
      session,
      'https://example.test/start',
      {
        trackOpenedTabs: true,
        sourceTabId: 1000,
      },
    );

    await expect(observer.getOpenedTabs(100)).resolves.toEqual([
      {
        tabId: 1001,
        openerTabId: 1000,
        url: 'https://example.test/results',
        title: 'Results',
        ready: true,
        settledBy: 'load',
      },
    ]);
    expect(cdpSession.ensureTargetRegistered).toHaveBeenCalledWith('child');
    await observer.dispose();
  });

  it('observes navigation and final metadata from the device-shell business frame', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const client = {
      closed: false,
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          return { identifier: 'shell-script' };
        }
        if (method === 'Page.getFrameTree') {
          return {
            frameTree: {
              frame: { id: 'main', url: 'https://example.test/' },
              childFrames: [
                {
                  frame: {
                    id: 'root-webview',
                    name: '__mearl_root__',
                    url: 'https://example.test/start',
                  },
                },
              ],
            },
          };
        }
        if (method === 'Runtime.evaluate') {
          return {
            result: { value: { title: 'Business', url: 'https://example.test/results' } },
          };
        }
        return {};
      }),
      on: vi.fn((method: string, callback: (params: any) => void) => {
        listeners.set(method, callback);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    };
    const pageSession = {
      client,
      targetId: 'target',
      url: '',
      buffers: {},
    } as any;
    await applyCdpDeviceShell(
      pageSession,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    listeners.get('Runtime.executionContextCreated')?.({
      context: { id: 77, auxData: { frameId: 'root-webview', isDefault: true } },
    });

    const observer = await startCdpNavigationObserver(
      { getBrowserClient: vi.fn() } as any,
      pageSession,
      'https://example.test/start',
    );
    listeners.get('Page.frameNavigated')?.({
      frame: { id: 'main', url: 'https://example.test/outer' },
    });
    expect(observer.hasStarted()).toBe(false);
    listeners.get('Page.frameNavigated')?.({
      frame: {
        id: 'root-webview',
        parentId: 'main',
        url: 'https://example.test/results',
      },
    });
    listeners.get('Page.loadEventFired')?.({});
    listeners.get('Page.frameStoppedLoading')?.({ frameId: 'root-webview' });

    await expect(observer.waitForResult(100)).resolves.toMatchObject({
      urlAfter: 'https://example.test/results',
      title: 'Business',
    });
    const pageStateEvaluation = client.sendCommand.mock.calls.find(
      ([method, params]) =>
        method === 'Runtime.evaluate' &&
        params?.expression === '({ title: document.title, url: location.href })',
    );
    expect(pageStateEvaluation?.[1]).toMatchObject({ contextId: 77 });
    await observer.dispose();
  });
});
