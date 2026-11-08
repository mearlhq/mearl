import {
  resolveGetCookieTarget,
  resolveSetCookieTarget,
  selectReadableCookie,
  validateRequiredActionTabId,
  type GetCookieParams,
  type GetCookieResult,
  type SetCookieParams,
  type SetCookieResult,
  type SetCookieTarget,
} from '@mearl/browser-core';
import { clearPageRefsForNavigation } from './pageRefs';

interface TransferableCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
  partitionKey?: {
    topLevelSite: string;
    hasCrossSiteAncestor?: boolean;
  };
}

function normalizeDomain(input: unknown): string {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Cookie domain must be a non-empty string');
  try {
    const hostname = new URL(value.includes('://') ? value : `https://${value}`).hostname;
    if (!hostname) throw new Error();
    return hostname.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  } catch {
    throw new Error(`Invalid cookie domain: ${value}`);
  }
}

function mapSameSite(value: chrome.cookies.SameSiteStatus): TransferableCookie['sameSite'] {
  if (value === 'strict') return 'Strict';
  if (value === 'lax') return 'Lax';
  if (value === 'no_restriction') return 'None';
  return undefined;
}

function toTransferableCookie(cookie: chrome.cookies.Cookie): TransferableCookie {
  const sameSite = mapSameSite(cookie.sameSite);
  const partitionKey = (
    cookie as chrome.cookies.Cookie & {
      partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
    }
  ).partitionKey;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(!cookie.session && typeof cookie.expirationDate === 'number'
      ? { expires: cookie.expirationDate }
      : {}),
    ...(partitionKey?.topLevelSite
      ? {
          partitionKey: {
            topLevelSite: partitionKey.topLevelSite,
            ...(typeof partitionKey.hasCrossSiteAncestor === 'boolean'
              ? { hasCrossSiteAncestor: partitionKey.hasCrossSiteAncestor }
              : {}),
          },
        }
      : {}),
  };
}

/** Export selected domains for local transfer into a managed browser. */
export async function handleExportCookies(data: { domains?: unknown } = {}): Promise<any> {
  if (!Array.isArray(data.domains)) throw new Error('domains must be an array');
  const domains = [...new Set(data.domains.map(normalizeDomain))];
  const cookies = new Map<string, TransferableCookie>();

  for (const domain of domains) {
    let domainCookies: chrome.cookies.Cookie[];
    try {
      domainCookies = await chrome.cookies.getAll({ domain });
    } catch (error) {
      throw new Error(
        `Failed to read cookies for "${domain}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const cookie of domainCookies) {
      const transferable = toTransferableCookie(cookie);
      const partition = transferable.partitionKey?.topLevelSite ?? '';
      cookies.set(
        `${transferable.name}\0${transferable.domain}\0${transferable.path}\0${partition}`,
        transferable,
      );
    }
  }

  return { domains, cookies: [...cookies.values()] };
}

async function resolveCookieStoreId(tabId: number): Promise<string> {
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find(store => store.tabIds.includes(tabId));
  if (!store) throw new Error(`Cookie store not found for tab ${tabId}`);
  return store.id;
}

function reloadTabAndWait(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Page load timeout after 30000ms: ${url}`));
    }, 30000);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId).catch(error => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function buildCookieDetails(target: SetCookieTarget, storeId?: string): chrome.cookies.SetDetails {
  return {
    url: target.cookieUrl,
    name: target.cookieName,
    value: target.cookieValue,
    path: target.path,
    secure: target.cookieUrl.startsWith('https:'),
    ...(target.cookieDomain ? { domain: target.cookieDomain } : {}),
    ...(storeId ? { storeId } : {}),
  };
}

export async function handleGetCookie(data: GetCookieParams): Promise<GetCookieResult> {
  validateRequiredActionTabId('get_cookie', data);
  const tabId = data.tabId;
  const tab = tabId !== undefined ? await chrome.tabs.get(tabId) : undefined;
  const target = resolveGetCookieTarget(tab?.url, data);
  const storeId = tabId !== undefined ? await resolveCookieStoreId(tabId) : undefined;
  const cookies = await chrome.cookies.getAll({
    url: target.cookieUrl,
    name: target.cookieName,
    ...(storeId ? { storeId } : {}),
  });
  const cookie = selectReadableCookie(cookies, target);

  return {
    ...(tabId !== undefined ? { tabId } : {}),
    url: data.url ? target.cookieUrl : (tab?.url ?? target.cookieUrl),
    name: target.cookieName,
    found: Boolean(cookie),
    ...(cookie
      ? {
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
        }
      : {}),
  };
}

export async function handleSetCookie(data: SetCookieParams): Promise<SetCookieResult> {
  validateRequiredActionTabId('set_cookie', data);
  const tabId = data.tabId;
  const tab = tabId !== undefined ? await chrome.tabs.get(tabId) : undefined;
  const target = resolveSetCookieTarget(tab?.url, data);
  const storeId = tabId !== undefined ? await resolveCookieStoreId(tabId) : undefined;
  const cookie = await chrome.cookies.set(buildCookieDetails(target, storeId));
  if (!cookie || cookie.value !== target.cookieValue) {
    throw new Error(`set_cookie: failed to set ${target.cookieName}`);
  }

  if (target.reload && tabId !== undefined) {
    clearPageRefsForNavigation(tabId);
    await reloadTabAndWait(tabId, tab?.url ?? target.cookieUrl);
  }

  return {
    ...(tabId !== undefined ? { tabId } : {}),
    url: data.url ? target.cookieUrl : (tab?.url ?? target.cookieUrl),
    name: target.cookieName,
    domain: target.domain,
    path: target.path,
    reloaded: target.reload,
  };
}
