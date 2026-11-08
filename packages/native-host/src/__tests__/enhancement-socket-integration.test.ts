import net from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProviderEnhancementClient, createProviderAppResourceClient, createProviderServer, type ProviderServer } from '../../../provider/src/index.js';
import { appProfileRevision, type AppProfileDefinition } from '@mearl/browser-core';
import { NodePageRuntimeStore } from '@mearl/daemon-core/page-runtimes';
import { ProviderAppResourceService } from '../provider-app-resources.js';
import { ProviderEnhancementService } from '../provider-enhancements.js';
import { BrowserEnhancementGateway } from '../browser-enhancement-gateway.js';
import { browserConnectionIdentity, type BrowserRecord } from '../browser-registry.js';
import { requestBrowserSocket } from '../browser-socket-request.js';
import { ControlSessionRegistry } from '../control-session.js';

const state = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { directory: mkdtempSync(join(tmpdir(), 'mearl-gateway-')), host: {} as any };
});
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => state.directory,
}));
vi.mock('../../../provider/src/control-host.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../provider/src/control-host.js')>(),
  readProviderControlHost: () => state.host,
  ensureProviderControlHost: async () => state.host,
}));

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
let providerServer: ProviderServer | undefined;
beforeEach(() => { mkdirSync(state.directory, { recursive: true }); });
afterEach(async () => {
  await providerServer?.stop();
  sockets.forEach(socket => socket.destroy());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  rmSync(state.directory, { recursive: true, force: true });
});

async function listen(name: string, dispatch: (request: any) => Promise<unknown>) {
  const socketPath = join(state.directory, name + '.sock');
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      void dispatch(request).then(data => socket.end(JSON.stringify({ id: request.id, success: true, data }) + '\n'),
        error => socket.end(JSON.stringify({ id: request.id, success: false, error: error.message }) + '\n'));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return socketPath;
}

it('serves independent identity callbacks while the original Provider action awaits the broker and native host', async () => {
  const providerId = 'socket-fixture';
  const deadline = Date.now() + 5000;
  const browser = {
    browserId: 'space', name: 'Space', status: 'connected', ownership: 'attached', persistence: 'persistent', operations: ['detach'],
    control: { kind: 'provider', capabilities: { actions: ['set_timezone'], screenshot: 'none', controlSessionMode: 'external' } },
  } as const;
  const owner = {
    pid: process.pid, startedAt: 'source', browserId: 'provider:socket-fixture:space', providerBrowserId: 'space',
    transport: 'provider', status: 'connected', provider: { id: providerId, protocolVersion: 3 },
    capabilities: browser.control.capabilities,
  } as unknown as BrowserRecord;
  const native = { pid: process.pid, browserId: 'native', startedAt: 'native', transport: 'extension' } as BrowserRecord;
  const browsers = [owner, native];
  let actionRunning = false, ordinaryCalls = 0, checks = 0;
  const client = createProviderEnhancementClient(providerId, 'space');
  const forward = (record: BrowserRecord, action: string, data: any, expires?: number) =>
    requestBrowserSocket(record.socketPath, action, data, 'test', 5000, record.providerBrowserId, undefined, { deadline: expires });
  const service = new ProviderEnhancementService({
    browsers: () => browsers, request: forward,
    enhance: (record, source, request, expires, providerPageId) => requestBrowserSocket(record.socketPath,
      '__provider_enhancement', request, 'test', 5000, undefined, undefined,
      { deadline: expires, providerTarget: source.browserId, providerControlToken: state.host.token,
        providerSourceIdentity: browserConnectionIdentity(source), providerPageId }),
  });
  state.host = { pid: process.pid, token: 'private-proof', ready: true, enhancementProtocolVersion: 1, controlSessionModes: ['external'] };
  state.host.socketPath = await listen('broker', request => service.invoke(request.providerTarget, request.data, request.deadline));
  const registry = new ControlSessionRegistry(() => 'native');
  const extension = vi.fn(async (request: any) => {
    expect(request.deadline).toBe(deadline);
    if (request.operation === 'probe') return { capabilities: { protocolVersion: 1, actions: ['set_timezone'] }, tabId: 7, mainFrameId: 'frame' };
    if (request.operation === 'bind') return { binding: { bindingId: 'extension-private', generation: 1, tabId: 7, mainFrameId: 'frame', actions: ['set_timezone'] } };
    expect(request.data).toEqual({ tabId: 7, timezone: 'UTC' });
    return { result: { enabled: true } };
  });
  const gateway = new BrowserEnhancementGateway({
    browsers: () => browsers, controlHost: () => state.host, available: () => true, tabs: async () => [7],
    run: (action, data, work) => registry.run(undefined, action, data, work),
    verifySource: (source, tabId, expires) => forward(source, '__provider_enhancement_target', { tabId }, expires),
    invoke: (request, expires) => extension({ ...request, deadline: expires }) as any,
  });
  native.socketPath = await listen('native', request => request.action === 'tab_list'
    ? Promise.resolve({ tabs: [{ tabId: 7, url: 'https://example.test' }] })
    : gateway.invoke(request.providerTarget, request.providerControlToken, request.data, request.deadline,
      request.providerSourceIdentity, request.providerPageId));
  providerServer = createProviderServer({ socketPath: join(state.directory, 'source.sock'), definition: {
    descriptor: { providerId, name: 'Fixture', version: '1' },
    browserType: { name: 'Fixture', controlSessionModes: ['external'], inputSchema: { type: 'object', properties: {} } },
    listBrowsers: async () => [browser as any], launch: async () => browser as any, close: async () => {}, detach: async () => {},
    getEnhancementTarget: async (request, context) => {
      expect(actionRunning).toBe(true); expect(context.deadline).toBe(deadline); checks++;
      return { tabId: request.tabId, ready: true, mainFrameId: 'frame', url: 'https://example.test' };
    },
    handleAction: async context => {
      ordinaryCalls++; actionRunning = true;
      try {
        const binding = await client.bind({ providerTabId: 11, actions: ['set_timezone'] }, context.deadline);
        expect(binding.bindingId).not.toBe('extension-private');
        return await client.invoke(binding, { action: 'set_timezone', data: { tabId: 11, timezone: 'UTC' } }, context.deadline);
      } finally { actionRunning = false; }
    },
  } });
  await providerServer.start(); owner.socketPath = providerServer.socketPath;
  expect(await forward(owner, 'set_timezone', { tabId: 11, timezone: 'UTC' }, deadline)).toEqual({ enabled: true });
  expect(ordinaryCalls).toBe(1); expect(checks).toBe(6);
  expect(extension.mock.calls.map(call => call[0].operation)).toEqual(['probe', 'bind', 'invoke']);
  expect(registry.list()).toEqual([]);
});

