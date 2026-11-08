import { describe, expect, it } from 'vitest';
import { hasRequestConditions } from '../mockConditions';

describe('hasRequestConditions', () => {
  it('ignores the mock sequence index', () => {
    expect(hasRequestConditions()).toBe(false);
    expect(hasRequestConditions({})).toBe(false);
    expect(hasRequestConditions({ $index: 0 })).toBe(false);
  });

  it('detects request matching conditions', () => {
    expect(hasRequestConditions({ id: '123' })).toBe(true);
    expect(hasRequestConditions({ $index: 1, id: '123' })).toBe(true);
  });
});
