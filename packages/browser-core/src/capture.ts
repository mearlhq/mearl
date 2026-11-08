export interface CaptureCursorPayload {
  tabId: number;
  generation: string;
  sequence: number;
  scope: 'all' | 'logs' | 'requests' | 'events';
}

export interface CaptureSequenceState {
  tabId: number;
  generation: string;
  currentSequence: number;
}

export interface CapturedEntry {
  captureSequence: number;
  timestampMs: number;
}

export interface CaptureQueryOptions {
  after?: string;
  since?: number;
  limit?: number;
  now?: number;
}

export interface CaptureQueryResult<T> {
  entries: T[];
  totalMatched: number;
  nextCursor: string;
  hasMore: boolean;
  gap: boolean;
}

const CURSOR_PREFIX = 'mearl-capture-v1';

export function createCaptureGeneration(): string {
  return crypto.randomUUID();
}

export function encodeCaptureCursor(cursor: CaptureCursorPayload): string {
  return `${CURSOR_PREFIX}:${cursor.tabId}:${cursor.generation}:${cursor.scope}:${cursor.sequence}`;
}

export function decodeCaptureCursor(value: string): CaptureCursorPayload {
  const match = value.match(/^mearl-capture-v1:(\d+):([^:]+):(all|logs|requests|events):(\d+)$/);
  if (!match) throw new Error('Invalid capture cursor');
  const tabId = Number(match[1]);
  const sequence = Number(match[4]);
  if (!Number.isSafeInteger(tabId) || !Number.isSafeInteger(sequence)) {
    throw new Error('Invalid capture cursor');
  }
  return {
    tabId,
    generation: match[2]!,
    scope: match[3] as CaptureCursorPayload['scope'],
    sequence,
  };
}

export function captureCheckpoint(state: CaptureSequenceState): string {
  return encodeCaptureCursor({
    tabId: state.tabId,
    generation: state.generation,
    sequence: state.currentSequence,
    scope: 'all',
  });
}

export function nextCaptureSequence(state: CaptureSequenceState): number {
  state.currentSequence += 1;
  return state.currentSequence;
}

function resolveAfterSequence(
  after: string | undefined,
  state: CaptureSequenceState,
  scope: CaptureCursorPayload['scope'],
): number {
  if (!after) return 0;
  const cursor = decodeCaptureCursor(after);
  if (cursor.tabId !== state.tabId) {
    throw new Error(`Capture cursor belongs to tab ${cursor.tabId}, not tab ${state.tabId}`);
  }
  if (cursor.generation !== state.generation) {
    throw new Error('Capture cursor expired because the tab collector was restarted');
  }
  if (cursor.scope !== 'all' && cursor.scope !== scope) {
    throw new Error(`Capture cursor is scoped to ${cursor.scope}, not ${scope}`);
  }
  if (cursor.sequence > state.currentSequence) {
    throw new Error('Capture cursor is ahead of the current collector state');
  }
  return cursor.sequence;
}

/**
 * Queries an oldest-first capture buffer.
 *
 * A query without `after` selects the newest matching entries and returns them
 * oldest-first. Incremental queries select the earliest entries after the
 * cursor so callers can paginate without skipping data.
 */
export function queryCapturedEntries<T extends CapturedEntry>(
  buffer: readonly T[],
  state: CaptureSequenceState,
  options: CaptureQueryOptions,
  matches: (entry: T) => boolean,
  droppedThroughSequence = 0,
  scope: CaptureCursorPayload['scope'] = 'all',
): CaptureQueryResult<T> {
  const { after, since, now = Date.now() } = options;
  const limit = Math.max(1, Math.floor(options.limit ?? 100));
  const afterSequence = resolveAfterSequence(after, state, scope);
  const sinceTimestampMs = since === undefined ? undefined : now - since * 1000;
  const matched = buffer.filter(
    entry =>
      entry.captureSequence > afterSequence &&
      (sinceTimestampMs === undefined || entry.timestampMs >= sinceTimestampMs) &&
      matches(entry),
  );
  const hasMore = matched.length > limit;
  const entries = after ? matched.slice(0, limit) : matched.slice(-limit);
  const nextSequence =
    after && hasMore && entries.length > 0
      ? entries[entries.length - 1]!.captureSequence
      : state.currentSequence;

  return {
    entries,
    totalMatched: matched.length,
    nextCursor: encodeCaptureCursor({
      tabId: state.tabId,
      generation: state.generation,
      sequence: nextSequence,
      scope,
    }),
    hasMore,
    gap: after !== undefined && afterSequence < droppedThroughSequence,
  };
}
