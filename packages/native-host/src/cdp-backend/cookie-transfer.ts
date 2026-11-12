import {
  cookieMatchesDomain,
  normalizeCookieDomains,
  type TransferableCookie,
} from '../browser-cookie-copy.js';
import type { CdpSession } from './cdp-session.js';

interface CookieCommandClient {
  sendCommand(method: string, params?: Record<string, any>, timeoutMs?: number): Promise<any>;
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
