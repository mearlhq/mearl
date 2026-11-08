/**
 * Background Diagnostics and Tracking Event Collector
 *
 * 基于 CDP Network domain 在 background 层采集请求，
 * 用于 Agent 控制的 tab 在无 DevTools Panel 时也能获取请求和埋点数据。
 *
 * 通过 debugger lease 与页面操作、Mock 和移动模拟共享同一个 session。
 */

import {
  compileTextPattern,
  matchesTextPattern,
  queryCapturedTrackingEvents,
  appendCapturedTrackingBatch,
  appendRequestStreamCaptureChunk as appendProtocolStreamCaptureChunk,
  appendRequestToBuffer,
  captureCheckpoint,
  createCaptureGeneration,
  createRequestBufferAccounting,
  createRequestStreamCapture as createProtocolStreamCapture,
  finishRequestStreamCapture as finishProtocolStreamCapture,
  nextCaptureSequence,
  type TrackingEventQueryOptions,
  type CapturedTrackingEventQueryResult,
  queryCapturedEntries,
  refreshRequestInBuffer,
  updateRequestStreamCaptureResponse as updateProtocolStreamCaptureResponse,
  type CaptureQueryResult,
  type CaptureSequenceState,
  type ConsoleLog,
  type RequestStreamCapture as ProtocolStreamCapture,
  type RequestStreamCaptureResponse as ProtocolStreamCaptureResponse,
  type RequestStreamCaptureStart as ProtocolStreamCaptureStart,
} from '@mearl/browser-core';
import { CapturedRequest, RumEvent } from '../panel/types';
import { captureBrowserTrackingDecoder, type TrackingRequestResult } from './browserTracking';
import { getCurrentLanguage } from '../panel/utils/i18n';
import { inspectBrowserRequest } from './requestInspection';
import type { RequestMetadata } from '@mearl/browser-core';
import {
  calculateHeadersSize,
  generateNonProtocolApiName,
  getHeaderValue,
  normalizeNonProtocolResourceType,
  parseJsonpResponse,
  parseRequestInfo,
  parseSseMessages,
  parseSseResponse,
} from '../panel/utils/helpers';
import { acquireDebuggerLease, type DebuggerLease } from './debuggerSessionManager';

const EVENT_BUFFER_MAX = 500;
const LOG_BUFFER_MAX = 1000;
const BUSINESS_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document', 'jsonp']);

interface NormalizedConsoleLog {
  level: string;
  message: string;
  timestampMs: number;
  source?: string;
  args: string[];
}

function remoteObjectToString(obj: any): string {
  if (obj === null || obj === undefined || obj.type === 'undefined') return 'undefined';
  if (obj.value !== undefined) return String(obj.value);
  if (obj.description) return obj.description;
  return `[${obj.type || 'Object'}]`;
}

function remoteObjectParamsToLog(
  type: string,
  args: any[],
  timestamp: number,
  stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> },
): NormalizedConsoleLog {
  const levelMap: Record<string, string> = {
    warning: 'warn',
    debug: 'debug',
    info: 'info',
    error: 'error',
    log: 'log',
    dir: 'log',
    dirxml: 'log',
    table: 'log',
    trace: 'log',
    assert: 'error',
  };
  const stringArgs = (args || []).map(remoteObjectToString);
  const message = stringArgs.join(' ');
  const topFrame = stackTrace?.callFrames?.[0];
  const filename = topFrame?.url ? topFrame.url.split('/').pop() || topFrame.url : undefined;
  const source =
    filename && topFrame?.lineNumber !== undefined
      ? `${filename}:${topFrame.lineNumber + 1}`
      : filename;

  return {
    level: levelMap[type] || 'log',
    message,
    timestampMs: Math.floor(timestamp),
    args: stringArgs.length > 0 ? stringArgs : [message],
    ...(source ? { source } : {}),
  };
}

/** Per-tab 请求缓冲区 */
const requestBuffers = new Map<number, CapturedRequest[]>();

/** Per-tab 请求缓冲区字节统计 */
const requestBufferAccounting = new Map<number, ReturnType<typeof createRequestBufferAccounting>>();

/** Per-tab console/browser log buffer. */
const logBuffers = new Map<number, ConsoleLog[]>();

interface DiagnosticsCaptureState extends CaptureSequenceState {
  droppedRequestsThroughSequence: number;
  droppedLogsThroughSequence: number;
  droppedEventsThroughSequence: number;
}

const captureStates = new Map<number, DiagnosticsCaptureState>();

/** Per-tab 埋点事件缓冲区 */
const eventBuffers = new Map<number, RumEvent[]>();

/** Per-tab 埋点请求序号，用于生成稳定且不冲突的事件 ID */
const eventSequences = new Map<number, number>();

/** Per-tab 进行中的请求（等待响应） */
interface PendingRequest {
  request: CapturedRequest;
  startMonotonicTime?: number;
}

const pendingRequests = new Map<number, Map<string, PendingRequest>>();

