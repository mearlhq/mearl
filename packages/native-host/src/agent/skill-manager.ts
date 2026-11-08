import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  AgentSkillCheckUpdatesResult,
  AgentSkillCheckUpdatesOptions,
  AgentSkillInstallOptions,
  AgentSkillMutationOptions,
  AgentSkillMutationResult,
  AgentSkillProviderId,
  AgentSkillScope,
} from '@mearl/browser-core';
import { resolveSkillsInvocation, stripAnsi } from '@mearl/setup/skills';
import { checkTrackedSkillUpdates, readTrackedSkillSources, isPublicSkillSource, inspectGlobalSkill, preserveSkillDisabled, type SkillInstallationStatus } from '@mearl/setup/skill-sources';
import { nativeCapabilities } from '../native-capability-services.js';
import { runCommand } from '@mearl/daemon-core';
import {
  findPluginDirectoryEntry,
  findPluginRegistration,
  listPluginNames,
  loadPlugin,
  OFFICIAL_PLUGIN_MANAGER,
  registerPlugin,
  unregisterPlugin,
  skillManifestPath,
} from '@mearl/client/plugin';
import { resolveWorkspaceDirectory } from './workspace-directory.js';

const SKILL_PLUGIN_MANAGER = 'skills';

const registrationContext = {
  options: {},
  invoke: async () => {
    throw new Error('注册时不能执行浏览器操作');
  },
  progress: () => {
    throw new Error('注册时不能报告执行进度');
  },
};

function installedSkillDirectory(name: string, scope: AgentSkillScope, cwd?: string): string {
  return join(scope === 'global' ? homedir() : cwd!, '.agents', 'skills', name);
}

function canonicalDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return resolve(directory);
  }
}

function registrationConflicts(directory: string, existing: ReturnType<typeof findPluginRegistration>, manager: string): boolean {
  if (!existing) return false;
  const registered = dirname(dirname(existing.entry));
  return existing.managedBy === manager
    ? resolve(registered) !== resolve(directory)
    : canonicalDirectory(registered) !== canonicalDirectory(directory);
}

function registeredNamesForSkill(directory: string): string[] {
  const installedDirectory = resolve(directory);
  return listPluginNames().filter(name => {
    const entry = findPluginRegistration(name)?.entry;
    return entry !== undefined && resolve(dirname(dirname(entry))) === installedDirectory;
  });
}

async function registerInstalledSkillPlugin(
  directory: string,
  skillName: string,
  manager = SKILL_PLUGIN_MANAGER,
  registrationManagedBy?: string,
  replaceExisting = false,
  expectedPluginNames?: readonly string[],
): Promise<string | undefined> {
  if (!skillManifestPath(directory)) {
    throw new Error(`Skill 安装完成但找不到安装目录: ${directory}`);
  }
  const entry = findPluginDirectoryEntry(directory);
  const aliases = registeredNamesForSkill(directory);
  const managed = registrationManagedBy === OFFICIAL_PLUGIN_MANAGER;
  const presetOwned = aliases.some(alias => findPluginRegistration(alias)?.managedBy === OFFICIAL_PLUGIN_MANAGER);
  if (!entry) {
    for (const name of aliases) {
      if ((!managed && !presetOwned) || findPluginRegistration(name)?.managedBy === OFFICIAL_PLUGIN_MANAGER) unregisterPlugin(name);
    }
    return undefined;
  }
  const plugin = await loadPlugin(entry, registrationContext);
  const name = plugin.name || skillName;
  if (expectedPluginNames && !expectedPluginNames.includes(name)) throw new Error(`SKILL_PLUGIN_NAME_CONFLICT: ${skillName}`);
  const existing = findPluginRegistration(name);
  const replacingRegistration = registrationConflicts(directory, existing, manager);
  if (replacingRegistration && !replaceExisting) {
    throw new Error(`插件 ${name} 已由其他 Skill 注册，无法自动覆盖`);
  }
  if (managed && !presetOwned && !replaceExisting && aliases.some(alias => alias !== name && findPluginRegistration(alias)?.managedBy !== registrationManagedBy)) {
    throw new Error(`SKILL_USER_PLUGIN_ALIAS_CONFLICT: ${skillName}`);
  }
  if (plugin.setup) {
    const registrations = () => JSON.stringify([findPluginRegistration(name), registeredNamesForSkill(directory).map(alias => findPluginRegistration(alias))]);
    const before = registrations();
    await plugin.setup({ runCommand });
    if (!skillManifestPath(directory) || findPluginDirectoryEntry(directory) !== entry || registrations() !== before) {
      throw new Error(`SKILL_PLUGIN_REGISTRATION_CHANGED: ${skillName}`);
    }
  }
  // Ownership follows an existing preset registration across refreshes and exported-name changes.
  const managedBy = (managed || presetOwned) && existing && !replacingRegistration
    ? existing.managedBy
    : presetOwned
      ? OFFICIAL_PLUGIN_MANAGER
      : registrationManagedBy ?? manager;
  registerPlugin(name, entry, plugin.description, {
    managedBy,
    ...(plugin.toolbox ? { toolbox: plugin.toolbox } : {}),
    appProfiles: plugin.appProfiles,
    profileSources: plugin.profileSources,
  });
  for (const alias of aliases) {
    if (alias !== name && ((!managed && !presetOwned) || findPluginRegistration(alias)?.managedBy === OFFICIAL_PLUGIN_MANAGER)) unregisterPlugin(alias);
  }
  return name;
}

