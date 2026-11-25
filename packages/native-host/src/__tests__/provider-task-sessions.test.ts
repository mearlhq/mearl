import { describe, expect, it, vi } from 'vitest';
import { ProviderTaskSessions } from '../provider-task-sessions.js';
import type { BrowserRecord } from '../browser-registry.js';

const browser: BrowserRecord = {
  browserId: 'provider:fixture:local',
  browserName: 'Fixture',
  pid: 10,
  socketPath: '/fixture.sock',
  transport: 'provider',
  providerBrowserId: 'local',
  provider: { id: 'fixture', name: 'Fixture', builtin: false, protocolVersion: 3 },
  status: 'connected',
  startedAt: 'now',
  updatedAt: 0,
  details: { taskSessionScope: 'browser' },
};
const task: BrowserRecord = {
  ...browser,
  browserId: 'provider:fixture:task-8',
  providerBrowserId: 'task-8',
  details: { taskSessionScope: 'session', taskSessionBrowserId: 'local' },
  references: [{ kind: 'workspace', id: '8' }],
};
const extension: BrowserRecord = {
  ...browser,
  browserId: 'extension',
  transport: 'extension',
  pid: 11,
};

function fixture(withExtension = true, created = false) {
  const tabs = [{ tabId: 1, url: 'about:blank' }];
  const request = vi.fn(async (_target, action, data) => {
    if (action === 'tab_list') return { tabs };
    if (action === 'tab_open') {
      tabs.push({ tabId: 2, url: data.url });
      return { tabId: 2, opened: true };
    }
    if (action === 'get_capabilities')
      return { actions: ['tab_list', 'tab_open', 'page_inspect', 'get_cookie'] };
    return {};
  });
  const browsers = [
    browser,
    created ? { ...task, details: { ...task.details, taskSessionCreated: true } } : task,
    extension,
  ];
  const invokeExtension = vi.fn(async () => ({ snapshot: 'from extension' }));
  const authorizeOpen = vi.fn(async () => {});
  const reserveExtensionPage = vi.fn(async () => {});
  const updateExtension = vi.fn(async () => {});
  const open = vi.fn(async () => task.browserId);
  const service = new ProviderTaskSessions({
    browsers: () => browsers,
    open,
    request,
    invokeExtension,
    authorizeOpen,
    reserveExtensionPage,
    updateExtension,
    findExtension: vi.fn(async () => (withExtension ? extension : undefined)),
    notify: vi.fn(),
  });
  const invoke = (action: string, data: Record<string, any>, id?: string) =>
    service.invoke(browser, action, data, id, 'remote');
  return {
    invoke,
    request,
    invokeExtension,
    authorizeOpen,
    reserveExtensionPage,
    updateExtension,
    open,
    service,
    browsers,
    tabs,
  };
}