/** 扩展后台代发的 Protocol 流式请求不会出现在页面 CDP Network 事件中，需显式关联生命周期。 */
const backgroundProtocolStreams = new Map<number, Map<string, ProtocolStreamCapture>>();

/** 记录哪些 tab 正在采集 */
const collectingTabs = new Set<number>();

/** 每个采集任务持有一个 Network domain lease */
const collectorLeases = new Map<number, DebuggerLease>();

/** 合并同一 tab 上并发的启动请求 */
const collectionStartPromises = new Map<number, Promise<void>>();

export type RequestCollectionConsumer = 'agent' | 'response-modification' | 'device-preview-panel';

/** 同一采集会话可同时被 Agent 和 Panel 的修改响应功能复用。 */
const collectionConsumers = new Map<number, Set<RequestCollectionConsumer>>();
const businessWebViewSessions = new Map<number, Set<string>>();

export function listBusinessWebViewSessions(tabId: number): readonly string[] {
  return [...(businessWebViewSessions.get(tabId) ?? [])];
}
const networkBufferOptions = {
  maxTotalBufferSize: 10 * 1024 * 1024,
  maxPostDataSize: 5 * 1024 * 1024,
};

type CollectorTarget = chrome.debugger.Debuggee & { sessionId?: string };

function setWebViewNetwork(tabId: number, sessionId: string, enabled: boolean): Promise<unknown> {
  const target: CollectorTarget = { tabId, sessionId };
  return chrome.debugger.sendCommand(
    target,
    enabled ? 'Network.enable' : 'Network.disable',
    enabled ? networkBufferOptions : undefined,
  ).catch(() => {});
}

export async function registerRequestCollectionWebView(tabId: number, sessionId: string): Promise<void> {
  const sessions = businessWebViewSessions.get(tabId) ?? new Set<string>();
  sessions.add(sessionId);
  businessWebViewSessions.set(tabId, sessions);
  if (collectingTabs.has(tabId)) {
    await setWebViewNetwork(tabId, sessionId, true);
  }
}

export function forgetRequestCollectionWebView(tabId: number, sessionId?: string): void {
  if (sessionId === undefined) {
    businessWebViewSessions.delete(tabId);
    return;
  }
  businessWebViewSessions.get(tabId)?.delete(sessionId);
  const pending = pendingRequests.get(tabId);
  if (pending) {
    for (const key of pending.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        handleLoadingFailed(tabId, key, { errorText: 'WebView detached' });
      }
    }
  }
}

export type CollectorUpdate =
  | {
      type: 'request';
      request: CapturedRequest;
      removedRequestIds: number[];
    }
  | {
      type: 'events';
      events: RumEvent[];
      removedEventIds: string[];
    };

let collectorUpdateListener: ((tabId: number, update: CollectorUpdate) => void) | null = null;

function emitCollectorUpdate(tabId: number, update: CollectorUpdate): void {
  collectorUpdateListener?.(tabId, update);
}

function invalidateCollection(tabId: number): void {
  collectingTabs.delete(tabId);
  networkQueues.delete(tabId);
  pendingCaptureSequences.delete(tabId);
  collectionErrors.delete(tabId);  pendingRequests.delete(tabId);
  backgroundProtocolStreams.delete(tabId);
  collectorLeases.delete(tabId);
  collectionConsumers.delete(tabId);
  businessWebViewSessions.delete(tabId);
}

function getCaptureState(tabId: number): DiagnosticsCaptureState {
  const state = captureStates.get(tabId);
  if (!state) throw new Error(`Diagnostics capture is not active for tab ${tabId}`);
  return state;
}

const networkQueues = new Map<number, Promise<void>>();
const pendingCaptureSequences = new Map<number, Set<number>>();
const collectionErrors = new Map<number, Error>();

/** A cursor cannot cross an accepted request whose decoder has not committed yet. */
function committedCaptureState(tabId: number): DiagnosticsCaptureState {
  const state = getCaptureState(tabId);
  let sequence = state.currentSequence;
  for (const pending of pendingCaptureSequences.get(tabId) ?? []) sequence = Math.min(sequence, pending - 1);
  return { ...state, currentSequence: sequence };
}
export async function flushRequestCollection(tabId: number, options: { allowDecodeFailure?: boolean } = {}): Promise<void> {
  const state = captureStates.get(tabId);
  await networkQueues.get(tabId)?.catch(() => {});
  if (captureStates.get(tabId) !== state) throw new Error('Diagnostics capture changed while waiting for decoding');
  const error = collectionErrors.get(tabId);
  if (error && !options.allowDecodeFailure) throw error;
}
function enqueueNetworkEvent(tabId: number, state: DiagnosticsCaptureState, task: () => void | Promise<void>, release?: () => void) {
  const previous = networkQueues.get(tabId) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (collectingTabs.has(tabId) && captureStates.get(tabId) === state) await task();
  }).catch(error => {
    if (captureStates.get(tabId) === state) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure.name === 'TrackingRequestError') collectionErrors.delete(tabId);
      else collectionErrors.set(tabId, failure);
      addLogToBuffer(tabId, { level: 'error', message: `Tracking decoding failed: ${failure.message}`, timestampMs: Date.now(), source: 'tracking', origin: 'browser', args: [] });
    }
  }).finally(() => {
    release?.();
    if (networkQueues.get(tabId) === next) networkQueues.delete(tabId);
  });
  networkQueues.set(tabId, next);
}

