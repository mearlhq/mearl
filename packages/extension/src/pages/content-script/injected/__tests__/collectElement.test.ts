import { beforeEach, describe, expect, it } from 'vitest';

import { collectElementData } from '../collectElement';

describe('collectElementData', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a reusable selector for class names that require CSS escaping', () => {
    document.body.innerHTML = `
      <div class="card sm:w-1/2"><span>first</span></div>
      <div class="card sm:w-1/2"><span id="target">second</span></div>
    `;
    const target = document.getElementById('target')!;
    target.removeAttribute('id');

    const result = collectElementData(target, false)!;

    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
    expect(document.querySelector(result.selector)).toBe(target);
  });
});
