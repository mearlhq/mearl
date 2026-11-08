import {
  resolveAppProfile,
  type ResolveAppProfileOptions,
} from '@mearl/app-profiles';
import {
  appProfileRevision,
  validateAppProfileDefinition,
  type AppProfileCatalogEntry,
} from '@mearl/browser-core';
import { requestNativeHostOnce } from './nativeHostRequest';
import { getBrowserAppProfile, getBrowserAppProfileCatalog, onBrowserPresetChange } from './browserCapabilityRegistry';

const CACHE_KEY = 'appProfileCatalog';
const pending = new Map<boolean, Promise<AppProfileCatalog>>();
let catalogGeneration = 0;
let listening = false;
interface AppProfileCatalog {
  profiles: AppProfileCatalogEntry[];
  errors: Array<{ plugin: string; error: string }>;
  offline?: boolean;
}
function pluginEntries(value: unknown, hiddenPlugins: ReadonlySet<string>): AppProfileCatalogEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid app profile catalog');
  return value
    .filter(entry => entry?.source === 'plugin' && !hiddenPlugins.has(entry.plugin))
    .map(entry => {
      const definition = validateAppProfileDefinition(entry.definition);
      if (
        typeof entry.plugin !== 'string' ||
        !/^[a-z][a-z0-9-]*$/.test(entry.plugin) ||
        (definition.name.includes('/') && !definition.name.startsWith(`${entry.plugin}/`)) ||
        entry.id !== definition.name ||
        entry.revision !== appProfileRevision(definition)
      )
        throw new Error('Invalid app profile registration');
      return {
        id: definition.name,
        label: definition.label,
        source: 'plugin' as const,
        plugin: entry.plugin,
        revision: entry.revision,
        definition,
      };
    });
}

/** Installed definitions are synchronized before activation; document startup only consumes data. */
export async function getAppProfileCatalog(options: { refresh?: boolean } = {}): Promise<AppProfileCatalog> {
  if (!listening) {
    listening = true;
    onBrowserPresetChange(() => { catalogGeneration++; pending.clear(); });
  }
  const generation = catalogGeneration;
  const assertCurrent = () => { if (generation !== catalogGeneration) throw new Error('App profile catalog selection changed'); };
  const refresh = options.refresh !== false;
  const current = pending.get(refresh);
  if (current) return current;
  const result = (async () => {
    const browser = await getBrowserAppProfileCatalog();
    assertCurrent();
    const browserIds = new Set(browser.bundleIds);
    const browserAppIds = new Set(browser.profiles.map(profile => profile.id));
    try {
      const result = (await requestNativeHostOnce(
        'app_profile_catalog',
        { refresh },
        5_000,
      )) as AppProfileCatalog;
      const plugins = pluginEntries(result.profiles, browserIds);
      assertCurrent();
      await chrome.storage.local.set({ [CACHE_KEY]: plugins });
      assertCurrent();
      return {
        profiles: [...browser.profiles, ...plugins.filter(profile => !browserAppIds.has(profile.id))],
        errors: [...browser.errors, ...(result.errors ?? [])],
      };
    } catch (error) {
      assertCurrent();
      const stored: Record<string, unknown> = await chrome.storage.local
        .get(CACHE_KEY)
        .catch(() => ({}));
      assertCurrent();
      let plugins: AppProfileCatalogEntry[] = [];
      try {
        plugins = pluginEntries(stored[CACHE_KEY] ?? [], browserIds);
      } catch {
        /* Invalid cache is unavailable. */
      }
      return {
        profiles: [
          ...browser.profiles,
          ...plugins.filter(profile => !browserAppIds.has(profile.id)).map(profile => ({ ...profile, available: false })),
        ],
        errors: [...browser.errors, { plugin: '', error: String(error) }],
        offline: true,
      };
    }
  })();
  pending.set(refresh, result);
  try {
    return await result;
  } finally {
    if (pending.get(refresh) === result) pending.delete(refresh);
  }
}

export async function resolveAvailableAppProfile(
  name: string,
  options: ResolveAppProfileOptions = {},
) {
  const browser = await getBrowserAppProfile(name);
  if (browser) return resolveAppProfile(name, options, browser.definition);
  const catalog = await getAppProfileCatalog();
  if (catalog.offline) throw new Error(`App profile requires an online registration: ${name}`);
  const profile = catalog.profiles.find(candidate => candidate.id === name);
  if (!profile) throw new Error(`App profile is unavailable: ${name}`);
  return resolveAppProfile(name, options, profile.definition);
}
