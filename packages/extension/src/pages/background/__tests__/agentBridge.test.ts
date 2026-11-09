import { EXTENSION_RPC_VERSION, ExtensionRpcError } from '@mearl/browser-core';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const capabilityMocks = vi.hoisted(() => ({ handleGetCapabilities: vi.fn() }));
vi.mock('../capabilityDiscovery', () => capabilityMocks);
const enhancementMocks = vi.hoisted(() => ({ handleBrowserEnhancement: vi.fn() }));
vi.mock('../browserEnhancements', () => enhancementMocks);

const analyticsMocks = vi.hoisted(() => ({
  getAnalyticsClientId: vi.fn(),
}));
const actionTargetMocks = vi.hoisted(() => ({
  prepareTabForAgent: vi.fn().mockResolvedValue(undefined),
  resumeFrozenPage: vi.fn().mockResolvedValue(undefined),
  capturePageDownload: vi.fn(),
}));
vi.mock('../agentHandlers/downloadHandlers', () => ({
  capturePageDownload: actionTargetMocks.capturePageDownload,
}));
const permissionMocks = vi.hoisted(() => ({
  isAgentDomainAuthorized: vi.fn(),
}));
const httpHandlerMocks = vi.hoisted(() => ({
  handleSendRequest: vi.fn(),
}));
const diagnosticMocks = vi.hoisted(() => ({
  handleCaptureCheckpoint: vi.fn(),
  handleGetEvents: vi.fn(),
  handleGetLogs: vi.fn(),
  handleGetRequests: vi.fn(),
}));
const browserHandlerMocks = vi.hoisted(() => ({
  getDevtoolsSelectedElement: vi.fn(),
}));
const interactionHandlerMocks = vi.hoisted(() => ({
  handlePageInspect: vi.fn(),
}));
const toolboxTabMocks = vi.hoisted(() => ({
  openToolboxToolTab: vi.fn(),
}));
const tabGroupMocks = vi.hoisted(() => ({
  handoffAgentTabGroups: vi.fn().mockResolvedValue(undefined),
  resumeAgentTabGroups: vi.fn().mockResolvedValue(undefined),
  handleBrowserRelease: vi.fn(),
}));

vi.mock('../agentHandlers/agentTabGroups', async importOriginal => ({
  ...(await importOriginal<typeof import('../agentHandlers/agentTabGroups')>()),
  handoffAgentTabGroups: tabGroupMocks.handoffAgentTabGroups,
  resumeAgentTabGroups: tabGroupMocks.resumeAgentTabGroups,
}));
vi.mock('../agentHandlers/releaseHandlers', () => ({
  handleBrowserRelease: tabGroupMocks.handleBrowserRelease,
}));
vi.mock('../backgroundPageActivity', () => ({
  setBackgroundPageActivity: vi.fn().mockResolvedValue(undefined),
  releaseBackgroundPageActivities: vi.fn().mockResolvedValue(undefined),
  resumeFrozenPage: actionTargetMocks.resumeFrozenPage,
}));

vi.mock('../../../shared/analytics', () => ({
  getAnalyticsClientId: analyticsMocks.getAnalyticsClientId,
}));
vi.mock('../agentHandlers/tabHandlers', async importOriginal => ({
  ...(await importOriginal<typeof import('../agentHandlers/tabHandlers')>()),
  prepareTabForAgent: actionTargetMocks.prepareTabForAgent,
}));
vi.mock('../../../shared/proxyPermissions', () => ({
  isAgentDomainAuthorized: permissionMocks.isAgentDomainAuthorized,
}));
vi.mock('../agentHandlers/httpHandlers', async importOriginal => ({
  ...(await importOriginal<typeof import('../agentHandlers/httpHandlers')>()),
  handleSendRequest: httpHandlerMocks.handleSendRequest,
}));
vi.mock('../agentHandlers/requestHandlers', async importOriginal => ({
  ...(await importOriginal<typeof import('../agentHandlers/requestHandlers')>()),
  handleCaptureCheckpoint: diagnosticMocks.handleCaptureCheckpoint,
  handleGetEvents: diagnosticMocks.handleGetEvents,
  handleGetLogs: diagnosticMocks.handleGetLogs,
  handleGetRequests: diagnosticMocks.handleGetRequests,
}));
vi.mock('../agentHandlers/browserHandlers', async importOriginal => ({
  ...(await importOriginal<typeof import('../agentHandlers/browserHandlers')>()),
  getDevtoolsSelectedElement: browserHandlerMocks.getDevtoolsSelectedElement,
}));
vi.mock('../agentHandlers/interactionHandlers', async importOriginal => ({
  ...(await importOriginal<typeof import('../agentHandlers/interactionHandlers')>()),
  handlePageInspect: interactionHandlerMocks.handlePageInspect,
}));
vi.mock('../../../shared/toolboxTab', () => ({
  openToolboxToolTab: toolboxTabMocks.openToolboxToolTab,
}));

