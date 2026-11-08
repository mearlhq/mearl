import { createRequestStreamCapture, updateRequestStreamCaptureResponse, appendRequestStreamCaptureChunk, finishRequestStreamCapture } from '@mearl/browser-core';
import { nativeCapabilities } from '../native-capability-services.js';
import { parseRequestMetadata } from '@mearl/browser-core';
import { getTrackingCapability, type ProtocolStreamCapture, type ProtocolStreamCaptureResponse, type ProtocolStreamCaptureStart } from '../capability-contracts.js';
/**
 * In-memory circular buffers for CDP network requests, console logs, and
 * RUM/tracking events. A single CdpSession subscribes to CDP events and
 * fills these buffers; callers read from them without CDP interaction.
 */

import { TextDecoder } from 'node:util';

import type {
  CapturedRequest,
  RumEvent,
  ConsoleLog,
  RequestBufferAccounting,
} from '@mearl/browser-core';
import {
  appendCapturedTrackingBatch,
  appendRequestToBuffer,
  createSseEventParser,
  createCaptureGeneration,
  createRequestBufferAccounting,
  nextCaptureSequence,
  parseSseDataValue,
  refreshRequestInBuffer,
  type CaptureSequenceState,
  type ParsedSseEvent,
  type SseEventParser,
} from '@mearl/browser-core';
import type { CdpClient, CdpChildSession } from './client.js';
import { ensureCdpDomain } from './domain-manager.js';

const MAX_LOGS = 500;
const MAX_EVENTS = 500;
const COLLECTED_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document', 'eventsource']);

// ─── Pending request assembly ─────────────────────────────────────────────────

interface PartialRequest extends CapturedRequest {
  id: number;
  requestId: string;
  timestamp: string;
  timestampMs: number;
  method: string;
  url: string;
  apiName: string;
  headers: Array<{ name: string; value: string }>;
  postData: any;
  queryString: Array<{ name: string; value: string }>;
  status: number;
  statusText: string;
  responseHeaders: Array<{ name: string; value: string }>;
  responseBody: any;
  isProxy: boolean;
  proxyRequestUrl: string | null;
  proxyData: any;
  startTs?: number; // high-res monotonic timestamp for duration calc
}

interface CdpSseStream {
  parser: SseEventParser;
  decoder: TextDecoder;
  mode: 'eventsource' | 'resource' | 'fallback';
  lastMessageTimeMs?: number;
}

export type CdpProtocolStreamCapture = ProtocolStreamCapture;
export type CdpProtocolStreamStart = Omit<ProtocolStreamCaptureStart, 'id' | 'tabId' | 'captureSequence'>;
export type CdpProtocolStreamResponse = ProtocolStreamCaptureResponse;

// ─── Exports ──────────────────────────────────────────────────────────────────

export interface CdpBuffers {
  requests: CapturedRequest[];
  logs: ConsoleLog[];
  events: RumEvent[];
  pending: Map<string, PartialRequest>;
  sseStreams: Map<string, CdpSseStream>;
  requestCounter: number;
  requestBufferAccounting: RequestBufferAccounting;
  capture: CaptureSequenceState & {
    droppedRequestsThroughSequence: number;
    droppedLogsThroughSequence: number;
    droppedEventsThroughSequence: number;
  };
}

export function createBuffers(tabId = 0): CdpBuffers {
  return {
    requests: [],
    logs: [],
    events: [],
    pending: new Map(),
    sseStreams: new Map(),
    requestCounter: 0,
    requestBufferAccounting: createRequestBufferAccounting(),
    capture: {
      tabId,
      generation: createCaptureGeneration(),
      currentSequence: 0,
      droppedRequestsThroughSequence: 0,
      droppedLogsThroughSequence: 0,
      droppedEventsThroughSequence: 0,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    const result: Array<{ name: string; value: string }> = [];
    u.searchParams.forEach((value, name) => result.push({ name, value }));
    return result;
  } catch {
    return [];
  }
}

function headersObjToArray(obj: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
}

function getHeaderValue(headers: Record<string, unknown>, targetName: string): string {
  const target = targetName.toLowerCase();
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === target);
  return entry ? String(entry[1]) : '';
}

