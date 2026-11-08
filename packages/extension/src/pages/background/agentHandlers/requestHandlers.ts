/**
 * Agent handlers: get_requests, get_logs, get_events
 */

import {
  formatTrackingEvent,
  TRACKING_CAPTURE_ARMED_HINT,
  type CaptureCheckpointParams,
  type CaptureCheckpointResult,
  type ConsoleLog,
  type GetEventsParams,
  type GetLogsParams,
  type GetRequestsParams,
  type TrackingEventOutput,
} from '@mearl/browser-core';
import { RumEvent } from '../../panel/types';
import { serializeRequest, type SerializeOptions } from '../requestBuffer';
import {
  flushRequestCollection,
  getCaptureCheckpoint,
  getCollectedEvents,
  getCollectedLogs,
  getCollectedRequests,
  isCollecting,
} from '../backgroundRequestCollector';
import type { AgentHandlerContext } from './types';

// ─── get_requests ────────────────────────────────────────────────────────────

export async function handleGetRequests(
  data: GetRequestsParams,
  _ctx: AgentHandlerContext,
): Promise<{ meta: any; requests: any[] }> {
  const source = data.source ?? 'all';
  const count = data.count ?? 10;

  const serializeOpts: SerializeOptions = {
    includeBody: data.includeBody ?? !data.fields?.length,
    includeHeaders: data.includeHeaders === true,
    maxBodySize: data.maxBodySize ?? 50000,
    fields: data.fields,
    keysOnly: data.keysOnly === true,
  };

  const tabId = data.tabId;
  if (!isCollecting(tabId)) {
    throw new Error(
      `Diagnostics capture is unavailable for tab ${tabId}. Reopen the page with tab_open and retry.`,
    );
  }
  await flushRequestCollection(tabId, { allowDecodeFailure: true });
  const response = getCollectedRequests(tabId, {
    count,
    source,
    filter: data.filter,
    since: data.since,
    after: data.after,
  });

  const serialized = response.requests
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map(req => serializeRequest(req, serializeOpts));
  const captureStatus = response.totalInBuffer === 0 ? 'armed' : 'active';
  const captureHint =
    serialized.length === 0 && captureStatus === 'armed'
      ? 'Request capture is active, but this tab has no captured history yet. Reload the current tab or repeat the triggering action, then call get_requests again.'
      : undefined;

  return {
    meta: {
      count: serialized.length,
      totalMatched: response.totalMatched,
      totalInBuffer: response.totalInBuffer,
      tabIds: [tabId],
      filter: data.filter,
      since: data.since,
      after: data.after,
      nextCursor: response.nextCursor,
      hasMore: response.hasMore,
      gap: response.gap,
      includeBody: serializeOpts.includeBody,
      includeHeaders: serializeOpts.includeHeaders,
      fields: data.fields,
      keysOnly: serializeOpts.keysOnly,
      captureStatus,
      hint: captureHint,
      source: 'background_collector',
    },
    requests: serialized,
  };
}

// ─── get_logs ────────────────────────────────────────────────────────────────

export async function handleGetLogs(
  data: GetLogsParams,
  _ctx: AgentHandlerContext,
): Promise<{
  meta: {
    count: number;
    totalMatched: number;
    totalInBuffer: number;
    level: string;
    since?: number;
    after?: string;
    filter?: string;
    nextCursor: string;
    hasMore: boolean;
    gap: boolean;
    captureStatus: 'armed' | 'active';
    hint?: string;
    source: 'background_collector';
  };
  logs: ConsoleLog[];
}> {
  const { level, since, after, limit = 100, filter, tabId } = data;
  if (!isCollecting(tabId)) {
    throw new Error(
      `Diagnostics capture is unavailable for tab ${tabId}. Reopen the page with tab_open and retry.`,
    );
  }
  await flushRequestCollection(tabId, { allowDecodeFailure: true });
  const result = getCollectedLogs(tabId, { level, since, after, limit, filter });
  const captureStatus = result.totalInBuffer === 0 ? 'armed' : 'active';

  return {
    meta: {
      count: result.entries.length,
      totalMatched: result.totalMatched,
      totalInBuffer: result.totalInBuffer,
      level: level || 'all',
      since,
      after,
      filter,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      gap: result.gap,
      captureStatus,
      ...(captureStatus === 'armed' && {
        hint: 'Log capture is active, but this tab has no captured history yet. Reload the current tab or repeat the triggering action, then call get_logs again.',
      }),
      source: 'background_collector',
    },
    logs: result.entries,
  };
}

