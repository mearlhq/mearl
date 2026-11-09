import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_PROFILES } from '../../../../../app-profiles/src/__tests__/fixtures';
import {
  BrowserBundleStore,
  bundleDigest,
  prepareBundle,
  prepareBrowserPreset,
  PRESET_TRANSFER_CHUNK_BYTES,
  type PreparedBrowserPreset,
  type PresetTransferRequest,
  type BundleManifest,
} from '@mearl/preset/bundles';
import { requestUiFixture as legacyBrowserRequestUi } from '../../../test/fixtures/requestUi';
import { createBrowserCapabilityRegistry } from '../browserCapabilityRegistry';
import { browserCapabilityCatalog } from '../browserCapabilityCatalog';
import { handleBrowserBundleRequest } from '../browserBundleService';
import { synchronizeBrowserPreset } from '../browserPresetSync';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const ui = { id: extensionId, url: `chrome-extension://${extensionId}/options.html` };
const source = 'https://example.com/profiles/bundle.json';
const presetSource = 'https://example.com/presets/reader.json';
const stores: BrowserBundleStore[] = [];

it('publishes package-owned operations and keeps catalog configuration fixed to the captured installation', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const runtime = await import('../browserCapabilities');
  vi.spyOn(runtime, 'validateBrowserCapabilities').mockResolvedValue(undefined);
  const factory = new IDBFactory();
  const store = new BrowserBundleStore({ indexedDB: factory, mearlApiVersion: '1.0.0' });
  stores.push(store);
  const files = {
    'runtime.cjs': new TextEncoder().encode(
      'module.exports = (_, config) => ({ identity: () => config })',
    ),
    'extension.json': new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        operations: { identity: { hook: 'identity.panel' } },
        logins: { accounts: { url: 'https://example.com/login', title: { en: 'Accounts' } } },
      }),
    ),
  };
  const manifest: BundleManifest = {
    schemaVersion: 1,
    id: 'identity',
    version: '1.0.0',
    defaults: { tenant: 'first' },
    resources: Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([name, bytes]) => [
          name,
          { sha256: await bundleDigest(bytes), byteLength: bytes.length },
        ]),
      ),
    ),
    contributions: {
      extension: 'extension.json',
      browserRuntimes: {
        extension: { entry: 'runtime.cjs', bindings: { 'identity.panel': 'identity' } },
      },
    },
  };
  const load = async (url: string) =>
    url.endsWith('bundle.json')
      ? new TextEncoder().encode(JSON.stringify(manifest))
      : files[url.split('/').pop() as keyof typeof files];
  const registry = createBrowserCapabilityRegistry(store, load);
  const first = await registry.install({
    id: 'identity',
    source: 'https://example.com/bundle.json',
    expectedRevision: null,
  });
  const captured = await registry.captureSelection();
  const catalog = browserCapabilityCatalog(captured);
  expect((await registry.settings(captured)).extension?.operations?.identity).toEqual({
    hook: 'identity.panel',
  });
  const original = await catalog.runtimes();
  expect(original.snapshot.modules.identity.config).toEqual({ tenant: 'first' });
  manifest.defaults = { tenant: 'second' };
  await registry.install({
    id: 'identity',
    source: 'https://example.com/bundle.json',
    expectedRevision: first.revision,
  });
  const updated = await registry.captureSelection();
  expect(
    (await browserCapabilityCatalog(updated).runtimes()).snapshot.modules.identity.config,
  ).toEqual({ tenant: 'second' });
  expect(await catalog.runtimes()).toBe(original);
  expect(original.snapshot.modules.identity.config).toEqual({ tenant: 'first' });
});
async function transfer(
  prepared: PreparedBrowserPreset,
  revision = 'a'.repeat(64),
  overrides = {},
) {
  const header = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      installationRevision: revision,
      snapshot: prepared.snapshot,
      bundles: prepared.bundles.map(({ source, manifest, revision }) => ({
        source,
        manifest,
        revision,
      })),
      overrides,
    }),
  );
  const hash = await bundleDigest(header);
  const bytes = new Map<string, Uint8Array>([[hash, header]]);
  for (const bundle of prepared.bundles)
    for (const [name, entry] of Object.entries(bundle.manifest.resources))
      bytes.set(entry.sha256, bundle.resources[name]);
  return vi.fn(async (input: PresetTransferRequest) => {
    if (input.operation === 'open')
      return { session: 'test-session', sha256: hash, byteLength: header.byteLength };
    if (input.operation === 'read')
      return {
        data: Buffer.from(
          bytes
            .get(input.sha256)!
            .subarray(input.offset, input.offset + PRESET_TRANSFER_CHUNK_BYTES),
        ).toString('base64'),
      };
    if (input.operation === 'confirm') return { installationRevision: revision };
    return { released: true };
  });
}
async function alterStored(
  factory: IDBFactory,
  storeName: string,
  key: string,
  change: (value: any) => void,
) {
  await new Promise<void>((resolve, reject) => {
    const open = factory.open('mearl-capabilities-v3');
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => {
        change(request.result);
        if (storeName === 'preset') store.put(request.result, key);
        else store.put(request.result);
      };
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    open.onerror = () => reject(open.error);
  });
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function registryFixture(name = 'simulation/reader', withRuntime = false) {
  vi.stubGlobal('crypto', webcrypto);
  const factory = new IDBFactory();
  const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
  stores.push(store);
  const runtimeBytes = new TextEncoder().encode(
    'module.exports.install=config=>{window.__testRuntime=config.profile;};',
  );
  const definition = {
    ...APP_PROFILES.reader,
    name,
    ...(withRuntime && {
      pageRuntime: { id: 'simulation/main', sha256: await bundleDigest(runtimeBytes) },
    }),
  };
  const body = new TextEncoder().encode(JSON.stringify(definition));
  const manifest: BundleManifest = {
    schemaVersion: 1,
    id: 'simulation',
    version: '1.0.0',
    resources: { 'reader.json': { sha256: await bundleDigest(body), byteLength: body.byteLength } },
    contributions: { appProfiles: ['reader.json'] },
  };
  if (withRuntime) {
    manifest.resources['runtime.cjs'] = {
      sha256: definition.pageRuntime!.sha256,
      byteLength: runtimeBytes.byteLength,
    };
    manifest.contributions!.pageRuntimes = { main: 'runtime.cjs' };
  }
  const preset = {
    schemaVersion: 1,
    id: 'reader',
    version: '1.0.0',
    extends: { source: './organization.json' },
    appProfiles: { reader: name },
  };
  const parent = {
    schemaVersion: 1,
    id: 'organization',
    version: '1.0.0',
    packages: {
      simulation: { source, targets: ['browser'] },
      'example-device': { source: 'https://example.com/example-device.json', targets: ['node'] },
    },
  };
  const load = vi.fn(async (url: string) => {
    if (url === source) return new TextEncoder().encode(JSON.stringify(manifest));
    if (url === presetSource) return new TextEncoder().encode(JSON.stringify(preset));
    if (url.endsWith('/runtime.cjs')) return runtimeBytes;
    if (url === 'https://example.com/presets/organization.json')
      return new TextEncoder().encode(JSON.stringify(parent));
    return body;
  });
  return {
    registry: createBrowserCapabilityRegistry(store, load),
    store,
    load,
    factory,
    definition,
    preset,
    manifest,
  };
}

describe('browser app profile bundles', () => {
  it('installs every profile in a bundle without changing the active Preset', async () => {
    const f = await registryFixture();
    const profilesSource = 'https://example.com/portable/bundle.json';
    const files = new Map<string, Uint8Array>();
    const profilePaths = ['reader.json', 'writer.json'];
    const resources = Object.fromEntries(
      await Promise.all(
        profilePaths.map(async (path, index) => {
          const app = index === 0 ? 'reader' : 'writer';
          const bytes = new TextEncoder().encode(
            JSON.stringify({
              ...APP_PROFILES.reader,
              name: `portable/${app}`,
              defaultAppId: app,
            }),
          );
          files.set(new URL(path, profilesSource).href, bytes);
          return [path, { sha256: await bundleDigest(bytes), byteLength: bytes.length }];
        }),
      ),
    );
    files.set(
      profilesSource,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          id: 'portable',
          version: '1.0.0',
          resources,
          contributions: { appProfiles: profilePaths },
        }),
      ),
    );
    const registry = createBrowserCapabilityRegistry(
      f.store,
      async url => files.get(url) ?? f.load(url),
    );
    await registry.applyPreset({ source: presetSource, expectedRevision: null });
    await expect(registry.get('constructor')).resolves.toBeUndefined();
    const before = await registry.catalog();
    const result = await registry.installProfile(profilesSource);
    expect(result.profiles.map(profile => profile.id)).toEqual([
      'portable/reader',
      'portable/writer',
    ]);
    const after = await registry.catalog();
    expect(after.presetRevision).toBe(before.presetRevision);
    expect(after.profiles.map(profile => profile.id)).toEqual(['reader', 'writer']);
    expect((await registry.get('reader'))?.plugin).toBe('simulation');
    expect((await registry.get('writer'))?.plugin).toBe('portable');
  });

  it('validates browser factories before confirming installation and preserves the previous selection on failure', async () => {
    const f = await registryFixture('simulation/reader', true);
    await f.registry.applyPreset({ source: presetSource, expectedRevision: null });
    const previous = (await f.store.list()).activeRevision;
    f.manifest.contributions!.browserRuntimes = {
      extension: { entry: 'runtime.cjs', bindings: { 'request.apiSchema': 'schema' } },
    };
    const prepared = await prepareBrowserPreset(presetSource, {
      mearlApiVersion: '1.0.0',
      load: f.load,
    });
    const transport = await transfer(prepared);
    const sendMessage = vi.fn(async (_message: { action: string }) => ({
      success: false,
      error: 'Missing browser handler',
    }));
    vi.stubGlobal('chrome', {
      ...chrome,
      runtime: { ...chrome.runtime, sendMessage, onConnect: { addListener: vi.fn() } },
      offscreen: {
        hasDocument: async () => false,
        createDocument: async () => {},
        closeDocument: async () => {},
      },
    });
    await expect(
      synchronizeBrowserPreset(
        { operation: 'sync', installationRevision: 'a'.repeat(64) },
        transport,
        f.registry,
      ),
    ).resolves.toMatchObject({ accepted: false, error: 'Missing browser handler' });
    expect(
      transport.mock.calls.filter(([request]) => request.operation === 'confirm'),
    ).toHaveLength(1);
    expect((await f.store.list()).activeRevision).toBe(previous);
    sendMessage.mockImplementation(async () => ({ success: true, error: '' }));
    const confirmed = vi.fn(transport.getMockImplementation());
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      confirmed,
      f.registry,
    );
    const confirmation = confirmed.mock.calls.findLastIndex(
      ([request]) => request.operation === 'confirm',
    );
    expect(confirmation).toBeGreaterThan(-1);
    const validation = sendMessage.mock.calls.findLastIndex(
      ([message]) => message.action !== 'browserRequestUiChanged',
    );
    expect(sendMessage.mock.invocationCallOrder[validation]).toBeLessThan(
      confirmed.mock.invocationCallOrder[confirmation],
    );
  });
  it('receives the captured Node installation without downloading again and restores it offline', async () => {
    const f = await registryFixture('simulation/reader', true);
    const prepared = await prepareBrowserPreset(presetSource, {
      mearlApiVersion: '1.0.0',
      load: f.load,
    });
    const transport = await transfer(prepared);
    f.load.mockRejectedValue(new Error('offline'));
    const state = await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      transport,
      f.registry,
    );
    expect(state).toMatchObject({
      installationRevision: 'a'.repeat(64),
      browserRevision: prepared.snapshot.revision,
      ready: true,
      settingsReady: true,
    });
    expect((await f.registry.get('reader'))?.source).toBe('plugin');
    await f.store.close();
    const reopened = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: f.factory });
    stores.push(reopened);
    const registry = createBrowserCapabilityRegistry(reopened, f.load);
    expect(
      await synchronizeBrowserPreset({ operation: 'status' }, transport, registry),
    ).toMatchObject({
      ...state,
      installationToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await registry.get('reader'))?.definition.pageRuntime?.sha256).toBe(
      f.definition.pageRuntime!.sha256,
    );
  });

  it('uninstalls the captured preset and retains code pinned by active documents', async () => {
    const f = await registryFixture('simulation/reader', true);
    const prepared = await prepareBrowserPreset(presetSource, {
      mearlApiVersion: '1.0.0',
      load: f.load,
    });
    const transport = await transfer(prepared);
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      transport,
      f.registry,
    );
    const sha256 = f.definition.pageRuntime!.sha256;
    await f.store.pinPageRuntimes({ 'tab:1': sha256 });
    const status = await synchronizeBrowserPreset({ operation: 'status' }, transport, f.registry);
    const uninstall = {
      operation: 'uninstall' as const,
      browserRevision: status.browserRevision!,
      installationToken: status.installationToken!,
    };
    await expect(
      synchronizeBrowserPreset({ ...uninstall, installationToken: null }, transport, f.registry),
    ).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    expect(await synchronizeBrowserPreset(uninstall, transport, f.registry)).toMatchObject({
      accepted: true,
      browserRevision: null,
      installationRevision: null,
    });
    expect((await f.store.list()).bundles).toEqual([]);
    expect(await f.store.pageRuntimeSource(sha256)).toContain('module.exports.install');
    await f.store.pinPageRuntimes({ 'tab:1': null });
    await expect(f.store.pageRuntimeSource(sha256)).rejects.toMatchObject({
      code: 'BUNDLE_INTEGRITY',
    });
  });

  it('repairs corrupt installation association while ignoring unrelated independent package errors', async () => {
    const f = await registryFixture();
    const prepared = await prepareBrowserPreset(presetSource, {
      mearlApiVersion: '1.0.0',
      load: f.load,
    });
    const transport = await transfer(prepared);
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      transport,
      f.registry,
    );
    await alterStored(f.factory, 'preset', 'installation', value => {
      value.browserRevision = 'b'.repeat(64);
    });
    expect((await f.registry.installationStatus()).ready).toBe(false);
    const broken = await f.store.list();
    await expect(
      f.registry.applyPreset({ source: presetSource, expectedRevision: broken.activeRevision }),
    ).rejects.toThrow('NATIVE_SYNC_REQUIRED');
    expect((await f.store.list()).installationToken).toBe(broken.installationToken);
    expect((await f.store.list()).installationError).toBe(broken.installationError);
    expect(
      (
        await synchronizeBrowserPreset(
          { operation: 'sync', installationRevision: 'a'.repeat(64) },
          transport,
          f.registry,
        )
      ).ready,
    ).toBe(true);
    const open = f.factory.open('mearl-capabilities-v3');
    await new Promise<void>((resolve, reject) => {
      open.onsuccess = () => {
        const database = open.result;
        const tx = database.transaction('bundles', 'readwrite');
        tx.objectStore('bundles').put({
          id: 'unrelated',
          revision: 'bad',
          byteLength: 0,
          bundle: {},
        });
        tx.oncomplete = () => {
          database.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect((await f.registry.installationStatus()).ready).toBe(true);
    expect((await f.registry.catalog()).errors.some(error => error.plugin === 'unrelated')).toBe(
      true,
    );
  });

  it('retains a browser update and its existing Native association while another transfer is in progress', async () => {
    const f = await registryFixture();
    const prepared = await prepareBrowserPreset(presetSource, {
      mearlApiVersion: '1.0.0',
      load: f.load,
    });
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      await transfer(prepared),
      f.registry,
    );
    const wire = await transfer(prepared, 'b'.repeat(64));
    let changed = false;
    const result = await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'b'.repeat(64) },
      async input => {
        const response = await wire(input);
        if (input.operation === 'read' && !changed) {
          changed = true;
          await f.registry.applyPreset({
            source: presetSource,
            expectedRevision: prepared.snapshot.revision,
          });
        }
        return response;
      },
      f.registry,
    );
    expect(result).toMatchObject({
      accepted: false,
      ready: false,
      error: expect.stringContaining('BUNDLE_CONFLICT'),
    });
    expect((await f.store.list()).installation?.revision).toBe('a'.repeat(64));
    expect((await f.store.list()).activeRevision).toBe(prepared.snapshot.revision);
  });

  it('rejects semantically invalid app contributions before replacing a working selection', async () => {
    const f = await registryFixture();
    const first = await prepareBrowserPreset(presetSource, {
      mearlApiVersion: '1.0.0',
      load: f.load,
    });
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      await transfer(first),
      f.registry,
    );
    const bytes = new TextEncoder().encode(JSON.stringify({ ...f.definition, label: 12 }));
    f.manifest.resources['reader.json'] = {
      sha256: await bundleDigest(bytes),
      byteLength: bytes.byteLength,
    };
    const original = f.load.getMockImplementation()!;
    f.load.mockImplementation(async url =>
      url === 'https://example.com/profiles/reader.json' ? bytes : original(url),
    );
    const bad = await prepareBrowserPreset(presetSource, {
      mearlApiVersion: '1.0.0',
      load: f.load,
    });
    const result = await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'b'.repeat(64) },
      await transfer(bad, 'b'.repeat(64)),
      f.registry,
    );
    expect(result).toMatchObject({ accepted: false, ready: false });
    expect((await f.store.list()).installation?.revision).toBe('a'.repeat(64));
    expect((await f.registry.installationStatus()).ready).toBe(true);
  });
  it('validates and retains the exact installer before activating a runtime-backed profile', async () => {
    const { registry, definition, load } = await registryFixture('simulation/reader', true);
    await registry.applyPreset({ source: presetSource, expectedRevision: null });
    load.mockRejectedValue(new Error('offline'));
    expect((await registry.get('reader'))?.definition.pageRuntime).toEqual(definition.pageRuntime);
    expect(await registry.pageRuntimeSource(definition.pageRuntime!.sha256)).toContain(
      'module.exports.install',
    );
  });
  it('rejects a runtime resource that disagrees with its profile digest before activation', async () => {
    const { registry, manifest, store } = await registryFixture('simulation/reader', true);
    manifest.contributions!.pageRuntimes = { main: 'reader.json' };
    await expect(
      registry.applyPreset({ source: presetSource, expectedRevision: null }),
    ).rejects.toThrow('verified installer');
    expect(await store.get('simulation')).toBeUndefined();
    expect(await store.activePreset()).toBeUndefined();
  });
  it('installs and restores a complete existing profile with no native-host dependency', async () => {
    const { registry, definition, store, factory, load } = await registryFixture();
    const installed = await registry.install({ id: 'simulation', source, expectedRevision: null });
    expect(installed.profiles[0]).toMatchObject({
      id: definition.name,
      definition,
      available: true,
    });
    await store.close();
    const reopened = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    stores.push(reopened);
    load.mockRejectedValue(new Error('offline'));
    const next = createBrowserCapabilityRegistry(reopened, load);
    expect((await next.get(definition.name))?.definition).toEqual(definition);
    expect((await next.catalog()).bundleIds).toEqual(['simulation']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('validates the host profile schema and namespace before making a bundle active', async () => {
    const { registry, store } = await registryFixture('other/reader');
    await expect(
      registry.install({ id: 'simulation', source, expectedRevision: null }),
    ).rejects.toThrow('namespace');
    expect(await store.get('simulation')).toBeUndefined();
  });

  it('checks all UI contributions on install but reads request UI independently of other views', async () => {
    const { registry, manifest, store, load } = await registryFixture();
    manifest.contributions!.browserViews = { requestCases: 'reader.json' };
    await expect(
      registry.install({ id: 'simulation', source, expectedRevision: null }),
    ).rejects.toThrow();
    expect(await store.get('simulation')).toBeUndefined();
    // A persisted package can remain byte-valid while a contribution fails host validation.
    const bundle = await prepareBundle(source, {
      load,
      expectedId: 'simulation',
      mearlApiVersion: '1.0.0',
    });
    await store.install(bundle, null);
    await expect(registry.requestUi()).resolves.toBeUndefined();
    await expect(registry.view('requestCases')).rejects.toThrow();
  });

  it('does not return a removed profile from a different provider in the same namespace', async () => {
    const { registry } = await registryFixture();
    await registry.install({ id: 'simulation', source, expectedRevision: null });
    await expect(registry.get('simulation/missing')).rejects.toThrow('does not provide');
    expect(await registry.get('uninstalled/reader')).toBeUndefined();
  });
  it('applies an inherited preset under the original App ID and preserves the complete definition offline', async () => {
    const { registry, definition, load } = await registryFixture();
    const status = await registry.applyPreset({ source: presetSource, expectedRevision: null });
    expect(status).toMatchObject({
      id: 'reader',
      browserReady: true,
      ready: false,
      pending: [{ id: 'example-device', runtime: 'node' }],
    });
    load.mockRejectedValue(new Error('offline'));
    const selected = await registry.get('reader');
    expect(selected?.id).toBe('reader');
    expect(selected?.definition).toEqual({ ...definition, name: 'reader' });
    const catalog = await registry.catalog();
    expect(catalog.profiles.map(profile => profile.id)).toEqual(['reader']);
    expect(catalog.boundAppIds).toEqual(['reader']);
    expect(catalog.preset?.revision).toBe(status.revision);
    await expect(
      registry.remove('simulation', (await registry.get(definition.name))!.revision),
    ).rejects.toThrow('managed');
  });
  it('validates the selected implementation before writing any package or preset pointer', async () => {
    const { registry, store, preset } = await registryFixture();
    preset.appProfiles.reader = 'simulation/missing';
    await expect(
      registry.applyPreset({ source: presetSource, expectedRevision: null }),
    ).rejects.toThrow('not provided');
    expect(await store.activePreset()).toBeUndefined();
    expect(await store.get('simulation')).toBeUndefined();
  });
  it('isolates a corrupt package while retaining valid preset bindings and unrelated built-in availability', async () => {
    const { registry, factory } = await registryFixture();
    await registry.applyPreset({ source: presetSource, expectedRevision: null });
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('mearl-capabilities-v3', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('bundles', 'readwrite');
        const objects = transaction.objectStore('bundles');
        const request = objects.get('simulation');
        request.onsuccess = () => {
          const record = request.result;
          record.bundle.manifest.resources['reader.json'].sha256 = '0'.repeat(64);
          objects.put(record);
        };
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const catalog = await registry.catalog();
    expect(catalog.boundAppIds).toEqual(['reader']);
    expect(catalog.presetUnavailable).toBe(false);
    expect(catalog.preset).toMatchObject({ browserReady: false, ready: false });
    expect(catalog.profiles).toEqual([]);
    await expect(registry.get('reader')).rejects.toThrow('integrity');
    expect(await registry.get('shop')).toBeUndefined();
  });
});

describe('browser bundle service boundary', () => {
  it('rejects web pages and content scripts before any download or storage access', async () => {
    const { registry, load } = await registryFixture();
    const install = vi.spyOn(registry, 'install');
    for (const sender of [
      { id: extensionId, url: 'https://example.com' },
      { id: 'other', url: ui.url },
    ]) {
      expect(
        await handleBrowserBundleRequest({ operation: 'install' }, sender, {
          extensionId,
          registry,
        }),
      ).toMatchObject({ success: false, code: 'EXTENSION_UI_REQUIRED' });
    }
    expect(install).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('installs through the extension UI and rejects stale or incomplete operation inputs', async () => {
    const { registry, load } = await registryFixture();
    expect(
      await handleBrowserBundleRequest(
        { operation: 'install', id: 'simulation', source, expectedRevision: null },
        ui,
        { extensionId, registry },
      ),
    ).toMatchObject({ success: true, data: { id: 'simulation' } });
    expect(
      await handleBrowserBundleRequest(
        { operation: 'install', id: 'simulation', source, expectedRevision: null },
        ui,
        { extensionId, registry },
      ),
    ).toMatchObject({ success: false, code: 'BUNDLE_CONFLICT' });
    load.mockClear();
    expect(
      await handleBrowserBundleRequest({ operation: 'install', id: 'simulation', source }, ui, {
        extensionId,
        registry,
      }),
    ).toMatchObject({ success: false, code: 'BUNDLE_INVALID' });
    expect(load).not.toHaveBeenCalled();
  });

  it('preserves the live document when a bundle is requested for removal', async () => {
    const { registry } = await registryFixture();
    const installed = await registry.install({ id: 'simulation', source, expectedRevision: null });
    const data = { operation: 'remove', id: 'simulation', expectedRevision: installed.revision };
    expect(
      await handleBrowserBundleRequest(data, ui, {
        extensionId,
        registry,
        inUse: async () => true,
      }),
    ).toMatchObject({ success: false, code: 'BUNDLE_CONFLICT' });
    expect(await registry.get('simulation/reader')).toBeDefined();
    expect(
      await handleBrowserBundleRequest(data, ui, {
        extensionId,
        registry,
        inUse: async () => false,
      }),
    ).toMatchObject({ success: true });
    expect(await registry.get('simulation/reader')).toBeUndefined();
  });
  it('applies a preset only through trusted extension UI and requires an explicit revision', async () => {
    const { registry, load } = await registryFixture();
    const request = { operation: 'applyPreset', source: presetSource, expectedRevision: null };
    expect(
      await handleBrowserBundleRequest(
        request,
        { id: extensionId, url: 'https://example.com' },
        { extensionId, registry },
      ),
    ).toMatchObject({ success: false, code: 'EXTENSION_UI_REQUIRED' });
    expect(
      await handleBrowserBundleRequest({ ...request, expectedRevision: undefined }, ui, {
        extensionId,
        registry,
      }),
    ).toMatchObject({ success: false, code: 'BUNDLE_INVALID' });
    expect(load).not.toHaveBeenCalled();
    expect(await handleBrowserBundleRequest(request, ui, { extensionId, registry })).toMatchObject({
      success: true,
      data: { browserReady: true, ready: false },
    });
  });
});

it.each([
  'accountsEnabled',
  'requestCasesEnabled',
  'requestImportEnabled',
  'trackingMetadataEnabled',
])('rejects request UI setting %s before capability execution or persistence', async key => {
  const f = await registryFixture('simulation/reader', true);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      ...legacyBrowserRequestUi,
      setting: { ...legacyBrowserRequestUi.setting, key },
    }),
  );
  f.manifest.resources['ui.json'] = {
    sha256: await bundleDigest(bytes),
    byteLength: bytes.length,
  };
  f.manifest.contributions!.requestUi = 'ui.json';
  f.manifest.contributions!.browserRuntimes = {
    extension: {
      entry: 'runtime.cjs',
      bindings: {
        [legacyBrowserRequestUi.details.hook]: 'details',
        ...(legacyBrowserRequestUi.save ? { [legacyBrowserRequestUi.save.hook]: 'save' } : {}),
      },
    },
  };
  const load = f.load.getMockImplementation()!;
  f.load.mockImplementation(async url => (url.endsWith('/ui.json') ? bytes : load(url)));
  await expect(
    f.registry.install({ id: 'simulation', source, expectedRevision: null }),
  ).rejects.toThrow('another service');
  expect((await f.store.list()).bundles).toHaveLength(0);
});

it('applies inherited simulation defaults and installer overrides from the accepted browser installation, including offline reopen', async () => {
  const f = await registryFixture('simulation/reader', true);
  Object.assign(f.preset.appProfiles, { shop: 'simulation/reader' });
  Object.assign(f.preset, {
    defaults: {
      simulation: {
        app: 'reader',
        deviceSelection: {
          preset: 'iphone-17-pro',
          orientation: 'portrait',
          fitToWindow: true,
          deviceShell: true,
        },
      },
    },
  });
  const prepared = await prepareBrowserPreset(presetSource, {
    mearlApiVersion: '1.0.0',
    load: f.load,
  });
  const overrides = {
    simulation: { app: 'shop', deviceSelection: { orientation: 'landscape' } },
  };
  const transport = await transfer(prepared, 'a'.repeat(64), overrides);
  expect(
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      transport,
      f.registry,
    ),
  ).toMatchObject({ ready: true, settingsReady: true, settingsPending: [] });
  expect(await f.registry.settings()).toMatchObject({
    simulation: {
      app: 'shop',
      deviceSelection: { preset: 'iphone-17-pro', orientation: 'landscape', splitScreen: false },
    },
    pending: [],
  });
  expect((await f.registry.settings()).appProfiles).toEqual((await f.registry.catalog()).profiles);
  await f.store.close();
  const reopened = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: f.factory });
  stores.push(reopened);
  f.load.mockRejectedValue(new Error('Offline'));
  expect(await createBrowserCapabilityRegistry(reopened, f.load).settings()).toMatchObject({
    simulation: { app: 'shop' },
    pending: [],
  });
});
it('retains Native association and user overrides on an unchanged browser update', async () => {
  const f = await registryFixture('simulation/reader', true);
  Object.assign(f.preset.appProfiles, { shop: 'simulation/reader' });
  Object.assign(f.preset, { defaults: { simulation: { app: 'reader' } } });
  const prepared = await prepareBrowserPreset(presetSource, {
    mearlApiVersion: '1.0.0',
    load: f.load,
  });
  const overrides = { simulation: { app: 'shop' } };
  await synchronizeBrowserPreset(
    { operation: 'sync', installationRevision: 'a'.repeat(64) },
    await transfer(prepared, 'a'.repeat(64), overrides),
    f.registry,
  );
  const previous = await f.registry.captureInstallationSelection();
  await f.registry.applyPreset({
    source: presetSource,
    expectedRevision: previous.activeRevision,
    expectedSelection: previous,
  });
  expect((await f.store.list()).installation).toEqual({
    revision: 'a'.repeat(64),
    browserRevision: prepared.snapshot.revision,
    overrides,
  });
  expect(await f.registry.settings()).toMatchObject({ simulation: { app: 'shop' } });
  const accepted = await f.store.list();
  f.preset.version = '2.0.0';
  await expect(
    f.registry.applyPreset({ source: presetSource, expectedRevision: accepted.activeRevision }),
  ).rejects.toThrow('NATIVE_SYNC_REQUIRED');
  expect((await f.store.list()).installation).toEqual(accepted.installation);
  expect((await f.store.list()).activeRevision).toBe(accepted.activeRevision);
});
it('rejects an installation selection whose association changed before or during preparation', async () => {
  const f = await registryFixture('simulation/reader', true);
  const prepared = await prepareBrowserPreset(presetSource, {
    mearlApiVersion: '1.0.0',
    load: f.load,
  });
  const previous = await f.registry.captureInstallationSelection();
  await synchronizeBrowserPreset(
    { operation: 'sync', installationRevision: 'a'.repeat(64) },
    await transfer(prepared),
    f.registry,
  );
  const cacheScope = (await f.registry.settings()).cacheScope;
  expect((await f.registry.settings()).cacheScope).toBe(cacheScope);
  await expect(
    f.registry.applyPreset({
      source: presetSource,
      expectedRevision: previous.activeRevision,
      expectedSelection: previous,
    }),
  ).rejects.toThrow('changed');
  const current = await f.registry.captureInstallationSelection();
  await expect(
    f.registry.applyPreset({
      source: presetSource,
      expectedRevision: current.activeRevision,
      expectedSelection: current,
      confirm: async () => {
        await synchronizeBrowserPreset(
          { operation: 'sync', installationRevision: 'b'.repeat(64) },
          await transfer(prepared, 'b'.repeat(64)),
          f.registry,
        );
      },
    }),
  ).rejects.toThrow('changed');
  expect((await f.store.list()).installation?.revision).toBe('b'.repeat(64));
  expect((await f.registry.settings()).cacheScope).not.toBe(cacheScope);
});
it('rejects an unavailable default app before confirmation and retains the previous usable preset', async () => {
  const f = await registryFixture();
  await f.registry.applyPreset({ source: presetSource, expectedRevision: null });
  const previous = await f.store.list();
  Object.assign(f.preset, { defaults: { simulation: { app: 'absent/app' } } });
  const prepared = await prepareBrowserPreset(presetSource, {
    mearlApiVersion: '1.0.0',
    load: f.load,
  });
  const transport = await transfer(prepared);
  expect(
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      transport,
      f.registry,
    ),
  ).toMatchObject({
    accepted: false,
    error: expect.stringContaining('default simulation app is unavailable'),
  });
  expect(transport.mock.calls.filter(([request]) => request.operation === 'confirm')).toHaveLength(
    1,
  );
  expect((await f.store.list()).activeRevision).toBe(previous.activeRevision);
});
it('keeps unknown settings pending while accepting the supported browser defaults', async () => {
  const f = await registryFixture();
  Object.assign(f.preset, {
    defaults: { simulation: { app: 'reader', timezone: 'UTC' }, extension: { language: 'en' } },
  });
  const prepared = await prepareBrowserPreset(presetSource, {
    mearlApiVersion: '1.0.0',
    load: f.load,
  });
  const transport = await transfer(prepared);
  expect(
    await synchronizeBrowserPreset(
      { operation: 'sync', installationRevision: 'a'.repeat(64) },
      transport,
      f.registry,
    ),
  ).toMatchObject({
    ready: true,
    settingsReady: false,
    settingsPending: ['extension.language', 'simulation.timezone'],
  });
  expect((await f.registry.settings()).simulation.app).toBe('reader');
});

