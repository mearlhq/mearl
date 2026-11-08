import { describe, expect, it, vi } from 'vitest';
import { providerRequestTimeoutMs } from '../provider-request-timeout.js';

describe('Provider request deadlines', () => {
  it('covers long actions without imposing a two-minute cap', () => {
    expect(providerRequestTimeoutMs('browser_close', {})).toBe(1_080_000);
    expect(providerRequestTimeoutMs('page_upload', {})).toBe(208_000);
    expect(providerRequestTimeoutMs('page_wait', { time: 180_000 })).toBe(185_000);
    expect(
      providerRequestTimeoutMs('run_actions', {
        actions: [
          { action: 'page_wait', data: { time: 180_000 } },
          { action: 'page_wait', data: { time: 180_000 } },
        ],
      }),
    ).toBe(370_000);
  });
  it('honors the caller deadline instead of restarting the timeout on each hop', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      expect(providerRequestTimeoutMs('page_wait', {}, 301_000)).toBe(300_000);
      now.mockReturnValue(151_000);
      expect(providerRequestTimeoutMs('page_wait', {}, 301_000)).toBe(150_000);
      for (const deadline of [0, 150_000, Infinity, NaN, 1.5, Date.now() + 2_147_483_648])
        expect(() => providerRequestTimeoutMs('page_wait', {}, deadline)).toThrow();
    } finally {
      now.mockRestore();
    }
  });
});
