import { invokeLocalHost, listLiveBrowsers } from '@mearl/client/local';
import { installationOriginCovered, loadInstallationConfig, matchesInstallationOrigin, trustedInstallationPreset } from '@mearl/preset/installation';
import { connectedPresetExtensions, createNodePresetLoader, PresetInstaller, resolveInstallationConfigUrl } from './preset.js';
import type { StagedPresetInstallation } from './preset.js';

interface BrowserSelection { browserId: string; presetId: string; presetSource: string; browserRevision: string }
interface Options { env?: NodeJS.ProcessEnv; writeLine?: (line: string) => void }
interface Dependencies {
  browsers?: typeof listLiveBrowsers;
  invoke?: typeof invokeLocalHost;
  configuration?: () => ReturnType<typeof loadInstallationConfig>;
  load?: ReturnType<typeof createNodePresetLoader>;
}

/** Explicit setup may complete a trusted browser selection before installing any Skills. */
export async function prepareBrowserSetupPreset(options: Options = {}, dependencies: Dependencies = {}): Promise<StagedPresetInstallation | undefined> {
  const env = options.env ?? process.env;
  const directory = env.MEARL_CAPABILITY_DIR;
  const current = await new PresetInstaller({ directory }).store.current();
  if (current.activation || current.receipt) return;
  const browsers = dependencies.browsers ?? listLiveBrowsers;
  const invoke = dependencies.invoke ?? invokeLocalHost;
  const configuration = dependencies.configuration ?? (() => {
    const url = resolveInstallationConfigUrl(env.MEARL_INSTALLATION_CONFIG_URL);
    return loadInstallationConfig(url, url.origin, AbortSignal.timeout(5_000));
  });
  const connected = () => connectedPresetExtensions(browsers(), env.MEARL_SOCKET_PATH?.trim());
  const read = async (): Promise<BrowserSelection[] | undefined> => {
    const targets = connected();
    if (!targets.length) return;
    return (await Promise.all(targets.map(async browser => {
      let value: any;
      try { value = await invoke('preset_browser_status', {}, { socketPath: browser.socketPath, timeoutSec: 5 }); }
      catch {
        if (!connected().some(target => target.browserId === browser.browserId && target.socketPath === browser.socketPath)) return [];
        throw new Error(`Cannot read preset from ${browser.browserId}. Reconnect the extension and retry setup, or use --preset <source>.`);
      }
      if (value?.error === 'EXTENSION_NOT_CONNECTED') return [];
      if (value?.error || typeof value?.browserReady !== 'boolean' || !Object.hasOwn(value, 'browserRevision') || (value.presetId !== undefined && (typeof value.presetId !== 'string' || !value.presetId || typeof value.presetSource !== 'string' || typeof value.browserRevision !== 'string' || value.browserReady !== true))) throw new Error(`Browser preset is unavailable in ${browser.browserId}. Reconnect the extension and retry setup, or use --preset <source>.`);
      if (!value.presetId) return [];
      return [{ browserId: browser.browserId, presetId: value.presetId, presetSource: value.presetSource, browserRevision: value.browserRevision }];
    }))).flat();
  };
  const accepted = await read();
  if (!accepted?.length) return;
  const first = accepted[0];
  if (accepted.some(value => value.presetId !== first.presetId || value.presetSource !== first.presetSource)) throw new Error('Connected browsers use different presets. Select one explicitly with --preset <source>.');
  const trusted = trustedInstallationPreset(await configuration(), first.presetId, first.presetSource);
  if (!trusted) throw new Error('The browser preset is not in the trusted installation catalog. Install it explicitly with --preset <source>.');
  const load = dependencies.load ?? createNodePresetLoader();
  const installer = new PresetInstaller({ directory, connectedExtensionsOnly: true, load: (source, resourceOptions) => {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password || !trusted.origins.some(origin => matchesInstallationOrigin(origin, url))) throw new Error('Browser preset resource is outside the trusted installation catalog');
    return load(source, resourceOptions);
  } });
  options.writeLine?.(`Using the browser's trusted preset: ${first.presetId}`);
  return installer.stage(first.presetSource, {
    expectedId: first.presetId, expectedRevision: null, signal: AbortSignal.timeout(120_000),
    validatePrepared: async prepared => {
      if (prepared.preset.permissions.origins.some(origin => !installationOriginCovered(origin, trusted.origins))) throw new Error('Browser preset permissions exceed the trusted installation catalog');
    },
    confirm: async () => {
      if (JSON.stringify(trustedInstallationPreset(await configuration(), first.presetId, first.presetSource)) !== JSON.stringify(trusted)) throw new Error('Browser preset trust changed during setup');
      const latest = await read();
      if (!latest || latest.length !== accepted.length || accepted.some(value => !latest.some(other => value.browserId === other.browserId && value.presetId === other.presetId && value.presetSource === other.presetSource && value.browserRevision === other.browserRevision))) throw new Error('The browser preset changed during setup. Retry or use --preset <source>.');
    },
  });
}
