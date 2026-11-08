import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderControlHostRecord } from '../control-host.js';
import {
  createProviderServer,
  createProviderRuntime,
  validateProviderBrowser,
  MEARL_PROVIDER_PROTOCOL_VERSION,
  type ProviderBrowser,
  type ProviderServer,
  type BrowserProviderDefinition,
} from '../index.js';
import { listProviderBrowserRecords } from '../registry.js';
import { validateInstalledProviderManifest } from '../host.js';

const state = vi.hoisted(() => ({ host: null as ProviderControlHostRecord | null, ensure: vi.fn() }));
vi.mock('../control-host.js', async importOriginal => ({
  ...await importOriginal<typeof import('../control-host.js')>(),
  readProviderControlHost: () => state.host,
  ensureProviderControlHost: async () => {
    state.ensure();
    return state.host ??= { controlSessionModes: ['mearl', 'external'] } as ProviderControlHostRecord;
  },
}));

const servers: ProviderServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
  state.host = null;
  state.ensure.mockClear();
});

function browser(mode?: 'mearl' | 'external'): ProviderBrowser {
  return {
    browserId: 'space-1',
    name: 'External space',
    status: 'connected',
    ownership: 'attached',
    persistence: 'persistent',
    operations: ['detach'],
    control: {
      kind: 'provider',
      capabilities: {
        actions: ['page_eval'],
        screenshot: 'none',
        ...(mode === undefined ? {} : { controlSessionMode: mode }),
      },
    },
  };
}

async function fixture(overrides: Partial<BrowserProviderDefinition> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-external-control-'));
  directories.push(directory);
  const handleAction = vi.fn(async () => ({ value: 42 }));
  const server = createProviderServer({
    socketPath: join(directory, 'provider.sock'),
    definition: {
      descriptor: { providerId: 'external-' + basename(directory), name: 'Fixture', version: '1.0.0' },
      browserType: { name: 'Fixture', controlSessionModes: ['mearl', 'external'], inputSchema: { type: 'object', properties: {} } },
      launch: async () => browser('external'),
      close: async () => {},
      detach: async () => {},
      handleAction,
      ...overrides,
    },
  });
  servers.push(server);
  await server.start();
  return { server, handleAction };
}

