import { describe, expect, it, vi } from 'vitest';
import { getStructure } from '../dataStructure.js';

describe('result structure samples', () => {
  it('reports primitives, heterogeneous array samples and empty collections without leaf values', () => {
    expect(
      getStructure({ title: 'secret', count: 2, nil: null, missing: undefined, empty: [] }),
    ).toEqual({
      title: 'string',
      count: 'number',
      nil: 'null',
      missing: 'undefined',
      empty: 'array[0]',
    });
    expect(getStructure([{ id: 1 }, { title: 'secret' }], { arraySamples: 2 })).toEqual({
      _type: 'array[2]',
      _samples: [{ id: 'number' }, { title: 'string' }],
    });
  });
  it('bounds depth, width and traversal while identifying circular references', () => {
    const value: any = { deep: { leaf: 1 } };
    value.self = value;
    expect(getStructure(value)).toEqual({ deep: { leaf: 'number' }, self: '<circular>' });
    expect(getStructure(value, { maxDepth: 1 })).toEqual({
      deep: '<max depth reached>',
      self: '<max depth reached>',
    });
    expect(getStructure({ a: 1, b: 2 }, { maxKeys: 1 })).toEqual({
      a: 'number',
      '<truncated keys>': 1,
    });
    expect(getStructure({ a: 1 }, { maxNodes: 1 })).toEqual({ a: '<max nodes reached>' });
  });
  it('does not execute accessors, including array elements, and retains special property names', () => {
    const getter = vi.fn(() => 'secret');
    const value = Object.defineProperty({}, 'token', { enumerable: true, get: getter });
    const array = Object.defineProperty([], '0', { enumerable: true, get: getter });
    expect(getStructure(value)).toEqual({ token: '<accessor>' });
    expect(getStructure(array)).toEqual({ _type: 'array[1]', _sample: '<accessor>' });
    expect(getter).not.toHaveBeenCalled();
    const result = getStructure(JSON.parse('{"__proto__":1}')) as object;
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
  it('rejects invalid resource bounds', () => {
    for (const options of [
      { maxDepth: 0 },
      { maxDepth: 21 },
      { maxKeys: -1 },
      { arraySamples: 1.5 },
      { maxNodes: Infinity },
    ])
      expect(() => getStructure({}, options)).toThrow();
  });
});