it.each([{ services: { exampleEnabled: false } }])(
  'keeps independent Node-only state and applies core browser defaults without extra packages %j',
  async defaults => {
    const f = await registryFixture();
    await f.registry.applyPreset({ source: presetSource, expectedRevision: null });
    const before = await f.store.list();
    const original = f.load.getMockImplementation()!;
    const nodeOnly = 'https://example.com/presets/node-only.json';
    const coreDefaults = 'https://example.com/presets/core-defaults.json';
    f.load.mockImplementation(async url =>
      url === nodeOnly
        ? new TextEncoder().encode(
            JSON.stringify({
              schemaVersion: 1,
              id: 'node-only',
              version: '1.0.0',
              packages: {
                'example-device': { source: '../example-device.json', targets: ['node'] },
              },
            }),
          )
        : url === coreDefaults
          ? new TextEncoder().encode(
              JSON.stringify({ schemaVersion: 1, id: 'core-defaults', version: '1.0.0', defaults }),
            )
          : original(url),
    );
    expect(
      await f.registry.applyPreset({
        source: nodeOnly,
        expectedRevision: before.activeRevision,
        keepIndependentBrowser: true,
      }),
    ).toMatchObject({
      browserRequired: false,
      pending: [{ kind: 'packages', id: 'example-device', runtime: 'node' }],
    });
    expect((await f.store.list()).activeRevision).toBe(before.activeRevision);
    expect((await f.store.list()).revisions).toEqual(before.revisions);
    await f.registry.applyPreset({
      source: coreDefaults,
      expectedRevision: before.activeRevision,
      keepIndependentBrowser: true,
    });
    expect((await f.store.list()).activation?.snapshot.source).toBe(coreDefaults);
    expect(await f.registry.settings()).toMatchObject({ ...defaults, pending: [] });
  },
);