function requestDisplayName(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function parsePostData(postData: string | undefined): any {
  if (!postData) return null;
  try {
    return JSON.parse(postData);
  } catch {
    // Try form-encoded
    try {
      const params: Record<string, string> = {};
      new URLSearchParams(postData).forEach((v, k) => (params[k] = v));
      return params;
    } catch {
      return postData;
    }
  }
}

function appendTrackingEvents(
  buffers: CdpBuffers,
  url: string,
  postData: string | undefined,
  batchSequence: number,
  captureSequence: number,
): boolean {
  const events = (getTrackingCapability()?.parse(url, postData, {
    sequence: batchSequence,
    now: Date.now(),
  }) ?? []).map(event => ({ ...event, captureSequence }));
  if (events.length === 0) return false;

  const removed = appendCapturedTrackingBatch(buffers.events, events, MAX_EVENTS);
  for (const event of removed) {
    if (event.captureSequence !== undefined) {
      buffers.capture.droppedEventsThroughSequence = Math.max(
        buffers.capture.droppedEventsThroughSequence,
        event.captureSequence,
      );
    }
  }
  return true;
}

function recordDroppedRequests(buffers: CdpBuffers, removed: CapturedRequest[]): void {
  for (const request of removed) {
    if (request.captureSequence !== undefined) {
      buffers.capture.droppedRequestsThroughSequence = Math.max(
        buffers.capture.droppedRequestsThroughSequence,
        request.captureSequence,
      );
    }
  }
}

function appendCapturedRequest(buffers: CdpBuffers, request: CapturedRequest): void {
  recordDroppedRequests(
    buffers,
    appendRequestToBuffer(buffers.requests, buffers.requestBufferAccounting, request),
  );
}

function refreshCapturedRequest(buffers: CdpBuffers, request: CapturedRequest): void {
  recordDroppedRequests(
    buffers,
    refreshRequestInBuffer(buffers.requests, buffers.requestBufferAccounting, request),
  );
}

export function recordCdpProtocolStreamStart(
  buffers: CdpBuffers,
  data: CdpProtocolStreamStart,
): CdpProtocolStreamCapture {
  const capture = createRequestStreamCapture({
    ...data, url: data.url ?? `protocol://${data.api}/`, source: 'protocol',
    id: ++buffers.requestCounter,
    tabId: buffers.capture.tabId,
    captureSequence: nextCaptureSequence(buffers.capture),
  });
  appendCapturedRequest(buffers, capture.request);
  return capture;
}

export function recordCdpProtocolStreamResponse(
  buffers: CdpBuffers,
  capture: CdpProtocolStreamCapture,
  response: CdpProtocolStreamResponse,
): void {
  updateRequestStreamCaptureResponse(capture, response);
  refreshCapturedRequest(buffers, capture.request);
}

export function recordCdpProtocolStreamChunk(
  buffers: CdpBuffers,
  capture: CdpProtocolStreamCapture,
  data: unknown,
  timestampMs = Date.now(),
): void {
  if (appendRequestStreamCaptureChunk(capture, data, timestampMs)) {
    refreshCapturedRequest(buffers, capture.request);
  }
}

export function recordCdpProtocolStreamEnd(
  buffers: CdpBuffers,
  capture: CdpProtocolStreamCapture,
  options: { timestampMs?: number; error?: string } = {},
): void {
  finishRequestStreamCapture(capture, options);
  refreshCapturedRequest(buffers, capture.request);
}

function requestEventTimestamp(partial: PartialRequest, monotonicTimestamp?: number): number {
  if (monotonicTimestamp !== undefined && partial.startTs !== undefined) {
    return Math.round(partial.timestampMs + (monotonicTimestamp - partial.startTs) * 1000);
  }
  return Date.now();
}

function ensurePageSseStream(
  buffers: CdpBuffers,
  partial: PartialRequest,
  mode: CdpSseStream['mode'],
): CdpSseStream {
  partial.isSSE = true;
  if (!Array.isArray(partial.responseBody)) partial.responseBody = [];
  const existing = buffers.sseStreams.get(partial.requestId);
  if (existing) return existing;
  const stream: CdpSseStream = {
    parser: createSseEventParser(),
    decoder: new TextDecoder(),
    mode,
  };
  buffers.sseStreams.set(partial.requestId, stream);
  return stream;
}

function appendPageSseEvents(
  buffers: CdpBuffers,
  partial: PartialRequest,
  stream: CdpSseStream,
  events: ParsedSseEvent[],
  timestampMs: number,
): void {
  if (!Array.isArray(partial.responseBody)) return;
  for (const event of events) {
    partial.responseBody.push({
      event: event.event,
      data: event.data,
      ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
      timestamp: timestampMs,
      duration: stream.lastMessageTimeMs === undefined ? 0 : timestampMs - stream.lastMessageTimeMs,
    });
    stream.lastMessageTimeMs = timestampMs;
  }
  if (events.length > 0) refreshCapturedRequest(buffers, partial);
}

function consumePageSseBytes(
  buffers: CdpBuffers,
  partial: PartialRequest,
  stream: CdpSseStream,
  bytes: Buffer,
  timestampMs: number,
): void {
  const text = stream.decoder.decode(bytes, { stream: true });
  appendPageSseEvents(buffers, partial, stream, stream.parser.push(text), timestampMs);
}

function finishPageSseStream(
  buffers: CdpBuffers,
  partial: PartialRequest,
  stream: CdpSseStream,
  timestampMs: number,
): void {
  const tail = stream.decoder.decode();
  const events = [...stream.parser.push(tail), ...stream.parser.finish()];
  appendPageSseEvents(buffers, partial, stream, events, timestampMs);
}

function replaceWithParsedSseBody(
  partial: PartialRequest,
  body: string,
  timestampMs: number,
): void {
  const parser = createSseEventParser();
  partial.responseBody = [...parser.push(body), ...parser.finish()].map(event => ({
    event: event.event,
    data: event.data,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    timestamp: timestampMs,
    duration: 0,
  }));
}

function appendCapturedLog(buffers: CdpBuffers, log: Omit<ConsoleLog, 'captureSequence'>): void {
  buffers.logs.push({ ...log, captureSequence: nextCaptureSequence(buffers.capture) });
  if (buffers.logs.length > MAX_LOGS) {
    const removed = buffers.logs.shift();
    if (removed) buffers.capture.droppedLogsThroughSequence = removed.captureSequence;
  }
}

// ─── Event listener setup ─────────────────────────────────────────────────────

export async function setupBufferListeners(
  client: CdpClient | CdpChildSession,
  buffers: CdpBuffers,
): Promise<void> {
  // ── Network.requestWillBeSent ──────────────────────────────────────────────
  client.on('Network.requestWillBeSent', (params: any) => {
    const url: string = params.request?.url ?? '';
    if (!url.startsWith('http')) return;
    if (getTrackingCapability()?.matches(url)) {
      const batchSequence = ++buffers.requestCounter;
      const captureSequence = nextCaptureSequence(buffers.capture);
      const captured = appendTrackingEvents(
        buffers,
        url,
        params.request?.postData,
        batchSequence,
        captureSequence,
      );
      if (!captured && params.request?.hasPostData && !params.request?.postData) {
        client
          .sendCommand('Network.getRequestPostData', { requestId: params.requestId }, 10000)
          .then((result: any) =>
            appendTrackingEvents(buffers, url, result?.postData, batchSequence, captureSequence),
          )
          .catch(() => {});
      }
      return;
    }
    const resourceType = String(params.type ?? '').toLowerCase();
    const metadata = parseRequestMetadata(nativeCapabilities.get('request.inspect')?.({ url, body: params.request?.postData }));
    const protocolApiName = metadata?.apiName ?? null;
    const isProtocol = protocolApiName !== null;
    if (!isProtocol && !COLLECTED_RESOURCE_TYPES.has(resourceType)) return;
    const ts: number | undefined = params.timestamp;
    const timestampMs: number =
      params.wallTime !== undefined ? Math.floor(params.wallTime * 1000) : Date.now();
    const redirected = buffers.pending.get(params.requestId);
    if (redirected && params.redirectResponse) {
      redirected.status = params.redirectResponse.status ?? 0;
      redirected.statusText = params.redirectResponse.statusText ?? '';
      redirected.duration =
        ts !== undefined && redirected.startTs !== undefined
          ? Math.round((ts - redirected.startTs) * 1000)
          : undefined;
      redirected.isPending = false;
      refreshCapturedRequest(buffers, redirected);
      buffers.pending.delete(params.requestId);
      buffers.sseStreams.delete(params.requestId);
    }
    const id = ++buffers.requestCounter;
    const captureSequence = nextCaptureSequence(buffers.capture);

    const partial: PartialRequest = {
      id,
      requestId: params.requestId,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      method: params.request?.method ?? 'GET',
      url,
      apiName: protocolApiName ?? requestDisplayName(url),
      headers: headersObjToArray(params.request?.headers ?? {}),
      postData: parsePostData(params.request?.postData),
      queryString: parseQueryString(url),
      status: 0,
      statusText: '',
      responseHeaders: [],
      responseBody: resourceType === 'eventsource' ? [] : null,
      environment: metadata?.environment,
    namespace: metadata?.namespace,
      isProxy: metadata?.isProxy ?? false,
      proxyRequestUrl: metadata?.proxyRequestUrl ?? null,
      proxyData: null,
      startTs: ts,
      captureSequence,
      isPending: true,
      isSSE: resourceType === 'eventsource',
      source: isProtocol ? 'protocol' : 'requests',
      resourceType,
    };

    buffers.pending.set(params.requestId, partial);
    appendCapturedRequest(buffers, partial);
  });

  // ── Network.responseReceived ───────────────────────────────────────────────
  client.on('Network.responseReceived', (params: any) => {
    const partial = buffers.pending.get(params.requestId);
    if (!partial) return;

    partial.status = params.response?.status ?? 0;
    partial.statusText = params.response?.statusText ?? '';
    partial.responseHeaders = headersObjToArray(params.response?.headers ?? {});
    const contentType = getHeaderValue(params.response?.headers ?? {}, 'content-type');
    const isSSE =
      partial.resourceType === 'eventsource' ||
      contentType.toLowerCase().includes('text/event-stream');
    if (isSSE) {
      const mode = partial.resourceType === 'eventsource' ? 'eventsource' : 'resource';
      const stream = ensurePageSseStream(buffers, partial, mode);
      if (mode === 'resource') {
        client
          .sendCommand('Network.streamResourceContent', { requestId: params.requestId }, 10000)
          .then((result: any) => {
            if (buffers.sseStreams.get(params.requestId) !== stream) return;
            if (typeof result?.bufferedData === 'string' && result.bufferedData) {
              consumePageSseBytes(
                buffers,
                partial,
                stream,
                Buffer.from(result.bufferedData, 'base64'),
                requestEventTimestamp(partial, params.timestamp),
              );
            }
          })
          .catch(() => {
            if (buffers.sseStreams.get(params.requestId) === stream) stream.mode = 'fallback';
          });
      }
    }
    refreshCapturedRequest(buffers, partial);
  });

  client.on('Network.dataReceived', (params: any) => {
    const partial = buffers.pending.get(params.requestId);
    const stream = buffers.sseStreams.get(params.requestId);
    if (!partial || stream?.mode !== 'resource' || typeof params.data !== 'string') return;
    consumePageSseBytes(
      buffers,
      partial,
      stream,
      Buffer.from(params.data, 'base64'),
      requestEventTimestamp(partial, params.timestamp),
    );
  });

  client.on('Network.eventSourceMessageReceived', (params: any) => {
    const partial = buffers.pending.get(params.requestId);
    if (!partial) return;
    const stream = ensurePageSseStream(buffers, partial, 'eventsource');
    appendPageSseEvents(
      buffers,
      partial,
      stream,
      [
        {
          event:
            typeof params.eventName === 'string' && params.eventName ? params.eventName : 'message',
          data: parseSseDataValue(String(params.data ?? '')),
          ...(typeof params.eventId === 'string' && params.eventId
            ? { eventId: params.eventId }
            : {}),
        },
      ],
      requestEventTimestamp(partial, params.timestamp),
    );
  });

  // ── Network.loadingFinished ────────────────────────────────────────────────
  client.on('Network.loadingFinished', (params: any) => {
    const partial = buffers.pending.get(params.requestId);
    if (!partial) return;

    buffers.pending.delete(params.requestId);

    const endTs: number | undefined = params.timestamp;
    const duration =
      endTs !== undefined && partial.startTs !== undefined
        ? Math.round((endTs - partial.startTs) * 1000)
        : undefined;

    const stream = buffers.sseStreams.get(params.requestId);
    if (stream?.mode === 'resource') {
      finishPageSseStream(
        buffers,
        partial,
        stream,
        requestEventTimestamp(partial, params.timestamp),
      );
    }
    buffers.sseStreams.delete(params.requestId);

    partial.duration = duration;
    partial.isPending = false;
    refreshCapturedRequest(buffers, partial);

    if (partial.isSSE && Array.isArray(partial.responseBody) && partial.responseBody.length > 0) {
      return;
    }

    // Fetch response body asynchronously and update
    client
      .sendCommand('Network.getResponseBody', { requestId: params.requestId }, 10000)
      .then((result: any) => {
        const responseBody = result.base64Encoded
          ? Buffer.from(result.body, 'base64').toString('utf-8')
          : result.body;
        if (partial.isSSE && typeof responseBody === 'string') {
          replaceWithParsedSseBody(
            partial,
            responseBody,
            requestEventTimestamp(partial, params.timestamp),
          );
          refreshCapturedRequest(buffers, partial);
          return;
        }
        partial.responseBody = responseBody;
        // Try to parse JSON response body
        if (typeof partial.responseBody === 'string') {
          try {
            partial.responseBody = JSON.parse(partial.responseBody);
          } catch {
            // keep as string
          }
        }
        refreshCapturedRequest(buffers, partial);
      })
      .catch(() => {
        // Response body not available (e.g., streaming)
      });
  });

  // ── Network.loadingFailed ──────────────────────────────────────────────────
  client.on('Network.loadingFailed', (params: any) => {
    const partial = buffers.pending.get(params.requestId);
    if (!partial) return;

    buffers.pending.delete(params.requestId);
    buffers.sseStreams.delete(params.requestId);

    partial.status = 0;
    partial.statusText = params.errorText ?? 'Failed';
    partial.duration =
      params.timestamp !== undefined && partial.startTs !== undefined
        ? Math.round((params.timestamp - partial.startTs) * 1000)
        : undefined;
    partial.isPending = false;
    if (partial.isSSE && Array.isArray(partial.responseBody) && partial.responseBody.length === 0) {
      partial.responseBody = { error: partial.statusText };
    }
    refreshCapturedRequest(buffers, partial);
  });

  // ── Runtime.consoleAPICalled ───────────────────────────────────────────────
  client.on('Runtime.consoleAPICalled', (params: any) => {
    const levelMap: Record<string, string> = {
      warning: 'warn',
      debug: 'debug',
      info: 'info',
      error: 'error',
      assert: 'error',
    };
    const level = levelMap[params.type] ?? 'log';
    const args: string[] = (params.args ?? []).map((arg: any) => {
      if (arg.type === 'string') return arg.value;
      if (arg.value !== undefined) return String(arg.value);
      if (arg.description !== undefined) return arg.description;
      return JSON.stringify(arg);
    });

    appendCapturedLog(buffers, {
      level,
      message: args.join(' '),
      timestampMs: params.timestamp ?? Date.now(),
      source: params.stackTrace?.callFrames?.[0]?.url
        ? `${params.stackTrace.callFrames[0].url.split('/').pop() || params.stackTrace.callFrames[0].url}:${params.stackTrace.callFrames[0].lineNumber + 1}`
        : 'console',
      args,
      origin: 'console',
    });
  });

  client.on('Runtime.exceptionThrown', (params: any) => {
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
    appendCapturedLog(buffers, {
      level: 'error',
      message,
      timestampMs: params.timestamp ?? Date.now(),
      ...(source ? { source } : {}),
      args: [message],
      origin: 'exception',
    });
  });

  // ── Log.entryAdded ─────────────────────────────────────────────────────────
  client.on('Log.entryAdded', (params: any) => {
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
    appendCapturedLog(buffers, {
      level: levelMap[entry.level] ?? entry.level ?? 'log',
      message,
      timestampMs: entry.timestamp ?? Date.now(),
      source: entry.url
        ? `${entry.url.split('/').pop() || entry.url}${entry.lineNumber !== undefined ? `:${entry.lineNumber + 1}` : ''}`
        : (entry.source ?? 'other'),
      args: args.length > 0 ? args : [message],
      origin: 'browser',
    });
  });

  // Listeners are installed before domains are enabled because Log.enable can
  // replay entries collected before this session attached.
  await Promise.all([
    ensureCdpDomain(client, 'Network', {
      maxTotalBufferSize: 10 * 1024 * 1024,
      maxPostDataSize: 5 * 1024 * 1024,
    }),
    ensureCdpDomain(client, 'Runtime'),
    ensureCdpDomain(client, 'Log'),
  ]);
}