function handleDebuggerEvent(source: CollectorTarget, method: string, params: any): void {
  const tabId = source.tabId;
  if (!tabId || !collectingTabs.has(tabId)) return;
  if (source.sessionId && !businessWebViewSessions.get(tabId)?.has(source.sessionId)) return;
  const state = getCaptureState(tabId);
  const requestKey = source.sessionId ? `${source.sessionId}:${params?.requestId}` : params?.requestId;
  if (method === 'Network.requestWillBeSent') {
    if (!params.request?.url?.startsWith('http')) return;
    const captureSequence = nextCaptureSequence(state);
    const sequence = (eventSequences.get(tabId) ?? 0) + 1;
    eventSequences.set(tabId, sequence);
    const sequences = pendingCaptureSequences.get(tabId)!;
    sequences.add(captureSequence);
    const decode = captureBrowserTrackingDecoder();
    const input = { url: params.request.url, body: params.request.postData, options: { sequence, now: Date.now() }, locale: getCurrentLanguage() };
    const decoded = Promise.all([decode(input), inspectBrowserRequest({ url: input.url, body: input.body })]);
    // The ordered commit attaches the rejection handler after preceding network events.
    void decoded.catch(() => {});
    enqueueNetworkEvent(tabId, state, async () => {
      try {
      let [result, metadata] = await decoded;
      if (!collectingTabs.has(tabId) || captureStates.get(tabId) !== state) return;
      if (result.tracking && !result.events.length && params.request.hasPostData && !params.request.postData) {
        const body = await chrome.debugger.sendCommand(source, 'Network.getRequestPostData', { requestId: params.requestId }).catch(() => undefined) as { postData?: string } | undefined;
        if (!collectingTabs.has(tabId) || captureStates.get(tabId) !== state) return;
        if (body?.postData) result = await decode({ ...input, body: body.postData });
      }
      if (!collectingTabs.has(tabId) || captureStates.get(tabId) !== state) return;
      collectionErrors.delete(tabId);
      if (!source.sessionId || businessWebViewSessions.get(tabId)?.has(source.sessionId)) {
        handleRequestWillBeSent(tabId, requestKey, params, result, captureSequence, metadata ?? undefined);
      }
      } catch (error) {
        if (captureStates.get(tabId) === state) {
          state.droppedEventsThroughSequence = Math.max(state.droppedEventsThroughSequence, captureSequence);
          if (!(error instanceof Error) || error.name !== 'TrackingRequestError') state.droppedRequestsThroughSequence = Math.max(state.droppedRequestsThroughSequence, captureSequence);
        }
        throw error;
      }
    }, () => sequences.delete(captureSequence));
    return;
  }
  switch (method) {
    case 'Network.responseReceived': enqueueNetworkEvent(tabId, state, () => handleResponseReceived(tabId, requestKey, params)); break;
    case 'Network.loadingFinished': enqueueNetworkEvent(tabId, state, () => { void handleLoadingFinished(tabId, source, requestKey, params); }); break;
    case 'Network.loadingFailed': enqueueNetworkEvent(tabId, state, () => handleLoadingFailed(tabId, requestKey, params)); break;
    case 'Runtime.consoleAPICalled': handleConsoleApiCalled(tabId, params); break;
    case 'Runtime.exceptionThrown': handleExceptionThrown(tabId, params); break;
    case 'Log.entryAdded': handleLogEntryAdded(tabId, params); break;
  }
}

let listenerRegistered = false;

function ensureEventListener(): void {
  if (listenerRegistered) return;
  chrome.debugger.onEvent.addListener(handleDebuggerEvent);
  listenerRegistered = true;
}

// ─── CDP event handlers ──────────────────────────────────────────────────────

function addLogToBuffer(tabId: number, log: Omit<ConsoleLog, 'captureSequence'>): void {
  const state = getCaptureState(tabId);
  const buffer = logBuffers.get(tabId) ?? [];
  if (!logBuffers.has(tabId)) logBuffers.set(tabId, buffer);
  buffer.push({ ...log, captureSequence: nextCaptureSequence(state) });
  if (buffer.length > LOG_BUFFER_MAX) {
    const removed = buffer.shift();
    if (removed) state.droppedLogsThroughSequence = removed.captureSequence;
  }
}

function handleConsoleApiCalled(tabId: number, params: any): void {
  const log = remoteObjectParamsToLog(
    params.type,
    params.args,
    params.timestamp ?? Date.now(),
    params.stackTrace,
  );
  addLogToBuffer(tabId, { ...log, origin: 'console' });
}

