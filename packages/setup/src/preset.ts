import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invoke, invokeLocalHost, listLiveBrowsers, SOCKET_PATH } from '@mearl/client/local';
import { mergePresetDefaults, type JsonObject } from '@mearl/preset';
import { BundleError, createBundleFetchLoader, preparePreset, type BundleLoader, type PreparedPreset } from '@mearl/preset/bundles';
import { PresetInstallationStore, presetSelectionRevision } from './presetStore.js';

const installationSite = createRequire(import.meta.url)('@mearl/preset/installation-site.json') as { url: string };
export const MEARL_INSTALLATION_CONFIG_URL = new URL('installation.json', installationSite.url).href;

/** Runtime overrides apply to this local process, never to browser-supplied install requests. */
export function resolveInstallationConfigUrl(value = process.env.MEARL_INSTALLATION_CONFIG_URL, allowLoopback = false): URL {
  const url = new URL(value || MEARL_INSTALLATION_CONFIG_URL);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Invalid installation configuration URL');
  return url;
}

export { claimPresetInstallation } from './presetInstallationLease.js';
export { PresetInstallationStore, presetSelectionRevision } from './presetStore.js';
export type { PresetInstallReceipt } from './presetStore.js';
export { PresetBrowserTransfer } from './presetBrowserTransfer.js';

export interface PresetHostTarget { id: string; socketPath?: string }
export interface PresetHostStatus { id: string; state: 'active' | 'pending' | 'rejected'; error?: string }
export interface PresetBrowserHostStatus extends PresetHostStatus { settingsReady: boolean }
export interface PresetComponentStatus {
  kind: 'skills' | 'providers';
  id: string;
  state: 'ready' | 'pending' | 'conflict';
  reason?: string;
}
export interface PresetComponentHostStatus {
  installationRevision: string;
  nodeRevision: string;
  components: PresetComponentStatus[];
  catalogReady?: boolean;
}
export interface PresetInstallStatus {
  revision: string | null;
  id?: string;
  version?: string;
  ready: boolean;
  settings?: JsonObject;
  overrides?: JsonObject;
  nodeRevision?: string;
  browserRevision?: string;
  browserSyncRequired?: boolean;
  localComponentCount?: number;
  hosts: PresetHostStatus[];
  browsers: PresetBrowserHostStatus[];
  pending: Array<{ kind: 'preset' | 'packages' | 'skills' | 'providers'; id: string; runtime: 'browser' | 'node'; reason: string }>;
  warnings: string[];
}

export interface PresetInstallerOptions {
  directory?: string;
  mearlApiVersion?: string;
  load?: BundleLoader;
  hosts?: () => PresetHostTarget[];
  invoke?: typeof invoke;
  /** CLI setup synchronizes connected extensions without requiring their acknowledgement. */
  connectedExtensionsOnly?: boolean;
}
export interface PresetApplyOptions { validatePrepared?: (prepared: PreparedPreset) => Promise<void>; skipUnchanged?: boolean; overrides?: JsonObject; signal?: AbortSignal; expectedRevision?: string | null; expectedId?: string; confirm?: () => Promise<void> }
export interface StagedPresetInstallation { revision: string; activate: () => Promise<PresetInstallStatus> }

/** The caller chooses the source; this loader adds no identity or credential discovery. */
export function createNodePresetLoader(): BundleLoader {
  const network = createBundleFetchLoader();
  return async (source, options) => {
    const url = new URL(source);
    if (url.protocol === 'file:') {
      options.signal?.throwIfAborted();
      const file = fileURLToPath(url);
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > options.maxBytes) throw new BundleError('BUNDLE_QUOTA', 'Invalid local preset resource file or size');
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > options.maxBytes) throw new BundleError('BUNDLE_QUOTA', 'Local preset resource exceeds its size limit');
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.byteLength) {
          options.signal?.throwIfAborted();
          const result = await handle.read(bytes, length, bytes.byteLength - length, null);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > stat.size) throw new BundleError('BUNDLE_INTEGRITY', 'Local preset resource changed while reading');
        return bytes.subarray(0, length);
      } finally { await handle.close(); }
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new BundleError('BUNDLE_INVALID', 'Preset sources require HTTPS, local files or loopback HTTP');
    }
    return network(source, options);
  };
}

