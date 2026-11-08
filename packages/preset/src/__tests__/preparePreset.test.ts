import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserBundleStore, bundleDigest, prepareBrowserPreset, preparePreset, verifyBrowserPreset, verifyPreset, verifyPreparedPreset } from '../bundles.js';
import { prepareNodeBundleSnapshot } from '../index.js';

vi.stubGlobal('crypto', webcrypto);
afterEach(() => vi.restoreAllMocks());
const source = 'https://example.com/presets/team.json';
const base = 'https://example.com/presets/base.json';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function fixture() {
  const sources = new Map<string, Uint8Array>();
  const code = new TextEncoder().encode('throw new Error("Preparation must not execute this factory")');
  const profile = encode({ name: 'simulation/default' });
  const packageManifest = async (id: string, resources: Record<string, Uint8Array>, contributions: object) => {
    const entries = await Promise.all(Object.entries(resources).map(async ([name, bytes]) => {
      sources.set(`https://example.com/${id}/${name}`, bytes);
      return [name, { sha256: await bundleDigest(bytes), byteLength: bytes.byteLength }];
    }));
    sources.set(`https://example.com/${id}/bundle.json`, encode({ schemaVersion: 1, id, version: '1.0.0', resources: Object.fromEntries(entries), contributions }));
  };
  await packageManifest('simulation', { 'profile.json': profile, 'runtime.cjs': code }, {
    appProfiles: ['profile.json'], nodeRuntimes: { 'native-host': { entry: 'runtime.cjs', bindings: { 'sample.simulation': 'simulate' } } },
  });
  await packageManifest('identity', { 'runtime.cjs': code }, {
    appProfiles: [], nodeRuntimes: { 'native-host': { entry: 'runtime.cjs', bindings: { 'sample.identity': 'identity' } } },
  });
  sources.set(base, encode({ schemaVersion: 1, id: 'base', version: '1.0.0', packages: {
    simulation: { source: '../simulation/bundle.json', version: '^1', targets: ['browser', 'node'] },
    identity: { source: '../identity/bundle.json', version: '^1', targets: ['node'] },
  }, appProfiles: { sample: 'simulation/default' }, defaults: { locale: 'en', nested: { first: true } } }));
  sources.set(source, encode({ schemaVersion: 1, id: 'team', version: '1.0.0', extends: { source: './base.json' },
    packages: { simulation: { version: '^1.0' } }, defaults: { nested: { second: true } },
    skills: { helper: { source: 'https://example.com/skills.git' } }, providers: { device: { source: 'https://example.com/provider.git' } },
  }));
  const load = vi.fn(async (url: string) => {
    const bytes = sources.get(url);
    if (!bytes) throw new Error(`Unexpected source: ${url}`);
    return bytes;
  });
  const options = { mearlApiVersion: '1.0.0', load };
  const patch = (url: string, values: object) => sources.set(url, encode({ ...JSON.parse(new TextDecoder().decode(sources.get(url)!)), ...values }));
  return { sources, load, options, patch };
}

