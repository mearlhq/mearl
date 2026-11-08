import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAccounts } from '../useAccounts';
const fixture = vi.hoisted(() => ({ settings: {}, fetch: vi.fn(), normalize: vi.fn() }));
vi.mock('../../utils/browserUiSettings', () => ({ useBrowserUiSettings: () => fixture.settings }));
vi.mock('../../utils/i18n', () => ({ t: (key: string) => key }));
vi.mock('../useLocalStorage', async () => {
  const { useState } = await import('react');
  return { useLocalStorage: () => [...useState([]), true] };
});
vi.mock('../../utils/accounts', () => ({ fetchAccounts: fixture.fetch, normalizeAccounts: fixture.normalize, withAccountAutoLogin: async (operation: () => unknown) => ({ result: await operation() }) }));
beforeEach(() => { fixture.settings = {}; fixture.fetch.mockReset(); fixture.normalize.mockReset().mockImplementation(async (accounts: unknown[]) => ({ success: true, data: accounts })); });
it('drops account results accepted before a preset switch and allows the next provider to load', async () => {
  let finishOld!: (value: unknown) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const { result, rerender } = renderHook(() => useAccounts());
  await waitFor(() => expect(result.current.initialized).toBe(true));
  let pending!: Promise<void>;
  act(() => { pending = result.current.requestAccounts(); });
  expect(result.current.loading).toBe(true);
  fixture.settings = {};
  rerender();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { finishOld({ success: true, data: { accountList: [{ id: 1, loginId: 'old' }] } }); await pending; });
  expect(result.current.accounts).toEqual([]);
  fixture.fetch.mockResolvedValue({ success: true, data: { accountList: [{ id: 2, loginId: 'new' }] } });
  await act(async () => { await result.current.requestAccounts(); });
  await waitFor(() => expect(result.current.accounts).toEqual([{ id: 2, loginId: 'new' }]));
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it('keeps another provider’s stored records hidden when normalization fails', async () => {
  fixture.fetch.mockResolvedValue({ success: true, data: { accountList: [{ id: 1, loginId: 'old' }] } });
  const { result, rerender } = renderHook(() => useAccounts());
  await waitFor(() => expect(result.current.initialized).toBe(true));
  await act(async () => { await result.current.requestAccounts(); });
  await waitFor(() => expect(result.current.accounts).toHaveLength(1));
  fixture.normalize.mockResolvedValue({ success: false, error: 'CAPABILITY_UNAVAILABLE' });
  fixture.settings = {};
  rerender();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  expect(result.current.accounts).toEqual([]);
  expect(fixture.normalize).toHaveBeenLastCalledWith([{ id: 1, loginId: 'old' }]);
});
