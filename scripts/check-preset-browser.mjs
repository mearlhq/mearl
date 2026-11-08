import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: "export * from './packages/preset/src/index.ts'; export * from './packages/preset/src/bundles.ts';",
    resolveDir: root,
    sourcefile: 'browser-check.ts',
  },
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  globalName: 'MearlPreset',
  write: false,
  logLevel: 'silent',
});

// No process, Buffer, require, filesystem or native host is supplied to this context.
const resolved = await runInNewContext(`${bundle.outputFiles[0].text}
(async () => {
  const documents = {
    'https://example.com/base.json': {
      schemaVersion: 1, id: 'base', version: '1.0.0',
      packages: { simulation: { source: './simulation.json', targets: ['browser'] } },
      defaults: { app: { version: '1', language: 'en' } }
    },
    'https://example.com/team.json': {
      schemaVersion: 1, id: 'team', version: '1.0.0',
      extends: { source: './base.json', version: '^1' },
      requires: { mearlApi: '^1' },
      defaults: { app: { version: '2' } }
    }
  };
  const preset = await MearlPreset.resolvePreset('https://example.com/team.json', {
    mearlApiVersion: '1.0.0', load: async source => documents[source]
  });
  const profile = new TextEncoder().encode(JSON.stringify({ name: 'sample/app' }));
  const manifest = {
    schemaVersion: 1, id: 'sample', version: '1.0.0',
    resources: { 'profile.json': { sha256: await MearlPreset.bundleDigest(profile), byteLength: profile.byteLength } },
    contributions: { appProfiles: ['profile.json'] }
  };
  const bundle = await MearlPreset.prepareBundle('https://example.com/bundle.json', {
    expectedId: 'sample', mearlApiVersion: '1.0.0',
    load: async source => source.endsWith('bundle.json') ? new TextEncoder().encode(JSON.stringify(manifest)) : profile
  });
  documents['https://example.com/browser-base.json'] = { schemaVersion: 1, id: 'browser-base', version: '1.0.0', packages: { sample: { source: './bundle.json', targets: ['browser'] } } };
  documents['https://example.com/browser.json'] = { schemaVersion: 1, id: 'browser', version: '1.0.0', extends: { source: './browser-base.json' }, appProfiles: { sample: 'sample/app' } };
  const prepared = await MearlPreset.prepareBrowserPreset('https://example.com/browser.json', {
    mearlApiVersion: '1.0.0', load: async source => source.endsWith('profile.json') ? profile : new TextEncoder().encode(JSON.stringify(documents[source] ?? manifest))
  });
  const browserPreset = await MearlPreset.verifyBrowserPreset(prepared.snapshot, '1.0.0');
  const nodeBytes = new TextEncoder().encode('throw new Error("Must not execute during preparation")');
  documents['https://example.com/identity.json'] = { schemaVersion: 1, id: 'identity', version: '1.0.0', resources: { 'runtime.cjs': { sha256: await MearlPreset.bundleDigest(nodeBytes), byteLength: nodeBytes.byteLength } }, contributions: { appProfiles: [], nodeRuntimes: { 'native-host': { entry: 'runtime.cjs', bindings: { 'sample.identity': 'identity' } } } } };
  documents['https://example.com/browser.json'].packages = { identity: { source: './identity.json', targets: ['node'] } };
  const whole = await MearlPreset.preparePreset('https://example.com/browser.json', {
    mearlApiVersion: '1.0.0', load: async source => source.endsWith('profile.json') ? profile : source.endsWith('runtime.cjs') ? nodeBytes : new TextEncoder().encode(JSON.stringify(documents[source] ?? manifest))
  });
  const wholePreset = await MearlPreset.verifyPreset(whole.snapshot, '1.0.0');
  const node = await MearlPreset.prepareNodeBundleSnapshot(whole.bundles, 'native-host', '1.0.0');
  const header = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, installationRevision: 'a'.repeat(64), snapshot: whole.browser.snapshot, bundles: whole.browser.bundles.map(({ source, manifest, revision }) => ({ source, manifest, revision })), overrides: {} }));
  const headerHash = await MearlPreset.bundleDigest(header);
  const transferResources = new Map([[headerHash, header], [manifest.resources['profile.json'].sha256, profile]]);
  const received = await MearlPreset.receiveBrowserPreset('a'.repeat(64), { mearlApiVersion: '1.0.0', transport: async request => {
    if (request.operation === 'open') return { session: 'browser-check', sha256: headerHash, byteLength: header.byteLength };
    if (request.operation === 'read') return { data: btoa(Array.from(transferResources.get(request.sha256).subarray(request.offset, request.offset + MearlPreset.PRESET_TRANSFER_CHUNK_BYTES), byte => String.fromCharCode(byte)).join('')) };
    if (request.operation === 'confirm') return { installationRevision: 'a'.repeat(64) };
    return {};
  } });
  await received.confirm(); await received.release();
  if (received.prepared.snapshot.revision !== whole.browser.snapshot.revision) throw new Error('Browser transfer selection drift');
  return JSON.stringify({ preset, browserApps: browserPreset.preset.appProfiles, wholeApps: whole.browser.preset.appProfiles, wholePackages: Object.keys(wholePreset.snapshot.bundleRevisions), nodeHooks: Object.keys(node.snapshot.bindings), profile: MearlPreset.readBundleJson(await MearlPreset.verifyBundle(bundle, '1.0.0'), 'profile.json') });
})()`, { URL, crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa }, { timeout: 5_000 });

const { preset, profile, browserApps, wholeApps, wholePackages, nodeHooks } = JSON.parse(resolved);
assert.deepEqual(preset.defaults, { app: { version: '2', language: 'en' } });
assert.equal(preset.packages.simulation.source, 'https://example.com/simulation.json');
assert.deepEqual(preset.chain.map(entry => entry.id), ['base', 'team']);
assert.deepEqual(profile, { name: 'sample/app' });
assert.deepEqual(browserApps, { sample: 'sample/app' });
assert.deepEqual(wholeApps, browserApps);
assert.deepEqual(wholePackages, ['sample', 'identity']);
assert.deepEqual(nodeHooks, ['sample.identity']);
console.log('Preset inheritance, browser/Node preparation and offline graph verification run without Node globals or executing factories.');
