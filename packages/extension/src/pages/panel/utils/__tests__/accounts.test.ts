import { beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_LOGIN_REQUIRED, isAccountLoginError, borrowAccount, fetchAccounts, fetchAccountIdentity, fetchAccountSso, normalizeAccounts, readAccountLabelCache, writeAccountLabelCache } from '../accounts';
import { callBrowserUiOperationResult } from '../browserUiSettings';
vi.mock('../browserUiSettings', () => ({ callBrowserUiOperationResult: vi.fn() }));
const provider = { bundleId: 'accounts', revision: 'one' };
const record = { id: 1, principalId: 123, loginId: 'test', site: 'test' };
beforeEach(() => { vi.mocked(callBrowserUiOperationResult).mockReset(); });
it('reads the display label synchronously only for the same installed selection and survives unavailable storage', () => {
  writeAccountLabelCache('selection-one', 'cached-account');
  expect(readAccountLabelCache('selection-one')).toBe('cached-account');
  expect(readAccountLabelCache('selection-two')).toBe('');
  expect(readAccountLabelCache()).toBe('');
  writeAccountLabelCache('selection-one', '');
  expect(readAccountLabelCache('selection-one')).toBe('');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('Unavailable'); });
  expect(() => writeAccountLabelCache('selection-one', 'next-account')).not.toThrow();
});
it('distinguishes a verified empty identity from an unavailable identity service', async () => {
  chrome.runtime.sendMessage = vi.fn().mockResolvedValueOnce({ success: true, data: { value: '', watch: [] } }).mockResolvedValueOnce({ success: false }) as any;
  expect(await fetchAccountIdentity({ cachedOnly: true })).toEqual({ value: '', watch: [] });
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'accountIdentity', cachedOnly: true });
  await expect(fetchAccountIdentity()).rejects.toThrow('Account identity unavailable');
});
it('preserves login expiry across the identity message boundary without treating a service error as logout', async () => {
  chrome.runtime.sendMessage = vi.fn().mockResolvedValueOnce({ success: false, error: ACCOUNT_LOGIN_REQUIRED }).mockResolvedValueOnce({ success: false, error: 'Identity service offline' }) as any;
  await expect(fetchAccountIdentity()).rejects.toThrow(ACCOUNT_LOGIN_REQUIRED);
  await expect(fetchAccountIdentity()).rejects.toThrow('Identity service offline');
  expect(isAccountLoginError(ACCOUNT_LOGIN_REQUIRED)).toBe(true);
  expect(isAccountLoginError('Identity service offline')).toBe(false);
});
it('binds displayed accounts to the actual accepted provider', async () => {
  vi.mocked(callBrowserUiOperationResult).mockResolvedValue({ provider, data: { success: true, data: { accountList: [record] } } });
  expect(await fetchAccounts()).toMatchObject({ data: { accountList: [{ ...record, provider }] } });
});
it('carries the borrowed account provider into subsequent ticket issuance', async () => {
  vi.mocked(callBrowserUiOperationResult).mockResolvedValue({ provider, data: { success: true, data: record } });
  const borrowed = await borrowAccount('test');
  await fetchAccountSso(borrowed.data!.principalId!, borrowed.data!.site!, borrowed.data!.provider);
  expect(callBrowserUiOperationResult).toHaveBeenLastCalledWith('accounts', { command: 'sso', principalId: 123, site: 'test' }, { provider });
});
it('never normalizes another provider’s persisted records under the new provider', async () => {
  vi.mocked(callBrowserUiOperationResult).mockResolvedValue({ provider, data: { success: true, data: [] } });
  await normalizeAccounts([{ ...record, provider: { bundleId: 'other', revision: 'one' } }, record]);
  expect(callBrowserUiOperationResult).toHaveBeenLastCalledWith('accounts', { command: 'normalize', accounts: [record] }, { provider });
});
it('retains login expiry and service failures for the existing retry controls', async () => {
  vi.mocked(callBrowserUiOperationResult).mockResolvedValue({ provider, data: { success: false, error: 'ACCOUNT_LOGIN_REQUIRED' } });
  expect(await borrowAccount('test')).toMatchObject({ success: false, error: 'ACCOUNT_LOGIN_REQUIRED' });
  vi.mocked(callBrowserUiOperationResult).mockRejectedValue(new Error('SERVICE_DISABLED'));
  expect(await borrowAccount('test')).toEqual({ success: false, error: 'SERVICE_DISABLED' });
});

it('rebinds same-bundle cached records through the newly accepted normalizer before use', async () => {
  const previous = { ...record, provider: { ...provider, revision: 'old' } };
  vi.mocked(callBrowserUiOperationResult).mockResolvedValueOnce({ provider, data: { success: true, data: [] } }).mockResolvedValueOnce({ provider, data: { success: true, data: [record] } });
  const result = await normalizeAccounts([previous]);
  expect(callBrowserUiOperationResult).toHaveBeenLastCalledWith('accounts', { command: 'normalize', accounts: [previous] }, { provider });
  expect(result.data).toEqual([{ ...record, provider }]);
});
