import { describe, expect, it } from 'vitest';
import { formatCustomTime, parseCustomTime } from '../customTime';

describe('custom time conversion', () => {
  it('converts a wall time in the selected timezone to an epoch', () => {
    const timestamp = parseCustomTime('2026-08-21T12:34', 'Asia/Shanghai');

    expect(timestamp).toBe(Date.parse('2026-08-21T04:34:00.000Z'));
    expect(formatCustomTime(timestamp!, 'Asia/Shanghai')).toBe('2026-08-21T12:34');
  });

  it('uses the selected timezone across daylight-saving offsets', () => {
    expect(parseCustomTime('2026-01-15T09:00', 'America/New_York')).toBe(
      Date.parse('2026-01-15T14:00:00.000Z'),
    );
    expect(parseCustomTime('2026-07-15T09:00', 'America/New_York')).toBe(
      Date.parse('2026-07-15T13:00:00.000Z'),
    );
  });

  it('rejects invalid and skipped daylight-saving wall times', () => {
    expect(parseCustomTime('not-a-time', 'Asia/Shanghai')).toBeNull();
    expect(parseCustomTime('2026-02-30T12:00', 'Asia/Shanghai')).toBeNull();
    expect(parseCustomTime('2026-03-08T02:30', 'America/New_York')).toBeNull();
  });
});
