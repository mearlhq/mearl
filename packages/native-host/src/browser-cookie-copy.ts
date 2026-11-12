import type { BuiltinBrowserLaunchOptions } from './builtin-provider-options.js';
import { nativeCapabilities } from './native-capability-services.js';

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
export function resolveCookieCopyPlan(
  input: BuiltinBrowserLaunchOptions['copyCookieDomains'],
): CookieCopyPlan {
  if (
    input === null ||
    (input !== undefined && typeof input !== 'string' && typeof input !== 'object')
  )
    throw new Error('copyCookieDomains must be an array, a preset name, or a scope object');

  const scope = input && typeof input === 'object' && !Array.isArray(input) ? input : undefined;
  if (
    scope?.presets !== undefined &&
    (!Array.isArray(scope.presets) ||
      scope.presets.some(value => typeof value !== 'string' || !value.trim()))
  )
    throw new Error('Invalid cookie-domain presets');

  if (typeof input === 'string' || (scope?.presets?.length ?? 0) > 0) {
    return nativeCapabilities.require('cookie.copyPlan')(input);
  }
  const domains = normalizeCookieDomains(Array.isArray(input) ? input : (scope?.domains ?? []));
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
