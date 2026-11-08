/**
 * Shared DNR (declarativeNetRequest) utilities for temporary header injection.
 *
 * ID ranges in background:
 * - redirect rules:  800000–899999
 * - CONFIG rule:     999999  ← 全局配置（SSE / 环境切换等），base64 JSON via Server-Timing
 * - COLLECT rule:    999998  ← Agent 采集模式（session rule，按 tabIds）
 * - CHAT TABS rule:  999997  ← 侧边栏对话允许页面创建关联 Tab
 * - temp injection:  900000–998999  ← this module (session rules)
 */

import {
  getSendRequestSourceHeaders,
  findSendRequestHeaderName,
  filterCookiesForUrl,
  serializeRequestCookies,
  type RequestCookie,
} from '@mearl/browser-core';
import { getChromiumMajorVersion } from '../../../shared/chromiumVersion';

export const CONFIG_RULE_ID = 999999;
export const COLLECT_DNR_RULE_ID = 999998;
export const AGENT_CHAT_ALLOW_NEW_TABS_DNR_RULE_ID = 999997;

const DNR_RULE_ID_START = 900000;
const DNR_RULE_ID_END = 998999;
let dnrRuleCursor = DNR_RULE_ID_START;
const activeTempDnrRuleIds = new Set<number>();
const tempHeaderQueues = new Map<string, Promise<void>>();
let staleTempRulesCleanup: Promise<void> | null = null;

/** Same-origin requests must finish cleanup before the next request installs its headers. */
async function acquireTempHeaderOrigin(origin: string): Promise<() => void> {
  const previous = tempHeaderQueues.get(origin);
  let unlock!: () => void;
  const tail = new Promise<void>(resolve => {
    unlock = resolve;
  });
  tempHeaderQueues.set(origin, tail);
  await previous;
  return () => {
    unlock();
    if (tempHeaderQueues.get(origin) === tail) tempHeaderQueues.delete(origin);
  };
}

// Temporary headers can outlive a service worker; old dynamic rules also survive extension updates.
async function ensureStaleTempRulesCleaned(): Promise<void> {
  if (!staleTempRulesCleanup) {
    staleTempRulesCleanup = (async () => {
      const [dynamicRules, sessionRules] = await Promise.all([
        chrome.declarativeNetRequest.getDynamicRules(),
        chrome.declarativeNetRequest.getSessionRules(),
      ]);
      const staleIds = (rules: chrome.declarativeNetRequest.Rule[]) =>
        rules
          .filter(
            rule =>
              rule.id >= DNR_RULE_ID_START &&
              rule.id <= DNR_RULE_ID_END &&
              !activeTempDnrRuleIds.has(rule.id),
          )
          .map(rule => rule.id);
      const staleDynamicIds = staleIds(dynamicRules);
      const staleSessionIds = staleIds(sessionRules);
      await Promise.all([
        ...(staleDynamicIds.length > 0
          ? [chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: staleDynamicIds })]
          : []),
        ...(staleSessionIds.length > 0
          ? [chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: staleSessionIds })]
          : []),
      ]);
    })().catch(error => {
      staleTempRulesCleanup = null;
      throw error;
    });
  }
  await staleTempRulesCleanup;
}

function allocateTempDnrRuleId(): number {
  const maxAttempts = DNR_RULE_ID_END - DNR_RULE_ID_START + 1;
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = dnrRuleCursor;
    dnrRuleCursor = candidate >= DNR_RULE_ID_END ? DNR_RULE_ID_START : candidate + 1;
    if (!activeTempDnrRuleIds.has(candidate)) {
      activeTempDnrRuleIds.add(candidate);
      return candidate;
    }
  }
  throw new Error('No available temporary DNR rule id');
}

function releaseTempDnrRuleId(ruleId: number): void {
  activeTempDnrRuleIds.delete(ruleId);
}

export async function cleanupTempDnrRule(dnrRuleId: number): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [dnrRuleId] });
  } catch (err) {
    staleTempRulesCleanup = null;
    console.warn('[DNR] Failed to clean temporary rule:', err);
  } finally {
    releaseTempDnrRuleId(dnrRuleId);
  }
}

/**
 * Installs a short-lived DNR MODIFY_HEADERS rule that injects the given request
 * headers for the exact request URL initiated by this extension. Redirects use
 * Chrome's cookie matching and can pick up cookies refreshed by the previous hop.
 * Returns the allocated rule ID so the caller can clean it up in a `finally` block.
 */
