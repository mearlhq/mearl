import { useState, useCallback, useEffect } from 'react';
import { isLoginError } from '../utils/loginError';
import { withSilentLogin, resetSilentLoginState } from '../utils/silentLogin';

import { callBrowserUiOperation } from '../utils/browserUiSettings';
import { setBrowserUiLoginOpen, useBrowserUiLogin } from '../utils/browserUiLogin';
import type { CaptureIdentity } from '../../../shared/captureIdentity';
import { parseCaptureIdentity } from '../../../shared/captureIdentity';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../shared/browserRequestUi';

export type UserInfo = CaptureIdentity;

type UserInfoSource = 'cookie-first' | 'full';

interface UseCaptureIdentityOptions {
  /**
   * 用户信息来源：
   * - 'cookie-first'（默认）：优先使用能力包提供的 Cookie 身份，缺失时读取完整身份
   * - 'full'：直接调用 能力包接口，读取完整身份字段
   *
   * 注意：同一页面内多个调用者应保持一致；首个订阅者的 source 决定本次会话的获取方式。
   */
  source?: UserInfoSource;
  /**
   * 是否延迟获取用户信息。
   * 设为 true 时，hook 挂载不会自动触发 fetch，仅订阅共享状态。
   * 适用于只关心登录弹窗状态、不主动需要 userInfo 的调用方（如 Panel 顶层）。
   */
  lazy?: boolean;
}

type FetchResult = { success: boolean; data?: UserInfo; error?: string };
type UserInfoListener = (info: UserInfo | null) => void;
type LoginRequiredListener = (required: boolean) => void;
type LoginModalListener = (isOpen: boolean) => void;

// ─── 共享状态：当前页面会话内所有实例共用 ────────────────────────────────────
let sharedUserInfo: UserInfo | null = null;
let sharedLoginRequired = false;
let inFlightFetch: Promise<FetchResult> | null = null;
let selectionGeneration = 0;
const selectionListeners = new Set<() => void>();
let listening = false;
function listenForSelectionChanges() {
  if (listening) return;
  listening = true;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.action !== BROWSER_REQUEST_UI_CHANGED) return;
    selectionGeneration++;
    sharedLoginPollingInFlight = false;
    inFlightFetch = null;
    setSharedUserInfo(null);
    setSharedLoginRequired(false);
    if (sharedLoginModalOpen) void setSharedLoginModalOpen(false).catch(console.warn);
    resetSilentLoginState('capture');
    for (const listener of selectionListeners) listener();
  });
}

const userInfoListeners = new Set<UserInfoListener>();
const loginRequiredListeners = new Set<LoginRequiredListener>();
const confirmedIdentityListeners = new Set<(info: UserInfo | null, required: boolean) => void>();
function confirmCaptureIdentity(info: UserInfo | null, required: boolean) {
  setSharedUserInfo(info); setSharedLoginRequired(required);
  for (const listener of confirmedIdentityListeners) listener(info, required);
}
export function subscribeCaptureIdentity(listener: (info: UserInfo | null, required: boolean) => void) {
  confirmedIdentityListeners.add(listener);
  return () => { confirmedIdentityListeners.delete(listener); };
}

function setSharedUserInfo(next: UserInfo | null) {
  sharedUserInfo = next;
  userInfoListeners.forEach(listener => listener(sharedUserInfo));
}

function setSharedLoginRequired(next: boolean) {
  if (sharedLoginRequired === next) return;
  sharedLoginRequired = next;
  loginRequiredListeners.forEach(listener => listener(sharedLoginRequired));
}

async function runFetchUserInfo(source: UserInfoSource, loginProbe = false): Promise<FetchResult> {
  const generation = selectionGeneration;
  try {
    const operation = async () => {
      if (generation !== selectionGeneration) throw new Error('Capture identity provider changed');
      const result = await callBrowserUiOperation<FetchResult>('capture.identity', { source });
      if (generation !== selectionGeneration) throw new Error('Capture identity provider changed');
      return result;
    };
    const response = sharedLoginModalOpen || loginProbe ? await operation() : (await withSilentLogin({
      service: 'capture', isLoginError: result => isLoginError(result.error), operation,
    })).result;

    if (generation !== selectionGeneration) return { success: false, error: 'Capture identity provider changed' };
    if (response.success && response.data) {
      const identity = parseCaptureIdentity(response.data);
      confirmCaptureIdentity(identity, false);
      return { success: true, data: identity };
    }
    if (isLoginError(response.error)) {
      confirmCaptureIdentity(null, true);
    }
    console.warn('[Capture identity] Failed to fetch user info:', response.error || 'Unknown error');
    return { success: false, error: response.error };
  } catch (error) {
    if (generation !== selectionGeneration) return { success: false, error: 'Capture identity provider changed' };
    console.warn('[Capture identity] Failed to fetch user info:', error);
    if (isLoginError(String(error))) {
      confirmCaptureIdentity(null, true);
    }
    return { success: false, error: String(error) };
  }
}

