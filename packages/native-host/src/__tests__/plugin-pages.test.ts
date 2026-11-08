import { PluginHost } from '../../../client/src/plugins/runtime/pluginHost.js';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPlugin } from '../../../client/src/plugins/pluginRegistry.js';
import type { PluginTaskManager } from '../../../client/src/plugins/runtime/pluginTaskManager.js';
import type { PluginTaskBridge } from '../../../client/src/plugins/runtime/pluginTaskManager.js';
import type { PluginPageManager } from '../../../client/src/plugins/runtime/pluginPageManager.js';

let host: PluginHost;
let runtime: string, directory: string, skill: string;
let tasks: PluginTaskManager, pages: PluginPageManager, bridge: PluginTaskBridge;
let target: any, documents: Map<string, any>, messages: any[];
const fixture = `
export const stateStorage = {version:1,collections:{cache:{scope:'instance',storage:'cache',schemaVersion:1,schema:{type:'integer'}}}};
export const pageRuntime = { version:1, matches:['https://example.test/*'], code:'host => ({ receive: message => message })', initialize:'initialize', events:{
  state:{ command:'state', policy:'latest', schema:{$id:'https://schema.test/event',type:'object',required:['value'],properties:{value:{type:'integer'},ms:{type:'integer'},action:{type:'string'}},additionalProperties:false} }
}};
export default app => {
  app.runtimeCommand('initialize', async (_, context) => { await new Promise(resolve => setTimeout(resolve, 30)); return context.page.send({type:'initialized'}); });
  app.runtimeCommand('state', async ({event}, context) => {
    await new Promise(resolve => setTimeout(resolve,event.payload.ms||0));
    if(event.payload.action) return context.invoke(event.payload.action,{actions:[{action:'page_eval',expression:'1'}]});
    return context.page.send({type:'saved',value:event.payload.value, revision:context.identity.revision});
  });
};`;
async function attach() {
  return pages.call('fixture', { operation: 'attach', tabId: 7 }, bridge);
}
async function history(id: string) {
  return pages.call('fixture', { operation: 'events', instanceId: id }, bridge);
}
async function event(id: string, sequence: number, payload: unknown) {
  return pages.receive(
    'fixture',
    { instanceId: id, eventSequence: sequence, name: 'state', payload },
    bridge,
  );
}

