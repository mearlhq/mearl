import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCookieHeader,
  collectCookies,
  buildDnrHeaders,
  cleanupTempDnrRule,
  fetchWithDnr,
  setupTempHeaderInjection,
} from '../dnr';

describe('proxy cookie scope', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([120, 130])('queries the full URL and its first-party partition on Chrome %s', async version => {
    vi.stubGlobal('navigator', { userAgent: `Chrome/${version}.0.0.0` });
    const cookie = { name: 'session', value: 'root', domain: '.example.com', path: '/' };
    const getAll = vi
      .fn()
      .mockResolvedValueOnce([
        cookie,
        { ...cookie, value: 'scoped', path: '/api' },
        { ...cookie, value: 'parent', domain: 'example.com', hostOnly: true },
        { ...cookie, value: 'partition', partitionKey: { topLevelSite: 'https://example.com' } },
      ])
      .mockResolvedValueOnce([
        {
          ...cookie,
          value: 'chips',
          httpOnly: true,
          partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: false },
        },
      ]);
    vi.stubGlobal('chrome', {
      cookies: { getAll },
      declarativeNetRequest: { HeaderOperation: { SET: 'set', REMOVE: 'remove' } },
    });
    const url = new URL('https://app.example.com/api/refresh');
    const cookies = await collectCookies(url);
    expect(getAll).toHaveBeenCalledTimes(2);
    expect(getAll).toHaveBeenNthCalledWith(1, { url: url.href });
    expect(getAll).toHaveBeenNthCalledWith(2, {
      url: url.href,
      partitionKey: {
        topLevelSite: 'https://app.example.com',
        ...(version === 130 ? { hasCrossSiteAncestor: false } : {}),
      },
    });
    expect(buildDnrHeaders(url, cookies)).toContainEqual({
      header: 'Cookie',
      operation: 'set',
      value: 'session=scoped; session=root; session=chips',
    });
    expect(buildDnrHeaders(url, [])).toContainEqual({ header: 'Cookie', operation: 'remove' });
  });
});

