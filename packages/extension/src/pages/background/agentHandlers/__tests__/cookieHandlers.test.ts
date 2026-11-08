import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetCookie, handleSetCookie } from '../cookieHandlers';

const mockChrome = {
  cookies: {
    getAllCookieStores: vi.fn(),
    getAll: vi.fn(),
    set: vi.fn(),
  },
  tabs: {
    get: vi.fn(),
    reload: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
};

global.chrome = mockChrome as unknown as typeof chrome;

describe('handleSetCookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChrome.cookies.getAllCookieStores.mockResolvedValue([
      { id: '0', tabIds: [42], incognito: false },
    ]);
    mockChrome.tabs.get.mockResolvedValue({
      id: 42,
      url: 'https://outreaders.m.shop.com/app/trip/rx-vehicle-search/pages/home',
    });
    mockChrome.tabs.reload.mockResolvedValue(undefined);
    mockChrome.cookies.getAll.mockResolvedValue([]);
    mockChrome.cookies.set.mockResolvedValue({
      name: 'edith_switch_br.rx-vehicle-search_home',
      value: '3.6.63',
    });
  });

  it('reads only the explicitly named cookie for verification', async () => {
    mockChrome.cookies.getAll.mockResolvedValue([
      {
        name: 'edith_switch_br.rx-vehicle-search_home',
        value: '3.6.63',
        domain: '.shop.com',
        path: '/',
      },
    ]);

    await expect(
      handleGetCookie({
        tabId: 42,
        name: 'edith_switch_br.rx-vehicle-search_home',
        domain: 'shop.com',
      }),
    ).resolves.toEqual({
      tabId: 42,
      url: 'https://outreaders.m.shop.com/app/trip/rx-vehicle-search/pages/home',
      name: 'edith_switch_br.rx-vehicle-search_home',
      found: true,
      value: '3.6.63',
      domain: '.shop.com',
      path: '/',
    });
    expect(mockChrome.cookies.getAll).toHaveBeenCalledWith({
      url: 'https://outreaders.m.shop.com/app/trip/rx-vehicle-search/pages/home',
      name: 'edith_switch_br.rx-vehicle-search_home',
      storeId: '0',
    });
  });

  it('reads by URL from the default store without any tab lookup', async () => {
    await expect(
      handleGetCookie({ url: 'https://www.shop.com/', name: 'account_name' }),
    ).resolves.toEqual({ url: 'https://www.shop.com/', name: 'account_name', found: false });
    expect(mockChrome.cookies.getAll).toHaveBeenCalledExactlyOnceWith({
      url: 'https://www.shop.com/',
      name: 'account_name',
    });
    expect(mockChrome.tabs.get).not.toHaveBeenCalled();
    expect(mockChrome.cookies.getAllCookieStores).not.toHaveBeenCalled();
  });

  it('sets by URL without depending on any tab', async () => {
    mockChrome.cookies.set.mockResolvedValue({ name: 'feature_flag', value: '1' });
    await expect(
      handleSetCookie({ url: 'https://www.shop.com/', name: 'feature_flag', value: '1' }),
    ).resolves.toEqual({
      url: 'https://www.shop.com/',
      name: 'feature_flag',
      domain: 'www.shop.com',
      path: '/',
      reloaded: false,
    });
    expect(mockChrome.cookies.set).toHaveBeenCalledExactlyOnceWith({
      url: 'https://www.shop.com/',
      name: 'feature_flag',
      value: '1',
      path: '/',
      secure: true,
    });
    expect(mockChrome.tabs.get).not.toHaveBeenCalled();
    expect(mockChrome.cookies.getAllCookieStores).not.toHaveBeenCalled();
    expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('uses the explicitly selected tab store even with a different target URL', async () => {
    mockChrome.cookies.getAllCookieStores.mockResolvedValue([{ id: '1', tabIds: [42] }]);
    mockChrome.cookies.set.mockResolvedValue({ name: 'feature_flag', value: '1' });
    await handleSetCookie({
      tabId: 42,
      url: 'https://example.com/',
      name: 'feature_flag',
      value: '1',
    });
    expect(mockChrome.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/', storeId: '1' }),
    );
    await handleGetCookie({ tabId: 42, url: 'https://example.com/', name: 'feature_flag' });
    expect(mockChrome.cookies.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/', storeId: '1' }),
    );
  });

  it('rejects a reload without tabId before writing', async () => {
    await expect(
      handleSetCookie({
        url: 'https://www.shop.com/',
        name: 'feature_flag',
        value: '1',
        reload: true,
      }),
    ).rejects.toThrow('reload requires tabId');
    expect(mockChrome.cookies.set).not.toHaveBeenCalled();
  });

  it('does not fall back to the default store when the selected tab store is missing', async () => {
    mockChrome.cookies.getAllCookieStores.mockResolvedValue([]);
    await expect(handleGetCookie({ tabId: 42, name: 'account_name' })).rejects.toThrow(
      'Cookie store not found',
    );
    expect(mockChrome.cookies.getAll).not.toHaveBeenCalled();
  });

  it('reports a missing named cookie without exposing other cookies', async () => {
    await expect(handleGetCookie({ tabId: 42, name: 'missing_cookie' })).resolves.toEqual({
      tabId: 42,
      url: 'https://outreaders.m.shop.com/app/trip/rx-vehicle-search/pages/home',
      name: 'missing_cookie',
      found: false,
    });
  });

  it('reads a named cookie for an explicit URL from the selected browser store', async () => {
    mockChrome.tabs.get.mockResolvedValue({ id: 42, url: 'https://example.com/debug' });
    mockChrome.cookies.getAll.mockResolvedValue([
      {
        name: 'account_name',
        value: 'test-user',
        domain: '.shop.com',
        path: '/',
      },
    ]);

    await expect(
      handleGetCookie({
        tabId: 42,
        name: 'account_name',
        url: 'https://www.shop.com/',
        domain: 'shop.com',
        path: '/',
      }),
    ).resolves.toMatchObject({
      tabId: 42,
      url: 'https://www.shop.com/',
      name: 'account_name',
      found: true,
      value: 'test-user',
    });
    expect(mockChrome.cookies.getAll).toHaveBeenCalledWith({
      url: 'https://www.shop.com/',
      name: 'account_name',
      storeId: '0',
    });
  });

  it('rejects HttpOnly cookies without returning their value', async () => {
    mockChrome.cookies.getAll.mockResolvedValue([
      {
        name: 'session_token',
        value: 'secret',
        domain: '.shop.com',
        path: '/',
        httpOnly: true,
      },
    ]);

    await expect(handleGetCookie({ tabId: 42, name: 'session_token' })).rejects.toThrow(
      'is HttpOnly and cannot be read',
    );
  });

  it('sets only the named cookie in the tab cookie store', async () => {
    await expect(
      handleSetCookie({
        tabId: 42,
        name: 'edith_switch_br.rx-vehicle-search_home',
        value: '3.6.63',
        domain: 'shop.com',
      }),
    ).resolves.toEqual({
      tabId: 42,
      url: 'https://outreaders.m.shop.com/app/trip/rx-vehicle-search/pages/home',
      name: 'edith_switch_br.rx-vehicle-search_home',
      domain: 'shop.com',
      path: '/',
      reloaded: false,
    });
    expect(mockChrome.cookies.set).toHaveBeenCalledWith({
      url: 'https://outreaders.m.shop.com/',
      name: 'edith_switch_br.rx-vehicle-search_home',
      value: '3.6.63',
      domain: '.shop.com',
      path: '/',
      secure: true,
      storeId: '0',
    });
    expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('rejects an unrelated explicit domain before writing', async () => {
    await expect(
      handleSetCookie({ tabId: 42, name: 'feature_flag', value: '1', domain: 'reader.com' }),
    ).rejects.toThrow('is not a parent domain');
    expect(mockChrome.cookies.set).not.toHaveBeenCalled();
  });

  it('reloads the tab only when explicitly requested', async () => {
    mockChrome.cookies.set.mockResolvedValue({ name: 'feature_flag', value: '1' });
    mockChrome.tabs.onUpdated.addListener.mockImplementation(listener => {
      queueMicrotask(() => listener(42, { status: 'complete' }));
    });

    await expect(
      handleSetCookie({ tabId: 42, name: 'feature_flag', value: '1', reload: true }),
    ).resolves.toMatchObject({ reloaded: true });
    expect(mockChrome.tabs.reload).toHaveBeenCalledWith(42);
    expect(mockChrome.tabs.onUpdated.removeListener).toHaveBeenCalled();
  });
});
