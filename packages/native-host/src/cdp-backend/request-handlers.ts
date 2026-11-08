/**
 * CDP request/log/event buffer query handlers.
 */

import {
  compileTextPattern,
  captureCheckpoint,
  formatTrackingEvent,
  matchesTextPattern,
  queryCapturedEntries,
  queryCapturedTrackingEvents,
  serializeRequest,
  TRACKING_CAPTURE_ARMED_HINT,
} from '@mearl/browser-core';
import type { SerializeOptions, CapturedRequest } from '@mearl/browser-core';
import type {
  CaptureCheckpointParams,
  GetEventsParams,
  GetLogsParams,
  GetRequestsParams,
  PageDiagnosticsOptions,
} from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import type { CdpBuffers } from './buffers.js';
import { registerActions } from './action-registry.js';

// ─── Buffer filter helper ────────────────────────────────────────────────────

function filterRequests(
  buffers: CdpBuffers,
  opts: {
    count?: number;
    filter?: string;
    since?: number;
    after?: string;
    source?: 'protocol' | 'requests' | 'all';
    applyHiddenFilter?: boolean;
  },
): ReturnType<typeof queryCapturedEntries<CapturedRequest & { captureSequence: number }>> {
  const pattern = opts.filter ? compileTextPattern(opts.filter) : undefined;
  return queryCapturedEntries(
    buffers.requests.filter((request): request is CapturedRequest & { captureSequence: number } =>
      Number.isSafeInteger(request.captureSequence),
    ),
    buffers.capture,
    { after: opts.after, since: opts.since, limit: opts.count ?? 10 },
    request =>
      (!opts.source || opts.source === 'all' || request.source === opts.source) &&
      (!pattern ||
        matchesTextPattern(request.url, pattern) ||
        matchesTextPattern(request.apiName, pattern)),
    buffers.capture.droppedRequestsThroughSequence,
    'requests',
  );
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function cdpGetRequests(session: PageSession, data: GetRequestsParams): Promise<any> {
  const opts = {
    count: data.count ?? 10,
    filter: data.filter,
    since: data.since,
    after: data.after,
    source: data.source,
    applyHiddenFilter: data.applyHiddenFilter !== false,
  };

  const captured = filterRequests(session.buffers, opts);
  const serializeOpts: SerializeOptions = {
    includeBody: data.includeBody ?? !data.fields?.length,
    includeHeaders: data.includeHeaders === true,
    maxBodySize: data.maxBodySize ?? 50000,
    fields: data.fields,
    keysOnly: data.keysOnly === true,
  };

  return {
    meta: {
      count: captured.entries.length,
      totalMatched: captured.totalMatched,
      totalInBuffer: session.buffers.requests.length,
      filter: data.filter,
      since: data.since,
      after: data.after,
      nextCursor: captured.nextCursor,
      hasMore: captured.hasMore,
      gap: captured.gap,
      source: 'cdp',
    },
    requests: captured.entries.map(r => serializeRequest(r, serializeOpts)),
  };
}

export async function cdpGetLogs(session: PageSession, data: GetLogsParams): Promise<any> {
  const { level, since, after, limit = 100, filter } = data;
  const pattern = filter ? compileTextPattern(filter) : undefined;
  const captured = queryCapturedEntries(
    session.buffers.logs,
    session.buffers.capture,
    { after, since, limit },
    log =>
      (!level || level === 'all' || log.level === level) &&
      (!pattern ||
        matchesTextPattern(log.message, pattern) ||
        log.args.some(arg => matchesTextPattern(arg, pattern))),
    session.buffers.capture.droppedLogsThroughSequence,
    'logs',
  );
  const captureStatus = session.buffers.logs.length === 0 ? 'armed' : 'active';

  return {
    meta: {
      count: captured.entries.length,
      totalMatched: captured.totalMatched,
      totalInBuffer: session.buffers.logs.length,
      level: level || 'all',
      since,
      after,
      filter,
      nextCursor: captured.nextCursor,
      hasMore: captured.hasMore,
      gap: captured.gap,
      captureStatus,
      ...(captureStatus === 'armed' && {
        hint: 'Log capture is active, but this tab has no captured history yet. Reload the current tab or repeat the triggering action, then call get_logs again.',
      }),
      source: 'cdp',
    },
    logs: captured.entries,
  };
}

export async function cdpCaptureCheckpoint(
  session: PageSession,
  _data: CaptureCheckpointParams,
): Promise<any> {
  return {
    tabId: session.tabId,
    cursor: captureCheckpoint(session.buffers.capture),
    timestampMs: Date.now(),
    captureStatus: session.buffers.capture.currentSequence === 0 ? 'armed' : 'active',
  };
}

export async function collectCdpPageDiagnostics(
  session: PageSession,
  after: string,
  diagnostics: PageDiagnosticsOptions,
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  if (diagnostics.logs) {
    const options =
      diagnostics.logs === true
        ? { level: 'error' as const, limit: 100 }
        : { level: 'error' as const, limit: 100, ...diagnostics.logs };
    result.logs = await cdpGetLogs(session, { ...options, tabId: session.tabId, after });
  }
  if (diagnostics.requests) {
    const options =
      diagnostics.requests === true
        ? { source: 'all' as const, includeBody: false, count: 100 }
        : {
            source: 'all' as const,
            includeBody: false,
            count: 100,
            ...diagnostics.requests,
          };
    result.requests = await cdpGetRequests(session, { ...options, tabId: session.tabId, after });
  }
  if (diagnostics.events) {
    const options =
      diagnostics.events === true
        ? { source: 'all' as const, limit: 100 }
        : { source: 'all' as const, limit: 100, ...diagnostics.events };
    result.events = await cdpGetEvents(session, { ...options, tabId: session.tabId, after });
  }
  return result;
}

export async function cdpGetEvents(session: PageSession, data: GetEventsParams): Promise<any> {
  const { source = 'all', event_type, since, after, limit = 20, filter, includeRaw = false } = data;
  const response = queryCapturedTrackingEvents(
    session.buffers.events,
    session.buffers.capture,
    {
      source,
      event_type,
      since,
      after,
      limit,
      filter,
    },
    session.buffers.capture.droppedEventsThroughSequence,
  );
  const captureStatus = response.totalInBuffer === 0 ? 'armed' : 'active';
  const hint =
    response.events.length === 0 && captureStatus === 'armed'
      ? TRACKING_CAPTURE_ARMED_HINT
      : undefined;

  return {
    meta: {
      count: response.events.length,
      totalMatched: response.totalMatched,
      totalInBuffer: response.totalInBuffer,
      source,
      captureStatus,
      captureSource: 'cdp',
      includeRaw,
      after,
      nextCursor: response.nextCursor,
      hasMore: response.hasMore,
      gap: response.gap,
      hint,
    },
    events: response.events.map(event => formatTrackingEvent(event, includeRaw)),
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerActions([
  { name: 'tab_checkpoint', session: 'page', handler: cdpCaptureCheckpoint },
  { name: 'capture_checkpoint', session: 'page', handler: cdpCaptureCheckpoint },
  { name: 'get_requests', session: 'page', handler: cdpGetRequests },
  { name: 'get_logs', session: 'page', handler: cdpGetLogs },
  { name: 'get_events', session: 'page', handler: cdpGetEvents },
]);
