import type { GetCookieParams, SetCookieParams } from './browserActionProtocol.js';

export interface GetCookieTarget {
  cookieName: string;
  cookieUrl: string;
  domain?: string;
  path?: string;
}

export interface SetCookieTarget {
  cookieName: string;
  cookieValue: string;
  cookieDomain?: string;
  cookieUrl: string;
  domain: string;
  path: string;
  reload: boolean;
}

export interface CookieCandidate {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  partitionKey?: unknown;
  partitionKeyOpaque?: boolean;
}

export type RequestCookie = Pick<CookieCandidate, 'name' | 'value'>;

export function serializeRequestCookies(cookies: readonly RequestCookie[]): string {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Token lookup follows the first (most specific path) occurrence in the Cookie header. */
export function requestCookiesToMap(cookies: readonly RequestCookie[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const cookie of cookies) {
    if (!values.has(cookie.name)) values.set(cookie.name, cookie.value);
  }
  return values;
}

function normalizeCookieDomain(input: string, action: string): string {
  const value = input.trim();
  if (!value) throw new Error(`${action}: "domain" must be a non-empty domain`);

  let hostname: string;
  try {
    hostname = new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    throw new Error(`${action}: invalid domain "${input}"`);
  }

  hostname = hostname.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!hostname) throw new Error(`${action}: invalid domain "${input}"`);
  return hostname;
}

/** Chromium also treats localhost and loopback URLs as trustworthy for Secure cookies. */
export function isSecureCookieUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/\.$/, '');
  const isLocalhost =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname);
  return url.protocol === 'https:' || isLocalhost;
}

/** Filter browser-context storage results to the cookies applicable to the requested URL. */
export function filterCookiesForUrl<T extends CookieCandidate>(
  cookies: readonly T[],
  cookieUrl: string,
): T[] {
  const url = new URL(cookieUrl);
  return cookies.filter(item => {
    const domain = item.domain.replace(/^\./, '').toLowerCase();
    const hostOnly = item.hostOnly ?? !item.domain.startsWith('.');
    if (url.hostname !== domain && (hostOnly || !url.hostname.endsWith(`.${domain}`))) return false;
    if (item.secure && !isSecureCookieUrl(url)) return false;
    return (
      url.pathname === item.path ||
      (url.pathname.startsWith(item.path) &&
        (item.path.endsWith('/') || url.pathname[item.path.length] === '/'))
    );
  });
}

/** Select one readable, non-partitioned named cookie from URL-filtered backend results. */
export function selectReadableCookie<T extends CookieCandidate>(
  cookies: readonly T[],
  target: GetCookieTarget,
): T | undefined {
  const cookie = cookies
    .filter(item => {
      if (
        item.partitionKey !== undefined ||
        item.partitionKeyOpaque === true ||
        item.name !== target.cookieName
      ) {
        return false;
      }
      const domain = item.domain.replace(/^\./, '').toLowerCase();
      if (target.domain && domain !== target.domain) return false;
      if (target.path && item.path !== target.path) return false;
      return true;
    })
    .sort((left, right) => {
      const pathDifference = right.path.length - left.path.length;
      if (pathDifference !== 0) return pathDifference;
      return right.domain.length - left.domain.length;
    })[0];
  if (cookie?.httpOnly) {
    throw new Error(`get_cookie: "${target.cookieName}" is HttpOnly and cannot be read`);
  }
  return cookie;
}

function validateCookieName(input: unknown, action: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`${action}: "name" is required`);
  }
  const name = input.trim();
  if (name.length > 256 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new Error(`${action}: "name" contains unsupported cookie characters`);
  }
  return name;
}

function validateCookieValue(input: unknown): string {
  if (typeof input !== 'string') throw new Error('set_cookie: "value" must be a string');
  const hasUnsupportedCharacter = [...input].some(character => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || character === ';' || character === ',';
  });
  if (input.length > 4096 || hasUnsupportedCharacter) {
    throw new Error('set_cookie: "value" contains unsupported cookie characters');
  }
  return input;
}

function validateCookiePath(input: unknown, action: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !input.startsWith('/')) {
    throw new Error(`${action}: "path" must start with "/"`);
  }
  const hasUnsupportedCharacter = [...input].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === ';';
  });
  if (input.length > 1024 || hasUnsupportedCharacter) {
    throw new Error(`${action}: "path" contains unsupported cookie characters`);
  }
  return input;
}

function parseCurrentUrl(currentUrl: string | undefined, action: string): URL {
  if (!currentUrl) throw new Error(`${action}: specify url or tabId`);
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    throw new Error(`${action}: invalid current page URL "${currentUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${action}: current page must use http or https`);
  }
  return url;
}

function resolveCookieUrl(
  currentUrl: string | undefined,
  input: { url?: string },
  action: string,
): URL {
  if (input.url !== undefined && (typeof input.url !== 'string' || !input.url.trim())) {
    throw new Error(`${action}: "url" must be a non-empty string`);
  }
  const url = parseCurrentUrl(input.url ?? currentUrl, action);
  if (input.url !== undefined && (url.username || url.password)) {
    throw new Error(`${action}: "url" must not contain credentials`);
  }
  return url;
}

function resolveExplicitDomain(url: URL, input: unknown, action: string): string | undefined {
  if (input !== undefined && typeof input !== 'string') {
    throw new Error(`${action}: "domain" must be a string`);
  }
  const explicitDomain =
    typeof input === 'string' && input ? normalizeCookieDomain(input, action) : undefined;
  if (
    explicitDomain &&
    url.hostname.toLowerCase() !== explicitDomain &&
    !url.hostname.toLowerCase().endsWith(`.${explicitDomain}`)
  ) {
    throw new Error(
      `${action}: domain "${explicitDomain}" is not a parent domain of target host "${url.hostname.toLowerCase()}"`,
    );
  }
  return explicitDomain;
}

export function resolveGetCookieTarget(
  currentUrl: string | undefined,
  input: GetCookieParams,
): GetCookieTarget {
  const action = 'get_cookie';
  const url = resolveCookieUrl(currentUrl, input, action);
  const name = validateCookieName(input?.name, action);
  const domain = resolveExplicitDomain(url, input?.domain, action);
  const path = validateCookiePath(input?.path, action);
  return {
    cookieName: name,
    cookieUrl: `${url.protocol}//${url.hostname}${(path ?? url.pathname) || '/'}`,
    ...(domain ? { domain } : {}),
    ...(path ? { path } : {}),
  };
}

export function resolveSetCookieTarget(
  currentUrl: string | undefined,
  input: SetCookieParams,
): SetCookieTarget {
  const action = 'set_cookie';
  const url = resolveCookieUrl(currentUrl, input, action);

  const name = validateCookieName(input?.name, action);
  const value = validateCookieValue(input?.value);
  const path = validateCookiePath(input?.path, action) ?? '/';
  if (input.reload !== undefined && typeof input.reload !== 'boolean') {
    throw new Error('set_cookie: "reload" must be a boolean');
  }
  const explicitDomain = resolveExplicitDomain(url, input?.domain, action);
  const domain = explicitDomain ?? url.hostname.toLowerCase();

  return {
    cookieName: name,
    cookieValue: value,
    ...(explicitDomain
      ? { cookieDomain: explicitDomain.includes('.') ? `.${explicitDomain}` : explicitDomain }
      : {}),
    cookieUrl: `${url.protocol}//${url.hostname.toLowerCase()}${path}`,
    domain,
    path,
    reload: input.reload === true,
  };
}