export async function setupTempHeaderInjection(
  targetUrl: URL,
  requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[],
): Promise<number> {
  await ensureStaleTempRulesCleaned();
  const dnrRuleId = allocateTempDnrRuleId();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [dnrRuleId],
      addRules: [
        {
          id: dnrRuleId,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders,
          },
          condition: {
            regexFilter: `^${targetUrl.href.split('#')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            isUrlFilterCaseSensitive: true,
            initiatorDomains: [chrome.runtime.id],
          },
        },
      ],
    });
    return dnrRuleId;
  } catch (error) {
    staleTempRulesCleanup = null;
    releaseTempDnrRuleId(dnrRuleId);
    throw error;
  }
}

// ─── Cookie collection ────────────────────────────────────────────────────────

/** Chrome normalizes the origin to a schemeful site and filters the requested cookie partition. */
export async function collectCookies(targetUrl: URL): Promise<chrome.cookies.Cookie[]> {
  const chromeMajor = getChromiumMajorVersion();
  const partitionKey = {
    topLevelSite: targetUrl.origin,
    ...(chromeMajor < 130 ? {} : { hasCrossSiteAncestor: false }),
  };
  const [ordinary, partitioned] = await Promise.all([
    chrome.cookies.getAll({ url: targetUrl.href }),
    chrome.cookies.getAll({
      url: targetUrl.href,
      partitionKey,
    }),
  ]);
  return filterCookiesForUrl(
    [
      ...ordinary.filter(cookie => cookie.partitionKey === undefined),
      ...partitioned.filter(cookie => cookie.partitionKey !== undefined),
    ],
    targetUrl.href,
  ).sort((left, right) => right.path.length - left.path.length);
}

/**
 * Builds the Cookie ModifyHeaderInfo entry for the given URL.
 * Returns `null` when no cookies are found.
 */
export async function buildCookieHeader(
  targetUrl: URL,
  collected?: readonly RequestCookie[],
): Promise<chrome.declarativeNetRequest.ModifyHeaderInfo | null> {
  const cookies = collected ?? (await collectCookies(targetUrl));
  if (cookies.length === 0) return null;

  return {
    header: 'Cookie',
    operation: chrome.declarativeNetRequest.HeaderOperation.SET,
    value: serializeRequestCookies(cookies),
  };
}

// ─── DNR header building ──────────────────────────────────────────────────────

/**
 * Constructs the standard DNR headers array (Referer + Origin + Cookie),
 * with optional auto-injection of X-XSRF-TOKEN from the cookie map.
 */
export function buildDnrHeaders(
  targetUrl: URL,
  cookies?: readonly RequestCookie[],
  skipXsrfHeader = false,
  requestHeaders: Record<string, string> = {},
): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  const sourceHeaders = getSendRequestSourceHeaders(targetUrl, requestHeaders);
  const headers: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];

  if (sourceHeaders.referer) {
    headers.push({
      header: 'Referer',
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value: sourceHeaders.referer,
    });
  } else if (findSendRequestHeaderName(requestHeaders, 'Referer')) {
    headers.push({
      header: 'Referer',
      operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
    });
  }

  if (sourceHeaders.origin) {
    headers.push({
      header: 'Origin',
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value: sourceHeaders.origin,
    });
  } else if (findSendRequestHeaderName(requestHeaders, 'Origin')) {
    headers.push({
      header: 'Origin',
      operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
    });
  }

  if (cookies !== undefined) {
    headers.push({
      header: 'Cookie',
      operation: cookies.length
        ? chrome.declarativeNetRequest.HeaderOperation.SET
        : chrome.declarativeNetRequest.HeaderOperation.REMOVE,
      ...(cookies.length ? { value: serializeRequestCookies(cookies) } : {}),
    });

    if (!skipXsrfHeader) {
      const xsrfTokenValue = cookies.find(cookie => cookie.name === 'XSRF-TOKEN')?.value;
      if (xsrfTokenValue) {
        headers.push({
          header: 'X-XSRF-TOKEN',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: xsrfTokenValue,
        });
      }
    }
  }

  return headers;
}

// ─── DNR fetch wrappers ───────────────────────────────────────────────────────

/**
 * Wraps a fetch call with temporary DNR header injection and automatic cleanup.
 * Same-origin requests share an exclusive queue through cleanup, including fallback requests.
 */
export async function fetchWithDnr<T>(
  targetUrl: URL,
  dnrHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[],
  fetchFn: () => Promise<T>,
): Promise<T> {
  const release = await acquireTempHeaderOrigin(targetUrl.origin);
  let dnrRuleId: number | null = null;
  try {
    try {
      dnrRuleId = await setupTempHeaderInjection(targetUrl, dnrHeaders);
    } catch (error) {
      console.warn('[fetchWithDnr] Failed to set up DNR injection rule:', error);
    }
    return await fetchFn();
  } finally {
    try {
      if (dnrRuleId !== null) await cleanupTempDnrRule(dnrRuleId);
    } finally {
      release();
    }
  }
}

/**
 * Convenience wrapper: collects cookies, builds DNR headers (Referer + Origin
 * + Cookie + X-XSRF-TOKEN), injects them via a temporary DNR rule, runs `fn`,
 * then removes the rule.
 */
export async function withCookieInjection<T>(targetUrl: URL, fn: () => Promise<T>): Promise<T> {
  const cookies = await collectCookies(targetUrl);
  const dnrHeaders = buildDnrHeaders(targetUrl, cookies);
  return fetchWithDnr(targetUrl, dnrHeaders, fn);
}
