/**
 * Shared utilities for dev rules (used by both options page and background).
 * Handles form ↔ Chrome declarativeNetRequest.Rule conversion and
 * alpha-placeholder resolution (\a \b \c → regex captures from source URL).
 *
 * initiatorDomains field supports two formats per entry:
 *   - Plain domain:  "edith.wapa.shop.com"
 *   - URL pattern:   "edith.wapa.shop.com/clam/([^/]+)/"
 *     → Chrome API receives only the domain portion (before first '/')
 *     → Auto-apply uses it as regex against the full tab URL to resolve \a \b captures
 */

export type ActionType = 'redirect' | 'block' | 'allow' | 'upgradeScheme' | 'modifyHeaders';

export interface RequestHeaderOperation {
  header: string;
  operation: 'set' | 'append' | 'remove';
  value: string;
}
export type RedirectType = 'regexSubstitution' | 'url';
export type FilterType = 'regexFilter' | 'urlFilter';

/** Serializable form state stored in chrome.storage.local */
export interface StoredRuleForm {
  id: number;
  priority: number;
  actionType: ActionType;
  redirectType: RedirectType;
  regexSubstitution: string;
  redirectUrl: string;
  filterType: FilterType;
  regexFilter: string;
  urlFilter: string;
  /** Comma-separated. Each entry may be a URL pattern with captures, e.g. domain/path/([^/]+)/ */
  initiatorDomains: string;
  resourceTypes: string[];
  requestHeaders?: RequestHeaderOperation[];
  responseHeaders?: RequestHeaderOperation[];
  description?: string;
  /** Whether this rule is enabled. Defaults to true when undefined. */
  enabled?: boolean;
}

export const DEV_RULES_STORAGE_KEY = 'devRulesFormConfig';
export const DEV_RULE_ID_MIN = 1;
export const DEV_RULE_ID_MAX = 799999;

export function isDevRuleId(id: number): boolean {
  return Number.isInteger(id) && id >= DEV_RULE_ID_MIN && id <= DEV_RULE_ID_MAX;
}

export function filterDevRules(
  rules: chrome.declarativeNetRequest.Rule[],
): chrome.declarativeNetRequest.Rule[] {
  return rules.filter(r => isDevRuleId(r.id));
}

export function getNextDevRuleId(forms: Array<Pick<StoredRuleForm, 'id'>>): number {
  const maxId = forms.reduce((max, r) => Math.max(max, r.id || 0), 0);
  const nextId = Math.max(DEV_RULE_ID_MIN, maxId + 1);
  if (!isDevRuleId(nextId)) {
    throw new Error(
      `Dev rule id overflow: next id ${nextId} exceeds reserved user rule range (${DEV_RULE_ID_MIN}-${DEV_RULE_ID_MAX})`,
    );
  }
  return nextId;
}

/**
 * 过滤掉非 dev rules 使用的保留 ID（UA 规则、重定向规则等），
 * 确保 dev rules 更新时不会误删其他规则。
 * 保留 ID >= 800000 的规则（由 background 独立管理）。
 */
export function filterDevRuleIds(rules: chrome.declarativeNetRequest.Rule[]): number[] {
  return filterDevRules(rules).map(r => r.id);
}

/**
 * Extract plain domain from an initiatorDomain entry.
 * "edith.wapa.shop.com/clam/([^/]+)/" → "edith.wapa.shop.com"
 */
function extractDomain(entry: string): string {
  return entry.split('/')[0].trim();
}

/** Convert stored form → Chrome declarativeNetRequest.Rule (no placeholder resolution) */
export function storedFormToRule(f: StoredRuleForm): chrome.declarativeNetRequest.Rule {
  const action: Record<string, unknown> = { type: f.actionType };
  if (f.actionType === 'redirect') {
    action.redirect =
      f.redirectType === 'regexSubstitution'
        ? { regexSubstitution: f.regexSubstitution }
        : { url: f.redirectUrl };
  }
  if (f.actionType === 'modifyHeaders' && f.requestHeaders?.length) {
    action.requestHeaders = f.requestHeaders
      .filter(h => h.header)
      .map(h =>
        h.operation === 'remove'
          ? { header: h.header, operation: h.operation }
          : { header: h.header, operation: h.operation, value: h.value },
      );
  }
  if (f.actionType === 'modifyHeaders' && f.responseHeaders?.length) {
    action.responseHeaders = f.responseHeaders
      .filter(h => h.header)
      .map(h =>
        h.operation === 'remove'
          ? { header: h.header, operation: h.operation }
          : { header: h.header, operation: h.operation, value: h.value },
      );
  }

  const condition: Record<string, unknown> = {};
  if (f.filterType === 'regexFilter' && f.regexFilter) {
    condition.regexFilter = f.regexFilter;
  } else if (f.filterType === 'urlFilter' && f.urlFilter) {
    condition.urlFilter = f.urlFilter;
  }
  const domains = f.initiatorDomains
    .split(/[,\n]/)
    .map(d => extractDomain(d))
    .filter(Boolean);
  if (domains.length) condition.initiatorDomains = domains;
  if (f.resourceTypes.length) condition.resourceTypes = f.resourceTypes;

  return {
    id: f.id,
    priority: f.priority,
    action: action as unknown as chrome.declarativeNetRequest.RuleAction,
    condition: condition as chrome.declarativeNetRequest.RuleCondition,
  };
}

const ALPHA = 'abcdefghij';

/**
 * Replace \a \b \c … in regexSubstitution / redirectUrl with captured groups
 * from matching initiatorDomain URL patterns against tabUrl.
 * Each comma-separated entry in initiatorDomains that contains '(' is tried as a regex.
 */
export function resolveAlphaPlaceholders(
  form: StoredRuleForm,
  tabUrl: string,
): { resolved: StoredRuleForm; matched: boolean } {
  const entries = form.initiatorDomains
    .split(/[,\n]/)
    .map(d => d.trim())
    .filter(d => d.includes('('));
  if (!entries.length) return { resolved: form, matched: false };

  for (const entry of entries) {
    try {
      // Treat entry as a URL regex: if it doesn't start with ^ prepend protocol prefix
      const pattern = entry.startsWith('^') ? entry : `^https?://${entry}`;
      const match = tabUrl.match(new RegExp(pattern));
      if (!match) continue;

      let sub = form.regexSubstitution;
      let url = form.redirectUrl;
      for (let i = 0; i < ALPHA.length && i + 1 < match.length; i++) {
        const re = new RegExp(`\\\\${ALPHA[i]}`, 'g');
        const val = match[i + 1] ?? '';
        sub = sub.replace(re, val);
        url = url.replace(re, val);
      }
      return { resolved: { ...form, regexSubstitution: sub, redirectUrl: url }, matched: true };
    } catch {
      continue;
    }
  }
  return { resolved: form, matched: false };
}
