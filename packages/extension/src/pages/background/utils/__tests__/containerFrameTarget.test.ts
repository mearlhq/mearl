import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAppProfileForTab: vi.fn(),
  getDeviceShellForTab: vi.fn(),
  acquireDebuggerLease: vi.fn(),
  release: vi.fn(),
  listBusinessWebViewSessions: vi.fn(),
}));

vi.mock('../appProfileRules', () => ({
  getAppProfileForTab: mocks.getAppProfileForTab,
}));

vi.mock('../../deviceShellRules', () => ({
  getDeviceShellForTab: mocks.getDeviceShellForTab,
}));

vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease: mocks.acquireDebuggerLease,
}));

vi.mock('../../backgroundRequestCollector', () => ({
  listBusinessWebViewSessions: mocks.listBusinessWebViewSessions,
}));

import {
  getContainerTopFrame,
  getFrameViewportTransform,
  reloadContainerTopFrame,
} from '../containerFrameTarget';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chrome.debugger.sendCommand).mockReset();
  mocks.getAppProfileForTab.mockResolvedValue({ profile: 'reader' });
  mocks.getDeviceShellForTab.mockResolvedValue(null);
  mocks.acquireDebuggerLease.mockResolvedValue({ release: mocks.release });
  mocks.release.mockResolvedValue(undefined);
  mocks.listBusinessWebViewSessions.mockReturnValue([]);
});

describe('getContainerTopFrame', () => {
  it('skips debugger discovery when a capture only needs the phone frame', async () => {
    mocks.getDeviceShellForTab.mockResolvedValue({ config: {} });
    await expect(getContainerTopFrame(7, 'phone-frame')).resolves.toBeUndefined();
    expect(mocks.acquireDebuggerLease).not.toHaveBeenCalled();
    expect(mocks.getAppProfileForTab).not.toHaveBeenCalled();
  });

  it('无上层页面时把自动化目标解析到根 WebView', async () => {
    vi.mocked(chrome.debugger.sendCommand).mockResolvedValueOnce({
      frameTree: {
        frame: { id: 'top', url: 'https://example.com/home' },
        childFrames: [
          {
            frame: {
              id: 'root',
              name: '__mearl_root__',
              url: 'https://example.com/home',
            },
          },
        ],
      },
    } as never);

    await expect(getContainerTopFrame(7)).resolves.toEqual({
      frameId: 'root',
      url: 'https://example.com/home',
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('有多层 WebView 时选择最后打开的栈顶层', async () => {
    vi.mocked(chrome.debugger.sendCommand).mockResolvedValueOnce({
      frameTree: {
        frame: { id: 'top', url: 'https://example.com/home' },
        childFrames: [
          {
            frame: {
              id: 'root',
              name: '__mearl_root__',
              url: 'https://example.com/home',
            },
          },
          {
            frame: {
              id: 'layer-1',
              name: '__mearl_layer__',
              url: 'https://example.com/list',
            },
          },
          {
            frame: {
              id: 'layer-2',
              name: '__mearl_layer__',
              url: 'https://example.com/detail',
            },
          },
        ],
      },
    } as never);

    await expect(getContainerTopFrame(7)).resolves.toEqual({
      frameId: 'layer-2',
      url: 'https://example.com/detail',
    });
  });

  it('等待关闭动画结束后选择恢复交互的下层', async () => {
    let activeLayerInspections = 0;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method, params) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', url: 'https://example.com/home' },
            childFrames: [
              {
                frame: {
                  id: 'root',
                  name: '__mearl_root__',
                  url: 'https://example.com/home',
                },
              },
              {
                frame: {
                  id: 'active-layer',
                  name: '__mearl_layer__',
                  url: 'https://example.com/list',
                },
              },
              {
                frame: {
                  id: 'closing-layer',
                  name: '__mearl_layer__',
                  url: 'https://example.com/detail',
                },
              },
            ],
          },
        } as never;
      }
      if (method === 'DOM.getFrameOwner') {
        const frameId = (params as { frameId?: string })?.frameId;
        return {
          backendNodeId: frameId === 'active-layer' ? 2 : frameId === 'closing-layer' ? 3 : 1,
        } as never;
      }
      if (method === 'DOM.describeNode') {
        const backendNodeId = (params as { backendNodeId?: number })?.backendNodeId;
        if (backendNodeId === 2) activeLayerInspections += 1;
        return {
          node: {
            attributes:
              backendNodeId === 2 && activeLayerInspections > 1
                ? ['name', '__mearl_layer__']
                : ['inert', '', 'aria-hidden', 'true'],
          },
        } as never;
      }
      return {} as never;
    });

    await expect(getContainerTopFrame(7)).resolves.toEqual({
      frameId: 'active-layer',
      url: 'https://example.com/list',
    });
    expect(activeLayerInspections).toBe(2);
  });

  it('非容器 tab 不申请调试会话', async () => {
    mocks.getAppProfileForTab.mockResolvedValue(undefined);

    await expect(getContainerTopFrame(7)).resolves.toBeUndefined();
    expect(mocks.acquireDebuggerLease).not.toHaveBeenCalled();
  });

  it('finds a cross-origin business layer in its child session', async () => {
    mocks.getDeviceShellForTab.mockResolvedValue({ config: { phoneFrame: { width: 402, height: 874 } } });
    mocks.listBusinessWebViewSessions.mockReturnValue(['child-session']);
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (target, method, params) => {
      if (method === 'Page.getFrameTree') {
        return 'sessionId' in target
          ? { frameTree: { frame: { id: 'layer', parentId: 'top', name: '__mearl_layer__', url: 'https://layer.test/' } } }
          : { frameTree: { frame: { id: 'top', url: 'https://example.test/' }, childFrames: [
              { frame: { id: 'root', parentId: 'top', name: '__mearl_root__', url: 'https://example.test/' } },
            ] } };
      }
      if (method === 'DOM.getFrameOwner') {
        return { backendNodeId: (params as { frameId: string }).frameId === 'layer' ? 2 : 1 };
      }
      if (method === 'DOM.describeNode') {
        return { node: { attributes: (params as { backendNodeId: number }).backendNodeId === 2 ? [] : ['inert', ''] } };
      }
      return {};
    });
    await expect(getContainerTopFrame(7)).resolves.toEqual({
      frameId: 'layer', sessionId: 'child-session', phoneFrame: true, url: 'https://layer.test/',
    });
  });

  it('纯设备外壳也把自动化目标解析到根 WebView', async () => {
    mocks.getAppProfileForTab.mockResolvedValue(undefined);
    mocks.getDeviceShellForTab.mockResolvedValue({ config: { platform: 'ios' } });
    vi.mocked(chrome.debugger.sendCommand).mockResolvedValueOnce({
      frameTree: {
        frame: { id: 'top', url: 'https://example.com/home' },
        childFrames: [
          {
            frame: {
              id: 'root',
              name: '__mearl_root__',
              url: 'https://example.com/home',
            },
          },
        ],
      },
    } as never);

    await expect(getContainerTopFrame(7)).resolves.toEqual({
      frameId: 'root',
      url: 'https://example.com/home',
    });
  });
});

