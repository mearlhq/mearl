import {
  TAB_CUSTOM_TIMEZONES,
  normalizeTabPageOverrides,
  tabPageOverridesStorageKey,
  type TabCustomTimezone,
  type TabPageOverrides,
} from '../../shared/tabPageOverrides';
import { disableTimezoneForTab, enableTimezoneForTab } from './debuggerManager';
import { runSerializedQuickSimulationUpdate } from './quickSimulationUpdateQueue';
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
): chrome.declarativeNetRequest.Rule[] {
  const config = {
    ...(userAgent ? { ua: userAgent } : {}),
    ...(timeOverride?.offsetMs !== null && timeOverride?.offsetMs !== undefined
      ? { time: timeOverride }
      : {}),
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
): Promise<void> {
  await runRuleUpdateExclusive(async () => {
    await ensurePageOverrideRulesHydrated();
    const previousRuleId = pageConfigRuleIdsByTab.get(tabId);
    if (!userAgent && timeOverride?.offsetMs == null) {
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
      addRules: buildPageOverrideRules(tabId, ruleId, userAgent, timeOverride),
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

export async function getTabPageOverrides(tabId: number): Promise<TabPageOverrides> {
  const key = tabPageOverridesStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return normalizeTabPageOverrides(stored[key]);
}

export async function updateTabPageOverrides(
  tabId: number,
  patch: unknown,
): Promise<TabPageOverrides> {
  const update = () => runTabUpdateExclusive(tabId, async () => {
    const previous = await getTabPageOverrides(tabId);
    const validatedPatch = validatePatch(patch);
    const next = normalizeTabPageOverrides({ ...previous, ...validatedPatch });
    const effectiveUserAgent = next.customUserAgentEnabled ? next.customUserAgent.trim() : '';
    const timeChanged = previous.customTime !== next.customTime;
    let timeOverride = await getTimeOverrideForTab(tabId);
    let shouldNotifyTime = false;

    if (previous.customTimezone !== next.customTimezone) {
      if (next.customTimezone) {
        await enableTimezoneForTab(tabId, next.customTimezone, 'settings');
      } else {
        await disableTimezoneForTab(tabId, 'settings');
      }
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
    await syncTabPageOverrideRules(tabId, effectiveUserAgent, timeOverride);
    if (shouldNotifyTime && timeOverride) await sendTimeOverrideForTab(tabId, timeOverride);

    await chrome.storage.session.set({ [tabPageOverridesStorageKey(tabId)]: next });
    return next;
  });
  return patch && typeof patch === 'object' && Object.hasOwn(patch, 'customTimezone')
    ? runSerializedQuickSimulationUpdate(tabId, update)
    : update();
}

export async function ensureTabPageOverridesApplied(tabId: number): Promise<void> {
  await runTabUpdateExclusive(tabId, async () => {
    const overrides = await getTabPageOverrides(tabId);
    const userAgent = overrides.customUserAgentEnabled ? overrides.customUserAgent.trim() : '';
    let timeOverride = await getTimeOverrideForTab(tabId);
    let shouldNotifyTime = false;
    if (overrides.customTimezone) {
      await enableTimezoneForTab(tabId, overrides.customTimezone, 'settings');
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
    await syncTabPageOverrideRules(tabId, userAgent, timeOverride);
    if (shouldNotifyTime && timeOverride) await sendTimeOverrideForTab(tabId, timeOverride);
  });
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
      syncTabPageOverrideRules(tabId, '', null),
      chrome.storage.session.remove(tabPageOverridesStorageKey(tabId)),
    ]);
  });
}
