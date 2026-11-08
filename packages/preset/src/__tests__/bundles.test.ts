import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserBundleStore, bundleDigest, createBundleFetchLoader, prepareBundle, readBundleJson,
  validateBundleManifest, verifyBundle, type BundleManifest, type BundleLoader,
} from '../bundles.js';

const source = 'https://example.com/simulation/bundle.json';
const encoder = new TextEncoder();
afterEach(() => vi.restoreAllMocks());
async function fixture(version = '1.0.0', id = 'simulation') {
  const bytes = encoder.encode(JSON.stringify({ name: `${id}/sample`, label: 'Sample', version }));
  const manifest: BundleManifest = {
    schemaVersion: 1, id, version, requires: { mearlApi: '^1' },
    resources: { 'profiles/sample.json': { sha256: await bundleDigest(bytes), byteLength: bytes.byteLength } },
    contributions: { appProfiles: ['profiles/sample.json'] },
  };
  const resources: Record<string, Uint8Array> = {
    [source]: encoder.encode(JSON.stringify(manifest)),
    'https://example.com/simulation/profiles/sample.json': bytes,
  };
  const load = vi.fn<BundleLoader>(async url => {
    if (!resources[url]) throw new Error('Resource unavailable');
    return resources[url];
  });
  return { manifest, resources, load, options: { load, mearlApiVersion: '1.0.0', expectedId: id } };
}

