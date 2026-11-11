vi.mock('../../appProfileCatalog', () => ({
  resolveAvailableAppProfile: async (
    ...args: Parameters<
      typeof import('../../../../../../app-profiles/src/__tests__/fixtures').resolveAppProfile
    >
  ) =>
    (await import('../../../../../../app-profiles/src/__tests__/fixtures')).resolveAppProfile(
      ...args,
    ),
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backgroundPageActivity', () => ({
  setBackgroundPageActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../backgroundRequestCollector', () => ({
  flushRequestCollection: vi.fn().mockResolvedValue(undefined),
  cleanupCollector: vi.fn(),
  getCaptureCheckpoint: vi.fn((tabId: number) => ({
    tabId,
    cursor: `cursor-${tabId}`,
    timestampMs: 1,
    captureStatus: 'armed',
  })),
  isCollecting: vi.fn().mockReturnValue(false),
  startRequestCollection: vi.fn().mockResolvedValue(undefined),
  stopRequestCollection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../debuggerManager', () => ({
  disableEmulationForTab: vi.fn().mockResolvedValue(undefined),
  enableAppProfileDocumentBootstrapForTab: vi.fn().mockResolvedValue(undefined),
  enableEmulationForTab: vi.fn().mockResolvedValue(undefined),
  enableSafeAreaInsetsForTab: vi.fn().mockResolvedValue(undefined),
  emulationRuntimeStateMatches: vi.fn(
    (
      state: {
        screenWidth: number;
        deviceScaleFactor: number;
        userAgent: string;
        maxTouchPoints: number;
      } | null,
      config: {
        width: number;
        deviceScaleFactor: number;
        userAgent: string;
        touch: boolean;
      },
      expectedUserAgent = config.userAgent,
    ) =>
      Boolean(
        state &&
        state.screenWidth === config.width &&
        Math.abs(state.deviceScaleFactor - config.deviceScaleFactor) < 0.01 &&
        state.userAgent === expectedUserAgent &&
        (config.touch ? state.maxTouchPoints > 0 : state.maxTouchPoints === 0),
      ),
  ),
  navigateTabInSession: vi.fn().mockResolvedValue(undefined),
  prepareDeviceShellWebViewEnvironmentForTab: vi.fn().mockResolvedValue(undefined),
  reapplyEmulationForTab: vi.fn().mockResolvedValue(undefined),
  reapplySafeAreaInsetsForTab: vi.fn().mockResolvedValue(undefined),
  reloadTabInSession: vi.fn().mockResolvedValue(undefined),
  readEmulationRuntimeState: vi.fn(),
  readSafeAreaRuntimeState: vi.fn(),
  safeAreaRuntimeStateMatches: vi.fn(
    (state: Record<string, number> | null, expected: Record<string, number>) =>
      Boolean(
        state &&
        state.top === expected.top &&
        state.right === expected.right &&
        state.bottom === expected.bottom &&
        state.left === expected.left,
      ),
  ),
}));
vi.mock('../../agentChatTabBindings', () => ({
  bindAgentChatTabFromSource: vi.fn().mockResolvedValue(null),
  getAgentChatTabBindings: vi.fn().mockResolvedValue({ bindings: {} }),
}));
vi.mock('../../utils/containerFrameTarget', () => ({
  reloadContainerTopFrame: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../deviceShellRules', () => ({
  applyDeviceShellForTab: vi.fn().mockResolvedValue(undefined),
  clearDeviceShellForTab: vi.fn().mockResolvedValue(undefined),
}));

import {
  addCollectingTab,
  applyEmulationWithReload,
  applySafeAreaInsetsWithReload,
  handlePageNavigate,
  handleTabClose,
  handleTabGroup,
  handleTabList,
  handleTabOpen,
  listCollectingMarkerTabIds,
  navigateAndWait,
  removeCollectingTab,
  waitForTabLoad,
} from '../tabHandlers';
import {
  getCaptureCheckpoint,
  startRequestCollection,
  stopRequestCollection,
} from '../../backgroundRequestCollector';
import {
  enableAppProfileDocumentBootstrapForTab,
  enableEmulationForTab,
  enableSafeAreaInsetsForTab,
  navigateTabInSession,
  prepareDeviceShellWebViewEnvironmentForTab,
  readEmulationRuntimeState,
  readSafeAreaRuntimeState,
  reapplyEmulationForTab,
  reapplySafeAreaInsetsForTab,
  reloadTabInSession,
} from '../../debuggerManager';
import { bindAgentChatTabFromSource, getAgentChatTabBindings } from '../../agentChatTabBindings';
import { createControlledFaviconDataUrl, resolveEmulationConfig } from '@mearl/browser-core';
import { resolveAppProfile } from '../../../../../../app-profiles/src/__tests__/fixtures';
import { setBackgroundPageActivity } from '../../backgroundPageActivity';
import { reloadContainerTopFrame } from '../../utils/containerFrameTarget';
import { applyDeviceShellForTab } from '../../deviceShellRules';

