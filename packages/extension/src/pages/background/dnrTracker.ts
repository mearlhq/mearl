import { DEV_RULES_STORAGE_KEY, type StoredRuleForm } from '../../shared/devRulesUtils';
import { CONFIG_RULE_ID } from './utils/dnr';
import { NETWORK_RULE_BASE, NETWORK_RULE_MAX } from './networkControlRules';
import { networkControlStorageKey } from '../../shared/browserControl';
import { browserUiText, type BrowserUiText } from '@mearl/preset/bundles';
import { isBrowserRequestLoginRule } from '../../shared/browserRequestUi';
import { getTabPageOverrides, isTabPageOverrideRuleId } from './tabPageOverrides';

export interface DnrDisplayRule {
  label: string;
  count?: number;
  ruleId?: number;
  canDisable: boolean;
  disableTarget?: DnrOverrideDisableTarget;
}

export type DnrOverrideDisableTarget = 'userAgent' | 'timezone' | 'pageTime';

// Per-tab DNR 命中记录: tabId → ruleId → count
const dnrTabMatches = new Map<number, Map<number, number>>();
const dnrNotifyTimers = new Map<number, ReturnType<typeof setTimeout>>();

function resolveDnrRuleLabel(
  ruleId: number,
  dynamicRules: chrome.declarativeNetRequest.Rule[],
  storedForms: StoredRuleForm[],
  controlLabel?: BrowserUiText,
): string | null {
  if (isTabPageOverrideRuleId(ruleId)) return null;
  if (isBrowserRequestLoginRule(ruleId)) return null;
  if (ruleId >= 900000 && ruleId <= 998999) return null;
  if (ruleId >= 799997 && ruleId <= 799999) return null;
  if (ruleId === CONFIG_RULE_ID) return null;
  if (ruleId >= 800000 && ruleId <= 899999) {
    const rule = dynamicRules.find(r => r.id === ruleId);
    const filter = rule?.condition.urlFilter ?? rule?.condition.regexFilter ?? '';
    return chrome.i18n.getMessage('dnrLabelResourceRedirect', filter);
  }
  if (ruleId >= NETWORK_RULE_BASE && ruleId <= NETWORK_RULE_MAX) {
    const rule = dynamicRules.find(r => r.id === ruleId);
    if (!rule) return null;
    if (rule?.action.responseHeaders?.some(header => header.header === 'server-timing'))
      return null;
    if (controlLabel) return browserUiText(controlLabel, chrome.i18n.getUILanguage?.() ?? 'en');
    return chrome.i18n.getMessage('networkControlLabel') || 'Network routes';
  }
  const rule = dynamicRules.find(r => r.id === ruleId);
  if (!rule) return null;
  const form = storedForms.find(f => f.id === ruleId);
  if (form?.description) return form.description;
  const condition = rule.condition.urlFilter ?? rule.condition.regexFilter ?? '';
  return `${rule.action.type}${condition ? ': ' + condition.substring(0, 50) : ''}`;
}

export async function buildDnrDisplayData(tabId: number): Promise<DnrDisplayRule[]> {
  const tabMatches = dnrTabMatches.get(tabId);

  const [dynamicRules, localStorage, pageOverrides, controlStorage] = await Promise.all([
    Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      chrome.declarativeNetRequest.getSessionRules(),
    ]).then(([dynamic, session]) => [...dynamic, ...session]),
    chrome.storage.local.get([DEV_RULES_STORAGE_KEY]),
    getTabPageOverrides(tabId),
    chrome.storage.session.get(networkControlStorageKey(tabId)),
  ]);
  const storedForms: StoredRuleForm[] = localStorage[DEV_RULES_STORAGE_KEY] || [];

  const result: DnrDisplayRule[] = [];
  const customUserAgent =
    typeof pageOverrides.customUserAgent === 'string' ? pageOverrides.customUserAgent.trim() : '';
  if (pageOverrides.customUserAgentEnabled && customUserAgent) {
    result.push({
      label: chrome.i18n.getMessage('dnrLabelUaOverride'),
      canDisable: true,
      disableTarget: 'userAgent',
    });
  }

  if (pageOverrides.customTimezone) {
    result.push({
      label: chrome.i18n.getMessage('dnrLabelTimezoneOverride', pageOverrides.customTimezone),
      canDisable: true,
      disableTarget: 'timezone',
    });
  }
  if (pageOverrides.customTime !== null) {
    result.push({
      label: chrome.i18n.getMessage('dnrLabelTimeOverride'),
      canDisable: true,
      disableTarget: 'pageTime',
    });
  }

  for (const [ruleId, count] of tabMatches ?? []) {
    if (ruleId === CONFIG_RULE_ID) continue;
    const label = resolveDnrRuleLabel(ruleId, dynamicRules, storedForms, controlStorage[networkControlStorageKey(tabId)]?.label);
    if (label === null) continue;
    const canDisable = ruleId >= 1 && ruleId <= 799996;
    result.push({ label, count, ruleId, canDisable });
  }
  return result;
}

export function scheduleDnrNotify(tabId: number) {
  const existing = dnrNotifyTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    dnrNotifyTimers.delete(tabId);
    const rules = await buildDnrDisplayData(tabId);
    chrome.tabs.sendMessage(tabId, { action: 'updateDnrIndicator', rules }).catch(() => {});
  }, 200);
  dnrNotifyTimers.set(tabId, timer);
}

export function recordDnrMatch(tabId: number, ruleId: number) {
  if (!dnrTabMatches.has(tabId)) dnrTabMatches.set(tabId, new Map());
  const tabMap = dnrTabMatches.get(tabId)!;
  tabMap.set(ruleId, (tabMap.get(ruleId) ?? 0) + 1);
}

export function removeDnrRuleMatch(tabId: number, ruleId: number) {
  const tabMap = dnrTabMatches.get(tabId);
  if (tabMap) tabMap.delete(ruleId);
}

export function cleanupDnrTab(tabId: number) {
  dnrTabMatches.delete(tabId);
  const timer = dnrNotifyTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    dnrNotifyTimers.delete(tabId);
  }
}

export function resetDnrTabOnNavigation(tabId: number) {
  dnrTabMatches.delete(tabId);
  const timer = dnrNotifyTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    dnrNotifyTimers.delete(tabId);
  }
}
