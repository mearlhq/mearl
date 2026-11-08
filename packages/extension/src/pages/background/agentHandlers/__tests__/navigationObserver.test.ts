import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const leaseMocks = vi.hoisted(() => ({
  release: vi.fn(),
  options: undefined as { onInvalidated?: () => void } | undefined,
}));
vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease: vi.fn(async (_tabId: number, options: { onInvalidated?: () => void }) => {
    leaseMocks.options = options;
    return { tabId: 1, consumer: 'test', generation: 1, release: leaseMocks.release };
  }),
}));

import { acquireDebuggerLease } from '../../debuggerSessionManager';
import { startExtensionNavigationObserver } from '../navigationObserver';

describe('extension navigation adapter', () => {
  let tabListener: (tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void;
  let createdTabListener: (tab: chrome.tabs.Tab) => void;
  let createdNavigationTargetListener: (
    details: chrome.webNavigation.WebNavigationSourceCallbackDetails,
  ) => void;
  let debuggerListener: (source: chrome.debugger.Debuggee, method: string, params: any) => void;
  const tabsById = new Map<number, chrome.tabs.Tab>();
  const removeTabListener = vi.fn();
  const removeCreatedTabListener = vi.fn();
  const removeCreatedNavigationTargetListener = vi.fn();
  const removeDebuggerListener = vi.fn();

  beforeEach(() => {
    leaseMocks.release.mockReset().mockResolvedValue(undefined);
    leaseMocks.options = undefined;
    removeTabListener.mockClear();
    removeCreatedTabListener.mockClear();
    removeCreatedNavigationTargetListener.mockClear();
    removeDebuggerListener.mockClear();
    tabsById.clear();
    vi.mocked(acquireDebuggerLease).mockClear();
    chrome.tabs = {
      get: vi.fn(async (tabId: number) => tabsById.get(tabId)),
      onCreated: {
        addListener: vi.fn(callback => {
          createdTabListener = callback as typeof createdTabListener;
        }),
        removeListener: removeCreatedTabListener,
      },
      onUpdated: {
        addListener: vi.fn(callback => {
          tabListener = callback as typeof tabListener;
        }),
        removeListener: removeTabListener,
      },
    } as any;
    chrome.webNavigation = {
      onCreatedNavigationTarget: {
        addListener: vi.fn(callback => {
          createdNavigationTargetListener = callback as typeof createdNavigationTargetListener;
        }),
        removeListener: removeCreatedNavigationTargetListener,
      },
    } as any;
    chrome.debugger = {
      onEvent: {
        addListener: vi.fn(callback => {
          debuggerListener = callback as typeof debuggerListener;
        }),
        removeListener: removeDebuggerListener,
      },
    } as any;
    chrome.scripting = { executeScript: vi.fn().mockResolvedValue([]) } as any;
  });

  afterEach(() => vi.useRealTimers());

  it('maps tab updates to a completed navigation and cleans up listeners', async () => {
    const observer = await startExtensionNavigationObserver(7, 'https://example.test/start');
    tabListener(7, { status: 'loading', url: 'https://example.test/results' }, {
      id: 7,
      url: 'https://example.test/results',
      status: 'loading',
    } as chrome.tabs.Tab);
    tabListener(7, { status: 'complete' }, {
      id: 7,
      url: 'https://example.test/results',
      title: 'Results',
      status: 'complete',
    } as chrome.tabs.Tab);

    await expect(observer.waitForResult(100)).resolves.toEqual(
      expect.objectContaining({
        urlAfter: 'https://example.test/results',
        title: 'Results',
        settledBy: 'load',
      }),
    );
    await observer.dispose();
    expect(removeTabListener).toHaveBeenCalledOnce();
    expect(acquireDebuggerLease).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('maps debugger request events and releases the Network lease', async () => {
    vi.useFakeTimers();
    const observer = await startExtensionNavigationObserver(8, 'https://example.test/start', {
      trackNetwork: true,
      networkIdleMs: 100,
    });
    debuggerListener({ tabId: 8 }, 'Network.requestWillBeSent', {
      requestId: 'search',
      type: 'XHR',
      request: { url: 'https://example.test/api/search' },
    });
    tabListener(8, { status: 'loading', url: 'https://example.test/results' }, {
      id: 8,
      url: 'https://example.test/results',
      status: 'loading',
    } as chrome.tabs.Tab);
    tabListener(8, { status: 'complete' }, {
      id: 8,
      url: 'https://example.test/results',
      status: 'complete',
    } as chrome.tabs.Tab);
    const result = observer.waitForResult(1000);
    debuggerListener({ tabId: 8 }, 'Network.loadingFinished', { requestId: 'search' });
    await vi.advanceTimersByTimeAsync(101);

    await expect(result).resolves.toEqual(
      expect.objectContaining({ settledBy: 'network-idle', pendingRequests: 0 }),
    );
    await observer.dispose();
    expect(acquireDebuggerLease).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ consumer: 'page-act-navigation', domains: ['Network'] }),
    );
    expect(removeDebuggerListener).toHaveBeenCalledOnce();
    expect(leaseMocks.release).toHaveBeenCalledOnce();
  });

  it('reports directly opened tabs once with final metadata', async () => {
    tabsById.set(12, {
      id: 12,
      openerTabId: 7,
      url: 'https://example.test/results',
      title: 'Results',
      active: false,
      status: 'complete',
    } as chrome.tabs.Tab);
    tabsById.set(13, {
      id: 13,
      openerTabId: 99,
      url: 'https://example.test/unrelated',
      title: 'Unrelated',
      active: false,
      status: 'complete',
    } as chrome.tabs.Tab);
    const observer = await startExtensionNavigationObserver(7, 'https://example.test/start', {
      trackOpenedTabs: true,
      sourceTabId: 7,
    });

    createdTabListener({ id: 12, openerTabId: 7, pendingUrl: 'about:blank' } as chrome.tabs.Tab);
    createdNavigationTargetListener({
      sourceTabId: 7,
      sourceFrameId: 0,
      sourceProcessId: 1,
      tabId: 12,
      url: 'https://example.test/results',
      timeStamp: 1,
    });
    createdTabListener({ id: 13, openerTabId: 99 } as chrome.tabs.Tab);

    await expect(observer.getOpenedTabs(100)).resolves.toEqual([
      {
        tabId: 12,
        openerTabId: 7,
        url: 'https://example.test/results',
        title: 'Results',
        active: false,
        ready: true,
        settledBy: 'load',
      },
    ]);
    await observer.dispose();
    expect(removeCreatedTabListener).toHaveBeenCalledOnce();
    expect(removeCreatedNavigationTargetListener).toHaveBeenCalledOnce();
  });

  it('stops extending navigation detection when the debugger lease is invalidated', async () => {
    vi.useFakeTimers();
    const observer = await startExtensionNavigationObserver(9, 'https://example.test/start', {
      trackNetwork: true,
    });
    debuggerListener({ tabId: 9 }, 'Network.requestWillBeSent', {
      requestId: 'search',
      type: 'Fetch',
      request: { url: 'https://example.test/api/search' },
    });
    const started = observer.waitForStart(100);
    await vi.advanceTimersByTimeAsync(150);
    leaseMocks.options?.onInvalidated?.();
    await vi.advanceTimersByTimeAsync(50);

    await expect(started).resolves.toBe(false);
    await observer.dispose();
  });

  it('bounds readiness cleanup when the target page does not answer', async () => {
    vi.useFakeTimers();
    chrome.scripting.executeScript = vi.fn(() => new Promise(() => {})) as any;
    const observer = await startExtensionNavigationObserver(10, 'https://example.test/start', {
      trackNetwork: true,
    });
    const disposed = observer.dispose();

    await vi.advanceTimersByTimeAsync(1001);

    await expect(disposed).resolves.toBeUndefined();
    expect(leaseMocks.release).toHaveBeenCalledOnce();
  });
});