function sharedFetchUserInfo(source: UserInfoSource, loginProbe = false): Promise<FetchResult> {
  if (inFlightFetch) return inFlightFetch;
  const pending = runFetchUserInfo(source, loginProbe).finally(() => {
    if (inFlightFetch === pending) inFlightFetch = null;
  });
  inFlightFetch = pending;
  return pending;
}

// ─── 登录弹窗状态 ────────────────────────────────────────────────────────────
let sharedLoginModalOpen = false;
let sharedLoginPollingTimer: ReturnType<typeof setInterval> | null = null;
let sharedLoginPollingBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
let sharedLoginPollingInFlight = false;
let sharedLoginStatusRefresher: (() => Promise<boolean>) | null = null;
const loginModalListeners = new Set<LoginModalListener>();

function notifyLoginModalListeners() {
  loginModalListeners.forEach(listener => listener(sharedLoginModalOpen));
}

function stopSharedLoginPolling() {
  if (sharedLoginPollingBootstrapTimer) {
    clearTimeout(sharedLoginPollingBootstrapTimer);
    sharedLoginPollingBootstrapTimer = null;
  }
  if (sharedLoginPollingTimer) {
    clearInterval(sharedLoginPollingTimer);
    sharedLoginPollingTimer = null;
  }
}

async function runSharedLoginStatusRefresh() {
  if (sharedLoginPollingInFlight || !sharedLoginModalOpen || !sharedLoginStatusRefresher) {
    return;
  }
  sharedLoginPollingInFlight = true;
  const generation = selectionGeneration;
  try {
    const success = await sharedLoginStatusRefresher();
    if (success && generation === selectionGeneration) {
      closeLoginModalAfterSuccess();
    }
  } finally {
    if (generation === selectionGeneration) sharedLoginPollingInFlight = false;
  }
}

function ensureSharedLoginPolling() {
  if (!sharedLoginModalOpen || sharedLoginPollingTimer) {
    return;
  }
  sharedLoginPollingBootstrapTimer = setTimeout(() => {
    void runSharedLoginStatusRefresh();
  }, 1200);
  sharedLoginPollingTimer = setInterval(() => {
    void runSharedLoginStatusRefresh();
  }, 2000);
}

let loginTransition: Promise<unknown> = Promise.resolve();
function setSharedLoginModalOpen(isOpen: boolean): Promise<void> {
  const generation = selectionGeneration;
  const change = () => changeSharedLoginModalOpen(isOpen, generation);
  const pending = loginTransition.then(change, change);
  loginTransition = pending.catch(() => {});
  return pending;
}
async function changeSharedLoginModalOpen(isOpen: boolean, generation: number) {
  if (isOpen && generation !== selectionGeneration) return;
  if (sharedLoginModalOpen === isOpen) return;
  if (!isOpen) {
    sharedLoginModalOpen = false;
    stopSharedLoginPolling();
    notifyLoginModalListeners();
    await setBrowserUiLoginOpen('capture', false).catch(error => console.warn('[Account] Login release failed', error));
    return;
  }
  await setBrowserUiLoginOpen('capture', true);
  if (generation !== selectionGeneration) {
    await setBrowserUiLoginOpen('capture', false);
    return;
  }
  sharedLoginModalOpen = true;
  ensureSharedLoginPolling();
  notifyLoginModalListeners();
}

function closeLoginModalAfterSuccess() {
  if (!sharedLoginModalOpen) return;
  void setSharedLoginModalOpen(false);
  resetSilentLoginState('capture');
}

/**
 * 抓包身份管理 Hook
 *
 * - 共享状态：同一页面会话内所有调用者共用 userInfo / loginRequired / loginModalOpen
 * - 自动获取：首个订阅者挂载且当前没有缓存/进行中请求时，自动发起一次 fetch
 * - 并发去重：多个组件同时挂载只产生一次 /user/get 请求
 * - 不持久化：关闭 panel/devtools 后状态清空，下次打开必然校验真实登录态
 */