describe('temporary DNR header rules', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes leftover rules before concurrent requests install session rules', async () => {
    const getDynamicRules = vi
      .fn()
      .mockResolvedValue([{ id: 800001 }, { id: 905030 }, { id: 905031 }, { id: 999999 }]);
    const getSessionRules = vi.fn().mockResolvedValue([{ id: 905032 }, { id: 999861 }]);
    const updateDynamicRules = vi.fn().mockResolvedValue(undefined);
    const updateSessionRules = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension-id' },
      declarativeNetRequest: {
        getDynamicRules,
        getSessionRules,
        updateDynamicRules,
        updateSessionRules,
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
        HeaderOperation: { SET: 'set' },
      },
    });
    const url = new URL('https://api.example.test/system/userinfo');
    const headers: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
      {
        header: 'Cookie',
        operation: chrome.declarativeNetRequest.HeaderOperation.SET,
        value: 'session=current',
      },
    ];

    const ids = await Promise.all([
      setupTempHeaderInjection(url, [...headers]),
      setupTempHeaderInjection(url, [...headers]),
    ]);

    expect(getDynamicRules).toHaveBeenCalledOnce();
    expect(getSessionRules).toHaveBeenCalledOnce();
    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [905030, 905031],
    });
    expect(updateSessionRules).toHaveBeenNthCalledWith(1, { removeRuleIds: [905032] });
    expect(ids).toEqual([900000, 900001]);
    expect(updateSessionRules).toHaveBeenCalledTimes(3);
    for (const call of updateSessionRules.mock.calls.slice(1)) {
      expect(call[0].addRules[0]).toMatchObject({
        action: { requestHeaders: headers },
        condition: {
          regexFilter: '^https://api\\.example\\.test/system/userinfo$',
          isUrlFilterCaseSensitive: true,
          initiatorDomains: ['extension-id'],
        },
      });
    }
    await Promise.all(ids.map(cleanupTempDnrRule));
  });

  it('matches literal URL characters and excludes fragments and redirect destinations', async () => {
    const updateSessionRules = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension-id' },
      declarativeNetRequest: {
        updateSessionRules,
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
      },
    });
    const url = new URL('https://example.com/api/Refresh?q=a*b+c#fragment');
    const id = await setupTempHeaderInjection(url, []);
    const condition = updateSessionRules.mock.calls[0][0].addRules[0].condition;
    const matches = new RegExp(condition.regexFilter);
    expect(condition.isUrlFilterCaseSensitive).toBe(true);
    expect(matches.test('https://example.com/api/Refresh?q=a*b+c')).toBe(true);
    expect(matches.test('https://example.com/api/refresh?q=a*b+c')).toBe(false);
    expect(matches.test('https://example.com/api/Refresh?q=abbbc')).toBe(false);
    expect(matches.test('https://example.com/public/echo')).toBe(false);
    await cleanupTempDnrRule(id);
  });

  it('keeps same-origin headers separate while permitting other origins in parallel', async () => {
    let firstRuleId: number | undefined;
    let finishCleanup: (() => void) | undefined;
    const updateSessionRules = vi.fn(
      async (data: {
        addRules?: chrome.declarativeNetRequest.Rule[];
        removeRuleIds?: number[];
      }) => {
        if (firstRuleId === undefined && data.addRules) firstRuleId = data.addRules[0].id;
        if (!data.addRules && data.removeRuleIds?.includes(firstRuleId!)) {
          await new Promise<void>(resolve => {
            finishCleanup = resolve;
          });
        }
      },
    );
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension-id' },
      declarativeNetRequest: {
        getDynamicRules: vi.fn().mockResolvedValue([]),
        getSessionRules: vi.fn().mockResolvedValue([]),
        updateSessionRules,
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
        HeaderOperation: { SET: 'set' },
      },
    });
    const url = new URL('https://example.com/api/first');
    let finish!: () => void;
    const fetchFirst = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const first = fetchWithDnr(
      url,
      [
        {
          header: 'Origin',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: 'https://first.example',
        },
      ],
      fetchFirst,
    );
    await vi.waitFor(() => expect(fetchFirst).toHaveBeenCalledOnce());
    const fetchSecond = vi.fn(async () => 'second');
    const second = fetchWithDnr(
      new URL('https://example.com/api/second'),
      [
        {
          header: 'Origin',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: 'https://second.example',
        },
      ],
      fetchSecond,
    );
    try {
      await expect(
        fetchWithDnr(new URL('https://other.example/api'), [], async () => 'other'),
      ).resolves.toBe('other');
      expect(fetchSecond).not.toHaveBeenCalled();
      expect(updateSessionRules.mock.calls.filter(([data]) => data.addRules)).toHaveLength(2);
      finish();
      await vi.waitFor(() => expect(finishCleanup).toBeTypeOf('function'));
      expect(fetchSecond).not.toHaveBeenCalled();
    } finally {
      finish();
      finishCleanup?.();
      await first;
      await second;
    }
    expect(fetchSecond).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'cleanup'])('unblocks queued requests after %s fails', async failure => {
    let cleanupFailed = false;
    const updateSessionRules = vi.fn(async (data: { addRules?: unknown }) => {
      if (failure === 'cleanup' && !data.addRules && !cleanupFailed) {
        cleanupFailed = true;
        throw new Error('cleanup failed');
      }
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension-id' },
      declarativeNetRequest: {
        getDynamicRules: vi.fn().mockResolvedValue([]),
        getSessionRules: vi.fn().mockResolvedValue([]),
        updateSessionRules,
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
      },
    });
    const url = new URL('https://example.com/api');
    const failed = fetchWithDnr(url, [], async () => {
      if (failure === 'fetch') throw new Error('fetch failed');
      return 'first';
    });
    const outcome =
      failure === 'fetch'
        ? expect(failed).rejects.toThrow('fetch failed')
        : expect(failed).resolves.toBe('first');
    const next = fetchWithDnr(url, [], async () => 'next');
    await outcome;
    await expect(next).resolves.toBe('next');
  });

  it('keeps fallback requests isolated when header installation fails', async () => {
    const updateSessionRules = vi
      .fn()
      .mockRejectedValueOnce(new Error('DNR unavailable'))
      .mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension-id' },
      declarativeNetRequest: {
        getDynamicRules: vi.fn().mockResolvedValue([]),
        getSessionRules: vi.fn().mockResolvedValue([]),
        updateSessionRules,
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
      },
    });
    const url = new URL('https://example.com/api');
    let finish!: () => void;
    const fetchFallback = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const fallback = fetchWithDnr(url, [], fetchFallback);
    await vi.waitFor(() => expect(fetchFallback).toHaveBeenCalledOnce());
    const fetchNext = vi.fn(async () => 'next');
    const next = fetchWithDnr(url, [], fetchNext);
    try {
      await fetchWithDnr(new URL('https://other.example/api'), [], async () => {});
      expect(fetchNext).not.toHaveBeenCalled();
      expect(updateSessionRules.mock.calls.filter(([data]) => data.addRules)).toHaveLength(2);
    } finally {
      finish();
      await fallback;
      await next;
    }
    expect(fetchNext).toHaveBeenCalledOnce();
  });
});

it.each([{ cookies: [{ name: 'csrfToken', value: 'owned%2Fcsrf' }] }, { cookies: [] }])(
  'builds a Cookie header from the accepted collection without querying again',
  async ({ cookies: collected }) => {
    const getAll = vi.fn();
    vi.stubGlobal('chrome', {
      cookies: { getAll },
      declarativeNetRequest: { HeaderOperation: { SET: 'set' } },
    });
    const value = await buildCookieHeader(new URL('https://example.com/'), collected);
    expect(value).toEqual(
      collected.length
        ? { header: 'Cookie', operation: 'set', value: 'csrfToken=owned%2Fcsrf' }
        : null,
    );
    expect(getAll).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  },
);
