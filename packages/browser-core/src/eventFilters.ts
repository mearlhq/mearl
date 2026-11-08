import type { RumEvent } from './types.js';
import { encodeCaptureCursor, queryCapturedEntries, type CaptureSequenceState } from './capture.js';

export const TRACKING_CAPTURE_ARMED_HINT =
  'Event capture is active, but this tab has no captured history yet. Reload the current tab or repeat the triggering action, then call get_events again.';

export interface TrackingEventQueryOptions {
  source?: RumEvent['source'] | 'all';
  event_type?: string;
  filter?: string;
  /** Only include events received in the most recent N seconds. */
  since?: number;
  /** Opaque cursor returned by tab_checkpoint or a previous event query. */
  after?: string;
  limit?: number;
  /** Current time override for deterministic callers and tests. */
  now?: number;
}

export type TrackingEventOutput = Omit<RumEvent, '_raw' | '_context' | 'captureSequence'>;

export interface TrackingEventQueryResult {
  events: RumEvent[];
  totalMatched: number;
  totalInBuffer: number;
}

export interface CapturedTrackingEventQueryResult extends TrackingEventQueryResult {
  nextCursor: string;
  hasMore: boolean;
  gap: boolean;
}

export interface CompiledTextPattern {
  regex: RegExp | null;
  fallback: string;
}

export function compileTextPattern(value: string): CompiledTextPattern {
  try {
    return { regex: new RegExp(value, 'i'), fallback: '' };
  } catch {
    return { regex: null, fallback: value.toLowerCase() };
  }
}

export function matchesTextPattern(
  value: string | null | undefined,
  pattern: CompiledTextPattern,
): boolean {
  if (!value) return false;
  return pattern.regex ? pattern.regex.test(value) : value.toLowerCase().includes(pattern.fallback);
}

function compactEventUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.origin === 'null') {
      return value.split(/[?#]/, 1)[0];
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

/**
 * Agent queries default to the parsed event fields. Full tracking payloads and
 * context remain available on demand for field-level debugging.
 */
export function formatTrackingEvent(
  event: RumEvent,
  includeRaw = false,
): RumEvent | TrackingEventOutput {
  const { captureSequence: _discardedCaptureSequence, ...publicEvent } = event;
  if (includeRaw) return publicEvent;

  const { _raw: _discardedRaw, _context, url, ...summary } = publicEvent;
  const compactUrl = compactEventUrl(url ?? _context.requestUrl);
  return {
    ...summary,
    ...(compactUrl ? { url: compactUrl } : {}),
  };
}

function matchesTrackingEvent(
  event: RumEvent,
  options: Pick<TrackingEventQueryOptions, 'source' | 'event_type' | 'filter'>,
): boolean {
  const { source = 'all', event_type, filter } = options;
  if (source !== 'all' && event.source !== source) return false;
  if (event_type && !matchesTextPattern(event.event_type, compileTextPattern(event_type))) {
    return false;
  }
  if (filter) {
    const pattern = compileTextPattern(filter);
    if (!matchesTextPattern(event.name, pattern) && !matchesTextPattern(event.url, pattern)) {
      return false;
    }
  }
  return true;
}

/** Query an oldest-first tracking buffer and return matching events newest first. */
export function queryTrackingEvents(
  buffer: readonly RumEvent[],
  options: TrackingEventQueryOptions = {},
): TrackingEventQueryResult {
  const { source = 'all', event_type, filter, since, limit = 20, now = Date.now() } = options;
  let events = [...buffer].reverse();

  if (source !== 'all') {
    events = events.filter(event => event.source === source);
  }
  if (since !== undefined) {
    const sinceTimestamp = now - since * 1000;
    events = events.filter(event => event.batchTimestampMs >= sinceTimestamp);
  }
  if (event_type) {
    const pattern = compileTextPattern(event_type);
    events = events.filter(event => matchesTextPattern(event.event_type, pattern));
  }
  if (filter) {
    const pattern = compileTextPattern(filter);
    events = events.filter(
      event => matchesTextPattern(event.name, pattern) || matchesTextPattern(event.url, pattern),
    );
  }

  return {
    events: events.slice(0, limit),
    totalMatched: events.length,
    totalInBuffer: buffer.length,
  };
}

interface CapturedTrackingBatch {
  captureSequence: number;
  timestampMs: number;
  events: RumEvent[];
}

/** Insert one parsed tracking upload in request-arrival order and prune whole batches. */
export function appendCapturedTrackingBatch(
  buffer: RumEvent[],
  events: readonly RumEvent[],
  maxSize: number,
): RumEvent[] {
  if (events.length === 0) return [];

  const captureSequence = events[0]!.captureSequence;
  const insertionIndex = Number.isSafeInteger(captureSequence)
    ? buffer.findIndex(
        event =>
          Number.isSafeInteger(event.captureSequence) && event.captureSequence! > captureSequence!,
      )
    : -1;
  buffer.splice(insertionIndex < 0 ? buffer.length : insertionIndex, 0, ...events);

  if (buffer.length <= maxSize) return [];
  let removeCount = buffer.length - maxSize;
  const boundarySequence = buffer[removeCount - 1]?.captureSequence;
  while (
    boundarySequence !== undefined &&
    buffer[removeCount]?.captureSequence === boundarySequence
  ) {
    removeCount += 1;
  }
  return buffer.splice(0, removeCount);
}

/** Query tracking events after one cross-channel checkpoint without splitting an upload batch. */
export function queryCapturedTrackingEvents(
  buffer: readonly RumEvent[],
  state: CaptureSequenceState,
  options: TrackingEventQueryOptions = {},
  droppedThroughSequence = 0,
): CapturedTrackingEventQueryResult {
  const limit = Math.max(1, Math.floor(options.limit ?? 20));
  if (!options.after) {
    const snapshot = queryTrackingEvents(buffer, options);
    return {
      ...snapshot,
      nextCursor: encodeCaptureCursor({
        tabId: state.tabId,
        generation: state.generation,
        sequence: state.currentSequence,
        scope: 'events',
      }),
      hasMore: snapshot.totalMatched > limit,
      gap: false,
    };
  }

  const sinceTimestampMs =
    options.since === undefined ? undefined : (options.now ?? Date.now()) - options.since * 1000;
  const batchesBySequence = new Map<number, CapturedTrackingBatch>();
  for (const event of buffer) {
    if (!Number.isSafeInteger(event.captureSequence)) continue;
    if (sinceTimestampMs !== undefined && event.batchTimestampMs < sinceTimestampMs) continue;
    if (!matchesTrackingEvent(event, options)) continue;
    const captureSequence = event.captureSequence!;
    const batch = batchesBySequence.get(captureSequence);
    if (batch) batch.events.push(event);
    else {
      batchesBySequence.set(captureSequence, {
        captureSequence,
        timestampMs: event.batchTimestampMs,
        events: [event],
      });
    }
  }
  const batches = [...batchesBySequence.values()].sort(
    (left, right) => left.captureSequence - right.captureSequence,
  );

  const captured = queryCapturedEntries(
    batches,
    state,
    { after: options.after, limit: Number.MAX_SAFE_INTEGER },
    () => true,
    droppedThroughSequence,
    'events',
  );
  const selected: CapturedTrackingBatch[] = [];
  let selectedCount = 0;
  for (const batch of captured.entries) {
    if (selected.length > 0 && selectedCount + batch.events.length > limit) break;
    selected.push(batch);
    selectedCount += batch.events.length;
  }
  const hasMore = selected.length < captured.entries.length;
  const nextSequence = hasMore
    ? selected[selected.length - 1]!.captureSequence
    : state.currentSequence;

  return {
    events: selected.flatMap(batch => batch.events),
    totalMatched: captured.entries.reduce((total, batch) => total + batch.events.length, 0),
    totalInBuffer: buffer.length,
    nextCursor: encodeCaptureCursor({
      tabId: state.tabId,
      generation: state.generation,
      sequence: nextSequence,
      scope: 'events',
    }),
    hasMore,
    gap: captured.gap,
  };
}