beforeAll(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'mearl-page-worker-'));
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}');
  await build({
    entryPoints: [fileURLToPath(new URL('../../../client/src/plugin-worker.ts', import.meta.url))],
    outfile: join(runtime, 'dist/plugin-worker.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __pageRequire } from "node:module"; const require = __pageRequire(import.meta.url);',
    },
  });
});
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-page-test-'));
  skill = join(directory, 'skill');
  mkdirSync(skill);
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  writeFileSync(join(skill, 'SKILL.md'), '# Page fixture');
  writeFileSync(join(skill, 'main.mjs'), fixture);
  registerPlugin('fixture', join(skill, 'main.mjs'));
  host = new PluginHost({ workerPath: join(runtime, 'dist/plugin-worker.js') });
  tasks = host.tasks;
  pages = host.pages;
  target = {
    browserSessionId: 'browser-one',
    tabId: 7,
    frameId: 12,
    documentId: 'document-one',
    url: 'https://example.test/page',
  };
  documents = new Map();
  messages = [];
  bridge = {
    id: 'caller',
    scope: { access: 'toolbox', plugin: 'fixture', source: 'toolbox', bridge: 'caller' },
    invoke: vi.fn(async (action, data) => {
      if (action !== 'page_runtime') throw new Error(`Unexpected action: ${action}`);
      if (data.operation === 'session') return { browserSessionId: target.browserSessionId };
      if (data.operation === 'resolve') return { ...target };
      if (data.operation === 'attach') {
        documents.set((data.instance as any).instanceId, data.instance);
        return data.instance;
      }
      if (data.operation === 'detach') {
        documents.delete(String(data.instanceId));
        return {};
      }
      const instance = documents.get(String(data.instanceId));
      if (!instance || instance.target.documentId !== target.documentId)
        throw new Error('PLUGIN_PAGE_NOT_FOUND: Document is gone');
      if (data.operation === 'get') return instance;
      if (data.operation === 'send') {
        messages.push(data.message);
        return { kind: 'value', value: data.message };
      }
      throw new Error(`Unexpected operation: ${data.operation}`);
    }),
  };
});
afterEach(async () => {
  await host.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('plugin page execution service', { timeout: 20000 }, () => {
  it('applies a bounded timeout to one page request without changing subsequent requests', async () => {
    const instance = await attach();
    await pages.call(
      'fixture',
      {
        operation: 'send',
        instanceId: instance.instanceId,
        message: { type: 'long-native-call' },
        timeoutSec: 120,
      },
      bridge,
    );
    await pages.call(
      'fixture',
      { operation: 'send', instanceId: instance.instanceId, message: { type: 'normal-call' } },
      bridge,
    );
    const calls = vi
      .mocked(bridge.invoke)
      .mock.calls.filter(
        ([, data]) =>
          data.operation === 'send' &&
          ['long-native-call', 'normal-call'].includes((data.message as any)?.type),
      );
    expect(calls[0][1]).toMatchObject({ timeoutSec: 120 });
    expect(calls[1][1]).not.toHaveProperty('timeoutSec');
    expect(calls[0][2]).toMatchObject({ timeoutSec: 120 });
    expect(calls[1][2]).not.toHaveProperty('timeoutSec');
    for (const timeoutSec of [0, -1, 301, Infinity, NaN, '120']) {
      await expect(
        pages.call(
          'fixture',
          { operation: 'send', instanceId: instance.instanceId, message: {}, timeoutSec },
          bridge,
        ),
      ).rejects.toThrow('timeoutSec');
    }
  });
  it('cancels the document request when its transport fails to prevent late native results', async () => {
    const instance = await attach(),
      invoke = bridge.invoke;
    bridge.invoke = vi.fn(async (action, data, options) => {
      if (data.operation === 'send' && (data.message as any)?.type === 'native-timeout')
        throw new Error('Request timeout');
      if (data.operation === 'cancel') return { cancelled: true };
      return invoke(action, data, options);
    });
    await expect(
      pages.call(
        'fixture',
        { operation: 'send', instanceId: instance.instanceId, message: { type: 'native-timeout' } },
        bridge,
      ),
    ).rejects.toThrow('Request timeout');
    const request = vi
      .mocked(bridge.invoke)
      .mock.calls.find(
        ([, data]) => data.operation === 'send' && (data.message as any)?.type === 'native-timeout',
      )![1];
    expect(bridge.invoke).toHaveBeenCalledWith(
      'page_runtime',
      expect.objectContaining({ operation: 'cancel', requestId: request.requestId }),
      expect.any(Object),
    );
  });
  it('forwards context.page timeout options from the bound runtime worker', async () => {
    writeFileSync(
      join(skill, 'main.mjs'),
      fixture.replace(
        "return context.page.send({type:'saved',value:event.payload.value, revision:context.identity.revision});",
        "return context.page.send({type:'saved',value:event.payload.value, revision:context.identity.revision}, {timeoutSec:120});",
      ),
    );
    registerPlugin('fixture', join(skill, 'main.mjs'));
    const instance = await attach();
    await event(instance.instanceId, 1, { value: 42 });
    await vi.waitFor(
      () =>
        expect(bridge.invoke).toHaveBeenCalledWith(
          'page_runtime',
          expect.objectContaining({
            operation: 'send',
            message: expect.objectContaining({ type: 'saved', value: 42 }),
          }),
          expect.objectContaining({ timeoutSec: 120 }),
        ),
      { timeout: 10000 },
    );
  });
  it('long-polls until an event or invalidation and releases aborted observers', async () => {
    const instance = await attach();
    let cursor = (await history(instance.instanceId)).nextCursor;
    const input = () => ({
      operation: 'events',
      instanceId: instance.instanceId,
      cursor,
      waitMs: 25000,
    });
    const waiting = pages.call('fixture', input(), bridge);
    await vi.waitFor(() =>
      expect((pages as any).changes.listenerCount(instance.instanceId)).toBe(1),
    );
    await event(instance.instanceId, 1, { value: 1 });
    expect((await waiting).events).toContainEqual(expect.objectContaining({ type: 'received' }));
    await vi.waitFor(
      async () =>
        expect(
          (await history(instance.instanceId)).events.some(
            (event: any) => event.type === 'success',
          ),
        ).toBe(true),
      { timeout: 10000 },
    );
    cursor = (await history(instance.instanceId)).nextCursor;
    const controller = new AbortController();
    const aborted = pages.call(
      'fixture',
      input(),
      bridge,
      {},
      { cwd: directory, environment: {}, signal: controller.signal },
    );
    const rejected = expect(aborted).rejects.toThrow('observer closed');
    await vi.waitFor(() =>
      expect((pages as any).changes.listenerCount(instance.instanceId)).toBe(1),
    );
    controller.abort(new Error('observer closed'));
    await rejected;
    expect((pages as any).changes.listenerCount(instance.instanceId)).toBe(0);
    const detached = pages.call('fixture', input(), bridge);
    await vi.waitFor(() =>
      expect((pages as any).changes.listenerCount(instance.instanceId)).toBe(1),
    );
    await pages.call('fixture', { operation: 'detach', instanceId: instance.instanceId }, bridge);
    expect((await detached).instance.state).toBe('detached');
    expect((pages as any).changes.listenerCount(instance.instanceId)).toBe(0);
  });

  it('bounds event waits and returns an unchanged cursor when a wait expires', async () => {
    const instance = await attach();
    const cursor = (await history(instance.instanceId)).nextCursor;
    await expect(
      pages.call(
        'fixture',
        { operation: 'events', instanceId: instance.instanceId, cursor, waitMs: 20 },
        bridge,
      ),
    ).resolves.toMatchObject({ events: [], nextCursor: cursor });
    for (const waitMs of [-1, 25001, '20'])
      await expect(
        pages.call(
          'fixture',
          { operation: 'events', instanceId: instance.instanceId, cursor, waitMs },
          bridge,
        ),
      ).rejects.toThrow('event wait');
    expect((pages as any).changes.listenerCount(instance.instanceId)).toBe(0);
  });

  it('reconciles only the same owner, installation and document and refuses stale activation identities', async () => {
    const instance = await attach();
    await event(instance.instanceId, 1, { value: 1 });
    const sync = (value = instance, session = target.browserSessionId) =>
      pages.receive(
        'fixture',
        { kind: 'sync', browserSessionId: session, instances: [value] },
        bridge,
      );
    expect(await sync()).toMatchObject({
      host: tasks.host,
      instances: [{ instance: { instanceId: instance.instanceId }, lastReceived: 1 }],
    });
    expect(
      await sync({ ...instance, host: { ...instance.host, epoch: 'previous-epoch' } }),
    ).toMatchObject({ instances: [] });
    expect(
      await sync({ ...instance, target: { ...instance.target, documentId: 'previous-document' } }),
    ).toMatchObject({ instances: [] });
    await expect(sync(instance, 'other-browser')).rejects.toMatchObject({
      code: 'PLUGIN_PAGE_TARGET_CHANGED',
    });
    await expect(
      pages.call(
        'fixture',
        { operation: 'attach', tabId: 7, installationId: 'other-installation' },
        bridge,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_PAGE_INSTALLATION_CHANGED' });
  });
  it('lets document initialization read its plugin activation while rejecting configuration and other documents', async () => {
    const invoke = bridge.invoke;
    bridge.invoke = (action, data, options) =>
      data.operation === 'activation'
        ? Promise.resolve({ activation: { enabled: true, matches: ['https://example.test/*'] } })
        : invoke(action, data, options);
    writeFileSync(
      join(skill, 'main.mjs'),
      fixture.replace(
        "return context.page.send({type:'initialized'});",
        `const rule = await app.page('activation');
      const denied = [];
      for (const input of [{operation:'activation',enabled:true}, {operation:'activation',enabled:false}, {operation:'get',instanceId:'other-document'}]) {
        try { const {operation,...payload}=input; await app.page(operation,payload); } catch(error) { denied.push(error.code); }
      }
      return context.page.send({type:'initialized',rule,denied});`,
      ),
    );
    const instance = await attach();
    expect(instance.state).toBe('active');
    expect(messages).toEqual([
      {
        type: 'initialized',
        rule: { activation: { enabled: true, matches: ['https://example.test/*'] } },
        denied: Array(3).fill('PLUGIN_PAGE_TARGET_CHANGED'),
      },
    ]);
    await expect(
      pages.call(
        'fixture',
        { operation: 'activation', enabled: false },
        bridge,
        {},
        { expectedTarget: target },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_PAGE_TARGET_CHANGED' });
  });

  it('claims manual reuse without reinitializing and does not forward ownership flags from ordinary reads', async () => {
    const instance = await pages.call(
      'fixture',
      { operation: 'attach', tabId: 7, activationGeneration: 1 },
      bridge,
    );
    const invoke = vi.mocked(bridge.invoke);
    invoke.mockClear();
    await pages.call(
      'fixture',
      { operation: 'get', instanceId: instance.instanceId, retainManual: true },
      bridge,
    );
    expect(invoke.mock.calls.some(([, data]) => data.retainManual === true)).toBe(false);
    await pages.call('fixture', { operation: 'attach', tabId: 7, activationGeneration: 1 }, bridge);
    expect(invoke.mock.calls.some(([, data]) => data.retainManual === true)).toBe(false);
    expect((await attach()).instanceId).toBe(instance.instanceId);
    expect(
      invoke.mock.calls.some(
        ([, data]) => data.retainManual === true && data.instanceId === instance.instanceId,
      ),
    ).toBe(true);
    expect(messages).toEqual([{ type: 'initialized' }]);
  });

  it('shares initialization across simultaneous attachments and reconnects observers', async () => {
    const [first, second] = await Promise.all([attach(), attach()]);
    expect(first.instanceId).toBe(second.instanceId);
    expect(messages).toEqual([{ type: 'initialized' }]);
    const publicEntry = { ...bridge, scope: { ...bridge.scope, access: 'public' as const } };
    expect(
      (await pages.call('fixture', { operation: 'attach', tabId: 7 }, publicEntry)).instanceId,
    ).toBe(first.instanceId);
    expect(messages).toHaveLength(1);
    bridge = { ...bridge, id: 'reconnected' };
    expect((await history(first.instanceId)).instance.state).toBe('active');
  });

  it('bounds plugin-owned event payloads, deduplicates events, coalesces latest and pins source', async () => {
    const instance = await attach();
    await expect(event(instance.instanceId, 1, { value: 'x'.repeat(32 * 1024) })).rejects.toThrow(
      'exceeds 32 KiB',
    );
    await event(instance.instanceId, 1, { value: 'plugin-owned', ms: 150 });
    await event(instance.instanceId, 2, { value: 2 });
    await event(instance.instanceId, 3, { value: 3 });
    expect(await event(instance.instanceId, 3, { value: 3 })).toMatchObject({ duplicate: true });
    writeFileSync(join(skill, 'main.mjs'), 'throw new Error("live source must not run");');
    await vi.waitFor(
      () =>
        expect(
          messages.filter(message => message.type === 'saved').map(message => message.value),
        ).toEqual(['plugin-owned', 3]),
      { timeout: 10000 },
    );
    expect(
      messages
        .filter(message => message.type === 'saved')
        .every(message => message.revision === instance.revision),
    ).toBe(true);
    expect((await history(instance.instanceId)).events).toContainEqual(
      expect.objectContaining({ type: 'superseded', eventSequence: 2 }),
    );
  });

  it.each(['page_eval', 'run_actions'])('blocks document access through %s', async action => {
    const instance = await attach();
    await event(instance.instanceId, 1, { value: 1, action });
    await vi.waitFor(
      async () =>
        expect((await history(instance.instanceId)).events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            error: expect.objectContaining({ code: 'PLUGIN_PAGE_TARGET_CHANGED' }),
          }),
        ),
      { timeout: 10000 },
    );
    expect(messages).toEqual([{ type: 'initialized' }]);
  });

  it('cancels queued and running work when navigation invalidates the document', async () => {
    const instance = await attach();
    await event(instance.instanceId, 1, { value: 1, ms: 500 });
    await event(instance.instanceId, 2, { value: 2 });
    documents.delete(instance.instanceId);
    await pages.receive(
      'fixture',
      { instanceId: instance.instanceId, kind: 'invalidated', target: instance.target },
      { ...bridge, id: 'navigation-connection' },
    );
    await vi.waitFor(
      () =>
        expect(
          tasks.list({ access: 'public', source: 'runtime', bridge: 'service' }, true).tasks,
        ).toHaveLength(0),
      { timeout: 10000 },
    );
    expect(messages).toEqual([{ type: 'initialized' }]);
    expect((await history(instance.instanceId)).instance.state).toBe('invalidated');
  });

  it('isolates page scope and rejects notifications from another browser', async () => {
    const instance = await attach();
    await expect(
      pages.call(
        'other',
        { operation: 'get', instanceId: instance.instanceId },
        { ...bridge, scope: { ...bridge.scope, plugin: 'other' } },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_PAGE_NOT_FOUND' });
    target.browserSessionId = 'different-browser';
    await expect(
      pages.receive(
        'fixture',
        { instanceId: instance.instanceId, kind: 'invalidated', target: instance.target },
        bridge,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_PAGE_TARGET_CHANGED' });
  });

  it('renews healthy instances while another browser request is hung', async () => {
    const first = await attach();
    target.documentId = 'document-two';
    const second = await attach();
    const invoke = bridge.invoke;
    let renewed = false;
    bridge.invoke = async (action, input, options) => {
      if (input.operation === 'get' && input.instanceId === first.instanceId)
        return new Promise(() => {});
      if (input.operation === 'get' && input.instanceId === second.instanceId) renewed = true;
      return invoke(action, input, options);
    };
    vi.useFakeTimers();
    try {
      const reconciliation = (pages as any).reconcile();
      await vi.advanceTimersByTimeAsync(1);
      expect(renewed).toBe(true);
      expect(second.state).toBe('active');
      await vi.advanceTimersByTimeAsync(8000);
      await reconciliation;
      expect(first.state).toBe('active');
      expect(second.state).toBe('active');
      await vi.advanceTimersByTimeAsync(22000);
      const expired = (pages as any).reconcile();
      await vi.advanceTimersByTimeAsync(8000);
      await expired;
      expect(first.state).toBe('invalidated');
      expect(second.state).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps instance ownership during a transport outage and revalidates before resuming', async () => {
    const instance = await attach();
    const original = { ...instance.target };
    const invoke = bridge.invoke;
    let unavailable = true;
    bridge.invoke = vi.fn(async (action, input, options) => {
      if (unavailable && input.operation === 'get') throw new Error('Socket connection closed');
      return invoke(action, input, options);
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11000);
    try {
      await (pages as any).reconcile();
      expect(instance.state).toBe('active');
      await expect(
        pages.call(
          'fixture',
          {
            operation: 'send',
            instanceId: instance.instanceId,
            message: { type: 'blocked' },
          },
          bridge,
        ),
      ).rejects.toMatchObject({ code: 'PLUGIN_PAGE_UNAVAILABLE' });
      await expect(
        host.state.call(
          'fixture',
          {
            operation: 'get',
            collection: 'cache',
            instanceId: instance.instanceId,
            key: 'value',
          },
          bridge,
        ),
      ).rejects.toMatchObject({ code: 'PLUGIN_PAGE_UNAVAILABLE' });
      expect(messages).toEqual([{ type: 'initialized' }]);
      unavailable = false;
      await (pages as any).reconcile();
      expect(
        await pages.call('fixture', { operation: 'get', instanceId: instance.instanceId }, bridge),
      ).toMatchObject({ state: 'active', target: original });
      await expect(
        pages.call(
          'fixture',
          {
            operation: 'send',
            instanceId: instance.instanceId,
            message: { type: 'recovered' },
          },
          bridge,
        ),
      ).resolves.toEqual({ type: 'recovered' });
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects an unavailable reconciliation instead of reporting a missing instance', async () => {
    const instance = await attach();
    const invoke = bridge.invoke;
    bridge.invoke = async (action, input, options) => {
      if (input.operation === 'get') throw new Error('Browser is registering');
      return invoke(action, input, options);
    };
    await expect(
      pages.receive(
        'fixture',
        {
          kind: 'sync',
          browserSessionId: target.browserSessionId,
          instances: [instance],
        },
        { ...bridge, id: 'new-native-host' },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_PAGE_UNAVAILABLE' });
    expect(instance.state).toBe('active');
    bridge.invoke = invoke;
    await expect(
      pages.receive(
        'fixture',
        {
          kind: 'sync',
          browserSessionId: target.browserSessionId,
          instances: [instance],
        },
        bridge,
      ),
    ).resolves.toMatchObject({ instances: [{ instance: { instanceId: instance.instanceId } }] });
  });

  it('does not extend the recovery lease on repeated failures and invalidates confirmed missing documents immediately', async () => {
    const instance = await attach();
    const invoke = bridge.invoke;
    bridge.invoke = async (action, input, options) => {
      if (input.operation === 'get') throw new Error('Native host was reaped');
      return invoke(action, input, options);
    };
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      for (const elapsed of [10000, 20000, 29000]) {
        clock.mockReturnValue(now + elapsed);
        await (pages as any).reconcile();
        expect(instance.state).toBe('active');
      }
      clock.mockReturnValue(now + 30001);
      await (pages as any).reconcile();
      expect(instance).toMatchObject({
        state: 'invalidated',
        error: { code: 'PLUGIN_PAGE_INVALIDATED' },
      });
    } finally {
      clock.mockRestore();
    }
    bridge.invoke = invoke;
    const next = await attach();
    documents.delete(next.instanceId);
    await (pages as any).reconcile();
    expect(next.state).toBe('invalidated');
  });

  it('resumes an accepted event only when no task started before the outage', async () => {
    const instance = await attach();
    const invoke = bridge.invoke;
    let probes = 0;
    bridge.invoke = async (action, input, options) => {
      if (input.operation === 'get' && ++probes >= 3) throw new Error('Socket closed');
      return invoke(action, input, options);
    };
    await event(instance.instanceId, 1, { value: 42 });
    await vi.waitFor(() =>
      expect(pages.diagnosticSnapshot()[0]).toMatchObject({ queued: 1, running: 0 }),
    );
    expect(tasks.store.list().filter(record => record.task.command === 'state')).toHaveLength(0);
    bridge.invoke = invoke;
    await (pages as any).reconcile();
    await vi.waitFor(
      async () =>
        expect((await history(instance.instanceId)).events).toContainEqual(
          expect.objectContaining({ type: 'success', eventSequence: 1 }),
        ),
      { timeout: 10000 },
    );
    expect(tasks.store.list().filter(record => record.task.command === 'state')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'saved')).toEqual([
      expect.objectContaining({ value: 42 }),
    ]);
  });

  it('rejects state writes when a page closes while document validation is in flight', async () => {
    const instance = await attach();
    await host.state.call(
      'fixture',
      { operation: 'get', collection: 'cache', instanceId: instance.instanceId, key: 'value' },
      bridge,
    );
    const invoke = bridge.invoke;
    let release!: (value: unknown) => void;
    let waiting = false;
    bridge.invoke = async (action, input, options) => {
      if (input.operation === 'get' && input.instanceId === instance.instanceId && !waiting) {
        waiting = true;
        return new Promise(resolve => {
          release = resolve;
        });
      }
      return invoke(action, input, options);
    };
    const write = host.state.call(
      'fixture',
      {
        operation: 'transact',
        collection: 'cache',
        instanceId: instance.instanceId,
        transaction: {
          operations: [{ type: 'put', key: 'value', value: 1, expectedVersion: 'a:0' }],
        },
      },
      bridge,
    );
    const rejected = expect(write).rejects.toBeDefined();
    await vi.waitFor(() => expect(waiting).toBe(true));
    await pages.call('fixture', { operation: 'detach', instanceId: instance.instanceId }, bridge);
    release({ ...instance, state: 'active' });
    await rejected;
  });

  it('can stop an infinite registration without blocking the service event loop', async () => {
    writeFileSync(join(skill, 'main.mjs'), 'while(true) {}');
    const pending = attach();
    const rejected = expect(pending).rejects.toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 100));
    await pages.close();
    await rejected;
  });
  it('exports page metadata without reading or mutating the browser', async () => {
    const instance = await attach();
    vi.mocked(bridge.invoke).mockClear();
    const diagnostic = host.diagnose({ instanceId: instance.instanceId }, bridge.scope);
    expect(diagnostic.pages[0]).toMatchObject({
      observation: 'service-snapshot',
      binding: { instanceId: instance.instanceId, documentId: target.documentId },
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostic)).not.toContain('https://example.test');
  });

  it('gives document-bound nested plugins their own instance and blocks browser-wide writes', async () => {
    const childRoot = join(directory, 'child');
    mkdirSync(childRoot);
    writeFileSync(join(childRoot, 'SKILL.md'), '# Child');
    writeFileSync(
      join(childRoot, 'main.mjs'),
      `export const pageRuntime={version:1,matches:['https://example.test/*'],code:'host => ({receive: value => value})'};
      export default app => { app.command('page', async () => { const page=await app.page('attach',{tabId:7}); return app.page('send',{instanceId:page.instanceId,message:{type:'child-saved'}}); }); app.command('wide', () => app.invoke('browser_close',{})); };`,
    );
    registerPlugin('child', join(childRoot, 'main.mjs'));
    writeFileSync(
      join(skill, 'main.mjs'),
      fixture.replace(
        "if(event.payload.action) return context.invoke(event.payload.action,{actions:[{action:'page_eval',expression:'1'}]});",
        "if(event.payload.action) return app.invoke('child',{command:event.payload.action,input:{}});",
      ),
    );
    const instance = await attach();
    await event(instance.instanceId, 1, { value: 1, action: 'page' });
    await vi.waitFor(
      async () =>
        expect(
          (await history(instance.instanceId)).events.some((item: any) => item.type === 'success'),
        ).toBe(true),
      { timeout: 10000 },
    );
    const childPage = (
      await pages.call(
        'child',
        { operation: 'list' },
        { ...bridge, scope: { ...bridge.scope, plugin: 'child' } },
      )
    ).instances[0];
    expect(childPage.instanceId).not.toBe(instance.instanceId);
    expect(childPage.plugin).toBe('child');
    expect(childPage.target.documentId).toBe(instance.target.documentId);
    expect(messages).toContainEqual({ type: 'child-saved' });
    await event(instance.instanceId, 2, { value: 2, action: 'wide' });
    await vi.waitFor(
      async () =>
        expect(
          (await history(instance.instanceId)).events.some(
            (item: any) =>
              item.type === 'error' && item.error?.code === 'PLUGIN_PAGE_TARGET_CHANGED',
          ),
        ).toBe(true),
      { timeout: 10000 },
    );
  });

  it('cancels attachment initialization before retaining a ready instance', async () => {
    writeFileSync(
      join(skill, 'main.mjs'),
      fixture.replace('setTimeout(resolve, 30)', 'setTimeout(resolve, 10000)'),
    );
    const controller = new AbortController();
    const pending = pages.call(
      'fixture',
      { operation: 'attach', tabId: 7 },
      bridge,
      {},
      { cwd: directory, environment: {}, signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(
      () => expect(tasks.store.list().some(record => record.task.state === 'running')).toBe(true),
      { timeout: 10000 },
    );
    controller.abort();
    await rejected;
    expect(
      (await pages.call('fixture', { operation: 'list' }, bridge)).instances.every(
        (item: any) => item.state !== 'active',
      ),
    ).toBe(true);
    expect(
      tasks.store
        .list()
        .every(record => !['queued', 'running', 'cancelling'].includes(record.task.state)),
    ).toBe(true);
  });

  it('rejects cancellation during the final browser validation before readiness', async () => {
    const original = bridge.invoke;
    let release!: () => void,
      held = false;
    bridge.invoke = async (action, input, options) => {
      if (
        input.operation === 'get' &&
        !held &&
        tasks.store
          .list()
          .some(record => record.task.command === 'initialize' && record.task.state === 'success')
      ) {
        held = true;
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      return original(action, input, options);
    };
    const controller = new AbortController();
    const pending = pages.call(
      'fixture',
      { operation: 'attach', tabId: 7 },
      bridge,
      {},
      { cwd: directory, environment: {}, signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 10000 });
    controller.abort();
    release();
    await rejected;
    expect(
      (await pages.call('fixture', { operation: 'list' }, bridge)).instances.every(
        (item: any) => item.state !== 'active',
      ),
    ).toBe(true);
  });

  it('keeps initialization on the current caller connection when browser reconciliation rebinds the instance', async () => {
    let release!: () => void;
    const invoke = bridge.invoke;
    bridge.invoke = (action, data, options) =>
      action === 'send_request'
        ? new Promise(resolve => {
            release = () => resolve({ ok: true });
          })
        : invoke(action, data, options);
    writeFileSync(
      join(skill, 'main.mjs'),
      fixture
        .replace(
          'await new Promise(resolve => setTimeout(resolve, 30));',
          "await context.invoke('send_request',{url:'https://example.test/barrier',withCookies:false});",
        )
        .replace(
          "return context.page.send({type:'initialized'});",
          "await context.state('cache','get',{key:'value'}); return context.page.send({type:'initialized'});",
        ),
    );
    const pending = attach();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 10000 });
    const instance = [...documents.values()][0];
    const reconnect = {
      ...bridge,
      id: 'reconciled-browser',
      scope: { ...bridge.scope, access: 'runtime' as const, source: 'runtime' as const },
    };
    await expect(
      pages.receive(
        'fixture',
        { kind: 'sync', browserSessionId: target.browserSessionId, instances: [instance] },
        reconnect,
      ),
    ).resolves.toMatchObject({ instances: [{ instance: { instanceId: instance.instanceId } }] });
    release();
    await expect(pending).resolves.toMatchObject({
      instanceId: instance.instanceId,
      state: 'active',
    });
    expect(
      tasks.store.list().find(record => record.task.command === 'initialize')?.task.state,
    ).toBe('success');
    expect(messages).toContainEqual({ type: 'initialized' });
  });
});
