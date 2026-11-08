import { getAppProfileCatalog } from './appProfileCatalog';
import { handleRequestPermission } from './agentHandlers/permissionHandlers';
import { onBrowserPresetChange } from './browserCapabilityRegistry';
import { getQuickDeviceEmulationState, restoreQuickDeviceEmulationForTab } from './quickDeviceEmulation';
import { getRememberedQuickAppProfileForTab } from './quickDeviceSimulationState';
import { setQuickAppSimulationWithAutoRuleSync } from './quickSimulationAutoRules';
import { getAppProfileForTab } from './utils/appProfileRules';

const MENU_ID = 'enableQuickSimulation';
let available = false;

export function updateQuickSimulationContextMenu(enabled: boolean): void {
  available = enabled;
  if (!enabled) {
    chrome.contextMenus.remove(MENU_ID, () => { void chrome.runtime.lastError; });
    return;
  }
  chrome.contextMenus.update(MENU_ID, { visible: true }, () => {
    if (!chrome.runtime.lastError || !available) return;
    chrome.contextMenus.create({
      id: MENU_ID,
      title: chrome.i18n.getMessage('deviceSimulationEnableFromPage'),
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { void chrome.runtime.lastError; });
  });
}

export function initializeQuickSimulationContextMenu(): void {
  const refresh = () => {
    void getAppProfileCatalog({ refresh: false }).then(
      ({ profiles }) => updateQuickSimulationContextMenu(profiles.some(profile => profile.available !== false)),
      () => {},
    );
  };
  chrome.runtime.onInstalled.addListener(refresh);
  onBrowserPresetChange(() => queueMicrotask(refresh));
  refresh();

  chrome.contextMenus.onClicked.addListener(({ menuItemId, pageUrl }, tab) => {
    const tabId = tab?.id;
    if (menuItemId !== MENU_ID || tabId === undefined || !pageUrl) return;
    void enableForTab(tabId, pageUrl).catch(error => console.warn('[DeviceSimulation] Unable to enable from page:', error));
  });
}

async function enableForTab(tabId: number, pageUrl: string): Promise<void> {
  const page = new URL(pageUrl);
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return;
  const { profiles } = await getAppProfileCatalog();
  const available = profiles.filter(profile => profile.available !== false);
  updateQuickSimulationContextMenu(available.length > 0);
  if (!available.length) return;

  await restoreQuickDeviceEmulationForTab(tabId);
  const current = await getAppProfileForTab(tabId);
  if (current && getQuickDeviceEmulationState(tabId).active) return;
  const preferred = current?.profile ?? await getRememberedQuickAppProfileForTab(tabId);
  const profile = available.find(item => item.id === preferred) ?? available[0];
  if (!(await chrome.permissions.contains({ origins: [`${page.origin}/*`] }))) {
    const { granted } = await handleRequestPermission({ domain: page.hostname });
    if (!granted) return;
  }
  const targetUrl = (await chrome.tabs.get(tabId)).url;
  if (!targetUrl || new URL(targetUrl).origin !== page.origin) return;
  await setQuickAppSimulationWithAutoRuleSync({ tabId, profile: profile.id });
}
