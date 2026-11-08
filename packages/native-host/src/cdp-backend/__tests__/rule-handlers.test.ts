import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpSession, PageSession } from '../cdp-session.js';
import { clearCdpFetchInterceptionState } from '../fetch-interceptor.js';
import { cdpGetRules, cdpSetRule, clearCdpRuleState } from '../rule-handlers.js';

const audience = 'https://identity.example.com/api';
const target = 'https://identity.example.com/identity/api/auth-info/whoami';
const filter = '^https://identity\\.example\\.com/identity/api(?:[/?]|$)';

function createPage(targetId: string) {
  const listeners = new Map<string, (params: any) => Promise<void> | void>();
  const sendCommand = vi.fn(async (method: string) =>
    method === 'Page.getFrameTree' ? { frameTree: { frame: { id: `${targetId}-main` } } } : {},
  );
  const page = {
    targetId,
    tabId: 1000,
    url: 'about:blank',
    client: {
      closed: false,
      sendCommand,
      on: vi.fn((event: string, listener: (params: any) => Promise<void> | void) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      }),
    },
  } as unknown as PageSession;
  return { page, sendCommand, listeners };
}

function createBrowser(pages = [createPage('existing')]) {
  const browserListeners = new Map<string, (params: any) => void>();
  const connectionListeners = new Set<() => void>();
  const browserSendCommand = vi.fn(async () => ({}));
  const initializers: Array<(page: PageSession) => Promise<void>> = [];
  const session = {
    getBrowserClient: vi.fn(async () => ({
      sendCommand: browserSendCommand,
      on: vi.fn((event: string, listener: (params: any) => void) => {
        browserListeners.set(event, listener);
        return () => browserListeners.delete(event);
      }),
    })),
    addPageSessionInitializer: vi.fn((initializer: (page: PageSession) => Promise<void>) => {
      initializers.push(initializer);
      return () => initializers.splice(initializers.indexOf(initializer), 1);
    }),
    onBrowserConnected: vi.fn((listener: () => void) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    }),
    attachOpenPageTargets: vi.fn(async () => {}),
    listOpenPageSessions: vi.fn(() => pages.map(item => item.page)),
    ensureTargetRegistered: vi.fn(async () => 1001),
    getPageSession: vi.fn(async () => pages[0].page),
  } as unknown as CdpSession;
  return {
    session,
    pages,
    browserListeners,
    browserSendCommand,
    connectionListeners,
    initializers,
  };
}

const rule = {
  actionType: 'modifyHeaders' as const,
  filter,
  requestHeaders: [
    { header: 'Agent-Proof-Token-Audience', operation: 'set' as const, value: audience },
  ],
  resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'],
  priority: 150,
};

afterEach(() => clearCdpFetchInterceptionState());

