import { describe, expect, it, vi } from 'vitest';
import { resolveEmulationConfig } from '@mearl/browser-core';
import type { PageSession } from '../cdp-session.js';
import { cdpSetMock, clearCdpPageMocks } from '../mock-handlers.js';
import { clearCdpFetchInterceptionState } from '../fetch-interceptor.js';
import {
  applyCdpDeviceShell,
  clearCdpDeviceShell,
  getCdpDeviceShellInputOffset,
  sendCdpDeviceShellPageCommand,
} from '../device-shell.js';
import {
  disposePageObservation,
  finishPageObservation,
  startPageObservation,
} from '../page-observer.js';

describe('CDP device shell routing', () => {
  it('composes HTML response mocks with one-shot root document delivery', async () => {
    const listeners = new Map<string, (params: any) => Promise<void> | void>();
    const sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shell-script' };
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', url: 'https://example.test/mock-document' } } };
      return {};
    });
    const session = {
      client: {
        closed: false,
        sendCommand,
        on: (method: string, listener: (params: any) => Promise<void> | void) => {
          listeners.set(method, listener);
          return () => listeners.delete(method);
        },
      },
    } as unknown as PageSession;
    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    const html = '<html>mocked document</html>';
    await cdpSetMock(session, { apiName: 'mock-document', mockData: html });
    const params = {
      requestId: 'document',
      frameId: 'main',
      resourceType: 'Document',
      request: { url: 'https://example.test/mock-document', method: 'GET' },
    };
    try {
      await listeners.get('Fetch.requestPaused')?.({
        ...params,
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      });
      const delivery = sendCommand.mock.calls.find(
        ([method]) => method === 'Fetch.fulfillRequest',
      )![1] as { responseHeaders: Array<{ name: string; value: string }> };
      const token = delivery.responseHeaders
        .find(header => header.value.startsWith('mearl-document;'))!
        .value.match(/desc="([^"]+)"/)![1];
      listeners.get('Page.frameAttached')?.({ frameId: 'root', parentFrameId: 'main' });
      await listeners.get('Fetch.requestPaused')?.({
        ...params,
        requestId: 'replay',
        frameId: 'root',
        request: { ...params.request, url: 'https://example.test/.mearl-document/' + token },
      });
      expect(sendCommand).toHaveBeenLastCalledWith(
        'Fetch.fulfillRequest',
        expect.objectContaining({ body: Buffer.from(html).toString('base64') }),
      );
      expect(sendCommand).not.toHaveBeenCalledWith('Fetch.getResponseBody', expect.anything());
    } finally {
      await clearCdpDeviceShell(session);
      clearCdpPageMocks(session);
      clearCdpFetchInterceptionState([session]);
    }
  });

  it('delivers top HTML responses and releases its Fetch handler when simulation is cleared', async () => {
    const listeners = new Map<string, (params: any) => Promise<void> | void>();
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shell-script' };
      if (method === 'Fetch.getResponseBody')
        return { body: '<html>fixture</html>', base64Encoded: false };
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', url: 'about:blank' } } };
      return {};
    });
    const client = {
      closed: false,
      sendCommand,
      on: vi.fn((method: string, listener: (params: any) => Promise<void> | void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    };
    const session = { client } as unknown as PageSession;
    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    expect(sendCommand).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
      ],
    });
    sendCommand.mockClear();
    await listeners.get('Fetch.requestPaused')?.({
      requestId: 'shell-request',
      frameId: 'main',
      resourceType: 'Document',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      request: { url: 'https://example.test/callback?ticket=once', method: 'GET' },
    });
    expect(sendCommand).toHaveBeenCalledWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({ responseCode: 200 }),
    );
    await clearCdpDeviceShell(session);
    expect(sendCommand).toHaveBeenCalledWith('Fetch.disable', {});
    expect(listeners.has('Fetch.requestPaused')).toBe(false);
  });

  it.each(['iphone-duo-folded', 'iphone-duo-unfolded'] as const)(
    'reserves the Duo side rail for %s in its standalone document shell',
    async preset => {
      let shellSource = '';
      const client = {
        closed: false,
        sendCommand: vi.fn(async (method: string, params?: Record<string, any>) => {
          if (method === 'Page.addScriptToEvaluateOnNewDocument') {
            shellSource = String(params?.source);
            return { identifier: 'duo-shell-script' };
          }
          return {};
        }),
        on: vi.fn(() => () => {}),
        createChildSession: vi.fn(),
      };
      const session = { client } as unknown as PageSession;

      await applyCdpDeviceShell(session, resolveEmulationConfig({ enabled: true, preset }));

      expect(shellSource).toContain('"sideBarWidth":84');
      expect(shellSource).toContain('"statusBarHeight":0');
      expect(shellSource).toContain('width: calc(100% - ${config.sideBarWidth ?? 0}px)');
    },
  );

  it('serializes the shared chrome view and captures from its Dynamic Island bridge', async () => {
    const listeners = new Map<string, (params: any) => void>();
    let shellSource = '';
    const sendCommand = vi.fn(async (method: string, params?: Record<string, any>) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        shellSource = String(params?.source);
        return { identifier: 'shell-script' };
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression);
        if (expression.includes("const property = '--mearl-device-cutout-display'")) {
          return { result: { value: { value: '', priority: '' } } };
        }
        return {};
      }
      if (method === 'Page.captureScreenshot') return { data: 'AQID' };
      return {};
    });
    const client = {
      closed: false,
      sendCommand,
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    };
    const session = { client } as unknown as PageSession;

    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );

    expect(shellSource).toContain('installDeviceChromeView');
    expect(shellSource).toContain('MutationObserver');
    expect(shellSource).toContain('if (!document.documentElement) return');
    expect(shellSource).toContain('requestTitleBarState');
    expect(shellSource).toContain('titleBarState');
    expect(shellSource).toContain('statusBarBackground: state.statusBarBackground');
    expect(shellSource).toContain('id="signal"');
    expect(shellSource).toContain('id="wifi"');
    expect(shellSource).toContain('id="battery"');
    expect(sendCommand).toHaveBeenCalledWith('Runtime.addBinding', {
      name: '__mearlCdpDeviceShellRelay',
    });

    listeners.get('Runtime.bindingCalled')?.({
      name: '__mearlCdpDeviceShellRelay',
      executionContextId: 9,
      payload: JSON.stringify({ type: 'screenshot', requestId: 12 }),
    });

    await vi.waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
        format: 'png',
      }),
    );
    await vi.waitFor(() =>
      expect(
        sendCommand.mock.calls.some(
          ([method, params]) =>
            method === 'Runtime.evaluate' &&
            params?.contextId === 9 &&
            String(params.expression).includes('__mearlCdpDeviceShellResponse') &&
            String(params.expression).includes('AQID'),
        ),
      ).toBe(true),
    );
  });

  it('routes Runtime and Accessibility commands into the root WebView', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shell-script' };
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', name: '', url: 'https://example.test/' },
            childFrames: [
              {
                frame: {
                  id: 'root-webview',
                  name: '__mearl_root__',
                  url: 'https://example.test/',
                },
              },
            ],
          },
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'business' } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      return {};
    });
    const client = {
      closed: false,
      sendCommand,
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    };
    const session = { client } as unknown as PageSession;

    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    listeners.get('Runtime.executionContextCreated')?.({
      context: {
        id: 77,
        auxData: { frameId: 'root-webview', isDefault: true },
      },
    });

    await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    await sendCdpDeviceShellPageCommand(session, 'Accessibility.getFullAXTree', { depth: 5 });

    expect(sendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
      contextId: 77,
    });
    expect(sendCommand).toHaveBeenCalledWith('Accessibility.getFullAXTree', {
      depth: 5,
      frameId: 'root-webview',
    });
    await expect(getCdpDeviceShellInputOffset(session)).resolves.toEqual({ x: 0, y: 62 });

    await clearCdpDeviceShell(session);
    expect(sendCommand).toHaveBeenCalledWith('Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  });

  it('offsets direct input into the active right WebView in App-managed split screen', async () => {
    const sendCommand = vi.fn(async (method: string, params?: Record<string, any>) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return { identifier: 'split-shell-script' };
      }
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', url: 'https://example.test/' },
            childFrames: [
              {
                frame: {
                  id: 'root-webview',
                  name: '__mearl_root__',
                  url: 'https://example.test/home',
                },
              },
              {
                frame: {
                  id: 'right-webview',
                  name: '__mearl_layer__',
                  url: 'https://example.test/detail',
                },
              },
            ],
          },
        };
      }
      if (method === 'DOM.getFrameOwner') {
        return { backendNodeId: params?.frameId === 'right-webview' ? 2 : 1 };
      }
      if (method === 'DOM.describeNode') {
        return {
          node: {
            attributes:
              params?.backendNodeId === 2
                ? ['name', '__mearl_layer__']
                : ['inert', '', 'aria-hidden', 'true'],
          },
        };
      }
      return {};
    });
    const session = {
      client: {
        closed: false,
        sendCommand,
        on: vi.fn(() => () => {}),
        createChildSession: vi.fn(),
      },
    } as unknown as PageSession;
    const emulation = resolveEmulationConfig({
      enabled: true,
      preset: 'ipad-mini-a17-pro',
      orientation: 'landscape',
    });

    await applyCdpDeviceShell(session, emulation, { rootContainerManagedByApp: true });

    await expect(getCdpDeviceShellInputOffset(session)).resolves.toEqual({
      x: emulation.width / 2,
      y: 24,
    });
  });

  it('waits for the closing animation before routing scrolling to the interactive layer', async () => {
    const listeners = new Map<string, (params: any) => void>();
    let activeLayerInspections = 0;
    const sendCommand = vi.fn(async (method: string, params?: Record<string, any>) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shell-script' };
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', url: 'https://example.test/' },
            childFrames: [
              {
                frame: {
                  id: 'root-webview',
                  name: '__mearl_root__',
                  url: 'https://example.test/home',
                },
              },
              {
                frame: {
                  id: 'active-layer',
                  name: '__mearl_layer__',
                  url: 'https://example.test/list',
                },
              },
              {
                frame: {
                  id: 'closing-layer',
                  name: '__mearl_layer__',
                  url: 'https://example.test/detail',
                },
              },
            ],
          },
        };
      }
      if (method === 'DOM.getFrameOwner') {
        return {
          backendNodeId:
            params?.frameId === 'active-layer' ? 2 : params?.frameId === 'closing-layer' ? 3 : 1,
        };
      }
      if (method === 'DOM.describeNode') {
        if (params?.backendNodeId === 2) activeLayerInspections += 1;
        return {
          node: {
            attributes:
              params?.backendNodeId === 2 && activeLayerInspections > 1
                ? ['name', '__mearl_layer__']
                : ['inert', '', 'aria-hidden', 'true'],
          },
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { moved: true } } };
      return {};
    });
    const client = {
      closed: false,
      sendCommand,
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    };
    const session = { client } as unknown as PageSession;

    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    for (const [frameId, contextId] of [
      ['root-webview', 77],
      ['active-layer', 78],
      ['closing-layer', 79],
    ] as const) {
      listeners.get('Runtime.executionContextCreated')?.({
        context: { id: contextId, auxData: { frameId, isDefault: true } },
      });
    }

    await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: 'scrollBy(0, 500)',
      returnByValue: true,
    });

    expect(sendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'scrollBy(0, 500)',
      returnByValue: true,
      contextId: 78,
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 79 }),
    );
    expect(activeLayerInspections).toBe(2);
  });

  it('runs page observation inside the active App layer context', async () => {
    const listeners = new Map<string, (params: any) => void>();
    let observationEvaluation = 0;
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shell-script' };
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', url: 'https://example.test/' },
            childFrames: [
              {
                frame: {
                  id: 'root-webview',
                  name: '__mearl_root__',
                  url: 'https://example.test/business',
                },
                childFrames: [
                  {
                    frame: {
                      id: 'top-layer',
                      parentId: 'root-webview',
                      name: '__mearl_layer__',
                      url: 'https://example.test/detail',
                    },
                  },
                ],
              },
            ],
          },
        };
      }
      if (method === 'Runtime.evaluate') {
        observationEvaluation += 1;
        if (observationEvaluation === 1) return { result: { value: { version: 1 } } };
        if (observationEvaluation === 2) return { result: { value: { mode: 'delta' } } };
        return {};
      }
      return {};
    });
    const client = {
      closed: false,
      sendCommand,
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    };
    const session = { client } as unknown as PageSession;
    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    listeners.get('Runtime.executionContextCreated')?.({
      context: { id: 77, auxData: { frameId: 'root-webview', isDefault: true } },
    });
    listeners.get('Runtime.executionContextCreated')?.({
      context: { id: 78, auxData: { frameId: 'top-layer', isDefault: true } },
    });

    const checkpoint = await startPageObservation(session);
    await expect(finishPageObservation(session, checkpoint)).resolves.toMatchObject({
      mode: 'delta',
    });
    await disposePageObservation(session);

    const observationCalls = sendCommand.mock.calls.filter(
      ([method]) => method === 'Runtime.evaluate',
    );
    expect(observationCalls).toHaveLength(3);
    expect(observationCalls.every(([, params]) => params?.contextId === 78)).toBe(true);
  });

  it('reports navigation when an App layer becomes the active WebView', async () => {
    const listeners = new Map<string, (params: any) => void>();
    let layerVisible = false;
    const sendCommand = vi.fn(async (method: string, params?: Record<string, any>) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shell-script' };
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', url: 'https://example.test/' },
            childFrames: [
              {
                frame: {
                  id: 'root-webview',
                  name: '__mearl_root__',
                  url: 'https://example.test/home',
                },
                ...(layerVisible
                  ? {
                      childFrames: [
                        {
                          frame: {
                            id: 'top-layer',
                            parentId: 'root-webview',
                            name: '__mearl_layer__',
                            url: 'https://example.test/detail',
                          },
                        },
                      ],
                    }
                  : {}),
              },
            ],
          },
        };
      }
      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'document.title') return { result: { value: 'Detail' } };
        return {
          result: {
            value: {
              version: 1,
              url: 'https://example.test/home',
              title: 'Home',
            },
          },
        };
      }
      return {};
    });
    const client = {
      closed: false,
      sendCommand,
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    };
    const session = { client } as unknown as PageSession;
    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    listeners.get('Runtime.executionContextCreated')?.({
      context: { id: 77, auxData: { frameId: 'root-webview', isDefault: true } },
    });
    listeners.get('Runtime.executionContextCreated')?.({
      context: { id: 78, auxData: { frameId: 'top-layer', isDefault: true } },
    });

    const checkpoint = await startPageObservation(session);
    layerVisible = true;

    await expect(finishPageObservation(session, checkpoint)).resolves.toMatchObject({
      mode: 'navigation',
      urlBefore: 'https://example.test/home',
      urlAfter: 'https://example.test/detail',
      title: 'Detail',
      snapshotReasons: ['navigation'],
    });
    expect(sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'document.title', contextId: 78 }),
    );
  });

  it('updates an attached OOPIF environment without reloading when shell geometry is unchanged', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const childSendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'window.name') {
        return { result: { value: '__mearl_root__' } };
      }
      return {};
    });
    const child = {
      closed: false,
      sessionId: 'root-session',
      sendCommand: childSendCommand,
      on: vi.fn(() => () => {}),
    };
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shell-script' };
      return {};
    });
    const client = {
      closed: false,
      sendCommand,
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(() => child),
    };
    const session = { client } as unknown as PageSession;
    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    listeners.get('Target.attachedToTarget')?.({
      sessionId: 'root-session',
      targetInfo: { type: 'iframe' },
    });
    await vi.waitFor(() =>
      expect(childSendCommand).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger'),
    );
    childSendCommand.mockClear();

    await expect(
      applyCdpDeviceShell(
        session,
        resolveEmulationConfig({
          enabled: true,
          preset: 'iphone-17-pro',
          deviceScaleFactor: 2,
        }),
      ),
    ).resolves.toBe(false);

    expect(childSendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ deviceScaleFactor: 2 }),
    );
    expect(
      sendCommand.mock.calls.filter(
        ([method]) => method === 'Page.addScriptToEvaluateOnNewDocument',
      ),
    ).toHaveLength(1);
  });
});
