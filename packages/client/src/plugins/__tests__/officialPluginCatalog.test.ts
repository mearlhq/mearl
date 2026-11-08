import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFICIAL_PLUGINS, findOfficialPlugin, listOfficialPluginNames, readOfficialPluginCatalog, replaceOfficialPluginCatalog } from '../officialPluginCatalog.js';
import { listPluginNames } from '../pluginRegistry.js';

let directory: string;
const declaration = { description: 'Sample adapter', installArgs: ['https://example.com/skills', '--skill', 'sample-adapter', '--yes'], skill: 'sample-adapter', setup: 'team' };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'mearl-catalog-')); vi.stubEnv('MEARL_PLUGIN_DIR', directory); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('preset-owned plugin catalog', () => {
  it('starts without organization aliases and atomically replaces the selected catalog', () => {
    expect(readOfficialPluginCatalog()).toBeUndefined();
    expect(listOfficialPluginNames()).toEqual([]);
    replaceOfficialPluginCatalog('a'.repeat(64), { sample: declaration });
    expect(readOfficialPluginCatalog()).toEqual({ schemaVersion: 1, revision: 'a'.repeat(64), plugins: { sample: declaration } });
    expect(findOfficialPlugin('sample')).toEqual(declaration);
    expect(listOfficialPluginNames('team')).toEqual(['sample']);
    expect(listOfficialPluginNames('other')).toEqual([]);
    expect(OFFICIAL_PLUGINS.sample).toEqual(declaration);
    expect(listPluginNames()).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(join(directory, '.official-catalog.json')).mode & 0o777).toBe(0o600);
    replaceOfficialPluginCatalog('b'.repeat(64), {});
    expect(findOfficialPlugin('sample')).toBeUndefined();
    expect(Object.keys(OFFICIAL_PLUGINS)).toEqual([]);
  });
  it('reads external atomic changes and isolates a damaged optional catalog', () => {
    replaceOfficialPluginCatalog('a'.repeat(64), { sample: declaration });
    const path = join(directory, '.official-catalog.json');
    const data = JSON.parse(readFileSync(path, 'utf8')); data.plugins.second = { ...declaration, skill: 'second' };
    writeFileSync(path, JSON.stringify(data));
    expect(listOfficialPluginNames()).toEqual(['sample', 'second']);
    writeFileSync(path, '{damaged');
    expect(() => readOfficialPluginCatalog()).toThrow();
    expect(listOfficialPluginNames()).toEqual([]);
    expect(findOfficialPlugin('sample')).toBeUndefined();
    expect(listPluginNames()).toEqual([]);
  });
  it('rejects invalid catalog input before replacing the previous selection', () => {
    replaceOfficialPluginCatalog('a'.repeat(64), { sample: declaration });
    for (const item of [ { ...declaration, installArgs: [] }, { ...declaration, installArgs: ['bad\narg'] }, { ...declaration, skill: '../escape' }, { ...declaration, setup: '../escape' }, { ...declaration, source: 'unknown' } ]) {
      expect(() => replaceOfficialPluginCatalog('b'.repeat(64), { sample: item })).toThrow();
    }
    expect(() => replaceOfficialPluginCatalog('latest', {})).toThrow();
    expect(() => replaceOfficialPluginCatalog('b'.repeat(64), { tab_open: declaration })).toThrow();
    expect(readOfficialPluginCatalog()?.revision).toBe('a'.repeat(64));
    expect(findOfficialPlugin('sample')).toEqual(declaration);
  });
});

it('binds generated aliases to the exact current local selection without removing registrations', () => {
  const pointer = join(directory, '.active-node.json');
  writeFileSync(pointer, '{"selection":"first"}');
  const selection = { path: pointer, sha256: createHash('sha256').update(readFileSync(pointer)).digest('hex') };
  replaceOfficialPluginCatalog('a'.repeat(64), { sample: declaration }, selection);
  expect(findOfficialPlugin('sample')).toEqual(declaration);
  writeFileSync(pointer, '{"selection":"second"}');
  expect(readOfficialPluginCatalog()).toBeUndefined();
  expect(findOfficialPlugin('sample')).toBeUndefined();
  expect(() => replaceOfficialPluginCatalog('b'.repeat(64), { sample: declaration }, selection)).toThrow('SELECTION_CHANGED');
  const persisted = JSON.parse(readFileSync(join(directory, '.official-catalog.json'), 'utf8'));
  expect(persisted.revision).toBe('a'.repeat(64));
  expect(listPluginNames()).toEqual([]);
});
