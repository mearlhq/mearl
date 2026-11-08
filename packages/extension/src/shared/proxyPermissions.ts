import { ALLOWED_ORIGINS_LIST } from './allowedOrigins';
import { normalizeDomainInputToOrigin, isOriginAllowedByDomain } from '@mearl/browser-core';

export { normalizeDomainInputToOrigin, isOriginAllowedByDomain };

export const PROXY_PERMISSION_STORAGE_KEY = 'proxyCookieAllowedOrigins';
export const DISABLED_BUILTIN_ORIGINS_STORAGE_KEY = 'disabledBuiltinProxyCookieOrigins';
export const AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY = 'agentAllowAllDomains';
export const ALL_URLS_ORIGIN = '<all_urls>';

export const DEFAULT_AGENT_ORIGINS = ALLOWED_ORIGINS_LIST;

function dedupeOrigins(origins: string[]): string[] {
  return Array.from(new Set(origins));
}

export function formatOriginHost(origin: string): string {
  const isWildcard = origin.startsWith('*://*.');
  const host = origin.replace(/^\*:\/\/(?:\*\.)?/, '').replace(/\/\*$/, '');
  return isWildcard ? `*.${host}` : host;
}

export function getStoredAgentOrigins(): Promise<string[]> {
  return new Promise(resolve => {
    chrome.storage.sync.get(
      [PROXY_PERMISSION_STORAGE_KEY, DISABLED_BUILTIN_ORIGINS_STORAGE_KEY],
      result => {
        const stored = result?.[PROXY_PERMISSION_STORAGE_KEY];
        const allOrigins = Array.isArray(stored)
          ? dedupeOrigins(stored.filter((item): item is string => typeof item === 'string'))
          : dedupeOrigins(DEFAULT_AGENT_ORIGINS);

        const disabledRaw = result?.[DISABLED_BUILTIN_ORIGINS_STORAGE_KEY];
        const disabledSet = new Set(
          Array.isArray(disabledRaw)
            ? disabledRaw.filter((item): item is string => typeof item === 'string')
            : [],
        );

        resolve(allOrigins.filter(origin => !disabledSet.has(origin)));
      },
    );
  });
}

/**
 * Get all stored origins without filtering out disabled ones.
 * Used by the settings UI to display the full list.
 */
export function getAllStoredAgentOrigins(): Promise<string[]> {
  return new Promise(resolve => {
    chrome.storage.sync.get([PROXY_PERMISSION_STORAGE_KEY], result => {
      const stored = result?.[PROXY_PERMISSION_STORAGE_KEY];
      resolve(
        Array.isArray(stored)
          ? dedupeOrigins(stored.filter((item): item is string => typeof item === 'string'))
          : dedupeOrigins(DEFAULT_AGENT_ORIGINS),
      );
    });
  });
}

export function getDisabledBuiltinOrigins(): Promise<string[]> {
  return new Promise(resolve => {
    chrome.storage.sync.get([DISABLED_BUILTIN_ORIGINS_STORAGE_KEY], result => {
      const stored = result?.[DISABLED_BUILTIN_ORIGINS_STORAGE_KEY];
      resolve(
        Array.isArray(stored)
          ? stored.filter((item): item is string => typeof item === 'string')
          : [],
      );
    });
  });
}

export function setDisabledBuiltinOrigins(origins: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(
      {
        [DISABLED_BUILTIN_ORIGINS_STORAGE_KEY]: dedupeOrigins(origins),
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      },
    );
  });
}

export function getAgentAllowAllDomains(): Promise<boolean> {
  return new Promise(resolve => {
    chrome.storage.sync.get([AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY], result => {
      resolve(result?.[AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY] === true);
    });
  });
}

export function setAgentAllowAllDomains(enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(
      {
        [AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY]: enabled,
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      },
    );
  });
}

export function requestAgentOriginPermission(origin: string): Promise<boolean> {
  return new Promise(resolve => {
    chrome.permissions.request({ origins: [origin] }, granted => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve(false);
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

export function requestAgentAllDomainsPermission(): Promise<boolean> {
  return requestAgentOriginPermission(ALL_URLS_ORIGIN);
}

export async function grantAgentOriginPermission(origin: string): Promise<boolean> {
  if (!(await requestAgentOriginPermission(origin))) return false;
  const current = await getAllStoredAgentOrigins();
  if (!current.includes(origin)) {
    await setStoredAgentOrigins([...current, origin]);
  }
  return true;
}

export function setStoredAgentOrigins(origins: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(
      {
        [PROXY_PERMISSION_STORAGE_KEY]: dedupeOrigins(origins),
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      },
    );
  });
}

export function getAgentAllowedOrigins(): Promise<string[]> {
  return getStoredAgentOrigins();
}

export async function isAgentDomainAuthorized(domain: string): Promise<boolean> {
  if (await getAgentAllowAllDomains()) return true;
  const origins = await getAgentAllowedOrigins();
  return origins.some(origin => isOriginAllowedByDomain(origin, domain));
}
