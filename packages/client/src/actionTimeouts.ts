import {
  PAGE_ACT_ACTIONS,
  PAGE_UPLOAD_FILE_TRANSFER_TIMEOUT_MS,
  type PageActAction,
} from '@mearl/browser-core';

const SEND_REQUEST_FILE_TRANSFER_TIMEOUT_MS = 120_000;
// Persistent Providers may need to synchronize remote state before closing an instance.
const BROWSER_CLOSE_TIMEOUT_SEC = 18 * 60;

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, minimum), maximum);
}

const OBSERVED_PAGE_ACTIONS = new Set<PageActAction>(PAGE_ACT_ACTIONS);

export function resolveObservedActionTimeoutSec(data: Record<string, any>): number {
  const observe = data.observe ?? {};
  const observationMs = boundedNumber(observe.timeoutMs, 3000, 500, 30000);
  const navigationGraceMs = boundedNumber(observe.navigationGraceMs, 1000, 0, 5000);
  const navigationTimeoutMs = boundedNumber(observe.navigationTimeoutMs, 15000, 1000, 30000);
  const totalMs = observationMs + navigationGraceMs + 4000 + navigationTimeoutMs + 5000;
  return Math.max(20, Math.ceil(totalMs / 1000));
}

export function resolveActionTimeoutSec(
  action: string,
  data: Record<string, any>,
  fallback = 15,
): number {
  if (action === 'send_request') {
    const transferTimeoutMs =
      data.bodyFile !== undefined || (Array.isArray(data.files) && data.files.length > 0)
        ? SEND_REQUEST_FILE_TRANSFER_TIMEOUT_MS
        : 0;
    return Math.max(
      fallback,
      Math.ceil(((data.timeout ?? 30000) + transferTimeoutMs + 5000) / 1000),
    );
  }
  if (action === 'page_download')
    return Math.max(fallback, Math.ceil((Number(data.timeout ?? 30000) + 10000) / 1000));
  if (action === 'page_record' && data.operation === 'stop') return Math.max(fallback, 60);
  if (action === 'page_wait') {
    const waitMs = data.time ?? data.timeout ?? 10000;
    return Math.max(fallback, Math.ceil((Number(waitMs) + 5000) / 1000));
  }
  if (action === 'tab_open') return Math.max(fallback, 40);
  if (action === 'set_cookie' && data.reload === true) return Math.max(fallback, 40);
  if (action === 'browser_manage') {
    if (data.operation === 'launch' || data.operation === 'attach') return Math.max(fallback, 90);
    if (data.operation === 'close' || data.operation === 'detach')
      return Math.max(fallback, BROWSER_CLOSE_TIMEOUT_SEC);
  }
  if (action === 'run_actions') {
    const actions = Array.isArray(data.actions) ? data.actions : [{}];
    const timeoutSec = actions.reduce((total: number, step: Record<string, any>) => {
      const stepAction = String(step?.action ?? '');
      if (!stepAction || stepAction === 'run_actions') return total + 15;
      return total + resolveActionTimeoutSec(stepAction, step?.data ?? {}, 15);
    }, 0);
    return Math.max(fallback, timeoutSec);
  }
  // 页面交互动作默认内置观察，超时需覆盖观察与导航窗口；observe:false 时是裸动作，用默认超时
  const observedAction = OBSERVED_PAGE_ACTIONS.has(action as PageActAction);
  const observationEnabled =
    action === 'page_eval'
      ? data.observe !== null && typeof data.observe === 'object' && !Array.isArray(data.observe)
      : data.observe !== false;
  if (action === 'page_upload') {
    const actionTimeoutSec = observationEnabled ? resolveObservedActionTimeoutSec(data) : fallback;
    return Math.max(
      fallback,
      actionTimeoutSec + Math.ceil(PAGE_UPLOAD_FILE_TRANSFER_TIMEOUT_MS / 1000),
    );
  }
  if (observedAction && observationEnabled) {
    return Math.max(fallback, resolveObservedActionTimeoutSec(data));
  }
  return fallback;
}
