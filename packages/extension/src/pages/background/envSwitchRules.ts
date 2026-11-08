import type { NetworkControlSelection } from '@mearl/browser-core';
import type { SelectedBrowserControl } from '@mearl/preset/bundles';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import { SETTINGS_CONTEXT_TAB_STORAGE_KEY } from '../../shared/constants';
import { updateConfigRule } from './resourceRedirectRules';
import { isNetworkControlRule, setNetworkControlForTab, addNetworkControlOrigin, clearNetworkControlForTab } from './networkControlRules';
export { NETWORK_RULE_BASE as ENVSWITCH_RULE_BASE, NETWORK_RULE_MAX as ENVSWITCH_RULE_MAX } from './networkControlRules';
let initialization: Promise<void> | undefined;
export function initEnvSwitchRules(): Promise<void> {
  initialization ??= (async () => {
    await updateConfigRule();
    const removeRuleIds = (await chrome.declarativeNetRequest.getDynamicRules()).filter(isNetworkControlRule).map(rule => rule.id);
    if (removeRuleIds.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}
export async function selectedNetworkControl(): Promise<SelectedBrowserControl | undefined> {
  return (await browserCapabilityRegistry().settings()).browserControl;
}
export async function setInstalledNetworkControl(tabId: number, selection: NetworkControlSelection | null): Promise<void> {
  await initEnvSwitchRules();
  if (selection === null) { await clearNetworkControlForTab(tabId, true); return; }
  await setNetworkControlForTab(tabId, async () => {
    const control = await selectedNetworkControl();
    if (!control || control.definition.id !== selection?.id) throw new Error('Unknown installed browser control');
    return control;
  }, selection.value);
}
export async function addEnvSwitchCorsRule(tabId: number, url: string) { return addNetworkControlOrigin(tabId, url); }
export async function cleanupNetworkControlForTab(tabId: number) {
  await initEnvSwitchRules();
  await clearNetworkControlForTab(tabId, true);
}
export async function getSettingsContextTabId(): Promise<number | null> {
  const value = (await chrome.storage.session.get(SETTINGS_CONTEXT_TAB_STORAGE_KEY))[SETTINGS_CONTEXT_TAB_STORAGE_KEY];
  return typeof value === 'number' ? value : null;
}
export async function setSettingsContextTabId(tabId: number | null) {
  if (tabId === null) await chrome.storage.session.remove(SETTINGS_CONTEXT_TAB_STORAGE_KEY);
  else await chrome.storage.session.set({ [SETTINGS_CONTEXT_TAB_STORAGE_KEY]: tabId });
}
