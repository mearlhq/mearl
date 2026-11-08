import { decodeNetworkRoutePlan, encodeNetworkRoutePlan, parseNetworkRoutePlan, type NetworkRoutePlan, type SelectedBrowserControl, type BrowserUiText } from '@mearl/preset/bundles';
import { NETWORK_ROUTES_SERVER_TIMING_KEY, networkControlStorageKey } from '../../shared/browserControl';
import { authorizeBrowserCapabilityUrl } from './browserCapabilities';

export const NETWORK_RULE_BASE = 999900;
export const NETWORK_RULE_MAX = 999949;
export interface AcceptedNetworkControl {
  controlId: string;
  bundleId: string;
  revision: string;
  value: string;
  defaultValue: string;
  plan: NetworkRoutePlan;
  label?: BrowserUiText;
  aliases?: string[];
}
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}
export const isNetworkControlRule = (rule: chrome.declarativeNetRequest.Rule) => rule.id >= NETWORK_RULE_BASE && rule.id <= NETWORK_RULE_MAX;
function originOf(url: string): string | undefined {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined; } catch { return undefined; }
}
function allocate(used: Set<number>) {
  for (let id = NETWORK_RULE_BASE; id <= NETWORK_RULE_MAX; id++) if (!used.has(id)) { used.add(id); return id; }
  throw new Error('No available network control DNR rule id');
}
async function readState(tabId: number): Promise<AcceptedNetworkControl | undefined> {
  const value = (await chrome.storage.session.get(networkControlStorageKey(tabId)))[networkControlStorageKey(tabId)];
  if (!value || typeof value !== 'object') return undefined;
  try {
    if (['controlId', 'bundleId', 'revision', 'value', 'defaultValue'].some(key => typeof value[key] !== 'string')) return undefined;
    return { ...value, plan: parseNetworkRoutePlan(value.plan) };
  } catch { return undefined; }
}
export async function getNetworkControlState(tabId: number) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab ID');
  await queue;
  return readState(tabId);
}
function tabRules(rules: chrome.declarativeNetRequest.Rule[], tabId: number) {
  return rules.filter(rule => isNetworkControlRule(rule) && rule.condition.tabIds?.includes(tabId));
}
function makeRules(tabId: number, plan: NetworkRoutePlan, previous: chrome.declarativeNetRequest.Rule[], allRules: chrome.declarativeNetRequest.Rule[], reportedUrl?: string) {
  if (!plan.routes.length) return [];
  const used = new Set(allRules.filter(rule => !previous.includes(rule)).map(rule => rule.id));
  const origins = new Set(previous.flatMap(rule => rule.action.responseHeaders ?? []).filter(header => header.header === 'access-control-allow-origin').map(header => header.value).filter((value): value is string => !!value));
  const origin = reportedUrl && originOf(reportedUrl);
  if (origin) origins.add(origin);
  const rules: chrome.declarativeNetRequest.Rule[] = [{
    id: allocate(used), priority: 100,
    action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType, responseHeaders: [{ header: 'server-timing', operation: 'append' as chrome.declarativeNetRequest.HeaderOperation, value: `${NETWORK_ROUTES_SERVER_TIMING_KEY};desc="${encodeNetworkRoutePlan(plan)}"` }] },
    condition: { tabIds: [tabId], resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[] },
  }];
  const hosts = [...new Set(plan.routes.map(route => route.toHost))].map(host => host.replace(/\./g, '\\.')).join('|');
  for (const origin of origins) rules.push({
    id: allocate(used), priority: 100,
    action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType, responseHeaders: [
      { header: 'access-control-allow-origin', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: origin },
      { header: 'access-control-allow-credentials', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'true' },
    ] },
    condition: { tabIds: [tabId], initiatorDomains: [new URL(origin).hostname], regexFilter: `^https?://(${hosts})/` },
  });
  return rules;
}

/** The rule transaction and its selection share one queue, including failed-write rollback. */
async function accept(tabId: number, selection: AcceptedNetworkControl, reportedUrl?: string, existingRulesOnly = false) {
  const plan = parseNetworkRoutePlan(selection.plan);
  const key = networkControlStorageKey(tabId);
  const previousValue = (await chrome.storage.session.get(key))[key];
  const all = await chrome.declarativeNetRequest.getSessionRules();
  const previous = tabRules(all, tabId);
  const addRules = existingRulesOnly ? previous.map(rule => ({ ...rule, action: { ...rule.action, responseHeaders: rule.action.responseHeaders?.map(header => header.header === 'server-timing' ? { ...header, value: `${NETWORK_ROUTES_SERVER_TIMING_KEY};desc="${encodeNetworkRoutePlan(plan)}"` } : header) } })) : makeRules(tabId, plan, previous, all, reportedUrl);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: previous.map(rule => rule.id), addRules });
  try { await chrome.storage.session.set({ [key]: { ...selection, plan } }); }
  catch (error) {
    const current = tabRules(await chrome.declarativeNetRequest.getSessionRules(), tabId);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: current.map(rule => rule.id), addRules: previous });
    if (previousValue === undefined) await chrome.storage.session.remove(key);
    else await chrome.storage.session.set({ [key]: previousValue });
    throw error;
  }
}