function sourceUrl(source: string): string {
  try { return new URL(source).href; }
  catch { return pathToFileURL(resolve(source)).href; }
}

function localHosts(allowStart = false): PresetHostTarget[] {
  const configured = process.env.MEARL_SOCKET_PATH?.trim();
  const hosts = configured ? [{ id: 'local', socketPath: configured }] : listLiveBrowsers().filter(browser => !browser.provider).map(browser => ({ id: browser.browserId, socketPath: browser.socketPath }));
  return hosts.length ? Array.from(new Map(hosts.map(host => [host.socketPath, host])).values()) : [{ id: 'local', ...(allowStart ? {} : { socketPath: SOCKET_PATH }) }];
}

export function connectedPresetExtensions(browsers: ReturnType<typeof listLiveBrowsers>, socketPath?: string) {
  return browsers.filter(browser => !browser.provider && browser.transport === 'extension' &&
    (browser.status === undefined || browser.status === 'connected') && (!socketPath || browser.socketPath === socketPath));
}

/** Installation and live acknowledgements are distinct; browser/external installs remain pending. */
export class PresetInstaller {
  readonly store: PresetInstallationStore;
  private readonly options: PresetInstallerOptions;

  constructor(options: PresetInstallerOptions = {}) {
    this.options = options;
    this.store = new PresetInstallationStore(options);
  }

  private invokeHost(action: string, data: Record<string, unknown>, target: PresetHostTarget, timeoutSec: number, allowStart = false): Promise<any> {
    if (!this.options.invoke && !target.socketPath && !allowStart) return Promise.reject(new Error('HOST_UNAVAILABLE'));
    return (this.options.invoke ?? (target.socketPath ? invoke : invokeLocalHost))(action, data, { socketPath: target.socketPath, timeoutSec });
  }

  private async hostStatus(reload: boolean, nodeRevision: string, installationRevision: string): Promise<PresetHostStatus[]> {
    const targets = this.options.hosts?.() ?? localHosts(reload);
    return Promise.all(targets.map(async target => {
      try {
        const result = await this.invokeHost(reload ? 'node_capabilities_reload' : 'node_capabilities_status', reload ? { structured: true } : {}, target, 15, reload);
        if (reload && result?.accepted === false) return { id: target.id, state: 'rejected' as const, error: typeof result.error === 'string' ? result.error : 'Node capability activation was rejected' };
        return { id: target.id, state: result?.revision === nodeRevision && result?.installationRevision === installationRevision ? 'active' as const : 'pending' as const };
      } catch {
        return { id: target.id, state: 'pending' as const, error: 'HOST_UNAVAILABLE' };
      }
    }));
  }

  private async browserStatus(reload: boolean, browserRevision: string, installationRevision: string): Promise<PresetBrowserHostStatus[]> {
    const targets = this.options.connectedExtensionsOnly
      ? connectedPresetExtensions(listLiveBrowsers(), process.env.MEARL_SOCKET_PATH?.trim()).map(browser => ({ id: browser.browserId, socketPath: browser.socketPath }))
      : this.options.hosts?.() ?? localHosts(reload);
    return Promise.all(targets.map(async target => {
      try {
        const result = await this.invokeHost(reload ? 'preset_browser_sync' : 'preset_browser_status', reload ? { installationRevision } : {}, target, reload ? 130 : 15, reload);
        if (result?.accepted === false) return { id: target.id, state: 'rejected' as const, settingsReady: false, error: typeof result.error === 'string' ? result.error : 'Browser preset activation rejected' };
        const error = Array.isArray(result?.permissionPending) && result.permissionPending.length
          ? 'PRESET_DOMAIN_PERMISSION_REQUIRED: Open extension settings and authorize preset domains'
          : typeof result?.error === 'string' ? result.error : undefined;
        return { id: target.id, state: result?.ready === true && result?.browserRevision === browserRevision && result?.installationRevision === installationRevision ? 'active' as const : 'pending' as const, settingsReady: result?.settingsReady === true, ...(error ? { error } : {}) };
      } catch { return { id: target.id, state: 'pending' as const, settingsReady: false, error: 'BROWSER_UNAVAILABLE' }; }
    }));
  }

