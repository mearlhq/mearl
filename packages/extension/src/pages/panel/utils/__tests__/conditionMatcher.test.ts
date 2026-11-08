import { describe, it, expect } from 'vitest';
import { matchesOverrideConditions, findMatchingOverride } from '../conditionMatcher';
import { ResponseOverride } from '../../../../shared/types';

describe('matchesOverrideConditions', () => {
  const baseOverride: ResponseOverride = {
    id: 'test-1',
    apiName: 'mtop.test.api',
    responseData: {},
  };

  it('should always match when no conditions', () => {
    expect(matchesOverrideConditions({ ...baseOverride }, undefined)).toBe(true);
    expect(matchesOverrideConditions({ ...baseOverride, conditions: {} }, undefined)).toBe(true);
    expect(matchesOverrideConditions({ ...baseOverride, conditions: undefined }, undefined)).toBe(
      true,
    );
  });

  it('should match conditions against parsed postData object', () => {
    const override = { ...baseOverride, conditions: { itemId: '123' } };
    expect(matchesOverrideConditions(override, { itemId: '123', extra: 'data' })).toBe(true);
    expect(matchesOverrideConditions(override, { itemId: '456' })).toBe(false);
    expect(matchesOverrideConditions(override, {})).toBe(false);
  });

  it('should match conditions against JSON string postData', () => {
    const override = { ...baseOverride, conditions: { itemId: '123' } };
    expect(matchesOverrideConditions(override, JSON.stringify({ itemId: '123' }))).toBe(true);
    expect(matchesOverrideConditions(override, JSON.stringify({ itemId: '456' }))).toBe(false);
  });

  it('should match conditions against form-encoded postData', () => {
    const override = { ...baseOverride, conditions: { itemId: '123' } };
    expect(matchesOverrideConditions(override, 'itemId=123&name=test')).toBe(true);
    expect(matchesOverrideConditions(override, 'itemId=456')).toBe(false);
  });

  it('should match conditions against queryString', () => {
    const override = { ...baseOverride, conditions: { page: 1 } };
    const queryString = [
      { name: 'page', value: '1' },
      { name: 'size', value: '20' },
    ];
    expect(matchesOverrideConditions(override, undefined, queryString)).toBe(true);
  });

  it('should merge queryString and postData for matching', () => {
    const override = { ...baseOverride, conditions: { page: 1, itemId: '123' } };
    const queryString = [{ name: 'page', value: '1' }];
    const postData = { itemId: '123' };
    expect(matchesOverrideConditions(override, postData, queryString)).toBe(true);
  });

  it('should match nested conditions', () => {
    const override = { ...baseOverride, conditions: { filter: { type: 'hot' } } };
    const postData = { filter: { type: 'hot', limit: 10 } };
    expect(matchesOverrideConditions(override, postData)).toBe(true);
  });

  it('should fallback to matching requestData.data (shorthand)', () => {
    const override = { ...baseOverride, conditions: { itemId: '123' } };
    const postData = { data: { itemId: '123', name: 'test' } };
    expect(matchesOverrideConditions(override, postData)).toBe(true);
  });

  it('should not match when data fallback also fails', () => {
    const override = { ...baseOverride, conditions: { itemId: '123' } };
    const postData = { data: { itemId: '456' } };
    expect(matchesOverrideConditions(override, postData)).toBe(false);
  });

  it('should handle null/undefined postData gracefully', () => {
    const override = { ...baseOverride, conditions: { itemId: '123' } };
    expect(matchesOverrideConditions(override, null)).toBe(false);
    expect(matchesOverrideConditions(override, undefined)).toBe(false);
    expect(matchesOverrideConditions(override, '')).toBe(false);
  });

  it('should parse JSON values in form-encoded postData', () => {
    const override = { ...baseOverride, conditions: { ids: [1, 2, 3] } };
    expect(matchesOverrideConditions(override, 'ids=[1,2,3]')).toBe(true);
  });

  it('should ignore the reserved sequence index when matching request fields', () => {
    expect(
      matchesOverrideConditions(
        { ...baseOverride, conditions: { $index: 1, itemId: '123' } },
        { itemId: '123' },
      ),
    ).toBe(true);
    expect(matchesOverrideConditions({ ...baseOverride, conditions: { $index: 1 } }, {})).toBe(
      true,
    );
  });
});

describe('findMatchingOverride', () => {
  const makeOverride = (id: string, conditions?: Record<string, any>): ResponseOverride => ({
    id,
    apiName: 'mtop.test.api',
    responseData: { id },
    conditions,
  });

  it('should return undefined for empty/undefined list', () => {
    expect(findMatchingOverride(undefined, {})).toBeUndefined();
    expect(findMatchingOverride([], {})).toBeUndefined();
  });

  it('should return unconditional override when no conditions set', () => {
    const overrides = [makeOverride('a')];
    expect(findMatchingOverride(overrides, { anything: true })).toBe(overrides[0]);
  });

  it('should return first matching override by condition', () => {
    const overrides = [
      makeOverride('cond-a', { itemId: '111' }),
      makeOverride('cond-b', { itemId: '222' }),
      makeOverride('fallback'),
    ];
    expect(findMatchingOverride(overrides, { itemId: '222' })?.id).toBe('cond-b');
  });

  it('should fallback to unconditional override when no condition matches', () => {
    const overrides = [makeOverride('cond-a', { itemId: '111' }), makeOverride('fallback')];
    expect(findMatchingOverride(overrides, { itemId: '999' })?.id).toBe('fallback');
  });

  it('should return undefined when no override matches', () => {
    const overrides = [
      makeOverride('cond-a', { itemId: '111' }),
      makeOverride('cond-b', { itemId: '222' }),
    ];
    expect(findMatchingOverride(overrides, { itemId: '999' })).toBeUndefined();
  });
});
