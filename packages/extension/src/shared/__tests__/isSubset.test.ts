import { describe, it, expect } from 'vitest';
import { isSubset } from '../isSubset';

describe('isSubset', () => {
  it('should return true for identical primitives', () => {
    expect(isSubset(1, 1)).toBe(true);
    expect(isSubset('abc', 'abc')).toBe(true);
    expect(isSubset(true, true)).toBe(true);
    expect(isSubset(null, null)).toBe(true);
    expect(isSubset(undefined, undefined)).toBe(true);
  });

  it('should compare primitives via string coercion', () => {
    expect(isSubset(123, '123')).toBe(true);
    expect(isSubset('456', 456)).toBe(true);
    expect(isSubset(0, '0')).toBe(true);
  });

  it('should return false for mismatched primitives', () => {
    expect(isSubset(1, 2)).toBe(false);
    expect(isSubset('a', 'b')).toBe(false);
  });

  it('should handle null/undefined asymmetry', () => {
    expect(isSubset(null, undefined)).toBe(false);
    expect(isSubset(undefined, null)).toBe(false);
    expect(isSubset(null, 'abc')).toBe(false);
    expect(isSubset('abc', null)).toBe(false);
  });

  it('should match flat object subset', () => {
    expect(isSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(isSubset({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 })).toBe(true);
  });

  it('should fail if subset has extra keys', () => {
    expect(isSubset({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('should fail if values mismatch', () => {
    expect(isSubset({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('should match nested objects recursively', () => {
    expect(isSubset({ a: { x: 1 } }, { a: { x: 1, y: 2 }, b: 3 })).toBe(true);
    expect(isSubset({ a: { x: 1 } }, { a: { x: 2 } })).toBe(false);
  });

  it('should compare arrays by JSON equality', () => {
    expect(isSubset([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(isSubset([1, 2], [1, 2, 3])).toBe(false);
    expect(isSubset([1, 2, 3], [1, 2])).toBe(false);
  });

  it('should not match array against non-array', () => {
    expect(isSubset([1], { 0: 1 })).toBe(false);
  });

  it('should match empty subset against any object', () => {
    expect(isSubset({}, { a: 1, b: 2 })).toBe(true);
    expect(isSubset({}, {})).toBe(true);
  });

  it('should handle deeply nested structures', () => {
    const subset = { user: { address: { city: 'Shanghai' } } };
    const superset = { user: { name: 'test', address: { city: 'Shanghai', zip: '200000' } } };
    expect(isSubset(subset, superset)).toBe(true);
  });

  it('should handle string-number coercion in nested values', () => {
    expect(isSubset({ id: '123' }, { id: 123, name: 'test' })).toBe(true);
    expect(isSubset({ id: 123 }, { id: '123', name: 'test' })).toBe(true);
  });
});
