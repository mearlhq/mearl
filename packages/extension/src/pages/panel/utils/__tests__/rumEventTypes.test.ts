import { describe, expect, it } from 'vitest';
import { normalizeRumSelectedTypes } from '../rumEventTypes';

describe('normalizeRumSelectedTypes', () => {
  it('将旧的资源子类型筛选合并为 assets 并去重', () => {
    expect(
      normalizeRumSelectedTypes([
        'rum/view',
        'rum/resource:js',
        'rum/resource:image',
        'rum/assets',
      ]),
    ).toEqual(['rum/view', 'rum/assets']);
  });

  it('没有旧类型时保留原数组引用', () => {
    const types = ['rum/view', 'rum/assets'];
    expect(normalizeRumSelectedTypes(types)).toBe(types);
  });
});
