import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAccounts } from '../useAccounts';
import {
  browserDomainPermissionError,
  browserHostPermissionError,
} from '../../../../shared/browserCapabilityPermissions';
const fixture = vi.hoisted(() => ({ settings: {}, fetch: vi.fn(), normalize: vi.fn() }));
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
  fixture.fetch.mockReset();
  fixture.normalize
    .mockReset()
    .mockImplementation(async (accounts: unknown[]) => ({ success: true, data: accounts }));
  vi.mocked(chrome.runtime.sendMessage).mockReset();
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
