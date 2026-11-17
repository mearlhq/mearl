import {
  TAB_CUSTOM_TIMEZONES,
  normalizeTabPageOverrides,
  tabPageOverridesStorageKey,
  type TabCustomTimezone,
  type TabPageOverrides,
} from '../../shared/tabPageOverrides';
import { disableTimezoneForTab, enableTimezoneForTab } from './debuggerManager';
import { ensureContentScriptsForOrigins } from './contentScriptRegistrar';
import { getTabFrameIds } from './frameMessaging';
import { runSerializedQuickSimulationUpdate } from './quickSimulationUpdateQueue';
import { getSimulationSitePattern, getSimulationSiteUrl } from '../../shared/permissionRequest';
import {
  disableTimeForTab,
  enableTimeForTab,
  getTimeOverrideForTab,
  sendTimeOverrideForTab,
  type PageTimeOverride,
} from './pageTimeOverride';

// 页面设置按 tabId 存入 storage.session。session DNR 的文档响应规则在 document_start
// 前传递页面配置；UA 请求规则独立覆盖该 tab 的全部请求头。
// 999701–999799 与 App Profile(999800+) 和环境切换(999900+) 的规则区间互不重叠。
const TAB_PAGE_OVERRIDE_SERVER_TIMING_KEY = 'mearl-tab-page-override';
const TAB_PAGE_CONFIG_RULE_ID_START = 999701;
const TAB_PAGE_CONFIG_RULE_ID_END = 999749;
const TAB_UA_RULE_ID_OFFSET = 50;
const ALLOWED_TIMEZONES = new Set<TabCustomTimezone>(TAB_CUSTOM_TIMEZONES);

interface PageTimezoneOverride {
  timezone: TabCustomTimezone;
  revision: number;
}

export class PageTimezoneSiteAccessError extends Error {
  constructor(readonly origin: string) {
    super('Site access is required to simulate the page timezone');
  }
}

const pageConfigRuleIdsByTab = new Map<number, number>();
let pageConfigRuleIdCursor = TAB_PAGE_CONFIG_RULE_ID_START;
let hydrationPromise: Promise<void> | null = null;
let ruleQueue: Promise<unknown> = Promise.resolve();
const tabUpdateQueues = new Map<number, Promise<unknown>>();

function runRuleUpdateExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = ruleQueue.then(operation, operation);
  ruleQueue = result.catch(() => {});
  return result;
}

async function runTabUpdateExclusive<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = tabUpdateQueues.get(tabId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  tabUpdateQueues.set(tabId, result);
  try {
    return await result;
  } finally {
    if (tabUpdateQueues.get(tabId) === result) tabUpdateQueues.delete(tabId);
  }
}

function encodeConfig(config: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(config))));
}

async function ensurePageOverrideRulesHydrated(): Promise<void> {
  hydrationPromise ??= chrome.declarativeNetRequest
    .getSessionRules()
    .then(rules => {
      for (const rule of rules) {
        if (rule.id < TAB_PAGE_CONFIG_RULE_ID_START || rule.id > TAB_PAGE_CONFIG_RULE_ID_END) {
          continue;
        }
        const tabId = rule.condition.tabIds?.[0];
        if (tabId !== undefined) pageConfigRuleIdsByTab.set(tabId, rule.id);
      }
    })
    .catch(error => {
      hydrationPromise = null;
      throw error;
    });
  await hydrationPromise;
}

function allocatePageConfigRuleId(): number {
  const used = new Set(pageConfigRuleIdsByTab.values());
  const maxAttempts = TAB_PAGE_CONFIG_RULE_ID_END - TAB_PAGE_CONFIG_RULE_ID_START + 1;
  for (let index = 0; index < maxAttempts; index += 1) {
    const candidate = pageConfigRuleIdCursor;
    pageConfigRuleIdCursor =
      candidate >= TAB_PAGE_CONFIG_RULE_ID_END ? TAB_PAGE_CONFIG_RULE_ID_START : candidate + 1;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('No available per-tab page override DNR rule id');
}

function buildPageOverrideRules(
  tabId: number,
  configRuleId: number,
  userAgent: string,
  timeOverride: PageTimeOverride | null,
  timezoneOverride: PageTimezoneOverride | null,
): chrome.declarativeNetRequest.Rule[] {
  const config = {
    ...(userAgent ? { ua: userAgent } : {}),
    ...(timeOverride?.offsetMs !== null && timeOverride?.offsetMs !== undefined
      ? { time: timeOverride }
      : {}),
    ...(timezoneOverride?.timezone ? { timezone: timezoneOverride } : {}),
  };
  const rules: chrome.declarativeNetRequest.Rule[] = [
    {
      id: configRuleId,
      priority: 90,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        responseHeaders: [
          {
            header: 'server-timing',
            operation: 'append' as chrome.declarativeNetRequest.HeaderOperation,
            value: `${TAB_PAGE_OVERRIDE_SERVER_TIMING_KEY};desc="${encodeConfig(config)}"`,
          },
        ],
      },
      condition: {
        resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
        tabIds: [tabId],
      },
    },
  ];
  if (userAgent) {
    rules.push({
      id: configRuleId + TAB_UA_RULE_ID_OFFSET,
      priority: 90,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: 'user-agent',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: userAgent,
          },
        ],
      },
      condition: { tabIds: [tabId] },
    });
  }
  return rules;
}

