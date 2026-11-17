import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { JsonObject } from '@mearl/preset';
import { preparePreset } from '@mearl/preset/bundles';
import { PresetInstallationStore, readInstallationManagement } from '../preset-installation.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mearl-management-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function install(defaults: JsonObject = {}, skills: JsonObject = {}) {
  const source = 'https://example.test/preset.json';
  const prepared = await preparePreset(source, {
    mearlApiVersion: '1.0.0',
    load: async () =>
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          id: 'team',
          version: '1.0.0',
          skills,
          defaults: {
            management: { setup: { package: '@team/setup', version: 'beta' } },
            ...defaults,
          },
        }),
      ),
  });
  const store = new PresetInstallationStore({ directory });
  const receipt = await store.apply(prepared, { expectedRevision: null });
  return { store, receipt, prepared };
}
it('distinguishes an unselected installation and reads management from the accepted graph', async () => {
  expect(await readInstallationManagement({ directory })).toEqual({
    setup: undefined,
    source: undefined,
    revision: undefined,
  });
  const { receipt } = await install();
  expect(await readInstallationManagement({ directory })).toEqual({
    setup: { package: '@team/setup', version: 'beta' },
    source: 'https://example.test/preset.json',
    revision: receipt.revision,
  });
});
it('reads the Preset catalog directly from the accepted graph without a Skill installation', async () => {
  const agentDocs = 'https://example.test/skills';
  const skillCatalog = {
    'team-report': 'Read team reports',
    'other-report': {
      description: 'Read another team’s reports',
      source: 'https://example.test/other/skills.git',
    },
    'managed-report': { description: 'Read managed reports' },
  };
  const { store, receipt, prepared } = await install(
    { extension: { links: { agentDocs } }, skillCatalogSource: 'example/skills', skillCatalog },
    { 'managed-report': { source: 'example/managed' } },
  );
  await store.apply(prepared, {
    expectedRevision: receipt.revision,
    overrides: {
      extension: { links: { agentDocs: 'https://other.example.test/skills' } },
      skillCatalog: { 'team-report': 'Other instructions' },
    },
  });
  const installed = await readInstallationManagement({ directory });
  expect(installed.agentDocs).toBe(agentDocs);
  expect(installed.skillCatalog).toEqual({
    'team-report': { description: 'Read team reports', source: 'example/skills' },
    'other-report': skillCatalog['other-report'],
    'managed-report': { description: 'Read managed reports', managed: true },
  });
});
it.each(['javascript:alert(1)', 'https://user:secret@example.test/skills'])(
  'ignores unsafe discovery links (%s)',
  async agentDocs => {
    await install({ extension: { links: { agentDocs } } });
    expect((await readInstallationManagement({ directory })).agentDocs).toBeUndefined();
  },
);
it('keeps valid catalog entries when one would inject new output lines', async () => {
  await install({
    skillCatalogSource: 'example/skills',
    skillCatalog: {
      'invalid-report': 'Read team reports\n# New section',
      'team-report': 'Read team reports',
    },
  });
  expect((await readInstallationManagement({ directory })).skillCatalog).toEqual({
    'team-report': { description: 'Read team reports', source: 'example/skills' },
  });
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
  await expect(
    store.apply(prepared, {
      expectedRevision: receipt.revision,
      overrides: { management: { setup: { package: '@other/setup', version: 'latest' } } },
    }),
  ).rejects.toThrow('cannot be overridden');
  expect((await readInstallationManagement({ directory })).revision).toBe(receipt.revision);
});