describe('reloadContainerTopFrame', () => {
  it('只刷新栈顶半弹层 WebView，保留承载展示状态的父文档', async () => {
    let debuggerListener:
      | ((source: chrome.debugger.Debuggee, method: string, params: any) => void)
      | undefined;
    vi.mocked(chrome.debugger.onEvent.addListener).mockImplementation(listener => {
      debuggerListener = listener;
    });
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method, _params) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', url: 'https://example.com/home' },
            childFrames: [
              {
                frame: {
                  id: 'root',
                  name: '__mearl_root__',
                  url: 'https://example.com/home',
                },
              },
              {
                frame: {
                  id: 'sheet',
                  name: '__mearl_layer__',
                  url: 'https://example.com/detail?pop=true',
                },
              },
            ],
          },
        } as never;
      }
      if (method === 'Page.navigate') {
        queueMicrotask(() => {
          debuggerListener?.({ tabId: 7 }, 'Page.frameStartedLoading', { frameId: 'sheet' });
          debuggerListener?.({ tabId: 7 }, 'Page.frameStoppedLoading', { frameId: 'sheet' });
        });
      }
      return {} as never;
    });

    await expect(reloadContainerTopFrame(7)).resolves.toEqual({
      frameId: 'sheet',
      url: 'https://example.com/detail?pop=true',
    });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Page.navigate', {
      url: 'https://example.com/detail?pop=true',
      frameId: 'sheet',
    });
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'Page.reload',
      expect.anything(),
    );
    expect(chrome.debugger.onEvent.removeListener).toHaveBeenCalledWith(debuggerListener);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});

describe('getFrameViewportTransform', () => {
  it('组合 frame 内容区相对顶层视口的偏移与缩放', async () => {
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top', url: 'https://example.com/shell' },
            childFrames: [
              {
                frame: {
                  id: 'business',
                  parentId: 'top',
                  name: '__mearl_layer__',
                  url: 'https://example.com/list',
                },
              },
            ],
          },
        } as never;
      }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 42 } as never;
      if (method === 'DOM.resolveNode') return { object: { objectId: 'frame-owner' } } as never;
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: { x: 0, y: 103, scaleX: 1, scaleY: 1, width: 393, height: 749 },
          },
        } as never;
      }
      return {} as never;
    });

    await expect(getFrameViewportTransform(7, 'business')).resolves.toEqual({
      frameId: 'business',
      url: 'https://example.com/list',
      outerOwnerBackendNodeId: 42,
      offset: { x: 0, y: 103 },
      scale: { x: 1, y: 1 },
      viewport: { width: 393, height: 749 },
    });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Runtime.releaseObject',
      { objectId: 'frame-owner' },
    );
  });
});
