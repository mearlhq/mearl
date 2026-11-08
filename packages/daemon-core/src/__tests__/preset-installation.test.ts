import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { preparePreset } from '@mearl/preset/bundles';
import { PresetInstallationStore, readInstallationManagement } from '../preset-installation.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mearl-management-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function install() {
  const source = 'https://example.test/preset.json';
  const prepared = await preparePreset(source, { mearlApiVersion: '1.0.0', load: async () => new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, id: 'team', version: '1.0.0', defaults: { management: { setup: { package: '@team/setup', version: 'beta' } } } })) });
  const store = new PresetInstallationStore({ directory });
  const receipt = await store.apply(prepared, { expectedRevision: null });
  return { store, receipt, prepared };
}
it('distinguishes an unselected installation and reads management from the accepted graph', async () => {
  expect(await readInstallationManagement({ directory })).toEqual({ setup: undefined, source: undefined, revision: undefined });
  const { receipt } = await install();
  expect(await readInstallationManagement({ directory })).toEqual({ setup: { package: '@team/setup', version: 'beta' }, source: 'https://example.test/preset.json', revision: receipt.revision });
});
it('does not fall back when the accepted receipt is corrupt or missing', async () => {
  const { receipt } = await install();
  const file = join(directory, 'installations', `${receipt.revision}.json`);
  const value = JSON.parse(await readFile(file, 'utf8'));
  value.snapshot.source = 'https://other.example.test/preset.json';
  await writeFile(file, JSON.stringify(value));
  await expect(readInstallationManagement({ directory })).rejects.toThrow('BUNDLE_INTEGRITY');
  await rm(file);
  await expect(readInstallationManagement({ directory })).rejects.toThrow();
});
it('rejects runtime preference overrides of installation ownership', async () => {
  const { store, receipt, prepared } = await install();
  await expect(store.apply(prepared, { expectedRevision: receipt.revision, overrides: { management: { setup: { package: '@other/setup', version: 'latest' } } } })).rejects.toThrow('cannot be overridden');
  expect((await readInstallationManagement({ directory })).revision).toBe(receipt.revision);
});
