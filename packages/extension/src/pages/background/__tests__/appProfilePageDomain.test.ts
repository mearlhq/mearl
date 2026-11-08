import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';
import {
  cleanupTab,
  disableAppProfileDocumentBootstrapForTab,
  enableAppProfileDocumentBootstrapForTab,
  getTabState,
} from '../debuggerManager';
import { acquireDebuggerLease, getDebuggerSessionDebugState } from '../debuggerSessionManager';

const tabId = 4309;

vi.mock('../appProfileRuntimeSource', async () => {
  const { buildAppProfileRuntimeCallSource } =
    await import('@mearl/browser-core/appProfileRuntime');
  return {
    buildAppProfileRuntimeProgram: async (config: string) => ({
      registration: '',
      call: buildAppProfileRuntimeCallSource(config),
    }),
  };
});

describe('App 新文档脚本的 Page 域生命周期', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({ identifier: 'bootstrap' });
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ id: tabId, discarded: false }),
    } as unknown as typeof chrome.tabs;
  });

  afterEach(() => cleanupTab(tabId));

  it('App 启动脚本在页面操作结束后仍持有 Page 域，关闭模拟时释放', async () => {
    const { injected } = resolveAppProfile('shop');
    await enableAppProfileDocumentBootstrapForTab(tabId, injected);
    const operation = await acquireDebuggerLease(tabId, {
      consumer: 'page-operation',
      domains: ['Page'],
    });
    vi.mocked(chrome.debugger.sendCommand).mockClear();
    await operation.release();

    expect(getDebuggerSessionDebugState(tabId)?.domainRefs.Page).toBe(1);
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith({ tabId }, 'Page.disable', {});
    await enableAppProfileDocumentBootstrapForTab(tabId, injected);
    expect(getDebuggerSessionDebugState(tabId)?.domainRefs.Page).toBe(1);

    await disableAppProfileDocumentBootstrapForTab(tabId);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId }, 'Page.disable', {});
    expect(getTabState(tabId)?.appProfilePageLease).toBeUndefined();
  });

  it('启动脚本注册失败时释放 Page 域', async () => {
    const { injected } = resolveAppProfile('shop');
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});
    await expect(enableAppProfileDocumentBootstrapForTab(tabId, injected)).rejects.toThrow(
      'identifier',
    );
    expect(getTabState(tabId)?.appProfilePageLease).toBeUndefined();
    expect(getDebuggerSessionDebugState(tabId)?.domainRefs.Page).toBeUndefined();
  });

  it('注册脚本遇到会话失效后在新会话重新持有 Page 域', async () => {
    const { injected } = resolveAppProfile('shop');
    let failed = false;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && !failed) {
        failed = true;
        throw new Error('Detached while handling command');
      }
      return { identifier: 'bootstrap' };
    });

    await enableAppProfileDocumentBootstrapForTab(tabId, injected);

    expect(getDebuggerSessionDebugState(tabId)?.domainRefs.Page).toBe(1);
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(([, method]) => method === 'Page.enable'),
    ).toHaveLength(2);
    expect(getTabState(tabId)?.appProfileDocumentBootstrap?.identifier).toBe('bootstrap');
    await disableAppProfileDocumentBootstrapForTab(tabId);
    expect(getDebuggerSessionDebugState(tabId)?.domainRefs.Page).toBeUndefined();
  });
});
