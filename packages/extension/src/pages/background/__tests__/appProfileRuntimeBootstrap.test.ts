import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';
import { resolveEmulationConfig } from '@mearl/browser-core';

describe('App profile 启动脚本资源读取失败', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    chrome.runtime.getURL = vi.fn(path => `chrome-extension://runtime-test/${path}`);
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('后台重启后恢复跨进程 iframe 失败也会释放暂停的 target', async () => {
    const { handleAppProfileChildTargetEvent } = await import('../debuggerManager');
    const { injected } = resolveAppProfile('reader');
    const emulation = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Page.getFrameTree' ? { frameTree: { frame: { name: '__mearl_root__' } } } : {});

    await expect(
      handleAppProfileChildTargetEvent(
        9991,
        'Target.attachedToTarget',
        { sessionId: 'child-session', targetInfo: { type: 'iframe' } },
        injected,
        emulation,
      ),
    ).resolves.toBeUndefined();

    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 9991, sessionId: 'child-session' },
      'Runtime.runIfWaitingForDebugger',
      {},
    );
    expect(fetch).toHaveBeenCalled();
  });
});