function request(server: ProviderServer, action = 'page_eval', data: Record<string, unknown> = { expression: '42' }) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(server.socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({
      id: 'test', action, browserId: 'space-1', data,
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
    }) + '\n'));
    socket.on('data', data => response += data);
    socket.on('end', () => {
      try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}

describe('external Provider task control', () => {
  it('preserves a validated initial environment across the actual Provider socket without forwarding other fields', async () => {
    const device = { userAgent: 'Host', platform: 'Host', userAgentMetadata: null,
      screen: { width: 1920, height: 1080, deviceScaleFactor: 1, orientation: 'landscape-primary', angle: 0 },
      touchPoints: 0, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    const target = { tabId: 11, ready: true as const, targetId: 'physical', url: 'https://example.test',
      initialEnvironment: { device }, unrelated: 'must not forward' };
    const { server } = await fixture({ getEnhancementTarget: async () => target });
    server.updateBrowsers([await server.runtime.launch({})]);
    const result = await request(server, '__provider_enhancement_target', { tabId: 11 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ tabId: 11, ready: true, targetId: 'physical', url: 'https://example.test', initialEnvironment: { device } });
    expect(JSON.stringify(result)).not.toContain('must not forward');
  });

  it('prepares a missing host before startup can accept a launch request', async () => {
    const { server } = await fixture();
    expect(state.ensure).toHaveBeenCalledOnce();
    expect(state.host?.controlSessionModes).toContain('external');
    expect(await server.runtime.listBrowsers()).toEqual([]);
  });

  it('refuses an old host before running any launch side effects', async () => {
    state.host = {} as ProviderControlHostRecord;
    const launch = vi.fn(async () => browser('external'));
    await expect(fixture({ launch })).rejects.toThrow('CONTROL_SESSION_MODE_UNSUPPORTED');
    expect(launch).not.toHaveBeenCalled();
  });

  it('rechecks the prerequisite before launch if a running host is replaced by an older one', async () => {
    const launch = vi.fn(async () => browser('external'));
    const { server } = await fixture({ launch });
    state.host = {} as ProviderControlHostRecord;
    expect(await request(server, 'browser_launch')).toMatchObject({
      success: false, error: expect.stringContaining('CONTROL_SESSION_MODE_UNSUPPORTED'),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('keeps default Provider startup independent of the control host', async () => {
    state.host = {} as ProviderControlHostRecord;
    await fixture({ browserType: { name: 'Legacy', inputSchema: { type: 'object', properties: {} } } });
    expect(state.ensure).not.toHaveBeenCalled();
  });

  it.each([[], ['other'], ['mearl', 'mearl'], null])('rejects invalid declared modes %s', modes => {
    expect(() => createProviderRuntime({
      descriptor: { providerId: 'fixture', name: 'Fixture', version: '1' },
      browserType: { name: 'Fixture', controlSessionModes: modes as any, inputSchema: { type: 'object', properties: {} } },
      launch: async () => browser(), close: async () => {},
    })).toThrow('control session modes are invalid');
    expect(validateInstalledProviderManifest({
      providerId: 'fixture', name: 'Fixture', version: '1', protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
      browserType: { name: 'Fixture', controlSessionModes: modes as any, inputSchema: { type: 'object', properties: {} } },
      packageName: 'fixture', packageRoot: '/tmp/fixture', entryPath: '/tmp/fixture/runtime.js',
    })).toBe('browserType is invalid');
  });
  it.each([undefined, 'mearl', 'external'] as const)('accepts mode %s without adding a default field', mode => {
    const input = browser(mode);
    expect(() => validateProviderBrowser(input)).not.toThrow();
    expect(input.control).toEqual(browser(mode).control);
  });

  it.each([null, '', 'ego', true, 1])('rejects invalid mode %s', mode => {
    const input = browser();
    Object.assign((input.control as { capabilities: object }).capabilities, { controlSessionMode: mode });
    expect(() => validateProviderBrowser(input)).toThrow('invalid control session mode');
  });

  it('does not allow a delegated host transport to bypass its Mearl control lifecycle', () => {
    const input = browser('external');
    input.control = { ...input.control, kind: 'host', transport: 'extension', browserId: 'original' } as any;
    expect(() => validateProviderBrowser(input)).toThrow('require Provider control');
  });

  it('refuses publication before changing runtime or registry when the host is absent or old', async () => {
    const { server } = await fixture();
    const original = browser();
    server.updateBrowsers([original]);
    for (const host of [null, { controlSessionModes: undefined }]) {
      state.host = host as ProviderControlHostRecord | null;
      expect(() => server.updateBrowsers([browser('external')])).toThrow('CONTROL_SESSION_MODE_UNSUPPORTED');
      expect(await server.runtime.listBrowsers()).toEqual([original]);
      expect(listProviderBrowserRecords().find(record => record.provider.id === server.runtime.definition.descriptor.providerId)?.capabilities?.controlSessionMode).toBeUndefined();
    }
  });

  it('preserves the mode in published records and stops dispatch if host support disappears', async () => {
    const { server, handleAction } = await fixture();
    state.host = { controlSessionModes: ['mearl', 'external'] } as ProviderControlHostRecord;
    server.updateBrowsers([browser('external')]);
    expect(listProviderBrowserRecords().find(record => record.provider.id === server.runtime.definition.descriptor.providerId)?.capabilities?.controlSessionMode).toBe('external');
    expect(await request(server)).toMatchObject({ success: true, data: { value: 42 } });
    expect(handleAction).toHaveBeenCalledOnce();
    state.host = {} as ProviderControlHostRecord;
    expect(await request(server)).toMatchObject({ success: false, error: expect.stringContaining('CONTROL_SESSION_MODE_UNSUPPORTED') });
    expect(await request(server, 'browser_instances')).toMatchObject({ success: false });
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it.each(['mearl', 'external'] as const)('rejects dynamic list mode changes after selecting %s', async mode => {
    const other = mode === 'mearl' ? 'external' : 'mearl';
    const listBrowsers = vi.fn().mockResolvedValueOnce([browser(mode)]).mockResolvedValue([browser(other)]);
    const { server, handleAction } = await fixture({ listBrowsers });
    expect(await request(server)).toMatchObject({ success: false, error: expect.stringContaining('CONTROL_SESSION_MODE_CHANGED') });
    expect(handleAction).not.toHaveBeenCalled();
  });

  it('does not remember modes from a failed batch and preserves the mode through stopped state', async () => {
    const { server } = await fixture();
    const invalid = { ...browser(), browserId: 'invalid', operations: ['syncCookies'] } as ProviderBrowser;
    expect(() => server.runtime.updateBrowsers([browser(), invalid])).toThrow('without implementing');
    server.runtime.updateBrowsers([browser('external')]);
    const stopped = { ...browser(), status: 'stopped', control: { kind: 'none' } } as ProviderBrowser;
    server.runtime.updateBrowsers([stopped]);
    expect(() => server.runtime.updateBrowsers([browser()])).toThrow('CONTROL_SESSION_MODE_CHANGED');
    server.runtime.updateBrowsers([browser('external')]);
  });

  it('requires external support to be declared before an external instance can be returned', async () => {
    const { server } = await fixture({ browserType: { name: 'Legacy', inputSchema: { type: 'object', properties: {} } } });
    expect(() => server.runtime.updateBrowsers([browser('external')])).toThrow('did not declare');
  });

  it('checks instance mode on launch and start results, including after stopped state', async () => {
    const { server } = await fixture({ start: async () => browser('external') });
    server.runtime.updateBrowsers([browser()]);
    await expect(server.runtime.launch({})).rejects.toThrow('CONTROL_SESSION_MODE_CHANGED');
    server.runtime.updateBrowsers([{ ...browser(), status: 'stopped', control: { kind: 'none' }, operations: ['start'] }]);
    await expect(server.runtime.start({ browserId: 'space-1' })).rejects.toThrow('CONTROL_SESSION_MODE_CHANGED');
  });
});
