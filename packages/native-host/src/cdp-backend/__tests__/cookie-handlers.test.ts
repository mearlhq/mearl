import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpSession, PageSession } from '../cdp-session.js';
import { cdpGetCookie, cdpSetCookie } from '../cookie-handlers.js';
import { dispatchCdpAction } from '../action-registry.js';
import { ensureControlledIndicator } from '../controlled-indicator.js';

vi.mock('../controlled-indicator.js', () => ({ ensureControlledIndicator: vi.fn() }));

function createSession(
  sendCommand: ReturnType<typeof vi.fn>,
  on = vi.fn(() => () => {}),
): PageSession {
  return {
    client: {
      sendCommand,
      on,
    },
  } as unknown as PageSession;
}

function createBrowserSession(sendCommand: ReturnType<typeof vi.fn>) {
  const session = {
    getBrowserClient: vi.fn(async () => ({ sendCommand })),
    getPageSession: vi.fn(async () => createSession(sendCommand)),
  };
  return { session: session as unknown as CdpSession, getPageSession: session.getPageSession };
}

describe('browser-scoped cookie dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('reads a URL from the default context without resolving a page', async () => {
    const sendCommand = vi.fn().mockResolvedValue({
      cookies: [
        { name: 'account_name', value: 'wrong-domain', domain: '.example.com', path: '/' },
        { name: 'account_name', value: 'wrong-path', domain: '.shop.com', path: '/other' },
        { name: 'account_name', value: 'test-user', domain: '.shop.com', path: '/' },
      ],
    });
    const { session, getPageSession } = createBrowserSession(sendCommand);
    await expect(
      dispatchCdpAction(session, 'get_cookie', {
        url: 'https://www.shop.com/',
        name: 'account_name',
      }),
    ).resolves.toEqual({
      url: 'https://www.shop.com/',
      name: 'account_name',
      found: true,
      value: 'test-user',
      domain: '.shop.com',
      path: '/',
    });
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith('Storage.getCookies', {});
    expect(getPageSession).not.toHaveBeenCalled();
  });

  it('writes one session cookie to the default context without a page', async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    const { session, getPageSession } = createBrowserSession(sendCommand);
    await expect(
      dispatchCdpAction(session, 'set_cookie', {
        url: 'https://www.shop.com/',
        name: 'feature_flag',
        value: '1',
      }),
    ).resolves.toEqual({
      url: 'https://www.shop.com/',
      name: 'feature_flag',
      domain: 'www.shop.com',
      path: '/',
      reloaded: false,
    });
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith('Storage.setCookies', {
      cookies: [
        {
          url: 'https://www.shop.com/',
          name: 'feature_flag',
          value: '1',
          path: '/',
          secure: true,
        },
      ],
    });
    expect(getPageSession).not.toHaveBeenCalled();
  });

  it('keeps HTTP localhost Secure cookies visible in browser storage queries', async () => {
    const sendCommand = vi.fn().mockResolvedValue({
      cookies: [
        {
          name: 'feature_flag',
          value: '1',
          domain: 'localhost',
          path: '/',
          secure: true,
        },
      ],
    });
    const { session } = createBrowserSession(sendCommand);
    await expect(
      dispatchCdpAction(session, 'get_cookie', { url: 'http://localhost/', name: 'feature_flag' }),
    ).resolves.toMatchObject({ found: true, value: '1' });
  });

  it('marks the selected page when a cookie write requests reload', async () => {
    let loadListener: (() => void) | undefined;
    const sendCommand = vi.fn(async method => {
      if (method === 'Page.reload') queueMicrotask(() => loadListener?.());
      return { success: true };
    });
    const on = vi.fn((_event: string, listener: () => void) => {
      loadListener = listener;
      return () => {};
    });
    const { session, getPageSession } = createBrowserSession(sendCommand);
    getPageSession.mockResolvedValue(createSession(sendCommand, on));
    await expect(
      dispatchCdpAction(
        session,
        'set_cookie',
        {
          tabId: 1001,
          url: 'https://www.shop.com/',
          name: 'feature_flag',
          value: '1',
          reload: true,
        },
        'remote',
      ),
    ).resolves.toMatchObject({ reloaded: true });
    expect(ensureControlledIndicator).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 'remote');
    expect(sendCommand).toHaveBeenLastCalledWith('Page.reload');
  });

  it.each(['get_cookie', 'set_cookie'])('keeps %s in the selected tab context', async action => {
    const sendCommand = vi.fn().mockResolvedValue({ cookies: [], success: true });
    const { session, getPageSession } = createBrowserSession(sendCommand);
    await dispatchCdpAction(
      session,
      action,
      { tabId: 1001, url: 'https://www.shop.com/', name: 'feature_flag', value: '1' },
      'remote',
    );
    expect(getPageSession).toHaveBeenCalledExactlyOnceWith(1001);
    expect(ensureControlledIndicator).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(
      action === 'get_cookie' ? 'Network.getCookies' : 'Network.setCookie',
      expect.any(Object),
    );
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Storage.'))).toBe(false);
  });

  it('rejects reload without an explicit tab before writing', async () => {
    const sendCommand = vi.fn();
    const { session, getPageSession } = createBrowserSession(sendCommand);
    await expect(
      dispatchCdpAction(session, 'set_cookie', {
        url: 'https://www.shop.com/',
        name: 'feature_flag',
        value: '1',
        reload: true,
      }),
    ).rejects.toThrow('reload requires tabId');
    expect(sendCommand).not.toHaveBeenCalled();
    expect(getPageSession).not.toHaveBeenCalled();
  });
});