export async function handleCaptureCheckpoint(
  data: CaptureCheckpointParams,
  _ctx: AgentHandlerContext,
): Promise<CaptureCheckpointResult> {
  const tabId = data.tabId;
  if (!isCollecting(tabId)) {
    throw new Error(
      `Diagnostics capture is unavailable for tab ${tabId}. Reopen the page with tab_open and retry.`,
    );
  }
  await flushRequestCollection(tabId, { allowDecodeFailure: true });
  return getCaptureCheckpoint(tabId);
}

// ─── get_events ──────────────────────────────────────────────────────────────

export async function handleGetEvents(
  data: GetEventsParams,
  ctx: AgentHandlerContext,
): Promise<{
  meta: {
    count: number;
    totalMatched: number;
    totalInBuffer: number;
    source: string;
    captureStatus: 'inactive' | 'armed' | 'active';
    captureSource: 'background_collector' | 'panel' | 'none';
    includeRaw: boolean;
    after?: string;
    nextCursor?: string;
    hasMore?: boolean;
    gap?: boolean;
    hint?: string;
  };
  events: Array<RumEvent | TrackingEventOutput>;
}> {
  const { source = 'all', event_type, filter, since, after, limit = 20, includeRaw = false } = data;
  const tabId = data.tabId;

  if (isCollecting(tabId)) await flushRequestCollection(tabId);
  const collectedResponse = isCollecting(tabId)
    ? getCollectedEvents(tabId, { source, event_type, filter, since, after, limit })
    : null;
  if (after && !collectedResponse) {
    throw new Error(
      `Diagnostics capture is unavailable for tab ${tabId}. Reopen the page with tab_open and retry.`,
    );
  }
  let response = collectedResponse ?? {
    events: [] as RumEvent[],
    totalMatched: 0,
    totalInBuffer: 0,
  };
  let captureSource: 'background_collector' | 'panel' | 'none' =
    collectedResponse && (after !== undefined || collectedResponse.totalMatched > 0)
      ? 'background_collector'
      : 'none';

  if (!after && (!collectedResponse || collectedResponse.totalMatched === 0)) {
    try {
      response = await ctx.queryPanel(tabId, {
        type: 'getEvents',
        source,
        event_type,
        filter,
        since,
        limit,
      });
      captureSource = 'panel';
    } catch {
      // Panel 未连接时保留后台采集结果，包括尚未产生事件的 armed 状态。
    }
  }

  const captureStatus = !collectedResponse
    ? 'inactive'
    : collectedResponse.totalInBuffer === 0
      ? 'armed'
      : 'active';
  const hint =
    response.events.length > 0
      ? undefined
      : captureStatus === 'armed'
        ? TRACKING_CAPTURE_ARMED_HINT
        : captureStatus === 'inactive'
          ? 'Event capture could not attach to the current tab. Open the page with tab_open, then call get_events for the new tabId.'
          : undefined;

  return {
    meta: {
      count: response.events.length,
      totalMatched: response.totalMatched,
      totalInBuffer: response.totalInBuffer,
      source,
      captureStatus,
      captureSource,
      includeRaw,
      after,
      ...('nextCursor' in response ? { nextCursor: response.nextCursor } : {}),
      ...('hasMore' in response ? { hasMore: response.hasMore } : {}),
      ...('gap' in response ? { gap: response.gap } : {}),
      hint,
    },
    events: response.events.map(event => formatTrackingEvent(event, includeRaw)),
  };
}
