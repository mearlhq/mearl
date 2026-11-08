/** Domain requests prefer the open toolbar popup and fall back to a dedicated window. */

import type { RequestPermissionParams } from '@mearl/browser-core';
import {
  normalizeDomainInputToOrigin,
  grantAgentOriginPermission,
} from '../../../shared/proxyPermissions';
import {
  POPUP_PERMISSION_REQUEST,
  POPUP_PERMISSION_CANCEL,
  POPUP_PERMISSION_ALLOW,
  PERMISSION_REQUEST_TIMEOUT_MS,
  type DomainPermissionDecision,
} from '../../../shared/permissionRequest';

async function requestInPopup(
  domain: string,
  origin: string,
  requestId: string,
): Promise<DomainPermissionDecision | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let grantRequest: Promise<DomainPermissionDecision> | undefined;
  let granting = false;
  const popupUrl = chrome.runtime.getURL('src/pages/popup/index.html');
  const allowListener = (
    message: { type?: string; requestId?: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: DomainPermissionDecision) => void,
  ) => {
    if (
      message?.type !== POPUP_PERMISSION_ALLOW ||
      message.requestId !== requestId ||
      sender.id !== chrome.runtime.id ||
      sender.url !== popupUrl ||
      sender.tab
    ) {
      return;
    }
    if (!granting || !grantRequest) {
      granting = true;
      // The click's message carries the user gesture; request before any async work.
      // Keep the browser callback and storage write alive if the toolbar popup closes.
      grantRequest = grantAgentOriginPermission(origin)
        .then(granted => ({ granted, ...(granted ? { origin } : {}) }))
        .catch(error => ({
          granted: false,
          error: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          granting = false;
        });
    }
    void grantRequest.then(sendResponse);
    return true;
  };
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.POPUP],
    });
    if (contexts.length === 0) return;
    chrome.runtime.onMessage.addListener(allowListener);
    return await Promise.race([
      chrome.runtime
        .sendMessage({ type: POPUP_PERMISSION_REQUEST, domain, requestId })
        .catch(() => undefined)
        .then(decision => decision ?? grantRequest),
      new Promise<DomainPermissionDecision>(resolve => {
        timer = setTimeout(() => resolve({ granted: false }), PERMISSION_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Context discovery may be unavailable; use the standalone confirmation.
    return;
  } finally {
    chrome.runtime.onMessage.removeListener(allowListener);
    clearTimeout(timer);
    if (timer !== undefined) {
      void chrome.runtime.sendMessage({ type: POPUP_PERMISSION_CANCEL, requestId }).catch(() => {});
    }
  }
}

interface PermissionDecisionMessage {
  type: 'permission_decision';
  requestId: string;
  /** true = user approved and chrome.permissions.request succeeded */
  granted: boolean;
  origin?: string;
}

function generateRequestId(): string {
  return `pr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function handleRequestPermission(
  data: RequestPermissionParams,
): Promise<{ granted: boolean; domain: string; origin?: string }> {
  const { domain } = data;

  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    throw new Error('Invalid domain: domain must be a non-empty string');
  }

  const origin = normalizeDomainInputToOrigin(domain.trim());
  if (!origin) {
    throw new Error(
      `Invalid domain format: "${domain}". Provide a plain hostname like "example.com".`,
    );
  }

  const requestId = generateRequestId();
  const decision = await requestInPopup(domain.trim(), origin, requestId);
  if (decision && typeof decision.granted === 'boolean') {
    return decision.granted ? { granted: true, domain, origin } : { granted: false, domain };
  }
  const popupUrl =
    chrome.runtime.getURL('src/pages/permission-request/index.html') +
    `?domain=${encodeURIComponent(domain.trim())}&requestId=${encodeURIComponent(requestId)}`;

  // Calculate center position based on the last focused window's screen
  const popupWidth = 380;
  // Window dimensions include the title bar and Chrome's debugger notification.
  const popupHeight = 300;
  let left: number | undefined;
  let top: number | undefined;
  try {
    const lastWin = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (
      lastWin.left != null &&
      lastWin.top != null &&
      lastWin.width != null &&
      lastWin.height != null
    ) {
      left = Math.round(lastWin.left + (lastWin.width - popupWidth) / 2);
      top = Math.round(lastWin.top + (lastWin.height - popupHeight) / 2);
    }
  } catch {
    // fallback: let Chrome decide position
  }

  // Open the confirmation popup window
  const win = await chrome.windows.create({
    url: popupUrl,
    type: 'popup',
    width: popupWidth,
    height: popupHeight,
    left,
    top,
    focused: true,
    state: 'normal',
  });

  if (!win?.id) {
    throw new Error('Failed to open permission request window');
  }

  const windowId = win.id;

  // Wait for the user's decision (message from popup) or timeout / window close
  return new Promise<{ granted: boolean; domain: string; origin?: string }>(resolve => {
    let resolved = false;
    const timer: { id?: ReturnType<typeof setTimeout> } = {};

    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.windows.onRemoved.removeListener(windowClosedListener);
      clearTimeout(timer.id);
    };

    const done = (granted: boolean, origin?: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(granted ? { granted: true, domain, origin } : { granted: false, domain });
    };

    const messageListener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      const msg = message as PermissionDecisionMessage;
      if (
        msg?.type === 'permission_decision' &&
        msg.requestId === requestId &&
        _sender.url === popupUrl &&
        _sender.id === chrome.runtime.id
      ) {
        sendResponse({});
        done(msg.granted, msg.origin);
      }
    };

    const windowClosedListener = (closedWindowId: number) => {
      if (closedWindowId === windowId) {
        done(false, undefined);
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    chrome.windows.onRemoved.addListener(windowClosedListener);

    timer.id = setTimeout(() => {
      // Close the popup if still open and resolve as denied
      chrome.windows.remove(windowId).catch(() => {});
      done(false);
    }, PERMISSION_REQUEST_TIMEOUT_MS);
  });
}
