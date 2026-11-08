import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const debuggerMocks = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  acquireDebuggerLease: vi.fn(),
  resolveDebuggerFrameExecutionContextId: vi.fn(),
}));
const containerMocks = vi.hoisted(() => ({
  getContainerTopFrame: vi.fn(),
  getFrameViewportTransform: vi.fn(),
}));

vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease: debuggerMocks.acquireDebuggerLease,
  resolveDebuggerFrameExecutionContextId: debuggerMocks.resolveDebuggerFrameExecutionContextId,
}));
vi.mock('../../utils/containerFrameTarget', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/containerFrameTarget')>(),
  getContainerTopFrame: containerMocks.getContainerTopFrame,
  getFrameViewportTransform: containerMocks.getFrameViewportTransform,
}));

import { captureNodeScreenshotViaCDP, captureScreenshotViaCDP } from '../screenshotUtils';

const defaultDebuggerCommand = async (
  _target: chrome.debugger.Debuggee,
  method: string,
  params: Record<string, unknown>,
) => {
  if (method === 'Runtime.evaluate') {
    const expression = String(params.expression);
    if (expression.includes('const properties =')) {
      return {
        result: {
          value: [
            { property: '--mearl-side-panel-toggle-display', value: '', priority: '' },
            { property: '--mearl-device-cutout-display', value: '', priority: '' },
          ],
        },
      };
    }
    if (expression.trim().startsWith('new Promise')) return {};
    if (expression.includes('window.innerWidth')) {
      return {
        result: {
          value: { width: 393, height: 852, dpr: 3 },
        },
      };
    }
    if (expression.includes('const el = document.querySelector')) {
      return { result: { value: { x: 10, y: 20, width: 120, height: 80 } } };
    }
    if (expression.includes('root.style.removeProperty(property)')) return {};
  }
  if (method === 'Page.captureScreenshot') return { data: 'AQID' };
  throw new Error(`Unexpected CDP method: ${method}`);
};

