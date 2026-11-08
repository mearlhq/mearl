import { describe, expect, it } from 'vitest';
import { findMatchingTabs, selectMatchingTab } from '../tabMatching';

const tabs = [
  { id: 1, url: 'https://www.figma.com/design/file-a/Name?node-id=1-2#section' },
  { id: 2, url: 'https://www.figma.com/design/file-a/Name?node-id=3-4' },
  { id: 3, url: 'https://example.com/' },
];

describe('tab URL matching', () => {
  it('matches exact URLs after ignoring search and hash', () => {
    expect(
      findMatchingTabs(tabs, 'https://www.figma.com/design/file-a/Name', {
        ignoreSearch: true,
        ignoreHash: true,
      }).map(tab => tab.id),
    ).toEqual([1, 2]);
  });

  it('supports full URL globs', () => {
    expect(
      findMatchingTabs(tabs, 'https://www.figma.com/', {
        urlPattern: 'https://www.figma.com/design/file-a/*',
        ignoreSearch: true,
        ignoreHash: true,
      }).map(tab => tab.id),
    ).toEqual([1, 2]);
  });

  it('rejects ambiguous matches unless first-match behavior is explicit', () => {
    expect(() =>
      selectMatchingTab(tabs, tabs[0].url, { ignoreSearch: true, ignoreHash: true }),
    ).toThrow('matched 2 existing tabs');
    expect(
      selectMatchingTab(tabs, tabs[0].url, {
        ignoreSearch: true,
        ignoreHash: true,
        onMultiple: 'first',
      })?.id,
    ).toBe(1);
  });
});