describe('extension tab lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.storage.sync = {
      get: vi.fn().mockResolvedValue({ agentPreventForeground: false }),
    } as any;
    vi.mocked(setBackgroundPageActivity).mockResolvedValue(undefined);
    vi.mocked(stopRequestCollection).mockResolvedValue(undefined);
    vi.mocked(getAgentChatTabBindings).mockResolvedValue({ bindings: {} });
    vi.mocked(reloadContainerTopFrame).mockResolvedValue(undefined);
    chrome.tabs = {
      query: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
    } as any;
    chrome.windows = {
      update: vi.fn().mockResolvedValue(undefined),
    } as any;
    chrome.tabGroups = undefined as any;
    chrome.scripting = undefined as any;
    chrome.declarativeNetRequest = {
      getSessionRules: vi.fn().mockResolvedValue([]),
      updateSessionRules: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  it('lists tabs with the exact Mearl favicon as controlled after the registry is lost', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      {
        id: 999991,
        windowId: 1,
        url: 'https://example.test/local',
        favIconUrl: createControlledFaviconDataUrl('local'),
        active: false,
      },
      {
        id: 999992,
        windowId: 1,
        url: 'https://example.test/remote',
        favIconUrl: createControlledFaviconDataUrl('remote'),
        active: false,
      },
      {
        id: 999993,
        windowId: 1,
        url: 'https://example.test/other',
        favIconUrl: 'data:image/svg+xml,<svg/>',
        active: false,
      },
    ] as chrome.tabs.Tab[]);

    const result = await handleTabList();

    expect(result.tabs.map(tab => tab.controlled)).toEqual([true, true, undefined]);
  });

  it('includes the Chrome group color in tab_list', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 7, windowId: 3, groupId: 41, url: 'https://example.test' } as chrome.tabs.Tab,
    ]);
    chrome.tabGroups = {
      query: vi
        .fn()
        .mockResolvedValue([{ id: 41, windowId: 3, title: 'Project', color: 'orange' }]),
    } as any;

    await expect(handleTabList()).resolves.toMatchObject({
      tabs: [{ groupId: 41, groupTitle: 'Project', groupColor: 'orange' }],
    });
  });

  it.each([
    'https://example.test/page',
    'chrome-extension://test/options.html',
    'chrome://settings/',
  ])('reuses an explicitly requested tab without creating a new one: %s', async url => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        url: `${url}?state=ready`,
        title: 'Existing',
      } as chrome.tabs.Tab,
    ]);

    await expect(
      handleTabOpen({
        url,
        active: true,
        reuse: 'require',
        match: { ignoreSearch: true },
      }),
    ).resolves.toMatchObject({ tabId: 7, opened: false, reused: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(startRequestCollection).toHaveBeenCalledWith(7);
    expect(chrome.tabs.create).toBeUndefined();
  });

  it.each(['local', 'remote'] as const)(
    'emulates activation while foreground is blocked for %s agents',
    async controlSource => {
      vi.mocked(chrome.tabs.query).mockResolvedValue([
        { id: 7, windowId: 3, url: 'https://example.test/page' } as chrome.tabs.Tab,
      ]);
      vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
        agentPreventForeground: true,
      }));
      vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, active: false } as chrome.tabs.Tab);
      const params = { url: 'https://example.test/page', active: true, reuse: 'require' as const };
      const result = await handleTabOpen(params, controlSource);
      expect(result).toMatchObject({ tabId: 7, reused: true });
      expect(result.activation).toMatchObject({
        requested: true,
        mode: 'background',
        tabActive: false,
      });
      expect(setBackgroundPageActivity).toHaveBeenCalledWith(7, true, undefined);
      expect(chrome.tabs.update).not.toHaveBeenCalled();
      expect(chrome.windows.update).not.toHaveBeenCalled();
      expect(startRequestCollection).toHaveBeenCalledWith(7);

      vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
        agentPreventForeground: false,
      }));
      await handleTabOpen(params, controlSource);
      expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
      expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
    },
  );

  it.each(['binding', 'collection', 'lookup'] as const)(
    'does not enable background activity when reused tab %s fails',
    async stage => {
      const tab = {
        id: 7,
        windowId: 3,
        url: 'https://example.test/page',
        active: false,
      } as chrome.tabs.Tab;
      const failure = new Error('activation preparation failed');
      vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
        agentPreventForeground: true,
      }));
      vi.mocked(chrome.tabs.query).mockResolvedValue([tab]);
      vi.mocked(chrome.tabs.get).mockResolvedValue(tab);
      if (stage === 'binding') vi.mocked(bindAgentChatTabFromSource).mockRejectedValueOnce(failure);
      if (stage === 'collection') vi.mocked(startRequestCollection).mockRejectedValueOnce(failure);
      if (stage === 'lookup')
        vi.mocked(chrome.tabs.get).mockResolvedValueOnce(tab).mockRejectedValueOnce(failure);

      await expect(
        handleTabOpen({
          url: tab.url!,
          active: true,
          reuse: 'require',
          openerTabId: 11,
        }),
      ).rejects.toThrow('activation preparation failed');
      expect(setBackgroundPageActivity).not.toHaveBeenCalled();
    },
  );

  it('defaults to background activation when no foreground preference is stored', async () => {
    vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({}));
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 7, windowId: 3, url: 'https://example.test/page' } as chrome.tabs.Tab,
    ]);
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, active: false } as chrome.tabs.Tab);
    const result = await handleTabOpen({
      url: 'https://example.test/page',
      reuse: 'require',
      active: true,
    });
    expect(result.activation).toMatchObject({ mode: 'background', tabActive: false });
    expect(setBackgroundPageActivity).toHaveBeenCalledWith(7, true, undefined);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it('restores a minimized window and reports the verified activation state', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        url: 'https://example.test/page',
        title: 'Existing',
      } as chrome.tabs.Tab,
    ]);
    chrome.tabs.update = vi
      .fn()
      .mockResolvedValue({ id: 7, active: true } as chrome.tabs.Tab) as any;
    chrome.windows.update = vi
      .fn()
      .mockResolvedValueOnce({ id: 3, focused: true, state: 'minimized' } as chrome.windows.Window)
      .mockResolvedValueOnce({
        id: 3,
        focused: true,
        state: 'normal',
      } as chrome.windows.Window) as any;
    chrome.scripting = {
      executeScript: vi.fn().mockResolvedValue([{ result: 'visible' }]),
    } as any;

    await expect(
      handleTabOpen({
        url: 'https://example.test/page',
        active: true,
        reuse: 'require',
      }),
    ).resolves.toMatchObject({
      activation: {
        requested: true,
        tabActive: true,
        windowFocused: true,
        windowState: 'normal',
        visibilityState: 'visible',
      },
    });
    expect(chrome.windows.update).toHaveBeenNthCalledWith(1, 3, { focused: true });
    expect(chrome.windows.update).toHaveBeenNthCalledWith(2, 3, {
      focused: true,
      state: 'normal',
    });
  });

  it('rolls back a newly created tab when activation fails', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 11, windowId: 3 } as chrome.tabs.Tab);
    chrome.tabs.create = vi.fn().mockResolvedValue({ id: 7, windowId: 3 } as chrome.tabs.Tab);
    chrome.tabs.update = vi
      .fn()
      .mockResolvedValue({ id: 7, windowId: 3, active: true } as chrome.tabs.Tab) as any;
    chrome.windows.update = vi.fn().mockRejectedValue(new Error('window focus failed')) as any;

    await expect(
      handleTabOpen({
        url: 'https://example.test/target',
        active: true,
        openerTabId: 11,
      }),
    ).rejects.toThrow('tab_open could not establish browser control: window focus failed');

    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
    expect(stopRequestCollection).toHaveBeenCalledWith(7);
  });

  it.each([
    { active: false, blocked: false, title: 'Mearl', collapsed: true },
    { active: true, blocked: true, title: 'Mearl', collapsed: true },
    { active: true, blocked: false, title: 'agentUserTabGroup', collapsed: false },
  ])('groups a newly opened page according to its presentation: %j', async input => {
    vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
      agentPreventForeground: input.blocked,
    }));
    chrome.tabs.create = vi.fn().mockResolvedValue({ id: 7, windowId: 3 } as chrome.tabs.Tab);
    chrome.tabs.get = vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
      const tab = { id: tabId, windowId: 3, status: 'complete' } as chrome.tabs.Tab;
      if (callback) {
        callback(tab);
        return undefined;
      }
      return Promise.resolve(tab);
    }) as any;
    chrome.tabs.onUpdated = { addListener: vi.fn(), removeListener: vi.fn() } as any;
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);
    chrome.tabs.group = vi.fn().mockResolvedValue(55);
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleTabOpen({
      url: 'https://example.test/target',
      openerTabId: 11,
      active: input.active,
    });

    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        active: input.active && !input.blocked,
      }),
    );
    expect(chrome.tabs.group).toHaveBeenCalledWith({
      tabIds: [7],
      createProperties: { windowId: 3 },
    });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { title: input.title });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { collapsed: input.collapsed });
  });

  it('does not retain pre-navigation visibility when the final page cannot be verified', async () => {
    chrome.tabs.create = vi.fn().mockResolvedValue({
      id: 7,
      windowId: 3,
      status: 'complete',
    } as chrome.tabs.Tab);
    chrome.tabs.update = vi
      .fn()
      .mockResolvedValue({ id: 7, windowId: 3, active: true } as chrome.tabs.Tab) as any;
    chrome.windows.update = vi
      .fn()
      .mockResolvedValue({ id: 3, focused: true, state: 'normal' } as chrome.windows.Window) as any;
    chrome.tabs.onUpdated = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    } as any;
    chrome.tabs.get = vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
      const tab = {
        id: tabId,
        windowId: 3,
        status: 'complete',
        url: tabId === 11 ? 'https://example.test/source' : 'https://example.test/target',
        title: tabId === 11 ? 'Source' : 'Target',
      } as chrome.tabs.Tab;
      if (callback) {
        callback(tab);
        return undefined;
      }
      return Promise.resolve(tab);
    }) as any;
    let visibilityReads = 0;
    chrome.scripting = {
      executeScript: vi.fn(async options => {
        if (!String(options.func).includes('document.visibilityState')) return [{}];
        visibilityReads += 1;
        if (visibilityReads === 1) return [{ result: 'visible' }];
        throw new Error('target page is not scriptable');
      }),
    } as any;

    const result = await handleTabOpen({
      url: 'https://example.test/target',
      active: true,
      openerTabId: 11,
    });

    expect(result.activation).toMatchObject({ requested: true, tabActive: true });
    expect(result.activation).not.toHaveProperty('visibilityState');
    expect(visibilityReads).toBe(2);
  });

  it.each([false, true])(
    'opens in the work window instead of the opener window, active=%s',
    async active => {
      const source = { id: 11, windowId: 3, status: 'complete' } as chrome.tabs.Tab;
      const opened = { id: 7, windowId: 9, status: 'complete' } as chrome.tabs.Tab;
      chrome.tabs.create = vi.fn().mockResolvedValue(opened);
      chrome.tabs.get = vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
        const tab = tabId === 11 ? source : opened;
        if (callback) {
          callback(tab);
          return undefined;
        }
        return Promise.resolve(tab);
      }) as any;
      chrome.tabs.onUpdated = { addListener: vi.fn(), removeListener: vi.fn() } as any;
      vi.mocked(chrome.tabs.query).mockResolvedValue([]);
      vi.mocked(chrome.tabs.update).mockImplementation(async () => opened);
      chrome.tabs.group = vi.fn().mockResolvedValue(55);
      chrome.tabGroups = {
        query: vi.fn().mockResolvedValue([{ id: 44, title: 'Mearl', windowId: 9 }]),
        update: vi.fn().mockResolvedValue(undefined),
      } as any;

      await handleTabOpen({ url: 'https://example.test/target', openerTabId: 11, active });

      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'about:blank', active, windowId: 9 });
      expect(bindAgentChatTabFromSource).toHaveBeenCalledWith(11, 7);
      if (active) expect(chrome.windows.update).toHaveBeenCalledWith(9, { focused: true });
    },
  );

  it('keeps a reused foreground page in its original window and group', async () => {
    const page = {
      id: 7,
      windowId: 3,
      url: 'https://example.test/page',
      groupId: 99,
    } as chrome.tabs.Tab;
    vi.mocked(chrome.tabs.query).mockResolvedValue([page]);
    vi.mocked(chrome.tabs.get).mockResolvedValue(page);
    vi.mocked(chrome.tabs.update).mockImplementation(async () => page);
    chrome.tabs.group = vi.fn();
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 44, title: 'Mearl', windowId: 9 }]),
    } as any;

    await handleTabOpen({ url: page.url!, reuse: 'require', active: true });

    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
  });

  it('presents a reused managed foreground page in the user group', async () => {
    const page = {
      id: 7,
      windowId: 3,
      url: 'https://example.test/page',
      groupId: 44,
    } as chrome.tabs.Tab;
    vi.mocked(chrome.tabs.query).mockResolvedValue([page]);
    vi.mocked(chrome.tabs.get).mockResolvedValue(page);
    vi.mocked(chrome.tabs.update).mockImplementation(async () => page);
    chrome.tabs.group = vi.fn().mockResolvedValue(55);
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 44, title: 'Mearl', windowId: 3 }]),
      update: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleTabOpen({ url: page.url!, reuse: 'require', active: true });

    expect(chrome.tabs.group).toHaveBeenCalledWith({
      tabIds: [7],
      createProperties: { windowId: 3 },
    });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { title: 'agentUserTabGroup' });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { collapsed: false });
  });

  it('binds a reused tab to the explicit opener conversation', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        url: 'https://example.test/page',
        title: 'Existing',
      } as chrome.tabs.Tab,
    ]);

    await handleTabOpen({
      url: 'https://example.test/page',
      reuse: 'require',
      openerTabId: 11,
    });

    expect(bindAgentChatTabFromSource).toHaveBeenCalledWith(11, 7);
  });

  it('does not reuse a tab owned by another conversation', async () => {
    vi.mocked(getAgentChatTabBindings).mockResolvedValue({
      bindings: {
        '11': { ownerTabId: 11, sessionId: 'session-11' },
        '7': { ownerTabId: 7, sessionId: 'session-7' },
      },
    });
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        url: 'https://example.test/page',
        title: 'Other conversation',
      } as chrome.tabs.Tab,
    ]);

    await expect(
      handleTabOpen({
        url: 'https://example.test/page',
        reuse: 'require',
        openerTabId: 11,
      }),
    ).rejects.toThrow('did not find a matching existing tab');
    expect(bindAgentChatTabFromSource).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'creates a related background tab with foreground prevention %s',
    async prevented => {
      vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
        agentPreventForeground: prevented,
      }));
      vi.mocked(chrome.tabs.query).mockResolvedValue([]);
      chrome.tabs.create = vi.fn().mockResolvedValue({
        id: 7,
        windowId: 3,
        status: 'complete',
      } as chrome.tabs.Tab);
      chrome.tabs.onUpdated = {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      } as any;
      chrome.tabs.get = vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
        const tab = {
          id: tabId,
          windowId: 3,
          status: 'complete',
          url: tabId === 11 ? 'https://example.test/source' : 'https://example.test/target',
          title: tabId === 11 ? 'Source' : 'Target',
        } as chrome.tabs.Tab;
        if (callback) {
          callback(tab);
          return undefined;
        }
        return Promise.resolve(tab);
      }) as any;

      await expect(
        handleTabOpen({
          url: 'https://example.test/target',
          openerTabId: 11,
          active: prevented,
          restoreFocusOnClose: true,
        }),
      ).resolves.toMatchObject({ tabId: 7, opened: true });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'about:blank',
        active: false,
        windowId: 3,
        openerTabId: 11,
      });
      expect(bindAgentChatTabFromSource).toHaveBeenCalledWith(11, 7);
      expect(chrome.windows.update).not.toHaveBeenCalled();
      expect(chrome.tabs.update).not.toHaveBeenCalled();
      if (prevented) {
        expect(setBackgroundPageActivity).toHaveBeenCalledWith(7, true, undefined);
        expect(vi.mocked(setBackgroundPageActivity).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(navigateTabInSession).mock.invocationCallOrder[0]!,
        );
      } else {
        expect(setBackgroundPageActivity).not.toHaveBeenCalled();
      }
      expect(vi.mocked(startRequestCollection).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(navigateTabInSession).mock.invocationCallOrder[0]!,
      );
      // 基线取在导航完成之后
      expect(vi.mocked(getCaptureCheckpoint).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(navigateTabInSession).mock.invocationCallOrder[0]!,
      );
      expect(navigateTabInSession).toHaveBeenCalledWith(7, 'https://example.test/target');
    },
  );

  it('adds the tab to the named group when group is specified', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        url: 'https://example.test/page',
        title: 'Existing',
      } as chrome.tabs.Tab,
    ]);
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, windowId: 3 } as chrome.tabs.Tab);
    chrome.tabs.group = vi.fn().mockResolvedValue(55);
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    } as any;

    await expect(
      handleTabOpen({ url: 'https://example.test/page', reuse: 'require', group: '验证任务' }),
    ).resolves.toMatchObject({ tabId: 7, reused: true });
    expect(chrome.tabs.group).toHaveBeenCalledWith({
      tabIds: [7],
      createProperties: { windowId: 3 },
    });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { title: '验证任务' });
  });

  it('joins the existing group with the same title in the same window', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      {
        id: 7,
        windowId: 3,
        url: 'https://example.test/page',
        title: 'Existing',
      } as chrome.tabs.Tab,
    ]);
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, windowId: 3 } as chrome.tabs.Tab);
    chrome.tabs.group = vi.fn().mockResolvedValue(88);
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 88, title: '验证任务', windowId: 3 }]),
      update: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleTabOpen({ url: 'https://example.test/page', reuse: 'require', group: '验证任务' });
    expect(chrome.tabGroups.query).toHaveBeenCalledWith({ title: '验证任务', windowId: 3 });
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [7], groupId: 88 });
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });

  it('groups existing tabs without marking them as controlled', async () => {
    vi.mocked(chrome.tabs.get).mockImplementation(
      async id => ({ id, windowId: 3 }) as chrome.tabs.Tab,
    );
    chrome.tabs.group = vi.fn().mockResolvedValue(55);
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    } as any;

    await expect(handleTabGroup({ tabIds: [7, 8], title: 'Project' })).resolves.toEqual({
      groupId: 55,
      tabIds: [7, 8],
      title: 'Project',
    });
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [7, 8] });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { title: 'Project' });
    await expect(handleTabGroup({ tabIds: [7, 7], title: 'Project' })).rejects.toThrow('distinct');
  });

  it('only joins a group whose title matches exactly', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, windowId: 3 } as chrome.tabs.Tab);
    chrome.tabs.group = vi.fn().mockResolvedValue(55);
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 44, title: 'Project archive', windowId: 3 }]),
      update: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleTabGroup({ tabIds: [7], title: 'Project' });

    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [7] });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { title: 'Project' });
  });

  it('ungroups existing tabs through tab_group without closing them', async () => {
    chrome.tabs.ungroup = vi.fn().mockResolvedValue(undefined);

    await expect(handleTabGroup({ tabIds: [7, 8], ungroup: true })).resolves.toEqual({
      tabIds: [7, 8],
      ungrouped: true,
    });
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([7, 8]);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    await expect(handleTabGroup({ tabIds: [7, 7], ungroup: true })).rejects.toThrow('distinct');
  });

  it.each([false, true])(
    'respects foreground prevention %s when closing a temporary tab',
    async prevented => {
      vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
        agentPreventForeground: prevented,
      }));
      let restoreTargets: Record<string, { tabId: number; windowId: number }> = {
        '9': { tabId: 2, windowId: 1 },
      };
      chrome.storage.session = {
        get: vi.fn().mockImplementation(async () => ({
          agentTabRestoreTargets: restoreTargets,
        })),
        set: vi.fn().mockImplementation(async value => {
          restoreTargets = value.agentTabRestoreTargets;
        }),
      } as any;
      vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 2, windowId: 1 } as chrome.tabs.Tab);

      await expect(handleTabClose({ tabId: 9 })).resolves.toEqual({
        success: true,
        restoredTabId: prevented ? undefined : 2,
      });
      expect(chrome.tabs.remove).toHaveBeenCalledWith(9);
      if (prevented) {
        expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(chrome.windows.update).not.toHaveBeenCalled();
      } else {
        expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
        expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
      }
      expect(restoreTargets).toEqual({});
    },
  );

  it('closes the tab before releasing request collection', async () => {
    let tabClosed = false;
    vi.mocked(chrome.tabs.remove).mockImplementation(async () => {
      tabClosed = true;
    });
    vi.mocked(stopRequestCollection).mockImplementation(async () => {
      expect(tabClosed).toBe(true);
    });

    await expect(handleTabClose({ tabId: 9 })).resolves.toEqual({ success: true });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(9);
    expect(stopRequestCollection).toHaveBeenCalledWith(9);
  });

  it('restores recorded focus when post-close cleanup fails', async () => {
    let restoreTargets: Record<string, { tabId: number; windowId: number }> = {
      '9': { tabId: 2, windowId: 1 },
    };
    chrome.storage.session = {
      get: vi.fn().mockImplementation(async () => ({
        agentTabRestoreTargets: restoreTargets,
      })),
      set: vi.fn().mockImplementation(async value => {
        restoreTargets = value.agentTabRestoreTargets;
      }),
    } as any;
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 2, windowId: 1 } as chrome.tabs.Tab);
    vi.mocked(stopRequestCollection).mockRejectedValue(new Error('debugger already detached'));
    vi.mocked(chrome.declarativeNetRequest.updateSessionRules).mockRejectedValue(
      new Error('session rule cleanup failed'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(handleTabClose({ tabId: 9 })).resolves.toEqual({
        success: true,
        restoredTabId: 2,
      });
      expect(chrome.tabs.remove).toHaveBeenCalledWith(9);
      expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
      expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(restoreTargets).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  it('retains a collection marker when DNR cleanup fails so release can retry', async () => {
    const tabId = 991;
    await addCollectingTab(tabId);
    vi.mocked(chrome.declarativeNetRequest.updateSessionRules).mockRejectedValueOnce(
      new Error('session rule cleanup failed'),
    );

    await expect(removeCollectingTab(tabId)).rejects.toThrow('session rule cleanup failed');
    expect(listCollectingMarkerTabIds()).toContain(tabId);

    await expect(removeCollectingTab(tabId)).resolves.toBeUndefined();
    expect(listCollectingMarkerTabIds()).not.toContain(tabId);
  });

  it('navigates back through page_navigate history mode', async () => {
    let navigatedBack = false;
    chrome.tabs.goBack = vi.fn(async () => {
      navigatedBack = true;
    });
    chrome.tabs.onUpdated = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    } as any;
    chrome.tabs.get = vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
      const tab = {
        id: tabId,
        status: 'complete',
        url: navigatedBack ? 'https://example.test/home' : 'https://example.test/login',
        title: navigatedBack ? 'Home' : 'Login',
      } as chrome.tabs.Tab;
      if (callback) {
        callback(tab);
        return undefined;
      }
      return Promise.resolve(tab);
    }) as any;

    await expect(handlePageNavigate({ tabId: 7, history: 'back' }, () => null)).resolves.toEqual({
      tabId: 7,
      url: 'https://example.test/home',
      title: 'Home',
      history: 'back',
    });
    expect(chrome.tabs.goBack).toHaveBeenCalledWith(7);
  });

  it('refreshes only the active container WebView when one is present', async () => {
    vi.mocked(reloadContainerTopFrame).mockResolvedValue({
      frameId: 'sheet',
      url: 'https://example.test/detail?pop=true',
    });
    chrome.tabs.get = vi.fn().mockResolvedValue({
      id: 7,
      status: 'complete',
      url: 'https://example.test/detail?pop=true',
      title: 'Detail',
    } as chrome.tabs.Tab);

    await expect(handlePageNavigate({ tabId: 7, refresh: true }, () => null)).resolves.toEqual({
      tabId: 7,
      url: 'https://example.test/detail?pop=true',
      title: 'Detail',
      refreshed: true,
    });
    expect(reloadContainerTopFrame).toHaveBeenCalledWith(7);
    expect(reloadTabInSession).not.toHaveBeenCalled();
  });

  it('refreshes a regular page inside the shared debugger session', async () => {
    let committedListener: ((details: any) => void) | undefined;
    let tabListener: ((id: number, info: chrome.tabs.TabChangeInfo) => void) | undefined;
    chrome.tabs.get = vi.fn().mockResolvedValue({
      id: 7,
      status: 'complete',
      url: 'https://example.test/home',
      title: 'Home',
    } as chrome.tabs.Tab);
    chrome.tabs.onUpdated = {
      addListener: vi.fn(listener => {
        tabListener = listener;
      }),
      removeListener: vi.fn(),
    } as any;
    chrome.webNavigation.onCommitted.addListener = vi.fn(listener => {
      committedListener = listener;
    });
    vi.mocked(reloadTabInSession).mockImplementation(async () => {
      committedListener?.({ tabId: 7, frameId: 0 });
      tabListener?.(7, { status: 'complete' } as chrome.tabs.TabChangeInfo);
    });

    await expect(handlePageNavigate({ tabId: 7, refresh: true }, () => null)).resolves.toEqual({
      tabId: 7,
      url: 'https://example.test/home',
      title: 'Home',
      refreshed: true,
    });
    expect(reloadContainerTopFrame).toHaveBeenCalledWith(7);
    expect(reloadTabInSession).toHaveBeenCalledWith(7);
  });
});