describe('browser capability bundle preparation', () => {
  it('permits absent App contributions while rejecting an explicit null declaration', async () => {
    const { manifest } = await fixture();
    expect(validateBundleManifest({ ...manifest, contributions: {} }, '1.0.0').contributions?.appProfiles).toBeUndefined();
    expect(() => validateBundleManifest({ ...manifest, contributions: { appProfiles: null } }, '1.0.0')).toThrow('App profiles');
  });
  it('loads exact relative resources, validates integrity and preserves JSON contributions', async () => {
    const { options, load } = await fixture();
    const bundle = await prepareBundle(source, options);
    expect(load.mock.calls.map(([url]) => url)).toEqual([source, 'https://example.com/simulation/profiles/sample.json']);
    expect(readBundleJson(bundle, 'profiles/sample.json')).toEqual({ name: 'simulation/sample', label: 'Sample', version: '1.0.0' });
    expect(bundle.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifyBundle(bundle, '1.0.0')).toEqual(bundle);
  });

  it('rejects a mismatched identity, version or API before fetching resource bodies', async () => {
    const { options, load } = await fixture();
    await expect(prepareBundle(source, { ...options, expectedId: 'other' })).rejects.toMatchObject({ code: 'BUNDLE_INVALID' });
    await expect(prepareBundle(source, { ...options, version: '^2' })).rejects.toMatchObject({ code: 'BUNDLE_INCOMPATIBLE' });
    await expect(prepareBundle(source, { ...options, mearlApiVersion: '2.0.0' })).rejects.toMatchObject({ code: 'BUNDLE_INCOMPATIBLE' });
    expect(load.mock.calls.every(([url]) => url === source)).toBe(true);
  });

  it.each(['../escape.json', '/escape.json', 'profiles/../escape.json', 'profiles//sample.json', 'profiles/%2e%2e/escape.json', 'https://other.example.com/file.json'])
    ('rejects a resource path that escapes its declared bundle directory: %s', async name => {
      const { manifest } = await fixture();
      expect(() => validateBundleManifest({ ...manifest, resources: { [name]: manifest.resources['profiles/sample.json'] } }, '1.0.0')).toThrow();
    });

  it('rejects missing contribution resources, oversized manifests and non-JSON data', async () => {
    const { manifest, options } = await fixture();
    expect(() => validateBundleManifest({ ...manifest, contributions: { appProfiles: ['missing.json'] } }, '1.0.0')).toThrow();
    expect(() => validateBundleManifest({ ...manifest, resources: { 'x.json': { sha256: '0'.repeat(64), byteLength: 17 * 1024 * 1024 } } }, '1.0.0')).toThrow();
    await expect(prepareBundle(source, { ...options, load: async () => encoder.encode('x'.repeat(65_537)) })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    await expect(prepareBundle(source, { ...options, load: async () => new Uint8Array([0xff]) })).rejects.toMatchObject({ code: 'BUNDLE_INVALID' });
  });

  it('detects corrupt downloads and does not retain caller-owned resource buffers', async () => {
    const { options, resources } = await fixture();
    const bundle = await prepareBundle(source, options);
    resources['https://example.com/simulation/profiles/sample.json'][0] ^= 1;
    expect(readBundleJson(bundle, 'profiles/sample.json')).toHaveProperty('name', 'simulation/sample');
    await expect(prepareBundle(source, options)).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    bundle.resources['profiles/sample.json'][0] ^= 1;
    await expect(verifyBundle(bundle, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
  });

  it('rejects altered stored manifest revisions and undeclared resource bodies', async () => {
    const { options } = await fixture();
    const bundle = await prepareBundle(source, options);
    await expect(verifyBundle({ ...bundle, revision: '0'.repeat(64) }, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await expect(verifyBundle({ ...bundle, source: 'https://other.example.com/bundle.json' }, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await expect(verifyBundle({ ...bundle, resources: { ...bundle.resources, extra: new Uint8Array() } }, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INVALID' });
  });

  it('changes the revision when the same content is explicitly rebound to another source', async () => {
    const { options, resources } = await fixture();
    const first = await prepareBundle(source, options);
    const second = await prepareBundle('https://other.example.com/bundle.json', {
      ...options,
      load: async url => url.endsWith('bundle.json') ? resources[source] : resources['https://example.com/simulation/profiles/sample.json'],
    });
    expect(second.manifest).toEqual(first.manifest);
    expect(second.revision).not.toBe(first.revision);
  });

  it('propagates cancellation before any resource can become active', async () => {
    const { options, load } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(prepareBundle(source, { ...options, signal: controller.signal })).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('bounded browser downloads', () => {
  it('uses an explicit redirect policy and limits decoded response bytes', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const load = createBundleFetchLoader({ fetch: fetcher });
    expect(await load(source, { maxBytes: 3 })).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledWith(source, expect.objectContaining({ redirect: 'error', credentials: 'omit' }));
    await expect(load(source, { maxBytes: 2 })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
  });

  it('rejects authentication pages returned as redirects or HTTP failures', async () => {
    for (const response of [new Response('login', { status: 401 }), { ok: true, redirected: true } as Response]) {
      await expect(createBundleFetchLoader({ fetch: vi.fn(async () => response) })(source, { maxBytes: 64 }))
        .rejects.toMatchObject({ code: 'BUNDLE_INVALID' });
    }
  });
});

describe('persistent browser bundle installation', () => {
  it('stores shared resource bytes once and retains them until the last package or page releases them', async () => {
    const factory = new IDBFactory();
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    const bytes = encoder.encode('module.exports.install = () => {};');
    const sha256 = await bundleDigest(bytes);
    const bundles = [];
    for (const id of ['first', 'second']) {
      const manifest = { schemaVersion: 1, id, version: '1.0.0', resources: { 'main.cjs': { sha256, byteLength: bytes.length } }, contributions: { pageRuntimes: { main: 'main.cjs' } } };
      const bundle = await prepareBundle(`https://example.com/${id}/bundle.json`, { expectedId: id, mearlApiVersion: '1.0.0', load: async url => url.endsWith('bundle.json') ? encoder.encode(JSON.stringify(manifest)) : bytes });
      await store.install(bundle, null); bundles.push(bundle);
    }
    const inspect = () => new Promise<{ objects: any[]; bundles: any[] }>((resolve, reject) => {
      const open = factory.open('mearl-capabilities-v3', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction(['objects', 'bundles']);
        const objects = transaction.objectStore('objects').getAll(), metadata = transaction.objectStore('bundles').getAll();
        transaction.oncomplete = () => { db.close(); resolve({ objects: objects.result, bundles: metadata.result }); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    try {
      expect((await inspect()).objects).toHaveLength(1);
      expect((await inspect()).bundles.every(record => record.bundle.resources === undefined)).toBe(true);
      await store.pinPageRuntimes({ page: sha256 });
      for (const bundle of bundles) await store.remove(bundle.manifest.id, bundle.revision);
      expect((await inspect()).objects).toHaveLength(1);
      expect(await store.pageRuntimeSource(sha256)).toBe(new TextDecoder().decode(bytes));
      await store.pinPageRuntimes({ page: null });
      expect((await inspect()).objects).toHaveLength(0);
    } finally { await store.close(); }
  });
  it('rejects concurrently added independent bundles against the validated complete selection', async () => {
    const first = await fixture('1.0.0', 'first'), second = await fixture('1.0.0', 'second');
    const a = await prepareBundle(source, first.options), b = await prepareBundle(source, second.options);
    const factory = new IDBFactory();
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    const other = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    try {
      const expected = (await store.list()).revisions;
      const results = await Promise.allSettled([store.install(a, null, expected), other.install(b, null, expected)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'BUNDLE_CONFLICT' } });
      expect((await store.list()).bundles).toHaveLength(1);
    } finally { await store.close(); await other.close(); }
  });
  it('pins caller-owned metadata and resource bytes before asynchronous integrity checks', async () => {
    const { options } = await fixture();
    const bundle = await prepareBundle(source, options);
    const original = structuredClone(bundle);
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: new IDBFactory() });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      if (++calls === 2) { enter(); await released; }
      return digest(...args);
    });
    const installing = store.install(bundle, null);
    await entered;
    bundle.revision = '0'.repeat(64);
    bundle.source = 'https://other.example.com/bundle.json';
    bundle.manifest.version = '9.0.0';
    bundle.resources['profiles/sample.json'][0] ^= 1;
    release();
    await installing;
    spy.mockRestore();
    expect(await store.get('simulation')).toEqual(original);
    await store.close();
  });
  it('restores an installed profile after reopening storage without a loader or native host', async () => {
    const { options, load } = await fixture();
    const factory = new IDBFactory();
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    const bundle = await prepareBundle(source, options);
    await store.install(bundle, null);
    await store.close();
    load.mockClear();
    const reopened = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    expect(await reopened.get('simulation')).toEqual(bundle);
    expect((await reopened.list()).errors).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    await reopened.close();
  });

  it('retains the working revision when an update fails integrity validation', async () => {
    const first = await fixture();
    const second = await fixture('2.0.0');
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: new IDBFactory() });
    const original = await prepareBundle(source, first.options);
    await store.install(original, null);
    const update = await prepareBundle(source, second.options);
    update.resources['profiles/sample.json'][0] ^= 1;
    await expect(store.install(update, original.revision)).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    expect((await store.get('simulation'))?.revision).toBe(original.revision);
    await store.close();
  });

  it('rejects stale updates and removals in the same transaction as the write', async () => {
    const factory = new IDBFactory();
    const first = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    const second = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    const a = await fixture();
    const b = await fixture('2.0.0');
    const original = await prepareBundle(source, a.options);
    const update = await prepareBundle(source, b.options);
    await first.install(original, null);
    await second.install(update, original.revision);
    await expect(first.install(original, original.revision)).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    await expect(first.remove('simulation', original.revision)).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
    expect((await first.get('simulation'))?.revision).toBe(update.revision);
    await first.remove('simulation', update.revision);
    expect(await second.get('simulation')).toBeUndefined();
    await first.close(); await second.close();
  });

  it('does not let a corrupt bundle hide other installed profiles', async () => {
    const factory = new IDBFactory();
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory });
    const a = await fixture();
    const b = await fixture('1.0.0', 'other');
    await store.install(await prepareBundle(source, a.options), null);
    await store.install(await prepareBundle(source, b.options), null);
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('mearl-capabilities-v3', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('bundles', 'readwrite');
        const objects = transaction.objectStore('bundles');
        const get = objects.get('simulation');
        get.onsuccess = () => { const record = get.result; record.bundle.manifest.resources['profiles/sample.json'].sha256 = '0'.repeat(64); objects.put(record); };
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const result = await store.list();
    expect(result.bundles.map(bundle => bundle.manifest.id)).toEqual(['other']);
    expect(result.errors).toEqual([expect.objectContaining({ id: 'simulation', error: expect.stringContaining('BUNDLE_INTEGRITY') })]);
    await store.close();
  });
});