async function syncTabPageOverrideRules(
  tabId: number,
  userAgent: string,
  timeOverride: PageTimeOverride | null,
  timezoneOverride: PageTimezoneOverride | null,
): Promise<void> {
  await runRuleUpdateExclusive(async () => {
    await ensurePageOverrideRulesHydrated();
    const previousRuleId = pageConfigRuleIdsByTab.get(tabId);
    if (!userAgent && timeOverride?.offsetMs == null && !timezoneOverride?.timezone) {
      if (previousRuleId === undefined) return;
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [previousRuleId, previousRuleId + TAB_UA_RULE_ID_OFFSET],
      });
      pageConfigRuleIdsByTab.delete(tabId);
      return;
    }

    const ruleId = previousRuleId ?? allocatePageConfigRuleId();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId, ruleId + TAB_UA_RULE_ID_OFFSET],
      addRules: buildPageOverrideRules(tabId, ruleId, userAgent, timeOverride, timezoneOverride),
    });
    pageConfigRuleIdsByTab.set(tabId, ruleId);
  });
}

function validatePatch(patch: unknown): Partial<TabPageOverrides> {
  if (!patch || typeof patch !== 'object') throw new Error('Invalid page override patch');
  const input = patch as Record<string, unknown>;
  const result: Partial<TabPageOverrides> = {};
  if ('customUserAgent' in input) {
    if (typeof input.customUserAgent !== 'string') throw new Error('Invalid User-Agent');
    result.customUserAgent = input.customUserAgent;
  }
  if ('customUserAgentEnabled' in input) {
    if (typeof input.customUserAgentEnabled !== 'boolean') {
      throw new Error('Invalid User-Agent state');
    }
    result.customUserAgentEnabled = input.customUserAgentEnabled;
  }
  if ('customTimezone' in input) {
    if (!ALLOWED_TIMEZONES.has(input.customTimezone as TabCustomTimezone)) {
      throw new Error('Invalid timezone');
    }
    result.customTimezone = input.customTimezone as TabCustomTimezone;
  }
  if ('customTime' in input) {
    if (
      input.customTime !== null &&
      (typeof input.customTime !== 'number' || !Number.isFinite(input.customTime))
    ) {
      throw new Error('Invalid custom time');
    }
    result.customTime = input.customTime as number | null;
  }
  return result;
}

export function isTabPageOverrideRuleId(ruleId: number): boolean {
  return (
    (ruleId >= TAB_PAGE_CONFIG_RULE_ID_START && ruleId <= TAB_PAGE_CONFIG_RULE_ID_END) ||
    (ruleId >= TAB_PAGE_CONFIG_RULE_ID_START + TAB_UA_RULE_ID_OFFSET &&
      ruleId <= TAB_PAGE_CONFIG_RULE_ID_END + TAB_UA_RULE_ID_OFFSET)
  );
}

async function readTabPageOverrides(tabId: number) {
  const key = tabPageOverridesStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key] as
    | (TabPageOverrides & {
        pageTimezone?: PageTimezoneOverride | null;
      })
    | undefined;
  return { overrides: normalizeTabPageOverrides(value), pageTimezone: value?.pageTimezone ?? null };
}

export async function getTabPageOverrides(tabId: number): Promise<TabPageOverrides> {
  return (await readTabPageOverrides(tabId)).overrides;
}

