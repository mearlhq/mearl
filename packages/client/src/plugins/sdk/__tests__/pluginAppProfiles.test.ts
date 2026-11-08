import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findPluginRegistration,
  loadPlugin,
  refreshRegisteredPlugin,
  registerPlugin,
  unregisterPlugin,
} from '../plugin';

const definition = {
  name: 'sample',
  label: 'Sample Maps',
  appName: 'sample',
  defaultAppVersion: '13.8.0',
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
let root: string;
let entry: string;
const context = { options: {}, invoke: vi.fn(), progress: vi.fn() };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mearl-profile-plugin-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(root, 'registry'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'assets'));
  entry = join(root, 'scripts', 'main.mjs');
  writeFileSync(
    entry,
    `export const name = 'maps'; export const appProfiles = { version: 1, profiles: ['assets/sample.json'] };`,
  );
  writeFileSync(join(root, 'assets', 'sample.json'), JSON.stringify(definition));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('profile-only plugins', () => {
  it('registers metadata without commands and refreshes referenced JSON independently of the entry', async () => {
    const loaded = await loadPlugin(entry, context);
    registerPlugin('maps', entry, loaded.description, loaded);
    const previous = findPluginRegistration('maps')!;
    expect(previous.appProfiles?.profiles[0].label).toBe('Sample Maps');
    writeFileSync(
      join(root, 'assets', 'sample.json'),
      JSON.stringify({ ...definition, label: 'Updated Sample Maps' }),
    );
    const updated = await refreshRegisteredPlugin('maps');
    expect(updated?.appProfiles?.profiles[0].label).toBe('Updated Sample Maps');
    expect(previous.appProfiles?.profiles[0].label).toBe('Sample Maps');
    expect(context.invoke).not.toHaveBeenCalled();
    expect(unregisterPlugin('maps')).toBe(true);
    expect(findPluginRegistration('maps')).toBeUndefined();
    expect(previous.appProfiles?.profiles[0].label).toBe('Sample Maps');
  });
  it('loads a Python profile-only contribution without a register function', async () => {
    const python = join(root, 'scripts', 'main.py');
    writeFileSync(
      python,
      `name = 'maps'\nappProfiles = ${JSON.stringify({ version: 1, profiles: [definition] })}\n`,
    );
    const loaded = await loadPlugin(python, context);
    expect(loaded.appProfiles?.profiles[0].name).toBe('sample');
  });
  it('keeps the last valid registration if an updated definition is invalid', async () => {
    const loaded = await loadPlugin(entry, context);
    registerPlugin('maps', entry, undefined, loaded);
    writeFileSync(join(root, 'assets', 'sample.json'), '{');
    await expect(refreshRegisteredPlugin('maps')).rejects.toThrow();
    expect(findPluginRegistration('maps')?.appProfiles?.profiles[0].label).toBe('Sample Maps');
  });
  it('rejects symlinks escaping the plugin root', async () => {
    writeFileSync(join(root, 'outside.json'), JSON.stringify(definition));
    const skill = join(root, 'skill');
    mkdirSync(join(skill, 'scripts'), { recursive: true });
    symlinkSync(join(root, 'outside.json'), join(skill, 'escaped.json'));
    const nested = join(skill, 'scripts', 'main.mjs');
    writeFileSync(nested, `export const appProfiles = { version: 1, profiles: ['escaped.json'] };`);
    await expect(loadPlugin(nested, context)).rejects.toThrow('inside the Skill');
  });
  it('does not accept empty ordinary plugins', async () => {
    writeFileSync(entry, 'export default () => {};');
    await expect(loadPlugin(entry, context)).rejects.toThrow('入口未注册任何命令');
  });
});
