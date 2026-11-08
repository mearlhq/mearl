import { expect, it } from 'vitest';
import { validateBrowserControl, selectBrowserControl } from '../browserControls.js';
import { parseNetworkRoutePlan, encodeNetworkRoutePlan, decodeNetworkRoutePlan } from '../networkRoutes.js';
import { bundleDigest, prepareBundle, verifyBundle, type BundleManifest, type PreparedBundle } from '../bundle.js';

const plan = { routes: [{ id: 'api', fromHost: 'api.example.test', toHost: 'qa.example.test' }] };
const definition = () => ({ schemaVersion: 1, id: 'environment', kind: 'segmented', label: { en: 'Request target' }, description: { en: 'Reload to apply' }, defaultValue: 'off', messages: { changed: { en: 'Reload' }, failed: { en: 'Failed' } }, options: [{ value: 'off', label: { en: 'Default' }, networkRoutes: { routes: [] } }, { value: 'qa', label: { en: 'QA' }, networkRoutes: plan }] });
it('accepts arbitrary environment names and round-trips the shared route protocol', () => {
  expect(validateBrowserControl(definition()).options[1].value).toBe('qa');
  expect(decodeNetworkRoutePlan(encodeNetworkRoutePlan(plan))).toEqual(plan);
});
it.each([
  null, [], { routes: [{ fromHost: '*.example.test', toHost: 'qa.example.test' }] },
  { routes: [{ fromHost: 'api.example.test', toHost: 'https://qa.example.test/' }] },
  { routes: [{ fromHost: 'api.example.test', toHost: 'api.example.test' }] },
  { routes: [...plan.routes, ...plan.routes] },
  { routes: plan.routes, rawDnr: {} },
  { routes: Array.from({ length: 33 }, (_, i) => ({ fromHost: `api${i}.example.test`, toHost: 'qa.example.test' })) },
])('rejects unsafe or ambiguous route plans %#', value => expect(() => parseNetworkRoutePlan(value)).toThrow());
it('rejects duplicate choices and a reset choice that installs routes', () => {
  const duplicate = definition(); duplicate.options.push(duplicate.options[1]);
  expect(() => validateBrowserControl(duplicate)).toThrow();
  const reset = definition(); reset.defaultValue = 'qa';
  expect(() => validateBrowserControl(reset)).toThrow();
});
it('rejects competing providers rather than letting the installation order choose', () => {
  const bytes = new TextEncoder().encode(JSON.stringify(definition()));
  const bundle = { source: 'https://example.test/bundle.json', revision: 'a', manifest: { id: 'one', contributions: { browserControls: 'control.json' } }, resources: { 'control.json': bytes } } as unknown as PreparedBundle;
  expect(selectBrowserControl([bundle])?.definition.defaultValue).toBe('off');
  expect(() => selectBrowserControl([bundle, { ...bundle, manifest: { ...bundle.manifest, id: 'two' } }])).toThrow('multiple providers');
});
it('validates control resources both during download and offline verification', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(definition()));
  const manifest: BundleManifest = { schemaVersion: 1, id: 'example', version: '1.0.0', resources: { 'control.json': { sha256: await bundleDigest(bytes), byteLength: bytes.byteLength } }, contributions: { appProfiles: [], browserControls: 'control.json' } };
  const load = async (url: string) => url.endsWith('control.json') ? bytes : new TextEncoder().encode(JSON.stringify(manifest));
  const bundle = await prepareBundle('https://example.test/bundle.json', { mearlApiVersion: '1.0.0', expectedId: 'example', load });
  expect((await verifyBundle(bundle, '1.0.0')).manifest.contributions?.browserControls).toBe('control.json');
  const invalid = new TextEncoder().encode(JSON.stringify({ ...definition(), defaultValue: 'missing' }));
  manifest.resources['control.json'] = { sha256: await bundleDigest(invalid), byteLength: invalid.byteLength };
  await expect(prepareBundle(bundle.source, { mearlApiVersion: '1.0.0', expectedId: 'example', load: async url => url.endsWith('control.json') ? invalid : new TextEncoder().encode(JSON.stringify(manifest)) })).rejects.toThrow('default option');
});
