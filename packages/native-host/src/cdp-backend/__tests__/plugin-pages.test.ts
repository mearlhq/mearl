import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { hashKey, writeRecord } from '@mearl/daemon-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { createContext, runInContext, type Context } from 'node:vm';
import { CdpPluginPageHost, pruneCdpSessionStorage } from '../plugin-pages.js';
import type { CdpSession } from '../cdp-session.js';

function emitter() {
  const listeners = new Map<string, Set<(data: any) => void>>();
  return {
    on(name: string, listener: (data: any) => void) {
      const group = listeners.get(name) ?? new Set();
      listeners.set(name, group);
      group.add(listener);
      return () => {
        group.delete(listener);
      };
    },
    emit(name: string, data: any) {
      for (const listener of listeners.get(name) ?? []) listener(data);
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-cdp-pages-'));
  const contexts = new Map<number, Context>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const clients: any[] = [];
  let contextId = 10,
    documentId = 'doc-one',
    url = 'https://example.test/page';
  let identity = 'browser-one';
  const connected = new Set<() => void>();
  const browser = () => ({
    ...emitter(),
    identity,
    sendCommand: vi.fn(async (method: string, params?: any) => {
      if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
      if (method === 'Target.getTargets')
        return { targetInfos: [{ type: 'page', targetId: 'page', url }] };
      return {};
    }),
    createChildSession: () => child(),
  });
  let parent = browser();
  const child = () => {
    const worlds = new Map<string, number>();
    let binding = '';
    const client = {
      ...emitter(),
      closed: false,
      sendCommand: vi.fn(async (method: string, params?: any, _timeout?: number) => {
        if (method === 'Page.getFrameTree')
          return { frameTree: { frame: { id: 'frame-main', url } } };
        if (method === 'Runtime.enable')
          client.emit('Runtime.executionContextCreated', {
            context: {
              id: ++contextId,
              uniqueId: documentId,
              auxData: { frameId: 'frame-main', isDefault: true },
            },
          });
        if (method === 'Runtime.addBinding') binding = params.name;
        if (method === 'Page.createIsolatedWorld') {
          let id = worlds.get(params.worldName);
          if (!id || !contexts.has(id)) {
            id = ++contextId;
            worlds.set(params.worldName, id);
            const executionContextId = id;
            contexts.set(
              id,
              createContext({
                crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
                AbortController,
                TextEncoder,
                TextDecoder,
                queueMicrotask,
                setTimeout,
                clearTimeout,
                setInterval: (...args: Parameters<typeof setInterval>) => {
                  const timer = setInterval(...args);
                  intervals.add(timer);
                  return timer;
                },
                clearInterval: (timer: ReturnType<typeof setInterval>) => {
                  clearInterval(timer);
                  intervals.delete(timer);
                },
                document: { title: 'fixture' },
                [binding]: (payload: string) =>
                  client.emit('Runtime.bindingCalled', {
                    name: binding,
                    executionContextId,
                    payload,
                  }),
              }),
            );
          }
          return { executionContextId: id };
        }
        if (method === 'Runtime.evaluate') {
          try {
            return {
              result: {
                value: await runInContext(params.expression, contexts.get(params.contextId)!),
              },
            };
          } catch (error) {
            return { exceptionDetails: { text: String(error) } };
          }
        }
        return {};
      }),
    };
    clients.push(client);
    return client;
  };
  const cdp = {
    getBrowserClient: async () => parent,
    browserSessionIdentity: async () => identity,
    onBrowserConnected: (listener: () => void) => {
      connected.add(listener);
      return () => connected.delete(listener);
    },
    getPageSession: async () => ({ targetId: 'page', client: parent }),
    ensureTargetRegistered: async () => 1000,
  } as unknown as CdpSession;
  const owner = { hostId: 'execution-host', epoch: 'epoch-one' };
  let lastReceived = 0;
  const native = vi.fn(async (action: string, data: any): Promise<any> => {
    if (action === 'plugin_page_call' && data.input.operation === 'attach')
      return attach(undefined, data.plugin, data.input);
    if (action === 'plugin_page_call' && data.input.operation === 'detach')
      return host.handle(data.input);
    if (data.input?.kind === 'sync')
      return {
        host: owner,
        instances: data.input.instances.map((instance: any) => ({ instance, lastReceived })),
      };
    if (data.input?.kind === 'event') lastReceived = data.input.eventSequence;
    return { accepted: true };
  });
  const storageFile = join(directory, 'session.json');
  let host = new CdpPluginPageHost(cdp, native, { browserId: 'fixture', storageFile });
  const attach = async (
    code = 'host => ({ receive: message => message })',
    plugin = 'fixture',
    options: Record<string, any> = {},
  ): Promise<any> => {
    const target = await host.handle({ operation: 'resolve', tabId: 1000, frame: 'main' });
    return host.handle({
      ...options,
      operation: 'attach',
      frame: 'main',
      instance: {
        instanceId: `pi_${randomUUID()}`,
        plugin,
        installationId: options.installationId ?? randomUUID(),
        revision: 'one',
        host: owner,
        target,
        state: 'active',
      },
      runtime: {
        version: 1,
        matches: ['https://example.test/*'],
        code,
        events: { state: { command: 'save', schema: { type: 'object' } } },
      },
    });
  };
  const send = (instance: any, message: any, extra = {}) =>
    host.handle({
      operation: 'send',
      instanceId: instance.instanceId,
      tabId: 1000,
      message,
      ...extra,
    });
  return {
    attach,
    send,
    native,
    clients,
    contexts,
    intervals,
    storageFile,
    get host() {
      return host;
    },
    async restartHost() {
      host.dispose();
      host = new CdpPluginPageHost(cdp, native, { browserId: 'fixture', storageFile });
      return host.handle({ operation: 'session' });
    },
    navigate() {
      for (const client of clients) {
        client.emit('Runtime.executionContextsCleared', {});
        client.emit('Page.frameNavigated', { frame: { id: 'frame-main', url } });
        client.emit('Runtime.executionContextCreated', {
          context: {
            id: ++contextId,
            uniqueId: (documentId = 'doc-two'),
            auxData: { frameId: 'frame-main', isDefault: true },
          },
        });
      }
    },
    sameDocument() {
      url = 'https://example.test/page#next';
      for (const client of clients)
        client.emit('Page.navigatedWithinDocument', { frameId: 'frame-main', url });
    },
    restartBrowser() {
      identity = 'browser-two';
      parent = browser();
      for (const listener of connected) listener();
    },
    cleanup() {
      host.dispose();
      for (const timer of intervals) clearInterval(timer);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
let f: ReturnType<typeof fixture>;
afterEach(() => f?.cleanup());

it('reclaims obsolete browser session values and preserves persistent activation rules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-cdp-session-cleanup-'));
  const storageFile = join(directory, 'browser.json');
  mkdirSync(`${storageFile}.d`);
  const save = (name: string, identity: string) => {
    const file = join(`${storageFile}.d`, name);
    writeRecord(file, { pid: process.pid, identity, value: {} });
    return file;
  };
  try {
    const old = save('session-aaaaaaaaaaaaaaaa.json', 'old');
    const current = save('session-bbbbbbbbbbbbbbbb.json', 'current');
    const persistent = save('persistent-aaaaaaaaaaaaaaaa.json', 'old');
    pruneCdpSessionStorage(storageFile, 'current');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(persistent)).toBe(true);
    pruneCdpSessionStorage(storageFile);
    expect(existsSync(current)).toBe(false);
    expect(existsSync(persistent)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CDP plugin page adapter with the shared document runtime', () => {
  it('executes a healthy document while another target attachment is pending or fails', async () => {
    f = fixture();
    const instance = await f.attach();
    const adapter = (f.host as any).adapter;
    let reject!: (reason: Error) => void;
    const pending = new Promise((_resolve, fail) => {
      reject = fail;
    });
    void pending.catch(() => {});
    adapter.targets.set('unrelated', pending);
    try {
      await expect(f.send(instance, 'healthy')).resolves.toEqual({
        kind: 'value',
        value: 'healthy',
      });
      reject(new Error('Other tab disappeared'));
      await expect(f.send(instance, 'still healthy')).resolves.toEqual({
        kind: 'value',
        value: 'still healthy',
      });
    } finally {
      adapter.targets.delete('unrelated');
      reject(new Error('Test finished'));
    }
  });

  it('writes renewed leases without rewriting runtime snapshots and restores values by key', async () => {
    f = fixture();
    const instance = await f.attach(
      'host => ({ receive: value => value })' + ' '.repeat(1024 * 1024),
    );
    const adapter = (f.host as any).adapter;
    const snapshotFile = join(`${f.storageFile}.d`, `session-${hashKey('pluginPageHost.v1')}.json`);
    const leaseFile = join(`${f.storageFile}.d`, `session-${hashKey('pluginPageLeases.v1')}.json`);
    const before = statSync(snapshotFile);
    const original = readFileSync(snapshotFile, 'utf8');
    for (let index = 0; index < 20; index++)
      await f.host.handle({ operation: 'get', instanceId: instance.instanceId, tabId: 1000 });
    await (f.host as any).saveLeases();
    expect(statSync(snapshotFile).ino).toBe(before.ino);
    expect(readFileSync(snapshotFile, 'utf8')).toBe(original);
    expect(statSync(leaseFile).size).toBeLessThan(1024);
    const saved = JSON.parse(readFileSync(leaseFile, 'utf8')).value;
    const restored = await adapter.session.get(['pluginPageLeases.v1']);
    expect(restored).toEqual({ 'pluginPageLeases.v1': saved });
    expect(saved[instance.instanceId].expires).toBeGreaterThanOrEqual(
      JSON.parse(original).value.records[0].expires,
    );
    adapter.storage = undefined;
    expect(await adapter.session.get(['pluginPageLeases.v1'])).toEqual({
      'pluginPageLeases.v1': saved,
    });
    restored['pluginPageLeases.v1'][instance.instanceId].expires = 0;
    expect(await adapter.session.get(['pluginPageLeases.v1'])).toEqual({
      'pluginPageLeases.v1': saved,
    });
  });

  it('retains persistent keys and discards session keys when the browser identity changes', async () => {
    f = fixture();
    const adapter = (f.host as any).adapter;
    await adapter.session.set({ custom: { value: 'temporary' } });
    await adapter.persistent.set({ custom: { value: 'saved' } });
    adapter.storage = undefined;
    expect(await adapter.session.get(['custom'])).toEqual({ custom: { value: 'temporary' } });
    const before = await f.host.handle({ operation: 'session' });
    f.restartBrowser();
    await vi.waitFor(async () =>
      expect(await f.host.handle({ operation: 'session' })).not.toEqual(before),
    );
    expect(await adapter.session.get(['custom'])).toEqual({ custom: undefined });
    adapter.storage = undefined;
    expect(await adapter.persistent.get(['custom'])).toEqual({ custom: { value: 'saved' } });
    expect(await adapter.session.get(['custom'])).toEqual({ custom: undefined });
  });

  it('sends messages and acknowledged page events without extension APIs', async () => {
    f = fixture();
    const instance = await f.attach(
      `host => ({ receive: async message => { await host.emit('state', { value: message }); return { title: document.title }; } })`,
    );
    expect(instance.target.frameId).toBe('frame-main');
    expect(await f.send(instance, 'hello')).toEqual({ kind: 'value', value: { title: 'fixture' } });
    expect(
      f.native.mock.calls.some(
        ([, data]) => data.input.kind === 'event' && data.input.payload.value === 'hello',
      ),
    ).toBe(true);
  });

  it('isolates globals between plugins and propagates execution deadlines', async () => {
    f = fixture();
    const first = await f.attach(
      'host => { globalThis.privateValue = 7; return {receive: () => privateValue}; }',
    );
    const second = await f.attach('host => ({receive: () => typeof privateValue})', 'second');
    expect(await f.send(first, {})).toEqual({ kind: 'value', value: 7 });
    expect(await f.send(second, {}, { timeoutSec: 9 })).toEqual({
      kind: 'value',
      value: 'undefined',
    });
    expect(
      f.clients[0].sendCommand.mock.calls.some(
        ([method, , timeout]: any[]) => method === 'Runtime.evaluate' && timeout === 9000,
      ),
    ).toBe(true);
  });

  it('cooperatively cancels a pending request through a concurrent CDP evaluation', async () => {
    f = fixture();
    const instance = await f.attach(
      `host => ({ receive: (message, request) => new Promise(resolve => request.signal.addEventListener('abort', () => resolve('cancelled'), {once:true})) })`,
    );
    const pending = f.send(instance, {}, { requestId: 'pending' });
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    await vi.waitFor(() =>
      expect(
        [...f.contexts.values()].some(context =>
          runInContext(`globalThis.__mearlPluginPageInstances?.size === 1`, context),
        ),
      ).toBe(true),
    );
    await f.host.handle({
      operation: 'cancel',
      instanceId: instance.instanceId,
      tabId: 1000,
      requestId: 'pending',
    });
    await rejected;
  });

  it('keeps same-document navigation but invalidates a replaced document', async () => {
    f = fixture();
    const instance = await f.attach();
    f.sameDocument();
    await vi.waitFor(() =>
      expect(f.native.mock.calls.some(([, data]) => data.input.kind === 'navigation')).toBe(true),
    );
    expect(await f.send(instance, 'alive')).toEqual({ kind: 'value', value: 'alive' });
    f.navigate();
    await expect(f.send(instance, 'stale')).rejects.toThrow(/invalidated|not found/i);
    expect((await f.attach()).target.documentId).toBe('doc-two');
  });

  it('preserves browser-session identity across host restart and resets it across browser restart', async () => {
    f = fixture();
    const before = await f.host.handle({ operation: 'session' });
    expect(await f.restartHost()).toEqual(before);
    f.restartBrowser();
    await vi.waitFor(async () =>
      expect(await f.host.handle({ operation: 'session' })).not.toEqual(before),
    );
  });

  it('reactivates matching pages and retains only persistent rules after browser restart', async () => {
    f = fixture();
    for (const [plugin, persistence] of [
      ['saved', 'persistent'],
      ['temporary', 'session'],
    ] as const) {
      await f.host.handle({
        operation: 'activation',
        plugin,
        enabled: true,
        frame: 'main',
        persistence,
        installationId: randomUUID(),
        matches: ['https://example.test/*'],
        allowedMatches: ['https://example.test/*'],
      });
    }
    await vi.waitFor(() =>
      expect(f.native.mock.calls.filter(([action]) => action === 'plugin_page_call')).toHaveLength(
        2,
      ),
    );
    await Promise.all(f.native.mock.results.map(result => result.value));
    const before = await f.host.handle({ operation: 'session' });
    const initialCalls = f.native.mock.calls.length;
    f.restartBrowser();
    await vi.waitFor(async () =>
      expect(await f.host.handle({ operation: 'session' })).not.toEqual(before),
    );
    expect(
      (await f.host.handle({ operation: 'activation', plugin: 'saved' })).activation.persistence,
    ).toBe('persistent');
    expect(await f.host.handle({ operation: 'activation', plugin: 'temporary' })).toEqual({
      activation: null,
    });
    await vi.waitFor(() =>
      expect(
        f.native.mock.calls
          .slice(initialCalls)
          .some(
            ([action, data]) =>
              action === 'plugin_page_call' &&
              data.plugin === 'saved' &&
              data.input.operation === 'attach',
          ),
      ).toBe(true),
    );
  });

  it('rejects events from another execution context and removes document ports on detach', async () => {
    f = fixture();
    const instance = await f.attach();
    const client = f.clients[0];
    const binding = client.sendCommand.mock.calls.find(
      ([method]: any[]) => method === 'Runtime.addBinding',
    )[1].name;
    client.emit('Runtime.bindingCalled', {
      name: binding,
      executionContextId: -1,
      payload: JSON.stringify({ type: 'connect', id: 'fake', name: 'fake' }),
    });
    await f.host.handle({ operation: 'detach', instanceId: instance.instanceId });
    await expect(
      f.host.handle({ operation: 'get', instanceId: instance.instanceId, tabId: 1000 }),
    ).rejects.toThrow('PLUGIN_PAGE_NOT_FOUND');
    expect(
      [...f.contexts.values()].every(context =>
        runInContext('globalThis.__mearlPluginPageInstances.size === 0', context),
      ),
    ).toBe(true);
    expect(f.intervals.size).toBe(0);
  });

  it('invalidates a lost isolated world and permits a fresh attachment', async () => {
    f = fixture();
    const instance = await f.attach();
    const contextId = [...f.contexts.keys()][0];
    f.contexts.delete(contextId);
    f.clients[0].emit('Runtime.executionContextDestroyed', { executionContextId: contextId });
    await (f.host as any).tick();
    await expect(
      f.host.handle({ operation: 'get', tabId: 1000, instanceId: instance.instanceId }),
    ).rejects.toThrow('PLUGIN_PAGE_NOT_FOUND');
    const fresh = await f.attach();
    expect(await f.send(fresh, 'restored')).toEqual({ kind: 'value', value: 'restored' });
  });
});
