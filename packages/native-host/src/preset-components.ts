import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCommand, withOwnedCommands, type CommandRunner } from '@mearl/daemon-core';
import type { ResolvedComponent } from '@mearl/preset';
import { intersects, satisfies, valid, validRange } from 'semver';
import { PresetInstallationStore, claimPresetInstallation, type PresetComponentHostStatus, type PresetComponentStatus } from '@mearl/setup/preset';
import { inspectProviderPackage, installProviderPackage, parseProviderPackageSpec } from '@mearl/setup';
import { listInstalledProviders } from '@mearl/provider/host';
import { findPluginRegistration, OFFICIAL_PLUGIN_MANAGER, readOfficialPluginCatalog, replaceOfficialPluginCatalog, validateOfficialPluginCatalog, type OfficialPluginDefinition } from '@mearl/client/plugin';
import { AgentSkillManager } from './agent/skill-manager.js';
import { nativeCapabilities } from './native-capability-services.js';
import { nativeCapabilityDirectory } from './page-runtime-store.js';

/** Native Messaging stdout carries protocol frames; package diagnostics remain captured. */
export const runPresetProviderCommand: CommandRunner = (command, args, options) => runCommand(command, args, { ...options, tee: false, capture: true, timeoutMs: Math.min(options?.timeoutMs ?? 120_000, 120_000) });


function ordered(entries: Record<string, ResolvedComponent>): Array<[string, ResolvedComponent]> {
  const result: Array<[string, ResolvedComponent]> = [];
  const done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    done.add(id);
    const entry = entries[id];
    for (const dependency of entry.dependsOn ?? []) visit(dependency);
    result.push([id, entry]);
  };
  for (const [id, entry] of Object.entries(entries)) if (entry.enabled !== false) visit(id);
  return result;
}

function providerSpec(entry: ResolvedComponent): string {
  const parsed = parseProviderPackageSpec(entry.source!.replace(/^npm:/, ''));
  if (parsed.target !== 'latest' && !validRange(parsed.target) && !entry.version) throw new Error('Provider dist-tags require a preset version range');
  if (parsed.target !== 'latest' && validRange(parsed.target) && entry.version && !intersects(parsed.target, entry.version)) throw new Error('Provider source target conflicts with its preset version range');
  return `${parsed.packageName}@${parsed.target === 'latest' && entry.version ? entry.version : parsed.target}`;
}

function pluginNames(catalog: { plugins: Record<string, OfficialPluginDefinition> } | undefined, skill: string): string[] {
  return Object.entries(catalog?.plugins ?? {}).filter(([, plugin]) => plugin.skill === skill).map(([name]) => name);
}

export interface PresetComponentInstallerOptions {
  store?: PresetInstallationStore;
  skills?: AgentSkillManager;
  nodeStatus?: typeof nativeCapabilities.status;
  listProviders?: typeof listInstalledProviders;
  installProvider?: typeof installProviderPackage;
  ownerFile?: string;
  pluginCatalog?: () => unknown;
}

/** External commands are resumable side effects; readiness is always read from the installed assets. */
export class PresetComponentInstaller {
  private readonly store: PresetInstallationStore;
  private readonly skills: AgentSkillManager;
  private readonly nodeStatus: typeof nativeCapabilities.status;
  private readonly listProviders: typeof listInstalledProviders;
  private readonly installProvider: typeof installProviderPackage;
  private readonly ownerFile: string;
  private readonly pluginCatalog: () => unknown;

  constructor(options: PresetComponentInstallerOptions = {}) {
    this.store = options.store ?? new PresetInstallationStore({ directory: nativeCapabilityDirectory() });
    this.skills = options.skills ?? new AgentSkillManager();
    this.nodeStatus = options.nodeStatus ?? nativeCapabilities.status;
    this.listProviders = options.listProviders ?? listInstalledProviders;
    this.installProvider = options.installProvider ?? (source => installProviderPackage(source, { runCommand: runPresetProviderCommand }));
    this.pluginCatalog = options.pluginCatalog ?? (() => nativeCapabilities.require('plugins.catalog')());
    this.ownerFile = options.ownerFile ?? join(homedir(), '.agents', '.mearl-preset-install.json');
  }

  private async accepted(revision: string, verifyResources = false) {
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Expected a preset installation revision');
    const current = await this.store.current({ verifyResources });
    const host = this.nodeStatus();
    if (!current.receipt || !current.preset || current.receipt.revision !== revision || host.installationRevision !== revision || host.revision !== current.receipt.nodeRevision) throw new Error('PRESET_SELECTION_CHANGED');
    return { receipt: current.receipt, preset: current.preset, rawHash: current.rawHash!, hasCatalog: Boolean(current.activation?.bindings['plugins.catalog']) };
  }

