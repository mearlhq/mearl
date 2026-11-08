import { createBrowserUiLoginLease } from './browserUiLogin';
export interface SilentLoginOptions<T> {
  service: string;
  isLoginError: (result: T) => boolean;
  operation: () => Promise<T>;
  timeoutMs?: number;
  cooldownMs?: number;
}

export interface SilentLoginResult<T> {
  result: T;
  silentLoginSucceeded: boolean;
}

interface ServiceState {
  inFlight: Promise<boolean> | null;
  lastAttemptAt: number;
  lastFailed: boolean;
}

const serviceStates = new Map<string, ServiceState>();

function getServiceState(service: string): ServiceState {
  let state = serviceStates.get(service);
  if (!state) {
    state = { inFlight: null, lastAttemptAt: 0, lastFailed: false };
    serviceStates.set(service, state);
  }
  return state;
}

export function resetSilentLoginState(service: string) {
  // Existing attempts retain their own state and lease; the next session cannot join them.
  serviceStates.delete(service);
}

function attemptSilentLogin(
  service: string,
  state: ServiceState,
  timeoutMs: number,
  cooldownMs: number,
): Promise<boolean> {
  if (state.inFlight) return state.inFlight;

  const now = Date.now();
  if (state.lastFailed && now - state.lastAttemptAt < cooldownMs) {
    return Promise.resolve(false);
  }

  state.lastAttemptAt = now;

  state.inFlight = (async () => {
    let lease: Awaited<ReturnType<typeof createBrowserUiLoginLease>>;
    try { lease = await createBrowserUiLoginLease(service); }
    catch { state.lastFailed = true; return false; }
    try {
      return await new Promise<boolean>(resolve => {
        const iframe = document.createElement('iframe');
        iframe.src = lease.definition.url;
        iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';
        iframe.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox');
        let settled = false;
        const finish = (success: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          iframe.remove();
          state.lastFailed = !success;
          resolve(success);
        };
        const timeout = setTimeout(() => finish(false), timeoutMs);
        iframe.addEventListener('load', () => finish(true), { once: true });
        document.body.appendChild(iframe);
      });
    } finally { await lease.close().catch(() => {}); }
  })().finally(() => { state.inFlight = null; });

  return state.inFlight;
}

/**
 * 执行 operation，如果结果为登录失效，尝试静默 iframe 续期后重试。
 * 整个过程是同步 await，调用方 loading 不中断。
 */
export async function withSilentLogin<T>(
  opts: SilentLoginOptions<T>,
): Promise<SilentLoginResult<T>> {
  const {
    service,
    isLoginError,
    operation,
    timeoutMs = 10_000,
    cooldownMs = 30_000,
  } = opts;

  const state = getServiceState(service);
  const result = await operation();

  if (!isLoginError(result)) {
    return { result, silentLoginSucceeded: false };
  }

  if (serviceStates.get(service) !== state) return { result, silentLoginSucceeded: false };
  const iframeLoaded = await attemptSilentLogin(service, state, timeoutMs, cooldownMs);

  if (!iframeLoaded || serviceStates.get(service) !== state) {
    return { result, silentLoginSucceeded: false };
  }

  const retryResult = await operation();
  const succeeded = !isLoginError(retryResult);

  if (!succeeded) {
    state.lastFailed = true;
  }

  return {
    result: retryResult,
    silentLoginSucceeded: succeeded,
  };
}
