import type { CapturedRequest, RumEvent } from '../types';

const SSE_RECONCILE_WINDOW_MS = 5000;

export interface PanelRequestCaptureState {
  source: 'devtools' | 'debugger';
  debuggerSince: number;
}

export function acceptsDebuggerCapture(
  state: PanelRequestCaptureState,
  timestampMs: number,
): boolean {
  return state.source === 'debugger' && timestampMs >= state.debuggerSince;
}

export function acceptsCollectorRequest(
  state: PanelRequestCaptureState,
  request: CapturedRequest,
): boolean {
  return (
    request.captureTransport === 'background' || acceptsDebuggerCapture(state, request.timestampMs)
  );
}

function mergeRequest(existing: CapturedRequest, incoming: CapturedRequest): CapturedRequest {
  const merged = { ...existing, ...incoming };

  if (existing.responseOverride && !incoming.responseOverride) {
    merged.responseOverride = existing.responseOverride;
  }
  if (existing.isAutoTranslated && !incoming.isAutoTranslated) {
    merged.isAutoTranslated = true;
  }
  if (existing._createdByInjected) {
    merged._createdByInjected = true;
    merged._internalRequestId = existing._internalRequestId;
    merged.sseMessages = existing.sseMessages;
    if (!existing.isPending && existing.responseBody !== null) {
      merged.isPending = false;
      merged.responseBody = existing.responseBody;
    }
  }

  return merged;
}

function findInjectedSseMatch(requests: CapturedRequest[], incoming: CapturedRequest): number {
  return requests.findIndex(
    request =>
      request._createdByInjected &&
      request.captureSequence === undefined &&
      request.url === incoming.url &&
      request.apiName === incoming.apiName &&
      Math.abs(request.timestampMs - incoming.timestampMs) <= SSE_RECONCILE_WINDOW_MS,
  );
}

/** 将后台采集结果按稳定 ID 合并，同时兼容注入脚本提供的 SSE 逐条消息。 */
export function mergeCapturedRequests(
  current: CapturedRequest[],
  incomingRequests: CapturedRequest[],
  removedRequestIds: number[] = [],
): CapturedRequest[] {
  const removed = new Set(removedRequestIds);
  const next = current.filter(request => !removed.has(request.id));

  for (const incoming of incomingRequests) {
    if (removed.has(incoming.id)) continue;
    let index = next.findIndex(request => request.id === incoming.id);
    if (index === -1) index = findInjectedSseMatch(next, incoming);

    if (index === -1) {
      next.push(incoming);
    } else {
      next[index] = mergeRequest(next[index], incoming);
    }
  }

  return next;
}

export function mergeCapturedEvents(
  current: RumEvent[],
  incomingEvents: RumEvent[],
  removedEventIds: string[] = [],
): RumEvent[] {
  const removed = new Set(removedEventIds);
  const byId = new Map(
    current.filter(event => !removed.has(event.id)).map(event => [event.id, event]),
  );
  for (const event of incomingEvents) {
    if (!removed.has(event.id)) byId.set(event.id, event);
  }
  return Array.from(byId.values());
}
