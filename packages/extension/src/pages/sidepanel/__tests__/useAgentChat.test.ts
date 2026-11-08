import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AgentChatEvent, AgentChatProviderDescriptor } from '@mearl/browser-core';
import { chatMessages } from './chatTestHelpers';
import { useAgentChat } from '../useAgentChat';

vi.mock('../../panel/utils/i18n', () => ({
  t: (key: string, substitution?: string) =>
    key === 'agentChatStartingProvider' ? `Creating ${substitution} conversation…` : key,
}));

const provider: AgentChatProviderDescriptor = {
  id: 'codex',
  name: 'Codex',
  available: true,
  capabilities: {
    streaming: true,
    resume: true,
    listSessions: true,
    refreshHistory: true,
    imageInput: true,
    interrupt: true,
    requests: true,
  },
};

const qoderProvider: AgentChatProviderDescriptor = {
  ...provider,
  id: 'qoder',
  name: 'Qoder',
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function userEvent(id: string, sessionId: string, text: string): AgentChatEvent {
  return {
    id,
    sessionId,
    providerId: 'codex',
    kind: 'lifecycle',
    method: 'chat/userMessage',
    params: { text },
    timestamp: 1,
  };
}

describe('useAgentChat tab binding', () => {
  let activeTabId: number;
  let activatedListener: ((info: chrome.tabs.TabActiveInfo) => void) | undefined;
  let runtimeMessageListener: ((message: any) => void) | undefined;

  beforeEach(() => {
    activeTabId = 11;
    activatedListener = undefined;
    runtimeMessageListener = undefined;

    chrome.tabs = {
      query: vi.fn(async query =>
        query?.active
          ? [{ id: activeTabId, windowId: 1 }]
          : [
              { id: 11, windowId: 1 },
              { id: 22, windowId: 1 },
              { id: 33, windowId: 1 },
            ],
      ),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        windowId: 1,
        url: `https://example.com/tabs/${tabId}`,
        title: `Tab ${tabId}`,
      })),
      onActivated: {
        addListener: vi.fn(listener => {
          activatedListener = listener;
        }),
        removeListener: vi.fn(),
      },
      onRemoved: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    } as any;
    chrome.windows = {
      WINDOW_ID_NONE: -1,
      onFocusChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    } as any;
    (chrome.storage.local.get as unknown as Mock).mockReset();
    (chrome.storage.local.set as unknown as Mock).mockReset().mockResolvedValue(undefined);
    (chrome.storage.local.remove as unknown as Mock).mockReset().mockResolvedValue(undefined);
    (chrome.runtime.sendMessage as unknown as Mock).mockReset();
    (chrome.runtime as any).getManifest = vi.fn(() => ({ version: '1.40.0' }));
    vi.mocked(chrome.runtime.onMessage.addListener).mockReset();
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(listener => {
      runtimeMessageListener = listener as (message: any) => void;
    });
  });

  it('continues when Native Host and extension versions differ but agent chat is supported', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: {
              connected: true,
              nativeHostVersion: '1.39.2',
              extensionVersion: '1.40.0',
            },
          };
        }
        return { success: true };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(result.current.nativeHostUpdate).toBeNull();
    expect(result.current.providers).toEqual([provider]);
    expect(result.current.error).toBeNull();
  });

  it('requires a Native Host update when agent chat is unsupported', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return {
            success: false,
            code: 'PROTOCOL_MISMATCH',
            error: 'Update required',
          };
        }
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: {
              connected: true,
              nativeHostVersion: '1.40.0',
              extensionVersion: '1.40.0',
            },
          };
        }
        return { success: true };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(result.current.nativeHostUpdate).toEqual({
      extensionVersion: '1.40.0',
      nativeHostVersion: '1.40.0',
      reason: 'unsupported-capability',
    });
    expect(result.current.error).toBeNull();
  });

  it('shows a Native Host install guide when the host is not connected', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return {
            success: false,
            error: 'Native host is not connected',
          };
        }
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: {
              connected: false,
              nativeHostVersion: null,
              extensionVersion: '1.40.0',
            },
          };
        }
        return { success: true };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(result.current.nativeHostUpdate).toEqual({
      extensionVersion: '1.40.0',
      nativeHostVersion: null,
      reason: 'not-connected',
    });
    expect(result.current.error).toBeNull();
  });

  it('keeps the update guide available when reconnecting fails', async () => {
    let agentChatSupported = false;
    let reconnectSucceeds = false;
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return agentChatSupported
            ? { success: true, data: { providers: [provider], sessions: [] } }
            : { success: false, code: 'PROTOCOL_MISMATCH', error: 'Update required' };
        }
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: {
              connected: true,
              nativeHostVersion: '1.40.0',
              extensionVersion: '1.40.0',
            },
          };
        }
        if (message.action === 'resetAgentBridge') {
          return reconnectSucceeds
            ? { success: true }
            : { success: false, error: 'Native Host reconnect failed' };
        }
        return { success: true };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => result.current.retryNativeHost());

    expect(result.current.initializing).toBe(false);
    expect(result.current.nativeHostUpdate).toEqual({
      extensionVersion: '1.40.0',
      nativeHostVersion: '1.40.0',
      reason: 'unsupported-capability',
    });
    expect(result.current.error).toBe('Native Host reconnect failed');

    reconnectSucceeds = true;
    agentChatSupported = true;
    await act(async () => result.current.retryNativeHost());
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(result.current.nativeHostUpdate).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.providers).toEqual([provider]);
  });

  it('shows the conversation bound to the newly activated tab', async () => {
    const tab11Event = userEvent('tab11', 'saved_11', 'tab 11');
    const tab22Event = userEvent('tab22', 'saved_22', 'tab 22');
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      agentChatSidepanelStateV2: {
        version: 2,
        chats: {
          '11': {
            providerId: 'codex',
            events: [tab11Event],
            conversationEvents: [tab11Event],
          },
          '22': {
            providerId: 'codex',
            events: [tab22Event],
            conversationEvents: [tab22Event],
          },
        },
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({
      success: true,
      data: { providers: [provider], sessions: [] },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.activeTabId).toBe(11);
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: 'tab 11' },
    ]);

    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));
    expect(result.current.activeTabId).toBe(22);
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: 'tab 22' },
    ]);

    act(() => activatedListener?.({ tabId: 33, windowId: 1 }));
    expect(result.current.activeTabId).toBe(33);
    expect(result.current.conversationEvents).toEqual([]);

    act(() => activatedListener?.({ tabId: 44, windowId: 2 }));
    expect(result.current.activeTabId).toBe(33);
  });

  it.each([provider, qoderProvider])('keeps one $name conversation across related tabs and sends the active tab context', async activeProvider => {
    const providerId = activeProvider.id;
    const savedUserEvent = { ...userEvent('tab11', 'session_11', '检查主页面'), providerId };
    const bindings = {
      '11': { ownerTabId: 11, sessionId: 'session_11' },
      '22': { ownerTabId: 11, sessionId: 'session_11' },
    };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV3:11': {
        providerId,
        providerSessionId: 'thread_11',
        events: [savedUserEvent],
        conversationEvents: [savedUserEvent],
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: { nativeHostVersion: '1.40.0', extensionVersion: '1.40.0' },
          };
        }
        if (message.action === 'getAgentChatTabBindings') {
          return { success: true, data: { bindings } };
        }
        if (message.action === 'registerAgentChatTab') {
          return { success: true, data: { bindings } };
        }
        if (message.action === 'agent_chat_status') {
          return {
            success: true,
            data: {
              providers: [activeProvider],
              sessions: [
                {
                  id: 'session_11',
                  providerId,
                  providerSessionId: 'thread_11',
                  status: 'idle',
                  tabId: 11,
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return { success: true, data: { events: [savedUserEvent] } };
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_22' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));
    expect(result.current.activeTabId).toBe(22);
    expect(result.current.conversationTabId).toBe(11);
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '检查主页面' },
    ]);

    await act(async () => result.current.send('继续检查当前页'));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_send',
      data: expect.objectContaining({
        sessionId: 'session_11',
        message: expect.stringContaining(
          '<current_browser_tab_context>\n{"tabId":22,"url":"https://example.com/tabs/22","title":"Tab 22"}',
        ),
        displayMessage: '继续检查当前页',
        ...(providerId === 'qoder' ? { hasAdditionalContext: true } : {}),
      }),
    });
    if (providerId === 'qoder') {
      expect(result.current.conversationEvents.findLast(event => event.method === 'chat/userMessage')?.params)
        .toMatchObject({ hasAdditionalContext: true });
    }

    act(() => {
      runtimeMessageListener?.({
        action: 'agentChatTabBindingsChanged',
        data: {
          bindings: {},
          removed: {
            tabId: 22,
            ownerTabId: 11,
            sessionId: 'session_11',
            remainingTabIds: [],
          },
        },
      });
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
      action: 'agent_chat_close',
      data: { sessionId: 'session_11' },
    });
  });

  it.each(['codex', 'qoder'])('adopts a %s session bound by another chat surface', async providerId => {
    const nextSession = {
      id: 'session_next',
      providerId,
      providerSessionId: 'thread_next',
      status: 'idle',
      tabId: 11,
    };
    let bindings: Record<string, { ownerTabId: number; sessionId: string }> = {};
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV4:11': {
        version: 1,
        activeProviderId: 'codex',
        chats: Object.fromEntries(['codex', 'qoder'].map(id => [id, {
          providerId: id,
          providerSessionId: 'thread_previous',
          events: [{ ...userEvent('old', 'session_previous', 'previous chat'), providerId: id }],
        }])),
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(async message => {
      switch (message.action) {
        case 'agent_chat_status':
          return {
            success: true,
            data: { providers: [provider, qoderProvider], sessions: bindings['11'] ? [nextSession] : [] },
          };
        case 'getAgentChatTabBindings':
        case 'registerAgentChatTab':
          return { success: true, data: { bindings } };
        case 'agent_chat_events':
          return {
            success: true,
            data: { events: [{ ...userEvent('new', nextSession.id, 'new chat'), providerId }] },
          };
        default:
          return { success: true };
      }
    });
    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    bindings = { '11': { ownerTabId: 11, sessionId: nextSession.id } };
    act(() => runtimeMessageListener?.({ action: 'agentChatTabBindingsChanged', data: { bindings } }));

    await waitFor(() => expect(result.current.session?.id).toBe(nextSession.id));
    expect(chatMessages(result.current.conversationEvents)).toEqual([{ role: 'user', message: 'new chat' }]);
  });

  it('starts fresh only in the active tab and keeps the sibling conversation', async () => {
    const savedUserEvent = userEvent('tab11', 'session_11', '保留原会话');
    let bindings: Record<string, { ownerTabId: number; sessionId: string }> = {
      '11': { ownerTabId: 11, sessionId: 'session_11' },
      '22': { ownerTabId: 11, sessionId: 'session_11' },
    };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV3:11': {
        providerId: 'codex',
        providerSessionId: 'thread_11',
        events: [savedUserEvent],
        conversationEvents: [savedUserEvent],
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: { nativeHostVersion: '1.40.0', extensionVersion: '1.40.0' },
          };
        }
        if (message.action === 'getAgentChatTabBindings') {
          return { success: true, data: { bindings } };
        }
        if (message.action === 'agent_chat_status') {
          return {
            success: true,
            data: {
              providers: [provider],
              sessions: [
                {
                  id: 'session_11',
                  providerId: 'codex',
                  providerSessionId: 'thread_11',
                  status: 'running',
                  tabId: 11,
                  activeTurnId: 'turn_11',
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return { success: true, data: { events: [savedUserEvent] } };
        }
        if (message.action === 'detachAgentChatTab') {
          bindings = {
            '22': { ownerTabId: 22, sessionId: 'session_11' },
          };
          const detached = {
            tabId: 11,
            ownerTabId: 11,
            sessionId: 'session_11',
            remainingTabIds: [22],
            newOwnerTabId: 22,
          };
          return {
            success: true,
            data: {
              bindings,
              detached,
            },
          };
        }
        if (message.action === 'agent_chat_start') {
          return {
            success: true,
            data: {
              id: 'session_new',
              providerId: 'codex',
              providerSessionId: 'thread_new',
              status: 'idle',
              tabId: 11,
            },
          };
        }
        if (message.action === 'registerAgentChatTab') {
          bindings = {
            '11': { ownerTabId: 11, sessionId: 'session_new' },
            '22': { ownerTabId: 22, sessionId: 'session_11' },
          };
          return { success: true, data: { bindings } };
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_new' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => result.current.newChat());

    expect(result.current.activeTabId).toBe(11);
    expect(result.current.conversationTabId).toBe(11);
    expect(result.current.conversationEvents).toEqual([]);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
      action: 'agent_chat_close',
      data: { sessionId: 'session_11' },
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
      action: 'agent_chat_interrupt',
      data: { sessionId: 'session_11' },
    });

    await act(async () => result.current.send('开始独立会话'));
    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));

    expect(result.current.conversationTabId).toBe(22);
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '保留原会话' },
    ]);
    expect(bindings).toEqual({
      '11': { ownerTabId: 11, sessionId: 'session_new' },
      '22': { ownerTabId: 22, sessionId: 'session_11' },
    });
  });

  it('closes a cold-started session instead of stealing an authoritative tab binding', async () => {
    activeTabId = 22;
    const authoritativeBindings = {
      '11': { ownerTabId: 11, sessionId: 'session_11' },
      '22': { ownerTabId: 11, sessionId: 'session_11' },
    };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: { nativeHostVersion: '1.40.0', extensionVersion: '1.40.0' },
          };
        }
        if (message.action === 'getAgentChatTabBindings') {
          return { success: true, data: { bindings: {} } };
        }
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_start') {
          return {
            success: true,
            data: {
              id: 'session_22',
              providerId: 'codex',
              providerSessionId: 'thread_22',
              status: 'idle',
              tabId: 22,
            },
          };
        }
        if (message.action === 'registerAgentChatTab') {
          return {
            success: true,
            data: {
              bindings: authoritativeBindings,
              conflict: authoritativeBindings['22'],
            },
          };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => result.current.send('继续主对话'));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_close',
      data: { sessionId: 'session_22' },
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_chat_send' }),
    );
    expect(result.current.conversationTabId).toBe(11);
    expect(result.current.conversationEvents).toEqual([]);
    expect(result.current.error).toBe('agentChatTabBindingChanged');
  });

  it('restores the owner conversation when a new-window binding arrives after initialization', async () => {
    activeTabId = 22;
    vi.mocked(chrome.tabs.query).mockImplementation(async query =>
      query?.active
        ? ([{ id: 22, windowId: 1 }] as chrome.tabs.Tab[])
        : ([
            { id: 11, windowId: 2 },
            { id: 22, windowId: 1 },
          ] as chrome.tabs.Tab[]),
    );
    const savedUserEvent = userEvent('tab11', 'session_11', '主窗口对话');
    let bindings: Record<string, { ownerTabId: number; sessionId: string }> = {};
    (chrome.storage.local.get as unknown as Mock).mockImplementation(async keys =>
      keys === null
        ? {
            'agentChatSidepanelTabStateV3:11': {
              providerId: 'codex',
              providerSessionId: 'thread_11',
              events: [savedUserEvent],
              conversationEvents: [savedUserEvent],
            },
          }
        : {},
    );
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: { nativeHostVersion: '1.40.0', extensionVersion: '1.40.0' },
          };
        }
        if (message.action === 'getAgentChatTabBindings') {
          return { success: true, data: { bindings } };
        }
        if (message.action === 'registerAgentChatTab') {
          return { success: true, data: { bindings } };
        }
        if (message.action === 'agent_chat_status') {
          return {
            success: true,
            data: {
              providers: [provider],
              sessions: [
                {
                  id: 'session_11',
                  providerId: 'codex',
                  providerSessionId: 'thread_11',
                  status: 'idle',
                  tabId: 11,
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return { success: true, data: { events: [savedUserEvent] } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.conversationTabId).toBe(22);
    expect(result.current.conversationEvents).toEqual([]);

    bindings = {
      '11': { ownerTabId: 11, sessionId: 'session_11' },
      '22': { ownerTabId: 11, sessionId: 'session_11' },
    };
    act(() => {
      runtimeMessageListener?.({
        action: 'agentChatTabBindingsChanged',
        data: { bindings },
      });
    });

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.conversationTabId).toBe(11);
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '主窗口对话' },
    ]);
  });

  it('restores the last-used provider for tabs without a conversation', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      agentChatSidepanelLastUsedProviderV1: 'qoder',
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({
      success: true,
      data: { providers: [provider, qoderProvider], sessions: [] },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(result.current.providerId).toBe('qoder');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_prepare',
      data: { providerId: 'qoder' },
    });
    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));
    expect(result.current.providerId).toBe('qoder');
  });

  it('starts warming the persisted provider before status restoration finishes', async () => {
    const status = deferred<{
      success: boolean;
      data: { providers: AgentChatProviderDescriptor[]; sessions: never[] };
    }>();
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      agentChatSidepanelLastUsedProviderV1: 'qoder',
    });
    const sendMessage = chrome.runtime.sendMessage as unknown as Mock;
    sendMessage.mockImplementation(async (message: { action?: string }) => {
      if (message.action === 'agent_chat_status') return status.promise;
      if (message.action === 'getAgentStatus') {
        return {
          success: true,
          status: {
            connected: true,
            nativeHostVersion: '1.40.0',
            extensionVersion: '1.40.0',
          },
        };
      }
      return { success: true };
    });

    const { result } = renderHook(() => useAgentChat(1));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        action: 'agent_chat_prepare',
        data: { providerId: 'qoder' },
      }),
    );
    expect(result.current.initializing).toBe(true);

    await act(async () => {
      status.resolve({
        success: true,
        data: { providers: [provider, qoderProvider], sessions: [] },
      });
      await status.promise;
    });
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(
      sendMessage.mock.calls.filter(
        ([message]) =>
          message.action === 'agent_chat_prepare' && message.data?.providerId === 'qoder',
      ),
    ).toHaveLength(1);
  });

  it('warms the provider selected by the active tab', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV3:11': { providerId: 'codex' },
      'agentChatSidepanelTabStateV3:22': { providerId: 'qoder' },
    });
    const sendMessage = chrome.runtime.sendMessage as unknown as Mock;
    sendMessage.mockResolvedValue({
      success: true,
      data: { providers: [provider, qoderProvider], sessions: [] },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_prepare',
      data: { providerId: 'codex' },
    });

    sendMessage.mockClear();
    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));

    expect(result.current.providerId).toBe('qoder');
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_prepare',
      data: { providerId: 'qoder' },
    });
  });

  it('does not warm an unavailable provider', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    const sendMessage = chrome.runtime.sendMessage as unknown as Mock;
    sendMessage.mockResolvedValue({
      success: true,
      data: {
        providers: [provider, { ...qoderProvider, available: false }],
        sessions: [],
      },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    sendMessage.mockClear();
    act(() => result.current.setProviderId('qoder'));

    expect(result.current.providerId).toBe('qoder');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('starts a separate agent conversation and restores the previous one when switching back', async () => {
    const savedEvent = userEvent('codex_message', 'codex_session', '保留 Codex 会话');
    let bindings = {
      '11': { ownerTabId: 11, sessionId: 'codex_session' },
    };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV4:11': {
        version: 1,
        activeProviderId: 'codex',
        chats: {
          codex: {
            providerId: 'codex',
            providerSessionId: 'codex_thread',
            events: [savedEvent],
            conversationEvents: [savedEvent],
          },
        },
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string; data?: { sessionId?: string } }) => {
        if (message.action === 'getAgentChatTabBindings') {
          return { success: true, data: { bindings } };
        }
        if (message.action === 'agent_chat_status') {
          return {
            success: true,
            data: {
              providers: [provider, qoderProvider],
              sessions: [
                {
                  id: 'codex_session',
                  providerId: 'codex',
                  providerSessionId: 'codex_thread',
                  status: 'idle',
                  tabId: 11,
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return { success: true, data: { events: [savedEvent] } };
        }
        if (message.action === 'registerAgentChatTab') {
          bindings = { '11': { ownerTabId: 11, sessionId: message.data!.sessionId! } };
          return { success: true, data: { bindings } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '保留 Codex 会话' },
    ]);

    act(() => result.current.setProviderId('qoder'));
    expect(result.current.providerId).toBe('qoder');
    expect(result.current.hasConversationBinding).toBe(false);
    expect(result.current.conversationEvents).toEqual([]);

    act(() => result.current.setProviderId('codex'));
    await waitFor(() => expect(result.current.providerId).toBe('codex'));
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '保留 Codex 会话' },
    ]);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'registerAgentChatTab',
      data: { ownerTabId: 11, tabId: 11, sessionId: 'codex_session' },
    });
  });

  it('infers the last-used provider from existing tab state during migration', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV3:11': {
        providerId: 'qoder',
        updatedAt: 10,
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({
      success: true,
      data: { providers: [provider, qoderProvider], sessions: [] },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(result.current.providerId).toBe('qoder');
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      agentChatSidepanelLastUsedProviderV1: 'qoder',
    });
  });

  it('uses the most recently selected provider for new tabs and conversations', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({
      success: true,
      data: { providers: [provider, qoderProvider], sessions: [] },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    act(() => result.current.setProviderId('qoder'));
    expect(result.current.providerId).toBe('qoder');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_prepare',
      data: { providerId: 'qoder' },
    });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      agentChatSidepanelLastUsedProviderV1: 'qoder',
    });

    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));
    expect(result.current.providerId).toBe('qoder');
    act(() => result.current.setProviderId('codex'));

    act(() => activatedListener?.({ tabId: 11, windowId: 1 }));
    expect(result.current.providerId).toBe('qoder');
    await act(async () => result.current.newChat());
    expect(result.current.providerId).toBe('qoder');
  });

  it('keeps the shared legacy store until other windows migrate their tabs', async () => {
    const legacyStore = {
      version: 2 as const,
      chats: {
        '11': { providerId: 'codex', events: [userEvent('tab11', 'saved_11', 'tab 11')] },
        '22': { providerId: 'codex', events: [userEvent('tab22', 'saved_22', 'tab 22')] },
      },
    };
    const storage: Record<string, unknown> = { agentChatSidepanelStateV2: legacyStore };
    (chrome.tabs.query as unknown as Mock).mockImplementation(async query =>
      query?.active
        ? [{ id: 11, windowId: 1 }]
        : [
            { id: 11, windowId: 1 },
            { id: 22, windowId: 2 },
          ],
    );
    (chrome.storage.local.get as unknown as Mock).mockImplementation(async keys => {
      if (keys === null) return { ...storage };
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        selected.flatMap(key => (key in storage ? [[key, storage[key]]] : [])),
      );
    });
    (chrome.storage.local.set as unknown as Mock).mockImplementation(async updates => {
      Object.assign(storage, updates);
    });
    (chrome.storage.local.remove as unknown as Mock).mockImplementation(async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({
      success: true,
      data: { providers: [provider], sessions: [] },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(storage['agentChatSidepanelTabStateV4:11']).toBeDefined();
    expect(storage['agentChatSidepanelTabStateV4:22']).toBeUndefined();
    expect(storage.agentChatSidepanelStateV2).toBe(legacyStore);
  });

  it('derives the owner window before handling tab activation when window lookup failed', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({
      success: true,
      data: { providers: [provider], sessions: [] },
    });

    const { result } = renderHook(() => useAgentChat(null));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    act(() => activatedListener?.({ tabId: 44, windowId: 2 }));
    expect(result.current.activeTabId).toBe(11);
    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));
    expect(result.current.activeTabId).toBe(22);
  });

  it('associates, persists, and clears a workspace for the active tab', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_pick_directory') {
          return { success: true, data: { path: '/workspace/project' } };
        }
        if (message.action === 'agent_chat_start') {
          return {
            success: true,
            data: {
              id: 'session_11',
              providerId: 'codex',
              providerSessionId: 'thread_11',
              status: 'idle',
              cwd: '/workspace/project',
              ephemeral: true,
              tabId: 11,
            },
          };
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_11' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => result.current.selectWorkspace());
    expect(result.current.workspaceDirectory).toBe('/workspace/project');

    await act(async () => result.current.openInApp());
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_open_workspace',
      data: { cwd: '/workspace/project' },
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_chat_start' }),
    );

    await act(async () => result.current.send('修改代码', { ephemeral: true }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_start',
      data: {
        providerId: 'codex',
        cwd: '/workspace/project',
        ephemeral: true,
        tabId: 11,
        initialPageUrl: 'https://example.com/tabs/11',
        initialPageTitle: 'Tab 11',
      },
    });

    await act(async () => result.current.openInApp());
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
      action: 'agent_chat_open_workspace',
      data: { cwd: '/workspace/project' },
    });

    await act(async () => result.current.newChat());
    expect(result.current.workspaceDirectory).toBe('/workspace/project');

    act(() => result.current.clearWorkspace());
    expect(result.current.workspaceDirectory).toBeNull();
  });

  it('starts a fresh conversation in the requested project directory', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_start') {
          return {
            success: true,
            data: {
              id: 'session_project',
              providerId: 'codex',
              providerSessionId: 'thread_project',
              status: 'idle',
              cwd: '/workspace/notebook-project',
              tabId: 11,
            },
          };
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_project' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => {
      expect(
        await result.current.newChat({
          providerId: 'codex',
          cwd: '/workspace/notebook-project',
        }),
      ).toBe(true);
    });
    expect(result.current.workspaceDirectory).toBe('/workspace/notebook-project');

    await act(async () => result.current.send('整理笔记', { ephemeral: true }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_start',
      data: {
        providerId: 'codex',
        cwd: '/workspace/notebook-project',
        ephemeral: true,
        tabId: 11,
        initialPageUrl: 'https://example.com/tabs/11',
        initialPageTitle: 'Tab 11',
      },
    });
  });

  it('passes tabId when starting a session and keeps inactive-tab events', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_start') {
          return {
            success: true,
            data: {
              id: 'session_11',
              providerId: 'codex',
              providerSessionId: 'thread_11',
              status: 'idle',
              ephemeral: false,
              tabId: 11,
            },
          };
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_11' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    await act(async () =>
      result.current.send('检查页面\n\n<selected_page_element>{}</selected_page_element>', {
        ephemeral: false,
        displayMessage: '检查页面',
        images: [{ data: 'AQID', mimeType: 'image/png', name: 'screenshot.png' }],
      }),
    );

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_start',
      data: {
        providerId: 'codex',
        ephemeral: false,
        tabId: 11,
        initialPageUrl: 'https://example.com/tabs/11',
        initialPageTitle: 'Tab 11',
      },
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_send',
      data: {
        sessionId: 'session_11',
        message: '检查页面\n\n<selected_page_element>{}</selected_page_element>',
        displayMessage: '检查页面',
        images: [{ data: 'AQID', mimeType: 'image/png', name: 'screenshot.png' }],
        clientMessageId: expect.any(String),
      },
    });
    expect(result.current.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'chat/userMessage',
          params: {
            text: '检查页面',
            imageCount: 1,
          },
        }),
      ]),
    );
    expect(result.current.conversationEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'chat/userMessage',
          params: { text: '检查页面', imageCount: 1 },
        }),
      ]),
    );

    await act(async () => result.current.openInApp());
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_open_app',
      data: { sessionId: 'session_11' },
    });

    act(() => activatedListener?.({ tabId: 22, windowId: 1 }));
    act(() =>
      runtimeMessageListener?.({
        action: 'agentChatEvent',
        data: {
          id: 'answer_11',
          sessionId: 'session_11',
          providerId: 'codex',
          kind: 'notification',
          method: 'item/completed',
          params: {
            turnId: 'turn_11',
            item: { id: 'message_11', type: 'agentMessage', text: '页面检查完成' },
          },
          timestamp: 2,
        },
      }),
    );
    expect(result.current.conversationEvents).toEqual([]);

    act(() => activatedListener?.({ tabId: 11, windowId: 1 }));
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '检查页面\n🖼 ×1' },
      { role: 'assistant', message: '页面检查完成' },
    ]);
  });

  it('starts embedded conversations with their registered toolbox context', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_start') {
          return {
            success: true,
            data: {
              id: 'session_toolbox',
              providerId: 'codex',
              providerSessionId: 'thread_toolbox',
              status: 'idle',
              tabId: 11,
              toolboxToolId: 'plugin:notebook',
            },
          };
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_toolbox' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() =>
      useAgentChat(1, {
        toolboxToolId: 'plugin:notebook',
        toolboxContext: 'Notebook: Reading list',
      }),
    );
    await waitFor(() => expect(result.current.initializing).toBe(false));
    await act(async () => result.current.send('列出当前笔记'));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_start',
      data: {
        providerId: 'codex',
        tabId: 11,
        toolboxToolId: 'plugin:notebook',
        toolboxContext: 'Notebook: Reading list',
        initialPageUrl: 'https://example.com/tabs/11',
        initialPageTitle: 'Tab 11',
      },
    });
  });

  it('isolates toolbox conversations and workspace directories by conversation key', async () => {
    const scopedGroup = (cwd: string, message: string) => ({
      version: 1,
      activeProviderId: 'codex',
      chats: {
        codex: {
          providerId: 'codex',
          cwd,
          events: [userEvent(`event_${message}`, 'saved_session', message)],
          conversationEvents: [userEvent(`event_${message}`, 'saved_session', message)],
          updatedAt: 1,
        },
      },
    });
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatToolboxScopeStateV1:plugin%3Anotebook:notebook%3Aone': scopedGroup(
        '/repos/one',
        '项目一',
      ),
      'agentChatToolboxScopeStateV1:plugin%3Anotebook:notebook%3Atwo': scopedGroup(
        '/repos/two',
        '项目二',
      ),
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: { connected: true, nativeHostVersion: '1.40.0', extensionVersion: '1.40.0' },
          };
        }
        return { success: true, data: {} };
      },
    );

    const first = renderHook(() =>
      useAgentChat(1, {
        toolboxToolId: 'plugin:notebook',
        toolboxConversationKey: 'notebook:one',
        initialCwd: '/repos/one',
      }),
    );
    await waitFor(() => expect(first.result.current.initializing).toBe(false));
    expect(first.result.current.workspaceDirectory).toBe('/repos/one');
    expect(chatMessages(first.result.current.conversationEvents)).toEqual([
      { role: 'user', message: '项目一' },
    ]);
    first.unmount();

    const second = renderHook(() =>
      useAgentChat(1, {
        toolboxToolId: 'plugin:notebook',
        toolboxConversationKey: 'notebook:two',
        initialCwd: '/repos/two',
      }),
    );
    await waitFor(() => expect(second.result.current.initializing).toBe(false));
    expect(second.result.current.workspaceDirectory).toBe('/repos/two');
    expect(chatMessages(second.result.current.conversationEvents)).toEqual([
      { role: 'user', message: '项目二' },
    ]);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
      action: 'getAgentChatTabBindings',
    });
    expect(chrome.tabs.onActivated.addListener).not.toHaveBeenCalled();
    expect(chrome.tabs.onRemoved.addListener).not.toHaveBeenCalled();
  });

  it('applies model updates immediately and clears a turn-specific reroute on completion', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV3:11': {
        providerId: 'codex',
        providerSessionId: 'thread_11',
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return {
            success: true,
            data: {
              providers: [provider],
              sessions: [
                {
                  id: 'session_11',
                  providerId: 'codex',
                  providerSessionId: 'thread_11',
                  status: 'running',
                  activeTurnId: 'turn_11',
                  model: { id: 'configured-model' },
                  tabId: 11,
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return { success: true, data: { events: [] } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.session?.model).toEqual({ id: 'configured-model' });

    act(() =>
      runtimeMessageListener?.({
        action: 'agentChatEvent',
        data: {
          id: 'model-update',
          sessionId: 'session_11',
          providerId: 'codex',
          kind: 'notification',
          method: 'session/activeModel/updated',
          params: { model: { id: 'rerouted-model' } },
          timestamp: 2,
        },
      }),
    );
    expect(result.current.session?.activeModel).toEqual({ id: 'rerouted-model' });

    act(() =>
      runtimeMessageListener?.({
        action: 'agentChatEvent',
        data: {
          id: 'turn-completed',
          sessionId: 'session_11',
          providerId: 'codex',
          kind: 'notification',
          method: 'turn/completed',
          params: { turn: { id: 'turn_11', status: 'completed' } },
          timestamp: 3,
        },
      }),
    );
    expect(result.current.session?.activeModel).toBeUndefined();
    expect(result.current.session?.model).toEqual({ id: 'configured-model' });
  });

  it('shows the first message before the cold session finishes starting', async () => {
    let finishStart: ((session: Record<string, unknown>) => void) | undefined;
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_start') {
          return new Promise(resolve => {
            finishStart = resolve;
          });
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_11' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    let sendPromise: ReturnType<typeof result.current.send> | undefined;
    act(() => {
      sendPromise = result.current.send('你好');
    });

    await waitFor(() =>
      expect(chatMessages(result.current.conversationEvents)).toEqual([
        { role: 'user', message: '你好' },
        {
          role: 'preparing',
          message: 'Creating Codex conversation…',
        },
      ]),
    );

    await act(async () => {
      finishStart?.({
        success: true,
        data: {
          id: 'session_11',
          providerId: 'codex',
          providerSessionId: 'thread_11',
          status: 'idle',
          tabId: 11,
        },
      });
      await sendPromise;
    });
  });

  it.each([provider, qoderProvider])(
    'warms up $id without creating a conversation until the first send',
    async selected => {
      (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
      (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
        async (message: { action?: string }) => {
          if (message.action === 'agent_chat_status') {
            return { success: true, data: { providers: [selected], sessions: [] } };
          }
          if (message.action === 'agent_chat_start') {
            return {
              success: true,
              data: {
                id: 'session_11',
                providerId: selected.id,
                providerSessionId: 'thread_11',
                status: 'idle',
                tabId: 11,
              },
            };
          }
          if (message.action === 'agent_chat_send') {
            return { success: true, data: { turnId: 'turn_11' } };
          }
          return { success: true, data: {} };
        },
      );

      const { result } = renderHook(() => useAgentChat(1));
      await waitFor(() => expect(result.current.initializing).toBe(false));
      await waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          action: 'agent_chat_prepare',
          data: { providerId: selected.id },
        }),
      );
      expect(result.current.session).toBeNull();
      expect(
        (chrome.runtime.sendMessage as unknown as Mock).mock.calls.filter(
          ([message]) => message.action === 'agent_chat_start',
        ),
      ).toHaveLength(0);

      await act(async () => result.current.send('开始检查'));

      expect(
        (chrome.runtime.sendMessage as unknown as Mock).mock.calls.filter(
          ([message]) => message.action === 'agent_chat_start',
        ),
      ).toHaveLength(1);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'agent_chat_send',
        data: {
          sessionId: 'session_11',
          message: '开始检查',
          clientMessageId: expect.any(String),
        },
      });
    },
  );

  it('retries session creation on the next send after startup fails', async () => {
    let startCount = 0;
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_start') {
          startCount += 1;
          if (startCount === 1) return { success: false, error: 'Temporary startup failure' };
          return {
            success: true,
            data: {
              id: 'session_11',
              providerId: 'codex',
              providerSessionId: 'thread_11',
              status: 'idle',
              tabId: 11,
            },
          };
        }
        if (message.action === 'agent_chat_send') {
          return { success: true, data: { turnId: 'turn_11' } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => result.current.send('首次发送'));
    expect(startCount).toBe(1);
    expect(result.current.session).toBeNull();
    expect(result.current.error).toBe('Temporary startup failure');

    await act(async () => result.current.send('重试'));

    expect(startCount).toBe(2);
    expect(result.current.session?.id).toBe('session_11');
  });

  it('closes a cold-started session when the tab is reset before startup finishes', async () => {
    let finishStart: ((session: Record<string, unknown>) => void) | undefined;
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_start') {
          return new Promise(resolve => {
            finishStart = resolve;
          });
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    let sendPromise: ReturnType<typeof result.current.send> | undefined;
    act(() => {
      sendPromise = result.current.send('不要发送');
    });
    await waitFor(() => expect(result.current.submitting).toBe(true));

    await act(async () => result.current.newChat());
    expect(result.current.conversationEvents).toEqual([]);

    await act(async () => {
      finishStart?.({
        success: true,
        data: {
          id: 'stale_session_11',
          providerId: 'codex',
          providerSessionId: 'stale_thread_11',
          status: 'idle',
          tabId: 11,
        },
      });
      await sendPromise;
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_close',
      data: { sessionId: 'stale_session_11' },
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_chat_send' }),
    );
    expect(result.current.conversationEvents).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it.each([true, false])('replays a live conversation with a saved snapshot: %s', async saved => {
    const savedUserEvent = userEvent('user_11', 'session_11', '继续检查');
    const replayedAssistantEvent: AgentChatEvent = {
      id: 'answer_11',
      sessionId: 'session_11',
      providerId: 'codex',
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn_11',
        item: { id: 'message_11', type: 'agentMessage', text: '检查已完成' },
      },
      timestamp: 2,
    };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue(
      saved
        ? {
            'agentChatSidepanelTabStateV3:11': {
              providerId: 'codex',
              providerSessionId: 'thread_11',
              events: [savedUserEvent],
              conversationEvents: [savedUserEvent],
            },
          }
        : {},
    );
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return {
            success: true,
            data: {
              providers: [provider],
              sessions: [
                {
                  id: 'session_11',
                  providerId: 'codex',
                  providerSessionId: 'thread_11',
                  status: 'idle',
                  tabId: 11,
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return { success: true, data: { events: [savedUserEvent, replayedAssistantEvent] } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_events',
      data: { sessionId: 'session_11' },
    });
    expect(result.current.session?.id).toBe('session_11');
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '继续检查' },
      { role: 'assistant', message: '检查已完成' },
    ]);
  });

  it('lists and resumes an existing provider conversation', async () => {
    const historicalUserEvent = userEvent('history-user', 'session-resumed', '继续排查');
    const historicalAssistantEvent: AgentChatEvent = {
      id: 'history-assistant',
      sessionId: 'session-resumed',
      providerId: 'codex',
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-history',
        item: { id: 'answer-history', type: 'agentMessage', text: '已恢复上下文' },
      },
      timestamp: 2,
    };
    const refreshedAssistantEvent: AgentChatEvent = {
      id: 'history-external-update',
      sessionId: 'session-resumed',
      providerId: 'codex',
      kind: 'notification',
      method: 'item/completed',
      params: {
        turnId: 'turn-external',
        item: { id: 'answer-external', type: 'agentMessage', text: '外部更新' },
      },
      timestamp: 3,
    };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'getAgentStatus') {
          return {
            success: true,
            status: { nativeHostVersion: '1.40.0', extensionVersion: '1.40.0' },
          };
        }
        if (message.action === 'agent_chat_status') {
          return { success: true, data: { providers: [provider], sessions: [] } };
        }
        if (message.action === 'agent_chat_list_sessions') {
          return {
            success: true,
            data: {
              sessions: [
                {
                  providerId: 'codex',
                  providerSessionId: 'thread-existing',
                  title: 'Existing conversation',
                  cwd: '/workspace',
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_start') {
          return {
            success: true,
            data: {
              id: 'session-resumed',
              providerId: 'codex',
              providerSessionId: 'thread-existing',
              status: 'idle',
              tabId: 11,
              cwd: '/workspace',
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return {
            success: true,
            data: { events: [historicalUserEvent, historicalAssistantEvent] },
          };
        }
        if (message.action === 'agent_chat_refresh') {
          return {
            success: true,
            data: {
              session: {
                id: 'session-resumed',
                providerId: 'codex',
                providerSessionId: 'thread-existing',
                status: 'idle',
                tabId: 11,
                cwd: '/workspace',
              },
              events: [historicalUserEvent, historicalAssistantEvent, refreshedAssistantEvent],
            },
          };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    const listed = await result.current.listSessions('codex');
    await act(async () => result.current.resumeSession(listed.sessions[0]!));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_start',
      data: {
        providerId: 'codex',
        providerSessionId: 'thread-existing',
        tabId: 11,
        initialPageUrl: 'https://example.com/tabs/11',
        initialPageTitle: 'Tab 11',
        cwd: '/workspace',
      },
    });
    expect(result.current.session?.providerSessionId).toBe('thread-existing');
    expect(result.current.workspaceDirectory).toBe('/workspace');
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '继续排查' },
      { role: 'assistant', message: '已恢复上下文' },
    ]);

    await act(async () => result.current.refreshSession());

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'agent_chat_refresh',
      data: { sessionId: 'session-resumed' },
    });
    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '继续排查' },
      { role: 'assistant', message: '已恢复上下文' },
      { role: 'assistant', message: '外部更新' },
    ]);
  });

  it('keeps optimistic message order when replay replaces the local user event', async () => {
    const savedUserEvent = userEvent('user_11', 'session_11', '继续检查');
    const preparingEvent: AgentChatEvent = {
      ...savedUserEvent,
      id: 'preparing_11',
      method: 'chat/preparing',
      params: {},
      timestamp: 2,
    };
    const replayedUserEvent = { ...savedUserEvent, timestamp: 3 };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      'agentChatSidepanelTabStateV3:11': {
        providerId: 'codex',
        providerSessionId: 'thread_11',
        events: [savedUserEvent, preparingEvent],
        conversationEvents: [savedUserEvent, preparingEvent],
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockImplementation(
      async (message: { action?: string }) => {
        if (message.action === 'agent_chat_status') {
          return {
            success: true,
            data: {
              providers: [provider],
              sessions: [
                {
                  id: 'session_11',
                  providerId: 'codex',
                  providerSessionId: 'thread_11',
                  status: 'running',
                  tabId: 11,
                },
              ],
            },
          };
        }
        if (message.action === 'agent_chat_events') {
          return { success: true, data: { events: [replayedUserEvent] } };
        }
        return { success: true, data: {} };
      },
    );

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(chatMessages(result.current.conversationEvents)).toEqual([
      { role: 'user', message: '继续检查' },
      { role: 'thinking', message: '💭 …' },
    ]);
  });

  it('keeps a reset tab blank instead of reclaiming its old native session', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      agentChatSidepanelStateV2: {
        version: 2,
        chats: { '11': { providerId: 'codex', events: [], conversationEvents: [] } },
      },
    });
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({
      success: true,
      data: {
        providers: [provider],
        sessions: [
          {
            id: 'old_session_11',
            providerId: 'codex',
            providerSessionId: 'old_thread_11',
            status: 'idle',
            tabId: 11,
          },
        ],
      },
    });

    const { result } = renderHook(() => useAgentChat(1));
    await waitFor(() => expect(result.current.initializing).toBe(false));

    expect(result.current.session).toBeNull();
    expect(result.current.hasConversationBinding).toBe(false);
    expect(result.current.conversationEvents).toEqual([]);
  });
});
