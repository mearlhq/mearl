import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderEnhancementClient } from '../enhancements.js';
import { createProviderAppResourceClient } from '../app-resources.js';
import { createHash } from 'node:crypto';
import { resolveAppProfile } from '../../../app-profiles/src/index.js';
import type { AppProfileDefinition } from '@mearl/browser-core';

const state = vi.hoisted(() => ({ host: {} as any, ensure: vi.fn() }));
vi.mock('../control-host.js', () => ({ ensureProviderControlHost: async () => { state.ensure(); return state.host; } }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(stop => stop()));
  vi.clearAllMocks();
});

const binding = { bindingId: 'binding', generation: 1, tabId: 7, mainFrameId: 'main', actions: ['set_timezone'], nativeBrowserId: 'native', providerTabId: 11 };
async function fixture(reply?: (request: any, socket: net.Socket) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-enhancements-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\mearl-enhancements-${process.pid}-${Date.now()}` : join(directory, 'host.sock');
  const requests: any[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      requests.push(request);
      if (reply) return reply(request, socket);
      const result = request.data.operation === 'bind' ? { binding }
        : request.data.operation === 'release' ? { released: true } : { result: { enabled: true } };
      socket.end(JSON.stringify({ id: request.id, success: true, data: result }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  state.host = { socketPath, enhancementProtocolVersion: 1, token: 'host-private-proof' };
  return { requests, client: createProviderEnhancementClient('fixture', 'space'), resources: createProviderAppResourceClient('fixture', 'space') };
}

describe('Provider SDK enhancement client', () => {
  it('negotiates host-platform support without supplying the Creator policy in the request payload', async () => {
    const { requests } = await fixture(), client = createProviderEnhancementClient('fixture', 'space', { requireHostEnvironment: true });
    const request = { providerTabId: 11, actions: ['set_timezone' as const] };
    await expect(client.bind(request)).rejects.toThrow('cannot preserve the captured host environment');
    expect(requests).toEqual([]);
    state.host.enhancementHostEnvironmentVersion = 1;
    await client.bind(request);
    expect(requests[0].data).toEqual({ ...request, operation: 'bind' });
  });
  it('rejects a binding returned by a different native host than requested', async () => {
    const { client } = await fixture();
    await expect(client.bind({ providerTabId: 11, nativeBrowserId: 'selected', actions: ['set_timezone'] })).rejects.toThrow('Invalid enhancement binding response');
  });
  it('negotiates preparation support before requesting a fixed Extension page', async () => {
    const preparation = { nativeBrowserId: 'native', providerTabId: 11, tabId: 7, targetId: 'physical',
      url: `chrome-extension://${'a'.repeat(32)}/src/pages/browser-transport/index.html`,
      capabilities: { protocolVersion: 1, navigationOriginVersion: 1, preparationVersion: 1, actions: ['set_app_profile'] } };
    const { client, requests } = await fixture((request, socket) => socket.end(JSON.stringify({ id: request.id, success: true, data: { preparation } }) + '\n'));
    state.host.enhancementNavigationOriginVersion = 1;
    const request = { providerTabId: 11, actions: ['set_app_profile' as const], navigationOrigin: 'https://example.test' };
    await expect(client.inspect(request)).rejects.toThrow('cannot negotiate a preparation page');
    expect(requests).toEqual([]);
    state.host.enhancementPreparationVersion = 1;
    expect(await client.inspect(request)).toEqual(preparation);
    expect(requests[0].data).toEqual({ ...request, operation: 'inspect' });
    preparation.url += '?untrusted=1';
    await expect(client.inspect(request)).rejects.toThrow('Invalid enhancement preparation response');
  });
  it('does not send a first-navigation origin through an older host that would drop it', async () => {
    const { client, requests } = await fixture();
    const request = { providerTabId: 11, actions: ['set_timezone' as const], navigationOrigin: 'https://example.test' };
    await expect(client.bind(request)).rejects.toThrow('cannot authorize a first navigation origin');
    expect(requests).toEqual([]);
    state.host.enhancementNavigationOriginVersion = 1;
    await client.bind(request);
    expect(requests[0].data.navigationOrigin).toBe('https://example.test');
  });
  it('negotiates App resource support before opening a connection and retains absolute deadlines', async () => {
    const { requests } = await fixture();
    const client = createProviderAppResourceClient('fixture', 'space');
    await expect(client.catalog()).rejects.toThrow('APP_RESOURCES_UNSUPPORTED');
    expect(requests).toEqual([]);
    state.ensure.mockClear();
    await expect(client.catalog({}, Date.now() - 1)).rejects.toThrow('deadline');
    expect(state.ensure).not.toHaveBeenCalled();
  });
  it('reverifies runtime bytes, definition revision and the requested source page', async () => {
    const source = 'module.exports={install(){}};', runtime = { id: 'sample/runtime', sha256: createHash('sha256').update(source).digest('hex') };
    const definition: AppProfileDefinition = { name: 'sample/reader', label: 'Sample', appName: 'Sample', defaultAppVersion: '1', uaTokens: [], globals: {}, bridges: [], activeEvents: [], actions: { open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [] }, schemes: [], pageRuntime: runtime };
    const resolved = resolveAppProfile(definition.name, {}, definition);
    const result = { capabilityRevision: 'a'.repeat(64), installationRevision: null, config: resolved.injected, recommendedPreset: resolved.recommendedPreset,
      target: { tabId: 11, ready: true, targetId: 'physical', url: 'https://example.test' }, runtime: { binding: runtime, source } };
    const { resources } = await fixture((request, socket) => socket.end(JSON.stringify({ id: request.id, success: true, data: result }) + '\n'));
    state.host.appResourceProtocolVersion = 1;
    const request = { providerTabId: 11, profile: definition.name };
    expect((await resources.resolve(request)).runtime?.source).toBe(source);
    result.runtime.source = 'changed';
    await expect(resources.resolve(request)).rejects.toThrow('integrity');
    result.runtime.source = source; result.config.binding!.revision = 'c'.repeat(64);
    await expect(resources.resolve(request)).rejects.toThrow('definition revision');
    result.config = resolveAppProfile(definition.name, {}, definition).injected; result.target.tabId = 12;
    await expect(resources.resolve(request)).rejects.toThrow('IDENTITY_UNAVAILABLE');
  });
  it('uses only the scoped gateway and preserves results without exposing host proof', async () => {
    const { client, requests } = await fixture();
    const bound = await client.bind({ providerTabId: 11, actions: ['set_timezone'] });
    expect(await client.invoke(bound, { action: 'set_timezone', data: { tabId: 11, timezone: 'UTC' } })).toEqual({ enabled: true });
    expect(await client.release(bound)).toEqual({ released: true });
    expect(requests.map(request => request.data.operation)).toEqual(['bind', 'invoke', 'release']);
    expect(requests.every(request => request.action === '__provider_enhancement' && request.providerTarget === 'provider:fixture:space')).toBe(true);
    expect(requests.every(request => request.providerControlToken === undefined && request.controlSessionId === undefined)).toBe(true);
  });

  it('rejects old hosts before sending a request and never falls back to ordinary actions', async () => {
    const { client, requests } = await fixture();
    delete state.host.enhancementProtocolVersion;
    await expect(client.bind({ providerTabId: 11, actions: ['set_timezone'] })).rejects.toThrow('BROWSER_ENHANCEMENT_UNSUPPORTED');
    expect(requests).toEqual([]);
  });

  it('keeps caller deadlines outside business options and refuses expired work before startup', async () => {
    const { client, requests } = await fixture();
    await expect(client.bind({ providerTabId: 11, actions: ['set_timezone'] }, Date.now() - 1)).rejects.toThrow('deadline');
    expect(state.ensure).not.toHaveBeenCalled();
    const deadline = Date.now() + 3000;
    await client.bind({ providerTabId: 11, actions: ['set_timezone'] }, deadline);
    expect(requests[0].deadline).toBe(deadline);
    expect(requests[0].data.deadline).toBeUndefined();
  });

  it('does not replay or send another mutation after a lost response until explicit rebind', async () => {
    let lose = true;
    const { client, requests } = await fixture((request, socket) => {
      if (request.data.operation === 'invoke' && lose) { socket.destroy(); return; }
      socket.end(JSON.stringify({ id: request.id, success: true, data: request.data.operation === 'bind' ? { binding } : { result: {} } }) + '\n');
    });
    const bound = await client.bind({ providerTabId: 11, actions: ['set_timezone'] });
    await expect(client.invoke(bound, { action: 'set_timezone', data: { tabId: 11, timezone: 'UTC' } })).rejects.toThrow('closed');
    await expect(client.invoke(bound, { action: 'set_timezone', data: { tabId: 11, timezone: 'UTC' } })).rejects.toThrow('ENVIRONMENT_UNCONFIRMED');
    expect(requests.filter(request => request.data.operation === 'invoke')).toHaveLength(1);
    lose = false;
    const rebound = await client.bind({ providerTabId: 11, actions: ['set_timezone'] });
    await expect(client.invoke(rebound, { action: 'set_timezone', data: { tabId: 11, timezone: 'UTC' } })).resolves.toEqual({});
  });

  it('does not expose page input through its enhancement method', async () => {
    const { client, requests } = await fixture();
    const bound = await client.bind({ providerTabId: 11, actions: ['set_timezone'] });
    await expect(client.invoke(bound, { action: 'page_eval', data: { expression: '42' } } as any)).rejects.toThrow('SCOPE_MISMATCH');
    expect(requests).toHaveLength(1);
  });
});
