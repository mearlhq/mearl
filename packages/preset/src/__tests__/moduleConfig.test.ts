import { expect, it } from 'vitest';
import { mergePresetDefaults, resolveCapabilityConfig, prepareNodeBundleSnapshot } from '../index.js';
import { prepareBrowserBundleSnapshot, prepareBundle, bundleDigest } from '../bundles.js';

it('applies package, preset and user configuration identically in both hosts', async () => {
  const code = new TextEncoder().encode('module.exports = (_, config) => ({ value: () => config })');
  const manifest = { schemaVersion: 1, id: 'sample', version: '1.0.0', defaults: { nested: { inherited: true, choice: 'package' }, values: [1] },
    resources: { 'main.cjs': { sha256: await bundleDigest(code), byteLength: code.length } },
    contributions: { nodeRuntimes: { 'native-host': { entry: 'main.cjs', bindings: { 'sample.value': 'value' } } }, browserRuntimes: { extension: { entry: 'main.cjs', bindings: { 'sample.value': 'value' } } } } };
  const bundle = await prepareBundle('https://example.com/bundle.json', { expectedId: 'sample', mearlApiVersion: '1.0.0', load: async url => url.endsWith('bundle.json') ? new TextEncoder().encode(JSON.stringify(manifest)) : code });
  const config = resolveCapabilityConfig(mergePresetDefaults({ capabilities: { sample: { nested: { choice: 'preset' } } } }, { capabilities: { sample: { nested: { choice: 'user' }, values: [] } } }));
  const browser = await prepareBrowserBundleSnapshot([bundle], 'extension', '1.0.0', config);
  const node = await prepareNodeBundleSnapshot([bundle], 'native-host', '1.0.0', config);
  expect(browser.snapshot.modules.sample.config).toEqual({ nested: { inherited: true, choice: 'user' }, values: [] });
  expect(node.snapshot.modules.sample.config).toEqual(browser.snapshot.modules.sample.config);
  expect(manifest.defaults.nested.choice).toBe('package');
});

it('inherits defaults and merges host overrides without saving defaults into the override object', () => {
  const defaults = { capabilities: { sample: { manager: 'custom', nested: { inherited: true, option: 1 } } } };
  const overrides = { sample: { nested: { option: 2 } } };
  expect(resolveCapabilityConfig(defaults, overrides)).toEqual({ sample: { manager: 'custom', nested: { inherited: true, option: 2 } } });
  expect(overrides).toEqual({ sample: { nested: { option: 2 } } });
  expect(defaults.capabilities.sample.nested.option).toBe(1);
  expect(resolveCapabilityConfig(mergePresetDefaults(defaults, { capabilities: { sample: { manager: 'skills' } } }))).toMatchObject({ sample: { manager: 'skills', nested: { inherited: true } } });
});

it.each([null, [], 'invalid', { sample: true }, { 'invalid/id': {} }])('rejects malformed module defaults %#', capabilities => {
  expect(() => resolveCapabilityConfig({ capabilities } as never)).toThrow();
});

it('keeps disabled module overrides available and returns an empty config for a pure preset', () => {
  expect(resolveCapabilityConfig({})).toEqual({});
  expect(resolveCapabilityConfig({}, { disabled: { manager: 'custom' } })).toEqual({ disabled: { manager: 'custom' } });
});
