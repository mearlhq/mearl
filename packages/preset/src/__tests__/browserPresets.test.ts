import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserBundleStore,
  bundleDigest,
  prepareBrowserPreset,
  prepareBundle,
  verifyBrowserPreset,
} from '../bundles.js';

vi.stubGlobal('crypto', webcrypto);
const source = 'https://example.com/presets/team.json';
const packageSource = 'https://example.com/bundles/simulation/bundle.json';
const stores: BrowserBundleStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  vi.restoreAllMocks();
});

async function fixture(version = '1.0.0', patch: Record<string, unknown> = {}) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ name: 'simulation/default', value: version }),
  );
  const manifests = {
    [source]: {
      schemaVersion: 1,
      id: 'team',
      version,
      extends: { source: './base.json' },
      defaults: { locale: 'en' },
      ...patch,
    },
    'https://example.com/presets/base.json': {
      schemaVersion: 1,
      id: 'base',
      version: '1.0.0',
      packages: {
        simulation: { source: packageSource, version: '^1', targets: ['browser'] },
        identity: { source: 'https://example.com/identity.json', targets: ['node'] },
      },
      appProfiles: { sample: 'simulation/default' },
      defaults: { locale: 'zh', enabled: true },
    },
    [packageSource]: {
      schemaVersion: 1,
      id: 'simulation',
      version,
      resources: {
        'profile.json': { sha256: await bundleDigest(bytes), byteLength: bytes.byteLength },
      },
      contributions: { appProfiles: ['profile.json'] },
    },
  };
  const load = vi.fn(async (url: string) => {
    if (url === 'https://example.com/bundles/simulation/profile.json') return bytes;
    if (!(url in manifests)) throw new Error(`Unexpected source ${url}`);
    return new TextEncoder().encode(JSON.stringify(manifests[url as keyof typeof manifests]));
  });
  const factory = new IDBFactory();
  const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
  stores.push(store);
  return {
    load,
    factory,
    store,
    prepared: (options: { maxDownloadBytes?: number } = {}) =>
      prepareBrowserPreset(source, { load, mearlApiVersion: '1.0.0', ...options }),
  };
}