function handleExceptionThrown(tabId: number, params: any): void {
  const details = params.exceptionDetails ?? {};
  const exception = details.exception;
  const message =
    exception?.description ??
    (exception?.value !== undefined ? String(exception.value) : undefined) ??
    details.text ??
    'Uncaught exception';
  const topFrame = details.stackTrace?.callFrames?.[0];
  const url = topFrame?.url || details.url;
  const lineNumber = topFrame?.lineNumber ?? details.lineNumber;
  const source = url
    ? `${url.split('/').pop() || url}${lineNumber !== undefined ? `:${lineNumber + 1}` : ''}`
    : undefined;
  addLogToBuffer(tabId, {
    level: 'error',
    message,
    timestampMs: params.timestamp ?? Date.now(),
    ...(source ? { source } : {}),
    args: [message],
    origin: 'exception',
  });
}

function handleLogEntryAdded(tabId: number, params: any): void {
  const entry = params.entry ?? {};
  const levelMap: Record<string, string> = {
    verbose: 'log',
    info: 'info',
    warning: 'warn',
    error: 'error',
  };
  const args = (entry.args ?? []).map((arg: any) => {
    if (arg.value !== undefined) return String(arg.value);
    return arg.description ?? `[${arg.type || 'Object'}]`;
  });
  const message = entry.text || args.join(' ');
  const source = entry.url
    ? `${entry.url.split('/').pop() || entry.url}${entry.lineNumber !== undefined ? `:${entry.lineNumber + 1}` : ''}`
    : entry.source;
  addLogToBuffer(tabId, {
    level: levelMap[entry.level] ?? entry.level ?? 'log',
    message,
    timestampMs: entry.timestamp ?? Date.now(),
    ...(source ? { source } : {}),
    args: args.length > 0 ? args : [message],
    origin: 'browser',
  });
}

function handleRequestWillBeSent(tabId: number, requestKey: string, params: any, decoded: TrackingRequestResult, captureSequence: number, metadata?: RequestMetadata): void {
  const { request, type, timestamp: monotonicTime, wallTime } = params;
  if (decoded.tracking) {
    if (decoded.events.length) addEventsToBuffer(tabId, decoded.events.map(event => ({ ...event, captureSequence })));
    return;
  }

  const resourceType = type?.toLowerCase();
  const isProtocol = Boolean(metadata);

  if (request.method === 'OPTIONS') return;

  let pending = pendingRequests.get(tabId);
  if (!pending) {
    pending = new Map();
    pendingRequests.set(tabId, pending);
  }

  const redirected = pending.get(requestKey);
  if (redirected && params.redirectResponse) {
    redirected.request.status = params.redirectResponse.status ?? 0;
    redirected.request.statusText = params.redirectResponse.statusText ?? '';
    redirected.request.isPending = false;
    redirected.request.duration =
      monotonicTime !== undefined && redirected.startMonotonicTime !== undefined
        ? Math.round((monotonicTime - redirected.startMonotonicTime) * 1000)
        : undefined;
    refreshBufferedRequest(tabId, redirected.request);
    pending.delete(requestKey);
  }

  const headers: Array<{ name: string; value: string }> = [];
  if (request.headers) {
    for (const [name, value] of Object.entries(request.headers)) {
      headers.push({ name, value: String(value) });
    }
  }

  const extraction = metadata;
  const { queryString, postData, proxyData } = parseRequestInfo(
    request.url,
    request.postData,
    extraction,
  );
  const timestampMs = wallTime !== undefined ? Math.floor(wallTime * 1000) : Date.now();
  const date = new Date(timestampMs);
  const readableTimestamp = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  const capturedRequest: CapturedRequest = {
    id: timestampMs + captureSequence / 1000,
    timestamp: readableTimestamp,
    timestampMs,
    method: request.method || 'GET',
    url: request.url,
    environment: metadata?.environment,
    namespace: metadata?.namespace,
    apiName: extraction?.apiName ?? generateNonProtocolApiName(request.url, resourceType),
    status: 0,
    statusText: '',
    headers,
    responseHeaders: [],
    queryString,
    postData,
    responseBody: null,
    isProxy: extraction?.isProxy ?? false,
    proxyRequestUrl: extraction?.proxyRequestUrl ?? null,
    proxyData,
    isPending: true,
    requestHeadersSize: calculateHeadersSize(headers),
    requestBodySize:
      typeof request.postData === 'string'
        ? new TextEncoder().encode(request.postData).byteLength
        : undefined,
    tabId,
    source: isProtocol ? 'protocol' : 'requests',
    resourceType,
    captureSequence,
    captureTransport: 'debugger',
  };
  addToBuffer(tabId, capturedRequest);
  pending.set(requestKey, {
    request: capturedRequest,
    startMonotonicTime: monotonicTime,
  });
}

