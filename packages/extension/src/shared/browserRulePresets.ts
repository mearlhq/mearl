import { BundleError, type BrowserUiText } from '@mearl/preset/bundles';
import type { StoredRuleForm } from './devRulesUtils';

export interface BrowserRulePreset {
  name: string;
  description: BrowserUiText;
  rules: StoredRuleForm[];
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.length <= 4096;

export function browserUiMessages(value: unknown): Record<string, BrowserUiText> {
  if (!record(value) || Object.keys(value).length > 512) throw new BundleError('BUNDLE_INVALID', 'Invalid browser messages');
  const result: Record<string, BrowserUiText> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(key) || !record(entry) || !text(entry.en) || !entry.en || Object.keys(entry).some(locale => !['en', 'zh_CN'].includes(locale)) || entry.zh_CN !== undefined && !text(entry.zh_CN)) throw new BundleError('BUNDLE_INVALID', 'Invalid browser message');
    result[key] = { en: entry.en as string, ...(entry.zh_CN !== undefined ? { zh_CN: entry.zh_CN as string } : {}) };
  }
  return result;
}

/** Templates populate an editor; applying a rule still uses its permission and save flow. */
export function parseBrowserRulePresets(value: unknown): Record<string, BrowserRulePreset> {
  if (!record(value) || Object.keys(value).length > 32) throw new BundleError('BUNDLE_INVALID', 'Invalid rule templates');
  const result: Record<string, BrowserRulePreset> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(id) || !record(entry) || Object.keys(entry).some(key => !['name', 'description', 'rules'].includes(key)) || !text(entry.name) || !entry.name || !Array.isArray(entry.rules) || !entry.rules.length || entry.rules.length > 128) throw new BundleError('BUNDLE_INVALID', 'Invalid rule template');
    const description = browserUiMessages({ description: entry.description }).description;
    const ids = new Set<number>();
    for (const rule of entry.rules) {
      if (!record(rule) || !Number.isInteger(rule.id) || (rule.id as number) < 1 || (rule.id as number) > 799999 || ids.has(rule.id as number) || !Number.isInteger(rule.priority) || (rule.priority as number) < 1 || !['redirect', 'block', 'allow', 'upgradeScheme', 'modifyHeaders'].includes(rule.actionType as string) || !['regexSubstitution', 'url'].includes(rule.redirectType as string) || !['regexFilter', 'urlFilter'].includes(rule.filterType as string) || ['regexSubstitution', 'redirectUrl', 'regexFilter', 'urlFilter', 'initiatorDomains'].some(key => !text(rule[key])) || !Array.isArray(rule.resourceTypes) || rule.resourceTypes.length > 16 || rule.resourceTypes.some(type => !['main_frame', 'sub_frame', 'script', 'stylesheet', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'].includes(type)) || rule.description !== undefined && !text(rule.description) || rule.enabled !== undefined && typeof rule.enabled !== 'boolean' || Object.keys(rule).some(key => !['id', 'priority', 'actionType', 'redirectType', 'regexSubstitution', 'redirectUrl', 'filterType', 'regexFilter', 'urlFilter', 'initiatorDomains', 'resourceTypes', 'requestHeaders', 'responseHeaders', 'description', 'enabled'].includes(key))) throw new BundleError('BUNDLE_INVALID', 'Invalid rule template form');
      ids.add(rule.id as number);
      for (const field of ['requestHeaders', 'responseHeaders']) {
        const headers = rule[field];
        if (headers === undefined) continue;
        if (!Array.isArray(headers) || headers.length > 64 || headers.some(header => !record(header) || !text(header.header) || !header.header || !text(header.value) || !['set', 'append', 'remove'].includes(header.operation as string) || Object.keys(header).some(key => !['header', 'value', 'operation'].includes(key)))) throw new BundleError('BUNDLE_INVALID', 'Invalid rule template headers');
      }
    }
    result[id] = { name: entry.name as string, description, rules: structuredClone(entry.rules) as StoredRuleForm[] };
  }
  return result;
}
