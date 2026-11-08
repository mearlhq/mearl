import { describe, expect, it } from 'vitest';
import {
  captureCheckpoint,
  decodeCaptureCursor,
  queryCapturedEntries,
  type CaptureSequenceState,
} from '../capture.js';

interface Entry {
  captureSequence: number;
  timestampMs: number;
  value: string;
}

function state(currentSequence = 5): CaptureSequenceState {
  return { tabId: 7, generation: 'generation', currentSequence };
}

const entries: Entry[] = [1, 2, 3, 4, 5].map(sequence => ({
  captureSequence: sequence,
  timestampMs: sequence * 1000,
  value: `entry-${sequence}`,
}));

describe('capture cursor queries', () => {
  it('returns the latest entries oldest-first for a snapshot query', () => {
    const result = queryCapturedEntries(entries, state(), { limit: 2 }, () => true);

    expect(result.entries.map(entry => entry.captureSequence)).toEqual([4, 5]);
    expect(result.hasMore).toBe(true);
    expect(decodeCaptureCursor(result.nextCursor).sequence).toBe(5);
  });

  it('paginates incremental entries from the oldest unseen entry', () => {
    const captureState = state();
    const after = captureCheckpoint({ ...captureState, currentSequence: 1 });
    const first = queryCapturedEntries(entries, captureState, { after, limit: 2 }, () => true);

    expect(first.entries.map(entry => entry.captureSequence)).toEqual([2, 3]);
    expect(first.hasMore).toBe(true);
    expect(decodeCaptureCursor(first.nextCursor).sequence).toBe(3);

    const second = queryCapturedEntries(
      entries,
      captureState,
      { after: first.nextCursor, limit: 2 },
      () => true,
    );
    expect(second.entries.map(entry => entry.captureSequence)).toEqual([4, 5]);
    expect(second.hasMore).toBe(false);
    expect(decodeCaptureCursor(second.nextCursor).sequence).toBe(5);
  });

  it('advances past unmatched entries when an incremental page is exhausted', () => {
    const captureState = state();
    const after = captureCheckpoint({ ...captureState, currentSequence: 1 });
    const result = queryCapturedEntries(
      entries,
      captureState,
      { after, limit: 10 },
      entry => entry.captureSequence === 3,
    );

    expect(result.entries.map(entry => entry.captureSequence)).toEqual([3]);
    expect(decodeCaptureCursor(result.nextCursor).sequence).toBe(5);
  });

  it('reports a gap when the requested channel discarded unseen entries', () => {
    const captureState = state();
    const after = captureCheckpoint({ ...captureState, currentSequence: 1 });
    const result = queryCapturedEntries(entries.slice(2), captureState, { after }, () => true, 2);

    expect(result.gap).toBe(true);
  });

  it('rejects cursors from another collector generation', () => {
    const after = captureCheckpoint({ tabId: 7, generation: 'old', currentSequence: 1 });

    expect(() => queryCapturedEntries(entries, state(), { after }, () => true)).toThrow(
      'collector was restarted',
    );
  });

  it('rejects reusing a channel cursor for another diagnostic stream', () => {
    const captureState = state();
    const logs = queryCapturedEntries(entries, captureState, { limit: 1 }, () => true, 0, 'logs');

    expect(() =>
      queryCapturedEntries(
        entries,
        captureState,
        { after: logs.nextCursor },
        () => true,
        0,
        'requests',
      ),
    ).toThrow('scoped to logs');
  });

  it('supports an events-scoped cursor', () => {
    const result = queryCapturedEntries(entries, state(), { limit: 1 }, () => true, 0, 'events');

    expect(decodeCaptureCursor(result.nextCursor).scope).toBe('events');
  });

  it('interprets since as a relative number of seconds', () => {
    const result = queryCapturedEntries(entries, state(), { since: 2, now: 5000 }, () => true);

    expect(result.entries.map(entry => entry.captureSequence)).toEqual([3, 4, 5]);
  });
});
