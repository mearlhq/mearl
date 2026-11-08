import {
  DEV_RULES_STORAGE_KEY, filterDevRuleIds, filterDevRules, isDevRuleId,
  resolveAlphaPlaceholders, storedFormToRule, type StoredRuleForm,
} from '../../shared/devRulesUtils';

let queue: Promise<unknown> = Promise.resolve();
export function withDevRulesUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const pending = queue.then(operation, operation);
  queue = pending.catch(() => {});
  return pending;
}
const ALPHA_RE = /\\[a-j]/;
function activeRules(forms: StoredRuleForm[]) {
  return forms.filter(form => form.enabled !== false && !ALPHA_RE.test(form.regexSubstitution) && !ALPHA_RE.test(form.redirectUrl)).map(storedFormToRule);
}

/** The draft is durable even if Chrome rejects an unfinished rule; DNR updates are atomic. */
export function saveDevRules(forms: StoredRuleForm[], enabled: boolean) {
  return withDevRulesUpdate(async () => {
    try {
      if (!Array.isArray(forms) || typeof enabled !== 'boolean' ||
        new Set(forms.map(form => form.id)).size !== forms.length ||
        forms.some(form => !isDevRuleId(form.id))) throw new Error('Invalid request rules');
      await chrome.storage.local.set({ [DEV_RULES_STORAGE_KEY]: forms, devRulesEnabled: enabled });
      const rules = enabled ? activeRules(forms) : [];
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: filterDevRuleIds(existing), addRules: rules });
      return { success: true, rulesCount: rules.length };
    } catch (error) {
      const existing = await chrome.declarativeNetRequest.getDynamicRules().catch(() => undefined);
      return { success: false, error: error instanceof Error ? error.message : String(error),
        ...(existing ? { rulesCount: filterDevRules(existing).length } : {}) };
    }
  });
}

export function disableDevRule(ruleId: number) {
  return withDevRulesUpdate(async () => {
    if (!isDevRuleId(ruleId)) throw new Error('Invalid request rule ID');
    const stored = await chrome.storage.local.get(DEV_RULES_STORAGE_KEY);
    const forms: StoredRuleForm[] = stored[DEV_RULES_STORAGE_KEY] || [];
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    await chrome.storage.local.set({ [DEV_RULES_STORAGE_KEY]: forms.map(form => form.id === ruleId ? { ...form, enabled: false } : form) });
  });
}

/** Read the latest selection inside the same queue, so navigation cannot undo a toggle. */
export function autoApplyDevRules(tabUrl: string) {
  return withDevRulesUpdate(async () => {
    const stored = await chrome.storage.local.get([DEV_RULES_STORAGE_KEY, 'devRulesEnabled']);
    if (stored.devRulesEnabled === false) return;
    const forms: StoredRuleForm[] = stored[DEV_RULES_STORAGE_KEY] || [];
    let changed = false;
    const resolved = forms.filter(form => form.enabled !== false).map(form => {
      const result = resolveAlphaPlaceholders(form, tabUrl);
      if (result.matched && (result.resolved.regexSubstitution !== form.regexSubstitution || result.resolved.redirectUrl !== form.redirectUrl)) changed = true;
      return result.resolved;
    });
    if (!changed) return;
    const rules = activeRules(resolved);
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const signature = (values: chrome.declarativeNetRequest.Rule[]) => values.slice().sort((a, b) => a.id - b.id).map(rule =>
      JSON.stringify({ id: rule.id, priority: rule.priority ?? 1, action: rule.action, condition: rule.condition })).join('|');
    if (signature(filterDevRules(existing)) === signature(rules)) return;
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: filterDevRuleIds(existing), addRules: rules });
  });
}
