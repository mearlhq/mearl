import { getPublicSuffix } from 'tough-cookie';
import { filterCookiesForUrl, type CookieCandidate } from '@mearl/browser-core';

/** Background proxy requests use the target URL's first-party, schemeful site. */
export function getRequestCookiePartition(url: string): {
  topLevelSite: string;
  hasCrossSiteAncestor: false;
} {
  const target = new URL(url);
  // tough-cookie includes private suffix rules; ignoreError also accepts local test domains.
  const domain = getPublicSuffix(target.hostname, { ignoreError: true }) ?? target.hostname;
  return { topLevelSite: `${target.protocol}//${domain}`, hasCrossSiteAncestor: false };
}

/** Keep ordinary cookies and only the target site's first-party partition. */
export function selectRequestCookies<T extends CookieCandidate>(
  cookies: readonly T[],
  url: string,
): T[] {
  const partition = getRequestCookiePartition(url);
  return filterCookiesForUrl(cookies, url)
    .filter(cookie => {
      if (cookie.partitionKeyOpaque === true) return false;
      if (cookie.partitionKey === undefined) return true;
      if (!cookie.partitionKey || typeof cookie.partitionKey !== 'object') return false;
      const key = cookie.partitionKey as { topLevelSite?: unknown; hasCrossSiteAncestor?: unknown };
      return (
        key.topLevelSite === partition.topLevelSite &&
        (key.hasCrossSiteAncestor === undefined || key.hasCrossSiteAncestor === false)
      );
    })
    .sort((left, right) => right.path.length - left.path.length);
}
