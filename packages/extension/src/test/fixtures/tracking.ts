import type { RumEvent } from '../../pages/panel/types';
export function trackingEvent(input: Partial<RumEvent> = {}): RumEvent {
  return {
    id: 'fixture-event', source: 'rum', batchId: 0, batchTimestampMs: Date.now(), batchTimestamp: 'fixture',
    event_type: 'action', timestamp: Date.now(), _raw: {},
    _context: { requestUrl: 'https://example.test/events', app: {}, user: {}, session: {}, view: {}, properties: {}, os: {}, net: {} },
    ...input,
  };
}