export type SkillCliRunner = (executable: string, args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;
export type SkillBackendBatchOptions = Omit<AgentSkillInstallOptions, 'name' | 'providerId'> & { names: string[]; providerId?: AgentSkillProviderId };
/** A preset supplies CLI behavior; directory state and plugin registration stay in the host. */
export interface AgentSkillBackend {
  id: string;
  install(data: AgentSkillInstallOptions): ReturnType<SkillCliRunner>;
  installBatch?(data: SkillBackendBatchOptions): ReturnType<SkillCliRunner>;
  normalizeSource?(source: string, sourceType?: string): string;
  readSources?: typeof readTrackedSkillSources;
  update(data: AgentSkillMutationOptions): ReturnType<SkillCliRunner>;
  uninstall(data: AgentSkillMutationOptions): ReturnType<SkillCliRunner>;
  checkUpdates(data: AgentSkillCheckUpdatesOptions): Promise<AgentSkillCheckUpdatesResult>;
}
export const runSkillCli: SkillCliRunner = async (executable, args, cwd) => {
  const invocation = resolveSkillsInvocation();
  const result = await runCommand(executable, args, { cwd, capture: true, env: invocation?.env, timeoutMs: 120_000 });
  const detail = stripAnsi(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || /Failed to (?:update|remove)\s+[1-9]\d*\s+skills?/i.test(detail)) throw new Error(detail.trim() || 'Skills operation failed');
  return { stdout: result.stdout, stderr: result.stderr };
};
function runResolvedSkillCli(run: SkillCliRunner, args: string[], cwd?: string) {
  const invocation = resolveSkillsInvocation();
  if (!invocation) throw new Error('Skills CLI and npx are unavailable');
  return run(invocation.command, [...invocation.argsPrefix, ...args], cwd);
}

export interface AgentSkillManagerOptions {
  run?: SkillCliRunner;
  checkUpdates?: typeof checkTrackedSkillUpdates;
  readSources?: typeof readTrackedSkillSources;
  backend?: () => AgentSkillBackend | undefined;
}

export type { SkillInstallationStatus } from '@mearl/setup/skill-sources';

function validateProvider(value: unknown): AgentSkillProviderId {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error('Skill provider must be a valid agent ID');
  }
  return value;
}

function validateScope(value: unknown): AgentSkillScope {
  if (value !== 'project' && value !== 'global') {
    throw new Error('Skill scope must be project or global');
  }
  return value;
}

function validateArgument(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function validateSkillName(value: unknown): string {
  const name = validateArgument(value, 'Skill name');
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('Skill name is invalid');
  }
  return name;
}

function scopeCwd(scope: AgentSkillScope, cwd: unknown): string | undefined {
  if (scope === 'global') return undefined;
  return resolveWorkspaceDirectory(cwd);
}

export class AgentSkillManager {
  private readonly run: SkillCliRunner;
  private readonly check: typeof checkTrackedSkillUpdates;
  private readonly sources: typeof readTrackedSkillSources;
  private readonly selectedBackend: () => AgentSkillBackend | undefined;

  constructor(options: AgentSkillManagerOptions = {}) {
    this.run = options.run ?? runSkillCli;
    this.check = options.checkUpdates ?? checkTrackedSkillUpdates;
    this.sources = options.readSources ?? readTrackedSkillSources;
    this.selectedBackend = options.backend ?? (() => nativeCapabilities.get('skills.manager')?.());
  }

  private backend(expectedManagerId?: string): AgentSkillBackend | undefined {
    const backend = this.selectedBackend();
    if (backend && (typeof backend.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(backend.id) || ['install', 'update', 'uninstall', 'checkUpdates'].some(key => typeof backend[key as keyof AgentSkillBackend] !== 'function'))) throw new Error('Invalid Skill manager backend');
    if (backend?.installBatch !== undefined && typeof backend.installBatch !== 'function') throw new Error('Invalid Skill batch installer');
    if (backend?.readSources !== undefined && typeof backend.readSources !== 'function') throw new Error('Invalid Skill source reader');
    if (backend?.normalizeSource !== undefined && typeof backend.normalizeSource !== 'function') throw new Error('Invalid Skill source normalizer');
    if (expectedManagerId !== undefined && (typeof expectedManagerId !== 'string' || expectedManagerId !== (backend?.id ?? SKILL_PLUGIN_MANAGER))) throw new Error('SKILL_MANAGER_CHANGED');
    return backend;
  }

