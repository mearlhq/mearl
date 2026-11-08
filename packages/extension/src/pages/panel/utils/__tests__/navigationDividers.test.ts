import { describe, expect, it } from 'vitest';
import type { NavigationDivider } from '../../types';
import { appendNavigationDivider } from '../navigationDividers';

function makeDivider(overrides: Partial<NavigationDivider> = {}): NavigationDivider {
  return {
    type: 'navigation-divider',
    id: 1_000,
    timestampMs: 1_000,
    url: 'https://example.com/page',
    ...overrides,
  };
}

describe('navigation dividers', () => {
  it('appends a divider for the committed navigation URL', () => {
    const next = appendNavigationDivider([], 'https://example.com/page', 1_000);

    expect(next).toEqual([makeDivider()]);
  });

  it('assigns unique monotonic IDs to distinct events from the same millisecond', () => {
    const current = [makeDivider()];
    const next = appendNavigationDivider(current, 'https://example.com/other', 1_000);

    expect(next[1].id).toBeGreaterThan(next[0].id);
    expect(next[1].timestampMs).toBe(1_000);
  });
});