import { AgentBridge } from '../agentBridge';
import { PageActionPreconditionError } from '@mearl/browser-core';

describe('AgentBridge native handshake', () => {
  const postMessage = vi.fn();
  const disconnect = vi.fn();
  const addMessageListener = vi.fn();
  const addDisconnectListener = vi.fn();
  let bridge: AgentBridge | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    analyticsMocks.getAnalyticsClientId.mockRejectedValue(new Error('analytics unavailable'));
    permissionMocks.isAgentDomainAuthorized.mockResolvedValue(true);
    httpHandlerMocks.handleSendRequest.mockResolvedValue({ status: 200 });
    diagnosticMocks.handleCaptureCheckpoint.mockResolvedValue({
      tabId: 1,
      cursor: 'checkpoint',
      timestampMs: 1,
      captureStatus: 'armed',
    });
    diagnosticMocks.handleGetLogs.mockResolvedValue({ logs: [{ message: 'new error' }] });
    diagnosticMocks.handleGetRequests.mockResolvedValue({ requests: [{ url: '/api/new' }] });
    diagnosticMocks.handleGetEvents.mockResolvedValue({ events: [{ name: 'submit' }] });
    browserHandlerMocks.getDevtoolsSelectedElement.mockResolvedValue({
      selector: '#picked',
      attributes: { id: 'picked' },
      xpath: '/html/body/div',
      outerHTML: '<div id="picked">Target</div>',
      sourceLocation: 'src/Page.tsx:12:4',
      framework: { react: { componentStack: ['Page'] } },
    });
    interactionHandlerMocks.handlePageInspect.mockResolvedValue({
      selector: '#picked',
      filter: 'all',
      candidateCount: 1,
      count: 1,
      matches: [{ selector: '#picked', tag: 'div', text: 'Target' }],
      truncated: false,
    });
    toolboxTabMocks.openToolboxToolTab.mockResolvedValue(undefined);
    tabGroupMocks.handleBrowserRelease.mockResolvedValue({ released: true });

    chrome.tabs = {
      query: vi.fn().mockResolvedValue([{ id: 1 }]),
      get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/' }),
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    } as unknown as typeof chrome.tabs;
    chrome.windows = {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: vi.fn() },
    } as unknown as typeof chrome.windows;
    chrome.runtime.connectNative = vi.fn(
      () =>
        ({
          postMessage,
          disconnect,
          onMessage: { addListener: addMessageListener },
          onDisconnect: { addListener: addDisconnectListener },
        }) as unknown as chrome.runtime.Port,
    );
    (chrome.runtime.sendMessage as Mock).mockResolvedValue(undefined);
    (chrome.storage.local.get as Mock).mockResolvedValue({
      mearl_browser_id: 'browser-1',
    });
    (chrome.storage.local.set as Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    bridge?.destroy();
    bridge = null;
    vi.restoreAllMocks();
  });

  it('keeps browser identity and checks for updates once per background lifetime', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge = new AgentBridge(new Map());

    bridge.start();

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    expect(postMessage).toHaveBeenCalledWith({
      type: 'ping',
      timestamp: expect.any(Number),
      version: '2.0.0',
      rpcVersion: EXTENSION_RPC_VERSION,
      checkForUpdates: true,
      browserId: 'browser-1',
      browserName: expect.any(String),
    });
    expect(warn).toHaveBeenCalledWith(
      '[AgentBridge] Failed to load analytics identity:',
      expect.any(Error),
    );

    addMessageListener.mock.calls[0]![0]({
      type: 'pong',
      version: '2.0.0',
      rpcVersion: EXTENSION_RPC_VERSION,
    });
    bridge.reset();

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'ping',
      timestamp: expect.any(Number),
      version: '2.0.0',
      rpcVersion: EXTENSION_RPC_VERSION,
      checkForUpdates: false,
      browserId: 'browser-1',
      browserName: expect.any(String),
    });
  });

  it('tries the alternate host immediately without reporting a missing candidate as an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    bridge = new AgentBridge(new Map());

    bridge.start();

    expect(chrome.runtime.connectNative).toHaveBeenNthCalledWith(1, 'ai.mearl.skills');
    expect(bridge.getStatus().connected).toBe(false);

    chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
    addDisconnectListener.mock.calls[0]![0]();

    await vi.waitFor(() => expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(2));
    expect(chrome.runtime.connectNative).toHaveBeenNthCalledWith(2, 'ai.mearl.mcp');
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('[AgentBridge] Trying alternate Native Messaging host');

    chrome.runtime.lastError = undefined;
    addMessageListener.mock.calls[1]![0]({
      type: 'pong',
      version: '2.0.0',
      rpcVersion: EXTENSION_RPC_VERSION,
    });
    expect(bridge.getStatus().connected).toBe(true);
  });

  it('sends Skill installation requests while browser actions from agents are disabled', async () => {
    bridge = new AgentBridge(new Map(), new Map(), () => false);
    bridge.start();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const data = {
      providerId: 'codex',
      source: 'trip/mearl',
      name: 'tinypng-compress',
      scope: 'global',
    };
    addMessageListener.mock.calls[0]![0]({
      type: 'pong',
      version: '2.0.0',
      rpcVersion: EXTENSION_RPC_VERSION,
    });
    const pending = bridge.requestNativeHost('agent_skills_install', data);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const request = postMessage.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ action: 'agent_skills_install', data });
    addMessageListener.mock.calls[0]![0]({
      id: request.id,
      success: true,
      data: { ok: true, output: 'installed' },
    });
    await expect(pending).resolves.toEqual({ ok: true, output: 'installed' });
  });

  it('keeps ordinary agent actions disabled on a bridge opened for browser management', async () => {
    bridge = new AgentBridge(new Map(), new Map(), () => false);
    const internals = bridge as any;
    const sendToAgent = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});

    await internals.handleAgentMessage({
      id: 'disabled-action',
      action: 'tab_list',
      data: {},
    });

    expect(sendToAgent).toHaveBeenCalledWith({
      id: 'disabled-action',
      success: false,
      error: 'Agent service is disabled',
    });
  });

  it.each([undefined, EXTENSION_RPC_VERSION + 1])(
    'rejects incompatible host protocol %s before sending a service request',
    async rpcVersion => {
      bridge = new AgentBridge(new Map());
      bridge.start();
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
      addMessageListener.mock.calls[0]![0]({ type: 'pong', version: '2.0.0', rpcVersion });
      await expect(
        bridge.requestNativeHost('browser_instances', { operation: 'start', browser: 'one' }),
      ).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(bridge.getStatus().nativeRpcCompatible).toBe(false);
    },
  );

  it('waits for the handshake and preserves structured request errors', async () => {
    bridge = new AgentBridge(new Map());
    bridge.start();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const pending = bridge.requestNativeHost('browser_instances', {
      operation: 'start',
      browser: 'one',
    });
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledTimes(1);
    addMessageListener.mock.calls[0]![0]({ type: 'pong', rpcVersion: EXTENSION_RPC_VERSION });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const request = postMessage.mock.calls[1]![0];
    expect(request).toMatchObject({
      action: 'browser_instances',
      rpcVersion: EXTENSION_RPC_VERSION,
    });
    const rejected = expect(pending).rejects.toEqual(
      new ExtensionRpcError('UNSUPPORTED_ACTION', 'Service unavailable'),
    );
    addMessageListener.mock.calls[0]![0]({
      id: request.id,
      success: false,
      code: 'UNSUPPORTED_ACTION',
      error: 'Service unavailable',
    });
    await rejected;
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects diagnostic actions without a tab before preparing or dispatching them', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const sendToAgent = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});

    await internals.handleAgentMessage({ id: 'missing-tab', action: 'get_logs', data: {} });

    expect(sendToAgent).toHaveBeenCalledWith({
      id: 'missing-tab',
      success: false,
      error: expect.stringContaining('get_logs requires a numeric tabId'),
    });
    expect(actionTargetMocks.prepareTabForAgent).not.toHaveBeenCalled();
    expect(diagnosticMocks.handleGetLogs).not.toHaveBeenCalled();
  });

  it('blocks trusted enhancement writes when the Agent service is disabled but allows scoped release', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const reply = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
    vi.spyOn(internals, 'canHandleAgentActions').mockReturnValue(false);
    enhancementMocks.handleBrowserEnhancement.mockResolvedValue({ released: true });
    for (const operation of ['probe', 'bind', 'invoke']) {
      await internals.handleAgentMessage({
        id: operation,
        action: '__browser_enhancement',
        data: { operation },
        trustedInternal: true,
      });
      expect(reply).toHaveBeenCalledWith({
        id: operation,
        success: false,
        error: 'Agent service is disabled',
      });
    }
    expect(enhancementMocks.handleBrowserEnhancement).not.toHaveBeenCalled();
    await internals.handleAgentMessage({
      id: 'cleanup',
      action: '__browser_enhancement',
      data: { operation: 'release' },
      trustedInternal: true,
    });
    expect(reply).toHaveBeenCalledWith({ id: 'cleanup', success: true, data: { released: true } });
  });

  it('requires a trusted host for preset synchronization even with agent service disabled', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const reply = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
    const sync = vi.spyOn(internals, 'synchronizePreset').mockResolvedValue({ ready: true });
    vi.spyOn(internals, 'canHandleAgentActions').mockReturnValue(false);
    await internals.handleAgentMessage({
      id: 'untrusted',
      action: '__preset_browser',
      data: { operation: 'status' },
    });
    expect(sync).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'untrusted', success: false }),
    );
    await internals.handleAgentMessage({
      id: 'trusted',
      action: '__preset_browser',
      data: { operation: 'status' },
      trustedInternal: true,
    });
    expect(reply).toHaveBeenCalledWith({ id: 'trusted', success: true, data: { ready: true } });
  });

  it('routes capability discovery without domain authorization, capture or tab preparation', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    capabilityMocks.handleGetCapabilities.mockResolvedValue({
      apps: { status: 'available', entries: [] },
    });
    permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);
    vi.spyOn(internals, 'canHandleAgentActions').mockReturnValue(true);
    const reply = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
    await internals.handleAgentMessage({
      id: 'capabilities',
      action: 'get_capabilities',
      data: {},
    });
    expect(capabilityMocks.handleGetCapabilities).toHaveBeenCalledWith({});
    expect(permissionMocks.isAgentDomainAuthorized).not.toHaveBeenCalled();
    expect(actionTargetMocks.prepareTabForAgent).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('opens a notebook toolbox page through the safe internal action', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const notebookId = '00000000-0000-4000-8000-000000000001';

    const result = await internals.dispatchSingleAction(
      '__toolbox_open',
      { toolId: 'plugin:notebook', query: { id: notebookId } },
      { queryPanel: vi.fn(), getActiveTabId: vi.fn(() => 1) },
      'local',
    );

    expect(toolboxTabMocks.openToolboxToolTab).toHaveBeenCalledWith('plugin:notebook', {
      id: notebookId,
    });
    expect(result).toEqual({
      opened: true,
      toolId: 'plugin:notebook',
      query: { id: notebookId },
    });
  });

  it('inspects the DevTools selection through page_inspect $0', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const ctx = { queryPanel: vi.fn(), getActiveTabId: vi.fn(() => 1) };

    const result = await internals.dispatchSingleAction(
      'page_inspect',
      { tabId: 1, selector: '$0' },
      ctx,
      'local',
    );

    expect(browserHandlerMocks.getDevtoolsSelectedElement).toHaveBeenCalledWith(
      { tabId: 1, includeOuterHTML: true },
      ctx,
    );
    expect(interactionHandlerMocks.handlePageInspect).toHaveBeenCalledWith(
      { tabId: 1, selector: '#picked' },
      expect.any(Function),
    );
    expect(result).toMatchObject({
      selector: '$0',
      resolvedSelector: '#picked',
      source: 'devtools-selection',
      matches: [
        {
          selector: '#picked',
          attributes: { id: 'picked' },
          xpath: '/html/body/div',
          outerHTML: '<div id="picked">Target</div>',
        },
      ],
    });
  });

  it('prepares a step-level tab override once with the batch control source', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    vi.spyOn(internals, 'assertAgentActionAuthorized').mockResolvedValue(undefined);
    vi.spyOn(internals, 'dispatchSingleAction').mockResolvedValue({ ok: true });

    await internals.handleRunActions(
      {
        tabId: 1,
        actions: [
          { action: 'page_wait', data: { tabId: 2, time: 0 } },
          { action: 'page_snapshot', data: { tabId: 2 } },
        ],
      },
      {
        queryPanel: vi.fn(),
        getActiveTabId: vi.fn(() => 1),
      },
      'remote',
    );

    expect(actionTargetMocks.prepareTabForAgent).toHaveBeenCalledOnce();
    expect(actionTargetMocks.prepareTabForAgent).toHaveBeenCalledWith(2, 'remote');
  });

  it.each([undefined, false])('resumes the tab before a click (observe: %s)', async observe => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    vi.spyOn(internals, 'canHandleAgentActions').mockReturnValue(true);
    vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
    const observed = vi.spyOn(internals, 'handleObservedPageAction').mockResolvedValue({});
    const direct = vi.spyOn(internals, 'dispatchSingleAction').mockResolvedValue({});

    await internals.handleAgentMessage({
      id: 'click',
      action: 'page_click',
      data: { tabId: 1, selector: '#open', observe },
    });

    const dispatch = observe === false ? direct : observed;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(actionTargetMocks.resumeFrozenPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(actionTargetMocks.resumeFrozenPage.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0]!,
    );
  });

  it('resumes a download trigger after arming capture and before observing the click', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    vi.spyOn(internals, 'assertAgentActionAuthorized').mockResolvedValue(undefined);
    actionTargetMocks.capturePageDownload.mockImplementation((_data, trigger) => trigger());
    const observed = vi
      .spyOn(internals, 'handleObservedPageAction')
      .mockResolvedValue({ clicked: true });
    const data = { tabId: 1, trigger: { selector: '#download' } };

    await expect(
      internals.dispatchSingleAction('__capture_download', data, {}, 'local'),
    ).resolves.toEqual({ clicked: true });

    const [resumeOrder] = actionTargetMocks.resumeFrozenPage.mock.invocationCallOrder;
    expect(actionTargetMocks.resumeFrozenPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(actionTargetMocks.capturePageDownload.mock.invocationCallOrder[0]).toBeLessThan(
      resumeOrder!,
    );
    expect(resumeOrder).toBeLessThan(observed.mock.invocationCallOrder[0]!);
  });

  it('reports an invalid step tab as a batch failure before dispatching it', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const dispatch = vi.spyOn(internals, 'dispatchSingleAction');
    const result = await internals.handleRunActions(
      { tabId: 1, actions: [{ action: 'get_logs', data: { tabId: null } }] },
      { queryPanel: vi.fn(), getActiveTabId: vi.fn(() => 1) },
      'local',
    );

    expect(result).toMatchObject({
      completedSteps: 0,
      failedStep: 0,
      error: expect.stringContaining('get_logs requires a numeric tabId'),
      results: [{ step: 0, action: 'get_logs', success: false }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('captures requested diagnostics immediately before a bare page action and returns its delta', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const execute = vi
      .spyOn(internals, 'dispatchSingleAction')
      .mockResolvedValue({ clicked: true });
    const ctx = { queryPanel: vi.fn(), getActiveTabId: vi.fn(() => 1) };

    const result = await internals.handleObservedPageAction(
      'page_click',
      {
        tabId: 1,
        selector: '#submit',
        observe: false,
        diagnostics: true,
      },
      ctx,
      'local',
    );

    expect(diagnosticMocks.handleCaptureCheckpoint).toHaveBeenCalledWith({ tabId: 1 }, ctx);
    expect(diagnosticMocks.handleCaptureCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
    expect(diagnosticMocks.handleGetLogs).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 1, after: 'checkpoint', level: 'error' }),
      ctx,
    );
    expect(diagnosticMocks.handleGetRequests).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 1, after: 'checkpoint', source: 'all' }),
      ctx,
    );
    expect(result).toMatchObject({
      action: { success: true, data: { clicked: true } },
      diagnostics: {
        logs: { logs: [{ message: 'new error' }] },
        requests: { requests: [{ url: '/api/new' }] },
      },
    });
  });

  it('captures event diagnostics when explicitly requested', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    vi.spyOn(internals, 'dispatchSingleAction').mockResolvedValue({ clicked: true });
    const ctx = { queryPanel: vi.fn(), getActiveTabId: vi.fn(() => 1) };

    const result = await internals.handleObservedPageAction(
      'page_click',
      {
        tabId: 1,
        selector: '#submit',
        observe: false,
        diagnostics: { events: true },
      },
      ctx,
      'local',
    );

    expect(diagnosticMocks.handleGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 1, after: 'checkpoint', source: 'all' }),
      ctx,
    );
    expect(result).toMatchObject({ diagnostics: { events: { events: [{ name: 'submit' }] } } });
  });

  it('omits requested diagnostics when an action fails before execution', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    vi.spyOn(internals, 'dispatchSingleAction').mockRejectedValue(
      new PageActionPreconditionError(
        'Ref @e9801 not found. Run page_snapshot first to get fresh refs.',
      ),
    );
    const ctx = { queryPanel: vi.fn(), getActiveTabId: vi.fn(() => 1) };

    const result = await internals.handleObservedPageAction(
      'page_click',
      {
        tabId: 1,
        selector: '@e9801',
        observe: false,
        diagnostics: true,
      },
      ctx,
      'local',
    );

    expect(result).toEqual({
      action: {
        name: 'page_click',
        success: false,
        error: 'Ref @e9801 not found. Run page_snapshot first to get fresh refs.',
        stage: 'precondition',
      },
    });
    expect(diagnosticMocks.handleGetLogs).not.toHaveBeenCalled();
    expect(diagnosticMocks.handleGetRequests).not.toHaveBeenCalled();
  });

  it('authorizes both debugger URL fallback and the first navigation origin', async () => {
    bridge = new AgentBridge(new Map());
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7 } as chrome.tabs.Tab);
    chrome.debugger.getTargets = vi.fn().mockResolvedValue([
      {
        id: 'physical',
        type: 'page',
        tabId: 7,
        url: 'https://current.example/',
        attached: false,
      },
    ]);
    permissionMocks.isAgentDomainAuthorized.mockImplementation(
      async domain => domain !== 'next.example',
    );
    await expect(
      (bridge as any).assertEnhancementActionAuthorized(
        7,
        'set_app_profile',
        'https://next.example',
      ),
    ).rejects.toThrow('next.example');
    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('current.example');
    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('next.example');
  });

  it('expands handed off pages after restoring their normal activity', async () => {
    bridge = new AgentBridge(new Map());
    const result = await (bridge as any).dispatchSingleAction(
      '__control_deactivate',
      { tabIds: [7, 8] },
      {},
      'local',
    );
    expect(result).toEqual({ updated: true });
    expect(tabGroupMocks.handoffAgentTabGroups).toHaveBeenCalledWith([7, 8]);
  });

  it.each([
    { returningToAgent: true, released: true, folds: true },
    { returningToAgent: undefined, released: true, folds: false },
    { returningToAgent: true, released: false, folds: false },
  ])('folds session pages only after successful return: %j', async input => {
    bridge = new AgentBridge(new Map());
    tabGroupMocks.handleBrowserRelease.mockResolvedValue({ released: input.released });
    await (bridge as any).dispatchSingleAction(
      '__control_cleanup',
      { tabIds: [7], returningToAgent: input.returningToAgent },
      {},
      'local',
    );
    if (input.folds) expect(tabGroupMocks.resumeAgentTabGroups).toHaveBeenCalledWith([7]);
    else expect(tabGroupMocks.resumeAgentTabGroups).not.toHaveBeenCalled();
  });

  it.each(['__control_cleanup', '__control_deactivate'])(
    'allows %s restoration when the user switched to an unauthorized page',
    async action => {
      bridge = new AgentBridge(new Map());
      const internals = bridge as any;
      internals.currentTabId = 1;
      permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);
      vi.mocked(chrome.tabs.get).mockResolvedValue({
        id: 1,
        url: 'https://unapproved.example/',
      } as chrome.tabs.Tab);

      await expect(
        internals.assertAgentActionAuthorized(action, { tabIds: [7] }),
      ).resolves.toBeUndefined();
      expect(permissionMocks.isAgentDomainAuthorized).not.toHaveBeenCalled();
    },
  );

  it('authorizes the multipart target before accepting file chunks', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;

    await internals.assertAgentActionAuthorized('__send_request_files', {
      operation: 'start',
      url: 'https://content.example/upload',
      withCookies: true,
    });

    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledOnce();
    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('content.example');
  });

  it('routes transfer phases and permits cleanup after the current page loses authorization', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const sendToAgent = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
    const transferId = 'bridge-transfer';
    const send = (data: Record<string, unknown>) =>
      internals.handleAgentMessage({
        id: String(data.operation),
        action: '__send_request_files',
        trustedInternal: true,
        data: { ...data, transferId },
      });
    await send({
      operation: 'start',
      url: 'https://content.example/upload',
      files: [
        { fieldName: 'file', filename: 'test.txt', contentType: 'text/plain', byteLength: 3 },
      ],
    });
    expect(sendToAgent).toHaveBeenLastCalledWith({
      id: 'start',
      success: true,
      data: { accepted: true },
    });
    permissionMocks.isAgentDomainAuthorized.mockClear().mockResolvedValue(false);
    await send({ operation: 'chunk', fileIndex: 0, chunkIndex: 0, base64: 'YWJj' });
    expect(sendToAgent).toHaveBeenLastCalledWith({
      id: 'chunk',
      success: true,
      data: { receivedBytes: 3 },
    });
    await send({ operation: 'abort' });
    expect(sendToAgent).toHaveBeenLastCalledWith({
      id: 'abort',
      success: true,
      data: { aborted: true },
    });
    expect(permissionMocks.isAgentDomainAuthorized).not.toHaveBeenCalled();
  });

  it.each([
    { trustedInternal: true, operation: 'unknown', error: 'Invalid send_request file operation' },
    {
      trustedInternal: false,
      operation: 'abort',
      error: 'Internal action is not available to agents',
    },
  ])(
    'rejects invalid transfer requests: $operation / trusted=$trustedInternal',
    async ({ trustedInternal, operation, error }) => {
      bridge = new AgentBridge(new Map());
      const internals = bridge as any;
      const sendToAgent = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
      await internals.handleAgentMessage({
        id: 'invalid-transfer',
        action: '__send_request_files',
        trustedInternal,
        data: { operation, transferId: 'missing-transfer' },
      });
      expect(sendToAgent).toHaveBeenCalledWith({ id: 'invalid-transfer', success: false, error });
    },
  );

  it.each([
    'chrome-extension://aoehhjnofngknnjefamjbplchbolghkm/src/pages/options/index.html',
    'chrome://settings/',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
  ])('leaves browser-page access checks to Chrome: %s', async url => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url } as chrome.tabs.Tab);

    await internals.assertAgentActionAuthorized('tab_open', { url });
    for (const action of [
      'page_snapshot',
      'page_screenshot',
      'page_eval',
      'page_frames',
      'tab_close',
    ]) {
      await internals.assertAgentActionAuthorized(action, { tabId: 1 });
    }
    expect(permissionMocks.isAgentDomainAuthorized).not.toHaveBeenCalled();
  });

  it.each(['https://content.example/', 'http://content.example/', 'ftp://content.example/'])(
    'still requires domain authorization for network targets: %s',
    async url => {
      bridge = new AgentBridge(new Map());
      const internals = bridge as any;
      permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);
      vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url } as chrome.tabs.Tab);
      await expect(internals.assertAgentActionAuthorized('tab_open', { url })).rejects.toThrow(
        'Access to "content.example" is not authorized',
      );
      await expect(
        internals.assertAgentActionAuthorized('page_snapshot', { tabId: 1 }),
      ).rejects.toThrow('Access to "content.example" is not authorized');
    },
  );

  it('reports domain permission failures before dispatch with structured details', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);
    const sendToAgent = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
    const dispatch = vi.spyOn(internals, 'dispatchSingleAction');
    await internals.handleAgentMessage({
      id: 'blocked-upload',
      action: '__send_request_files',
      trustedInternal: true,
      data: { operation: 'start', url: 'https://content.example/upload', withCookies: false },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(sendToAgent).toHaveBeenCalledWith({
      id: 'blocked-upload',
      success: false,
      error: expect.stringContaining('Access to "content.example" is not authorized'),
      errorDetails: {
        code: 'DOMAIN_PERMISSION_REQUIRED',
        action: '__send_request_files',
        domain: 'content.example',
        requestDispatched: false,
      },
    });
  });

  it.each(['get_cookie', 'set_cookie'])(
    'authorizes %s against the explicit target URL',
    async action => {
      bridge = new AgentBridge(new Map());
      const internals = bridge as any;
      permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);
      await expect(
        internals.assertAgentActionAuthorized(action, {
          tabId: 1,
          url: 'https://cookie.example/',
        }),
      ).rejects.toThrow('Access to "cookie.example" is not authorized');
      expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('cookie.example');
      expect(chrome.tabs.get).not.toHaveBeenCalled();
    },
  );

  it('sets a browser-scoped cookie without preparing an implicit tab', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    vi.spyOn(internals, 'canHandleAgentActions').mockReturnValue(true);
    const dispatch = vi
      .spyOn(internals, 'dispatchSingleAction')
      .mockResolvedValue({ reloaded: false });
    await internals.handleAgentMessage({
      type: 'request',
      id: 'cookie-default',
      action: 'set_cookie',
      data: { url: 'https://cookie.example/', name: 'feature_flag', value: '1' },
    });
    expect(dispatch).toHaveBeenCalled();
    expect(actionTargetMocks.prepareTabForAgent).not.toHaveBeenCalled();
  });

  it('authorizes both the cookie URL and the reload target before dispatch', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    permissionMocks.isAgentDomainAuthorized.mockImplementation(
      async domain => domain === 'cookie.example',
    );
    await expect(
      internals.assertAgentActionAuthorized('set_cookie', {
        tabId: 1,
        url: 'https://cookie.example/',
        reload: true,
      }),
    ).rejects.toThrow('Access to "example.com" is not authorized');
    expect(permissionMocks.isAgentDomainAuthorized.mock.calls).toEqual([
      ['cookie.example'],
      ['example.com'],
    ]);
  });

  it.each(['get_cookie', 'set_cookie'])(
    'uses a tab cookie store for %s without preparing the page',
    async action => {
      bridge = new AgentBridge(new Map());
      const internals = bridge as any;
      vi.spyOn(internals, 'canHandleAgentActions').mockReturnValue(true);
      const dispatch = vi
        .spyOn(internals, 'dispatchSingleAction')
        .mockResolvedValue({ found: false });
      await internals.handleAgentMessage({
        type: 'request',
        id: 'cookie-context',
        action,
        data: { tabId: 1, url: 'https://cookie.example/', name: 'feature_flag', value: '1' },
      });
      expect(dispatch).toHaveBeenCalled();
      expect(actionTargetMocks.prepareTabForAgent).not.toHaveBeenCalled();
    },
  );

  it('prepares a cookie reload only after both target domains are authorized', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    vi.spyOn(internals, 'canHandleAgentActions').mockReturnValue(true);
    const dispatch = vi
      .spyOn(internals, 'dispatchSingleAction')
      .mockResolvedValue({ reloaded: true });
    await internals.handleAgentMessage({
      type: 'request',
      id: 'cookie-reload',
      action: 'set_cookie',
      data: {
        tabId: 1,
        url: 'https://cookie.example/',
        name: 'feature_flag',
        value: '1',
        reload: true,
      },
    });
    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('cookie.example');
    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('example.com');
    expect(dispatch).toHaveBeenCalled();
    expect(actionTargetMocks.prepareTabForAgent).toHaveBeenCalledExactlyOnceWith(1, 'local');
  });

  it('authorizes file uploads even when browser cookies are disabled', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;

    await internals.assertAgentActionAuthorized('__send_request_files', {
      operation: 'start',
      url: 'https://content.example/upload',
      withCookies: false,
    });

    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('content.example');
  });

  it('authorizes inline binary uploads even when browser cookies are disabled', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);

    await expect(
      internals.assertAgentActionAuthorized('send_request', {
        url: 'https://content.example/upload',
        method: 'POST',
        withCookies: false,
        bodyFile: { base64: 'AP8=' },
      }),
    ).rejects.toThrow('Access to "content.example" is not authorized');
    expect(permissionMocks.isAgentDomainAuthorized).toHaveBeenCalledWith('content.example');

    permissionMocks.isAgentDomainAuthorized.mockClear();
    await internals.assertAgentActionAuthorized('send_request', {
      url: 'https://content.example/image.png',
      withCookies: false,
    });
    expect(permissionMocks.isAgentDomainAuthorized).not.toHaveBeenCalled();
  });

  it('allows only trusted transferred file requests inside run_actions', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const data = {
      tabId: 1,
      actions: [
        {
          action: 'send_request',
          data: {
            transferId: 'transfer-1',
            url: 'https://content.example/upload',
            method: 'POST',
          },
        },
      ],
    };
    const ctx = {
      queryPanel: vi.fn(),
      getActiveTabId: vi.fn().mockReturnValue(1),
    };

    const rejected = await internals.handleRunActions(data, ctx, 'local', false);
    expect(rejected.error).toContain(
      'File transfer references require a trusted native-host request',
    );

    const accepted = await internals.handleRunActions(data, ctx, 'local', true);
    expect(accepted).toMatchObject({
      completedSteps: 1,
      results: [{ action: 'send_request', success: true, data: { status: 200 } }],
    });
    expect(httpHandlerMocks.handleSendRequest).toHaveBeenCalledWith(
      expect.objectContaining(data.actions[0].data),
    );
  });

  it.each([{ transferId: 'transfer-1' }, { binaryBody: true }])(
    'rejects public send_request transfer metadata before dispatch: %j',
    async fields => {
      bridge = new AgentBridge(new Map());
      const internals = bridge as any;
      const sendToAgent = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
      await internals.handleAgentMessage({
        id: 'public-reference',
        action: 'send_request',
        trustedInternal: false,
        data: { url: 'https://example.test/upload', withCookies: false, ...fields },
      });
      expect(sendToAgent).toHaveBeenCalledWith({
        id: 'public-reference',
        success: false,
        error: 'File transfer references require a trusted native-host request',
      });
      expect(httpHandlerMocks.handleSendRequest).not.toHaveBeenCalled();
    },
  );

  it('checks the transfer destination even for trusted cookie-free send_request calls', async () => {
    bridge = new AgentBridge(new Map());
    const internals = bridge as any;
    const sendToAgent = vi.spyOn(internals, 'sendToAgent').mockImplementation(() => {});
    const data = {
      url: 'https://destination.example/upload',
      withCookies: false,
      transferId: 'transfer-1',
    };
    permissionMocks.isAgentDomainAuthorized.mockResolvedValue(false);
    await internals.handleAgentMessage({
      id: 'trusted-transfer',
      action: 'send_request',
      trustedInternal: true,
      data,
    });
    expect(sendToAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        success: false,
        errorDetails: {
          code: 'DOMAIN_PERMISSION_REQUIRED',
          action: 'send_request',
          domain: 'destination.example',
          requestDispatched: false,
        },
      }),
    );
    expect(httpHandlerMocks.handleSendRequest).not.toHaveBeenCalled();
    permissionMocks.isAgentDomainAuthorized.mockResolvedValue(true);
    await internals.handleAgentMessage({
      id: 'trusted-transfer',
      action: 'send_request',
      trustedInternal: true,
      data,
    });
    expect(httpHandlerMocks.handleSendRequest).toHaveBeenCalledExactlyOnceWith(data);
  });
});
