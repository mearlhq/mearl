import { describe, expect, it } from 'vitest';
import { resolvePageNavigateInput } from '../pageNavigation';

describe('page navigation input', () => {
  it('normalizes URL, reload, and history traversal', () => {
    expect(resolvePageNavigateInput({ url: ' https://example.test/next ' })).toEqual({
      mode: 'url',
      url: 'https://example.test/next',
    });
    expect(resolvePageNavigateInput({ refresh: true })).toEqual({ mode: 'refresh' });
    expect(resolvePageNavigateInput({ history: 'back' })).toEqual({
      mode: 'history',
      history: 'back',
    });
    expect(resolvePageNavigateInput({ history: 'forward' })).toEqual({
      mode: 'history',
      history: 'forward',
    });
  });

  it('requires exactly one supported navigation mode', () => {
    expect(() => resolvePageNavigateInput({})).toThrow('provide exactly one');
    expect(() => resolvePageNavigateInput({ history: 'previous' })).toThrow(
      '"history" must be one of back, forward',
    );
    expect(() => resolvePageNavigateInput({ url: 'https://example.test', refresh: true })).toThrow(
      'got url, refresh',
    );
    expect(() => resolvePageNavigateInput({ refresh: true, history: 'back' })).toThrow(
      'got refresh, history',
    );
  });
});