describe('captureScreenshotViaCDP', () => {
  beforeEach(() => {
    debuggerMocks.release.mockClear();
    debuggerMocks.acquireDebuggerLease.mockClear();
    debuggerMocks.acquireDebuggerLease.mockResolvedValue({
      release: debuggerMocks.release,
    });
    debuggerMocks.resolveDebuggerFrameExecutionContextId.mockResolvedValue(77);
    containerMocks.getContainerTopFrame.mockReset().mockResolvedValue(undefined);
    containerMocks.getFrameViewportTransform.mockReset().mockResolvedValue({
      frameId: 'root-webview',
      url: 'https://example.test/',
      offset: { x: 0, y: 62 },
      scale: { x: 1, y: 1 },
      viewport: { width: 393, height: 790 },
    });
    (chrome.debugger.sendCommand as unknown as Mock)
      .mockReset()
      .mockImplementation(defaultDebuggerCommand);
  });

  it('hides screenshot-only UI while deriving viewport dimensions and capturing', async () => {
    await expect(captureScreenshotViaCDP(7, 'png', 80)).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AQID',
      width: 1179,
      height: 2556,
    });

    const calls = (chrome.debugger.sendCommand as unknown as Mock).mock.calls;
    expect(calls.map(([, method]) => method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Runtime.evaluate',
    ]);
    expect(String(calls[0][2].expression)).toContain(
      "root.style.setProperty(property, hiddenValue, 'important')",
    );
    expect(String(calls[0][2].expression)).toContain('--mearl-side-panel-toggle-display');
    expect(String(calls[0][2].expression)).toContain('--mearl-device-cutout-display');
    expect(String(calls[0][2].expression)).toContain('const root = document.documentElement');
    expect(String(calls[0][2].expression)).not.toContain('document.querySelector');
    expect(String(calls[4][2].expression)).toContain('root.style.removeProperty(property)');
    expect(String(calls[4][2].expression)).toContain('--mearl-device-cutout-display');
    expect(debuggerMocks.release).toHaveBeenCalledOnce();
  });

  it('preserves the full viewport in system-bar mode and crops visible captures to the WebView', async () => {
    containerMocks.getContainerTopFrame.mockImplementation(async (_tabId, scope) =>
      scope === 'container' ? { frameId: 'root-webview', url: 'https://example.test/' } : undefined);
    await expect(captureScreenshotViaCDP(7, 'png', 80)).resolves.toMatchObject({
      width: 1179,
      height: 2556,
    });
    expect(containerMocks.getFrameViewportTransform).not.toHaveBeenCalled();
    const calls = (chrome.debugger.sendCommand as unknown as Mock).mock.calls;
    expect(String(calls[0][2].expression)).not.toContain('--mearl-device-chrome-display');
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Page.captureScreenshot', {
      format: 'png',
    });
    await expect(captureScreenshotViaCDP(7, 'png', 80, true)).resolves.toMatchObject({
      width: 1179,
      height: 2370,
    });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: 0, y: 62, width: 393, height: 790, scale: 1 },
      },
    );
  });

  it('restores screenshot-only UI when viewport capture fails', async () => {
    (chrome.debugger.sendCommand as unknown as Mock).mockImplementation(
      async (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => {
        if (method === 'Page.captureScreenshot') throw new Error('capture failed');
        return defaultDebuggerCommand(target, method, params);
      },
    );

    await expect(captureScreenshotViaCDP(7, 'png', 80)).rejects.toThrow('capture failed');

    const calls = (chrome.debugger.sendCommand as unknown as Mock).mock.calls;
    expect(String(calls.at(-1)?.[2].expression)).toContain('root.style.removeProperty(property)');
    expect(debuggerMocks.release).toHaveBeenCalledOnce();
  });

  it('rounds a scaled preview crop inward to exclude the shell edges', async () => {
    containerMocks.getContainerTopFrame.mockResolvedValue({
      frameId: 'root-webview',
      phoneFrame: true,
      url: 'https://example.test/business',
    });
    containerMocks.getFrameViewportTransform.mockResolvedValue({
      offset: { x: 100.25, y: 40.75 },
      scale: { x: 0.5, y: 0.5 },
      viewport: { width: 402, height: 812 },
    });
    await expect(captureScreenshotViaCDP(7, 'png', 80)).resolves.toMatchObject({
      width: 600,
      height: 1215,
      pageUrl: 'https://example.test/business',
    });
    const calls = (chrome.debugger.sendCommand as unknown as Mock).mock.calls;
    expect(String(calls[0][2].expression)).toContain('--mearl-device-chrome-display');
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 101, y: 41, width: 200, height: 405, scale: 1 },
    });
  });

  it('restores the existing root-scoped display value and priority', async () => {
    (chrome.debugger.sendCommand as unknown as Mock).mockImplementation(
      async (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => {
        const expression = String(params.expression);
        if (method === 'Runtime.evaluate' && expression.includes('const properties =')) {
          return {
            result: {
              value: [
                {
                  property: '--mearl-side-panel-toggle-display',
                  value: 'inline-flex',
                  priority: 'important',
                },
                { property: '--mearl-device-cutout-display', value: '', priority: '' },
              ],
            },
          };
        }
        if (
          method === 'Runtime.evaluate' &&
          expression.includes('root.style.setProperty(property, value, priority)')
        ) {
          return {};
        }
        return defaultDebuggerCommand(target, method, params);
      },
    );

    await expect(captureScreenshotViaCDP(7, 'png', 80)).resolves.toBeDefined();

    const restoreExpression = String(
      (chrome.debugger.sendCommand as unknown as Mock).mock.calls.at(-1)?.[2].expression,
    );
    expect(restoreExpression).toContain('"value":"inline-flex"');
    expect(restoreExpression).toContain('"priority":"important"');
    expect(restoreExpression).toContain('root.style.setProperty(property, value, priority)');
  });

  it('keeps the capture result when restoring the side panel entry fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (chrome.debugger.sendCommand as unknown as Mock).mockImplementation(
      async (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => {
        if (
          method === 'Runtime.evaluate' &&
          String(params.expression).includes('root.style.removeProperty(property)')
        ) {
          throw new Error('restore failed');
        }
        return defaultDebuggerCommand(target, method, params);
      },
    );

    await expect(captureScreenshotViaCDP(7, 'png', 80)).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AQID',
      width: 1179,
      height: 2556,
    });
    expect(warn).toHaveBeenCalledWith(
      '[screenshot] Failed to restore hidden screenshot UI:',
      expect.objectContaining({ message: 'restore failed' }),
    );
    expect(debuggerMocks.release).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('preserves the capture error when restoring the side panel entry also fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (chrome.debugger.sendCommand as unknown as Mock).mockImplementation(
      async (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => {
        if (method === 'Page.captureScreenshot') throw new Error('capture failed');
        if (
          method === 'Runtime.evaluate' &&
          String(params.expression).includes('root.style.removeProperty(property)')
        ) {
          throw new Error('restore failed');
        }
        return defaultDebuggerCommand(target, method, params);
      },
    );

    await expect(captureScreenshotViaCDP(7, 'png', 80)).rejects.toThrow('capture failed');
    expect(warn).toHaveBeenCalledOnce();
    expect(debuggerMocks.release).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('hides screenshot-only UI around node screenshots without another frame wait', async () => {
    await expect(captureNodeScreenshotViaCDP(7, '.card', 'png', 80)).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AQID',
      width: 120,
      height: 80,
    });

    const calls = (chrome.debugger.sendCommand as unknown as Mock).mock.calls;
    expect(calls.map(([, method]) => method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Runtime.evaluate',
    ]);
    expect(calls.some(([, , params]) => String(params.expression).startsWith('new Promise'))).toBe(
      false,
    );
    expect(debuggerMocks.release).toHaveBeenCalledOnce();
  });

  it('maps a container element from business-frame coordinates into the outer viewport', async () => {
    containerMocks.getContainerTopFrame.mockResolvedValue({
      frameId: 'root-webview',
      url: 'https://example.test/',
    });
    containerMocks.getFrameViewportTransform.mockResolvedValue({
      frameId: 'root-webview',
      url: 'https://example.test/',
      offset: { x: 3, y: 62 },
      scale: { x: 0.5, y: 0.5 },
      viewport: { width: 393, height: 790 },
    });

    await expect(captureNodeScreenshotViaCDP(7, '.card', 'png', 80)).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AQID',
      width: 60,
      height: 40,
    });

    expect(debuggerMocks.resolveDebuggerFrameExecutionContextId).toHaveBeenCalledWith(
      7,
      'root-webview',
      false,
      undefined,
    );
    const calls = (chrome.debugger.sendCommand as unknown as Mock).mock.calls;
    const elementEvaluation = calls.find(
      ([, method, params]) =>
        method === 'Runtime.evaluate' &&
        String(params.expression).includes('document.querySelector'),
    );
    expect(elementEvaluation?.[2]).toMatchObject({ contextId: 77 });
    const capture = calls.find(([, method]) => method === 'Page.captureScreenshot');
    expect(capture?.[2]).toMatchObject({
      clip: { x: 8, y: 72, width: 60, height: 40, scale: 1 },
    });
  });

  it('serializes screenshots for the same tab', async () => {
    let captureCount = 0;
    let finishFirstCapture!: () => void;
    const firstCapturePending = new Promise<void>(resolve => {
      finishFirstCapture = resolve;
    });
    (chrome.debugger.sendCommand as unknown as Mock).mockImplementation(
      async (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => {
        if (method === 'Page.captureScreenshot') {
          captureCount += 1;
          if (captureCount === 1) await firstCapturePending;
          return { data: 'AQID' };
        }
        return defaultDebuggerCommand(target, method, params);
      },
    );

    const first = captureScreenshotViaCDP(7, 'png', 80);
    await vi.waitFor(() => expect(captureCount).toBe(1));
    const second = captureScreenshotViaCDP(7, 'png', 80);

    await Promise.resolve();
    expect(debuggerMocks.acquireDebuggerLease).toHaveBeenCalledTimes(1);

    finishFirstCapture();
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(debuggerMocks.acquireDebuggerLease).toHaveBeenCalledTimes(2);
  });
});
