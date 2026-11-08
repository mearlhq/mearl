import { mergeAppBridgeConfigs, validateAppBridgeConfig } from '@mearl/app-profiles';
import { type AppBridgeConfig, type AppProfileName } from '@mearl/browser-core';

export const APP_BRIDGE_CONFIGS_STORAGE_KEY = 'appBridgeConfigs';

export type StoredAppBridgeConfigs = Partial<Record<AppProfileName, AppBridgeConfig>>;
function isAppProfileName(value: string): value is AppProfileName {
  return /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(value);
}

export async function loadStoredAppBridgeConfigs(): Promise<StoredAppBridgeConfigs> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return {};
  const stored = await chrome.storage.local.get(APP_BRIDGE_CONFIGS_STORAGE_KEY);
  if (!stored || typeof stored !== 'object') return {};
  const raw = stored[APP_BRIDGE_CONFIGS_STORAGE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const configs: StoredAppBridgeConfigs = {};
  for (const [profile, config] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAppProfileName(profile)) continue;
    try {
      configs[profile] = validateAppBridgeConfig(config);
    } catch (error) {
      console.warn(`[Mearl] Ignoring invalid bridge config for ${profile}:`, error);
    }
  }
  return configs;
}

export async function saveStoredAppBridgeConfigs(configs: StoredAppBridgeConfigs): Promise<void> {
  const normalized: StoredAppBridgeConfigs = {};
  for (const [profile, config] of Object.entries(configs)) {
    if (!isAppProfileName(profile) || !config) continue;
    normalized[profile] = validateAppBridgeConfig(config);
  }
  await chrome.storage.local.set({ [APP_BRIDGE_CONFIGS_STORAGE_KEY]: normalized });
}

export async function resolveStoredAppBridgeConfig(
  profile: AppProfileName,
  explicit?: AppBridgeConfig,
): Promise<AppBridgeConfig | undefined> {
  const stored = (await loadStoredAppBridgeConfigs())[profile];
  return mergeAppBridgeConfigs(stored, explicit);
}

const APP_PROFILE_OPTIONS_STORAGE_KEY = 'appProfileOptions';
let profileStorageQueue: Promise<unknown> = Promise.resolve();
function updateProfileStorage<T>(update: () => Promise<T>): Promise<T> {
  const pending = profileStorageQueue.catch(() => {}).then(update);
  profileStorageQueue = pending;
  return pending;
}

export function saveStoredAppProfileBridgeConfig(
  profile: AppProfileName,
  patch: AppBridgeConfig,
): Promise<void> {
  return updateProfileStorage(async () => {
    const stored = await loadStoredAppBridgeConfigs();
    await saveStoredAppBridgeConfigs({
      ...stored,
      [profile]: mergeAppBridgeConfigs(stored[profile], patch),
    });
  });
}

export async function loadStoredAppProfileOptions(profile: string): Promise<{ language?: string }> {
  const stored = await chrome.storage.local.get(APP_PROFILE_OPTIONS_STORAGE_KEY);
  const language = stored?.[APP_PROFILE_OPTIONS_STORAGE_KEY]?.[profile]?.language;
  return typeof language === 'string' ? { language } : {};
}
export function saveStoredAppProfileOptions(
  profile: string,
  options: { language?: string },
): Promise<void> {
  return updateProfileStorage(async () => {
    const stored = await chrome.storage.local.get(APP_PROFILE_OPTIONS_STORAGE_KEY);
    await chrome.storage.local.set({
      [APP_PROFILE_OPTIONS_STORAGE_KEY]: {
        ...(stored?.[APP_PROFILE_OPTIONS_STORAGE_KEY] ?? {}),
        [profile]: options,
      },
    });
  });
}