describe('CDP request header rules', () => {
  it('returns rules and attaches the audience header to document, iframe, and fetch requests', async () => {
    const { session, pages, browserSendCommand } = createBrowser();
    const { sendCommand, listeners } = pages[0];
    try {
      await expect(cdpSetRule(session, rule)).resolves.toMatchObject({ success: true, ruleId: 1 });
      expect(browserSendCommand).toHaveBeenCalledWith('Target.setDiscoverTargets', {
        discover: true,
      });
      expect(sendCommand).toHaveBeenCalledWith('Fetch.enable', expect.any(Object));
      await expect(cdpGetRules(session)).resolves.toMatchObject({
        enabled: true,
        rules: [
          { ruleId: 1, actionType: 'modifyHeaders', filter, requestHeaders: rule.requestHeaders },
        ],
      });

      const paused = listeners.get('Fetch.requestPaused');
      for (const [resourceType, frameId] of [
        ['Document', 'existing-main'],
        ['Document', 'iframe'],
        ['Fetch', 'existing-main'],
        ['XHR', 'existing-main'],
      ]) {
        await paused?.({
          requestId: `${resourceType}-${frameId}`,
          resourceType,
          frameId,
          request: {
            url: target,
            headers: { Accept: 'application/json', 'agent-proof-token-audience': 'old' },
          },
        });
        expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
          requestId: `${resourceType}-${frameId}`,
          headers: expect.arrayContaining([
            { name: 'Accept', value: 'application/json' },
            { name: 'Agent-Proof-Token-Audience', value: audience },
          ]),
        });
      }
      await paused?.({
        requestId: 'unmatched',
        resourceType: 'Document',
        frameId: 'existing-main',
        request: {
          url: 'https://identity.example.com/identity/api2/whoami',
          headers: {},
        },
      });
      expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
        requestId: 'unmatched',
      });
      await paused?.({
        requestId: 'response',
        resourceType: 'Document',
        frameId: 'existing-main',
        request: { url: target },
        responseStatusCode: 200,
      });
      expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueResponse', {
        requestId: 'response',
      });
    } finally {
      clearCdpRuleState(session);
    }
  });

  it('adds rules to later page sessions and reuses the shared Fetch interceptor', async () => {
    const { session, initializers, browserListeners } = createBrowser();
    try {
      await cdpSetRule(session, rule);
      const next = createPage('new');
      await initializers[0](next.page);
      await next.listeners.get('Fetch.requestPaused')?.({
        requestId: 'new-document',
        resourceType: 'Document',
        frameId: 'new-main',
        request: { url: target, headers: {} },
      });
      expect(next.sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
        requestId: 'new-document',
        headers: [{ name: 'Agent-Proof-Token-Audience', value: audience }],
      });
      browserListeners.get('Target.targetCreated')?.({
        targetInfo: { type: 'page', targetId: 'new', url: 'about:blank' },
      });
      expect(session.ensureTargetRegistered).toHaveBeenCalledWith('new');
      browserListeners.get('Target.targetDestroyed')?.({ targetId: 'new' });
      expect(next.listeners.has('Page.frameNavigated')).toBe(false);
    } finally {
      clearCdpRuleState(session);
    }
  });

  it('uses the configured resource type and higher-priority header value', async () => {
    const { session, pages } = createBrowser();
    const { sendCommand, listeners } = pages[0];
    try {
      await cdpSetRule(session, { ...rule, priority: 1 });
      await cdpSetRule(session, {
        ...rule,
        priority: 2,
        resourceTypes: ['main_frame'],
        requestHeaders: [
          {
            header: 'Agent-Proof-Token-Audience',
            operation: 'set',
            value: 'https://override.example/api',
          },
        ],
      });
      const paused = listeners.get('Fetch.requestPaused');
      await paused?.({
        requestId: 'main',
        resourceType: 'Document',
        frameId: 'existing-main',
        request: { url: target, headers: {} },
      });
      expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
        requestId: 'main',
        headers: [{ name: 'Agent-Proof-Token-Audience', value: 'https://override.example/api' }],
      });
      await paused?.({
        requestId: 'iframe',
        resourceType: 'Document',
        frameId: 'iframe',
        request: { url: target, headers: {} },
      });
      expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
        requestId: 'iframe',
        headers: [{ name: 'Agent-Proof-Token-Audience', value: audience }],
      });
    } finally {
      clearCdpRuleState(session);
    }
  });

  it('removes rules by ID and releases interception after the last rule', async () => {
    const { session, pages } = createBrowser();
    const { sendCommand, listeners } = pages[0];
    try {
      await cdpSetRule(session, rule);
      await cdpSetRule(session, {
        ...rule,
        priority: 200,
        requestHeaders: [
          { header: 'Agent-Proof-Token-Audience', operation: 'set', value: 'override' },
        ],
      });
      await expect(cdpSetRule(session, { ruleId: 2, enabled: false })).resolves.toMatchObject({
        affectedCount: 1,
      });
      await expect(cdpGetRules(session)).resolves.toMatchObject({
        rules: [{ ruleId: 1 }],
      });
      await listeners.get('Fetch.requestPaused')?.({
        requestId: 'after-removal',
        resourceType: 'Document',
        frameId: 'existing-main',
        request: { url: target, headers: {} },
      });
      expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
        requestId: 'after-removal',
        headers: [{ name: 'Agent-Proof-Token-Audience', value: audience }],
      });

      await expect(cdpSetRule(session, { ruleId: 1, enabled: false })).resolves.toMatchObject({
        affectedCount: 1,
      });
      await expect(cdpSetRule(session, { ruleId: 1, enabled: false })).resolves.toMatchObject({
        affectedCount: 0,
      });
      await expect(cdpGetRules(session)).resolves.toEqual({ enabled: true, rules: [] });
      expect(sendCommand).toHaveBeenCalledWith('Fetch.disable', {});
    } finally {
      clearCdpRuleState(session);
    }
  });

  it('rejects unsupported rule operations before changing browser state', async () => {
    const { session } = createBrowser();
    await expect(cdpSetRule(session, { ...rule, actionType: 'block' })).rejects.toThrow(
      'modifyHeaders request headers only',
    );
    await expect(
      cdpSetRule(session, {
        ...rule,
        responseHeaders: [{ header: 'X-Test', operation: 'set', value: 'x' }],
      }),
    ).rejects.toThrow('does not support responseHeaders');
    await expect(
      cdpSetRule(session, {
        ...rule,
        requestHeaders: [{ header: 'X-Test', operation: 'append', value: 'x' }],
      }),
    ).rejects.toThrow('set operations');
    expect(session.getBrowserClient).not.toHaveBeenCalled();
    await expect(cdpGetRules(session)).resolves.toEqual({ enabled: true, rules: [] });
  });

  it('removes listeners and the rule when Fetch interception cannot start', async () => {
    const { session, pages, browserListeners } = createBrowser();
    const { sendCommand, listeners } = pages[0];
    sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Fetch.enable') throw new Error('Fetch unavailable');
      return method === 'Page.getFrameTree'
        ? { frameTree: { frame: { id: 'existing-main' } } }
        : {};
    });
    await expect(cdpSetRule(session, rule)).rejects.toThrow('Fetch unavailable');
    await expect(cdpGetRules(session)).resolves.toEqual({ enabled: true, rules: [] });
    expect(browserListeners.has('Target.targetCreated')).toBe(false);
    expect(listeners.has('Page.frameNavigated')).toBe(false);
  });

  it('drops session rules when the CDP browser connection is replaced', async () => {
    const { session, pages, connectionListeners, browserListeners } = createBrowser();
    await cdpSetRule(session, rule);
    for (const listener of [...connectionListeners]) listener();

    await expect(cdpGetRules(session)).resolves.toEqual({ enabled: true, rules: [] });
    expect(browserListeners.has('Target.targetCreated')).toBe(false);
    expect(pages[0].listeners.has('Page.frameNavigated')).toBe(false);
  });

  it('does not report success if the connection changes during installation', async () => {
    const { session, connectionListeners } = createBrowser();
    vi.mocked(session.attachOpenPageTargets).mockImplementation(async () => {
      for (const listener of [...connectionListeners]) listener();
    });

    await expect(cdpSetRule(session, rule)).rejects.toThrow('connection changed');
    await expect(cdpGetRules(session)).resolves.toEqual({ enabled: true, rules: [] });
  });
});
