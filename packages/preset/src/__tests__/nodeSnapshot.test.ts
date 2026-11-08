import { describe, expect, it, vi } from 'vitest';
import { prepareNodeBundleSnapshot, prepareCapabilitySnapshot, verifyCapabilitySnapshot, verifyCapabilityActivation, type CapabilitySelection } from '../index.js';
import { prepareBrowserBundleSnapshot, bundleDigest } from '../bundles.js';

function selection(): CapabilitySelection {
  return { schemaVersion: 1, modules: { sample: { sha256: 'a'.repeat(64), byteLength: 32, config: { option: true } } }, bindings: { 'sample.value': { module: 'sample', handler: 'value' } } };
}
describe('Node capability snapshot', () => {
  it('verifies the exact independent content and binding graph', async () => {
    const input = selection();
    const pending = prepareCapabilitySnapshot(input);
    input.modules.sample.config!.option = false;
    const snapshot = await pending;
    expect(snapshot.modules.sample.config!.option).toBe(true);
    await expect(verifyCapabilitySnapshot(snapshot)).resolves.toEqual(snapshot);
    snapshot.bindings['sample.value'].handler = 'other';
    await expect(verifyCapabilitySnapshot(snapshot)).rejects.toThrow('revision');
  });
  it('normalizes declaration order for a stable revision', async () => {
    const input = selection();
    input.modules.other = { sha256: 'b'.repeat(64), byteLength: 12 };
    const reversed = { ...input, modules: Object.fromEntries(Object.entries(input.modules).reverse()) };
    expect((await prepareCapabilitySnapshot(input)).revision).toBe((await prepareCapabilitySnapshot(reversed)).revision);
  });
  it('permits an explicit empty selection for disabling managed hooks', async () => {
    await expect(prepareCapabilitySnapshot({ schemaVersion: 1, modules: {}, bindings: {} })).resolves.toMatchObject({ modules: {}, bindings: {} });
  });
  it('validates receipt bindings without adding installer metadata to the Node revision', async () => {
    const snapshot = await prepareCapabilitySnapshot(selection());
    const activation = { ...snapshot, installationRevision: 'b'.repeat(64) };
    await expect(verifyCapabilityActivation(activation)).resolves.toEqual(activation);
    await expect(verifyCapabilityActivation({ ...activation, installationRevision: '../receipt' })).rejects.toThrow('installation revision');
    await expect(verifyCapabilitySnapshot(activation)).rejects.toThrow('structure');
  });
  it('bounds serialized selection configuration before hashing it', async () => {
    const input = selection(); input.modules.sample.config = { large: 'x'.repeat(262_144) };
    const hash = vi.spyOn(crypto.subtle, 'digest');
    try {
      await expect(prepareCapabilitySnapshot(input)).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
      expect(hash).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); }
  });
  it.each([
    (input: CapabilitySelection) => { input.bindings['sample.value'].module = 'missing'; },
    (input: CapabilitySelection) => { input.modules.sample.byteLength = -1; },
    (input: CapabilitySelection) => { input.modules.sample.sha256 = '../module.mjs'; },
    (input: CapabilitySelection) => { input.modules.sample.config = [] as never; },
    (input: CapabilitySelection) => { input.bindings['sample.value'] = { module: 'sample', handler: '../run' }; },
  ])('rejects invalid selections', async mutate => {
    const input = selection(); mutate(input);
    await expect(prepareCapabilitySnapshot(input)).rejects.toThrow();
  });
});