/**
 * 下发 + reload + 实测校验的共享实现（tab_open 与 set_device_emulation 共用）。
 * 关键约束：重试必须先 clear 再重设——参数不变时重复下发 setDeviceMetricsOverride
 * 是 no-op，不会让已失效的 override 重新生效。
 */
describe('applyEmulationWithReload', () => {
  const config = resolveEmulationConfig({ enabled: true, preset: 'iphone-15-pro' });
  const inEffect = {
    screenWidth: config.width,
    deviceScaleFactor: config.deviceScaleFactor,
    userAgent: config.userAgent,
    maxTouchPoints: 5,
  };
  const desktop = {
    screenWidth: 1512,
    deviceScaleFactor: 2,
    userAgent: 'Desktop',
    maxTouchPoints: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    chrome.tabs = {
      get: vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
        const tab = {
          id: tabId,
          status: 'complete',
          url: 'https://example.test/',
        } as chrome.tabs.Tab;
        if (callback) {
          callback(tab);
          return undefined;
        }
        return Promise.resolve(tab);
      }) as any,
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any;
  });

  it('首轮即生效时直接返回，不做多余的重设', async () => {
    vi.mocked(readEmulationRuntimeState).mockResolvedValue(inEffect);

    await expect(applyEmulationWithReload(1, config, 'https://example.test/')).resolves.toBe(true);

    expect(vi.mocked(enableEmulationForTab)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reapplyEmulationForTab)).not.toHaveBeenCalled();
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledTimes(1);
  });

  /**
   * session 可能被外部断开，override 随之消失，所以每轮都要重新下发再重载。
   * 重设走 reapplyEmulationForTab：clear + set 在同一 session 内完成，避免
   * disable 先清登记导致 release 时 detach，在两步之间多出一个竞态窗口。
   */
  it('首轮丢失时重新下发并重载，第二轮生效即成功', async () => {
    vi.mocked(readEmulationRuntimeState)
      .mockResolvedValueOnce(desktop)
      .mockResolvedValueOnce(inEffect);

    await expect(applyEmulationWithReload(1, config, 'https://example.test/')).resolves.toBe(true);

    expect(vi.mocked(enableEmulationForTab)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reapplyEmulationForTab)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledTimes(2);
  });

  it('读不到模拟态（session 已断）也按未生效处理并继续重试', async () => {
    vi.mocked(readEmulationRuntimeState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(inEffect);

    await expect(applyEmulationWithReload(1, config, 'https://example.test/')).resolves.toBe(true);
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledTimes(2);
  });

  it('reuses the device configuration prepared for the shell and reapplies it if verification fails', async () => {
    vi.mocked(readEmulationRuntimeState)
      .mockResolvedValueOnce(desktop)
      .mockResolvedValueOnce(inEffect);

    await expect(
      applyEmulationWithReload(1, config, 'https://example.test/', {
        devicePrepared: true,
      }),
    ).resolves.toBe(true);

    expect(vi.mocked(enableEmulationForTab)).not.toHaveBeenCalled();
    expect(vi.mocked(reapplyEmulationForTab)).toHaveBeenCalledExactlyOnceWith(1, config);
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledTimes(2);
  });

  /**
   * 每轮都是一次真实重载、用户看得见（页面在非模拟态与模拟态之间闪一下），
   * 所以只给一次兜底，而不是靠多轮重试撞成功率。
   */
  it('用尽轮数仍未生效则返回 false，不谎报成功', async () => {
    vi.mocked(readEmulationRuntimeState).mockResolvedValue(desktop);

    await expect(applyEmulationWithReload(1, config, 'https://example.test/')).resolves.toBe(false);
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledTimes(2);
  });

  /**
   * chrome.tabs.reload() 会间歇性断开 debugger session，override 随之丢失；
   * Page.reload 在 session 内部执行，不会弄掉自己所在的 session。
   */
  it('重载走 session 内的 Page.reload，不用 chrome.tabs.reload', async () => {
    vi.mocked(readEmulationRuntimeState).mockResolvedValue(inEffect);

    await applyEmulationWithReload(1, config, 'https://example.test/');

    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledWith(1);
    expect((chrome.tabs as { reload?: unknown }).reload).toBeUndefined();
  });
});

