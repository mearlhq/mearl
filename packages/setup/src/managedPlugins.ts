import { findPluginRegistration, readOfficialPluginCatalog, OFFICIAL_PLUGIN_MANAGER } from '@mearl/client/plugin';
import { installPlugins, uninstallPlugin } from './plugin.js';
import { runGlobalMearlSkillOperation } from './skills.js';
import { runCommand, type CommandRunner } from '@mearl/daemon-core';

export interface ManagedPluginOptions {
  env?: NodeJS.ProcessEnv;
  includeMearlSkill?: boolean;
  mearlSkillOperation?: 'install' | 'update';
  runCommand?: CommandRunner;
  writeLine?: (line: string) => void;
}
export interface ManagedPluginDependencies {
  readCatalog?: typeof readOfficialPluginCatalog;
  findPluginRegistration?: typeof findPluginRegistration;
  installPlugins?: typeof installPlugins;
  uninstallPlugin?: typeof uninstallPlugin;
  runSkillOperation?: typeof runGlobalMearlSkillOperation;
}

/** Only the selected preset's managed registrations participate in lifecycle updates. */
export async function installManagedPlugins(options: ManagedPluginOptions = {}, dependencies: ManagedPluginDependencies = {}): Promise<'installed' | 'skipped' | 'failed'> {
  const writeLine = options.writeLine ?? (line => console.error(line));
  try {
    const catalog = (dependencies.readCatalog ?? readOfficialPluginCatalog)();
    if (!catalog || Object.keys(catalog.plugins).length === 0) return 'skipped';
    const registrationFor = dependencies.findPluginRegistration ?? findPluginRegistration;
    const candidates = Object.entries(catalog.plugins).filter(([name]) => {
      const registration = registrationFor(name);
      if (registration && registration.managedBy !== OFFICIAL_PLUGIN_MANAGER) {
        writeLine(`${name} plugin: existing user registration kept.`); return false;
      }
      return true;
    });
    if (candidates.length === 0) return 'skipped';
    if (options.includeMearlSkill && !await (dependencies.runSkillOperation ?? runGlobalMearlSkillOperation)(options.mearlSkillOperation ?? 'install', {
      env: options.env, runCommand: options.runCommand, writeLine, yes: true,
    })) return 'failed';
    for (const [name, definition] of candidates) {
      const code = await (dependencies.installPlugins ?? installPlugins)([...definition.installArgs], options.runCommand ?? runCommand, { registrationManagedBy: OFFICIAL_PLUGIN_MANAGER, env: options.env });
      if (code !== 0) { writeLine(`${name} plugin: install failed (exit ${code}).`); return 'failed'; }
      if (registrationFor(name)?.managedBy !== OFFICIAL_PLUGIN_MANAGER) { writeLine(`${name} plugin: installation did not create its managed registration.`); return 'failed'; }
      writeLine(`${name} plugin: installed and registered.`);
    }
    return 'installed';
  } catch (error) { writeLine(`Managed plugin batch: ${error instanceof Error ? error.message : String(error)}; failed.`); return 'failed'; }
}

export async function uninstallManagedPlugins(options: ManagedPluginOptions = {}, dependencies: ManagedPluginDependencies = {}): Promise<'uninstalled' | 'skipped' | 'failed'> {
  const writeLine = options.writeLine ?? (line => console.error(line));
  try {
    const catalog = (dependencies.readCatalog ?? readOfficialPluginCatalog)();
    if (!catalog) return 'skipped';
    const registrationFor = dependencies.findPluginRegistration ?? findPluginRegistration;
    for (const name of Object.keys(catalog.plugins)) {
      const registration = registrationFor(name);
      if (!registration) continue;
      if (registration.managedBy !== OFFICIAL_PLUGIN_MANAGER) { writeLine(`${name} plugin: existing user registration kept.`); continue; }
      await (dependencies.uninstallPlugin ?? uninstallPlugin)(name, options.runCommand ?? runCommand, { preserveRegistrationsOutsideManager: OFFICIAL_PLUGIN_MANAGER, env: options.env });
      if (registrationFor(name)) { writeLine(`${name} plugin: uninstall did not clear its registration.`); return 'failed'; }
      writeLine(`${name} plugin: uninstalled.`);
    }
    if (options.includeMearlSkill && !await (dependencies.runSkillOperation ?? runGlobalMearlSkillOperation)('uninstall', { env: options.env, runCommand: options.runCommand, writeLine, yes: true })) return 'failed';
    return 'uninstalled';
  } catch (error) { writeLine(`Managed plugin batch: ${error instanceof Error ? error.message : String(error)}; failed.`); return 'failed'; }
}
