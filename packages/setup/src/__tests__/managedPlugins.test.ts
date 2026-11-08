import { describe, expect, it, vi } from 'vitest';
import { OFFICIAL_PLUGIN_MANAGER, type PluginRegistration } from '@mearl/client/plugin';
import { installManagedPlugins, uninstallManagedPlugins } from '../managedPlugins.js';

function fixture() {
  const plugins = Object.fromEntries(['first', 'second'].map(name => [name, { description: name, skill: name, installArgs: ['https://example.com/skills', '--skill', name, '--yes'] }]));
  const registrations = new Map<string, PluginRegistration>();
  const readCatalog = vi.fn(() => ({ schemaVersion: 1 as const, revision: 'a'.repeat(64), plugins }));
  const findPluginRegistration = vi.fn((name: string) => registrations.get(name));
  const installPlugins = vi.fn(async (args: string[]) => {
    const name = args[2]; registrations.set(name, { entry: `/skills/${name}/scripts/main.mjs`, managedBy: OFFICIAL_PLUGIN_MANAGER }); return 0;
  });
  const uninstallPlugin = vi.fn(async (name: string) => { registrations.delete(name); return { removed: true, unregisteredNames: [name] }; });
  const runSkillOperation = vi.fn(async () => true);
  const options = { includeMearlSkill: true, mearlSkillOperation: 'update' as const, writeLine: vi.fn() };
  return { registrations, options, deps: { readCatalog, findPluginRegistration, installPlugins, uninstallPlugin, runSkillOperation } };
}

describe('selected preset plugin lifecycle', () => {
  it('skips when no catalog is selected', async () => {
    const { options, deps } = fixture();
    await expect(installManagedPlugins(options, { ...deps, readCatalog: () => undefined })).resolves.toBe('skipped');
    expect(deps.installPlugins).not.toHaveBeenCalled(); expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });
  it('updates owned plugins, repairs missing registrations and keeps user registrations', async () => {
    const { registrations, options, deps } = fixture();
    registrations.set('first', { entry: '/user/first.mjs' });
    await expect(installManagedPlugins(options, deps)).resolves.toBe('installed');
    expect(registrations.get('first')?.entry).toBe('/user/first.mjs');
    expect(deps.installPlugins).toHaveBeenCalledOnce();
    expect(deps.installPlugins.mock.calls[0][0][2]).toBe('second');
    expect(deps.runSkillOperation).toHaveBeenCalledExactlyOnceWith('update', expect.objectContaining({ yes: true }));
    expect(registrations.get('second')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
  });
  it('does not report ready when installation returns success without the expected registration', async () => {
    const { options, deps } = fixture();
    deps.installPlugins.mockImplementation(async () => 0);
    await expect(installManagedPlugins(options, deps)).resolves.toBe('failed');
    expect(options.writeLine).toHaveBeenCalledWith(expect.stringContaining('did not create'));
  });
  it('preserves user-owned registrations when all entries were installed separately', async () => {
    const { registrations, options, deps } = fixture();
    for (const name of ['first','second']) registrations.set(name, { entry: `/user/${name}.mjs` });
    await expect(installManagedPlugins(options, deps)).resolves.toBe('skipped');
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });
  it('reports damaged catalog data and installer failures without claiming completion', async () => {
    const { options, deps } = fixture();
    await expect(installManagedPlugins(options, { ...deps, readCatalog: () => { throw new Error('corrupt catalog'); } })).resolves.toBe('failed');
    deps.installPlugins.mockResolvedValue(1);
    await expect(installManagedPlugins(options, deps)).resolves.toBe('failed');
  });
  it('uninstalls only managed registrations and removes the shared Skill once', async () => {
    const { registrations, options, deps } = fixture();
    registrations.set('first', { entry: '/managed/first.mjs', managedBy: OFFICIAL_PLUGIN_MANAGER });
    registrations.set('second', { entry: '/user/second.mjs' });
    await expect(uninstallManagedPlugins(options, deps)).resolves.toBe('uninstalled');
    expect(deps.uninstallPlugin).toHaveBeenCalledOnce(); expect(registrations.has('first')).toBe(false); expect(registrations.has('second')).toBe(true);
    expect(deps.runSkillOperation).toHaveBeenCalledExactlyOnceWith('uninstall', expect.objectContaining({ yes: true }));
  });
  it('does not remove the shared Skill after an incomplete plugin uninstall', async () => {
    const { registrations, options, deps } = fixture();
    registrations.set('first', { entry: '/managed/first.mjs', managedBy: OFFICIAL_PLUGIN_MANAGER });
    deps.uninstallPlugin.mockImplementation(async () => ({ removed: false, unregisteredNames: [] }));
    await expect(uninstallManagedPlugins(options, deps)).resolves.toBe('failed');
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });
});
