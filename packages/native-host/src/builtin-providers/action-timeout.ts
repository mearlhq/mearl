import { shouldObservePageAction } from '@mearl/browser-core';

const DEFAULT_TIMEOUT_MS = 15000;

export function toTimeoutMs(action: string, data: any): number {
  if (
    action === 'page_runtime' &&
    ['send', 'message_commit'].includes(data?.operation) &&
    data.timeoutSec !== undefined
  ) {
    if (
      typeof data.timeoutSec !== 'number' ||
      !Number.isFinite(data.timeoutSec) ||
      data.timeoutSec <= 0 ||
      data.timeoutSec > 300
    )
      throw new Error('Invalid page request timeout');
    return data.timeoutSec * 1000;
  }
  if (action === 'send_request') {
    const timeoutMs = Number(data && data.timeout ? data.timeout : 30000);
    return timeoutMs + 5000;
  }
  if (action === 'page_wait') {
    const timeoutMs = Number(data?.time ?? data?.timeout ?? 10000);
    return timeoutMs + 5000;
  }
  if (action === 'tab_open') {
    return 40000;
  }
  if (action === 'run_actions') {
    const actions = Array.isArray(data?.actions) ? data.actions : [{}];
    const timeoutMs = actions.reduce((total: number, step: any) => {
      const stepAction = String(step?.action ?? '');
      if (!stepAction || stepAction === 'run_actions') return total + DEFAULT_TIMEOUT_MS;
      return total + toTimeoutMs(stepAction, step?.data ?? {});
    }, 0);
    return Math.max(DEFAULT_TIMEOUT_MS, timeoutMs);
  }
  // Page interaction actions run with built-in observation unless disabled,
  // so the socket timeout must cover the observation and navigation windows.
  if (shouldObservePageAction(action, data)) {
    const observationMs = Math.min(Math.max(Number(data?.observe?.timeoutMs ?? 3000), 500), 30000);
    const navigationGraceMs = Math.min(
      Math.max(Number(data?.observe?.navigationGraceMs ?? 1000), 0),
      5000,
    );
    const navigationTimeoutMs = Math.min(
      Math.max(Number(data?.observe?.navigationTimeoutMs ?? 15000), 1000),
      30000,
    );
    return Math.max(
      DEFAULT_TIMEOUT_MS,
      observationMs + navigationGraceMs + 4000 + navigationTimeoutMs + 5000,
    );
  }
  return DEFAULT_TIMEOUT_MS;
}
