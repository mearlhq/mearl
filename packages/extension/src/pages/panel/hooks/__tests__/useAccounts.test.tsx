import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAccounts } from '../useAccounts';
import {
  browserDomainPermissionError,
  browserHostPermissionError,
} from '../../../../shared/browserCapabilityPermissions';
const fixture = vi.hoisted(() => ({
  settings: {},
  fetch: vi.fn(),
  normalize: vi.fn(),
  permissions: vi.fn(),
}));
vi.mock('../../../../shared/presetPermissions', () => ({
  missingPresetPermissions: fixture.permissions,
}));
vi.mock('../../utils/browserUiSettings', () => ({ useBrowserUiSettings: () => fixture.settings }));
vi.mock('../../utils/i18n', () => ({ t: (key: string) => key }));
vi.mock('../useLocalStorage', async () => {
  const { useState } = await import('react');
  return { useLocalStorage: () => [...useState([]), true] };
});
vi.mock('../../utils/accounts', () => ({
  fetchAccounts: fixture.fetch,
  normalizeAccounts: fixture.normalize,
  withAccountAutoLogin: async (operation: () => unknown) => ({ result: await operation() }),
}));
beforeEach(() => {
  fixture.settings = {};
  fixture.permissions
    .mockReset()
    .mockResolvedValue({
      missingOrigins: ['https://accounts.example.test/*'],
      missingAuthorization: [],
    });
  chrome.permissions = { onAdded: { addListener: vi.fn(), removeListener: vi.fn() } } as any;
  vi.mocked(chrome.storage.onChanged.addListener).mockClear();
  fixture.fetch.mockReset();
  fixture.normalize
    .mockReset()
    .mockImplementation(async (accounts: unknown[]) => ({ success: true, data: accounts }));
  vi.mocked(chrome.runtime.sendMessage).mockReset();
});

