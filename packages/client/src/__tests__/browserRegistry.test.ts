import { describe, it, expect } from 'vitest';
import { findBrowser, describeBrowser, type LiveBrowser } from '../browserRegistry';

function browser(overrides: Partial<LiveBrowser> = {}): LiveBrowser {
  return {
    pid: 1000,
    browserId: 'id-default',
    socketPath: '/tmp/x.sock',
    browserName: 'Chrome',
    ...overrides,
  };
}

describe('findBrowser', () => {
  const browsers: LiveBrowser[] = [
    browser({ browserId: 'aaaa1111', browserName: 'Chrome Canary' }),
    browser({ browserId: 'bbbb2222', browserName: 'Edge' }),
    browser({ browserId: 'cccc3333', browserName: 'Chrome' }),
  ];

  it('matches an exact browserId (case-insensitive) first', () => {
    expect(findBrowser(browsers, 'BBBB2222')?.browserId).toBe('bbbb2222');
  });

  it('prefers an exact name match over a substring match', () => {
    // "Chrome" is an exact name of cccc3333 but also a substring of "Chrome Canary".
    expect(findBrowser(browsers, 'chrome')?.browserId).toBe('cccc3333');
  });

  it('requires a full browser id when names are ambiguous', () => {
    const duplicates = [
      browser({ browserId: 'managed:shared', browserName: 'shared' }),
      browser({ browserId: 'managed:example-cloud:shared', browserName: 'shared' }),
    ];

    expect(() => findBrowser(duplicates, 'shared')).toThrow(
      'managed:shared, managed:example-cloud:shared',
    );
    expect(findBrowser(duplicates, 'managed:example-cloud:shared')?.browserId).toBe(
      'managed:example-cloud:shared',
    );
  });

  it('falls back to a substring of id or name', () => {
    expect(findBrowser(browsers, 'canary')?.browserId).toBe('aaaa1111');
    expect(findBrowser(browsers, 'bbbb')?.browserId).toBe('bbbb2222');
  });

  it('returns null for an empty selector or no match', () => {
    expect(findBrowser(browsers, '   ')).toBeNull();
    expect(findBrowser(browsers, 'firefox')).toBeNull();
    expect(findBrowser([], 'chrome')).toBeNull();
  });
});

describe('describeBrowser', () => {
  it('shows a short id as-is', () => {
    expect(describeBrowser(browser({ browserName: 'Edge', browserId: 'short' }))).toBe(
      'Edge [short]',
    );
  });

  it('truncates a long id to 8 chars + ellipsis', () => {
    expect(describeBrowser(browser({ browserName: 'Chrome', browserId: 'abcdefghijklmnop' }))).toBe(
      'Chrome [abcdefgh…]',
    );
  });
});