it('resolves verified runtime code larger than 1 MiB through a reentrant source callback', async () => {
  const providerId = 'resource-fixture', deadline = Date.now() + 10_000;
  const source = '/*' + 'runtime-padding'.repeat(90_000) + '*/module.exports={install(){}};';
  const binding = { id: 'sample/runtime', sha256: createHash('sha256').update(source).digest('hex') };
  const definition: AppProfileDefinition = { name: 'sample/reader', label: 'Sample', appName: 'Sample', defaultAppVersion: '1', uaTokens: [], globals: {}, bridges: [], activeEvents: [], schemes: [], pageRuntime: binding,
    actions: { open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [] } };
  const browser = { browserId: 'space', name: 'Space', status: 'connected', ownership: 'attached', persistence: 'persistent', operations: ['detach'],
    control: { kind: 'provider', capabilities: { actions: ['set_app_profile'], screenshot: 'none', controlSessionMode: 'external' } } } as const;
  const owner = { pid: process.pid, startedAt: 'source', browserId: 'provider:resource-fixture:space', providerBrowserId: 'space', transport: 'provider', status: 'connected',
    provider: { id: providerId, protocolVersion: 3 }, capabilities: browser.control.capabilities } as BrowserRecord;
  const forward = (browser: BrowserRecord, action: string, data: any, expires?: number) => requestBrowserSocket(browser.socketPath, action, data, '3',
    expires ? Math.max(1, expires - Date.now()) : 5000, browser.providerBrowserId, undefined, { deadline: expires });
  const resources = new ProviderAppResourceService({ browsers: () => [owner],
    verify: (browser, tabId, expires) => forward(browser, '__provider_enhancement_target', { tabId }, expires),
    snapshot: async () => ({ revision: 'a'.repeat(64), installationRevision: 'b'.repeat(64), defaultRuntime: undefined, runtime: () => source,
      catalog: { profiles: [{ id: definition.name, label: definition.label, source: 'plugin', revision: appProfileRevision(definition), definition }], errors: [] } }),
    store: new NodePageRuntimeStore(join(state.directory, 'cache')),
  });
  let actionRunning = false, checks = 0;
  const client = createProviderAppResourceClient(providerId, 'space');
  state.host = { protocolVersion: 3, controlSessionModes: ['mearl', 'external'], appResourceProtocolVersion: 1, ready: true, token: 'test', socketPath: await listen('resources', request => {
    expect(request.action).toBe('__provider_app_resources'); expect(request.controlSource).toBe('local');
    return resources.invoke(request.providerTarget, request.data, request.deadline);
  }) };
  providerServer = createProviderServer({ socketPath: join(state.directory, 'resource-source.sock'), definition: {
    descriptor: { providerId, name: 'Fixture', version: '1' }, browserType: { name: 'Fixture', controlSessionModes: ['external'], inputSchema: { type: 'object', properties: {} } },
    listBrowsers: async () => [browser as any], launch: async () => browser as any, close: async () => {}, detach: async () => {},
    getEnhancementTarget: async request => { expect(actionRunning).toBe(true); checks++; return { tabId: request.tabId, ready: true, targetId: 'physical', url: 'https://example.test' }; },
    handleAction: async context => {
      actionRunning = true;
      try {
        const resolved = await client.resolve({ providerTabId: 11, profile: definition.name }, context.deadline);
        expect(resolved.runtime?.source).toBe(source);
        expect(resolved.config.binding?.revision).toBe(appProfileRevision(definition));
        return { prepared: true, runtimeBytes: Buffer.byteLength(resolved.runtime!.source) };
      } finally { actionRunning = false; }
    },
  } });
  await providerServer.start(); owner.socketPath = providerServer.socketPath;
  const result = await forward(owner, 'set_app_profile', { tabId: 11, enabled: true, profile: definition.name }, deadline);
  expect(result).toEqual({ prepared: true, runtimeBytes: Buffer.byteLength(source) }); expect(checks).toBe(2);
});
