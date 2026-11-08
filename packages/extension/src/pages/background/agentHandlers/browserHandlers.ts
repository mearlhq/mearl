/**
 * Agent handlers: set_rule, get_rules, page_screenshot
 */

import type { PageScreenshotParams, RulesResult, SetRuleParams } from '@mearl/browser-core';
import type { ElementInfo } from '../../content-script/injected/collectElement';
import { captureVisibleScreenshot } from './visibleScreenshot';
import {
  captureNodeScreenshotViaCDP,
  captureScreenshotViaCDP,
  dataUrlToBase64,
} from './screenshotUtils';
import {
  DEV_RULES_STORAGE_KEY,
  getNextDevRuleId,
  storedFormToRule,
  type StoredRuleForm,
} from '../../../shared/devRulesUtils';
import { checkDevRulePermissions } from '../../../shared/devRulePermissions';
import { withDevRulesUpdate } from '../devRulesService';
import { getDeviceShellForTab } from '../deviceShellRules';

// ─── set_rule ─────────────────────────────────────────────────────────────────

export async function handleSetRule(
  data: SetRuleParams,
): Promise<{
  success: boolean;
  ruleId: number;
  affectedCount: number;
  message: string;
  warnings?: string[];
  missingOrigins?: string[];
}> {
  return withDevRulesUpdate(() => setRule(data));
}

async function setRule(data: SetRuleParams) {
  if (data?.enabled === false) {
    const { ruleId } = data;
    if (!Number.isSafeInteger(ruleId) || ruleId < 1) {
      throw new Error('Invalid ruleId: must be a positive integer');
    }
    const result = await chrome.storage.local.get([DEV_RULES_STORAGE_KEY, 'devRulesEnabled']);
    const rules: StoredRuleForm[] = result[DEV_RULES_STORAGE_KEY] || [];
    const rule = rules.find(item => item.id === ruleId);
    if (!rule) {
      return { success: true, ruleId, affectedCount: 0, message: `Rule #${ruleId} not found.` };
    }

    const applied = result.devRulesEnabled !== false && rule.enabled !== false;
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    try {
      await chrome.storage.local.set({
        [DEV_RULES_STORAGE_KEY]: rules.filter(item => item.id !== ruleId),
      });
    } catch (error) {
      if (applied) {
        await chrome.declarativeNetRequest
          .updateDynamicRules({ addRules: [storedFormToRule(rule)] })
          .catch(rollbackError =>
            console.warn('[AgentBridge] Failed to restore rule:', rollbackError),
          );
      }
      throw error;
    }
    return { success: true, ruleId, affectedCount: 1, message: `Rule #${ruleId} removed.` };
  }

  const {
    actionType,
    filter,
    redirectUrl,
    requestHeaders,
    responseHeaders,
    initiatorDomains,
    resourceTypes,
    priority = 1,
    description,
  } = data;

  if (
    !actionType ||
    !['redirect', 'block', 'allow', 'upgradeScheme', 'modifyHeaders'].includes(actionType)
  ) {
    throw new Error(
      'Invalid actionType: must be one of redirect, block, allow, upgradeScheme, modifyHeaders',
    );
  }

  if (!filter || typeof filter !== 'string' || filter.trim() === '') {
    throw new Error('Invalid filter: filter must be a non-empty string');
  }

  if (actionType === 'redirect' && (!redirectUrl || redirectUrl.trim() === '')) {
    throw new Error('redirectUrl is required for redirect actionType');
  }

  const result = await chrome.storage.local.get(DEV_RULES_STORAGE_KEY);
  const existingRules: StoredRuleForm[] = result[DEV_RULES_STORAGE_KEY] || [];

  const newRuleId = getNextDevRuleId(existingRules);

  const newRule: StoredRuleForm = {
    id: newRuleId,
    priority,
    actionType,
    redirectType: 'regexSubstitution',
    regexSubstitution: actionType === 'redirect' ? redirectUrl || '' : '',
    redirectUrl: '',
    filterType: 'regexFilter',
    regexFilter: filter,
    urlFilter: '',
    initiatorDomains: initiatorDomains || '',
    resourceTypes: resourceTypes || ['main_frame', 'xmlhttprequest'],
    description: description || 'Rule added via MCP/Skill',
    enabled: true,
  };

  if (actionType === 'modifyHeaders' && requestHeaders?.length) {
    newRule.requestHeaders = requestHeaders.map(h => ({
      header: h.header,
      operation: h.operation,
      value: h.value || '',
    }));
  }

  if (actionType === 'modifyHeaders' && responseHeaders?.length) {
    newRule.responseHeaders = responseHeaders.map(h => ({
      header: h.header,
      operation: h.operation,
      value: h.value || '',
    }));
  }

  const permissions = await checkDevRulePermissions([newRule]);
  const warnings: string[] = [];
  if (permissions.missingOrigins.length) {
    const commands = permissions.missingOrigins.map(origin => {
      const domain = origin
        .replace(/^[^:]+:\/\//, '')
        .replace(/^\*\./, '')
        .replace(/\/\*$/, '');
      return `mearl request_permission --payload '${JSON.stringify({ domain })}'`;
    });
    warnings.push(
      `Missing host permissions: ${permissions.missingOrigins.join(', ')}. The rule may not take effect. Open extension Request Rules to grant access, or request access with: ${commands.join('; ')}`,
    );
  }
  if (permissions.hasUnscopedRules) {
    warnings.push(
      'The URL pattern has no finite domain scope. Host permissions could not be fully checked. Narrow the filter to specific domains or check the relevant site access in extension settings.',
    );
  }
  const enabledResult = await chrome.storage.local.get('devRulesEnabled');
  const shouldApply = enabledResult.devRulesEnabled !== false;
  if (shouldApply) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [storedFormToRule(newRule)],
    });
  }
  try {
    await chrome.storage.local.set({ [DEV_RULES_STORAGE_KEY]: [...existingRules, newRule] });
  } catch (error) {
    if (shouldApply) {
      await chrome.declarativeNetRequest
        .updateDynamicRules({ removeRuleIds: [newRuleId] })
        .catch(rollbackError =>
          console.warn('[AgentBridge] Failed to roll back rule:', rollbackError),
        );
    }
    throw error;
  }

  return {
    success: true,
    ruleId: newRuleId,
    affectedCount: 1,
    message: `Rule #${newRuleId} saved. View in extension Options > Request Rules.${warnings.length ? ' Host permissions need attention; see warnings.' : ''}`,
    ...(warnings.length ? { warnings } : {}),
    ...(permissions.missingOrigins.length ? { missingOrigins: permissions.missingOrigins } : {}),
  };
}

