import { describe, expect, it } from 'vitest';
import {
  appendCapturedTrackingBatch,
  compileTextPattern,
  formatTrackingEvent,
  matchesTextPattern,
  queryCapturedTrackingEvents,
  queryTrackingEvents,
} from '../eventFilters';
import { captureCheckpoint, decodeCaptureCursor } from '../capture';
import type { RumEvent } from '../types';

function createEvent(
  id: string,
  source: RumEvent['source'],
  eventType: string,
  name: string,
  batchTimestampMs: number,
): RumEvent {
  return {
    id,
    source,
    batchId: 1,
    batchTimestampMs,
    batchTimestamp: '',
    event_type: eventType,
    name,
    timestamp: batchTimestampMs,
    _raw: {},
    _context: {
      requestUrl: '',
      app: {},
      user: {},
      session: {},
      view: {},
      properties: {},
      os: {},
      net: {},
    },
  };
}

describe('queryTrackingEvents', () => {
  const events = [
    createEvent('1', 'rum', 'view', 'home', 1_000),
    createEvent('2', 'aplus', 'CLK', 'button.submit', 2_000),
    createEvent('3', 'arms', 'error', 'checkout', 3_000),
  ];

  it('filters a buffer and returns the newest matches first', () => {
    expect(
      queryTrackingEvents(events, {
        source: 'aplus',
        event_type: '^clk$',
        filter: 'button',
        limit: 1,
      }),
    ).toEqual({
      events: [events[1]],
      totalMatched: 1,
      totalInBuffer: 3,
    });
  });

  it('applies relative since filtering with a deterministic current time', () => {
    const result = queryTrackingEvents(events, { since: 1.5, now: 4_000 });
    expect(result.events).toEqual([events[2]]);
    expect(result.totalMatched).toBe(1);
  });

  it('falls back to substring matching for invalid regular expressions', () => {
    const event = createEvent('4', 'rum', '[broken', 'literal[', 4_000);
    expect(queryTrackingEvents([event], { event_type: '[', filter: '[' }).events).toEqual([event]);
  });

  it('shares regex and invalid-pattern fallback semantics with request filtering', () => {
    const regex = compileTextPattern('train|traffic');
    expect(matchesTextPattern('sample.api.train.listsearch', regex)).toBe(true);
    expect(matchesTextPattern('sample.api.traffic.saveSearchRecord', regex)).toBe(true);

    const literal = compileTextPattern('api[');
    expect(matchesTextPattern('mtop.example.api[debug]', literal)).toBe(true);
  });

  it('formats compact agent output by default and preserves full detail on demand', () => {
    const event = {
      ...createEvent('5', 'aplus', 'CLK', 'button.search', 5_000),
      captureSequence: 7,
      url: 'https://gm.mmstat.com/aplus.clk?gmkey=CLK&gokey=very-large-payload',
      _raw: { gmkey: 'CLK', gokey: 'very-large-payload' },
      _context: {
        ...createEvent('context', 'aplus', 'CLK', 'context', 0)._context,
        requestUrl: 'https://gm.mmstat.com/aplus.clk?gmkey=CLK',
      },
    };

    expect(formatTrackingEvent(event)).toEqual(
      expect.objectContaining({
        id: '5',
        event_type: 'CLK',
        name: 'button.search',
        url: 'https://gm.mmstat.com/aplus.clk',
      }),
    );
    expect(formatTrackingEvent(event)).not.toHaveProperty('_raw');
    expect(formatTrackingEvent(event)).not.toHaveProperty('_context');
    expect(formatTrackingEvent(event)).not.toHaveProperty('captureSequence');
    expect(formatTrackingEvent(event, true)).toMatchObject({ _raw: { gmkey: 'CLK' } });
    expect(formatTrackingEvent(event, true)).not.toHaveProperty('captureSequence');
  });

  it('paginates checkpoint deltas without splitting one tracking upload batch', () => {
    const captureState = { tabId: 7, generation: 'events', currentSequence: 3 };
    const after = captureCheckpoint({ ...captureState, currentSequence: 1 });
    const capturedEvents = [
      { ...createEvent('batch-a-1', 'aplus', 'CLK', 'first', 2_000), captureSequence: 2 },
      { ...createEvent('batch-a-2', 'aplus', 'CLK', 'second', 2_000), captureSequence: 2 },
      { ...createEvent('batch-b-1', 'rum', 'view', 'third', 3_000), captureSequence: 3 },
    ];

    const first = queryCapturedTrackingEvents(capturedEvents, captureState, { after, limit: 1 });
    expect(first.events.map(event => event.id)).toEqual(['batch-a-1', 'batch-a-2']);
    expect(first.hasMore).toBe(true);
    expect(decodeCaptureCursor(first.nextCursor)).toMatchObject({ scope: 'events', sequence: 2 });

    const second = queryCapturedTrackingEvents(capturedEvents, captureState, {
      after: first.nextCursor,
      limit: 1,
    });
    expect(second.events.map(event => event.id)).toEqual(['batch-b-1']);
    expect(second.hasMore).toBe(false);
    expect(decodeCaptureCursor(second.nextCursor)).toMatchObject({ scope: 'events', sequence: 3 });
  });

  it('keeps asynchronously parsed batches in request-arrival order', () => {
    const buffer = [{ ...createEvent('later', 'rum', 'view', 'later', 2_000), captureSequence: 2 }];
    appendCapturedTrackingBatch(
      buffer,
      [{ ...createEvent('earlier', 'rum', 'view', 'earlier', 1_000), captureSequence: 1 }],
      500,
    );

    expect(buffer.map(event => event.id)).toEqual(['earlier', 'later']);
  });

  it('preserves opaque URL schemes while removing query and fragment detail', () => {
    const event = {
      ...createEvent('6', 'rum', 'resource', 'local-resource', 6_000),
      url: 'file:///tmp/page.html?token=secret#section',
    };

    expect(formatTrackingEvent(event)).toMatchObject({
      url: 'file:///tmp/page.html',
    });
  });
});