export function setNetworkControlForTab(tabId: number, selected: SelectedBrowserControl | (() => Promise<SelectedBrowserControl>), value: string, confirm?: () => Promise<void>) {
  return exclusive(async () => {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab ID');
    const control = typeof selected === 'function' ? await selected() : selected;
    const option = control.definition.options.find(option => option.value === value);
    if (!option) throw new Error('Unknown browser control option');
    await Promise.all([...new Set(option.networkRoutes.routes.map(route => route.toHost))].map(host => authorizeBrowserCapabilityUrl(`https://${host}/`)));
    await confirm?.();
    const tab = await chrome.tabs.get(tabId);
    await accept(tabId, { controlId: control.definition.id, bundleId: control.bundleId, revision: control.revision, value, defaultValue: control.definition.defaultValue, plan: option.networkRoutes, ...(control.definition.aliases ? { aliases: [...control.definition.aliases] } : {}), label: {
      en: `${control.definition.label.en} → ${option.label.en}`,
      zh_CN: `${control.definition.label.zh_CN ?? control.definition.label.en} → ${option.label.zh_CN ?? option.label.en}`,
    } }, tab.url);
  });
}

/** Used by compatibility migration; it pins the old accepted plan without consulting new defaults. */
export function adoptNetworkControlForTab(tabId: number, selection: AcceptedNetworkControl) {
  return exclusive(async () => { if (!(await readState(tabId))) await accept(tabId, selection, undefined, true); });
}

export function addNetworkControlOrigin(tabId: number, url: string, recover?: () => Promise<AcceptedNetworkControl | undefined>) {
  return exclusive(async () => {
    const origin = originOf(url);
    if (!origin) return;
    let accepted = await readState(tabId);
    if (!accepted && recover) {
      accepted = await recover();
      if (accepted) await accept(tabId, accepted, undefined, true);
    }
    if (!accepted) return;
    const all = await chrome.declarativeNetRequest.getSessionRules();
    const previous = tabRules(all, tabId);
    const header = previous.flatMap(rule => rule.action.responseHeaders ?? []).find(header => header.header === 'server-timing' && header.value?.startsWith(NETWORK_ROUTES_SERVER_TIMING_KEY + ';'))?.value;
    if (!header) return;
    try { if (JSON.stringify(decodeNetworkRoutePlan(/desc="([^"]+)"/.exec(header)![1])) !== JSON.stringify(accepted.plan)) return; } catch { return; }
    if (previous.some(rule => rule.action.responseHeaders?.some(header => header.header === 'access-control-allow-origin' && header.value === origin))) return;
    // Copy the accepted destination filter; a preset update never changes a running document.
    const template = previous.find(rule => !!rule.condition.regexFilter);
    if (!template) {
      if (!accepted.plan.routes.length) return;
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: previous.map(rule => rule.id), addRules: makeRules(tabId, accepted.plan, previous, all, origin) });
      return;
    }
    const rule = structuredClone(template);
    rule.id = allocate(new Set(all.map(rule => rule.id)));
    rule.condition.initiatorDomains = [new URL(origin).hostname];
    rule.action.responseHeaders = rule.action.responseHeaders?.map(header => header.header === 'access-control-allow-origin' ? { ...header, value: origin } : header);
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
  });
}

export function clearNetworkControlForTab(tabId: number, closed = false, prepare?: (previous?: AcceptedNetworkControl) => Promise<string | undefined>) {
  return exclusive(async () => {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab ID');
    const previous = await readState(tabId);
    const defaultValue = await prepare?.(previous);
    const reset: AcceptedNetworkControl = { controlId: previous?.controlId ?? '', bundleId: previous?.bundleId ?? '', revision: previous?.revision ?? '', value: previous?.defaultValue ?? defaultValue ?? '', defaultValue: previous?.defaultValue ?? defaultValue ?? '', plan: { routes: [] }, ...(previous?.aliases ? { aliases: previous.aliases } : {}) };
    if (!closed) return accept(tabId, reset);
    const rules = tabRules(await chrome.declarativeNetRequest.getSessionRules(), tabId);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) });
    await chrome.storage.session.remove(networkControlStorageKey(tabId));
  });
}