describe('applySafeAreaInsetsWithReload', () => {
  const insets = { top: 59, right: 0, bottom: 34, left: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    chrome.tabs = {
      get: vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
        const tab = {
          id: tabId,
          status: 'complete',
          url: 'https://example.test/',
        } as chrome.tabs.Tab;
        if (callback) {
          callback(tab);
          return undefined;
        }
        return Promise.resolve(tab);
      }) as any,
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any;
  });

  it('实测 CSS env 生效后成功，且不调用完整设备模拟', async () => {
    vi.mocked(readSafeAreaRuntimeState).mockResolvedValue(insets);

    await expect(applySafeAreaInsetsWithReload(1, insets, 'https://example.test/')).resolves.toBe(
      true,
    );

    expect(vi.mocked(enableSafeAreaInsetsForTab)).toHaveBeenCalledWith(1, insets);
    expect(vi.mocked(reapplySafeAreaInsetsForTab)).not.toHaveBeenCalled();
    expect(vi.mocked(enableEmulationForTab)).not.toHaveBeenCalled();
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledWith(1);
  });

  it('首轮安全区丢失时清后重设并再次重载', async () => {
    vi.mocked(readSafeAreaRuntimeState)
      .mockResolvedValueOnce({ top: 0, right: 0, bottom: 0, left: 0 })
      .mockResolvedValueOnce(insets);

    await expect(applySafeAreaInsetsWithReload(1, insets, 'https://example.test/')).resolves.toBe(
      true,
    );

    expect(vi.mocked(enableSafeAreaInsetsForTab)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reapplySafeAreaInsetsForTab)).toHaveBeenCalledWith(1, insets);
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledTimes(2);
  });

  it('两轮都读不到目标安全区时返回失败', async () => {
    vi.mocked(readSafeAreaRuntimeState).mockResolvedValue(null);

    await expect(applySafeAreaInsetsWithReload(1, insets, 'https://example.test/')).resolves.toBe(
      false,
    );
    expect(vi.mocked(reloadTabInSession)).toHaveBeenCalledTimes(2);
  });
});

