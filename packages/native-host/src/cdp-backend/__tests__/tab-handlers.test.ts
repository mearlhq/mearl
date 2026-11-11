vi.mock('../../app-profile-catalog.js', async original => ({
  ...(await original<typeof import('../../app-profile-catalog.js')>()),
  resolveInstalledAppProfile: async (
    ...args: Parameters<
      typeof import('../../../../app-profiles/src/__tests__/fixtures.js').resolveAppProfile
    >
  ) =>
    (await import('../../../../app-profiles/src/__tests__/fixtures.js')).resolveAppProfile(...args),
}));
import { describe, expect, it, vi } from 'vitest';
import { decodeCaptureCursor } from '@mearl/browser-core';
import { cdpTabList, cdpTabOpen } from '../tab-handlers';
import { createBuffers } from '../buffers';

describe('native CDP tab handlers', () => {
  it.each([
    { status: 'ready', navigateError: undefined, browserError: undefined },
    {
      status: 'pending',
      navigateError: 'CDP command timeout: Page.navigate',
      browserError: undefined,
    },
    { status: 'failed', navigateError: undefined, browserError: 'net::ERR_CONNECTION_REFUSED' },
  ])(
    'returns the opened tab with navigation status $status',
    async ({ status, navigateError, browserError }) => {
      const browserClient = {
        sendCommand: vi.fn(async (method: string) => {
          if (method === 'Target.createTarget') return { targetId: 'target-new' };
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: {
                targetId: 'target-new',
                url: 'https://example.test/ready',
                title: 'Ready',
              },
            };
          }
          return {};
        }),
      };
      const pageClient = {
        on: vi.fn(() => () => {}),
        sendCommand: vi.fn(async (method: string) => {
          if (method === 'Page.navigate') {
            pageSession.buffers.capture.currentSequence += 1;
            if (navigateError) throw new Error(navigateError);
            return { errorText: browserError };
          }
          if (method === 'Runtime.evaluate') {
            return { result: { value: 'interactive' } };
          }
          return {};
        }),
      };
      const pageSession = {
        client: pageClient,
        tabId: 1000,
        buffers: createBuffers(1000),
        targetId: 'target-new',
        url: 'about:blank',
      };
      const session = {
        getBrowserClient: vi.fn().mockResolvedValue(browserClient),
        registerTarget: vi.fn().mockResolvedValue(1000),
        getPageSession: vi.fn().mockResolvedValue(pageSession),
      } as any;

      const result = await cdpTabOpen(session, { url: 'https://example.test/ready' });
      expect(result).toMatchObject({
        tabId: 1000,
        url: 'https://example.test/ready',
        title: 'Ready',
        opened: true,
        reused: false,
        navigation: {
          requestedUrl: 'https://example.test/ready',
          status,
          ...(browserError ? { error: browserError } : {}),
        },
      });
      expect(decodeCaptureCursor(result.capture.cursor).sequence).toBe(0);
      expect(pageClient.sendCommand).toHaveBeenCalledWith(
        'Page.navigate',
        {
          url: 'https://example.test/ready',
        },
        expect.any(Number),
      );
      expect(browserClient.sendCommand).toHaveBeenCalledWith(
        'Target.getTargetInfo',
        {
          targetId: 'target-new',
        },
        expect.any(Number),
      );
    },
  );

  it('tells callers to keep using the returned tabId for an about:blank target', async () => {
    const browserClient = {
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Target.createTarget') return { targetId: 'target-blank' };
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'target-blank',
              url: 'about:blank',
              title: '',
            },
          };
        }
        return {};
      }),
    };
    const pageSession = {
      client: {
        on: vi.fn(() => () => {}),
        sendCommand: vi.fn(async (method: string) =>
          method === 'Runtime.evaluate' ? { result: { value: 'complete' } } : {},
        ),
      },
      tabId: 1004,
      buffers: createBuffers(1004),
      targetId: 'target-blank',
      url: 'about:blank',
    };
    const session = {
      getBrowserClient: vi.fn().mockResolvedValue(browserClient),
      registerTarget: vi.fn().mockResolvedValue(1004),
      getPageSession: vi.fn().mockResolvedValue(pageSession),
    } as any;

    await expect(cdpTabOpen(session, { url: 'about:blank' })).resolves.toMatchObject({
      tabId: 1004,
      url: 'about:blank',
      note: expect.stringContaining('Pass this tabId'),
    });
  });

  it('applies appProfile before the first business navigation', async () => {
    const commandOrder: string[] = [];
    const browserClient = {
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Target.createTarget') return { targetId: 'target-profile' };
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: 'target-profile',
              url: 'https://example.test/app',
              title: 'App',
            },
          };
        }
        return {};
      }),
    };
    const pageClient = {
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        if (event === 'Page.loadEventFired') queueMicrotask(() => listener({}));
        return () => {};
      }),
      createChildSession: vi.fn(),
      sendCommand: vi.fn(async (method: string) => {
        commandOrder.push(method);
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          return { identifier: 'app-profile-script' };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 77 };
        if (method === 'Page.getFrameTree') {
          return {
            frameTree: {
              frame: { id: 'top', name: '', url: 'https://example.test/app' },
              childFrames: [
                {
                  frame: {
                    id: 'root',
                    name: '__mearl_root__',
                    url: 'https://example.test/app',
                  },
                },
              ],
            },
          };
        }
        if (method === 'Page.navigate') pageSession.buffers.capture.currentSequence += 1;
        if (method === 'Runtime.evaluate') return { result: { value: 'complete' } };
        return {};
      }),
    };
    const pageSession = {
      client: pageClient,
      tabId: 1003,
      buffers: createBuffers(1003),
      targetId: 'target-profile',
      url: 'about:blank',
    };
    const session = {
      getBrowserClient: vi.fn().mockResolvedValue(browserClient),
      registerTarget: vi.fn().mockResolvedValue(1003),
      getPageSession: vi.fn().mockResolvedValue(pageSession),
    } as any;

    await expect(
      cdpTabOpen(session, {
        url: 'https://example.test/app',
        appProfile: 'reader',
      }),
    ).resolves.toMatchObject({
      tabId: 1003,
      appProfile: {
        profile: 'reader',
        os: 'ios',
      },
    });
    expect(commandOrder.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(
      commandOrder.indexOf('Page.navigate'),
    );
    expect(pageClient.sendCommand).toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.objectContaining({ userAgent: expect.stringContaining('Sample/') }),
    );
  });

  it.each([
    'https://example.test/page',
    'chrome-extension://test/options.html',
    'chrome://settings/',
  ])('reuses and activates an explicitly requested target: %s', async url => {
    const browserClient = {
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              {
                targetId: 'target-1',
                type: 'page',
                url: `${url}?state=ready`,
                title: 'Existing',
              },
            ],
          };
        }
        if (method === 'Browser.getWindowForTarget') {
          return { windowId: 42, bounds: { windowState: 'minimized' } };
        }
        return {};
      }),
    };
    const session = {
      getBrowserClient: vi.fn().mockResolvedValue(browserClient),
      ensureTargetRegistered: vi.fn().mockResolvedValue(1001),
      getPageSession: vi.fn().mockResolvedValue({
        tabId: 1001,
        buffers: createBuffers(1001),
        client: {
          sendCommand: vi.fn(async (method: string) =>
            method === 'Runtime.evaluate'
              ? { result: { value: 'visible' } }
              : { identifier: 'controlled-favicon-script' },
          ),
        },
      }),
    } as any;

    await expect(
      cdpTabOpen(session, {
        url,
        active: true,
        reuse: 'require',
        match: { ignoreSearch: true },
      }),
    ).resolves.toMatchObject({
      tabId: 1001,
      opened: false,
      reused: true,
      activation: {
        requested: true,
        tabActive: true,
        windowRestored: true,
        windowState: 'normal',
        visibilityState: 'visible',
      },
    });
    expect(browserClient.sendCommand).toHaveBeenCalledWith('Browser.setWindowBounds', {
      windowId: 42,
      bounds: { windowState: 'normal' },
    });
    expect(browserClient.sendCommand).toHaveBeenCalledWith('Target.activateTarget', {
      targetId: 'target-1',
    });
  });

  it('returns numeric id and tabId fields when listing targets', async () => {
    const session = {
      getBrowserClient: vi.fn().mockResolvedValue({
        sendCommand: vi.fn().mockResolvedValue({
          targetInfos: [
            { targetId: 'target-1', type: 'page', url: 'https://example.test/', title: 'Page' },
          ],
        }),
      }),
      ensureTargetRegistered: vi.fn().mockResolvedValue(1002),
    } as any;

    await expect(cdpTabList(session, {})).resolves.toEqual({
      tabs: [
        {
          id: 1002,
          tabId: 1002,
          url: 'https://example.test/',
          title: 'Page',
          active: false,
        },
      ],
      count: 1,
    });
  });
});