  private catalog(current: Awaited<ReturnType<PresetComponentInstaller['accepted']>>) {
    if (!current.hasCatalog) return undefined;
    const value = this.pluginCatalog();
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200) throw new Error('INVALID_PLUGIN_CATALOG');
    const plugins: Array<[string, OfficialPluginDefinition]> = [];
    for (const [name, raw] of Object.entries(value)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['description', 'skill', 'setup'].includes(key))) throw new Error('INVALID_PLUGIN_CATALOG');
      const item = raw as { description: string; skill: string; setup?: string };
      if (typeof item.skill !== 'string' || !Object.hasOwn(current.preset.skills, item.skill)) throw new Error('PLUGIN_CATALOG_SKILL_UNDECLARED');
      const skill = current.preset.skills[item.skill];
      if (skill.enabled === false) continue;
      plugins.push([name, { ...item, installArgs: [skill.source!, '--skill', item.skill, '--yes'] }]);
    }
    return validateOfficialPluginCatalog({ schemaVersion: 1, revision: current.receipt.revision, plugins: Object.fromEntries(plugins), selection: { path: join(this.store.directory, 'active-node.json'), sha256: current.rawHash } });
  }

  private catalogReady(expected: NonNullable<ReturnType<PresetComponentInstaller['catalog']>>): boolean {
    try {
      if (JSON.stringify(readOfficialPluginCatalog()) !== JSON.stringify(expected)) return false;
      return Object.entries(expected.plugins).every(([name, declaration]) => {
        const entry = findPluginRegistration(name)?.entry;
        return entry !== undefined && resolve(dirname(dirname(entry))) === resolve(homedir(), '.agents', 'skills', declaration.skill);
      });
    } catch { return false; }
  }

  private providerStatus(id: string, entry: ResolvedComponent): PresetComponentStatus {
    try { providerSpec(entry); }
    catch { return { kind: 'providers', id, state: 'conflict', reason: 'PROVIDER_VERSION_UNVERIFIABLE' }; }
    const { packageName, target } = parseProviderPackageSpec(entry.source!.replace(/^npm:/, ''));
    const installed = this.listProviders();
    if (installed.some(provider => (provider.providerId === id && provider.packageName !== packageName) || (provider.packageName === packageName && provider.providerId !== id))) return { kind: 'providers', id, state: 'conflict', reason: 'PROVIDER_SOURCE_CONFLICT' };
    const matching = installed.filter(provider => provider.providerId === id && provider.packageName === packageName);
    if (matching.length > 1) return { kind: 'providers', id, state: 'conflict', reason: 'PROVIDER_REGISTRATION_AMBIGUOUS' };
    const manifest = matching[0];
    if (!manifest || !inspectProviderPackage(manifest)) return { kind: 'providers', id, state: 'pending', reason: 'PROVIDER_INSTALL_REQUIRED' };
    if (target !== 'latest' && !validRange(target) && !entry.version) return { kind: 'providers', id, state: 'conflict', reason: 'PROVIDER_VERSION_UNVERIFIABLE' };
    const ranges = [entry.version, ...(target !== 'latest' && validRange(target) ? [target] : [])].filter((range): range is string => range !== undefined);
    if (ranges.some(range => !valid(manifest.version) || !satisfies(manifest.version, range))) return { kind: 'providers', id, state: 'pending', reason: 'PROVIDER_VERSION_REQUIRED' };
    return { kind: 'providers', id, state: 'ready' };
  }

  private skillStatus(manager: AgentSkillManager, id: string, entry: ResolvedComponent, catalog?: ReturnType<PresetComponentInstaller['catalog']>): PresetComponentStatus {
    const status = manager.inspectGlobal(entry.source!, id, entry.version, entry.migrateFrom);
    const aliases = pluginNames(catalog, id);
    if (status.state !== 'conflict' && manager.hasGlobalRegistrationConflict(id, aliases)) return { kind: 'skills', id, state: 'conflict', reason: 'SKILL_PLUGIN_REGISTRATION_CONFLICT' };
    return { kind: 'skills', id, state: status.state === 'ready' ? 'ready' : status.state === 'conflict' ? 'conflict' : 'pending', ...(status.reason ? { reason: status.reason } : {}) };
  }

  async status(revision: string): Promise<PresetComponentHostStatus> {
    const current = await this.accepted(revision);
    const { receipt, preset } = current;
    const catalog = this.catalog(current);
    const manager = this.skills.capture();
    const components = [
      ...ordered(preset.providers).map(([id, entry]) => this.providerStatus(id, entry)),
      ...ordered(preset.skills).map(([id, entry]) => this.skillStatus(manager, id, entry, catalog)),
    ];
    await this.accepted(revision);
    return { installationRevision: revision, nodeRevision: receipt.nodeRevision, components, ...(catalog ? { catalogReady: this.catalogReady(catalog) } : {}) };
  }

  async install(revision: string, options: { replaceSkills?: readonly string[] } = {}): Promise<PresetComponentHostStatus> {
    const lease = claimPresetInstallation(this.ownerFile);
    try {
      return await withOwnedCommands(lease.lifecycle, async () => {
      const current = await this.accepted(revision, true);
      const { preset } = current;
      const catalog = this.catalog(current);
      const manager = this.skills.capture();
      const providers = ordered(preset.providers);
      const skills = ordered(preset.skills);
      const expectedPluginNames: Record<string, readonly string[]> = Object.create(null);
      for (const [id] of skills) {
        const names = pluginNames(catalog, id);
        if (names.length) expectedPluginNames[id] = names;
      }
      if (options.replaceSkills !== undefined && (!Array.isArray(options.replaceSkills) || !options.replaceSkills.length || options.replaceSkills.length > 256 || new Set(options.replaceSkills).size !== options.replaceSkills.length || options.replaceSkills.some(id => typeof id !== 'string' || !skills.some(([name]) => name === id)))) throw new Error('INVALID_SKILL_REPLACEMENT_SELECTION');
      const replaceable = (id: string, status: { reason?: string }) => (status.reason === 'SKILL_SOURCE_CONFLICT' || status.reason === 'SKILL_PLUGIN_REGISTRATION_CONFLICT') && options.replaceSkills?.includes(id);
      // Unconfirmed source conflicts stop the batch before any external installation.
      for (const [id, entry] of providers) {
        providerSpec(entry);
        if (this.providerStatus(id, entry).state === 'conflict') throw new Error(`PROVIDER_SOURCE_CONFLICT: ${id}`);
      }
      for (const [id, entry] of skills) {
        const status = this.skillStatus(manager, id, entry, catalog);
        if (status.state === 'conflict' && !replaceable(id, status)) throw new Error(`${status.reason}: ${id}`);
      }
      for (const [id, entry] of providers) {
        await this.accepted(revision);
        const status = this.providerStatus(id, entry);
        if (status.state === 'conflict') throw new Error(`${status.reason}: ${id}`);
        if (status.state === 'ready') continue;
        await this.accepted(revision);
        await this.installProvider(providerSpec(entry));
        await this.accepted(revision);
        const installed = this.providerStatus(id, entry);
        if (installed.state !== 'ready') throw new Error(`${installed.reason}: ${id}`);
      }
      for (let index = 0; index < skills.length;) {
        await this.accepted(revision);
        const [id, entry] = skills[index];
        const source = entry.source!;
        const first = manager.inspectGlobal(source, id, entry.version, entry.migrateFrom);
        if (first.state === 'conflict' && !replaceable(id, first)) throw new Error(`${first.reason}: ${id}`);
        if (first.state === 'ready') { index++; continue; }
        if (first.state === 'registration') {
          await this.accepted(revision);
          await manager.repairGlobalRegistration(id, { registrationManagedBy: OFFICIAL_PLUGIN_MANAGER, replaceExisting: options.replaceSkills?.includes(id), expectedPluginNames: expectedPluginNames[id] });
          if (manager.inspectGlobal(source, id, entry.version).state !== 'ready') throw new Error(`SKILL_PLUGIN_REGISTRATION_REQUIRED: ${id}`);
          index++;
          continue;
        }
        const group: Array<[string, ResolvedComponent]> = [[id, entry]];
        index++;
        while (group.length < 256 && index < skills.length && skills[index][1].source === source) {
          const [nextId, next] = skills[index];
          if (next.dependsOn?.some(dependency => group.some(([groupId]) => dependency === groupId))) break;
          const status = manager.inspectGlobal(source, nextId, next.version, next.migrateFrom);
          if (status.state !== 'missing' && status.state !== 'version' && status.state !== 'migration' && !replaceable(nextId, status)) break;
          group.push([nextId, next]); index++;
        }
        await this.accepted(revision);
        await manager.installGlobals(source, group.map(([name]) => name), { registrationManagedBy: OFFICIAL_PLUGIN_MANAGER, migrateFrom: Object.fromEntries(group.map(([id, entry]) => [id, entry.migrateFrom ?? []])), expectedPluginNames, ...(options.replaceSkills?.length ? { replaceSkills: group.map(([name]) => name).filter(name => options.replaceSkills!.includes(name)) } : {}) });
        await this.accepted(revision);
        for (const [id, entry] of group) {
          const status = manager.inspectGlobal(source, id, entry.version);
          if (status.state !== 'ready') throw new Error(`${status.reason}: ${id}`);
        }
      }
      if (catalog) {
        await this.accepted(revision);
        replaceOfficialPluginCatalog(catalog.revision, catalog.plugins, catalog.selection);
      }
      return await this.status(revision);
      });
    } finally { lease.release(); }
  }
}
