import { describe, expect, it } from 'vitest';
import { serializeRequestCookies, requestCookiesToMap } from '@mearl/browser-core';
import { getRequestCookiePartition, selectRequestCookies } from '../request-cookies.js';

describe('proxy request cookies', () => {
  it.each([
    ['https://app.example.com:8443/api', 'https://example.com'],
    ['https://api.example.co.uk/api', 'https://example.co.uk'],
    ['https://tenant.github.io/api', 'https://tenant.github.io'],
    ['https://other.github.io/api', 'https://other.github.io'],
    ['https://api.tenant.github.io/api', 'https://tenant.github.io'],
    ['https://api.city.kawasaki.jp/api', 'https://city.kawasaki.jp'],
    ['https://a.b.ck/api', 'https://a.b.ck'],
    ['http://api.app.test/api', 'http://app.test'],
    ['http://localhost:8080/api', 'http://localhost'],
    ['http://127.0.0.1:8080/api', 'http://127.0.0.1'],
    ['http://[::1]:8080/api', 'http://[::1]'],
  ])('uses the schemeful first-party site for %s', (url, topLevelSite) => {
    expect(getRequestCookiePartition(url)).toEqual({ topLevelSite, hasCrossSiteAncestor: false });
  });

  it('preserves same-name cookies by path and excludes unrelated hosts, paths and partitions', () => {
    const cookie = { name: 'session', value: 'root', domain: '.example.com', path: '/' };
    const selected = selectRequestCookies(
      [
        cookie,
        { ...cookie, value: 'api', path: '/api' },
        { ...cookie, value: 'other-path', path: '/api2' },
        { ...cookie, value: 'parent-host-only', domain: 'example.com', hostOnly: true },
        { ...cookie, value: 'partitioned', partitionKey: { topLevelSite: 'https://example.com' } },
        { ...cookie, value: 'opaque', partitionKeyOpaque: true },
      ],
      'https://app.example.com/api/refresh',
    );
    expect(serializeRequestCookies(selected)).toBe(
      'session=api; session=root; session=partitioned',
    );
    expect(requestCookiesToMap(selected).get('session')).toBe('api');
  });

  it('isolates partition sites, schemes and ancestor contexts while retaining HttpOnly and path order', () => {
    const cookie = { name: 'session', value: 'global', domain: '.example.com', path: '/' };
    const key = { topLevelSite: 'https://example.com', hasCrossSiteAncestor: false };
    const selected = selectRequestCookies(
      [
        cookie,
        { ...cookie, value: 'chips', path: '/api', httpOnly: true, partitionKey: key },
        {
          ...cookie,
          value: 'other-site',
          partitionKey: { ...key, topLevelSite: 'https://other.com' },
        },
        {
          ...cookie,
          value: 'http-site',
          partitionKey: { ...key, topLevelSite: 'http://example.com' },
        },
        { ...cookie, value: 'embedded', partitionKey: { ...key, hasCrossSiteAncestor: true } },
        { ...cookie, value: 'opaque', partitionKey: key, partitionKeyOpaque: true },
        { ...cookie, value: 'wrong-path', path: '/private', partitionKey: key },
        { ...cookie, value: 'host-only', domain: 'example.com', hostOnly: true, partitionKey: key },
      ],
      'https://app.example.com/api/open',
    );
    expect(serializeRequestCookies(selected)).toBe('session=chips; session=global');
  });
});
