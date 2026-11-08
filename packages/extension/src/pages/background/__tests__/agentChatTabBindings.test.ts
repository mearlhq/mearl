import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../backgroundRequestCollector', () => ({
  startRequestCollection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../agentHandlers/controlledTabs', () => ({
  markTabControlled: vi.fn().mockResolvedValue(undefined),
}));

import { startRequestCollection } from '../backgroundRequestCollector';
import {
  bindAgentChatTabFromSource,
  detachAgentChatTab,
  getAgentChatTabBindings,
  installAgentChatTabBindingObservers,
  registerAgentChatTab,
  removeAgentChatTab,
} from '../agentChatTabBindings';

describe('Agent Chat related-tab bindings', () => {
  let stored: Record<string, unknown>;
  let createdTab: ((tab: chrome.tabs.Tab) => void) | undefined;
  let removedTab: ((tabId: number) => void) | undefined;
  let createdNavigationTarget:
    | ((details: chrome.webNavigation.WebNavigationSourceCallbackDetails) => void)
    | undefined;
  const onConversationEmpty = vi.fn();

  beforeAll(() => {
    chrome.tabs = {
      onCreated: {
        addListener: vi.fn(listener => {
          createdTab = listener;
        }),
        removeListener: vi.fn(),
      },
      onRemoved: {
        addListener: vi.fn(listener => {
          removedTab = listener;
        }),
        removeListener: vi.fn(),
      },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as any;
    chrome.webNavigation = {
      onCreatedNavigationTarget: {
        addListener: vi.fn(listener => {
          createdNavigationTarget = listener;
        }),
        removeListener: vi.fn(),
      },
    } as any;
    chrome.declarativeNetRequest = {
      updateSessionRules: vi.fn().mockResolvedValue(undefined),
    } as any;
    chrome.scripting = {
      executeScript: vi.fn().mockResolvedValue([]),
    } as any;
    chrome.storage.session = {
      get: vi.fn(async () => ({ ...stored })),
      set: vi.fn(async value => {
        stored = { ...stored, ...value };
      }),
    } as any;
    installAgentChatTabBindingObservers(onConversationEmpty);
  });

  beforeEach(() => {
    stored = {};
    vi.clearAllMocks();
    vi.mocked(chrome.declarativeNetRequest.updateSessionRules).mockResolvedValue(undefined);
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue(undefined);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  });

  it('inherits the source conversation and keeps conflicting conversations isolated', async () => {
    await registerAgentChatTab(11, 11, 'session-11');
    await expect(bindAgentChatTabFromSource(11, 22)).resolves.toEqual({
      ownerTabId: 11,
      sessionId: 'session-11',
    });

    await registerAgentChatTab(33, 33, 'session-33');
    await expect(bindAgentChatTabFromSource(11, 33)).resolves.toBeNull();

    await expect(getAgentChatTabBindings()).resolves.toEqual({
      bindings: {
        '11': { ownerTabId: 11, sessionId: 'session-11' },
        '22': { ownerTabId: 11, sessionId: 'session-11' },
        '33': { ownerTabId: 33, sessionId: 'session-33' },
      },
    });
  });

  it('does not let stale sidepanel state steal a tab from another conversation', async () => {
    await registerAgentChatTab(11, 11, 'session-11');
    await bindAgentChatTabFromSource(11, 22);

    await expect(registerAgentChatTab(22, 22, 'session-22')).resolves.toEqual({
      bindings: {
        '11': { ownerTabId: 11, sessionId: 'session-11' },
        '22': { ownerTabId: 11, sessionId: 'session-11' },
      },
      conflict: { ownerTabId: 11, sessionId: 'session-11' },
    });

    await expect(registerAgentChatTab(22, 33, 'session-22')).resolves.toEqual({
      bindings: {
        '11': { ownerTabId: 11, sessionId: 'session-11' },
        '22': { ownerTabId: 11, sessionId: 'session-11' },
      },
      conflict: { ownerTabId: 11, sessionId: 'session-11' },
    });
  });

  it('updates every related tab when the owner starts a replacement session', async () => {
    await registerAgentChatTab(11, 11, 'session-11');
    await bindAgentChatTabFromSource(11, 22);

    await expect(registerAgentChatTab(11, 22, 'session-new')).resolves.toEqual({
      bindings: {
        '11': { ownerTabId: 11, sessionId: 'session-new' },
        '22': { ownerTabId: 11, sessionId: 'session-new' },
      },
    });
  });

  it('binds page-created navigation targets through their explicit source tab', async () => {
    await registerAgentChatTab(11, 11, 'session-11');

    createdNavigationTarget?.({
      sourceTabId: 11,
      sourceFrameId: 0,
      sourceProcessId: 1,
      tabId: 44,
      url: 'https://example.test/child',
      timeStamp: 1,
    });

    await vi.waitFor(async () => {
      await expect(getAgentChatTabBindings()).resolves.toEqual({
        bindings: {
          '11': { ownerTabId: 11, sessionId: 'session-11' },
          '44': { ownerTabId: 11, sessionId: 'session-11' },
        },
      });
    });
    expect(startRequestCollection).toHaveBeenCalledWith(44);
  });

  it('ignores browser-created opener tabs and inherits only navigation targets', async () => {
    await registerAgentChatTab(11, 11, 'session-11');

    createdTab?.({ id: 44, openerTabId: 11 } as chrome.tabs.Tab);
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(getAgentChatTabBindings()).resolves.toEqual({
      bindings: {
        '11': { ownerTabId: 11, sessionId: 'session-11' },
      },
    });

    createdNavigationTarget?.({
      sourceTabId: 11,
      sourceFrameId: 0,
      sourceProcessId: 1,
      tabId: 44,
      url: 'https://example.test/child',
      timeStamp: 1,
    });

    await vi.waitFor(() => {
      expect(startRequestCollection).toHaveBeenCalledTimes(1);
    });
  });

  it('detaches only the selected related tab from its conversation', async () => {
    await registerAgentChatTab(11, 11, 'session-11');
    await bindAgentChatTabFromSource(11, 22);

    await expect(detachAgentChatTab(22)).resolves.toEqual({
      bindings: {
        '11': { ownerTabId: 11, sessionId: 'session-11' },
      },
      detached: {
        tabId: 22,
        ownerTabId: 11,
        sessionId: 'session-11',
        remainingTabIds: [11],
      },
    });
    expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { tabId: 22, allFrames: true },
        args: [false],
      }),
    );
  });

  it('reassigns the conversation owner when its original tab detaches', async () => {
    await registerAgentChatTab(11, 11, 'session-11');
    await bindAgentChatTabFromSource(11, 22);
    await bindAgentChatTabFromSource(11, 33);

    await expect(detachAgentChatTab(11)).resolves.toEqual({
      bindings: {
        '22': { ownerTabId: 22, sessionId: 'session-11' },
        '33': { ownerTabId: 22, sessionId: 'session-11' },
      },
      detached: {
        tabId: 11,
        ownerTabId: 11,
        sessionId: 'session-11',
        remainingTabIds: [22, 33],
        newOwnerTabId: 22,
      },
    });
  });

  it('keeps the conversation until its last related tab is removed', async () => {
    await registerAgentChatTab(11, 11, 'session-11');
    await bindAgentChatTabFromSource(11, 22);

    await expect(removeAgentChatTab(11)).resolves.toEqual({
      tabId: 11,
      ownerTabId: 11,
      sessionId: 'session-11',
      remainingTabIds: [22],
      newOwnerTabId: 22,
    });
    await expect(removeAgentChatTab(22)).resolves.toEqual({
      tabId: 22,
      ownerTabId: 22,
      sessionId: 'session-11',
      remainingTabIds: [],
    });
  });

  it('notifies the owner only after its last related tab is removed', async () => {
    await registerAgentChatTab(11, 11, 'session-11');
    await bindAgentChatTabFromSource(11, 22);

    removedTab?.(11);
    await vi.waitFor(async () => {
      await expect(getAgentChatTabBindings()).resolves.toEqual({
        bindings: {
          '22': { ownerTabId: 22, sessionId: 'session-11' },
        },
      });
    });
    expect(onConversationEmpty).not.toHaveBeenCalled();

    removedTab?.(22);
    await vi.waitFor(() => {
      expect(onConversationEmpty).toHaveBeenCalledOnce();
    });
    expect(onConversationEmpty).toHaveBeenCalledWith({
      tabId: 22,
      ownerTabId: 22,
      sessionId: 'session-11',
      remainingTabIds: [],
    });
  });
});
