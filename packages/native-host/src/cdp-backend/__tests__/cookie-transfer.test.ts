const hook = vi.hoisted(() => vi.fn());
vi.mock('../../native-capability-services.js', () => ({
  nativeCapabilities: { require: () => hook },
}));
import { describe, expect, it, vi } from 'vitest';
import { cdpImportCookiesWithClient } from '../cookie-transfer.js';
import {
  cookieMatchesDomain,
  normalizeCookieDomain,
  normalizeCookieDomains,
  resolveCookieCopyPlan,
} from '../../browser-cookie-copy.js';

describe('cookie transfer domain handling', () => {
  it('normalizes hostnames and URLs', () => {
    expect(normalizeCookieDomain('.Example.COM')).toBe('example.com');
    expect(normalizeCookieDomain('https://Sub.Example.com/path')).toBe('sub.example.com');
    expect(normalizeCookieDomains(['example.com', 'https://example.com/a'])).toEqual([
      'example.com',
    ]);
  });

  it('rejects empty and malformed domains', () => {
    expect(() => normalizeCookieDomain('')).toThrow('non-empty');
    expect(() => normalizeCookieDomain('https://')).toThrow('Invalid cookie domain');
    expect(() => normalizeCookieDomains('example.com')).toThrow('must be an array');
  });

  it('matches parent, exact, and child cookie domains', () => {
    expect(cookieMatchesDomain('.example.com', 'example.com')).toBe(true);
    expect(cookieMatchesDomain('login.example.com', 'example.com')).toBe(true);
    expect(cookieMatchesDomain('example.com', 'login.example.com')).toBe(true);
    expect(cookieMatchesDomain('notexample.com', 'example.com')).toBe(false);
  });

  it('keeps explicit domain copy behavior unchanged', () => {
    const plan = resolveCookieCopyPlan(['https://Example.com/path', 'example.com']);
    const cookies = [{ name: 'session', value: 'secret', domain: '.example.com', path: '/' }];

    expect(plan.domains).toEqual(['example.com']);
    expect(plan.select(cookies)).toBe(cookies);
  });

  it('delegates named scopes to the installed capability without embedding its domains', () => {
    const plan = { domains: ['identity.example.com'], select: vi.fn() };
    hook.mockReturnValueOnce(plan);
    expect(resolveCookieCopyPlan('mearl-services')).toBe(plan);
    expect(hook).toHaveBeenLastCalledWith('mearl-services');
    const input = { presets: ['sample-session'], domains: ['site.example.com'] };
    hook.mockReturnValueOnce(plan);
    expect(resolveCookieCopyPlan(input)).toBe(plan);
    expect(hook).toHaveBeenLastCalledWith(input);
  });
  it('rejects malformed scope values before calling the capability', () => {
    expect(() => resolveCookieCopyPlan(null as never)).toThrow('copyCookieDomains');
    expect(() => resolveCookieCopyPlan(7 as never)).toThrow('copyCookieDomains');
    expect(() => resolveCookieCopyPlan({ presets: 1 } as never)).toThrow('presets');
  });

  it('imports transferable cookies through any browser-level CDP client', async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    const cookies = [{ name: 'session', value: 'secret', domain: '.example.com', path: '/' }];

    await expect(cdpImportCookiesWithClient({ sendCommand }, cookies)).resolves.toBe(1);
    expect(sendCommand).toHaveBeenCalledWith('Storage.setCookies', { cookies });
  });

  it('does not issue a CDP command for an empty cookie list', async () => {
    const sendCommand = vi.fn();

    await expect(cdpImportCookiesWithClient({ sendCommand }, [])).resolves.toBe(0);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
