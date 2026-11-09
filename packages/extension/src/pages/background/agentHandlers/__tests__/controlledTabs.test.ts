import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupControlledTab,
  getControlledWindowId,
  listControlledTabIds,
  markTabControlled,
  releaseControlledTab,
} from '../controlledTabs';

describe('controlled tab registry & favicon indicator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const faviconState = (window as any).__mearlControlledFavicon__;
    faviconState?.observer?.disconnect?.();
    delete (window as any).__mearlControlledFavicon__;
    document.head.innerHTML = '';
    // 清空上一个用例遗留的登记（storage.session 缺失时走内存兜底）
    for (const tabId of await listControlledTabIds()) {
      cleanupControlledTab(tabId);
    }

    chrome.tabs = {
      get: vi.fn().mockImplementation(async (tabId: number) => ({ id: tabId, windowId: 100 })),
    } as any;
    chrome.windows = {
      get: vi.fn().mockResolvedValue({ type: 'normal' }),
    } as any;
    chrome.scripting = {
      executeScript: vi.fn().mockResolvedValue([]),
    } as any;
  });

  it('registers the tab and injects the favicon override script', async () => {
    await markTabControlled(42);

    expect(await listControlledTabIds()).toEqual([42]);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 42 },
        args: [expect.stringContaining('data:')],
        injectImmediately: true,
      }),
    );

    // 再次标记重新注入，覆盖导航后的新文档；页内幂等由注入脚本 guard 保证
    await markTabControlled(42);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it('uses distinct favicon variants for local and remote control', async () => {
    await markTabControlled(42, 'local');
    await markTabControlled(42, 'remote');

    const localInjection = vi.mocked(chrome.scripting.executeScript).mock.calls[0][0] as {
      args?: unknown[];
    };
    const remoteInjection = vi.mocked(chrome.scripting.executeScript).mock.calls[1][0] as {
      args?: unknown[];
    };
    const localUrl = localInjection.args?.[0] as string;
    const remoteUrl = remoteInjection.args?.[0] as string;

    expect(decodeURIComponent(localUrl)).toContain('data-control-source="local"');
    expect(decodeURIComponent(remoteUrl)).toContain('data-control-source="remote"');
    expect(localUrl).not.toBe(remoteUrl);
  });

  it('reapplies the favicon when the document head is replaced', async () => {
    await markTabControlled(42);
    const injection = vi.mocked(chrome.scripting.executeScript).mock.calls[0][0] as unknown as {
      func: (iconHref: string) => void;
      args: [string];
    };
    injection.func(...injection.args);
    expect(document.head.querySelector('link[data-mearl-favicon]')).not.toBeNull();

    const nextHead = document.createElement('head');
    document.head.replaceWith(nextHead);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(nextHead.querySelector('link[data-mearl-favicon]')).not.toBeNull();
  });

  it('resolves the window of the most recently marked alive tab', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);
    await markTabControlled(1);
    nowSpy.mockReturnValue(2000);
    await markTabControlled(2);
    nowSpy.mockRestore();

    vi.mocked(chrome.tabs.get).mockImplementation(async (tabId: number) => {
      return { id: tabId, windowId: tabId * 10 } as chrome.tabs.Tab;
    });
    await expect(getControlledWindowId()).resolves.toBe(20);

    // 最近的标签页已关闭时回退到次新的存活标签页
    vi.mocked(chrome.tabs.get).mockImplementation(async (tabId: number) => {
      if (tabId === 2) throw new Error('No tab with id: 2');
      return { id: tabId, windowId: tabId * 10 } as chrome.tabs.Tab;
    });
    await expect(getControlledWindowId()).resolves.toBe(10);
  });

  it('keeps the agent action working when injection is not permitted', async () => {
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(
      new Error('Cannot access contents of the page'),
    );

    await expect(markTabControlled(9)).resolves.toBeUndefined();
    // 登记成功，closeExisting 等功能职责不受注入失败影响
    expect(await listControlledTabIds()).toEqual([9]);
  });

  it('registers and releases a tab without waiting for favicon scripts', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(chrome.scripting.executeScript).mockImplementation(() => new Promise(() => {}));
      let marked = false;
      void markTabControlled(9).then(() => {
        marked = true;
      });
      await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(marked).toBe(true);
      expect(await listControlledTabIds()).toEqual([9]);

      let released = false;
      void releaseControlledTab(9).then(() => {
        released = true;
      });
      await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(released).toBe(true);
      expect(await listControlledTabIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unregisters the tab on cleanup', async () => {
    await markTabControlled(5);
    cleanupControlledTab(5);
    // unregister 走串行队列，等一拍
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(await listControlledTabIds()).toEqual([]);
  });

  it('removes the registry entry and injects favicon restoration on release', async () => {
    await markTabControlled(6);
    vi.mocked(chrome.scripting.executeScript).mockClear();

    await releaseControlledTab(6);

    expect(await listControlledTabIds()).toEqual([]);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 6 },
        injectImmediately: true,
        func: expect.any(Function),
      }),
    );
  });
});