describe('browser preset activation', () => {
  it('rejects an independently changed package set after host contribution validation', async () => {
    const f = await fixture();
    const prepared = await f.prepared();
    const expected = (await f.store.list()).revisions;
    const independent = await prepareBundle('https://example.com/independent/bundle.json', {
      expectedId: 'independent',
      mearlApiVersion: '1.0.0',
      load: async url =>
        url.endsWith('bundle.json')
          ? new TextEncoder().encode(
              JSON.stringify({ ...prepared.bundles[0].manifest, id: 'independent' }),
            )
          : prepared.bundles[0].resources['profile.json'],
    });
    await f.store.install(independent, null);
    await expect(
      f.store.activatePreset(
        prepared.snapshot,
        prepared.bundles.map(bundle => ({ bundle, expectedRevision: null })),
        null,
        undefined,
        expected,
      ),
    ).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    expect((await f.store.list()).bundles.map(bundle => bundle.manifest.id)).toEqual([
      'independent',
    ]);
    expect((await f.store.list()).activeRevision).toBeNull();
  });
  it('removes packages that leave the managed graph while preserving independent packages', async () => {
    const f = await fixture();
    const first = await f.prepared();
    const independent = await prepareBundle('https://example.com/independent/bundle.json', {
      expectedId: 'independent',
      mearlApiVersion: '1.0.0',
      load: async url =>
        url.endsWith('bundle.json')
          ? new TextEncoder().encode(
              JSON.stringify({ ...first.bundles[0].manifest, id: 'independent' }),
            )
          : first.bundles[0].resources['profile.json'],
    });
    await f.store.install(independent, null);
    await f.store.activatePreset(
      first.snapshot,
      first.bundles.map(bundle => ({ bundle, expectedRevision: null })),
      null,
    );
    const empty = await prepareBrowserPreset('https://example.com/empty.json', {
      mearlApiVersion: '1.0.0',
      load: async () =>
        new TextEncoder().encode(
          JSON.stringify({ schemaVersion: 1, id: 'empty', version: '1.0.0' }),
        ),
    });
    await f.store.activatePreset(empty.snapshot, [], first.snapshot.revision);
    expect((await f.store.list()).bundles.map(bundle => bundle.manifest.id)).toEqual([
      'independent',
    ]);
    expect(await f.store.profileBinding('sample')).toBeUndefined();
  });

  it('uninstalls a browser-only preset and preserves independently installed bundles', async () => {
    const f = await fixture();
    const { snapshot, bundles } = await f.prepared();
    const independent = await prepareBundle('https://example.com/independent/bundle.json', {
      expectedId: 'independent',
      mearlApiVersion: '1.0.0',
      load: async url =>
        url.endsWith('bundle.json')
          ? new TextEncoder().encode(JSON.stringify({ ...bundles[0].manifest, id: 'independent' }))
          : bundles[0].resources['profile.json'],
    });
    await f.store.install(independent, null);
    await f.store.activatePreset(
      snapshot,
      bundles.map(bundle => ({ bundle, expectedRevision: null })),
      null,
    );
    await f.store.uninstallPreset(snapshot.revision, null);
    expect(await f.store.list()).toMatchObject({
      activeRevision: null,
      installationToken: null,
      bundles: [independent],
    });
    expect(await f.store.profileBinding('sample')).toBeUndefined();
  });

  it('does not adopt an independently installed package during setup synchronization', async () => {
    const f = await fixture();
    const first = await f.prepared();
    await f.store.install(first.bundles[0], null);
    await expect(
      f.store.activatePreset(
        first.snapshot,
        first.bundles.map(bundle => ({ bundle, expectedRevision: bundle.revision })),
        null,
        {
          installation: {
            revision: 'a'.repeat(64),
            browserRevision: first.snapshot.revision,
            overrides: {},
          },
          expectedInstallationToken: null,
        },
      ),
    ).rejects.toThrow('independently installed');
    expect(await f.store.get('simulation')).toEqual(first.bundles[0]);
    expect((await f.store.list()).activeRevision).toBeNull();
  });
  it('resolves inheritance and prepares only explicitly browser-capable packages', async () => {
    const { prepared, load } = await fixture();
    const result = await prepared();
    expect(result.preset.chain.map(item => item.id)).toEqual(['base', 'team']);
    expect(result.preset.defaults).toEqual({ locale: 'en', enabled: true });
    expect(result.bundles.map(bundle => bundle.manifest.id)).toEqual(['simulation']);
    expect(load).toHaveBeenCalledTimes(4);
    expect(await verifyBrowserPreset(result.snapshot, '1.0.0')).toEqual({
      snapshot: result.snapshot,
      preset: result.preset,
    });
  });

  it('restores the selected provider and exact graph offline after reopening the store', async () => {
    const { store, factory, prepared, load } = await fixture();
    const { snapshot, bundles } = await prepared();
    await store.activatePreset(
      snapshot,
      bundles.map(bundle => ({ bundle, expectedRevision: null })),
      null,
    );
    await store.close();
    load.mockRejectedValue(new Error('offline'));
    const reopened = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    stores.push(reopened);
    expect((await reopened.profileBinding('sample'))?.target).toBe('simulation/default');
    expect((await reopened.activePreset())?.preset.packages.identity.targets).toEqual(['node']);
    expect((await reopened.list()).activation?.snapshot.revision).toBe(snapshot.revision);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('does not activate a partial or corrupt update and keeps the previous selection', async () => {
    const { store, prepared } = await fixture();
    const first = await prepared();
    await store.activatePreset(
      first.snapshot,
      first.bundles.map(bundle => ({ bundle, expectedRevision: null })),
      null,
    );
    await expect(store.activatePreset(first.snapshot, [], first.snapshot.revision)).rejects.toThrow(
      'every exact',
    );
    const next = await (await fixture('1.1.0')).prepared();
    next.bundles[0].resources['profile.json'][0] ^= 1;
    await expect(
      store.activatePreset(
        next.snapshot,
        next.bundles.map(bundle => ({ bundle, expectedRevision: first.bundles[0].revision })),
        first.snapshot.revision,
      ),
    ).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    expect((await store.profileBinding('sample'))?.bundle.manifest.version).toBe('1.0.0');
  });

  it('rejects stale preset/package writes and prevents direct mutation of managed bundles', async () => {
    const { store, prepared } = await fixture();
    const first = await prepared();
    const replacements = first.bundles.map(bundle => ({ bundle, expectedRevision: null }));
    await store.activatePreset(first.snapshot, replacements, null);
    await expect(
      store.activatePreset(first.snapshot, replacements, first.snapshot.revision),
    ).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    const current = first.bundles.map(bundle => ({ bundle, expectedRevision: bundle.revision }));
    await expect(store.activatePreset(first.snapshot, current, null)).rejects.toMatchObject({
      code: 'BUNDLE_CONFLICT',
    });
    await expect(store.remove('simulation', first.bundles[0].revision)).rejects.toThrow('managed');
    await expect(store.install(first.bundles[0], first.bundles[0].revision)).rejects.toThrow(
      'managed',
    );
    await store.activatePreset(first.snapshot, current, first.snapshot.revision);
  });

  it('rejects disabled or node-only App providers before downloading packages', async () => {
    for (const simulation of [{ enabled: false }, { targets: ['node'] }]) {
      const { prepared, load } = await fixture('1.0.0', { packages: { simulation } });
      await expect(prepared()).rejects.toThrow('enabled browser package');
      expect(load).toHaveBeenCalledTimes(2);
    }
  });

  it('uses a fresh 3.x store without importing or deleting older development data', async () => {
    const { factory, store, prepared } = await fixture();
    const { bundles } = await prepared();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('mearl-capability-bundles', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('bundles', { keyPath: 'id' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('bundles', 'readwrite');
        transaction
          .objectStore('bundles')
          .put({
            id: 'simulation',
            revision: bundles[0].revision,
            byteLength: Object.values(bundles[0].resources).reduce(
              (sum, bytes) => sum + bytes.byteLength,
              0,
            ),
            bundle: bundles[0],
          });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    expect(await store.get('simulation')).toBeUndefined();
    expect(await store.activePreset()).toBeUndefined();
    expect(await store.profileBinding('sample')).toBeUndefined();
  });

  it('detects changed offline manifests without consulting an online source', async () => {
    const { prepared } = await fixture();
    const { snapshot } = await prepared();
    snapshot.manifests[source].defaults = { locale: 'unexpected' };
    await expect(verifyBrowserPreset(snapshot, '1.0.0')).rejects.toMatchObject({
      code: 'BUNDLE_INTEGRITY',
    });
  });
  it('stops before loading the next package when the shared download budget is exhausted', async () => {
    const { prepared, load } = await fixture('1.0.0', {
      packages: {
        extra: { source: 'https://example.com/extra/bundle.json', targets: ['browser'] },
      },
    });
    const urls = [source, 'https://example.com/presets/base.json', packageSource];
    let maxDownloadBytes = 0;
    for (const url of urls) maxDownloadBytes += (await load(url)).byteLength;
    load.mockClear();
    await expect(prepared({ maxDownloadBytes })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    expect(load.mock.calls.map(([url]) => url)).toEqual(urls);
  });
  it('checks aggregate resource bytes before copying or hashing activation inputs', async () => {
    const { store, prepared } = await fixture();
    const { snapshot, bundles } = await prepared();
    bundles[0].resources = { huge: new Uint8Array(65 * 1024 * 1024) };
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(
      store.activatePreset(snapshot, [{ bundle: bundles[0], expectedRevision: null }], null),
    ).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    expect(digest).not.toHaveBeenCalled();
  });
});