function handleResponseReceived(tabId: number, requestKey: string, params: any): void {
  const { response } = params;
  const pending = pendingRequests.get(tabId);
  const entry = pending?.get(requestKey);
  if (!entry || !response) return;

  entry.request.status = response.status ?? 0;
  entry.request.statusText = response.statusText || '';
  entry.request.responseHeaders = Object.entries(response.headers ?? {}).map(([name, value]) => ({
    name,
    value: String(value),
  }));
  entry.request.responseHeadersSize = calculateHeadersSize(entry.request.responseHeaders);
  if (entry.request.source === 'requests') {
    entry.request.resourceType = normalizeNonProtocolResourceType(
      entry.request.resourceType ?? 'other',
      entry.request.url,
      entry.request.responseHeaders,
    );
    entry.request.apiName = generateNonProtocolApiName(entry.request.url, entry.request.resourceType);
  }
  entry.request.isSSE = getHeaderValue(entry.request.responseHeaders, 'content-type').includes(
    'text/event-stream',
  );
  refreshBufferedRequest(tabId, entry.request);
}

async function handleLoadingFinished(tabId: number, target: CollectorTarget, requestKey: string, params: any): Promise<void> {
  const captureState = captureStates.get(tabId);
  const { requestId, timestamp: endTimestamp } = params;
  const pending = pendingRequests.get(tabId);
  const entry = pending?.get(requestKey);
  if (!entry) return;
  pending!.delete(requestKey);

  entry.request.isPending = false;
  entry.request.duration =
    endTimestamp !== undefined && entry.startMonotonicTime !== undefined
      ? Math.round((endTimestamp - entry.startMonotonicTime) * 1000)
      : undefined;
  if (typeof params.encodedDataLength === 'number' && params.encodedDataLength >= 0) {
    entry.request.responseBodySize = params.encodedDataLength;
  }
  refreshBufferedRequest(tabId, entry.request);

  const isBinaryResource =
    entry.request.resourceType === 'image' ||
    entry.request.resourceType === 'font' ||
    entry.request.resourceType === 'media';
  if (isBinaryResource) return;

  // 尝试获取 response body
  let responseBody: any = null;
  try {
    const bodyResult = (await chrome.debugger.sendCommand(target, 'Network.getResponseBody', {
      requestId,
    })) as { body: string; base64Encoded: boolean };

    const bodyText = bodyResult.base64Encoded
      ? decodeURIComponent(escape(atob(bodyResult.body)))
      : bodyResult.body;

    if (entry.request.isSSE) {
      responseBody = parseSseResponse(bodyText);
      entry.request.sseMessages = parseSseMessages(bodyText);
    } else {
      responseBody = parseJsonpResponse(bodyText);
    }
  } catch {
    // body 可能不可用（如 204、重定向等），忽略
  }

  if (!collectingTabs.has(tabId) || captureStates.get(tabId) !== captureState) return;
  entry.request.responseBody = responseBody;
  refreshBufferedRequest(tabId, entry.request);
}

function handleLoadingFailed(tabId: number, requestKey: string, params: any): void {
  const { timestamp: endTimestamp } = params;
  const pending = pendingRequests.get(tabId);
  const entry = pending?.get(requestKey);
  if (!entry) return;
  pending!.delete(requestKey);
  entry.request.isPending = false;
  entry.request.status = 0;
  entry.request.statusText = params.errorText ?? 'Failed';
  entry.request.duration =
    endTimestamp !== undefined && entry.startMonotonicTime !== undefined
      ? Math.round((endTimestamp - entry.startMonotonicTime) * 1000)
      : undefined;
  refreshBufferedRequest(tabId, entry.request);
}

// ─── Buffer management ──────────────────────────────────────────────────────

function addToBuffer(tabId: number, request: CapturedRequest): void {
  let buffer = requestBuffers.get(tabId);
  if (!buffer) {
    buffer = [];
    requestBuffers.set(tabId, buffer);
  }
  let accounting = requestBufferAccounting.get(tabId);
  if (!accounting) {
    accounting = createRequestBufferAccounting();
    requestBufferAccounting.set(tabId, accounting);
  }
  const removed = appendRequestToBuffer(buffer, accounting, request);
  recordDroppedRequests(tabId, removed);
  emitCollectorUpdate(tabId, {
    type: 'request',
    request,
    removedRequestIds: removed.map(item => item.id),
  });
}

function refreshBufferedRequest(tabId: number, request: CapturedRequest): void {
  const buffer = requestBuffers.get(tabId);
  const accounting = requestBufferAccounting.get(tabId);
  if (!buffer || !accounting) return;
  const removed = refreshRequestInBuffer(buffer, accounting, request);
  recordDroppedRequests(tabId, removed);
  emitCollectorUpdate(tabId, {
    type: 'request',
    request,
    removedRequestIds: removed.map(item => item.id),
  });
}

function publishBackgroundRequest(tabId: number, request: CapturedRequest): void {
  if (requestBuffers.get(tabId)?.some(item => item.id === request.id)) {
    refreshBufferedRequest(tabId, request);
    return;
  }
  if (collectingTabs.has(tabId) && captureStates.has(tabId)) {
    addToBuffer(tabId, request);
    return;
  }
  emitCollectorUpdate(tabId, { type: 'request', request, removedRequestIds: [] });
}

function recordDroppedRequests(tabId: number, removed: CapturedRequest[]): void {
  const state = captureStates.get(tabId);
  if (!state) return;
  for (const request of removed) {
    if (request.captureSequence !== undefined) {
      state.droppedRequestsThroughSequence = Math.max(
        state.droppedRequestsThroughSequence,
        request.captureSequence,
      );
    }
  }
}

