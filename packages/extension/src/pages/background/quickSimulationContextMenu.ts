import { getAppProfileCatalog } from './appProfileCatalog';
import { handleRequestPermission } from './agentHandlers/permissionHandlers';
import { onBrowserPresetChange } from './browserCapabilityRegistry';
import { getRememberedQuickAppProfileForTab } from './quickDeviceSimulationState';
import { setQuickAppSimulationWithAutoRuleSync } from './quickSimulationAutoRules';
import { getAppProfileForTab, onAppProfileStateChange } from './utils/appProfileRules';

const ENABLE_MENU_ID = 'enableQuickSimulation';
const DISABLE_MENU_ID = 'disableQuickSimulation';
let available = false;
let menuRevision = 0;

export function updateQuickSimulationContextMenu(enabled: boolean): void {
  available = enabled;
  refreshMenu();
}

function refreshMenu(): void {
  const revision = ++menuRevision;
  void syncMenu(revision).catch(error =>
    console.warn('[DeviceSimulation] Unable to update page menu:', error),
  );
}

async function syncMenu(revision: number): Promise<void> {
  // Chrome shares context menu entries across tabs, so track the active tab in the focused window.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = tab?.id !== undefined && Boolean(await getAppProfileForTab(tab.id));
  if (revision !== menuRevision) return;
  const menuId = active ? DISABLE_MENU_ID : ENABLE_MENU_ID;
  chrome.contextMenus.remove(active ? ENABLE_MENU_ID : DISABLE_MENU_ID, () => {
    void chrome.runtime.lastError;
  });
  if (!available && !active) {
    chrome.contextMenus.remove(menuId, () => {
      void chrome.runtime.lastError;
    });
    return;
  }
  const title = active
    ? chrome.i18n.getMessage('deviceSimulationDisableFromPage')
    : chrome.i18n.getMessage('deviceSimulationEnableFromPage');
  chrome.contextMenus.update(menuId, { title, visible: true }, () => {
    if (!chrome.runtime.lastError || revision !== menuRevision) return;
    chrome.contextMenus.create(
      {
        id: menuId,
        title,
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      () => {
        void chrome.runtime.lastError;
      },
    );
  });
}

export function initializeQuickSimulationContextMenu(): void {
  const refresh = () => {
    void getAppProfileCatalog({ refresh: false }).then(
      ({ profiles }) =>
        updateQuickSimulationContextMenu(profiles.some(profile => profile.available !== false)),
      () => {},
    );
  };
  chrome.runtime.onInstalled.addListener(refresh);
  chrome.tabs.onActivated.addListener(refreshMenu);
  chrome.windows.onFocusChanged.addListener(refreshMenu);
  onAppProfileStateChange(refreshMenu);
  onBrowserPresetChange(() => queueMicrotask(refresh));
  refresh();

  chrome.contextMenus.onClicked.addListener(({ menuItemId, pageUrl }, tab) => {
    const tabId = tab?.id;
    if (
      (menuItemId !== ENABLE_MENU_ID && menuItemId !== DISABLE_MENU_ID) ||
      tabId === undefined ||
      !pageUrl
    )
      return;
    void setSimulationForTab(tabId, pageUrl, menuItemId === ENABLE_MENU_ID).catch(error =>
      console.warn('[DeviceSimulation] Unable to update simulation from page:', error),
    );
  });
}

async function setSimulationForTab(tabId: number, pageUrl: string, enable: boolean): Promise<void> {
  const page = new URL(pageUrl);
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return;
  if (enable === Boolean(await getAppProfileForTab(tabId))) {
    refreshMenu();
    return;
  }

  let profile = null;
  if (enable) {
    const { profiles } = await getAppProfileCatalog();
    const availableProfiles = profiles.filter(item => item.available !== false);
    updateQuickSimulationContextMenu(availableProfiles.length > 0);
    if (!availableProfiles.length) return;

    const preferred = await getRememberedQuickAppProfileForTab(tabId);
    profile = (availableProfiles.find(item => item.id === preferred) ?? availableProfiles[0]).id;
    if (!(await chrome.permissions.contains({ origins: [`${page.origin}/*`] }))) {
      const { granted } = await handleRequestPermission({ domain: page.hostname });
      if (!granted) return;
    }
  }
  const targetUrl = (await chrome.tabs.get(tabId)).url;
  if (!targetUrl || new URL(targetUrl).origin !== page.origin) return;
  if (enable && (await getAppProfileForTab(tabId))) return;
  await setQuickAppSimulationWithAutoRuleSync({ tabId, profile });
}