it('captures only the browser selection associated with the accepted Native revision', async () => {
  const f = await registryFixture('simulation/reader', true);
  const prepared = await prepareBrowserPreset(presetSource, {
    mearlApiVersion: '1.0.0',
    load: f.load,
  });
  const accepted = 'a'.repeat(64),
    replacement = 'b'.repeat(64);
  await synchronizeBrowserPreset(
    { operation: 'sync', installationRevision: accepted },
    await transfer(prepared, accepted),
    f.registry,
  );
  const selection = await f.registry.captureInstallationSelection(accepted);
  expect(selection.installationToken).toBeTruthy();
  await synchronizeBrowserPreset(
    { operation: 'sync', installationRevision: replacement },
    await transfer(prepared, replacement),
    f.registry,
  );
  await expect(f.registry.captureInstallationSelection(accepted)).rejects.toThrow(
    'INSTALLATION_SELECTION_CHANGED',
  );
  expect(await f.registry.captureInstallationSelection(replacement)).not.toEqual(selection);
});

it('reports missing preset authorization without disabling installed browser capabilities', async () => {
  const f = await registryFixture('simulation/reader', true);
  Object.assign(f.preset.appProfiles, { shop: 'simulation/reader' });
  Object.assign(f.preset, { permissions: { origins: ['https://accounts.example.test/*'] } });
  const prepared = await prepareBrowserPreset(presetSource, {
    mearlApiVersion: '1.0.0',
    load: f.load,
  });
  const transport = await transfer(prepared);
  const stored: Record<string, unknown> = { proxyCookieAllowedOrigins: [] };
  chrome.storage = {
    ...chrome.storage,
    sync: {
      get: vi.fn((keys, callback: any) =>
        callback(Object.fromEntries((keys as string[]).map(key => [key, stored[key]]))),
      ),
    },
  } as any;
  chrome.permissions = { ...chrome.permissions, contains: vi.fn(async () => true) } as any;
  const input = { operation: 'sync', installationRevision: 'a'.repeat(64) } as const;
  const path = `src/pages/permission-request/index.html?presetRevision=${input.installationRevision}`;
  const url = `chrome-extension://${extensionId}/${path}`;
  const getContexts = vi.fn().mockResolvedValue([]);
  const create = vi.fn();
  const update = vi.fn().mockResolvedValue({ id: 42 });
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: {
      ...chrome.runtime,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      getContexts,
    },
    windows: { create, update, getLastFocused: vi.fn().mockResolvedValue({}) },
  });
  expect(await synchronizeBrowserPreset(input, transport, f.registry)).toMatchObject({
    browserReady: true,
    ready: false,
    settingsReady: false,
    permissionPending: ['https://accounts.example.test/*'],
  });
  expect(create).not.toHaveBeenCalled();
  await synchronizeBrowserPreset({ ...input, showPermissions: true }, transport, f.registry);
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ url, type: 'popup', focused: true }),
  );
  getContexts.mockResolvedValue([{ frameId: 0, windowId: 42 }]);
  await synchronizeBrowserPreset({ ...input, showPermissions: true }, transport, f.registry);
  expect(create).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledExactlyOnceWith(42, { focused: true });
  stored.proxyCookieAllowedOrigins = ['*://accounts.example.test/*'];
  expect(await f.registry.installationStatus()).toMatchObject({
    ready: true,
    settingsReady: true,
    permissionPending: [],
  });
  chrome.permissions.contains = vi.fn(async () => false);
  expect(await f.registry.installationStatus()).toMatchObject({
    ready: false,
    permissionPending: ['https://accounts.example.test/*'],
  });
});

it('validates browser contributions before cross-host activation without changing installed state', async () => {
  const f = await registryFixture();
  await f.registry.applyPreset({ source: presetSource, expectedRevision: null });
  const before = await f.registry.captureInstallationSelection();
  const prepared = await prepareBrowserPreset(presetSource, {
    load: f.load,
    mearlApiVersion: '1.0.0',
  });
  await f.registry.validatePreparedPreset(prepared);
  expect(await f.registry.captureInstallationSelection()).toEqual(before);
  f.preset.appProfiles.reader = 'simulation/missing';
  const invalid = await prepareBrowserPreset(presetSource, {
    load: f.load,
    mearlApiVersion: '1.0.0',
  });
  await expect(f.registry.validatePreparedPreset(invalid)).rejects.toThrow('not provided');
  expect(await f.registry.captureInstallationSelection()).toEqual(before);
});
