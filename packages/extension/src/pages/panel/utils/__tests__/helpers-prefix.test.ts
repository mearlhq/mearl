import { describe, expect, it } from 'vitest';
import { setValueByPathInParsedData } from '../helpers';

describe('带前缀 JSON 的路径写回', () => {
  it.each([
    { path: ['payload', 'count'], value: 2, expected: 'callback{"count":2}' },
    { path: ['payload', 'extra'], value: 'new', expected: 'callback{"count":1,"extra":"new"}' },
    { path: ['payload', 'count'], value: undefined, expected: 'callback{}' },
  ])('修改 $path 时保留前缀', ({ path, value, expected }) => {
    const original = { payload: 'callback{"count":1}' };

    expect(setValueByPathInParsedData(original, original, path, value)).toEqual({
      payload: expected,
    });
    expect(original.payload).toBe('callback{"count":1}');
  });

  it('逐层保留多重嵌套字符串的前缀和 URL 编码', () => {
    const original = {
      payload:
        'outer' +
        JSON.stringify({
          inner: 'inner' + JSON.stringify({ encoded: encodeURIComponent('{"count":1}') }),
        }),
    };

    expect(
      setValueByPathInParsedData(original, original, ['payload', 'inner', 'encoded', 'count'], 2),
    ).toEqual({
      payload:
        'outer' +
        JSON.stringify({
          inner: 'inner' + JSON.stringify({ encoded: encodeURIComponent('{"count":2}') }),
        }),
    });
  });
});