describe('cdpSetCookie', () => {
  it('sets only the requested cookie', async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: 'https://market.wapa.shop.com/app/trip/rx-traffic-search/pages/index',
        },
      })
      .mockResolvedValueOnce({ success: true });

    await expect(
      cdpSetCookie(createSession(sendCommand), {
        tabId: 1001,
        name: 'edith_switch_br.rx-traffic-search_index',
        value: '1.5.37',
        domain: 'shop.com',
      }),
    ).resolves.toEqual({
      tabId: 1001,
      url: 'https://market.wapa.shop.com/app/trip/rx-traffic-search/pages/index',
      name: 'edith_switch_br.rx-traffic-search_index',
      domain: 'shop.com',
      path: '/',
      reloaded: false,
    });
    expect(sendCommand).toHaveBeenNthCalledWith(2, 'Network.setCookie', {
      name: 'edith_switch_br.rx-traffic-search_index',
      value: '1.5.37',
      url: 'https://market.wapa.shop.com/',
      domain: '.shop.com',
      path: '/',
      secure: true,
    });
  });

  it('rejects an unrelated explicit domain before writing', async () => {
    const sendCommand = vi.fn().mockResolvedValueOnce({
      result: {
        value: 'https://m.shop.com/app/trip/rx-vehicle-search/pages/home',
      },
    });

    await expect(
      cdpSetCookie(createSession(sendCommand), {
        name: 'feature_flag',
        value: '1',
        domain: 'reader.com',
      }),
    ).rejects.toThrow('is not a parent domain');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('reloads only when explicitly requested', async () => {
    let loadListener: (() => void) | undefined;
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: 'https://m.shop.com/app/trip/rx-vehicle-search/pages/home',
        },
      })
      .mockResolvedValueOnce({ success: true })
      .mockImplementationOnce(async () => {
        queueMicrotask(() => loadListener?.());
        return {};
      });
    const on = vi.fn((_event: string, listener: () => void) => {
      loadListener = listener;
      return () => {};
    });

    await expect(
      cdpSetCookie(createSession(sendCommand, on), {
        name: 'feature_flag',
        value: '1',
        reload: true,
      }),
    ).resolves.toMatchObject({ reloaded: true });
    expect(sendCommand).toHaveBeenNthCalledWith(3, 'Page.reload');
    expect(on).toHaveBeenCalledWith('Page.loadEventFired', expect.any(Function));
  });
});

describe('cdpGetCookie', () => {
  it('returns only the explicitly named cookie', async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: 'https://market.wapa.shop.com/app/trip/rx-traffic-search/pages/index',
        },
      })
      .mockResolvedValueOnce({
        cookies: [
          {
            name: 'other_cookie',
            value: 'secret',
            domain: '.shop.com',
            path: '/',
          },
          {
            name: 'edith_switch_br.rx-traffic-search_index',
            value: 'partitioned-secret',
            domain: '.shop.com',
            path: '/app',
            partitionKey: { topLevelSite: 'https://shop.com' },
          },
          {
            name: 'edith_switch_br.rx-traffic-search_index',
            value: 'opaque-partitioned-secret',
            domain: '.shop.com',
            path: '/app',
            partitionKeyOpaque: true,
          },
          {
            name: 'edith_switch_br.rx-traffic-search_index',
            value: '1.5.37',
            domain: '.shop.com',
            path: '/',
          },
        ],
      });

    await expect(
      cdpGetCookie(createSession(sendCommand), {
        tabId: 1001,
        name: 'edith_switch_br.rx-traffic-search_index',
        domain: 'shop.com',
      }),
    ).resolves.toEqual({
      tabId: 1001,
      url: 'https://market.wapa.shop.com/app/trip/rx-traffic-search/pages/index',
      name: 'edith_switch_br.rx-traffic-search_index',
      found: true,
      value: '1.5.37',
      domain: '.shop.com',
      path: '/',
    });
    expect(sendCommand).toHaveBeenNthCalledWith(2, 'Network.getCookies', {
      urls: ['https://market.wapa.shop.com/app/trip/rx-traffic-search/pages/index'],
    });
  });

  it('returns found false when the named cookie is absent', async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: 'https://m.shop.com/app/trip/rx-vehicle-search/pages/home',
        },
      })
      .mockResolvedValueOnce({ cookies: [] });

    await expect(
      cdpGetCookie(createSession(sendCommand), { name: 'missing_cookie' }),
    ).resolves.toEqual({
      url: 'https://m.shop.com/app/trip/rx-vehicle-search/pages/home',
      name: 'missing_cookie',
      found: false,
    });
  });

  it('reads a named cookie for an explicit URL without navigating the page', async () => {
    const sendCommand = vi.fn().mockResolvedValueOnce({
      cookies: [{ name: 'account_name', value: 'test-user', domain: '.shop.com', path: '/' }],
    });

    await expect(
      cdpGetCookie(createSession(sendCommand), {
        name: 'account_name',
        url: 'https://www.shop.com/',
        domain: 'shop.com',
        path: '/',
      }),
    ).resolves.toMatchObject({
      url: 'https://www.shop.com/',
      name: 'account_name',
      found: true,
      value: 'test-user',
    });
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith('Network.getCookies', {
      urls: ['https://www.shop.com/'],
    });
  });

  it('rejects HttpOnly cookies without returning their value', async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          value: 'https://m.shop.com/app/trip/rx-vehicle-search/pages/home',
        },
      })
      .mockResolvedValueOnce({
        cookies: [
          {
            name: 'session_token',
            value: 'secret',
            domain: '.shop.com',
            path: '/',
            httpOnly: true,
          },
        ],
      });

    await expect(
      cdpGetCookie(createSession(sendCommand), { name: 'session_token' }),
    ).rejects.toThrow('is HttpOnly and cannot be read');
  });
});
