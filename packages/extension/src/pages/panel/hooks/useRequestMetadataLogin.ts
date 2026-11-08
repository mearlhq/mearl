import { browserDocumentToken, sendBrowserDocumentMessage } from '../../../shared/browserDocument';
import { useState, useCallback, useEffect } from 'react';
import {
  browserRequestLoginError,
  type BrowserRequestUi,
} from '@mearl/preset/bundles';
import { getBrowserRequestUiState } from '../utils/browserRequestUiState';
import {
  BROWSER_REQUEST_UI_ACTION,
  BROWSER_REQUEST_LOGIN_PORT,
} from '../../../shared/browserRequestUi';
import { showToast } from '../utils/toast';
import { t } from '../utils/i18n';

type LoginModalListener = (isOpen: boolean, definition: BrowserRequestUi | null) => void;

let sharedOpen = false;
const listeners = new Set<LoginModalListener>();
let loginDefinition = getBrowserRequestUiState().definition;
let loginLease: string | null = null;
let loginPort: chrome.runtime.Port | null = null;
let transition: Promise<unknown> = Promise.resolve();

function notify() {
  listeners.forEach(l => l(sharedOpen, loginDefinition));
}

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
function cancelReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}
function connectLogin(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: BROWSER_REQUEST_LOGIN_PORT + id + ':' + browserDocumentToken });
    } catch (error) {
      reject(error);
      return;
    }
    loginPort = port;
    let ready = false;
    const timeout = setTimeout(() => {
      reject(new Error('Login connection timed out'));
      port.disconnect();
    }, 5_000);
    port.onMessage.addListener(message => {
      if (message?.ready !== true || ready) return;
      ready = true;
      clearTimeout(timeout);
      resolve();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      clearTimeout(timeout);
      if (!ready) reject(new Error('Login connection closed'));
      if (loginPort !== port) return;
      loginPort = null;
      if (sharedOpen && loginLease === id) scheduleReconnect(id);
    });
  });
}
function scheduleReconnect(id: string) {
  cancelReconnect();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (sharedOpen && loginLease === id && !loginPort) {
      void connectLogin(id).catch(() => {
        if (sharedOpen && loginLease === id) scheduleReconnect(id);
      });
    }
  }, 1_000);
}
async function changeOpen(isOpen: boolean) {
  if (sharedOpen === isOpen) return;
  if (isOpen) {
    const snapshot = getBrowserRequestUiState();
    if (!snapshot.selected) throw new Error('CAPABILITY_NOT_INSTALLED');
    const id = crypto.randomUUID();
    loginLease = id;
    try {
      await connectLogin(id);
      const response = await sendBrowserDocumentMessage({
        action: BROWSER_REQUEST_UI_ACTION,
        data: { operation: 'loginOpen', id, revision: snapshot.selected?.revision ?? null },
      });
      if (!response?.success || response.data?.id !== id || !response.data?.definition)
        throw new Error(response?.error || 'Login preparation failed');
      loginDefinition = response.data.definition;
    } catch (error) {
      loginLease = null;
      cancelReconnect();
      loginPort?.disconnect();
      loginPort = null;
      void sendBrowserDocumentMessage({ action: BROWSER_REQUEST_UI_ACTION, data: { operation: 'loginClose', id } })
        .catch(() => {});
      throw error;
    }
  } else {
    const id = loginLease;
    loginLease = null;
    cancelReconnect();
    if (id)
      void sendBrowserDocumentMessage({ action: BROWSER_REQUEST_UI_ACTION, data: { operation: 'loginClose', id } })
        .catch(() => {});
    loginPort?.disconnect();
    loginPort = null;
  }
  sharedOpen = isOpen;
  if (isOpen && !loginPort && loginLease) scheduleReconnect(loginLease);
  notify();
}
function setOpen(isOpen: boolean) {
  const next = transition.then(
    () => changeOpen(isOpen),
    () => changeOpen(isOpen),
  );
  transition = next.catch(() => {});
  return next;
}

/** 判断错误信息是否为 请求元数据提供者 未登录 */
export function isRequestMetadataLoginError(msg: string): boolean {
  const definition = getBrowserRequestUiState().definition;
  return definition ? browserRequestLoginError(definition, msg) : false;
}

/**
 * 请求元数据提供者 登录弹窗状态管理 Hook（跨组件共享，与 共享身份同模式）。
 * 在需要展示 请求元数据提供者 登录弹窗的组件中调用，并在根组件挂载 <LoginModal>。
 *
 * 注意：此 Hook 有意不做登录成功轮询。请求元数据提供者 没有简单可靠的接口来判断
 * 登录状态，用户完成登录后手动关闭弹窗即可，下次触发 getApiSchema 时会
 * 自动携带新 Cookie 重试。
 */
export function useRequestMetadataLogin() {
  const [loginModalOpen, setLoginModalOpen] = useState(sharedOpen);
  const [definition, setDefinition] = useState(loginDefinition);

  useEffect(() => {
    const listener = (isOpen: boolean, nextDefinition: BrowserRequestUi | null) => {
      setDefinition(nextDefinition);
      setLoginModalOpen(isOpen);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const openLoginModal = useCallback(async () => {
    await setOpen(true).catch(error => {
      console.warn('[Request UI] Login preparation failed', error);
      showToast(t('requestMetadataLoginOpenFailed'), 'error');
    });
  }, []);
  const closeLoginModal = useCallback(() => {
    void setOpen(false);
  }, []);

  return { loginModalOpen, openLoginModal, closeLoginModal, loginDefinition: definition };
}