function isBusinessRequest(request: CapturedRequest): boolean {
  return request.source === 'protocol' || BUSINESS_RESOURCE_TYPES.has(request.resourceType ?? '');
}

function addEventsToBuffer(tabId: number, events: RumEvent[]): void {
  let buffer = eventBuffers.get(tabId);
  if (!buffer) {
    buffer = [];
    eventBuffers.set(tabId, buffer);
  }
  const removed = appendCapturedTrackingBatch(buffer, events, EVENT_BUFFER_MAX);
  const state = getCaptureState(tabId);
  for (const event of removed) {
    if (event.captureSequence !== undefined) {
      state.droppedEventsThroughSequence = Math.max(
        state.droppedEventsThroughSequence,
        event.captureSequence,
      );
    }
  }
  emitCollectorUpdate(tabId, {
    type: 'events',
    events,
    removedEventIds: removed.map(event => event.id),
  });
}

export interface BackgroundProtocolStreamStart extends Omit<
  ProtocolStreamCaptureStart,
  'id' | 'tabId' | 'captureSequence' | 'url' | 'source'
> {
  streamId: string;
  url?: string;
}

export type BackgroundProtocolStreamResponse = ProtocolStreamCaptureResponse;

export interface BackgroundCapturedRequest {
  api: string;
  namespace?: string;
  environment?: string;
  requestData?: unknown;
  response?: unknown;
  success: boolean;
  duration: number;
  timestampMs: number;
  error?: string;
}

/** 把扩展后台代发的普通 Protocol 请求接入共用请求缓冲区。 */
export function recordBackgroundCapturedRequest(tabId: number, data: BackgroundCapturedRequest): boolean {
  const captureState = captureStates.get(tabId);
  const captureSequence =
    collectingTabs.has(tabId) && captureState ? nextCaptureSequence(captureState) : undefined;
  const request: CapturedRequest = {
    id: data.timestampMs + (captureSequence !== undefined ? captureSequence / 1000 : Math.random()),
    timestamp: new Date(data.timestampMs).toISOString(),
    timestampMs: data.timestampMs,
    method: 'POST',
    url: `protocol://${data.api}/`,
    apiName: data.api,
    ...(data.namespace !== undefined ? { namespace: data.namespace } : {}),
    ...(data.environment !== undefined ? { environment: data.environment } : {}),
    status: data.success ? 200 : 500,
    statusText: data.success ? 'OK' : data.error || 'Error',
    headers: [],
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    queryString: [],
    postData: data.requestData ?? null,
    responseBody: data.response ?? (data.error ? { error: data.error } : null),
    isProxy: true,
    proxyRequestUrl: null,
    proxyData: null,
    duration: data.duration,
    isPending: false,
    tabId,
    source: 'protocol',
    captureTransport: 'background',
    ...(captureSequence !== undefined ? { captureSequence } : {}),
  };
  publishBackgroundRequest(tabId, request);
  return true;
}

/** 把扩展后台代发的 Protocol SSE 请求接入 Agent 共用的请求缓冲区。 */
export function recordBackgroundProtocolStreamStart(
  tabId: number,
  data: BackgroundProtocolStreamStart,
): boolean {
  const captureState = captureStates.get(tabId);

  let streams = backgroundProtocolStreams.get(tabId);
  if (!streams) {
    streams = new Map();
    backgroundProtocolStreams.set(tabId, streams);
  }
  const { streamId, ...start } = data;
  if (streams.has(streamId)) return true;

  const captureSequence =
    collectingTabs.has(tabId) && captureState ? nextCaptureSequence(captureState) : undefined;
  const capture = createProtocolStreamCapture({
    ...start,
    url: start.url ?? `protocol://${start.api}/`,
    source: 'protocol',
    id:
      (data.timestampMs ?? Date.now()) +
      (captureSequence !== undefined ? captureSequence / 1000 : Math.random()),
    tabId,
    captureSequence: captureSequence ?? 0,
  });
  const request: CapturedRequest = { ...capture.request, captureTransport: 'background' };
  if (captureSequence === undefined) delete request.captureSequence;
  capture.request = request;
  publishBackgroundRequest(tabId, request);
  streams.set(streamId, capture);
  return true;
}

export function recordBackgroundProtocolStreamResponse(
  tabId: number,
  streamId: string,
  response: BackgroundProtocolStreamResponse,
): boolean {
  const entry = backgroundProtocolStreams.get(tabId)?.get(streamId);
  if (!entry) return false;
  updateProtocolStreamCaptureResponse(entry, response);
  publishBackgroundRequest(tabId, entry.request);
  return true;
}

export function recordBackgroundProtocolStreamChunk(
  tabId: number,
  streamId: string,
  data: unknown,
  timestampMs = Date.now(),
): boolean {
  const entry = backgroundProtocolStreams.get(tabId)?.get(streamId);
  if (!entry) return false;

  if (appendProtocolStreamCaptureChunk(entry, data, timestampMs)) {
    publishBackgroundRequest(tabId, entry.request);
  }
  return true;
}

