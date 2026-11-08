import { CookieJar, domainMatch, pathMatch } from 'tough-cookie';
import { isSecureCookieUrl, type CookieCandidate } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';

export interface ResponseCookieSync {
  updatedCount: number;
  rejectedCount: number;
  failedCount: number;
}

/** Apply response cookies to the same browser context that supplied the request's credentials. */
export async function syncResponseCookies(
  session: PageSession,
  url: string,
  headers: readonly string[],
): Promise<ResponseCookieSync | undefined> {
  if (!headers.length) return undefined;
  // The parser supplies domain validation, default paths, prefix rules and Max-Age precedence.
  const jar = new CookieJar(undefined, { prefixSecurity: 'strict' });
  const result: ResponseCookieSync = { updatedCount: 0, rejectedCount: 0, failedCount: 0 };
  const secureSource = isSecureCookieUrl(new URL(url));
  let storedCookies: CookieCandidate[] | undefined;
  for (const header of headers) {
    const now = new Date();
    const cookie = await jar.setCookie(header, url, { now, ignoreError: true });
    // A URL-only proxy has no partition identity. Never turn a partitioned cookie into a global one.
    if (
      !cookie ||
      (cookie.secure && !secureSource) ||
      (cookie.sameSite === 'none' && !cookie.secure) ||
      cookie.extensions?.some(attribute => /^partitioned(?:\s|=|$)/i.test(attribute))
    ) {
      result.rejectedCount++;
      continue;
    }
    const expires = cookie.expiryTime(now);
    try {
      if (!secureSource) {
        // CDP setters bypass the network stack's protection against insecure Secure-cookie overlays.
        storedCookies ??= (await session.client.sendCommand('Network.getAllCookies')).cookies;
        if (
          storedCookies!.some(
            existing =>
              existing.secure &&
              existing.name === cookie.key &&
              existing.partitionKey === undefined &&
              !existing.partitionKeyOpaque &&
              (domainMatch(existing.domain.replace(/^\./, ''), cookie.domain) ||
                domainMatch(cookie.domain, existing.domain.replace(/^\./, ''))) &&
              pathMatch(cookie.path!, existing.path),
          )
        ) {
          result.rejectedCount++;
          continue;
        }
      }
      const applied = await session.client.sendCommand('Network.setCookie', {
        url,
        name: cookie.key,
        value: cookie.value,
        path: cookie.path,
        ...(cookie.hostOnly ? {} : { domain: `.${cookie.domain}` }),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.sameSite
          ? { sameSite: cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1) }
          : {}),
        ...(expires !== undefined && expires !== Infinity
          ? { expires: Math.max(1, expires / 1000) }
          : {}),
      });
      if (applied.success === false) result.rejectedCount++;
      else result.updatedCount++;
    } catch {
      // The HTTP operation may already have succeeded; report sync failure without inviting a replay.
      result.failedCount++;
    }
  }
  return result;
}
