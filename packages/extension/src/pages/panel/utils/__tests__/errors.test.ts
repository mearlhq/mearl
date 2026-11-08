import { describe, expect, it } from 'vitest';
import { formatUnknownError, toError } from '../errors';

describe('error formatting', () => {
  it('uses the message from object-shaped errors', () => {
    expect(toError({ message: 'Storage is unavailable' }).toString()).toBe(
      'Error: Storage is unavailable',
    );
  });

  it('serializes object rejection reasons instead of returning [object Object]', () => {
    expect(formatUnknownError({ code: 'E_STORAGE', details: { area: 'sync' } })).toBe(
      '{"code":"E_STORAGE","details":{"area":"sync"}}',
    );
  });

  it('handles circular object rejection reasons', () => {
    const reason: Record<string, unknown> = { code: 'E_CIRCULAR' };
    reason.self = reason;

    const message = toError(reason).toString();

    expect(message).toContain('E_CIRCULAR');
    expect(message).toContain('[Circular]');
    expect(message).not.toContain('[object Object]');
  });

  it('preserves existing Error instances', () => {
    const original = new TypeError('Invalid value');

    expect(toError(original)).toBe(original);
  });
});
