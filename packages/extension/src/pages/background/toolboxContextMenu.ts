import type { ToolboxToolsListResult } from '@mearl/browser-core';
import { loadMessages, t } from '../../shared/i18n';
import { localizeToolboxMetadata } from '../../shared/toolboxLocale';
import { openToolboxToolTab } from '../../shared/toolboxTab';
import { DEFAULT_CONFIG } from '../panel/utils/config';

const MENU_ID = 'toolboxOpenInTab';
const TOOL_MENU_PREFIX = `${MENU_ID}:`;

function createItem(item: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(item, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

export function initializeToolboxContextMenu(readTools: () => Promise<ToolboxToolsListResult>) {
  let writes = Promise.resolve();
  let requested = 0;
  let received = 0;
  let appliedMenu: string | undefined;

  async function syncItems({ tools }: ToolboxToolsListResult) {
    const { language } = await chrome.storage.sync.get({ language: DEFAULT_CONFIG.language });
    const messages = await loadMessages(language);
    const title = messages.toolboxTitle?.message ?? t('toolboxTitle');
    const items = tools
      .filter(tool => tool.displayMode !== 'popup')
      .map(tool => ({
        id: `${TOOL_MENU_PREFIX}${tool.id}`,
        title: localizeToolboxMetadata(tool, language).title,
      }));
    const menu = JSON.stringify([title, items]);
    if (appliedMenu === menu) return;
    appliedMenu = undefined;

    // Removing the parent also removes its children, including items from a previous worker.
    await new Promise<void>(resolve => {
      chrome.contextMenus.remove(MENU_ID, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    if (items.length > 0) {
      await createItem({ id: MENU_ID, title, contexts: ['action'] });
      for (const item of items) {
        await createItem({ ...item, parentId: MENU_ID, contexts: ['action'] });
      }
    }
    appliedMenu = menu;
  }

  async function listTools(): Promise<ToolboxToolsListResult> {
    const revision = ++requested;
    const result = await readTools();
    if (revision > received) {
      received = revision;
      writes = writes
        .then(() => (revision === received ? syncItems(result) : undefined))
        .catch(error => console.warn('[Toolbox] Unable to update the extension menu:', error));
    }
    return result;
  }

  // Keep the last successful menu when the local service is temporarily unavailable.
  const refresh = () => void listTools().catch(() => {});
  chrome.runtime.onInstalled.addListener(refresh);
  chrome.runtime.onStartup.addListener(refresh);
  // Reload tools installed outside the browser when the browser regains focus.
  chrome.windows.onFocusChanged.addListener(windowId => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) refresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.language) refresh();
  });
  chrome.contextMenus.onClicked.addListener(({ menuItemId }) => {
    if (typeof menuItemId !== 'string' || !menuItemId.startsWith(TOOL_MENU_PREFIX)) return;
    void openToolboxToolTab(menuItemId.slice(TOOL_MENU_PREFIX.length)).catch(error =>
      console.warn('[Toolbox] Unable to open the tool in a tab:', error),
    );
  });

  return { listTools, refresh };
}
