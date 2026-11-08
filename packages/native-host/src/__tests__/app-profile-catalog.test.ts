import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPlugin, registerPlugin, unregisterPlugin } from '@mearl/client/plugin';
import { listInstalledAppProfiles, resolveInstalledAppProfile } from '../app-profile-catalog';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-profile-catalog-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('installed app profile catalog', () => {
  it('namespaces installed definitions and keeps pinned snapshots after uninstall', async () => {
    const entry = join(directory, 'scripts', 'main.mjs');
    mkdirSync(join(directory, 'scripts'));
    const profile = {
      name: 'sample',
      label: 'Custom Sample Maps',
      appName: 'sample',
      defaultAppVersion: '14.2.0',
      uaTokens: [],
      globals: {},
      bridges: [{ global: 'MapApp.bridge', style: 'sample' }],
      activeEvents: [],
      actions: {
        open: ['loadSchema'],
        close: [],
        title: ['setWebViewTitle'],
        systemInfo: [],
        protocol: [],
        noop: [],
      },
      schemes: [],
    };
    writeFileSync(
      entry,
      `export const appProfiles = ${JSON.stringify({ version: 1, profiles: [profile] })};`,
    );
    const loaded = await loadPlugin(entry, { options: {}, invoke: vi.fn(), progress: vi.fn() });
    registerPlugin('maps', entry, undefined, loaded);
    writeFileSync(entry, 'throw new Error("Discovery must not evaluate plugin source");');
    const snapshot = await listInstalledAppProfiles({ refresh: false });
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.profiles.map(item => item.id)).toEqual(['maps/sample']);
    writeFileSync(entry, `export const appProfiles = ${JSON.stringify({ version: 1, profiles: [profile] })};`);
    const catalog = await listInstalledAppProfiles();
    expect(catalog.errors).toEqual([]);
    expect(catalog.profiles.find(item => item.id === 'maps/sample')).toMatchObject({
      source: 'plugin',
      plugin: 'maps',
    });
    expect(catalog.profiles.find(item => item.id === 'sample')).toBeUndefined();
    const resolved = await resolveInstalledAppProfile('maps/sample');
    unregisterPlugin('maps');
    expect((await listInstalledAppProfiles({ refresh: false })).profiles).toEqual([]);
    await expect(resolveInstalledAppProfile('maps/sample')).rejects.toThrow('unavailable');
    expect(resolved.injected.binding?.definition.defaultAppVersion).toBe('14.2.0');
  });
  it('requires a capability before any App can be activated', async () => {
    expect((await listInstalledAppProfiles()).profiles).toEqual([]);
    await expect(resolveInstalledAppProfile('shop')).rejects.toThrow('Install an App simulation capability');
  });
});