describe('whole preset preparation', () => {
  it('captures one inherited graph and downloads dual-runtime packages only once', async () => {
    const { options, load } = await fixture();
    const result = await preparePreset(source, options);
    expect(result.preset.chain.map(item => item.id)).toEqual(['base', 'team']);
    expect(result.preset.defaults).toEqual({ locale: 'en', nested: { first: true, second: true } });
    expect(result.bundles.map(bundle => bundle.manifest.id)).toEqual(['simulation', 'identity']);
    expect(load.mock.calls.map(([url]) => url)).toHaveLength(7);
    expect(new Set(load.mock.calls.map(([url]) => url)).size).toBe(7);
    expect(result.preset.skills.helper.source).toBe('https://example.com/skills.git');
    expect(result.preset.providers.device.source).toBe('https://example.com/provider.git');
    const node = await prepareNodeBundleSnapshot(result.bundles, 'native-host', '1.0.0');
    expect(Object.keys(node.snapshot.bindings)).toEqual(['sample.identity', 'sample.simulation']);
    expect(Object.keys(node.snapshot.modules)).toEqual(['identity', 'simulation']);
    expect(load).toHaveBeenCalledTimes(7);
  });

  it('uses the existing browser activation contract and restores both graphs offline', async () => {
    const { options, load } = await fixture();
    const result = await preparePreset(source, options);
    expect(result.browser).toEqual(await prepareBrowserPreset(source, options));
    load.mockRejectedValue(new Error('offline'));
    expect(await verifyPreset(result.snapshot, '1.0.0')).toEqual({ snapshot: result.snapshot, preset: result.preset });
    expect(await verifyBrowserPreset(result.browser.snapshot, '1.0.0')).toEqual({ snapshot: result.browser.snapshot, preset: result.preset });
    const store = new BrowserBundleStore({ indexedDB: new IDBFactory(), mearlApiVersion: '1.0.0' });
    try {
      await store.activatePreset(result.browser.snapshot, result.browser.bundles.map(bundle => ({ bundle, expectedRevision: null })), null);
      expect((await store.profileBinding('sample'))?.bundle.manifest.id).toBe('simulation');
      expect((await store.activePreset())?.preset.packages.identity.targets).toEqual(['node']);
      expect((await store.list()).bundles.map(bundle => bundle.manifest.id)).toEqual(['simulation']);
    } finally { await store.close(); }
  });

  it('applies child disabling before downloads and keeps source provenance on patches', async () => {
    const { options, load, patch } = await fixture();
    patch(source, { packages: { simulation: { version: '^1.0' }, identity: { enabled: false } } });
    const result = await preparePreset(source, options);
    expect(result.bundles.map(bundle => bundle.manifest.id)).toEqual(['simulation']);
    expect(result.preset.packages.simulation).toMatchObject({ source: 'https://example.com/simulation/bundle.json', declaredBy: source, targets: ['browser', 'node'] });
    expect(load.mock.calls.some(([url]) => url.includes('/identity/'))).toBe(false);
  });

  it('rejects runtime-specific missing dependencies before downloading either package', async () => {
    const { options, load, patch } = await fixture();
    patch(source, { packages: { simulation: { dependsOn: ['identity'] } } });
    await expect(preparePreset(source, options)).rejects.toMatchObject({ code: 'BUNDLE_INCOMPATIBLE' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('discovers inferred Node targets before validating dependencies on explicitly Node packages', async () => {
    const { options, sources, patch } = await fixture();
    const parent = JSON.parse(new TextDecoder().decode(sources.get(base)!));
    delete parent.packages.identity.targets;
    parent.packages.identity.dependsOn = ['simulation'];
    parent.packages.simulation.targets = ['node'];
    parent.appProfiles = {};
    patch(base, parent);
    const url = 'https://example.com/simulation/bundle.json';
    const manifest = JSON.parse(new TextDecoder().decode(sources.get(url)!));
    delete manifest.contributions.appProfiles;
    patch(url, manifest);
    const prepared = await preparePreset(source, options);
    expect(prepared.snapshot.packageTargets).toEqual({ simulation: ['node'], identity: ['node'] });
    expect(prepared.browser.bundles).toEqual([]);
    expect(await verifyPreset(prepared.snapshot, '1.0.0')).toMatchObject({ preset: prepared.preset });
  });

  it('rejects genuinely incompatible inferred dependencies after discovery and before resource downloads', async () => {
    const { options, sources, patch, load } = await fixture();
    const parent = JSON.parse(new TextDecoder().decode(sources.get(base)!));
    delete parent.packages.identity.targets;
    parent.packages.identity.dependsOn = ['simulation'];
    parent.packages.simulation.targets = ['browser'];
    patch(base, parent);
    await expect(preparePreset(source, options)).rejects.toMatchObject({ code: 'BUNDLE_INCOMPATIBLE' });
    expect(load.mock.calls.map(([url]) => url)).toEqual([source, base, 'https://example.com/simulation/bundle.json', 'https://example.com/identity/bundle.json']);
  });

  it('infers supported targets from packages and preserves that selection for offline verification', async () => {
    const { options, sources, patch, load } = await fixture();
    const parent = JSON.parse(new TextDecoder().decode(sources.get(base)!));
    for (const entry of Object.values(parent.packages) as Array<{ targets?: string[] }>) delete entry.targets;
    patch(base, parent);
    const prepared = await preparePreset(source, options);
    expect(prepared.snapshot.packageTargets).toEqual({ simulation: ['browser', 'node'], identity: ['node'] });
    expect(prepared.snapshot.manifests[base].packages?.identity.targets).toBeUndefined();
    expect(await verifyPreset(prepared.snapshot, '1.0.0')).toMatchObject({ preset: prepared.preset });
    load.mockClear();
    expect((await prepareBrowserPreset(source, options)).bundles.map(bundle => bundle.manifest.id)).toEqual(['simulation']);
    expect(load.mock.calls.some(([url]) => url === 'https://example.com/identity/runtime.cjs')).toBe(false);
  });

  it('rejects a Node package version or resource failure instead of returning a browser-only success', async () => {
    for (const failure of ['version', 'resource']) {
      const { options, patch, sources } = await fixture();
      if (failure === 'version') patch(source, { packages: { identity: { version: '^2' } } });
      else sources.set('https://example.com/identity/runtime.cjs', new Uint8Array([0]));
      await expect(preparePreset(source, options)).rejects.toMatchObject({ code: failure === 'version' ? 'BUNDLE_INCOMPATIBLE' : 'BUNDLE_INTEGRITY' });
    }
  });

  it('shares one download budget across browser and Node packages', async () => {
    const { options, sources, load } = await fixture();
    const headers = [source, base, 'https://example.com/simulation/bundle.json', 'https://example.com/identity/bundle.json'];
    const bytesBeforeResources = headers
      .reduce((total, url) => total + sources.get(url)!.byteLength, 0);
    await expect(preparePreset(source, { ...options, maxDownloadBytes: bytesBeforeResources })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    expect(load.mock.calls.map(([url]) => url)).toEqual(headers);
    await expect(preparePreset(source, { ...options, maxDownloadBytes: 4 })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
  });

  it('rejects tampered, partial or wrong-kind offline snapshots', async () => {
    const { options } = await fixture();
    const result = await preparePreset(source, options);
    for (const mutate of [
      (value: typeof result.snapshot) => { value.manifests[source].defaults = { locale: 'changed' }; },
      (value: typeof result.snapshot) => { delete value.bundleRevisions.identity; },
      (value: typeof result.snapshot) => { delete value.manifests[base]; },
    ]) {
      const changed = structuredClone(result.snapshot);
      mutate(changed);
      await expect(verifyPreset(changed, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    }
    await expect(verifyPreset(result.browser.snapshot as typeof result.snapshot, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await expect(verifyBrowserPreset(result.snapshot, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
  });

  it('rejects a rehashed graph that omits a declared package', async () => {
    const { options } = await fixture();
    const { snapshot } = await preparePreset(source, options);
    delete snapshot.bundleRevisions.identity;
    const { revision: _revision, ...data } = snapshot;
    snapshot.revision = await bundleDigest(encode(data));
    await expect(verifyPreset(snapshot, '1.0.0')).rejects.toThrow('package graph');
  });

  it('captures caller input before asynchronous verification and respects cancellation', async () => {
    const { options, load } = await fixture();
    const { snapshot } = await preparePreset(source, options);
    const accepted = structuredClone(snapshot);
    const verification = verifyPreset(snapshot, '1.0.0');
    snapshot.manifests[source].defaults = { locale: 'later mutation' };
    expect((await verification).snapshot).toEqual(accepted);
    const controller = new AbortController();
    controller.abort();
    load.mockClear();
    await expect(preparePreset(source, { ...options, signal: controller.signal })).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
  it('captures every resource before asynchronous installation validation and derives its browser view', async () => {
    const { options } = await fixture();
    const prepared = await preparePreset(source, options);
    const accepted = structuredClone(prepared);
    const result = verifyPreparedPreset(prepared, '1.0.0');
    prepared.bundles[1].resources['runtime.cjs'][0] ^= 1;
    prepared.browser.snapshot.manifests[source].defaults = { wrong: true };
    expect(await result).toEqual(accepted);
  });
  it('rejects missing, duplicate and oversized resources before committing any installation', async () => {
    const { options } = await fixture();
    const prepared = await preparePreset(source, options);
    await expect(verifyPreparedPreset({ snapshot: prepared.snapshot, bundles: prepared.bundles.slice(0, 1) }, '1.0.0')).rejects.toThrow('every exact package');
    await expect(verifyPreparedPreset({ snapshot: prepared.snapshot, bundles: [prepared.bundles[0], prepared.bundles[0]] }, '1.0.0')).rejects.toThrow('every exact package');
    prepared.bundles[0].resources = { huge: new Uint8Array(65 * 1024 * 1024) };
    const hash = vi.spyOn(crypto.subtle, 'digest');
    await expect(verifyPreparedPreset(prepared, '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    expect(hash).not.toHaveBeenCalled();
  });
});
