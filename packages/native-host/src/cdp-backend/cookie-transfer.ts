import { nativeCapabilities } from '../native-capability-services.js';
/** Cookie export/import helpers for copying selected domains between CDP browsers. */

import type { BuiltinBrowserLaunchOptions } from '../builtin-provider-options.js';
import type { CdpSession } from './cdp-session.js';

export interface TransferableCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
  priority?: 'Low' | 'Medium' | 'High';
  sameParty?: boolean;
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
  sourcePort?: number;
  partitionKey?: {
    topLevelSite: string;
    hasCrossSiteAncestor?: boolean;
  };
}

interface CookieCommandClient {
  sendCommand(method: string, params?: Record<string, any>, timeoutMs?: number): Promise<any>;
}

export function normalizeCookieDomain(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('Cookie domain must be a non-empty string');

  let hostname: string;
  try {
    hostname = new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    throw new Error(`Invalid cookie domain: ${input}`);
  }
  hostname = hostname.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!hostname) throw new Error(`Invalid cookie domain: ${input}`);
  return hostname;
}

export function normalizeCookieDomains(inputs: unknown): string[] {
  if (!Array.isArray(inputs)) throw new Error('copyCookieDomains must be an array of domains');
  return [...new Set(inputs.map(value => normalizeCookieDomain(String(value))))];
}

export interface CookieCopyPlan {
  domains: string[];
  select(cookies: TransferableCookie[]): TransferableCookie[];
}

/** Explicit domains use the generic transport; named scopes belong to installed capabilities. */
export function resolveCookieCopyPlan(input: BuiltinBrowserLaunchOptions['copyCookieDomains']): CookieCopyPlan {
  if (input === null || (input !== undefined && typeof input !== 'string' && typeof input !== 'object')) throw new Error('copyCookieDomains must be an array, a preset name, or a scope object');
  if (input && !Array.isArray(input) && typeof input === 'object' && input.presets !== undefined && (!Array.isArray(input.presets) || input.presets.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('Invalid cookie-domain presets');
  if (typeof input === 'string' || (input && !Array.isArray(input) && typeof input === 'object' && (input.presets?.length ?? 0) > 0)) {
    return nativeCapabilities.require('cookie.copyPlan')(input);
  }
  const domains = normalizeCookieDomains(Array.isArray(input) ? input : input && typeof input === 'object' ? input.domains ?? [] : []);
  return { domains, select: cookies => cookies };
}

export function cookieMatchesDomain(cookieDomain: string, requestedDomain: string): boolean {
  const cookieHost = cookieDomain.toLowerCase().replace(/^\.+/, '');
  return (
    cookieHost === requestedDomain ||
    cookieHost.endsWith(`.${requestedDomain}`) ||
    requestedDomain.endsWith(`.${cookieHost}`)
  );
}

function toTransferableCookie(cookie: any): TransferableCookie {
  const result: TransferableCookie = {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain),
    path: String(cookie.path || '/'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) result.sameSite = cookie.sameSite;
  if (typeof cookie.expires === 'number' && cookie.expires > 0) result.expires = cookie.expires;
  if (['Low', 'Medium', 'High'].includes(cookie.priority)) result.priority = cookie.priority;
  if (typeof cookie.sameParty === 'boolean') result.sameParty = cookie.sameParty;
  if (['Unset', 'NonSecure', 'Secure'].includes(cookie.sourceScheme)) {
    result.sourceScheme = cookie.sourceScheme;
  }
  if (typeof cookie.sourcePort === 'number') result.sourcePort = cookie.sourcePort;
  if (cookie.partitionKey?.topLevelSite) {
    result.partitionKey = {
      topLevelSite: String(cookie.partitionKey.topLevelSite),
      ...(typeof cookie.partitionKey.hasCrossSiteAncestor === 'boolean'
        ? { hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor }
        : {}),
    };
  }
  return result;
}

export async function cdpExportCookies(
  session: CdpSession,
  domains: string[],
): Promise<TransferableCookie[]> {
  const requestedDomains = normalizeCookieDomains(domains);
  const browser = await session.getBrowserClient();
  const result = await browser.sendCommand('Storage.getCookies', {});
  return (result.cookies ?? [])
    .filter((cookie: any) =>
      requestedDomains.some(domain => cookieMatchesDomain(String(cookie.domain), domain)),
    )
    .map(toTransferableCookie);
}

export async function cdpImportCookies(
  session: CdpSession,
  cookies: TransferableCookie[],
): Promise<number> {
  if (cookies.length === 0) return 0;
  const browser = await session.getBrowserClient();
  return cdpImportCookiesWithClient(browser, cookies);
}

export async function cdpImportCookiesWithClient(
  browser: CookieCommandClient,
  cookies: TransferableCookie[],
): Promise<number> {
  if (cookies.length === 0) return 0;
  await browser.sendCommand('Storage.setCookies', { cookies });
  return cookies.length;
}
