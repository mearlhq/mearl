import { CONFIG_RULE_ID } from './utils/dnr';
import { CONFIG_SERVER_TIMING_KEY } from '../../shared/constants';

// ID 范围：800000–899999，按 URL 哈希分配（内存映射，重启后释放）
const REDIRECT_RULE_BASE = 800000;
const REDIRECT_RULE_MAX = 899999;
const redirectRuleMap = new Map<string, number>();
let redirectRuleCounter = 0;

export function initRedirectRules() {
  chrome.declarativeNetRequest.getDynamicRules().then(rules => {
    // 仅清理重定向区间（800000–899999）的内存态规则。
    const staleIds = rules
      .filter(r => r.id >= REDIRECT_RULE_BASE && r.id <= REDIRECT_RULE_MAX)
      .map(r => r.id);
    if (staleIds.length > 0) {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: staleIds });
    }
  });
}

function getRedirectRuleId(sourceUrl: string): number {
  if (!redirectRuleMap.has(sourceUrl)) {
    redirectRuleMap.set(sourceUrl, REDIRECT_RULE_BASE + redirectRuleCounter++);
  }
  return redirectRuleMap.get(sourceUrl)!;
}

export function setResourceRedirect(sourceUrl: string, redirectUrl: string): Promise<void> {
  const ruleId = getRedirectRuleId(sourceUrl);
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 200,
        action: {
          type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
          redirect: { url: redirectUrl },
        },
        condition: {
          urlFilter: sourceUrl,
          isUrlFilterCaseSensitive: false,
          excludedRequestMethods: ['options' as chrome.declarativeNetRequest.RequestMethod],
        },
      },
    ],
  });
}

export function removeResourceRedirect(sourceUrl: string): Promise<void> {
  const ruleId = redirectRuleMap.get(sourceUrl);
  if (ruleId === undefined) return Promise.resolve();
  return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] }).then(() => {
    redirectRuleMap.delete(sourceUrl);
  });
}

// ==================== 全局配置规则 ====================

interface ProtocolGlobalConfig {
  sse?: boolean;
}

function applyConfigRule(config: ProtocolGlobalConfig): Promise<void> {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
  const responseHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
    {
      header: 'server-timing',
      operation: 'append' as chrome.declarativeNetRequest.HeaderOperation,
      value: `${CONFIG_SERVER_TIMING_KEY};desc="${encoded}"`,
    },
  ];
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CONFIG_RULE_ID],
    addRules: [
      {
        id: CONFIG_RULE_ID,
        priority: 100,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          responseHeaders,
        },
        condition: {
          resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
        },
      },
    ],
  });
}

export async function updateConfigRule(): Promise<void> {
  const result = await chrome.storage.sync.get('sseMonitoringEnabled');
  await applyConfigRule({ sse: result.sseMonitoringEnabled !== false });
}
