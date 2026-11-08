export const EXTERNAL_SERVICE_KEYS = [
  'accountsEnabled',
  'requestCasesEnabled',
  'requestMetadataEnabled',
  'requestImportEnabled',
  'trackingMetadataEnabled',
] as const;
export type ExternalServiceKey = (typeof EXTERNAL_SERVICE_KEYS)[number];
export type ExternalServiceConfig = Record<ExternalServiceKey, boolean>;

export const SERVICE_DEFAULTS_CACHE_KEY = 'external-service-defaults';
export const SERVICE_DEFAULTS_REFRESH_ACTION = 'refreshExternalServiceDefaults';
export const EXTERNAL_SERVICE_UPDATE_ACTION = 'updateExternalServicePreferences';

export interface ServiceDefaultsCache {
  services: Record<string, boolean>;
}

export function isValidServiceDefaultsCache(value: unknown): value is ServiceDefaultsCache {
  if (!value || typeof value !== 'object') return false;
  const services = (value as ServiceDefaultsCache).services;
  return !!services && typeof services === 'object' && !Array.isArray(services)
    && Object.values(services).every(enabled => typeof enabled === 'boolean');
}

export function resolveExternalServices(
  preferences: Partial<ExternalServiceConfig>,
  cache: unknown,
): ExternalServiceConfig {
  const services = isValidServiceDefaultsCache(cache) ? cache.services : {};
  return Object.fromEntries(
    EXTERNAL_SERVICE_KEYS.map(key => [
      key,
      typeof preferences[key] === 'boolean' ? preferences[key] : services[key] === true,
    ]),
  ) as ExternalServiceConfig;
}

export async function readServiceDefaultsCache(): Promise<unknown> {
  try {
    const stored = await chrome.storage.session.get(SERVICE_DEFAULTS_CACHE_KEY);
    return stored[SERVICE_DEFAULTS_CACHE_KEY];
  } catch {
    return undefined;
  }
}
