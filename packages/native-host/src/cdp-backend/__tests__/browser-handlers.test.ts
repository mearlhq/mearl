import { describe, expect, it, vi } from 'vitest';
import { resolveEmulationConfig } from '@mearl/browser-core';
import { cdpPageScreenshot } from '../browser-handlers';
import { applyCdpDeviceShell } from '../device-shell.js';

const hiddenStates = [
  { property: '--mearl-side-panel-toggle-display', value: '', priority: '' },
  { property: '--mearl-device-cutout-display', value: '', priority: '' },
];

function createSession(options: { captureError?: Error } = {}) {
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.captureScreenshot') {
      if (options.captureError) throw options.captureError;
      return { data: 'AQID' };
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression);
      if (expression.includes('const properties =')) {
        return { result: { value: hiddenStates } };
      }
      if (expression.includes('JSON.stringify({ url:')) {
        return {
          result: {
            value: JSON.stringify({
              url: 'https://example.test/',
              title: 'Example',
              w: 393,
              h: 852,
              dpr: 3,
            }),
          },
        };
      }
      if (expression.includes('const states =')) return {};
    }
    throw new Error(`Unexpected CDP command: ${method}`);
  });
  return {
    sendCommand,
    session: { client: { sendCommand } } as any,
  };
}

describe('CDP browser handlers', () => {
  it('hides screenshot-only UI and restores it after viewport capture', async () => {
    const { sendCommand, session } = createSession();

    await expect(cdpPageScreenshot(session, { tabId: 1000, format: 'png' })).resolves.toEqual({
      meta: {
        format: 'png',
        width: 1179,
        height: 2556,
        size: 3,
        url: 'https://example.test/',
        title: 'Example',
      },
      data: 'AQID',
    });

    const calls = sendCommand.mock.calls;
    expect(calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Runtime.evaluate',
    ]);
    expect(String(calls[0][1]?.expression)).toContain(
      "root.style.setProperty(property, 'none', 'important')",
    );
    expect(String(calls[0][1]?.expression)).toContain('--mearl-device-cutout-display');
    expect(String(calls.at(-1)?.[1]?.expression)).toContain('root.style.removeProperty(property)');
  });

  it('restores screenshot-only UI when capture fails', async () => {
    const { sendCommand, session } = createSession({ captureError: new Error('capture failed') });

    await expect(cdpPageScreenshot(session, { tabId: 1000 })).rejects.toThrow('capture failed');

    expect(String(sendCommand.mock.calls.at(-1)?.[1]?.expression)).toContain(
      'root.style.removeProperty(property)',
    );
  });

  it('captures selector screenshots in the device-shell business page', async () => {
    const listeners = new Map<string, (params: any) => void>();
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
                  url: 'https://example.test/business',
                },
              },
            ],
          },
        };
      }
      if (method === 'Page.captureScreenshot') return { data: 'AQID' };
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression);
        if (expression.includes('const properties =')) return { result: { value: hiddenStates } };
        if (expression.includes('const states =')) return {};
        if (expression.includes('JSON.stringify({ url:')) {
          return {
            result: {
              value: JSON.stringify({
                url: 'https://example.test/business',
                title: 'Business',
                w: 393,
                h: 790,
                dpr: 3,
              }),
            },
          };
        }
        if (expression.includes('document.querySelector')) {
          return {
            result: { value: { x: 10, y: 20, width: 120, height: 80, devicePixelRatio: 3 } },
          };
        }
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
    const session = { client } as any;
    await applyCdpDeviceShell(
      session,
      resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' }),
    );
    listeners.get('Runtime.executionContextCreated')?.({
      context: { id: 77, auxData: { frameId: 'root-webview', isDefault: true } },
    });

    await expect(
      cdpPageScreenshot(session, { tabId: 1000, selector: '.card', format: 'png' }),
    ).resolves.toMatchObject({
      meta: { url: 'https://example.test/business', title: 'Business' },
    });
    expect(sendCommand).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      expect.objectContaining({
        clip: { x: 10, y: 82, width: 120, height: 80, scale: 3 },
        captureBeyondViewport: true,
      }),
    );
    const businessEvaluations = sendCommand.mock.calls.filter(
      ([method, params]) => method === 'Runtime.evaluate' && params?.contextId === 77,
    );
    expect(businessEvaluations).toHaveLength(2);
  });
});
