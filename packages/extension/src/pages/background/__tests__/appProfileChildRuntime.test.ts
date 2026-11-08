import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';

vi.mock('../appProfileRuntimeSource', () => ({
  buildAppProfileRuntimeProgram: vi.fn(async () => ({
    registration: 'window.registeredDynamicRuntime = true;',
    call: '',
  })),
}));

describe('普通跨进程 iframe 的动态 App 运行时', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({ identifier: 'bootstrap' });
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
  });

  it('在恢复执行前注册运行时，不覆盖子页面设备或导航', async () => {
    const { handleAppProfileChildTargetEvent } = await import('../debuggerManager');
    const config = resolveAppProfile('reader').injected;
    config.pageRuntime = { id: 'example/main', sha256: 'a'.repeat(64) };
    await handleAppProfileChildTargetEvent(9901, 'Target.attachedToTarget', {
      sessionId: 'ordinary-frame', targetInfo: { type: 'iframe' },
    }, config);

    const calls = vi.mocked(chrome.debugger.sendCommand).mock.calls;
    const registration = calls.findIndex(call => call[1] === 'Page.addScriptToEvaluateOnNewDocument');
    const resume = calls.findIndex(call => call[1] === 'Runtime.runIfWaitingForDebugger');
    const page = calls.findIndex(call => call[1] === 'Page.enable');
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(page).toBeGreaterThanOrEqual(0);
    expect(page).toBeLessThan(registration);
    expect(registration).toBeLessThan(resume);
    expect(calls[registration]).toEqual([
      { tabId: 9901, sessionId: 'ordinary-frame' },
      'Page.addScriptToEvaluateOnNewDocument',
      { source: 'window.registeredDynamicRuntime = true;' },
    ]);
    expect(calls.some(call => call[1].startsWith('Emulation.') || call[1] === 'Fetch.enable')).toBe(false);
  });

  it('关闭设备外壳后仍保留动态运行时的子 target 附加，关闭 App 后释放', async () => {
    const { enableAppProfileDocumentBootstrapForTab, clearDeviceShellWebViewEnvironmentForTab,
      disableAppProfileDocumentBootstrapForTab, cleanupTab } = await import('../debuggerManager');
    const config = resolveAppProfile('reader').injected;
    config.pageRuntime = { id: 'example/main', sha256: 'a'.repeat(64) };
    await enableAppProfileDocumentBootstrapForTab(9902, config);
    vi.mocked(chrome.debugger.sendCommand).mockClear();
    await clearDeviceShellWebViewEnvironmentForTab(9902);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9902 }, 'Target.setAutoAttach',
      expect.objectContaining({ autoAttach: true, waitForDebuggerOnStart: true }));
    vi.mocked(chrome.debugger.sendCommand).mockClear();
    await disableAppProfileDocumentBootstrapForTab(9902);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9902 }, 'Target.setAutoAttach',
      expect.objectContaining({ autoAttach: false, waitForDebuggerOnStart: false }));
    cleanupTab(9902);
  });

  it('切换到基本 UA 档案时关闭动态运行时的附加', async () => {
    const { enableAppProfileDocumentBootstrapForTab, cleanupTab } = await import('../debuggerManager');
    const config = resolveAppProfile('reader').injected;
    await enableAppProfileDocumentBootstrapForTab(9903, {
      ...config, pageRuntime: { id: 'example/main', sha256: 'a'.repeat(64) },
    });
    vi.mocked(chrome.debugger.sendCommand).mockClear();
    await enableAppProfileDocumentBootstrapForTab(9903, config);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9903 }, 'Target.setAutoAttach',
      expect.objectContaining({ autoAttach: false, waitForDebuggerOnStart: false }));
    cleanupTab(9903);
  });

  it('附加失败时移除新脚本，同配置能够重新准备', async () => {
    const { enableAppProfileDocumentBootstrapForTab, getTabState, cleanupTab } = await import('../debuggerManager');
    const config = { ...resolveAppProfile('reader').injected,
      pageRuntime: { id: 'example/main', sha256: 'a'.repeat(64) } };
    let fail = true;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === 'Target.setAutoAttach' && fail) { fail = false; throw new Error('attach failed'); }
      return { identifier: 'bootstrap' };
    });
    await expect(enableAppProfileDocumentBootstrapForTab(9904, config)).rejects.toThrow('attach failed');
    expect(getTabState(9904)?.appProfileDocumentBootstrap).toBeUndefined();
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9904 },
      'Page.removeScriptToEvaluateOnNewDocument', { identifier: 'bootstrap' });
    await enableAppProfileDocumentBootstrapForTab(9904, config);
    expect(getTabState(9904)?.appProfileDocumentBootstrap?.needsChildRuntime).toBe(true);
    cleanupTab(9904);
  });
});