/**
 * 顺序保证：监听必须在导航发起之前挂好。chrome.tabs.update / reload 返回时导航可能已经
 * 提交，先导航再挂监听会错过 onCommitted，一直等不到而退到「本次无导航」分支——
 * 等于没等，后续命令作用在即将被丢弃的文档上。
 */
describe('navigateAndWait', () => {
  it('先挂监听再发起导航，因此不会错过 onCommitted', async () => {
    let committedListener: ((details: any) => void) | undefined;
    let tabListener: ((id: number, info: chrome.tabs.TabChangeInfo) => void) | undefined;
    let listenerReadyBeforeNavigate = false;

    chrome.tabs = {
      get: vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
        const tab = {
          id: tabId,
          status: 'complete',
          url: 'https://example.test/',
        } as chrome.tabs.Tab;
        if (callback) {
          callback(tab);
          return undefined;
        }
        return Promise.resolve(tab);
      }) as any,
      onUpdated: {
        addListener: vi.fn((fn: any) => {
          tabListener = fn;
        }),
        removeListener: vi.fn(),
      },
    } as any;
    chrome.webNavigation = {
      onBeforeNavigate: { addListener: vi.fn(), removeListener: vi.fn() },
      onCommitted: {
        addListener: vi.fn((fn: any) => {
          committedListener = fn;
        }),
        removeListener: vi.fn(),
      },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onReferenceFragmentUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any;

    const settled = navigateAndWait(1, 'https://example.test/', async () => {
      // 导航发起时监听必须已经就位；真实环境里这一刻导航就可能已经提交
      listenerReadyBeforeNavigate = Boolean(committedListener && tabListener);
      committedListener?.({ tabId: 1, frameId: 0 });
      tabListener?.(1, { status: 'complete' } as chrome.tabs.TabChangeInfo);
    });

    await expect(settled).resolves.toBe('commit');
    expect(listenerReadyBeforeNavigate).toBe(true);
  });

  it('导航发起失败时把错误抛给调用方', async () => {
    chrome.tabs = {
      get: vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
        const tab = { id: tabId, status: 'loading' } as chrome.tabs.Tab;
        if (callback) {
          callback(tab);
          return undefined;
        }
        return Promise.resolve(tab);
      }) as any,
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any;
    chrome.webNavigation = {
      onBeforeNavigate: { addListener: vi.fn(), removeListener: vi.fn() },
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onReferenceFragmentUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any;

    await expect(
      navigateAndWait(1, 'https://example.test/', () => Promise.reject(new Error('No tab'))),
    ).rejects.toThrow('No tab');
  });
});

