import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, withRecordLock } from '@mearl/daemon-core';
import { PresetInstaller, createNodePresetLoader, resolveInstallationConfigUrl, type PresetInstallerOptions } from '@mearl/setup/preset';
import { loadInstallationConfig, trustedInstallationPreset, installationOriginCovered, matchesInstallationOrigin, PRESET_UPDATE_INTERVAL_MS, PRESET_UPDATE_RETRY_MS } from '@mearl/preset/installation';
import { presetRequiresBrowser } from '@mearl/preset/bundles';

interface UpdateState {
  id: string;
  source: string;
  checkedAt: number;
  nextCheckAt: number;
  token?: string;
  pid?: number;
  status?: string;
  error?: string;
}
interface Dependencies {
  directory: string;
  invoke: NonNullable<PresetInstallerOptions['invoke']>;
  extensionConnected: () => boolean;
  browserSelection?: () => Promise<{ presetId?: string; presetSource?: string }>;
  configuration?: () => ReturnType<typeof loadInstallationConfig>;
  now?: () => number;
  load?: ReturnType<typeof createNodePresetLoader>;
  log?: (...values: unknown[]) => void;
}

/** Detached/CDP hosts update only an existing trusted selection; an attached extension owns its updates. */
export function createNativePresetAutoUpdater(dependencies: Dependencies) {
  const now = dependencies.now ?? Date.now;
  const statePath = join(dependencies.directory, 'auto-update.json');
  const read = (): UpdateState | undefined => {
    try { if (statSync(statePath).size <= 8192) return JSON.parse(readFileSync(statePath, 'utf8')); }
    catch { /* A missing receipt makes the first installed selection due. */ }
  };
  const write = (value: UpdateState) => {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, statePath);
  };
  const configuration = dependencies.configuration ?? (() => { const url = resolveInstallationConfigUrl(); return loadInstallationConfig(url, url.origin, AbortSignal.timeout(5000)); });
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const installer = new PresetInstaller({ directory: dependencies.directory, hosts: () => [{ id: 'local' }], invoke: dependencies.invoke });
      const current = await installer.store.current({ verifyResources: false });
      if (!current.receipt || !current.preset) return;
      const extensionOwnsUpdate = async () => {
        if (!dependencies.extensionConnected()) return false;
        if (current.receipt!.browserSyncRequired || !dependencies.browserSelection) return true;
        const browser = await dependencies.browserSelection();
        return !browser.presetId || (browser.presetId === current.preset!.id && browser.presetSource === current.receipt!.snapshot.source);
      };
      if (await extensionOwnsUpdate()) return;
      const id = current.preset.id;
      const source = current.receipt.snapshot.source;
      const checkedAt = now();
      const token = randomUUID();
      mkdirSync(dependencies.directory, { recursive: true, mode: 0o700 });
      const claimed = withRecordLock(statePath, () => {
        const previous = read();
        if (previous?.token && previous.pid && isAlive(previous.pid) && checkedAt - previous.checkedAt < 30 * 60_000) return false;
        if (previous?.id === id && previous.source === source && previous.checkedAt <= checkedAt && previous.nextCheckAt > checkedAt) return false;
        write({ id, source, checkedAt, nextCheckAt: checkedAt + PRESET_UPDATE_RETRY_MS, token, pid: process.pid });
        return true;
      });
      if (!claimed) return;
      let status = 'failed';
      let error: string | undefined;
      try {
        const config = await configuration();
        const trusted = trustedInstallationPreset(config, id, source);
        if (!trusted) { status = 'untrusted'; return; }
        const load = dependencies.load ?? createNodePresetLoader();
        const updater = new PresetInstaller({
          directory: dependencies.directory, hosts: () => [{ id: 'local' }], invoke: dependencies.invoke,
          load: (value, options) => {
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password || !trusted.origins.some(origin => matchesInstallationOrigin(origin, url))) throw new Error('PRESET_UPDATE_SOURCE_DENIED');
            return load(value, options);
          },
        });
        const result = await updater.apply(source, {
          expectedId: id, expectedRevision: current.receipt.revision, skipUnchanged: true, signal: AbortSignal.timeout(120_000),
          validatePrepared: async prepared => {
            if (await extensionOwnsUpdate()) throw new Error('PRESET_UPDATE_EXTENSION_CONNECTED');
            const latest = trustedInstallationPreset(await configuration(), id, source);
            if (JSON.stringify(latest) !== JSON.stringify(trusted)) throw new Error('PRESET_UPDATE_TRUST_CHANGED');
            if (prepared.preset.permissions.origins.some(origin => !installationOriginCovered(origin, trusted.origins))) throw new Error('PRESET_UPDATE_SOURCE_DENIED');
            if (prepared.preset.permissions.origins.some(origin => !installationOriginCovered(origin, current.preset!.permissions.origins)) || (!current.receipt!.browserSyncRequired && presetRequiresBrowser(prepared.preset))) throw new Error('PRESET_UPDATE_PERMISSION_REQUIRED');
          },
        });
        status = result.revision === current.receipt.revision ? 'current' : 'updated';
        if (!result.ready) error = 'INSTALLATION_SYNC_PENDING';
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        dependencies.log?.('Preset update deferred:', error);
      } finally {
        withRecordLock(statePath, () => {
          if (read()?.token !== token) return;
          write({ id, source, checkedAt, nextCheckAt: checkedAt + (status === 'failed' || error ? PRESET_UPDATE_RETRY_MS : PRESET_UPDATE_INTERVAL_MS), status, ...(error ? { error } : {}) });
        });
      }
    })().catch(error => dependencies.log?.('Preset update unavailable:', String(error))).finally(() => { pending = undefined; });
    return pending;
  };
}