  /** A preset batch keeps one accepted manager for all of its operations. */
  capture(): AgentSkillManager {
    const backend = this.backend();
    return new AgentSkillManager({ run: this.run, readSources: this.sources, checkUpdates: this.check, backend: () => backend });
  }

  inspectGlobal(source: string, name: string, version?: string, migrateFrom?: readonly string[]): SkillInstallationStatus {
    const acceptedSource = validateArgument(source, 'Skill source');
    const acceptedName = validateSkillName(name);
    const backend = this.backend();
    return inspectGlobalSkill(acceptedSource, acceptedName, version, { migrateFrom, readSources: backend?.readSources ?? this.sources, externalManager: backend !== undefined, normalizeSource: backend?.normalizeSource });
  }

  hasGlobalRegistrationConflict(name: string, aliases: readonly string[]): boolean {
    const directory = installedSkillDirectory(validateSkillName(name), 'global');
    const manager = this.backend()?.id ?? SKILL_PLUGIN_MANAGER;
    return aliases.some(alias => registrationConflicts(directory, findPluginRegistration(alias), manager));
  }

  async repairGlobalRegistration(name: string, options: { registrationManagedBy?: string; replaceExisting?: boolean; expectedPluginNames?: readonly string[] } = {}): Promise<void> {
    const acceptedName = validateSkillName(name);
    const backend = this.backend();
    const directory = installedSkillDirectory(acceptedName, 'global');
    await registerInstalledSkillPlugin(directory, acceptedName, backend?.id ?? SKILL_PLUGIN_MANAGER, options.registrationManagedBy, options.replaceExisting, options.expectedPluginNames);
  }

  async install(data: AgentSkillInstallOptions): Promise<AgentSkillMutationResult> {
    const { providerId, scope, cwd } = this.mutationContext(data);
    const source = validateArgument(data.source, 'Skill source');
    const name = validateSkillName(data.name);
    const backend = this.backend(data.expectedManagerId);
    return this.installAccepted({ providerId, scope, cwd, name, source }, backend);
  }

  async installGlobal(source: string, name: string): Promise<AgentSkillMutationResult> {
    return this.installGlobals(source, [name]);
  }

  async installGlobals(source: string, names: string[], options: { registrationManagedBy?: string; migrateFrom?: Readonly<Record<string, readonly string[]>>; replaceSkills?: readonly string[]; expectedPluginNames?: Readonly<Record<string, readonly string[]>> } = {}): Promise<AgentSkillMutationResult> {
    const acceptedSource = validateArgument(source, 'Skill source');
    if (!Array.isArray(names) || !names.length || names.length > 256) throw new Error('Expected 1–256 Skill names');
    const acceptedNames = names.map(validateSkillName);
    if (new Set(acceptedNames).size !== acceptedNames.length) throw new Error('Duplicate Skill names');
    if (options.replaceSkills?.some(name => !acceptedNames.includes(name))) throw new Error('Invalid Skill replacement selection');
    const backend = this.backend();
    if (backend && !backend.installBatch) {
      throw new Error('The selected Skill manager requires a preset update for batch installation');
    }
    const assertSources = () => {
      if (options.registrationManagedBy !== OFFICIAL_PLUGIN_MANAGER) return;
      for (const name of acceptedNames) {
        const status = this.inspectGlobal(acceptedSource, name, undefined, options.migrateFrom?.[name]);
        if (status.state === 'conflict' && !(status.reason === 'SKILL_SOURCE_CONFLICT' && options.replaceSkills?.includes(name))) throw new Error(`${status.reason}: ${name}`);
      }
    };
    assertSources();
    let install = async () => {
      assertSources();
      return backend
      ? backend.installBatch!({ source: acceptedSource, names: acceptedNames, scope: 'global' })
      : runResolvedSkillCli(this.run, ['add', acceptedSource, '--skill', ...acceptedNames, '--global', '--full-depth', '--yes']);
    };
    for (const name of acceptedNames) {
      const operation = install;
      install = () => preserveSkillDisabled(installedSkillDirectory(name, 'global'), operation);
    }
    const output = await install();
    for (const name of acceptedNames) await registerInstalledSkillPlugin(installedSkillDirectory(name, 'global'), name, backend?.id ?? SKILL_PLUGIN_MANAGER, options.registrationManagedBy, options.replaceSkills?.includes(name), options.expectedPluginNames && Object.hasOwn(options.expectedPluginNames, name) ? options.expectedPluginNames[name] : undefined);
    return { ok: true, output: stripAnsi(output.stdout || output.stderr).trim() };
  }

