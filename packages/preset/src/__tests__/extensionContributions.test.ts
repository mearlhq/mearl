import { expect, it } from 'vitest';
import { bundleDigest, prepareBundle, selectExtensionContributions, validateExtensionContributions } from '../bundles.js';
import { browserUiHttpUrl } from '../requestUi.js';

async function bundle(id = 'example', hook = 'identity.panel') {
  const files = {
    'runtime.cjs': new TextEncoder().encode('module.exports = () => ({ identity: () => ({ subject: "user" }) })'),
    'extension.json': new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, operations: { identity: { hook, setting: 'accountsEnabled' } }, logins: { accounts: { url: 'https://example.com/login', title: { en: 'Accounts' } } } })),
  };
  const resources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, bytes]) => [name, { sha256: await bundleDigest(bytes), byteLength: bytes.length }])));
  const manifest = { schemaVersion: 1, id, version: '1.0.0', resources, contributions: { extension: 'extension.json', browserRuntimes: { extension: { entry: 'runtime.cjs', bindings: { 'identity.panel': 'identity' } } } } };
  return prepareBundle(`https://example.com/${id}/bundle.json`, { expectedId: id, mearlApiVersion: '1.0.0', load: async url => url.endsWith('bundle.json') ? new TextEncoder().encode(JSON.stringify(manifest)) : files[url.split('/').pop() as keyof typeof files] });
}
it('selects package-owned definitions with exact owners without requiring App profiles', async () => {
  const value = await bundle();
  expect(selectExtensionContributions([value])).toMatchObject({ operations: { identity: { hook: 'identity.panel' } }, owners: { identity: { bundleId: 'example', revision: value.revision } } });
  expect(value.manifest.contributions?.appProfiles).toBeUndefined();
});
it('rejects competing definitions and operations bound to a different package', async () => {
  expect(() => selectExtensionContributions([])).not.toThrow();
  const first = await bundle(), second = await bundle('other');
  expect(() => selectExtensionContributions([first, second])).toThrow('Multiple providers');
  const foreign = await bundle('foreign', 'identity.foreign');
  expect(() => selectExtensionContributions([foreign])).toThrow('own runtime');
});
it.each(['https://accounts.example.com/#/login', 'http://localhost:4321/#/login'])(
  'accepts SPA login navigation while retaining the API link restriction: %s', url => {
    const value = { schemaVersion: 1, logins: { accounts: { url, title: { en: 'Accounts' } } } };
    expect(validateExtensionContributions(value).logins?.accounts.url).toBe(url);
    expect(() => browserUiHttpUrl(url)).toThrow();
  },
);
it.each([
  { schemaVersion: 1, operations: { identity: { hook: 'valid', setting: 'agentEnabled' } } },
  { schemaVersion: 1, logins: { accounts: { url: 'https://user:password@example.com', title: { en: 'Accounts' } } } },
  { schemaVersion: 1, logins: { accounts: { url: 'javascript:alert(1)', title: { en: 'Accounts' } } } },
  { schemaVersion: 1, arbitrary: true },
])('rejects invalid declarations before loading runtime code %#', value => {
  expect(() => validateExtensionContributions(value)).toThrow();
});
