import { useEffect } from 'react';
import { showToast } from '../utils/toast';
import { t } from '../utils/i18n';
import { getWildcardHost } from './useHostPermissionPrompt';

/** 读取目标页面的 origin / hostname，非 http(s) 页（chrome:// 等）返回 null。 */
function getInspectedWindowPage(): Promise<{ origin: string; hostname: string } | null> {
  if (!chrome.devtools?.inspectedWindow) return Promise.resolve(null);
  return new Promise(resolve => {
    chrome.devtools.inspectedWindow.eval(
      "(location.protocol === 'http:' || location.protocol === 'https:') ? { origin: location.origin, hostname: location.hostname } : null",
      (result, exceptionInfo) => {
        resolve(exceptionInfo ? null : ((result as { origin: string; hostname: string }) ?? null));
      },
    );
  });
}

async function getInspectedPage(
  tabId: number | null,
): Promise<{ origin: string; hostname: string } | null> {
  if (tabId !== null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) {
        const url = new URL(tab.url);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return { origin: url.origin, hostname: url.hostname };
        }
      }
    } catch {
      // DevTools can still read the inspected page when Tabs omits the URL before authorization.
    }
  }
  return getInspectedWindowPage();
}

/** 当前 origin 是否已被授权 */
function isOriginGranted(origin: string): Promise<boolean> {
  return new Promise(resolve => {
    chrome.permissions.contains({ origins: [`${origin}/*`] }, granted => {
      void chrome.runtime.lastError;
      resolve(Boolean(granted));
    });
  });
}

export async function getPageHostPermissionGranted(tabId: number | null): Promise<boolean | null> {
  const page = await getInspectedPage(tabId);
  if (!page) return null;
  return isOriginGranted(page.origin);
}

function showPermissionToast(hostname: string): void {
  const origin = `*://${getWildcardHost(hostname)}/*`;
  showToast(t('contentScriptNeedsPermission'), 'error', 8000, {
    label: t('hostPermissionGrant'),
    onClick: () => {
      chrome.permissions.request({ origins: [origin] }, granted => {
        void chrome.runtime.lastError;
        if (granted) {
          showToast(t('hostPermissionGranted'), 'success');
        } else {
          showToast(t('hostPermissionGrantFailed'), 'error');
        }
      });
    },
  });
}

/** 未授权时复用页面操作失败所使用的授权提示；已授权或不可注入页面不提示。 */
export async function showHostPermissionPromptIfNeeded(tabId: number | null): Promise<boolean> {
  const page = await getInspectedPage(tabId);
  if (!page || (await isOriginGranted(page.origin))) return false;
  showPermissionToast(page.hostname);
  return true;
}

/**
 * 监听 background 发来的 "content script 不可达" 通知，给用户一个可直接操作的提示：
 * - 当前站点未授权 → toast 带「授权」按钮，点击直接弹出浏览器原生授权框（与顶部横幅一致，
 *   授权与否都由用户在弹框里决定）；授权成功后 background 会立即向当前页面注入脚本。
 * - 当前站点已授权或页面不可注入 → 不重复打扰用户。
 * 仅对用户主动发起的操作生效（见 background 的 sendTabMessageSafe notifyOnUnreachable）。
 */
export function useContentScriptUnreachableToast(tabId: number | null): void {
  useEffect(() => {
    const handler = (message: { action?: string; tabId?: number }) => {
      if (message?.action !== 'contentScriptUnreachable') return;
      if (tabId != null && message.tabId !== tabId) return;
      void (async () => {
        const page = await getInspectedPage(tabId);
        if (!page) return; // chrome:// 等特殊页无法注入脚本，提示也没用

        if (await isOriginGranted(page.origin)) return;

        // 未授权 → 使用与其他页面操作相同的授权提示与浏览器原生授权框。
        showPermissionToast(page.hostname);
      })();
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [tabId]);
}
