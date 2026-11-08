import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import { EXTERNAL_SERVICE_KEYS, SERVICE_DEFAULTS_CACHE_KEY, type ExternalServiceConfig, type ServiceDefaultsCache } from '../../shared/externalServices';
import type { BrowserPresetSettings } from '../../shared/browserPresetSettings';

let inFlight: Promise<ServiceDefaultsCache> | undefined;
let preferenceWrite: Promise<void> = Promise.resolve();
function enqueuePreferenceWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = preferenceWrite.then(write);
  preferenceWrite = result.then(() => {}, () => {});
  return result;
}

async function readDefaults(): Promise<ServiceDefaultsCache> {
  const settings = await browserCapabilityRegistry().settings();
  const cache: ServiceDefaultsCache = { services: settings.services ?? {} };
  const stored = await chrome.storage.session.get(SERVICE_DEFAULTS_CACHE_KEY);
  if (JSON.stringify(stored[SERVICE_DEFAULTS_CACHE_KEY]?.services) !== JSON.stringify(cache.services)) await chrome.storage.session.set({ [SERVICE_DEFAULTS_CACHE_KEY]: cache });
  return cache;
}

/** Installed defaults share the same queue as explicit choices. */
export function refreshExternalServiceDefaults(): Promise<ServiceDefaultsCache> {
  if (inFlight) return inFlight;
  inFlight = enqueuePreferenceWrite(readDefaults).finally(() => { inFlight = undefined; });
  return inFlight;
}
export async function isExternalServiceEnabled(key: string, settings?: Pick<BrowserPresetSettings, 'services' | 'extension'>): Promise<boolean> {
  const preferences = await chrome.storage.sync.get([key]);
  if (typeof preferences[key] === 'boolean') return preferences[key];
  const defaults = settings
    ? { services: settings.services }
    : await refreshExternalServiceDefaults();
  const latest = await chrome.storage.sync.get([key]);
  return typeof latest[key] === 'boolean' ? latest[key] : defaults.services?.[key] === true;
}
export function updateBrowserServicePreferences(patch: Record<string, boolean>, assertSelection?: () => Promise<void>): Promise<void> {
  return enqueuePreferenceWrite(async () => {
    const defaults = await readDefaults();
    await assertSelection?.();
    const values: Record<string, boolean> = {};
    const removals: string[] = [];
    for (const [key, enabled] of Object.entries(patch)) {
      if (typeof enabled !== 'boolean' || !/^[a-z][a-zA-Z0-9_-]{0,72}Enabled$/.test(key)) throw new Error('Invalid service preference');
      if (enabled === (defaults.services?.[key] === true)) removals.push(key);
      else values[key] = enabled;
    }
    if (Object.keys(values).length) await chrome.storage.sync.set(values);
    if (removals.length) await chrome.storage.sync.remove([...new Set(removals)]);
  });
}
export function updateExternalServicePreferences(patch: Partial<ExternalServiceConfig>): Promise<void> {
  return updateBrowserServicePreferences(Object.fromEntries(EXTERNAL_SERVICE_KEYS.filter(key => typeof patch[key] === 'boolean').map(key => [key, patch[key] as boolean])));
}