/**
 * 导航后的等待。所有调用点都是「刚发起导航/reload」之后，此时 tab.status 往往还是前一个
 * 文档的 complete，若立即据此返回，调用方会拿到即将被丢弃的文档（设备模拟 override
 * 就是这样丢的）。
 */
describe('waitForTabLoad', () => {
  let tabListeners: Array<(id: number, info: chrome.tabs.TabChangeInfo) => void>;
  let navListeners: Record<string, Array<(details: any) => void>>;

  const setupTab = (status: chrome.tabs.Tab['status']) => {
    tabListeners = [];
    navListeners = {
      onBeforeNavigate: [],
      onCommitted: [],
      onHistoryStateUpdated: [],
      onReferenceFragmentUpdated: [],
    };
    chrome.tabs = {
      get: vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
        const tab = { id: tabId, status, url: 'https://example.test/' } as chrome.tabs.Tab;
        if (callback) {
          callback(tab);
          return undefined;
        }
        return Promise.resolve(tab);
      }) as any,
      onUpdated: {
        addListener: vi.fn((fn: any) => tabListeners.push(fn)),
        removeListener: vi.fn((fn: any) => {
          tabListeners = tabListeners.filter(l => l !== fn);
        }),
      },
    } as any;
    chrome.webNavigation = Object.fromEntries(
      Object.keys(navListeners).map(event => [
        event,
        {
          addListener: vi.fn((fn: any) => navListeners[event]!.push(fn)),
          removeListener: vi.fn((fn: any) => {
            navListeners[event] = navListeners[event]!.filter(l => l !== fn);
          }),
        },
      ]),
    ) as any;
  };

  const emitNav = (event: string, tabId: number, frameId = 0) => {
    for (const fn of [...(navListeners[event] ?? [])]) fn({ tabId, frameId });
  };
  const emitTab = (id: number, status: string) => {
    for (const fn of [...tabListeners]) fn(id, { status } as chrome.tabs.TabChangeInfo);
  };
  const isPending = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    return !done;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('新文档提交后才认 complete，不被「上一页仍是 complete」骗到', async () => {
    // 前一个文档仍报 complete —— 单看 status 会误判本次导航已完成
    setupTab('complete');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitNav('onBeforeNavigate', 1);

    expect(await isPending(pending)).toBe(true);

    emitNav('onCommitted', 1);
    emitTab(1, 'complete');
    await expect(pending).resolves.toBe('commit');
  });

  it('提交前到达的 complete 不算本次导航完成', async () => {
    setupTab('complete');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitNav('onBeforeNavigate', 1);
    // 上一个文档的收尾 complete
    emitTab(1, 'complete');

    expect(await isPending(pending)).toBe(true);

    emitNav('onCommitted', 1);
    emitTab(1, 'complete');
    await expect(pending).resolves.toBe('commit');
  });

  it('纯同文档导航（SPA pushState）直接完成，不等新文档 complete', async () => {
    setupTab('complete');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitNav('onHistoryStateUpdated', 1);
    await expect(pending).resolves.toBe('same-document');
  });

  /**
   * reload 是跨文档重载，但 SPA 在重载过程中会调 replaceState 做路由初始化。若把这个
   * 同文档事件当成本次导航结束，调用方会在文档还在重建时继续，后续 CDP 命令打在正在
   * 销毁的上下文上（实测表现为读取模拟态返回 null、设备模拟随机失效）。
   */
  it('跨文档导航进行中，SPA 的 replaceState 不能提前结束等待', async () => {
    setupTab('complete');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitNav('onBeforeNavigate', 1);
    emitNav('onHistoryStateUpdated', 1);

    expect(await isPending(pending)).toBe(true);

    emitNav('onCommitted', 1);
    emitTab(1, 'complete');
    await expect(pending).resolves.toBe('commit');
  });

  it('tabs 先报 loading 时仍接受同文档导航完成信号', async () => {
    setupTab('complete');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitTab(1, 'loading');
    emitNav('onReferenceFragmentUpdated', 1);
    await expect(pending).resolves.toBe('same-document');
  });

  it('hash 变化按同文档导航完成', async () => {
    setupTab('complete');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitNav('onReferenceFragmentUpdated', 1);
    await expect(pending).resolves.toBe('same-document');
  });

  it('本次调用没有产生导航时按当前文档结束，不等到超时', async () => {
    setupTab('complete');
    await expect(waitForTabLoad(1, 'https://example.test/')).resolves.toBe('no-navigation');
  });

  it('宽限期检查时标签页已关闭，立即结束等待并传递错误', async () => {
    setupTab('complete');
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('No tab with id: 1.'));

    await expect(waitForTabLoad(1, 'https://example.test/')).rejects.toThrow('No tab with id: 1.');
  });

  it('导航命令未返回时不提前走「无导航」宽限分支', async () => {
    setupTab('complete');
    let markCommandSettled!: () => void;
    const navigationCommandSettled = new Promise<void>(resolve => {
      markCommandSettled = resolve;
    });
    const pending = waitForTabLoad(1, 'https://example.test/', {
      navigationCommandSettled,
    });

    expect(await isPending(pending)).toBe(true);

    markCommandSettled();
    await expect(pending).resolves.toBe('no-navigation');
  });

  it('导航已开始但尚未提交时，不走「无导航」宽限分支', async () => {
    setupTab('complete');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitTab(1, 'loading');

    expect(await isPending(pending)).toBe(true);

    emitNav('onCommitted', 1);
    emitTab(1, 'complete');
    await expect(pending).resolves.toBe('commit');
  });

  it('只认目标标签页主 frame 的信号', async () => {
    setupTab('loading');
    const pending = waitForTabLoad(1, 'https://example.test/');
    emitNav('onCommitted', 2);
    emitNav('onCommitted', 1, 3);
    emitTab(2, 'complete');
    emitTab(1, 'complete');

    expect(await isPending(pending)).toBe(true);

    emitNav('onCommitted', 1);
    emitTab(1, 'complete');
    await expect(pending).resolves.toBe('commit');
  });

  it('结束后摘掉全部监听', async () => {
    setupTab('complete');
    await waitForTabLoad(1, 'https://example.test/');

    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalled();
    expect(chrome.webNavigation.onBeforeNavigate.removeListener).toHaveBeenCalled();
    expect(chrome.webNavigation.onCommitted.removeListener).toHaveBeenCalled();
    expect(chrome.webNavigation.onHistoryStateUpdated.removeListener).toHaveBeenCalled();
    expect(chrome.webNavigation.onReferenceFragmentUpdated.removeListener).toHaveBeenCalled();
    expect(tabListeners).toHaveLength(0);
  });
});