// ─── get_rules ────────────────────────────────────────────────────────────────────────────────

/**
 * 返回当前存储的全部请求规则。与 Options 面板共享同一份存储，
 * 因此也包含用户手动配置的规则；字段结构与 set_rule 入参对齐。
 */
export async function handleGetRules(): Promise<RulesResult> {
  const result = await chrome.storage.local.get([DEV_RULES_STORAGE_KEY, 'devRulesEnabled']);
  const storedRules: StoredRuleForm[] = result[DEV_RULES_STORAGE_KEY] || [];
  return {
    enabled: result.devRulesEnabled !== false,
    rules: storedRules.map(rule => ({
      ruleId: rule.id,
      actionType: rule.actionType,
      filter: rule.filterType === 'regexFilter' ? rule.regexFilter : rule.urlFilter,
      ...(rule.actionType === 'redirect'
        ? {
            redirectUrl:
              rule.redirectType === 'regexSubstitution' ? rule.regexSubstitution : rule.redirectUrl,
          }
        : {}),
      ...(rule.requestHeaders?.length ? { requestHeaders: rule.requestHeaders } : {}),
      ...(rule.responseHeaders?.length ? { responseHeaders: rule.responseHeaders } : {}),
      ...(rule.initiatorDomains ? { initiatorDomains: rule.initiatorDomains } : {}),
      resourceTypes: rule.resourceTypes,
      priority: rule.priority,
      description: rule.description,
      enabled: rule.enabled,
    })),
  };
}

// ─── page_screenshot ───────────────────────────────────────────────────────────

export async function handlePageScreenshot(
  data: PageScreenshotParams,
  getActiveTabId: () => number | null,
): Promise<{
  meta: {
    format: 'png' | 'jpeg';
    width: number;
    height: number;
    size: number;
    url: string;
    title: string;
  };
  data: string;
}> {
  const { format = 'png', quality = 80, selector } = data;

  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab) {
    throw new Error('Failed to get active tab information');
  }

  if (data.captureMode !== undefined && !['cdp', 'visible'].includes(data.captureMode)) {
    throw new Error('Invalid screenshot captureMode');
  }
  if (data.captureMode === 'visible' && selector) {
    throw new Error('Visible capture does not support element selectors');
  }

  try {
    const { dataUrl, width, height, pageUrl } = selector
      ? await captureNodeScreenshotViaCDP(tabId, selector, format, quality)
      : data.captureMode === 'visible'
        ? await captureVisibleScreenshot(tab, format, quality)
        : await captureScreenshotViaCDP(tabId, format, quality);
    const base64Data = dataUrlToBase64(dataUrl);
    const size = Math.ceil((base64Data.length * 3) / 4);

    return {
      meta: {
        format,
        width,
        height,
        size,
        url: pageUrl ?? tab.url ?? '',
        title: tab.title || '',
      },
      data: base64Data,
    };
  } catch (error) {
    console.error('[AgentBridge] Failed to capture screenshot:', error);
    throw new Error(
      `Failed to capture screenshot: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function getDevtoolsSelectedElement(
  data: { tabId: number; includeOuterHTML?: boolean },
  ctx: import('./types').AgentHandlerContext,
): Promise<ElementInfo> {
  const tabId = data.tabId ?? ctx.getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus on a devtools panel.');
  }
  if ((await getDeviceShellForTab(tabId))?.config.phoneFrame) {
    throw new Error('In device preview, use a selector or a ref from page_snapshot to inspect the business page.');
  }

  const selectedElement = (await ctx.queryPanel(tabId, {
    type: 'getSelectedElement',
    includeOuterHTML: data.includeOuterHTML !== false,
  })) as ElementInfo | { error?: string };

  if (selectedElement && typeof selectedElement === 'object' && 'error' in selectedElement) {
    throw new Error(selectedElement.error || 'Failed to get selected element');
  }

  return selectedElement as ElementInfo;
}