  private async installAccepted(data: AgentSkillInstallOptions, backend: AgentSkillBackend | undefined): Promise<AgentSkillMutationResult> {
    const { providerId, scope, cwd, name, source } = data;
    const args = [
      'add',
      source,
      '--skill',
      name,
      ...(providerId ? ['--agent', providerId] : []),
      ...(scope === 'global' ? ['--global'] : []),
      '--full-depth',
      '--yes',
    ];
    const directory = installedSkillDirectory(name, scope, cwd);
    const output = await preserveSkillDisabled(directory, () =>
      backend ? backend.install(data) : runResolvedSkillCli(this.run, args, cwd),
    );
    await registerInstalledSkillPlugin(directory, name, backend?.id ?? SKILL_PLUGIN_MANAGER);
    return { ok: true, output: stripAnsi(output.stdout || output.stderr).trim() };
  }

  async checkUpdates(data: AgentSkillCheckUpdatesOptions): Promise<AgentSkillCheckUpdatesResult> {
    validateProvider(data.providerId);
    const cwd = data.cwd !== undefined && data.cwd !== null && data.cwd !== '' ? resolveWorkspaceDirectory(data.cwd) : undefined;
    const backend = this.backend();
    if (backend) return backend.checkUpdates({ providerId: data.providerId, cwd });
    return { updates: await this.check({ cwd }) };
  }

  async update(data: AgentSkillMutationOptions): Promise<AgentSkillMutationResult> {
    const { providerId, scope, cwd } = this.mutationContext(data);
    const name = validateSkillName(data.name);
    const backend = this.backend(data.expectedManagerId);
    const tracked = backend ? undefined : this.sources(scope, cwd).find(source => source.name === name);
    if (!backend && !tracked) throw new Error(`Skill source is not tracked: ${name}`);
    if (tracked && !isPublicSkillSource(tracked)) throw new Error('Installed Skill requires an external manager. Enable its preset.');
    const source = tracked?.ref ? `${tracked.source.replace(/#.*$/, '')}#${tracked.ref}` : tracked?.source ?? '';
    const args = ['add', source, '--skill', name, '--agent', data.providerId, ...(scope === 'global' ? ['--global'] : []), '--full-depth', '--yes'];
    const directory = installedSkillDirectory(name, scope, cwd);
    const registeredNames = registeredNamesForSkill(directory);
    const output = await preserveSkillDisabled(directory, () =>
      backend ? backend.update({ providerId, scope, cwd, name }) : runResolvedSkillCli(this.run, args, cwd),
    );
    if (skillManifestPath(directory)) {
      await registerInstalledSkillPlugin(directory, name, backend?.id ?? SKILL_PLUGIN_MANAGER);
    } else {
      for (const pluginName of registeredNames) unregisterPlugin(pluginName);
    }
    return { ok: true, output: stripAnsi(output.stdout || output.stderr).trim() };
  }

  async uninstall(data: AgentSkillMutationOptions): Promise<AgentSkillMutationResult> {
    const { providerId, scope, cwd } = this.mutationContext(data);
    const name = validateSkillName(data.name);
    const backend = this.backend(data.expectedManagerId);
    const tracked = backend ? undefined : this.sources(scope, cwd).find(source => source.name === name);
    if (tracked && !isPublicSkillSource(tracked)) throw new Error('Installed Skill requires an external manager. Enable its preset.');
    const args = [
      'remove',
      name,
      '--agent',
      providerId,
      ...(scope === 'global' ? ['--global'] : []),
      '--yes',
    ];
    const directory = installedSkillDirectory(name, scope, cwd);
    const registeredNames = registeredNamesForSkill(directory);
    const output = backend ? await backend.uninstall({ providerId, scope, cwd, name }) : await runResolvedSkillCli(this.run, args, cwd);
    if (!existsSync(directory)) {
      for (const pluginName of registeredNames) unregisterPlugin(pluginName);
    }
    return { ok: true, output: stripAnsi(output.stdout || output.stderr).trim() };
  }

  private mutationContext(data: AgentSkillMutationOptions): {
    providerId: AgentSkillProviderId;
    scope: AgentSkillScope;
    cwd?: string;
  } {
    const providerId = validateProvider(data.providerId);
    const scope = validateScope(data.scope);
    const cwd = scopeCwd(scope, data.cwd);
    return { providerId, scope, ...(cwd ? { cwd } : {}) };
  }
}