describe('tab_open 首次导航前应用模拟', () => {
  const setupOpen = () => {
    chrome.tabs = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({
        id: 91,
        windowId: 3,
        status: 'complete',
      } as chrome.tabs.Tab),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any;
    chrome.windows = { update: vi.fn().mockResolvedValue(undefined) } as any;
    chrome.declarativeNetRequest = {
      updateSessionRules: vi.fn().mockResolvedValue(undefined),
    } as any;
    chrome.tabs.get = vi.fn((tabId: number, callback?: (tab: chrome.tabs.Tab) => void) => {
      const tab = {
        id: tabId,
        windowId: 3,
        status: 'complete',
        url: 'https://example.test/target',
        title: 'Target',
      } as chrome.tabs.Tab;
      if (callback) {
        callback(tab);
        return undefined;
      }
      return Promise.resolve(tab);
    }) as any;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(navigateTabInSession).mockResolvedValue(undefined);
  });

  it('带 emulation 时先建 about:blank、下发 override，再在 session 内导航', async () => {
    setupOpen();
    const config = resolveEmulationConfig({ enabled: true, preset: 'iphone-15-pro' });
    vi.mocked(readEmulationRuntimeState).mockResolvedValue({
      screenWidth: config.width,
      deviceScaleFactor: config.deviceScaleFactor,
      userAgent: config.userAgent,
      maxTouchPoints: 5,
    });

    await handleTabOpen({
      url: 'https://example.test/target',
      emulation: { preset: 'iphone-15-pro' },
    } as never);

    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'about:blank' }),
    );
    expect(vi.mocked(enableEmulationForTab).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(navigateTabInSession).mock.invocationCallOrder[0]!,
    );
    expect(navigateTabInSession).toHaveBeenCalledWith(91, 'https://example.test/target');
  });

  it('带 appProfile 时只注入 App 环境，不隐式启用设备模拟', async () => {
    setupOpen();
    const profile = resolveAppProfile('reader');
    vi.mocked(readEmulationRuntimeState).mockResolvedValue({
      screenWidth: 402,
      deviceScaleFactor: 3,
      userAgent: profile.ua,
      maxTouchPoints: 5,
    });

    const result = await handleTabOpen({
      url: 'https://example.test/target',
      appProfile: 'reader',
    } as never);

    expect(enableAppProfileDocumentBootstrapForTab).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        profile: 'reader',
        simulateSystemBars: false,
        rootContainer: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(enableEmulationForTab).not.toHaveBeenCalled();
    expect(result.emulation).toBeUndefined();
    expect(result.appProfile?.userAgent).toContain('Sample/');
  });

  it('tab_open 的 App 注入与显式设备预设相互独立', async () => {
    setupOpen();
    const profile = resolveAppProfile('reader', { devicePreset: 'iphone-17e' });
    const config = resolveEmulationConfig({ enabled: true, preset: 'iphone-17e' });
    vi.mocked(readEmulationRuntimeState).mockResolvedValue({
      screenWidth: config.width,
      deviceScaleFactor: config.deviceScaleFactor,
      userAgent: profile.ua,
      maxTouchPoints: 5,
    });

    const result = await handleTabOpen({
      url: 'https://example.test/target',
      appProfile: 'reader',
      emulation: { preset: 'iphone-17e' },
    } as never);

    expect(enableAppProfileDocumentBootstrapForTab).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        simulateSystemBars: false,
        rootContainer: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(result.emulation?.preset).toBe('iphone-17e');
    expect(result.emulation?.deviceShell).toBe(false);
    expect(applyDeviceShellForTab).not.toHaveBeenCalled();
  });

  it('tab_open 可在横屏 App 设备外壳中首屏启用分屏', async () => {
    setupOpen();
    const profile = resolveAppProfile('reader', {
      devicePreset: 'ipad-mini-a17-pro',
      orientation: 'landscape',
    });
    const config = resolveEmulationConfig({
      enabled: true,
      preset: 'ipad-mini-a17-pro',
      orientation: 'landscape',
    });
    vi.mocked(readEmulationRuntimeState).mockResolvedValue({
      screenWidth: config.width,
      deviceScaleFactor: config.deviceScaleFactor,
      userAgent: profile.ua,
      maxTouchPoints: 5,
    });

    const result = await handleTabOpen({
      url: 'https://example.test/target',
      appProfile: 'reader',
      emulation: {
        preset: 'ipad-mini-a17-pro',
        orientation: 'landscape',
        deviceShell: true,
        splitScreen: true,
      },
    });

    expect(applyDeviceShellForTab).toHaveBeenCalledWith(91, expect.anything(), config, {
      splitScreen: true,
    });
    expect(prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(
      91,
      config,
      expect.anything(),
      { splitScreen: true },
    );
    expect(result.emulation).toMatchObject({
      orientation: 'landscape',
      deviceShell: true,
      splitScreen: true,
    });
  });

  it('tab_open 可直接注入 Android App 环境且不隐式创建设备模拟', async () => {
    setupOpen();
    const profile = resolveAppProfile('reader', { os: 'android' });
    const config = resolveEmulationConfig({ enabled: true, preset: profile.recommendedPreset });
    vi.mocked(readEmulationRuntimeState).mockResolvedValue({
      screenWidth: config.width,
      deviceScaleFactor: config.deviceScaleFactor,
      userAgent: profile.ua,
      maxTouchPoints: 5,
    });

    const result = await handleTabOpen({
      url: 'https://example.test/target',
      appProfile: 'reader',
      os: 'android',
    });

    expect(result.emulation).toBeUndefined();
    expect(result.appProfile).toMatchObject({ os: 'android' });
    expect(result.appProfile?.userAgent).toContain('Sample/10.0.9 Pixel 11');
    expect(result.appProfile?.userAgent).toContain('Pixel 11');
  });

  /**
   * 普通路径必须保持「先 attach 再导航」，否则首屏请求会漏采。
   */
  it('无模拟需求时仍走 about:blank，先 armed 采集再导航', async () => {
    setupOpen();

    await handleTabOpen({ url: 'https://example.test/target' } as never);

    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'about:blank' }),
    );
    expect(vi.mocked(startRequestCollection).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(navigateTabInSession).mock.invocationCallOrder[0]!,
    );
  });

  it('采集基线取在最终那次加载之后', async () => {
    setupOpen();
    const config = resolveEmulationConfig({ enabled: true, preset: 'iphone-15-pro' });
    vi.mocked(readEmulationRuntimeState).mockResolvedValue({
      screenWidth: config.width,
      deviceScaleFactor: config.deviceScaleFactor,
      userAgent: config.userAgent,
      maxTouchPoints: 5,
    });

    await handleTabOpen({
      url: 'https://example.test/target',
      emulation: { preset: 'iphone-15-pro' },
    } as never);

    expect(vi.mocked(getCaptureCheckpoint).mock.invocationCallOrder[0]!).toBeGreaterThan(
      vi.mocked(navigateTabInSession).mock.invocationCallOrder[0]!,
    );
  });

  it('模拟态校验失败时关闭 tab 并回滚规则', async () => {
    setupOpen();
    vi.mocked(readEmulationRuntimeState).mockResolvedValue(null);

    await expect(
      handleTabOpen({
        url: 'https://example.test/target',
        appProfile: 'reader',
        emulation: { preset: 'iphone-17-pro' },
      } as never),
    ).rejects.toThrow('could not establish the requested emulation state');

    expect(chrome.tabs.remove).toHaveBeenCalledWith(91);
    expect(stopRequestCollection).toHaveBeenCalledWith(91);
  });
});