it.each(['browser-first', 'authorization-first'])(
  'recovers after both permission layers are granted (%s)',
  async order => {
    const origin = 'https://accounts.example.test';
    fixture.settings = { logins: { accounts: { url: `${origin}/` } } };
    fixture.permissions.mockResolvedValue({
      missingOrigins: [origin],
      missingAuthorization: [origin],
    });
    fixture.fetch.mockResolvedValueOnce({
      success: false,
      error: browserHostPermissionError(new URL(origin)),
    });
    const { result } = renderHook(() => useAccounts());
    await act(async () => {
      await result.current.requestAccounts();
    });
    const onAdded = vi.mocked(chrome.permissions.onAdded.addListener).mock.calls[0][0];
    const onChanged = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0];
    fixture.permissions.mockResolvedValue({
      missingOrigins: order === 'browser-first' ? [] : [origin],
      missingAuthorization: order === 'browser-first' ? [origin] : [],
    });
    await act(async () => {
      if (order === 'browser-first') onAdded({ origins: [`${origin}/*`] });
      else onChanged({ proxyCookieAllowedOrigins: { newValue: [`${origin}/*`] } }, 'sync');
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    fixture.permissions.mockResolvedValue({ missingOrigins: [], missingAuthorization: [] });
    fixture.fetch.mockResolvedValue({
      success: true,
      data: { accountList: [{ id: 1, loginId: 'recovered' }] },
    });
    await act(async () => {
      if (order === 'browser-first')
        onChanged({ proxyCookieAllowedOrigins: { newValue: [`${origin}/*`] } }, 'sync');
      else onAdded({ origins: [`${origin}/*`] });
    });
    await waitFor(() => expect(result.current.accounts).toEqual([{ id: 1, loginId: 'recovered' }]));
    expect(result.current.error).toBe('');
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  },
);

it('retains cached accounts after a network failure and supports explicit retry', async () => {
  const accounts = [{ id: 1, loginId: 'cached' }];
  fixture.fetch.mockResolvedValueOnce({ success: true, data: { accountList: accounts } });
  const { result } = renderHook(() => useAccounts());
  await act(async () => {
    await result.current.requestAccounts();
  });
  await waitFor(() => expect(result.current.accounts).toEqual(accounts));
  fixture.fetch.mockResolvedValueOnce({ success: false, error: 'Network unavailable' });
  await act(async () => {
    await result.current.retryAccounts();
  });
  expect(result.current.accounts).toEqual(accounts);
  expect(result.current.error).toBe('Network unavailable');
  expect(chrome.permissions.onAdded.addListener).not.toHaveBeenCalled();
  fixture.fetch.mockResolvedValueOnce({ success: true, data: { accountList: [] } });
  await act(async () => {
    await result.current.retryAccounts();
  });
  await waitFor(() => expect(result.current.accounts).toEqual([]));
  expect(result.current.error).toBe('');
});

it('recovers when permission was granted before the failed response reached the UI', async () => {
  const url = new URL('https://accounts.example.test/');
  fixture.settings = { logins: { accounts: { url: url.href } } };
  fixture.permissions.mockResolvedValue({ missingOrigins: [], missingAuthorization: [] });
  fixture.fetch
    .mockResolvedValueOnce({ success: false, error: browserDomainPermissionError(url) })
    .mockResolvedValueOnce({ success: true, data: { accountList: [{ id: 1 }] } });
  const { result } = renderHook(() => useAccounts());
  await act(async () => {
    await result.current.requestAccounts();
  });
  await waitFor(() => expect(result.current.accounts).toEqual([{ id: 1 }]));
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(result.current.error).toBe('');
});

it('does not retry a disposed account view after a pending permission check resolves', async () => {
  const url = new URL('https://accounts.example.test/');
  fixture.settings = { logins: { accounts: { url: url.href } } };
  let finish!: (value: unknown) => void;
  fixture.permissions.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  fixture.fetch.mockResolvedValue({ success: false, error: browserHostPermissionError(url) });
  const { result, unmount } = renderHook(() => useAccounts());
  await act(async () => {
    await result.current.requestAccounts();
  });
  unmount();
  await act(async () => {
    finish({ missingOrigins: [], missingAuthorization: [] });
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
});
it('drops account results accepted before a preset switch and allows the next provider to load', async () => {
  let finishOld!: (value: unknown) => void;
  fixture.fetch.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishOld = resolve;
      }),
  );
  const { result, rerender } = renderHook(() => useAccounts());
  await waitFor(() => expect(result.current.initialized).toBe(true));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.requestAccounts();
  });
  expect(result.current.loading).toBe(true);
  fixture.settings = {};
  rerender();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    finishOld({ success: true, data: { accountList: [{ id: 1, loginId: 'old' }] } });
    await pending;
  });
  expect(result.current.accounts).toEqual([]);
  fixture.fetch.mockResolvedValue({
    success: true,
    data: { accountList: [{ id: 2, loginId: 'new' }] },
  });
  await act(async () => {
    await result.current.requestAccounts();
  });
  await waitFor(() => expect(result.current.accounts).toEqual([{ id: 2, loginId: 'new' }]));
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it('keeps another provider’s stored records hidden when normalization fails', async () => {
  fixture.fetch.mockResolvedValue({
    success: true,
    data: { accountList: [{ id: 1, loginId: 'old' }] },
  });
  const { result, rerender } = renderHook(() => useAccounts());
  await waitFor(() => expect(result.current.initialized).toBe(true));
  await act(async () => {
    await result.current.requestAccounts();
  });
  await waitFor(() => expect(result.current.accounts).toHaveLength(1));
  fixture.normalize.mockResolvedValue({ success: false, error: 'CAPABILITY_UNAVAILABLE' });
  fixture.settings = {};
  rerender();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  expect(result.current.accounts).toEqual([]);
  expect(fixture.normalize).toHaveBeenLastCalledWith([{ id: 1, loginId: 'old' }]);
});

it.each([browserDomainPermissionError, browserHostPermissionError])(
  'requests access only on an explicit retry and reloads after approval',
  async permissionError => {
    const site = new URL('https://accounts.example.test/');
    fixture.settings = { logins: { accounts: { url: site.href } } };
    fixture.fetch.mockResolvedValue({ success: false, error: permissionError(site) });
    const send = vi.mocked(chrome.runtime.sendMessage);
    send.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const { result } = renderHook(() => useAccounts());
    await act(async () => {
      await result.current.requestAccounts();
    });
    expect(result.current.error).toBe('accountsPermissionRequired');
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.retryAccounts({ requestPermission: true });
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('accountsPermissionRequired');

    fixture.fetch.mockResolvedValue({
      success: true,
      data: { accountList: [{ id: 1, loginId: 'test-account' }] },
    });
    await act(async () => {
      await result.current.retryAccounts({ requestPermission: true });
    });
    expect(send).toHaveBeenLastCalledWith({
      action: 'browserUiService',
      data: { operation: 'authorizeAccounts', origin: site.origin },
    });
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));
    expect(result.current.error).toBe('');
  },
);

it('does not request a different host from a capability error', async () => {
  fixture.settings = { logins: { accounts: { url: 'https://accounts.example.test/' } } };
  fixture.fetch.mockResolvedValue({
    success: false,
    error: browserDomainPermissionError(new URL('https://other.example.test/')),
  });
  const { result } = renderHook(() => useAccounts());
  await act(async () => {
    await result.current.requestAccounts();
  });
  await act(async () => {
    await result.current.retryAccounts({ requestPermission: true });
  });
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});