export async function getPageTimezoneOverride(tabId: number): Promise<PageTimezoneOverride | null> {
  // A new document can start between the live update and the navigation rule being saved.
  return runTabUpdateExclusive(tabId, async () => (await readTabPageOverrides(tabId)).pageTimezone);
}

export async function getNativeTimezoneSetting(tabId: number): Promise<string | undefined> {
  const { overrides, pageTimezone } = await readTabPageOverrides(tabId);
  return pageTimezone ? undefined : overrides.customTimezone || undefined;
}

async function getTabSitePattern(tabId: number): Promise<string | undefined> {
  const rawUrl =
    (await chrome.tabs.get(tabId)).url ??
    (await chrome.webNavigation.getFrame({ tabId, frameId: 0 }))?.url;
  const url = rawUrl && getSimulationSiteUrl(rawUrl);
  return url ? getSimulationSitePattern(url) : undefined;
}

async function applyPageTimezone(tabId: number, override: PageTimezoneOverride): Promise<void> {
  if (override.timezone) {
    const origin = await getTabSitePattern(tabId);
    if (!origin) throw new Error('Timezone simulation requires an HTTP or HTTPS page');
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      throw new PageTimezoneSiteAccessError(origin);
    }
    const { origins = [] } = await chrome.permissions.getAll();
    await ensureContentScriptsForOrigins(origins);
  }
  const applyToFrame = async (frameId: number) => {
    const injection = {
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN' as const,
      injectImmediately: true,
    };
    const apply = () =>
      chrome.scripting.executeScript({
        ...injection,
        func: (timezone: string, revision: number) =>
          window.__mearlApplyPageTimezone__?.(timezone, revision),
        args: [override.timezone, override.revision],
      });
    let [result] = await apply();
    if (result?.result == null && override.timezone) {
      // Open documents can predate registration or an extension update.
      await chrome.scripting.executeScript({
        ...injection,
        files: ['src/pages/content-script/early-inject.js'],
      });
      [result] = await apply();
    }
    if (override.timezone && result?.result !== true) {
      throw new Error('Page timezone simulation is unavailable');
    }
  };

  if (override.timezone) await applyToFrame(0);
  else await applyToFrame(0).catch(() => {});
  const frames = await getTabFrameIds(tabId);
  // Cross-origin frames may require their own site access.
  await Promise.allSettled(frames.filter(id => id !== 0).map(applyToFrame));
}

async function updateTimezone(
  tabId: number,
  timezone: TabCustomTimezone,
  previous: PageTimezoneOverride | null,
): Promise<PageTimezoneOverride | null> {
  if (!previous) {
    try {
      if (timezone) await enableTimezoneForTab(tabId, timezone, 'settings');
      else await disableTimezoneForTab(tabId, 'settings');
      return null;
    } catch (error) {
      if (!String(error).includes('Timezone override is only available to trusted clients'))
        throw error;
    }
  }
  const next = { timezone, revision: (previous?.revision ?? 0) + 1 };
  await applyPageTimezone(tabId, next);
  return next;
}

export async function updateTabPageOverrides(
  tabId: number,
  patch: unknown,
  expectedSite?: string,
): Promise<TabPageOverrides> {
  const update = () =>
    runTabUpdateExclusive(tabId, async () => {
      if (expectedSite && (await getTabSitePattern(tabId)) !== expectedSite) {
        throw new Error('The tab changed sites while requesting access');
      }
      const { overrides: previous, pageTimezone: previousPageTimezone } =
        await readTabPageOverrides(tabId);
      const validatedPatch = validatePatch(patch);
      const next = normalizeTabPageOverrides({ ...previous, ...validatedPatch });
      const effectiveUserAgent = next.customUserAgentEnabled ? next.customUserAgent.trim() : '';
      const timeChanged = previous.customTime !== next.customTime;
      let timeOverride = await getTimeOverrideForTab(tabId);
      let shouldNotifyTime = false;

      let pageTimezone = previousPageTimezone;
      if (validatedPatch.customTimezone !== undefined) {
        pageTimezone = await updateTimezone(tabId, next.customTimezone, previousPageTimezone);
      }
      if (next.customTime === null) {
        if (timeChanged || timeOverride?.offsetMs != null) {
          timeOverride = await disableTimeForTab(tabId, false);
          shouldNotifyTime = true;
        }
      } else if (timeChanged || timeOverride?.offsetMs == null) {
        timeOverride = await enableTimeForTab(tabId, next.customTime, false);
        shouldNotifyTime = true;
      }
      const key = tabPageOverridesStorageKey(tabId);
      try {
        await syncTabPageOverrideRules(tabId, effectiveUserAgent, timeOverride, pageTimezone);
        await chrome.storage.session.set({
          [key]: pageTimezone ? { ...next, pageTimezone } : next,
        });
      } catch (error) {
        if (pageTimezone && pageTimezone !== previousPageTimezone) {
          const restored = {
            timezone: previousPageTimezone?.timezone ?? '',
            revision: pageTimezone.revision + 1,
          } satisfies PageTimezoneOverride;
          await Promise.allSettled([
            applyPageTimezone(tabId, restored),
            syncTabPageOverrideRules(
              tabId,
              previous.customUserAgentEnabled ? previous.customUserAgent.trim() : '',
              timeOverride,
              restored,
            ),
            chrome.storage.session.set({ [key]: { ...previous, pageTimezone: restored } }),
          ]);
        }
        throw error;
      }
      if (shouldNotifyTime && timeOverride) await sendTimeOverrideForTab(tabId, timeOverride);
      return next;
    });
  return patch && typeof patch === 'object' && Object.hasOwn(patch, 'customTimezone')
    ? runSerializedQuickSimulationUpdate(tabId, update)
    : update();
}