function nodeBundle(id: string, byteLength = 32, resources: Record<string, Uint8Array> = { 'main.cjs': new Uint8Array(byteLength) }) {
  return { source: `https://example.com/${id}/bundle.json`, revision: 'a'.repeat(64), resources, manifest: { schemaVersion: 1 as const, id, version: '1.0.0', requires: { mearlApi: '^1' }, resources: { 'main.cjs': { byteLength, sha256: 'a'.repeat(64) } }, contributions: { appProfiles: [], nodeRuntimes: { 'native-host': { entry: 'main.cjs', bindings: {} } } } } };
}
it.each(['modules', 'bytes'])('preflights the complete %s quota before copying or digesting resources', async limit => {
  const readResource = vi.fn(() => { throw new Error('Resource must not be read beyond the quota'); });
  const length = limit === 'bytes' ? 16 * 1024 * 1024 : 32;
  const count = limit === 'bytes' ? 5 : 65;
  const bundles = Array.from({ length: count }, (_, index) => nodeBundle(`sample-${index}`, length, index === count - 1 ? Object.defineProperty({}, 'main.cjs', { enumerable: true, get: readResource }) : { 'main.cjs': new Uint8Array(length) }));
  await expect(prepareNodeBundleSnapshot(bundles, 'native-host', '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
  expect(readResource).not.toHaveBeenCalled();
});
it('copies accepted Node code before an asynchronous digest and binds its selected handler', async () => {
  const { bundleDigest } = await import('../bundles.js');
  const bundle = nodeBundle('sample');
  bundle.manifest.resources['main.cjs'].sha256 = await bundleDigest(bundle.resources['main.cjs']);
  bundle.manifest.contributions.nodeRuntimes['native-host'].bindings = { 'sample.value': 'value' };
  const pending = prepareNodeBundleSnapshot([bundle], 'native-host', '1.0.0', { sample: { option: true } });
  bundle.resources['main.cjs'][0] = 1;
  const result = await pending;
  expect(result.resources[result.snapshot.modules.sample.sha256][0]).toBe(0);
  expect(result.snapshot.bindings['sample.value']).toEqual({ module: 'sample', handler: 'value' });
  await expect(verifyCapabilitySnapshot(result.snapshot)).resolves.toEqual(result.snapshot);
});
it('rejects non-object module configuration instead of silently ignoring it', async () => {
  await expect(prepareNodeBundleSnapshot([], 'native-host', '1.0.0', { sample: null } as never)).rejects.toThrow('JSON objects');
});

describe('browser runtime selection', () => {
  async function browserBundle(id = 'browser-service') {
    const bundle = nodeBundle(id);
    bundle.manifest.resources['main.cjs'].sha256 = await bundleDigest(bundle.resources['main.cjs']);
    Object.assign(bundle.manifest.contributions, { browserRuntimes: { extension: { entry: 'main.cjs', bindings: { 'request.apiSchema': 'schema' } } } });
    return bundle;
  }
  it('selects browser declarations independently from Node hosts and captures the accepted bytes/config', async () => {
    const bundle = await browserBundle();
    const config = { 'browser-service': { tenant: 'accepted' } };
    const pending = prepareBrowserBundleSnapshot([nodeBundle('node-only'), bundle], 'extension', '1.0.0', config);
    config['browser-service'].tenant = 'changed'; bundle.resources['main.cjs'].fill(1);
    const prepared = await pending;
    expect(Object.keys(prepared.snapshot.modules)).toEqual(['browser-service']);
    expect(prepared.snapshot.modules['browser-service'].config).toEqual({ tenant: 'accepted' });
    expect(prepared.snapshot.bindings['request.apiSchema']).toEqual({ module: 'browser-service', handler: 'schema' });
    expect(Object.values(prepared.resources)[0][0]).toBe(0);
    await expect(verifyCapabilitySnapshot(prepared.snapshot)).resolves.toEqual(prepared.snapshot);
    expect((await prepareBrowserBundleSnapshot([bundle], 'popup', '1.0.0')).snapshot.modules).toEqual({});
  });
  it('rejects conflicting providers before digesting or evaluating any module', async () => {
    const first = await browserBundle(), second = await browserBundle('other');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      await expect(prepareBrowserBundleSnapshot([first, second], 'extension', '1.0.0')).rejects.toThrow('multiple providers');
      expect(digest).not.toHaveBeenCalled();
    } finally { digest.mockRestore(); }
  });
  it('rejects undeclared browser entries, invalid handlers and changed resource bytes', async () => {
    const bundle = await browserBundle();
    (bundle.manifest.contributions as any).browserRuntimes.extension.entry = 'missing.cjs';
    await expect(prepareBrowserBundleSnapshot([bundle], 'extension', '1.0.0')).rejects.toThrow();
    (bundle.manifest.contributions as any).browserRuntimes.extension.entry = 'main.cjs';
    (bundle.manifest.contributions as any).browserRuntimes.extension.bindings['request.apiSchema'] = '../schema';
    await expect(prepareBrowserBundleSnapshot([bundle], 'extension', '1.0.0')).rejects.toThrow();
    (bundle.manifest.contributions as any).browserRuntimes.extension.bindings['request.apiSchema'] = 'schema';
    bundle.resources['main.cjs'][0] = 1;
    await expect(prepareBrowserBundleSnapshot([bundle], 'extension', '1.0.0')).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
  });
});
