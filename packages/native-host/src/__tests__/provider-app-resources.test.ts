import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appProfileRevision, type AppProfileDefinition } from '@mearl/browser-core';
import { NodePageRuntimeStore } from '@mearl/daemon-core/page-runtimes';
import { acceptedAppResources, ProviderAppResourceService } from '../provider-app-resources.js';
import type { BrowserRecord } from '../browser-registry.js';

const state = vi.hoisted(() => ({ revision: 'a'.repeat(64), catalog: vi.fn(), get: vi.fn() }));
vi.mock('../native-capability-services.js', () => ({ nativeCapabilities: {
  refresh: async () => state.revision,
  status: () => ({ revision: state.revision, installationRevision: 'b'.repeat(64) }), get: state.get,
} }));
vi.mock('../app-profile-catalog.js', () => ({ listInstalledAppProfiles: state.catalog }));
const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); vi.clearAllMocks(); state.revision = 'a'.repeat(64); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-app-resource-')); directories.push(directory);
  const source = 'module.exports = { install() {} };';
  const binding = { id: 'sample/runtime', sha256: createHash('sha256').update(source).digest('hex') };
  const definition: AppProfileDefinition = { name: 'sample/reader', label: 'Sample', appName: 'Sample', defaultAppVersion: '1',
    uaTokens: ['Sample/{v}'], globals: { sample: '1' }, bridges: [], activeEvents: [], schemes: [],
    actions: { open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [] } };
  const snapshot = { revision: 'a'.repeat(64), installationRevision: 'b'.repeat(64),
    catalog: { profiles: [{ id: definition.name, label: definition.label, source: 'plugin' as const, revision: appProfileRevision(definition), definition }], errors: [] },
    runtime: vi.fn(() => source), defaultRuntime: vi.fn(() => binding),
  };
  const provider = { pid: process.pid, browserId: 'provider:sample:space', providerBrowserId: 'space', startedAt: 'start', transport: 'provider', status: 'connected',
    capabilities: { controlSessionMode: 'external' }, provider: { id: 'sample', protocolVersion: 3 } } as BrowserRecord;
  const verify = vi.fn(async () => ({ tabId: 7, ready: true as const, targetId: 'physical', url: 'https://example.test' }));
  const load = vi.fn(async () => snapshot);
  const store = new NodePageRuntimeStore(directory), resolve = vi.spyOn(store, 'resolve');
  const service = new ProviderAppResourceService({ browsers: () => [provider], snapshot: load, verify, store });
  const request = { operation: 'resolve' as const, providerTabId: 7, profile: definition.name, options: { appVersion: '2' } };
  return { service, provider, verify, load, snapshot, source, binding, definition, request, resolve };
}

describe('accepted App resources for external Providers', () => {
  it('discovers metadata without runtime code or page handle access', async () => {
    const f = fixture(); const result = await f.service.invoke(f.provider.browserId, { operation: 'catalog' });
    expect(result).toMatchObject({ catalog: { status: 'available', entries: [{ id: f.definition.name }] } });
    expect(JSON.stringify(result)).not.toContain(f.source);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
  });
  it('resolves a matching definition, default runtime and exact source without creating browser references', async () => {
    const f = fixture(); const result = await f.service.invoke(f.provider.browserId, f.request);
    expect(result).toMatchObject({ config: { profile: f.definition.name, pageRuntime: f.binding, binding: { options: { appVersion: '2' } } }, runtime: { binding: f.binding, source: f.source }, target: { targetId: 'physical' } });
    expect(f.resolve).toHaveBeenCalledWith(f.binding, f.snapshot.runtime);
    expect(f.verify).toHaveBeenCalledTimes(2);
    if (!('config' in result)) throw new Error('Expected config');
    expect(result.config.binding?.revision).toBe(appProfileRevision(result.config.binding!.definition));
  });
  it('rejects missing and corrupt runtime resources rather than accepting UA-only simulation', async () => {
    const f = fixture(); f.snapshot.defaultRuntime.mockReturnValue(undefined as any);
    await expect(f.service.invoke(f.provider.browserId, f.request)).rejects.toThrow('runtime is not installed');
    f.snapshot.defaultRuntime.mockReturnValue(f.binding); f.snapshot.runtime.mockReturnValue('changed code');
    await expect(f.service.invoke(f.provider.browserId, f.request)).rejects.toThrow('integrity');
  });
  it('rejects paused, stale and unrelated source identities before returning resources', async () => {
    const f = fixture();
    await expect(f.service.invoke('other', f.request)).rejects.toThrow('OWNER_UNAVAILABLE');
    f.verify.mockResolvedValueOnce({ tabId: 7, ready: false } as any);
    await expect(f.service.invoke(f.provider.browserId, f.request)).rejects.toThrow('PAUSED');
    expect(f.load).not.toHaveBeenCalled();
    f.verify.mockResolvedValueOnce({ tabId: 7, ready: true, targetId: 'old', url: 'https://example.test' });
    await expect(f.service.invoke(f.provider.browserId, f.request)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
  });
  it('rechecks owner epoch and deadline after asynchronous catalog preparation', async () => {
    const f = fixture(); f.load.mockImplementationOnce(async () => { f.provider.startedAt = 'new'; return f.snapshot; });
    await expect(f.service.invoke(f.provider.browserId, f.request)).rejects.toThrow('OWNER_CHANGED');
    const deadline = Date.now() + 1000, clock = vi.spyOn(Date, 'now');
    f.load.mockImplementationOnce(async () => { clock.mockReturnValue(deadline); return f.snapshot; });
    try { await expect(f.service.invoke(f.provider.browserId, f.request, deadline)).rejects.toThrow('deadline'); }
    finally { clock.mockRestore(); }
  });
  it('does not accept caller-supplied code, definitions or arbitrary option fields', async () => {
    const f = fixture();
    await expect(f.service.invoke(f.provider.browserId, { ...f.request, source: f.source } as any)).rejects.toThrow('Invalid');
    await expect(f.service.invoke(f.provider.browserId, { ...f.request, options: { definition: f.definition } } as any)).rejects.toThrow('Unsupported');
  });
  it('reads only the accepted Skill catalog and refuses a mixed capability snapshot', async () => {
    state.catalog.mockResolvedValueOnce({ profiles: [], errors: [] });
    await acceptedAppResources();
    expect(state.catalog).toHaveBeenCalledWith({ refresh: false });
    state.catalog.mockImplementationOnce(async () => { state.revision = 'c'.repeat(64); return { profiles: [], errors: [] }; });
    await expect(acceptedAppResources()).rejects.toThrow('CATALOG_CHANGED');
  });
});
