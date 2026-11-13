/**
 * Proxy/cookie domain permission utilities — pure functions, no chrome.* or storage deps.
 */

export interface DomainPermissionFailure {
  code: 'DOMAIN_PERMISSION_REQUIRED';
  action: string;
  domain: string;
  requestDispatched: false;
}

export class DomainPermissionError extends Error implements DomainPermissionFailure {
  readonly code = 'DOMAIN_PERMISSION_REQUIRED';
  readonly requestDispatched = false;

  constructor(
    readonly action: string,
    readonly domain: string,
    message = `${action}: Access to "${domain}" is not authorized. Request user authorization, then retry:\nmearl request_permission --payload '${JSON.stringify({ domain }).replace(/'/g, "'\\''")}'`,
  ) {
    super(message);
    this.name = 'DomainPermissionError';
  }
}

export const ALLOWED_ORIGINS = ['*://localhost/*', '*://127.0.0.1/*'] as const;

export const ALLOWED_ORIGINS_LIST: string[] = [...ALLOWED_ORIGINS];

function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

export function normalizeDomainInputToOrigin(input: string): string | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/^\*:\/\/(?:\*\.)?/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  if (
    !normalized ||
    normalized.includes('*') ||
    normalized.includes(':') ||
    /[\s?#]/.test(normalized)
  ) {
    return null;
  }

  const isIPv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized);
  const shouldUseWildcard = normalized.includes('.') && !isIPv4 && normalized !== 'localhost';
  const host = shouldUseWildcard ? `*.${normalized}` : normalized;
  return `*://${host}/*`;
}

export function isOriginAllowedByDomain(origin: string, domain: string): boolean {
  const normalizedDomain = normalizeHost(domain);
  if (!normalizedDomain) return false;

  const wildcardMatch = origin.match(/^\*:\/\/\*\.(.+)\/\*$/);
  if (wildcardMatch) {
    const suffix = normalizeHost(wildcardMatch[1]);
    return normalizedDomain === suffix || normalizedDomain.endsWith(`.${suffix}`);
  }

  const exactMatch = origin.match(/^\*:\/\/(.+)\/\*$/);
  if (exactMatch) {
    const target = normalizeHost(exactMatch[1]);
    return normalizedDomain === target;
  }

  return false;
}

/**
 * Checks whether a given domain is covered by any of the provided allowed origins.
 */
export function isDomainAuthorized(domain: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some(origin => isOriginAllowedByDomain(origin, domain));
}

/**
 * Extract the top-level registrable domain from a hostname.
 * e.g. "preview.example.com" → "example.com"
 */
// ─── Agent action domain-check classification ────────────────────────────────

/**
 * Actions that never require domain authorization: either meta/utility
 * actions, internal-only actions, read-only tab enumerations, or composite
 * wrappers whose individual steps are checked independently.
 */
export const ACTIONS_SKIP_DOMAIN_CHECK = new Set([
  'request_permission',
  'get_browser_info',
  'get_capabilities',
  '__export_cookies',
  'run_actions',
  '__control_release',
  '__control_cleanup',
  '__control_deactivate',
  // The recording handler authorizes the recorded tab and its navigation history.
  '__page_record',
  '__page_record_status',
  '__toolbox_open',
  '__extension_reload',
  '__preset_browser',
  '__profile_install',
  // tab_list is a read-only enumeration; sensitive operations on specific
  // tabs (page_eval, send_request, etc.) are still individually checked.
  'tab_list',
  // Grouping only changes Chrome's tab strip and does not access page contents.
  'tab_group',
]);

/**
 * Actions whose target domain is derived from a URL parameter in the action
 * payload rather than the current browser tab. All other domain-checked
 * actions resolve the domain from the active/specified tab's URL.
 */
export const URL_PARAM_ACTIONS = new Set(['send_request', '__send_request_files', 'tab_open']);

/**
 * Returns true if the given agent action requires domain authorization.
 */
export function actionRequiresDomainCheck(action: string): boolean {
  return !ACTIONS_SKIP_DOMAIN_CHECK.has(action);
}

export function getTopLevelDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const knownSecondLevel = new Set(['co', 'com', 'org', 'net', 'edu', 'gov', 'ac', 'mil']);
  const secondLast = parts[parts.length - 2];
  if (knownSecondLevel.has(secondLast) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}
