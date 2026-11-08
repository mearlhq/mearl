import { describe, expect, it } from 'vitest';
import {
  filterCookiesForUrl,
  resolveGetCookieTarget,
  resolveSetCookieTarget,
  selectReadableCookie,
} from '../cookie';

describe('set cookie target', () => {
  it('sets an explicit URL without a current page', () => {
    expect(
      resolveSetCookieTarget(undefined, {
        url: 'https://www.example.com/app/page',
        name: 'feature_flag',
        value: '1',
        domain: 'example.com',
      }),
    ).toMatchObject({
      cookieUrl: 'https://www.example.com/',
      cookieDomain: '.example.com',
      reload: false,
    });
  });

  it.each(['', 'chrome://settings/', 'https://user:secret@example.org/'])(
    'rejects invalid explicit URL %s',
    url => {
      expect(() =>
        resolveSetCookieTarget(undefined, { url, name: 'feature_flag', value: '1' }),
      ).toThrow();
    },
  );

  it('targets the current host without widening the cookie scope', () => {
    expect(
      resolveSetCookieTarget(
        'https://shop.preview.example.com/app/catalog/items',
        { name: 'feature_flag', value: 'enabled' },
      ),
    ).toEqual({
      cookieName: 'feature_flag',
      cookieValue: 'enabled',
      cookieUrl: 'https://shop.preview.example.com/',
      domain: 'shop.preview.example.com',
      path: '/',
      reload: false,
    });
  });

  it('supports an explicit parent domain, path, and reload', () => {
    expect(
      resolveSetCookieTarget(
        'https://assets.preview.example.com/app/catalog/search.html',
        {
          name: 'feature_channel.search',
          value: 'feature/example',
          domain: 'https://example.com',
          path: '/app',
          reload: true,
        },
      ),
    ).toEqual({
      cookieName: 'feature_channel.search',
      cookieValue: 'feature/example',
      cookieDomain: '.example.com',
      cookieUrl: 'https://assets.preview.example.com/app',
      domain: 'example.com',
      path: '/app',
      reload: true,
    });
  });

  it('rejects unrelated domains', () => {
    expect(() =>
      resolveSetCookieTarget('https://m.example.com/app', {
        name: 'feature_flag',
        value: 'enabled',
        domain: 'example.net',
      }),
    ).toThrow('is not a parent domain');
  });

  it('rejects unsafe names, values, and paths', () => {
    const url = 'https://m.example.com/app';
    expect(() => resolveSetCookieTarget(url, { name: 'bad name', value: '1' })).toThrow(
      '"name" contains unsupported',
    );
    expect(() => resolveSetCookieTarget(url, { name: 'safe', value: '1; other=1' })).toThrow(
      '"value" contains unsupported',
    );
    expect(() => resolveSetCookieTarget(url, { name: 'safe', value: '1', path: 'app' })).toThrow(
      '"path" must start',
    );
  });

  it('allows an empty value and rejects non-http pages', () => {
    expect(
      resolveSetCookieTarget('https://m.example.com/', {
        name: 'feature_flag',
        value: '',
      }).cookieValue,
    ).toBe('');
    expect(() =>
      resolveSetCookieTarget('chrome://settings/', { name: 'feature_flag', value: '1' }),
    ).toThrow('must use http or https');
  });
});

describe('get cookie target', () => {
  it('reads an explicit URL without a current page', () => {
    expect(
      resolveGetCookieTarget(undefined, {
        url: 'https://www.example.com/app/page',
        name: 'display_name',
      }),
    ).toEqual({ cookieName: 'display_name', cookieUrl: 'https://www.example.com/app/page' });
    expect(() => resolveGetCookieTarget(undefined, { name: 'display_name' })).toThrow(
      'specify url or tabId',
    );
  });

  it('uses the current page URL so path-scoped cookies remain visible', () => {
    expect(
      resolveGetCookieTarget(
        'https://shop.preview.example.com/app/catalog/items?source=test',
        { name: 'feature_channel.catalog' },
      ),
    ).toEqual({
      cookieName: 'feature_channel.catalog',
      cookieUrl: 'https://shop.preview.example.com/app/catalog/items',
    });
  });

  it('supports exact domain and path filters', () => {
    expect(
      resolveGetCookieTarget('https://assets.preview.example.com/app/page', {
        name: 'branch_cookie',
        domain: 'example.com',
        path: '/app',
      }),
    ).toEqual({
      cookieName: 'branch_cookie',
      cookieUrl: 'https://assets.preview.example.com/app',
      domain: 'example.com',
      path: '/app',
    });
  });

  it('uses an explicit lookup URL without requiring the current tab to share its domain', () => {
    expect(
      resolveGetCookieTarget('https://example.org/debug', {
        name: 'display_name',
        url: 'https://www.example.com/',
        domain: 'example.com',
        path: '/',
      }),
    ).toEqual({
      cookieName: 'display_name',
      cookieUrl: 'https://www.example.com/',
      domain: 'example.com',
      path: '/',
    });
  });

  it('rejects unrelated domains and unsafe names', () => {
    expect(() =>
      resolveGetCookieTarget('https://m.example.com/', {
        name: 'branch_cookie',
        domain: 'example.net',
      }),
    ).toThrow('is not a parent domain');
    expect(() => resolveGetCookieTarget('https://m.example.com/', { name: 'bad name' })).toThrow(
      '"name" contains unsupported',
    );
    expect(() =>
      resolveGetCookieTarget('https://example.org/', {
        name: 'feature_flag',
        url: 'https://user:secret@example.org/',
      }),
    ).toThrow('must not contain credentials');
  });
});

