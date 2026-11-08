import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../shared/proxyPermissions', () => ({
  isAgentDomainAuthorized: vi.fn().mockResolvedValue(true),
}));
vi.mock('../toolboxPageFrame', () => ({ resolveToolboxPageFrame: vi.fn().mockResolvedValue(12) }));
import { isAgentDomainAuthorized } from '../../../shared/proxyPermissions';
import { PluginPageHost } from '../pluginPageHost';

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    addListener: (fn: any) => listeners.add(fn),
    removeListener: (fn: any) => listeners.delete(fn),
    fire: (...args: any[]) => [...listeners].forEach(fn => fn(...args)),
  };
}
let session: Record<string, any>,
  local: Record<string, any>,
  api: any,
  native: ReturnType<typeof vi.fn<(action: string, data: Record<string, unknown>) => Promise<any>>>,
  host: PluginPageHost;
let connected: ReturnType<typeof event>, committed: ReturnType<typeof event>;
let documentId: string;
const installationId = '00000000-0000-4000-8000-000000000003';
let serviceOwner: { hostId: string; epoch: string }, lastReceived: number;
const eventCalls = () =>
  native.mock.calls.filter(([, data]) => (data.input as any)?.kind === 'event');
const reply = async (_action: string, data: Record<string, any>) => {
  if (data.input?.kind === 'sync')
    return {
      host: serviceOwner,
      instances: data.input.instances.map((instance: any) => ({ instance, lastReceived })),
    };
  if (data.input?.kind === 'event') lastReceived = data.input.eventSequence;
  return { accepted: true };
};
const id = 'pi_00000000-0000-4000-8000-000000000001';
const runtime = {
  version: 1,
  matches: ['https://example.test/*'],
  code: 'host => ({ receive: message => message })',
  events: { state: { command: 'save', schema: { type: 'object' } } },
};
async function attach(extra = {}) {
  const target = await host.handle({ operation: 'resolve', tabId: 7 });
  return host.handle({
    operation: 'attach',
    instance: {
      instanceId: id,
      plugin: 'fixture',
      installationId,
      revision: 'revision-one',
      host: { ...serviceOwner },
      target,
      state: 'active',
    },
    runtime,
    ...extra,
  });
}
function port(token: string, doc = documentId) {
  const disconnected = event();
  return {
    name: `mearl-plugin-page:${id}:${token}`,
    sender: { tab: { id: 7 }, frameId: 12, documentId: doc },
    onMessage: event(),
    onDisconnect: disconnected,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => disconnected.fire()),
  };
}
function storage(values: Record<string, any>) {
  return {
    get: vi.fn(async () => structuredClone(values)),
    set: vi.fn(async (patch: any) => Object.assign(values, structuredClone(patch))),
  };
}
beforeEach(() => {
  session = {};
  local = {};
  documentId = 'document-one';
  connected = event();
  committed = event();
  serviceOwner = { hostId: 'execution-host', epoch: 'epoch-one' };
  lastReceived = 0;
  native = vi.fn(reply);
  api = {
    configureWorld: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(async ({ target }: any) => [
      { frameId: 12, documentId: target.documentIds[0], result: { ok: true, value: null } },
    ]),
  };
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('chrome', {
    runtime: { onUserScriptConnect: connected },
    userScripts: api,
    storage: { session: storage(session), local: storage(local) },
    tabs: { query: vi.fn().mockResolvedValue([]), onRemoved: event() },
    webNavigation: {
      getFrame: vi.fn(async () => ({
        frameId: 12,
        documentId,
        documentLifecycle: 'active',
        url: 'https://example.test/page',
      })),
      onCommitted: committed,
      onCompleted: event(),
      onHistoryStateUpdated: event(),
      onReferenceFragmentUpdated: event(),
    },
  });
  vi.mocked(isAgentDomainAuthorized).mockResolvedValue(true);
  host = new PluginPageHost(native);
});
afterEach(() => {
  host.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('requires both file permissions to resolve a local preview in the main frame', async () => {
  const url = 'file:///home/example/.mearl/plugin-previews/fixture/preview.html';
  vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({ documentId, documentLifecycle: 'active', url } as never);
  const fileAccess = vi.fn().mockResolvedValue(false);
  const contains = vi.fn().mockResolvedValue(false);
  Object.assign(chrome, { extension: { isAllowedFileSchemeAccess: fileAccess }, permissions: { contains } });
  const resolve = { operation: 'resolve', tabId: 7, frame: 'main' };
  await expect(host.handle(resolve)).rejects.toThrow('DOMAIN_PERMISSION_REQUIRED');
  fileAccess.mockResolvedValue(true);
  await expect(host.handle(resolve)).rejects.toThrow('DOMAIN_PERMISSION_REQUIRED');
  contains.mockResolvedValue(true);
  await expect(host.handle(resolve)).resolves.toMatchObject({ url, documentId });
  await expect(host.handle({ ...resolve, frame: 12 })).rejects.toThrow('HTTP(S)');
});

describe('browser document runtime host', () => {
  it('atomically patches persistent activation matches across concurrent callers and removes the final rule', async () => {
    const patch = (matchPatch: Record<string, string[]>) =>
      host.handle({
        operation: 'activation',
        plugin: 'fixture',
        installationId,
        enabled: true,
        allowedMatches: runtime.matches,
        persistence: 'persistent',
        matchPatch,
      });
    await Promise.all([
      patch({ add: ['https://example.test/*'] }),
      patch({ add: ['https://another.test/*'] }),
    ]);
    expect(
      ((await host.handle({ operation: 'activation', plugin: 'fixture' })) as any).activation
        .matches,
    ).toEqual(['https://another.test/*', 'https://example.test/*']);
    await patch({ remove: ['https://example.test/*'] });
    expect(local['pluginPageActivations.v1'][0].matches).toEqual(['https://another.test/*']);
    host.dispose();
    host = new PluginPageHost(native);
    expect(
      ((await host.handle({ operation: 'activation', plugin: 'fixture' })) as any).activation
        .matches,
    ).toEqual(['https://another.test/*']);
    await patch({ remove: ['https://another.test/*'] });
    expect(await host.handle({ operation: 'activation', plugin: 'fixture' })).toEqual({
      activation: null,
    });
    expect(local['pluginPageActivations.v1']).toEqual([]);
  });
  it.each([
    {},
    { add: 'https://example.test/*' },
    { remove: ['file://*/*'] },
    { add: [], unknown: [] },
  ])('rejects malformed activation match patches: %j', async matchPatch => {
    await expect(
      host.handle({
        operation: 'activation',
        plugin: 'fixture',
        installationId,
        enabled: true,
        allowedMatches: runtime.matches,
        matchPatch,
      }),
    ).rejects.toThrow('match patch');
    expect(await host.handle({ operation: 'activation', plugin: 'fixture' })).toEqual({
      activation: null,
    });
  });
  it('does not inherit activation ranges from a replaced installation when applying a patch', async () => {
    const request = {
      operation: 'activation',
      plugin: 'fixture',
      enabled: true,
      allowedMatches: runtime.matches,
    };
    await host.handle({ ...request, installationId, matches: ['https://example.test/*'] });
    const result = (await host.handle({
      ...request,
      installationId: '11111111-1111-1111-1111-111111111111',
      matchPatch: { add: ['https://another.test/*'] },
    })) as any;
    expect(result.activation.matches).toEqual(['https://another.test/*']);
  });
  it('retains a claimed automatic instance across range removal and persists its manual ownership', async () => {
    const request = {
      operation: 'activation',
      plugin: 'fixture',
      installationId,
      enabled: true,
      allowedMatches: runtime.matches,
    };
    await host.handle({ ...request, matchPatch: { add: runtime.matches } });
    await attach({ activationGeneration: session['pluginPageHost.v1'].generations.fixture });
    await host.handle({ operation: 'get', instanceId: id, tabId: 7 });
    expect(session['pluginPageHost.v1'].records[0].activationGeneration).toBeDefined();
    await host.handle({ operation: 'get', instanceId: id, tabId: 7, retainManual: true });
    expect(session['pluginPageHost.v1'].records[0].activationGeneration).toBeUndefined();
    await host.handle({ ...request, matchPatch: { remove: runtime.matches } });
    await expect(
      host.handle({ operation: 'get', instanceId: id, tabId: 7 }),
    ).resolves.toMatchObject({ instanceId: id });
    await host.handle({ operation: 'activation', plugin: 'fixture', enabled: false });
    expect(session['pluginPageHost.v1'].records).toHaveLength(0);
  });
  it('preserves manual instances when a match patch removes the final automatic activation range', async () => {
    await attach();
    const request = {
      operation: 'activation',
      plugin: 'fixture',
      installationId,
      enabled: true,
      allowedMatches: runtime.matches,
    };
    await host.handle({ ...request, matchPatch: { add: ['https://example.test/automatic/*'] } });
    await host.handle({ ...request, matchPatch: { remove: ['https://example.test/automatic/*'] } });
    expect(session['pluginPageHost.v1'].records).toHaveLength(1);
    await host.handle({ operation: 'activation', plugin: 'fixture', enabled: false });
    expect(session['pluginPageHost.v1'].records).toHaveLength(0);
  });
  it.each(['get', 'navigation', 'tick'])(
    'invalidates automatic instances outside the activation range on %s',
    async operation => {
      await host.handle({
        operation: 'activation',
        plugin: 'fixture',
        installationId,
        enabled: true,
        allowedMatches: runtime.matches,
        matches: ['https://example.test/page*'],
      });
      await attach({ activationGeneration: session['pluginPageHost.v1'].generations.fixture });
      vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({
        frameId: 12,
        documentId,
        documentLifecycle: 'active',
        url: 'https://example.test/private',
      } as any);
      if (operation === 'get')
        await expect(host.handle({ operation, instanceId: id, tabId: 7 })).rejects.toThrow(
          'activation URL range',
        );
      else if (operation === 'tick') await (host as any).tick();
      else
        (chrome.webNavigation.onHistoryStateUpdated as any).fire({
          tabId: 7,
          frameId: 12,
          documentId,
          url: 'https://example.test/private',
        });
      await vi.waitFor(() => expect(session['pluginPageHost.v1'].records).toHaveLength(0));
      expect(native).toHaveBeenCalledWith(
        'plugin_page_event',
        expect.objectContaining({ input: expect.objectContaining({ kind: 'invalidated' }) }),
      );
    },
  );

  it('checks activation URL bounds before injecting an automatic instance', async () => {
    await host.handle({
      operation: 'activation',
      plugin: 'fixture',
      installationId,
      enabled: true,
      allowedMatches: runtime.matches,
      matches: ['https://example.test/other*'],
    });
    await expect(
      attach({ activationGeneration: session['pluginPageHost.v1'].generations.fixture }),
    ).rejects.toThrow('activation URL range');
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('keeps manually attached instances governed by their runtime URL declaration', async () => {
    await host.handle({
      operation: 'activation',
      plugin: 'fixture',
      installationId,
      enabled: true,
      allowedMatches: runtime.matches,
      matches: ['https://example.test/other*'],
    });
    await attach();
    expect(await host.handle({ operation: 'get', instanceId: id, tabId: 7 })).toMatchObject({
      state: 'active',
    });
  });

  it('batches lightweight lease writes and restores them without rewriting runtime snapshots on reads', async () => {
    await attach({ runtime: { ...runtime, code: runtime.code + ' '.repeat(320 * 1024) } });
    await (host as any).tick();
    const originalExpiry = session['pluginPageHost.v1'].records[0].expires;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalExpiry - 20000);
    try {
      const write = vi.mocked(chrome.storage.session.set);
      write.mockClear();
      for (let index = 0; index < 20; index++)
        await host.handle({ operation: 'get', instanceId: id, tabId: 7 });
      expect(write).not.toHaveBeenCalled();
      await (host as any).tick();
      expect(write).toHaveBeenCalledOnce();
      const snapshot = write.mock.calls[0][0];
      expect(Object.keys(snapshot)).toEqual(['pluginPageLeases.v1']);
      expect(JSON.stringify(snapshot).length).toBeLessThan(1024);
      expect(session['pluginPageHost.v1'].records[0].expires).toBe(originalExpiry);
      await (host as any).tick();
      expect(write).toHaveBeenCalledOnce();
      host.dispose();
      clock.mockReturnValue(originalExpiry + 1);
      host = new PluginPageHost(native);
      await (host as any).tick();
      expect(session['pluginPageHost.v1'].records[0].expires).toBe(originalExpiry + 10000);
      expect(await host.handle({ operation: 'get', instanceId: id, tabId: 7 })).toMatchObject({
        state: 'active',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('flushes renewed leases while browser reconciliation is stalled', async () => {
    await attach();
    await (host as any).tick();
    host.dispose();
    vi.useFakeTimers();
    let release!: (value: any) => void;
    native.mockImplementation(async (action, data: any) =>
      data.input?.kind === 'sync'
        ? new Promise(resolve => {
            release = resolve;
          })
        : reply(action, data),
    );
    host = new PluginPageHost(native);
    await host.handle({ operation: 'session' });
    await vi.advanceTimersByTimeAsync(1000);
    const write = vi.mocked(chrome.storage.session.set);
    write.mockClear();
    await host.handle({ operation: 'get', instanceId: id, tabId: 7 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledOnce();
    expect(Object.keys(write.mock.calls[0][0])).toEqual(['pluginPageLeases.v1']);
    host.dispose();
    release({ host: serviceOwner, instances: [] });
    await (host as any).tick();
  });

  it('preserves records on inconclusive document probes without renewing an expired lease', async () => {
    await attach();
    await (host as any).tick();
    const record = session['pluginPageHost.v1'].records[0];
    const getFrame = vi.mocked(chrome.webNavigation.getFrame);
    const healthy = getFrame.getMockImplementation()!;
    getFrame.mockRejectedValue(new Error('Browser connection interrupted'));
    await expect(host.handle({ operation: 'get', instanceId: id, tabId: 7 })).rejects.toMatchObject(
      { code: 'PLUGIN_PAGE_UNAVAILABLE' },
    );
    await (host as any).tick();
    expect((host as any).records.size).toBe(1);
    expect(native.mock.calls.some(([, data]) => (data.input as any)?.kind === 'invalidated')).toBe(
      false,
    );
    getFrame.mockImplementation(healthy);
    await expect(
      host.handle({ operation: 'get', instanceId: id, tabId: 7 }),
    ).resolves.toMatchObject({ state: 'active' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(record.expires + 60000);
    try {
      await expect(host.handle({ operation: 'get', instanceId: id, tabId: 7 })).rejects.toThrow(
        'PLUGIN_PAGE_INVALIDATED: Plugin page execution lease expired',
      );
      expect((host as any).records.size).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('reports the user-script switch requirement without leaving an active attachment', async () => {
    api.configureWorld.mockRejectedValue(new Error('disabled'));
    await expect(attach()).rejects.toThrow('USER_SCRIPTS_DISABLED:');
    expect(session['pluginPageHost.v1'].records).toHaveLength(0);
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('targets documentIds and rejects stale documents or revoked authorization', async () => {
    await attach();
    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['document-one'] },
        world: 'USER_SCRIPT',
      }),
    );
    documentId = 'document-two';
    await expect(
      host.handle({ operation: 'send', tabId: 7, instanceId: id, message: {} }),
    ).rejects.toThrow('Document changed');
    expect(native).toHaveBeenCalledWith(
      'plugin_page_event',
      expect.objectContaining({
        input: expect.objectContaining({
          kind: 'invalidated',
          target: expect.objectContaining({ documentId: 'document-one' }),
        }),
      }),
    );
    await attach();
    vi.mocked(isAgentDomainAuthorized).mockResolvedValue(false);
    await expect(host.handle({ operation: 'get', tabId: 7, instanceId: id })).rejects.toMatchObject(
      { code: 'DOMAIN_PERMISSION_REQUIRED' },
    );
    expect((host as any).records.size).toBe(0);
  });

  it('verifies port token, frame/document, connection epoch and event sequence', async () => {
    await attach();
    const token = session['pluginPageHost.v1'].records[0].token;
    const wrong = port(token, 'other-document');
    connected.fire(wrong);
    await vi.waitFor(() => expect(wrong.disconnect).toHaveBeenCalled());
    const first = port(token);
    connected.fire(first);
    await vi.waitFor(() =>
      expect(first.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })),
    );
    const epoch = first.postMessage.mock.calls[0][0].epoch;
    first.onMessage.fire({
      type: 'event',
      epoch: 'stale',
      sequence: 1,
      name: 'state',
      payload: {},
    });
    expect(eventCalls()).toHaveLength(0);
    first.onMessage.fire({
      type: 'event',
      epoch,
      sequence: 1,
      name: 'state',
      payload: { value: 1 },
    });
    await vi.waitFor(() =>
      expect(first.postMessage).toHaveBeenCalledWith({ type: 'accepted', sequence: 1 }),
    );
    first.onMessage.fire({
      type: 'event',
      epoch,
      sequence: 1,
      name: 'state',
      payload: { value: 1 },
    });
    expect(eventCalls()).toHaveLength(1);
    const second = port(token);
    connected.fire(second);
    await vi.waitFor(() => expect(first.disconnect).toHaveBeenCalled());
    first.onMessage.fire({ type: 'event', epoch, sequence: 2, name: 'state', payload: {} });
    expect(eventCalls()).toHaveLength(1);
  });

  it('restores unacknowledged events across background-worker restart', async () => {
    native.mockRejectedValue(new Error('native bridge unavailable'));
    await attach();
    const token = session['pluginPageHost.v1'].records[0].token;
    const source = port(token);
    connected.fire(source);
    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
    source.onMessage.fire({
      type: 'event',
      epoch: source.postMessage.mock.calls[0][0].epoch,
      sequence: 1,
      name: 'state',
      payload: { value: 7 },
    });
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records[0].pending).toHaveLength(1));
    host.dispose();
    native.mockImplementation(reply);
    host = new PluginPageHost(native);
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records[0].accepted).toBe(1));
    expect(session['pluginPageHost.v1'].records[0].pending).toHaveLength(0);
  });

  it('uses the service receipt after a worker restart instead of dispatching an already accepted event', async () => {
    native.mockRejectedValue(new Error('disconnected'));
    await attach();
    const source = port(session['pluginPageHost.v1'].records[0].token);
    connected.fire(source);
    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
    source.onMessage.fire({
      type: 'event',
      epoch: source.postMessage.mock.calls[0][0].epoch,
      sequence: 1,
      name: 'state',
      payload: {},
    });
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records[0].pending).toHaveLength(1));
    host.dispose();
    lastReceived = 1;
    native.mockImplementation(reply);
    host = new PluginPageHost(native);
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records[0].accepted).toBe(1));
    expect(eventCalls()).toHaveLength(0);
  });

  it('keeps subsequent pending events when reconciliation overtakes a delayed acknowledgement', async () => {
    await attach();
    let acknowledge!: (value: unknown) => void;
    native.mockImplementation(async (action, data: any) => {
      if (data.input?.kind === 'event' && data.input.eventSequence === 1) {
        lastReceived = 1;
        return new Promise(resolve => {
          acknowledge = resolve;
        });
      }
      return reply(action, data);
    });
    const source = port(session['pluginPageHost.v1'].records[0].token);
    connected.fire(source);
    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
    const epoch = source.postMessage.mock.calls[0][0].epoch;
    source.onMessage.fire({ type: 'event', epoch, sequence: 1, name: 'state', payload: {} });
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    source.onMessage.fire({ type: 'event', epoch, sequence: 2, name: 'state', payload: {} });
    source.onMessage.fire({ type: 'event', epoch, sequence: 3, name: 'state', payload: {} });
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records[0].pending).toHaveLength(3));
    await (host as any).tick();
    expect(
      session['pluginPageHost.v1'].records[0].pending.map((event: any) => event.sequence),
    ).toEqual([2, 3]);
    acknowledge({ accepted: true });
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records[0].accepted).toBe(3));
    expect(eventCalls().map(([, data]) => (data.input as any).eventSequence)).toEqual([1, 2, 3]);
  });

  it('fences pending events when the execution service epoch changes', async () => {
    native.mockRejectedValue(new Error('disconnected'));
    await attach();
    const source = port(session['pluginPageHost.v1'].records[0].token);
    connected.fire(source);
    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
    source.onMessage.fire({
      type: 'event',
      epoch: source.postMessage.mock.calls[0][0].epoch,
      sequence: 1,
      name: 'state',
      payload: {},
    });
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records[0].pending).toHaveLength(1));
    host.dispose();
    serviceOwner = { ...serviceOwner, epoch: 'epoch-two' };
    native.mockImplementation(reply);
    host = new PluginPageHost(native);
    await vi.waitFor(() => expect(session['pluginPageHost.v1'].records).toHaveLength(0));
    expect(eventCalls()).toHaveLength(0);
    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({ js: [{ code: expect.stringContaining('?.dispose()') }] }),
    );
  });

  it('revokes an activation rule when its installation has been replaced', async () => {
    await host.handle({
      operation: 'activation',
      plugin: 'fixture',
      installationId,
      enabled: true,
      allowedMatches: runtime.matches,
    });
    host.dispose();
    (chrome.tabs.query as any).mockResolvedValue([{ id: 7 }]);
    native.mockImplementation(async (action, data) =>
      action === 'plugin_page_call'
        ? { error: { code: 'PLUGIN_PAGE_INSTALLATION_CHANGED', message: 'installation changed' } }
        : reply(action, data),
    );
    host = new PluginPageHost(native);
    await vi.waitFor(async () =>
      expect(await host.handle({ operation: 'activation', plugin: 'fixture' })).toEqual({
        activation: null,
      }),
    );
    expect(native).toHaveBeenCalledWith(
      'plugin_page_call',
      expect.objectContaining({ input: expect.objectContaining({ installationId }) }),
    );
  });

  it('recreates a new owner only through an existing activation rule after a service restart', async () => {
    await attach();
    await host.handle({
      operation: 'activation',
      plugin: 'fixture',
      installationId,
      enabled: true,
      allowedMatches: runtime.matches,
      persistence: 'persistent',
    });
    host.dispose();
    serviceOwner = { ...serviceOwner, epoch: 'epoch-two' };
    (chrome.tabs.query as any).mockResolvedValue([{ id: 7 }]);
    const replacementId = 'pi_00000000-0000-4000-8000-000000000002';
    native.mockImplementation(async (action, data: any) => {
      if (action === 'plugin_page_call' && data.input.operation === 'attach') {
        const target = await host.handle({ operation: 'resolve', tabId: 7 });
        return host.handle({
          operation: 'attach',
          instance: {
            instanceId: replacementId,
            plugin: 'fixture',
            installationId,
            revision: 'revision-two',
            host: serviceOwner,
            target,
            state: 'active',
          },
          runtime,
          activationGeneration: data.input.activationGeneration,
        });
      }
      return reply(action, data);
    });
    host = new PluginPageHost(native);
    await vi.waitFor(() =>
      expect(session['pluginPageHost.v1'].records).toMatchObject([
        { instance: { instanceId: replacementId, host: { epoch: 'epoch-two' } } },
      ]),
    );
    expect(eventCalls()).toHaveLength(0);
    const scripts = api.execute.mock.calls.map(([value]: any) => value.js[0].code as string);
    expect(
      scripts.findIndex((code: string) => code.includes(`get("${id}")?.dispose()`)),
    ).toBeLessThan(
      scripts.findIndex((code: string) => code.includes(`"instanceId":"${replacementId}"`)),
    );
  });

  it('cancels stale automatic attachments before script injection after a rule is disabled', async () => {
    await host.handle({
      operation: 'activation',
      plugin: 'fixture',
      enabled: true,
      installationId,
      allowedMatches: runtime.matches,
      matches: runtime.matches,
    });
    const generation = session['pluginPageHost.v1'].generations.fixture;
    await host.handle({ operation: 'activation', plugin: 'fixture', enabled: false });
    await expect(attach({ activationGeneration: generation })).rejects.toThrow(
      'Activation rule changed',
    );
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('does not change rule generation when inspecting or repeating the same rule', async () => {
    const rule = {
      operation: 'activation',
      plugin: 'fixture',
      enabled: true,
      installationId,
      allowedMatches: runtime.matches,
      matches: runtime.matches,
    };
    await host.handle(rule);
    const generation = session['pluginPageHost.v1'].generations.fixture;
    await host.handle({ operation: 'activation', plugin: 'fixture' });
    await host.handle(rule);
    expect(session['pluginPageHost.v1'].generations.fixture).toBe(generation);
  });

  it('reassembles Unicode messages with integrity checks and returns bounded result chunks', async () => {
    await attach();
    const message = { content: '设计😀'.repeat(60000) };
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const transferId = crypto.randomUUID();
    const base = { instanceId: id, tabId: 7, transferId };
    await host.handle({ ...base, operation: 'message_begin', bytes: bytes.length, sha256: hash });
    for (let offset = 0, index = 0; offset < bytes.length; offset += 192 * 1024, index++)
      await host.handle({
        ...base,
        operation: 'message_chunk',
        index,
        data: Buffer.from(bytes.subarray(offset, offset + 192 * 1024)).toString('base64'),
      });
    api.execute.mockResolvedValueOnce([
      { frameId: 12, documentId, result: { ok: true, value: message } },
    ]);
    const result = await host.handle({ ...base, operation: 'message_commit' });
    expect(result).toMatchObject({ kind: 'resource', bytes: bytes.length, sha256: hash });
    const parts = [];
    for (let index = 0; index < result.chunks; index++) {
      const chunk = await host.handle({
        instanceId: id,
        tabId: 7,
        operation: 'result_chunk',
        resultId: result.resultId,
        index,
      });
      parts.push(Buffer.from(chunk.data, 'base64'));
    }
    expect(JSON.parse(Buffer.concat(parts).toString())).toEqual(message);
    await host.handle({
      instanceId: id,
      tabId: 7,
      operation: 'result_release',
      resultId: result.resultId,
    });
    await expect(
      host.handle({
        instanceId: id,
        tabId: 7,
        operation: 'result_chunk',
        resultId: result.resultId,
        index: 0,
      }),
    ).rejects.toThrow('not found');
    await expect(host.handle({ ...base, operation: 'message_commit' })).rejects.toThrow(
      'not found',
    );
  });
});
