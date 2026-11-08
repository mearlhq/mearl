import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserBundleStore, bundleDigest, preparePreset, receiveBrowserPreset, type PresetTransferRequest } from '@mearl/preset/bundles';
import { PresetBrowserTransfer, PresetInstallationStore, PresetInstaller } from '../preset.js';

const source = 'https://example.com/team.json';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
let directory: string;
const stores: BrowserBundleStore[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mearl-browser-transfer-')); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
function browserStore(factory = new IDBFactory()) {
  const store = new BrowserBundleStore({ indexedDB: factory, mearlApiVersion: '1.0.0' });
  stores.push(store);
  return { store, factory };
}
async function fixture(large = false) {
  const sources = new Map<string, Uint8Array>();
  const profile = encode({ name: 'simulation/default' });
  const runtime = new TextEncoder().encode('module.exports.install = () => {};' + (large ? ' '.repeat(1200000) : ''));
  const node = new TextEncoder().encode('module.exports = () => ({ identity: () => "node-only-code" });');
  const setPackage = async (id: string, resources: Record<string, Uint8Array>, contributions: unknown) => {
    for (const [name, bytes] of Object.entries(resources)) sources.set(`https://example.com/${id}/${name}`, bytes);
    sources.set(`https://example.com/${id}/bundle.json`, encode({ schemaVersion: 1, id, version: '1.0.0', resources: Object.fromEntries(await Promise.all(Object.entries(resources).map(async ([name, bytes]) => [name, { sha256: await bundleDigest(bytes), byteLength: bytes.byteLength }]))), contributions }));
  };
  await setPackage('simulation', { 'profile.json': profile, 'runtime.cjs': runtime }, { appProfiles: ['profile.json'], pageRuntimes: { main: 'runtime.cjs' } });
  await setPackage('identity', { 'node.cjs': node }, { appProfiles: [], nodeRuntimes: { 'native-host': { entry: 'node.cjs', bindings: { 'sample.identity': 'identity' } } } });
  const manifest = { schemaVersion: 1, id: 'team', version: '1.0.0', packages: { simulation: { source: './simulation/bundle.json', targets: ['browser'] }, identity: { source: './identity/bundle.json', targets: ['node'] } }, appProfiles: { sample: 'simulation/default' } };
  sources.set(source, encode(manifest));
  const load = vi.fn(async (url: string) => { const bytes = sources.get(url); if (!bytes) throw new Error('Unexpected download'); return bytes; });
  const prepared = await preparePreset(source, { load, mearlApiVersion: '1.0.0' });
  const store = new PresetInstallationStore({ directory });
  const receipt = await store.apply(prepared, { expectedRevision: null, overrides: { locale: 'zh' } });
  const service = new PresetBrowserTransfer(store);
  return { sources, manifest, load, prepared, store, receipt, service, runtime, node, transport: (input: PresetTransferRequest) => service.handle(input) };
}

describe('captured browser preset transfer', () => {
  it('rejects an oversized header before reading it and releases the known session', async () => {
    const transport = vi.fn(async (input: PresetTransferRequest) => input.operation === 'open' ? { session: 'bounded', sha256: 'a'.repeat(64), byteLength: 16 * 1024 * 1024 + 1 } : {});
    await expect(receiveBrowserPreset('a'.repeat(64), { transport, mearlApiVersion: '1.0.0' })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    expect(transport.mock.calls.map(([input]) => input.operation)).toEqual(['open', 'release']);
  });

  it('releases a transfer cancelled during its first metadata read', async () => {
    const f = await fixture();
    const signal = new AbortController();
    const transport = vi.fn(async (input: PresetTransferRequest) => { const result = await f.transport(input); if (input.operation === 'read') signal.abort(); return result; });
    await expect(receiveBrowserPreset(f.receipt.revision, { transport, mearlApiVersion: '1.0.0', signal: signal.signal })).rejects.toThrow();
    expect(transport.mock.calls.at(-1)?.[0].operation).toBe('release');
    expect(await f.service.handle({ operation: 'open', installationRevision: f.receipt.revision })).toHaveProperty('session');
  });
  it('announces only accepted browser installations, including deactivation after the last browser package', async () => {
    const f = await fixture();
    expect(await f.service.selectedRevision(f.receipt.revision)).toBe(f.receipt.revision);
    expect(await f.service.selectedRevision('a'.repeat(64))).toBeNull();
    f.sources.set(source, encode({ schemaVersion: 1, id: 'team', version: '1.0.1' }));
    const empty = await preparePreset(source, { load: f.load, mearlApiVersion: '1.0.0' });
    const removed = await f.store.apply(empty, { expectedRevision: f.receipt.revision });
    expect(removed.browserSyncRequired).toBe(true);
    expect(await f.service.selectedRevision(removed.revision)).toBe(removed.revision);
    const fresh = new PresetInstallationStore({ directory: join(directory, 'node-only') });
    f.sources.set(source, encode({ schemaVersion: 1, id: 'team', version: '1.0.1', packages: { identity: { source: './identity/bundle.json', targets: ['node'] } } }));
    const nodeOnly = await fresh.apply(await preparePreset(source, { load: f.load, mearlApiVersion: '1.0.0' }), { expectedRevision: null });
    expect(nodeOnly.browserSyncRequired).toBe(false);
    expect(await new PresetBrowserTransfer(fresh).selectedRevision(nodeOnly.revision)).toBeNull();
  });
  it('streams the accepted browser bytes below Native Messaging limits and restores its receipt offline', async () => {
    const f = await fixture(true);
    const { store, factory } = browserStore();
    f.load.mockRejectedValue(new Error('source offline'));
    let maximum = 0;
    const requested = new Set<string>();
    const received = await receiveBrowserPreset(f.receipt.revision, { mearlApiVersion: '1.0.0', transport: async input => {
      if (input.operation === 'read') requested.add(input.sha256);
      const result = await f.transport(input);
      maximum = Math.max(maximum, Buffer.byteLength(JSON.stringify(result)));
      return result;
    } });
    expect(maximum).toBeLessThan(1024 * 1024);
    expect(requested.has(await bundleDigest(f.node))).toBe(false);
    expect(received.prepared.bundles.map(bundle => bundle.manifest.id)).toEqual(['simulation']);
    expect(received.prepared.bundles[0].resources['runtime.cjs']).toEqual(f.runtime);
    await store.activatePreset(received.prepared.snapshot, received.prepared.bundles.map(bundle => ({ bundle, expectedRevision: null })), null, { installation: received.installation, expectedInstallationToken: null });
    await received.release();
    await store.close();
    const reopened = browserStore(factory).store;
    expect((await reopened.list()).installation).toEqual({ revision: f.receipt.revision, browserRevision: f.receipt.browserRevision, overrides: { locale: 'zh' } });
    expect((await reopened.profileBinding('sample'))?.target).toBe('simulation/default');
    expect(f.load).toHaveBeenCalledTimes(6);
  }, 15_000);

  it('rejects corrupted chunks without replacing the browser selection and releases its transfer', async () => {
    const f = await fixture();
    const { store } = browserStore();
    let changed = false;
    await expect(receiveBrowserPreset(f.receipt.revision, { mearlApiVersion: '1.0.0', transport: async input => {
      const response = await f.transport(input) as Record<string, unknown>;
      if (input.operation === 'read' && !changed) { changed = true; response.data = 'A'.repeat(String(response.data).length); }
      return response;
    } })).rejects.toThrow('BUNDLE_INTEGRITY');
    expect((await store.list()).activeRevision).toBeNull();
    const retry = await receiveBrowserPreset(f.receipt.revision, { mearlApiVersion: '1.0.0', transport: f.transport });
    await retry.release();
  });

  it('rejects an installation changed while its exact resources are streaming', async () => {
    const f = await fixture();
    let changed = false;
    await expect(receiveBrowserPreset(f.receipt.revision, { mearlApiVersion: '1.0.0', transport: async input => {
      const result = await f.transport(input);
      if (input.operation === 'read' && !changed) { changed = true; await f.store.apply(f.prepared, { expectedRevision: f.receipt.revision, overrides: { newer: true } }); }
      return result;
    } })).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    expect((await f.store.current()).receipt?.overrides).toEqual({ newer: true });
  });

  it('protects configuration-only browser selection changes with an independent CAS', async () => {
    const f = await fixture();
    const { store } = browserStore();
    const first = await receiveBrowserPreset(f.receipt.revision, { mearlApiVersion: '1.0.0', transport: f.transport });
    await store.activatePreset(first.prepared.snapshot, first.prepared.bundles.map(bundle => ({ bundle, expectedRevision: null })), null, { installation: first.installation, expectedInstallationToken: null });
    await first.release();
    const firstToken = (await store.list()).installationToken;
    const next = await f.store.apply(f.prepared, { expectedRevision: f.receipt.revision, overrides: { user: true } });
    const second = await receiveBrowserPreset(next.revision, { mearlApiVersion: '1.0.0', transport: f.transport });
    const packages = second.prepared.bundles.map(bundle => ({ bundle, expectedRevision: bundle.revision }));
    await store.activatePreset(second.prepared.snapshot, packages, first.prepared.snapshot.revision, { installation: second.installation, expectedInstallationToken: firstToken });
    await expect(store.activatePreset(first.prepared.snapshot, packages, first.prepared.snapshot.revision, { installation: first.installation, expectedInstallationToken: firstToken })).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    expect((await store.list()).installation?.revision).toBe(next.revision);
    await second.release();
    await store.activatePreset(first.prepared.snapshot, packages, first.prepared.snapshot.revision);
    expect((await store.list()).installation).toBeUndefined();
  });

  it('bounds sessions, offsets and exposed resources and expires abandoned transfers', async () => {
    const f = await fixture();
    let now = 0;
    const service = new PresetBrowserTransfer(f.store, () => now);
    const opened = await service.handle({ operation: 'open', installationRevision: f.receipt.revision }) as { session: string; sha256: string };
    await expect(service.handle({ operation: 'open', installationRevision: f.receipt.revision })).rejects.toThrow('already running');
    await expect(service.handle({ operation: 'read', session: opened.session, sha256: await bundleDigest(f.node), offset: 0 })).rejects.toThrow('Invalid browser transfer resource');
    for (const offset of [-1, 1, Infinity, 99999999]) await expect(service.handle({ operation: 'read', session: opened.session, sha256: opened.sha256, offset })).rejects.toThrow('Invalid browser transfer resource');
    now = 120001;
    await expect(service.handle({ operation: 'confirm', session: opened.session })).rejects.toThrow('expired');
    expect(await service.handle({ operation: 'open', installationRevision: f.receipt.revision })).toHaveProperty('session');
  });

  it('keeps Node activation and browser configuration pending state truthful after browser rejection', async () => {
    const f = await fixture();
    let reject = false;
    let browserIdentity: string | null = null;
    const invoke = vi.fn(async (action: string, data: any) => {
      const current = await f.store.current();
      if (action.startsWith('node_capabilities')) return { accepted: true, revision: current.receipt!.nodeRevision, installationRevision: current.receipt!.revision };
      if (action === 'preset_browser_sync') {
        if (reject) return { accepted: false, error: 'Invalid app definition' };
        browserIdentity = data.installationRevision;
      }
      return { ready: true, settingsReady: false, browserRevision: current.receipt!.browserRevision, installationRevision: browserIdentity };
    });
    const installer = new PresetInstaller({ directory, load: f.load, hosts: () => [{ id: 'chrome', socketPath: 'owned' }], invoke });
    const first = await installer.apply(source);
    expect(first.browsers).toEqual([{ id: 'chrome', state: 'active', settingsReady: false }]);
    expect(first.pending).toEqual([{ kind: 'preset', id: 'team', runtime: 'browser', reason: 'SETTINGS_APPLY_REQUIRED' }]);
    reject = true;
    await expect(installer.configure({ next: true })).rejects.toThrow('selection retained for retry');
    expect((await f.store.current()).receipt?.overrides).toEqual({ next: true });
    const pending = await installer.status();
    expect(pending.ready).toBe(false);
    expect(pending.pending.some(entry => entry.reason === 'BROWSER_SYNC_REQUIRED')).toBe(true);
    expect(pending.hosts[0].state).toBe('active');
  });
});