export function recordBackgroundProtocolStreamEnd(
  tabId: number,
  streamId: string,
  options: { timestampMs?: number; error?: string } = {},
): boolean {
  const streams = backgroundProtocolStreams.get(tabId);
  const entry = streams?.get(streamId);
  if (!entry) return false;

  finishProtocolStreamCapture(entry, options);
  publishBackgroundRequest(tabId, entry.request);
  streams!.delete(streamId);
  if (streams!.size === 0) backgroundProtocolStreams.delete(tabId);
  return true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** 对指定 tab 启动请求采集并持有 Network domain lease。 */
export async function startRequestCollection(
  tabId: number,
  consumer: RequestCollectionConsumer = 'agent',
): Promise<void> {
  const consumers = collectionConsumers.get(tabId) ?? new Set<RequestCollectionConsumer>();
  consumers.add(consumer);
  collectionConsumers.set(tabId, consumers);

  const existingStart = collectionStartPromises.get(tabId);
  if (existingStart) return existingStart;
  if (collectingTabs.has(tabId)) return;

  const startPromise = (async () => {
    ensureEventListener();
    captureStates.set(tabId, {
      tabId,
      generation: createCaptureGeneration(),
      currentSequence: 0,
      droppedRequestsThroughSequence: 0,
      droppedLogsThroughSequence: 0,
      droppedEventsThroughSequence: 0,
    });
    requestBuffers.set(tabId, []);
    requestBufferAccounting.set(tabId, createRequestBufferAccounting());
    logBuffers.set(tabId, []);
    eventBuffers.set(tabId, []);
    eventSequences.set(tabId, 0);
    pendingCaptureSequences.set(tabId, new Set());
    collectionErrors.delete(tabId);
    networkQueues.delete(tabId);
    pendingRequests.set(tabId, new Map());
    backgroundProtocolStreams.set(tabId, new Map());
    // Mark the collector before enabling domains because Log.enable may replay
    // entries synchronously through entryAdded.
    collectingTabs.add(tabId);
    try {
      const lease = await acquireDebuggerLease(tabId, {
        consumer: 'diagnostics-collector',
        domains: ['Network', 'Runtime', 'Log'],
        domainParams: {
          Network: networkBufferOptions,
        },
        onInvalidated: () => invalidateCollection(tabId),
      });
      collectorLeases.set(tabId, lease);
      await Promise.all([...(businessWebViewSessions.get(tabId) ?? [])].map(sessionId =>
        setWebViewNetwork(tabId, sessionId, true),
      ));
    } catch (error) {
      collectionConsumers.delete(tabId);
      collectingTabs.delete(tabId);
  networkQueues.delete(tabId);
  pendingCaptureSequences.delete(tabId);
  collectionErrors.delete(tabId);      captureStates.delete(tabId);
      requestBuffers.delete(tabId);
      requestBufferAccounting.delete(tabId);
      logBuffers.delete(tabId);
      eventBuffers.delete(tabId);
      eventSequences.delete(tabId);
      pendingRequests.delete(tabId);
      backgroundProtocolStreams.delete(tabId);
      throw error;
    }
  })();
  collectionStartPromises.set(tabId, startPromise);
  try {
    await startPromise;
  } finally {
    collectionStartPromises.delete(tabId);
  }
}

/**
 * 停止指定 tab 的请求采集
 */
export async function stopRequestCollection(
  tabId: number,
  consumer: RequestCollectionConsumer = 'agent',
): Promise<void> {
  const starting = collectionStartPromises.get(tabId);
  if (starting) await starting.catch(() => {});

  const consumers = collectionConsumers.get(tabId);
  consumers?.delete(consumer);
  if (consumers?.size) return;
  collectionConsumers.delete(tabId);

  collectingTabs.delete(tabId);
  networkQueues.delete(tabId);
  pendingCaptureSequences.delete(tabId);
  collectionErrors.delete(tabId);  pendingRequests.delete(tabId);
  backgroundProtocolStreams.delete(tabId);
  const lease = collectorLeases.get(tabId);
  collectorLeases.delete(tabId);
  await Promise.all([...(businessWebViewSessions.get(tabId) ?? [])].map(sessionId =>
    setWebViewNetwork(tabId, sessionId, false),
  ));
  await lease?.release();
}

/** 订阅后台采集结果，用于将同一份数据实时投影到 Panel。 */
export function setCollectorUpdateListener(
  listener: ((tabId: number, update: CollectorUpdate) => void) | null,
): void {
  collectorUpdateListener = listener;
}

/** 获取 Panel 首次连接时的完整采集快照。 */
export function getCollectorSnapshot(tabId: number): {
  requests: CapturedRequest[];
  events: RumEvent[];
} {
  const sequence = captureStates.has(tabId) ? committedCaptureState(tabId).currentSequence : Infinity;
  return {
    requests: (requestBuffers.get(tabId) ?? []).filter(value => value.captureSequence === undefined || value.captureSequence <= sequence),
    events: (eventBuffers.get(tabId) ?? []).filter(value => value.captureSequence === undefined || value.captureSequence <= sequence),
  };
}

/**
 * 获取指定 tab 的已采集请求
 */
export function getCollectedRequests(
  tabId: number,
  options: {
    count?: number;
    source?: 'protocol' | 'requests' | 'all';
    filter?: string;
    since?: number;
    after?: string;
  } = {},
): {
  requests: CapturedRequest[];
  totalMatched: number;
  totalInBuffer: number;
  nextCursor: string;
  hasMore: boolean;
  gap: boolean;
} {
  const buffer = requestBuffers.get(tabId) || [];
  const { count = 10, source, filter, since, after } = options;
  const pattern = filter ? compileTextPattern(filter) : undefined;
  const state = committedCaptureState(tabId);
  const captured = queryCapturedEntries(
    buffer.filter((request): request is CapturedRequest & { captureSequence: number } =>
      Number.isSafeInteger(request.captureSequence) && request.captureSequence! <= state.currentSequence,
    ).sort((left, right) => left.captureSequence - right.captureSequence),
    state,
    { after, since, limit: count },
    request =>
      isBusinessRequest(request) &&
      (!source || source === 'all' || request.source === source) &&
      (!pattern ||
        matchesTextPattern(request.apiName, pattern) ||
        matchesTextPattern(request.url, pattern)),
    state.droppedRequestsThroughSequence,
    'requests',
  );

  return {
    requests: captured.entries,
    totalMatched: captured.totalMatched,
    totalInBuffer: buffer.filter(value => value.captureSequence! <= state.currentSequence && isBusinessRequest(value)).length,
    nextCursor: captured.nextCursor,
    hasMore: captured.hasMore,
    gap: captured.gap,
  };
}

export function getCollectedLogs(
  tabId: number,
  options: {
    level?: 'log' | 'warn' | 'error' | 'info' | 'all';
    filter?: string;
    since?: number;
    after?: string;
    limit?: number;
  } = {},
): CaptureQueryResult<ConsoleLog> & { totalInBuffer: number } {
  const buffer = logBuffers.get(tabId) ?? [];
  const state = committedCaptureState(tabId);
  const pattern = options.filter ? compileTextPattern(options.filter) : undefined;
  const result = queryCapturedEntries(
    buffer.filter(value => value.captureSequence <= state.currentSequence).sort((left, right) => left.captureSequence - right.captureSequence),
    state,
    { after: options.after, since: options.since, limit: options.limit ?? 100 },
    log =>
      (!options.level || options.level === 'all' || log.level === options.level) &&
      (!pattern ||
        matchesTextPattern(log.message, pattern) ||
        log.args.some(arg => matchesTextPattern(arg, pattern))),
    state.droppedLogsThroughSequence,
    'logs',
  );
  return { ...result, totalInBuffer: buffer.filter(value => value.captureSequence <= state.currentSequence).length };
}

export function getCaptureCheckpoint(tabId: number): {
  tabId: number;
  cursor: string;
  timestampMs: number;
  captureStatus: 'armed' | 'active';
} {
  const state = committedCaptureState(tabId);
  return {
    tabId,
    cursor: captureCheckpoint(state),
    timestampMs: Date.now(),
    captureStatus: state.currentSequence === 0 ? 'armed' : 'active',
  };
}

/** 获取指定 tab 已采集并解析的埋点事件。 */
export function getCollectedEvents(
  tabId: number,
  options: TrackingEventQueryOptions = {},
): CapturedTrackingEventQueryResult {
  const buffer = eventBuffers.get(tabId) || [];
  const state = committedCaptureState(tabId);
  return queryCapturedTrackingEvents(buffer.filter(value => value.captureSequence! <= state.currentSequence), state, options, state.droppedEventsThroughSequence);
}

/**
 * 检查指定 tab 是否正在采集
 */
export function isCollecting(tabId: number): boolean {
  return collectingTabs.has(tabId);
}

/** 返回所有持有后台请求采集 lease 的标签页。 */
export function listCollectingTabIds(): number[] {
  return Array.from(
    new Set([...collectingTabs, ...collectorLeases.keys(), ...collectionStartPromises.keys()]),
  );
}

/**
 * 清理指定 tab 的所有采集数据
 */
export function cleanupCollector(tabId: number): void {
  businessWebViewSessions.delete(tabId);
  collectingTabs.delete(tabId);
  networkQueues.delete(tabId);
  pendingCaptureSequences.delete(tabId);
  collectionErrors.delete(tabId);  requestBuffers.delete(tabId);
  requestBufferAccounting.delete(tabId);
  logBuffers.delete(tabId);
  captureStates.delete(tabId);
  eventBuffers.delete(tabId);
  eventSequences.delete(tabId);
  pendingRequests.delete(tabId);
  backgroundProtocolStreams.delete(tabId);
  collectorLeases.delete(tabId);
  collectionStartPromises.delete(tabId);
  collectionConsumers.delete(tabId);
}