export function useCaptureIdentity(options: UseCaptureIdentityOptions = {}) {
  listenForSelectionChanges();
  const { source = 'cookie-first', lazy = false } = options;
  const acceptedLogin = useBrowserUiLogin('capture');

  const [userInfo, setUserInfoState] = useState<UserInfo | null>(sharedUserInfo);
  const [loginRequired, setLoginRequiredState] = useState<boolean>(sharedLoginRequired);
  const [loginModalOpen, setLoginModalOpen] = useState(sharedLoginModalOpen);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState(selectionGeneration);

  const fetchUserInfo = useCallback(
    async ({ silent = false, loginProbe = false }: { silent?: boolean; loginProbe?: boolean } = {}): Promise<FetchResult> => {
      const generation = selectionGeneration;
      if (!silent) setLoading(true);
      try {
        return await sharedFetchUserInfo(source, loginProbe);
      } finally {
        if (!silent && generation === selectionGeneration) setLoading(false);
      }
    },
    [source],
  );

  // 订阅共享状态变化 + 首个订阅者触发自动 fetch
  useEffect(() => {
    const userListener: UserInfoListener = info => setUserInfoState(info);
    const loginRequiredListener: LoginRequiredListener = required =>
      setLoginRequiredState(required);
    const loginModalListener: LoginModalListener = isOpen => setLoginModalOpen(isOpen);
    userInfoListeners.add(userListener);
    loginRequiredListeners.add(loginRequiredListener);
    loginModalListeners.add(loginModalListener);
    const selectionListener = () => { setLoading(false); setSelection(selectionGeneration); };
    selectionListeners.add(selectionListener);

    // 订阅时同步一次最新共享状态，避免初始化后 shared 值被改写却未收到通知
    setUserInfoState(sharedUserInfo);
    setLoginRequiredState(sharedLoginRequired);
    setLoginModalOpen(sharedLoginModalOpen);

    // 首个非 lazy 订阅者：本会话还没拉过用户信息时自动 fetch
    if (!lazy && !sharedUserInfo && !inFlightFetch) {
      void fetchUserInfo({ silent: true });
    }

    return () => {
      userInfoListeners.delete(userListener);
      loginRequiredListeners.delete(loginRequiredListener);
      loginModalListeners.delete(loginModalListener);
      selectionListeners.delete(selectionListener);
    };
  }, [selection]);

  // 注册当前实例的 refresher，供登录弹窗轮询使用
  useEffect(() => {
    const refreshLoginStatus = async () => {
      const result = await fetchUserInfo({ silent: true });
      return !!(result.success && result.data);
    };
    sharedLoginStatusRefresher = refreshLoginStatus;
    if (sharedLoginModalOpen) ensureSharedLoginPolling();
    return () => {
      if (sharedLoginStatusRefresher === refreshLoginStatus) {
        sharedLoginStatusRefresher = null;
      }
    };
  }, [fetchUserInfo]);

  // 打开内嵌登录弹窗：先 await DNR 规则安装完成，再触发渲染
  const openLoginWindow = useCallback(async () => {
    await setSharedLoginModalOpen(true);
  }, []);

  const closeLoginWindow = useCallback(async () => {
    void setSharedLoginModalOpen(false);
    resetSilentLoginState('capture');
    await fetchUserInfo({ silent: true });
  }, [fetchUserInfo]);

  return {
    userInfo,
    loading,
    loginRequired,
    loginModalOpen,
    loginDefinition: acceptedLogin.definition,
    isLoggedIn: Boolean(userInfo?.subject),
    fetchUserInfo,
    openLoginWindow,
    closeLoginWindow,
  };
}

/**
 * 包裹能力包请求：登录失效时自动静默续期并重试。
 * 整个过程是同步 await，调用方 loading 不中断。
 * 如果静默失败，会自动设置 sharedLoginRequired=true。
 */
export async function withCaptureAutoLogin<T extends { success: boolean; error?: string }>(
  operation: () => Promise<T>,
): Promise<T> {
  const generation = selectionGeneration;
  const { result, silentLoginSucceeded } = await withSilentLogin({
    service: 'capture',
    isLoginError: r => isLoginError(r.error),
    operation: async () => {
      if (generation !== selectionGeneration) throw new Error('Capture identity provider changed');
      const result = await operation();
      if (generation !== selectionGeneration) throw new Error('Capture identity provider changed');
      return result;
    },
  });

  if (generation !== selectionGeneration) throw new Error('Capture identity provider changed');

  if (result.success) {
    if (silentLoginSucceeded) {
      confirmCaptureIdentity(sharedUserInfo, false);
    }
    return result;
  }

  if (isLoginError(result.error)) {
    confirmCaptureIdentity(null, true);
    await setSharedLoginModalOpen(true);
  }

  return result;
}

/** The document host shares the identity with sibling request UI entry points. */
export function captureIdentitySelection() { return selectionGeneration; }
export function acceptCaptureIdentity(info: Record<string, unknown> | null, loginRequired: boolean, expectedSelection = selectionGeneration) {
  if (expectedSelection !== selectionGeneration) throw new Error('Capture identity provider changed');
  const identity = info === null ? null : parseCaptureIdentity(info);
  if (JSON.stringify(identity) !== JSON.stringify(sharedUserInfo)) setSharedUserInfo(identity);
  setSharedLoginRequired(loginRequired);
}
export function dismissCaptureLogin() { return setSharedLoginModalOpen(false); }
