import { describe, it, expect } from 'vitest';
import {
  normalizeDomainInputToOrigin,
  isOriginAllowedByDomain,
  isDomainAuthorized,
  getTopLevelDomain,
  ALLOWED_ORIGINS_LIST,
  actionRequiresDomainCheck,
  URL_PARAM_ACTIONS,
  DomainPermissionError,
} from '../proxyPermissions';

it('describes missing domain permission as an undispatched action', () => {
  const error = new DomainPermissionError('send_request', 'upload.example');
  expect(error).toBeInstanceOf(Error);
  expect(JSON.parse(JSON.stringify(error))).toMatchObject({
    code: 'DOMAIN_PERMISSION_REQUIRED',
    action: 'send_request',
    domain: 'upload.example',
    requestDispatched: false,
  });
  expect(error.message).toContain(
    `mearl request_permission --payload '{"domain":"upload.example"}'`,
  );
});

describe('normalizeDomainInputToOrigin', () => {
  it('wraps a normal domain in a wildcard-subdomain origin', () => {
    expect(normalizeDomainInputToOrigin('shop.com')).toBe('*://*.shop.com/*');
  });

  it('strips protocol, www, path and port before normalizing', () => {
    expect(normalizeDomainInputToOrigin('https://www.Reader.com/path?x=1')).toBe(
      '*://*.reader.com/*',
    );
  });

  it('accepts an already-formatted origin and re-normalizes it', () => {
    expect(normalizeDomainInputToOrigin('*://*.example.com/*')).toBe('*://*.example.com/*');
  });

  it('does not wildcard localhost', () => {
    expect(normalizeDomainInputToOrigin('localhost')).toBe('*://localhost/*');
  });

  it('does not wildcard IPv4 addresses', () => {
    expect(normalizeDomainInputToOrigin('127.0.0.1')).toBe('*://127.0.0.1/*');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['a b', 'inner whitespace'],
    ['foo#frag', 'fragment char'],
  ])('rejects invalid input (%o — %s) with null', input => {
    expect(normalizeDomainInputToOrigin(input)).toBeNull();
  });
});

describe('isOriginAllowedByDomain', () => {
  it('matches a subdomain against a wildcard origin', () => {
    expect(isOriginAllowedByDomain('*://*.shop.com/*', 'item.shop.com')).toBe(true);
  });

  it('matches the apex domain against a wildcard origin', () => {
    expect(isOriginAllowedByDomain('*://*.shop.com/*', 'shop.com')).toBe(true);
  });

  it('does not treat a suffix collision as a subdomain', () => {
    expect(isOriginAllowedByDomain('*://*.shop.com/*', 'notshop.com')).toBe(false);
    expect(isOriginAllowedByDomain('*://*.shop.com/*', 'shop.com.evil.com')).toBe(false);
  });

  it('matches an exact (non-wildcard) origin only for the exact host', () => {
    expect(isOriginAllowedByDomain('*://localhost/*', 'localhost')).toBe(true);
    expect(isOriginAllowedByDomain('*://localhost/*', 'sub.localhost')).toBe(false);
  });

  it('ignores protocol, port and www when normalizing the domain', () => {
    expect(isOriginAllowedByDomain('*://*.shop.com/*', 'https://www.item.shop.com:443')).toBe(true);
  });

  it('returns false for an empty domain', () => {
    expect(isOriginAllowedByDomain('*://*.shop.com/*', '')).toBe(false);
  });
});

describe('isDomainAuthorized', () => {
  it('authorizes domains covered by the built-in allowlist', () => {
    expect(ALLOWED_ORIGINS_LIST).toEqual(['*://localhost/*', '*://127.0.0.1/*']);
    expect(isDomainAuthorized('127.0.0.1', ALLOWED_ORIGINS_LIST)).toBe(true);
    expect(isDomainAuthorized('localhost', ALLOWED_ORIGINS_LIST)).toBe(true);
  });

  it('rejects domains outside the allowlist', () => {
    expect(isDomainAuthorized('example.com', ALLOWED_ORIGINS_LIST)).toBe(false);
    expect(isDomainAuthorized('item.shop.com', ALLOWED_ORIGINS_LIST)).toBe(false);
    expect(isDomainAuthorized('evil.com', ALLOWED_ORIGINS_LIST)).toBe(false);
    expect(isDomainAuthorized('shop.com.evil.com', ALLOWED_ORIGINS_LIST)).toBe(false);
  });
});

describe('getTopLevelDomain', () => {
  it('reduces a deep subdomain to its registrable domain', () => {
    expect(getTopLevelDomain('preview.example.com')).toBe('example.com');
    expect(getTopLevelDomain('a.b.c.shop.com')).toBe('shop.com');
  });

  it('keeps three labels for known second-level TLDs', () => {
    expect(getTopLevelDomain('shop.example.co.uk')).toBe('example.co.uk');
  });

  it('returns short hostnames unchanged', () => {
    expect(getTopLevelDomain('shop.com')).toBe('shop.com');
    expect(getTopLevelDomain('localhost')).toBe('localhost');
  });
});

describe('actionRequiresDomainCheck', () => {
  it('allows browser_release to relinquish control without page authorization', () => {
    expect(actionRequiresDomainCheck('browser_release')).toBe(false);
  });

  it('reloads the extension independently of the active page domain', () => {
    expect(actionRequiresDomainCheck('__extension_reload')).toBe(false);
    expect(actionRequiresDomainCheck('page_eval')).toBe(true);
    expect(actionRequiresDomainCheck('unknown_action')).toBe(true);
  });

  it('authorizes file transfers and requests against their target URL', () => {
    expect(actionRequiresDomainCheck('__send_request_files')).toBe(true);
    expect(URL_PARAM_ACTIONS.has('__send_request_files')).toBe(true);
    expect(actionRequiresDomainCheck('send_request')).toBe(true);
    expect(URL_PARAM_ACTIONS.has('send_request')).toBe(true);
  });
});
