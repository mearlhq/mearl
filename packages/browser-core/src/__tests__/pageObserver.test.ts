import { describe, expect, it } from 'vitest';
import {
  isPotentialNavigationRequest,
  resolveNavigationWaitOptions,
  shouldWaitForPotentialNavigation,
} from '../pageObserver.js';

describe('page observer navigation policy', () => {
  it('adds a navigation grace only to low-information click and press results', () => {
    expect(
      shouldWaitForPotentialNavigation('page_click', {
        mode: 'delta',
        settledBy: 'quiet',
        mutationCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldWaitForPotentialNavigation('page_press', {
        mode: 'delta',
        settledBy: 'no-change',
        mutationCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldWaitForPotentialNavigation('page_click', {
        mode: 'delta',
        settledBy: 'quiet',
        mutationCount: 1,
        effects: { interactives: [{} as any] },
      }),
    ).toBe(false);
    expect(
      shouldWaitForPotentialNavigation('page_type', {
        mode: 'delta',
        settledBy: 'no-change',
        mutationCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldWaitForPotentialNavigation('page_click', {
        mode: 'delta',
        settledBy: 'quiet',
        mutationCount: 1,
        effects: { texts: [{ selector: '#status', text: 'Loading' }] },
      }),
    ).toBe(true);
  });

  it('normalizes navigation wait options', () => {
    expect(resolveNavigationWaitOptions()).toEqual({
      graceMs: 1000,
      timeoutMs: 15000,
      networkIdleMs: 500,
      contentReadyAfterMs: 5000,
    });
    expect(
      resolveNavigationWaitOptions({
        navigationGraceMs: -1,
        navigationTimeoutMs: 99999,
        networkIdleMs: 10,
      }),
    ).toEqual({
      graceMs: 0,
      timeoutMs: 30000,
      networkIdleMs: 100,
      contentReadyAfterMs: 5000,
    });
    expect(
      resolveNavigationWaitOptions({
        navigationTimeoutMs: 1000,
        networkIdleMs: 500,
        contentReadyAfterMs: 9999,
      }),
    ).toEqual({
      graceMs: 1000,
      timeoutMs: 1000,
      networkIdleMs: 500,
      contentReadyAfterMs: 250,
    });
  });

  it('tracks action APIs without treating background resources as navigation signals', () => {
    expect(isPotentialNavigationRequest('XHR', 'https://example.test/search')).toBe(true);
    expect(isPotentialNavigationRequest('Fetch', 'https://example.test/search')).toBe(true);
    expect(
      isPotentialNavigationRequest('Other', 'https://example.test/h5/sample.api.search/1.0/'),
    ).toBe(false);
    expect(isPotentialNavigationRequest('Other', 'https://example.test/collect.gif')).toBe(false);
    expect(isPotentialNavigationRequest('Document', 'https://example.test/results')).toBe(false);
  });
});