describe('Provider task sessions', () => {
  it('keeps the visible browser stable and delegates page operations to the matched extension', async () => {
    const {
      invoke,
      request,
      open,
      invokeExtension,
      reserveExtensionPage,
      updateExtension,
      service,
    } = fixture();
    const { session } = await invoke('session_manage', {
      operation: 'new',
      providerOptions: { name: 'task' },
    });
    expect(open).toHaveBeenCalledWith(browser, { name: 'task' }, undefined);
    expect(session).toMatchObject({
      browserId: browser.browserId,
      task: { reference: { id: '8' }, pageTransport: 'extension' },
    });
    await expect(invoke('page_snapshot', { tabId: 1 }, session.sessionId)).resolves.toMatchObject({
      snapshot: 'from extension',
      session: { sessionId: session.sessionId },
    });
    expect(invokeExtension).toHaveBeenCalledWith(
      task,
      extension,
      'page_snapshot',
      { tabId: 1 },
      'remote',
      undefined,
    );
    await invoke('tab_open', { url: 'https://example.test' }, session.sessionId);
    await invoke('session_manage', { operation: 'handoff' }, session.sessionId);
    await expect(invoke('page_snapshot', { tabId: 1 }, session.sessionId)).rejects.toThrow(
      'CONTROL_SESSION_PAUSED',
    );
    expect(invokeExtension).toHaveBeenCalledTimes(1);
    await invoke('session_manage', { operation: 'resume' }, session.sessionId);
    await invoke('session_manage', { operation: 'end' }, session.sessionId);
    expect(reserveExtensionPage.mock.calls.map(call => call[2])).toEqual([1, 2]);
    expect(updateExtension.mock.calls.map(call => call[2])).toEqual([
      { operation: 'deactivate' },
      { operation: 'cleanup', preserveEnvironment: true, returningToAgent: true },
      { operation: 'cleanup', preserveEnvironment: true, returningToAgent: false },
    ]);
    expect(
      request.mock.calls.filter(call => call[1] === 'browser_control').map(call => call[2]),
    ).toEqual([
      { operation: 'handoff' },
      { operation: 'resume' },
      { operation: 'finish', keepTabIds: [1] },
    ]);
    expect(service.find(session.sessionId)).toBeUndefined();
  });

  it('uses the Provider without an extension and pauses when the native owner takes control', async () => {
    const { invoke, request, invokeExtension, service } = fixture(false);
    const { session } = await invoke('session_manage', { operation: 'new' });
    expect(session.task.pageTransport).toBe('provider');
    request.mockRejectedValueOnce(new Error('EXTERNAL_CONTROL_PAUSED: user owns the task'));
    await expect(
      invoke('page_click', { tabId: 1, selector: 'button' }, session.sessionId),
    ).rejects.toThrow('EXTERNAL_CONTROL_PAUSED');
    expect(service.find(session.sessionId)?.status).toBe('user');
    await invoke('session_manage', { operation: 'resume' }, session.sessionId);
    expect(service.find(session.sessionId)?.status).toBe('active');
    expect(invokeExtension).not.toHaveBeenCalled();
  });

  it('does not replay a failed extension operation through the Provider', async () => {
    const { invoke, request, invokeExtension } = fixture();
    const { session } = await invoke('session_manage', { operation: 'new' });
    invokeExtension.mockRejectedValueOnce(new Error('CONTROL_SESSION_TRANSPORT_UNAVAILABLE'));
    await expect(
      invoke('page_click', { tabId: 1, selector: 'button' }, session.sessionId),
    ).rejects.toThrow('CONTROL_SESSION_TRANSPORT_UNAVAILABLE');
    expect(request.mock.calls.some(call => call[1] === 'page_click')).toBe(false);
  });

  it.each([true, false])(
    'pauses a batch when its page route reports native handoff (extension %s)',
    async withExtension => {
      const { invoke, request, invokeExtension, service } = fixture(withExtension);
      const { session } = await invoke('session_manage', { operation: 'new' });
      const route = withExtension ? invokeExtension : request;
      route.mockRejectedValueOnce(new Error('EXTERNAL_CONTROL_PAUSED: user owns the task'));
      await expect(
        invoke(
          'run_actions',
          {
            tabId: 1,
            actions: [
              { action: 'page_click', data: { selector: 'button' } },
              { action: 'page_snapshot' },
            ],
          },
          session.sessionId,
        ),
      ).resolves.toMatchObject({ completedSteps: 0, failedStep: 0, session: { status: 'user' } });
      expect(service.find(session.sessionId)?.status).toBe('user');
      expect(route).toHaveBeenCalledTimes(withExtension ? 1 : 2);
    },
  );

  it('authorizes the first destination before the Provider creates a tab', async () => {
    const { invoke, request, authorizeOpen } = fixture();
    const { session } = await invoke('session_manage', { operation: 'new' });
    authorizeOpen.mockRejectedValueOnce(new Error('Agent domain denied'));
    const url = 'https://example.test';
    await expect(invoke('tab_open', { url }, session.sessionId)).rejects.toThrow(
      'Agent domain denied',
    );
    expect(authorizeOpen).toHaveBeenCalledWith(task, extension, url, 'remote', undefined);
    expect(request.mock.calls.map(([, action]) => action)).toEqual(['tab_list']);
    await expect(
      invoke('tab_open', { url, emulation: { preset: 'iphone-17-pro' } }, session.sessionId),
    ).rejects.toThrow('Set device or App emulation after opening the task page');
    expect(authorizeOpen).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'cleans up an implicit session when its first action fails (new task %s)',
    async created => {
      const { invoke, request, authorizeOpen, service } = fixture(true, created);
      authorizeOpen.mockRejectedValueOnce(new Error('Agent domain denied'));
      await expect(invoke('tab_open', { url: 'https://example.test' }, 'new')).rejects.toThrow(
        'Agent domain denied',
      );
      expect(request.mock.calls.at(-1)?.slice(1, 3)).toEqual(
        created
          ? ['browser_control', { operation: 'finish', keepTabIds: [] }]
          : ['browser_instances', { operation: 'detach' }],
      );
      expect(service.list()).toEqual([]);
    },
  );

  it('rejects task targets published for another provider browser', async () => {
    const { invoke, request, browsers } = fixture();
    browsers[1] = { ...task, details: { ...task.details, taskSessionBrowserId: 'other' } };
    await expect(invoke('session_manage', { operation: 'new' })).rejects.toThrow(
      'did not publish its task session target',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('limits the hybrid route to extension page actions and provider tab lifecycle', async () => {
    const { invoke, request } = fixture();
    const { session } = await invoke('session_manage', { operation: 'new' });
    const result = await invoke('get_capabilities', {}, session.sessionId);
    expect(result.actions).toContain('page_snapshot');
    expect(result.actions).not.toContain('get_cookie');
    await expect(invoke('page_inspect', { tabId: 1 }, session.sessionId)).rejects.toThrow(
      'page_inspect is unavailable on the extension task route',
    );
    expect(request.mock.calls.map(([, action]) => action)).toEqual([
      'tab_list',
      'get_capabilities',
    ]);
  });

  it('requires saving artifacts before ending a provider task session', async () => {
    const { invoke, service, request } = fixture();
    const { session } = await invoke('session_manage', { operation: 'new' });
    await expect(
      invoke(
        'session_manage',
        { operation: 'end', keepArtifactIds: ['recording'] },
        session.sessionId,
      ),
    ).rejects.toThrow('Save artifacts before ending');
    expect(service.find(session.sessionId)?.status).toBe('active');
    expect(request.mock.calls.map(([, action]) => action)).toEqual(['tab_list']);
  });

  it('rejects lifecycle commands addressed to a new session before opening a native task', async () => {
    const { invoke, open } = fixture();
    await expect(invoke('session_manage', { operation: 'handoff' }, 'new')).rejects.toThrow(
      'Invalid request',
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('honors shared tab matching semantics for reuse within a task', async () => {
    const { invoke, tabs, request, reserveExtensionPage } = fixture();
    const { session } = await invoke('session_manage', { operation: 'new' });
    const url = 'https://example.test';
    tabs.push({ tabId: 2, url }, { tabId: 3, url });
    await expect(invoke('tab_open', { url }, session.sessionId)).rejects.toThrow(
      'matched 2 existing tabs',
    );
    await expect(
      invoke('tab_open', { url, match: { onMultiple: 'first' } }, session.sessionId),
    ).resolves.toMatchObject({ tabId: 2, opened: false, reused: true });
    expect(request.mock.calls.some(([, action]) => action === 'tab_open')).toBe(false);
    expect(reserveExtensionPage.mock.calls.map(call => call[2])).toEqual([1, 2]);
  });

  it('can retry resume after extension cleanup fails following native resume', async () => {
    const { invoke, request, updateExtension, service } = fixture();
    const { session } = await invoke('session_manage', { operation: 'new' });
    await invoke('session_manage', { operation: 'handoff' }, session.sessionId);
    updateExtension.mockRejectedValueOnce(new Error('Extension cleanup failed'));
    await expect(
      invoke('session_manage', { operation: 'resume' }, session.sessionId),
    ).rejects.toThrow('Extension cleanup failed');
    expect(service.find(session.sessionId)?.status).toBe('user');
    await expect(
      invoke('session_manage', { operation: 'resume' }, session.sessionId),
    ).resolves.toMatchObject({ session: { status: 'active' } });
    expect(
      request.mock.calls.filter(
        ([, action, data]) => action === 'browser_control' && data.operation === 'resume',
      ),
    ).toHaveLength(2);
  });
});