export async function grantTabTimezoneSiteAccess(
  tabId: number,
  patch: unknown,
  origin: string,
): Promise<TabPageOverrides> {
  const url = getSimulationSiteUrl(origin);
  const { customTimezone } = validatePatch(patch);
  if (!url || getSimulationSitePattern(url) !== origin || !customTimezone) {
    throw new Error('Invalid timezone site access request');
  }
  // Request from the click's runtime message so Chrome can close the toolbar popup safely.
  if (!(await chrome.permissions.request({ origins: [origin] }))) {
    throw new PageTimezoneSiteAccessError(origin);
  }
  return updateTabPageOverrides(tabId, { customTimezone }, origin);
}

export async function ensureTabPageOverridesApplied(tabId: number): Promise<void> {
  await runSerializedQuickSimulationUpdate(tabId, () =>
    runTabUpdateExclusive(tabId, async () => {
      const { overrides, pageTimezone } = await readTabPageOverrides(tabId);
      const userAgent = overrides.customUserAgentEnabled ? overrides.customUserAgent.trim() : '';
      let timeOverride = await getTimeOverrideForTab(tabId);
      let shouldNotifyTime = false;
      let restoredTimezone = pageTimezone;
      if (pageTimezone?.timezone) {
        await applyPageTimezone(tabId, pageTimezone).catch(() => {});
      } else if (overrides.customTimezone) {
        restoredTimezone = await updateTimezone(tabId, overrides.customTimezone, null).catch(
          () => pageTimezone,
        );
      }
      if (overrides.customTime === null) {
        if (timeOverride?.offsetMs != null) {
          timeOverride = await disableTimeForTab(tabId, false);
          shouldNotifyTime = true;
        }
      } else if (timeOverride?.offsetMs == null) {
        timeOverride = await enableTimeForTab(tabId, overrides.customTime, false);
        shouldNotifyTime = true;
      }
      await syncTabPageOverrideRules(tabId, userAgent, timeOverride, restoredTimezone);
      if (restoredTimezone !== pageTimezone) {
        await chrome.storage.session.set({
          [tabPageOverridesStorageKey(tabId)]: { ...overrides, pageTimezone: restoredTimezone },
        });
      }
      if (shouldNotifyTime && timeOverride) await sendTimeOverrideForTab(tabId, timeOverride);
    }),
  );
}

export async function disableTabPageOverride(tabId: number, target: unknown): Promise<void> {
  switch (target) {
    case 'userAgent':
      await updateTabPageOverrides(tabId, { customUserAgentEnabled: false });
      return;
    case 'timezone':
      await updateTabPageOverrides(tabId, { customTimezone: '' });
      return;
    case 'pageTime':
      await updateTabPageOverrides(tabId, { customTime: null });
      return;
    default:
      throw new Error('Unknown DNR override');
  }
}

export async function cleanupTabPageOverrides(tabId: number): Promise<void> {
  await runTabUpdateExclusive(tabId, async () => {
    await Promise.all([
      syncTabPageOverrideRules(tabId, '', null, null),
      chrome.storage.session.remove(tabPageOverridesStorageKey(tabId)),
    ]);
  });
}