  private async componentStatus(install: boolean, receipt: import('./presetStore.js').PresetInstallReceipt, replaceSkills?: readonly string[]): Promise<{ status?: PresetComponentHostStatus; error?: string }> {
    const target = (this.options.hosts?.() ?? localHosts(install))[0];
    if (!target) return {};
    try {
      const result = await this.invokeHost(install ? 'preset_components_install' : 'preset_components_status', { installationRevision: receipt.revision, ...(install && replaceSkills?.length ? { replaceSkills } : {}) }, target, install ? 900 : 15, install);
      if (result?.installationRevision !== receipt.revision || result?.nodeRevision !== receipt.nodeRevision || !Array.isArray(result?.components)) throw new Error('Component installation host requires an update');
      if (result.catalogReady !== undefined && typeof result.catalogReady !== 'boolean') throw new Error('Invalid plugin catalog readiness');
      const seen = new Set<string>();
      for (const entry of result.components) {
        if (!entry || !['skills', 'providers'].includes(entry.kind) || typeof entry.id !== 'string' || !['ready', 'pending', 'conflict'].includes(entry.state) || (entry.reason !== undefined && typeof entry.reason !== 'string')) throw new Error('Invalid component installation status');
        const key = `${entry.kind}:${entry.id}`;
        if (seen.has(key)) throw new Error('Duplicate component installation status');
        seen.add(key);
      }
      return { status: result };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }

  async status(): Promise<PresetInstallStatus> {
    const current = await this.store.current();
    const result: PresetInstallStatus = { revision: presetSelectionRevision(current), ready: false, hosts: [], browsers: [], pending: [], warnings: [] };
    if (!current.receipt || !current.prepared) return result;
    const { preset } = current.prepared;
    const receipt = current.receipt;
    result.id = preset.id;
    result.version = preset.version;
    result.overrides = receipt.overrides;
    result.settings = mergePresetDefaults(preset.defaults, receipt.overrides);
    result.nodeRevision = receipt.nodeRevision;
    result.browserRevision = receipt.browserRevision;
    const browserSyncRequired = receipt.browserSyncRequired === true && !this.options.connectedExtensionsOnly;
    result.browserSyncRequired = browserSyncRequired;
    result.localComponentCount = Object.values(preset.packages).filter(entry => entry.enabled !== false && entry.targets?.includes('node')).length
      + [...Object.values(preset.skills), ...Object.values(preset.providers)].filter(entry => entry.enabled !== false).length;
    result.hosts = await this.hostStatus(false, receipt.nodeRevision, receipt.revision);
    const nodeReady = result.hosts.length > 0 && result.hosts.every(host => host.state === 'active');
    if (receipt.browserSyncRequired) result.browsers = await this.browserStatus(false, receipt.browserRevision, receipt.revision);
    const browserReady = result.browsers.length > 0 && result.browsers.every(host => host.state === 'active');
    for (const [id, entry] of Object.entries(preset.packages)) {
      if (entry.enabled === false) continue;
      for (const runtime of entry.targets ?? []) {
        if (runtime === 'browser') { if (browserSyncRequired && !browserReady) result.pending.push({ kind: 'packages', id, runtime, reason: 'BROWSER_SYNC_REQUIRED' }); }
        else if (!receipt.managedModules.includes(id) && Object.keys(current.prepared.bundles.find(bundle => bundle.manifest.id === id)?.manifest.contributions?.nodeRuntimes ?? {}).length) result.pending.push({ kind: 'packages', id, runtime, reason: 'NODE_HOST_NOT_SUPPORTED' });
        else if (!nodeReady) result.pending.push({ kind: 'packages', id, runtime, reason: 'HOST_SYNC_REQUIRED' });
      }
    }
    const hasExternal = ['skills', 'providers'].some(kind => Object.values(preset[kind as 'skills' | 'providers']).some(entry => entry.enabled !== false));
    const hasCatalog = Boolean(current.activation?.bindings['plugins.catalog']);
    const components = hasExternal || hasCatalog ? await this.componentStatus(false, receipt) : {};
    if (hasCatalog && components.status?.catalogReady !== true) result.pending.push({ kind: 'preset', id: preset.id, runtime: 'node', reason: 'PLUGIN_CATALOG_SYNC_REQUIRED' });
    if (components.error) result.warnings.push(`Component readiness check failed: ${components.error}`);
    for (const kind of ['skills', 'providers'] as const) for (const [id, entry] of Object.entries(preset[kind])) {
      if (entry.enabled === false) continue;
      const actual = components.status?.components.find(component => component.kind === kind && component.id === id);
      if (actual?.state !== 'ready') result.pending.push({ kind, id, runtime: 'node', reason: actual?.reason ?? 'INSTALL_REQUIRED' });
    }
    if (receipt.nodeSyncRequired && !nodeReady && !result.pending.some(entry => entry.reason === 'HOST_SYNC_REQUIRED')) result.pending.push({ kind: 'preset', id: preset.id, runtime: 'node', reason: 'HOST_SYNC_REQUIRED' });
    if (browserSyncRequired && !browserReady && !result.pending.some(entry => entry.reason === 'BROWSER_SYNC_REQUIRED')) result.pending.push({ kind: 'preset', id: preset.id, runtime: 'browser', reason: 'BROWSER_SYNC_REQUIRED' });
    if (browserSyncRequired && browserReady && Object.keys(result.settings ?? {}).length && !result.browsers.every(host => host.settingsReady)) result.pending.push({ kind: 'preset', id: preset.id, runtime: 'browser', reason: 'SETTINGS_APPLY_REQUIRED' });
    result.ready = result.pending.length === 0;
    return result;
  }

  private async synchronize(receipt: import('./presetStore.js').PresetInstallReceipt, previousRevision: string | null, replaceSkills?: readonly string[]): Promise<PresetInstallStatus> {
    const hosts = await this.hostStatus(true, receipt.nodeRevision, receipt.revision);
    const rejection = hosts.find(host => host.state === 'rejected');
    if (rejection) {
      if (previousRevision === receipt.revision) throw new Error(`Node activation rejected; installed selection retained: ${rejection.error}`);
      await this.store.rollback(receipt.revision);
      const previous = await this.store.current({ verifyResources: false });
      await this.hostStatus(true, previous.activation?.revision ?? '', previous.activation?.installationRevision ?? '');
      throw new Error(`Node activation rejected; previous selection restored: ${rejection.error}`);
    }
    const browsers = receipt.browserSyncRequired ? await this.browserStatus(true, receipt.browserRevision, receipt.revision) : [];
    const rejected = browsers.find(host => host.state === 'rejected');
    if (rejected && !this.options.connectedExtensionsOnly) throw new Error(`Browser activation rejected; installed selection retained for retry: ${rejected.error}`);
    const installed = await this.store.current({ verifyResources: false });
    if (installed.receipt?.revision !== receipt.revision || !installed.preset) throw new BundleError('BUNDLE_CONFLICT', 'The selected preset changed before component installation');
    const hasExternal = [...Object.values(installed.preset.skills), ...Object.values(installed.preset.providers)].some(entry => entry.enabled !== false);
    const components = hasExternal || installed.activation?.bindings['plugins.catalog'] ? await this.componentStatus(true, receipt, replaceSkills) : {};
    const status = await this.status();
    if (rejected) status.warnings.push(`Browser preset activation rejected by ${rejected.id}: ${rejected.error}`);
    if (components.error) status.warnings.push(`Component installation failed; completed assets retained for retry: ${components.error}`);
    if (status.revision !== receipt.revision) throw new BundleError('BUNDLE_CONFLICT', 'The selected preset changed while hosts were synchronizing');
    try { await this.store.collectGarbage(); }
    catch (error) { status.warnings.push(`Preset resource cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    return status;
  }

  private async stageSource(source: string, expectedRevision: string | null, options: PresetApplyOptions): Promise<StagedPresetInstallation> {
    const prepared = await preparePreset(sourceUrl(source), { mearlApiVersion: this.store.mearlApiVersion, load: this.options.load ?? createNodePresetLoader(), signal: options.signal });
    if (options.expectedId !== undefined && prepared.preset.id !== options.expectedId) throw new BundleError('BUNDLE_INVALID', 'The preset identity differs from the accepted installation');
    await options.validatePrepared?.(prepared);
    if (options.skipUnchanged) {
      const current = await this.store.current();
      if (presetSelectionRevision(current) !== expectedRevision) throw new BundleError('BUNDLE_CONFLICT', 'The installed preset changed during update');
      if (current.receipt && current.prepared?.snapshot.revision === prepared.snapshot.revision) {
        return { revision: current.receipt.revision, activate: async () => {
          const status = await this.status();
          if (status.revision !== expectedRevision) throw new BundleError('BUNDLE_CONFLICT', 'The installed preset changed during update');
          return status.ready ? status : this.resume(current.receipt!.revision);
        } };
      }
    }
    const receipt = await this.store.apply(prepared, { ...options, expectedRevision });
    let activated = false;
    return { revision: receipt.revision, activate: async () => {
      if (activated) throw new Error('Staged installation was already activated; use resume with its revision to retry');
      activated = true;
      const current = await this.store.current();
      if (current.receipt?.revision !== receipt.revision) throw new BundleError('BUNDLE_CONFLICT', 'The selected preset changed before runtime setup completed');
      return this.synchronize(current.receipt, expectedRevision);
    } };
  }

  /** Save exact resources and desired selection; activate once after runtime setup, then retry via resume. */
  async stage(source: string, options: PresetApplyOptions = {}): Promise<StagedPresetInstallation> {
    const accepted = { ...options, ...(options.overrides === undefined ? {} : { overrides: mergePresetDefaults({}, options.overrides) }) };
    const current = await this.store.current({ verifyResources: false });
    const revision = presetSelectionRevision(current);
    if (accepted.expectedRevision !== undefined && accepted.expectedRevision !== revision) throw new BundleError('BUNDLE_CONFLICT', 'The installed preset changed before preparation');
    return this.stageSource(source, revision, accepted);
  }

  async apply(source: string, options: PresetApplyOptions = {}): Promise<PresetInstallStatus> {
    return (await this.stage(source, options)).activate();
  }

  async update(options: Pick<PresetApplyOptions, 'validatePrepared' | 'skipUnchanged' | 'signal'> = {}): Promise<PresetInstallStatus> {
    const current = await this.store.current({ verifyResources: false });
    if (!current.receipt) throw new Error('No preset is installed');
    return this.apply(current.receipt.snapshot.source, { ...options, expectedRevision: presetSelectionRevision(current) });
  }

  async resume(expectedRevision: string, options: { replaceSkills?: readonly string[] } = {}): Promise<PresetInstallStatus> {
    const current = await this.store.current();
    if (!current.receipt || current.receipt.revision !== expectedRevision) throw new BundleError('BUNDLE_CONFLICT', 'The installed preset changed before resuming');
    const names = options.replaceSkills;
    if (names !== undefined && (!Array.isArray(names) || !names.length || names.length > 256 || new Set(names).size !== names.length || names.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(name) || !current.preset || !Object.hasOwn(current.preset.skills, name) || current.preset.skills[name].enabled === false))) throw new Error('Invalid Skill replacement selection');
    return this.synchronize(current.receipt, expectedRevision, options.replaceSkills);
  }

  async repair(options: { replaceSkills?: readonly string[] } = {}): Promise<PresetInstallStatus> {
    const current = await this.store.current({ verifyResources: false });
    if (!current.receipt) throw new Error('No preset is installed');
    return this.resume(current.receipt.revision, options);
  }

  async configure(value: JsonObject): Promise<PresetInstallStatus> {
    const current = await this.store.current();
    if (!current.prepared) throw new Error('No preset is installed');
    const receipt = await this.store.apply(current.prepared, { expectedRevision: presetSelectionRevision(current), overrides: value });
    return this.synchronize(receipt, presetSelectionRevision(current));
  }
}

export async function runPresetCommand(command: 'apply' | 'update' | 'status' | 'repair', source?: string, options: { replaceSkills?: readonly string[] } = {}): Promise<PresetInstallStatus> {
  if (command !== 'repair' && options.replaceSkills !== undefined) throw new Error('Skill replacements require preset repair');
  const installer = new PresetInstaller({ connectedExtensionsOnly: true });
  if (command === 'repair') return installer.repair(options);
  return command === 'status' ? installer.status() : command === 'update' ? installer.update() : installer.apply(source!);
}