describe('cookie selection', () => {
  it.each([
    ['unrelated domain', 'https://m.example.com/app/page', { domain: '.example.org', path: '/' }],
    ['host-only parent', 'https://m.example.com/app/page', { domain: 'example.com', path: '/' }],
    [
      'hostOnly flag',
      'https://m.example.com/app/page',
      { domain: '.example.com', path: '/', hostOnly: true },
    ],
    ['partial domain suffix', 'https://evilexample.com/', { domain: '.example.com', path: '/' }],
    ['unrelated path', 'https://m.example.com/app/page', { domain: '.example.com', path: '/other' }],
    [
      'partial path segment',
      'https://m.example.com/application',
      { domain: '.example.com', path: '/app' },
    ],
    [
      'secure cookie on HTTP',
      'http://m.example.com/',
      { domain: '.example.com', path: '/', secure: true },
    ],
  ])('excludes %s from browser storage results', (_name, url, cookie) => {
    const target = resolveGetCookieTarget(undefined, { url, name: 'feature_flag' });
    expect(
      selectReadableCookie(
        filterCookiesForUrl([{ name: 'feature_flag', value: '1', ...cookie }], target.cookieUrl),
        target,
      ),
    ).toBeUndefined();
  });

  it.each(['localhost', 'localhost.', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]'])(
    'allows Secure cookies for HTTP loopback host %s',
    host => {
      const cookies = [{ name: 'feature_flag', value: '1', domain: host, path: '/', secure: true }];
      expect(filterCookiesForUrl(cookies, `http://${host}/`)).toEqual(cookies);
    },
  );

  it.each(['localhost.example.org', 'localhost.com', '128.0.0.1', '192.168.1.1'])(
    'excludes Secure cookies for untrusted HTTP host %s',
    host => {
      const cookies = [{ name: 'feature_flag', value: '1', domain: host, path: '/', secure: true }];
      expect(filterCookiesForUrl(cookies, `http://${host}/`)).toEqual([]);
    },
  );

  it('ignores partitioned cookies and selects the most specific path', () => {
    const target = resolveGetCookieTarget('https://m.example.com/app/page', {
      name: 'feature_flag',
    });
    const cookies = [
      {
        name: 'feature_flag',
        value: 'partitioned',
        domain: 'm.example.com',
        path: '/app',
        partitionKey: { topLevelSite: 'https://example.com' },
      },
      {
        name: 'feature_flag',
        value: 'opaque-partitioned',
        domain: 'm.example.com',
        path: '/app',
        partitionKeyOpaque: true,
      },
      {
        name: 'feature_flag',
        value: 'root',
        domain: '.example.com',
        path: '/',
      },
      {
        name: 'feature_flag',
        value: 'app',
        domain: 'm.example.com',
        path: '/app',
      },
    ];

    expect(selectReadableCookie(cookies, target)?.value).toBe('app');
  });

  it('applies exact domain and path filters', () => {
    const target = resolveGetCookieTarget('https://m.example.com/app/page', {
      name: 'feature_flag',
      domain: 'example.com',
      path: '/',
    });
    const cookies = [
      {
        name: 'feature_flag',
        value: 'host',
        domain: 'm.example.com',
        path: '/',
      },
      {
        name: 'feature_flag',
        value: 'parent',
        domain: '.example.com',
        path: '/',
      },
    ];

    expect(selectReadableCookie(cookies, target)?.value).toBe('parent');
  });

  it('rejects HttpOnly cookies', () => {
    const target = resolveGetCookieTarget('https://m.example.com/', {
      name: 'session_token',
    });

    expect(() =>
      selectReadableCookie(
        [
          {
            name: 'session_token',
            value: 'secret',
            domain: 'm.example.com',
            path: '/',
            httpOnly: true,
          },
        ],
        target,
      ),
    ).toThrow('is HttpOnly and cannot be read');
  });
});
