// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lease: vi.fn(), close: vi.fn() }));
vi.mock('../browserUiLogin', () => ({ createBrowserUiLoginLease: mocks.lease }));
import { withSilentLogin, resetSilentLoginState } from '../silentLogin';
beforeEach(() => {
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.lease.mockReset().mockResolvedValue({ definition: { url: 'about:blank?accepted-login' }, close: mocks.close });
});
it('uses the accepted named URL and retries only after its hidden frame loads', async () => {
  const operation = vi.fn<() => Promise<{ success: boolean; error?: string }>>().mockResolvedValueOnce({ success: false, error: 'login' }).mockResolvedValueOnce({ success: true });
  const result = withSilentLogin({ service: 'fixture-retry', operation, isLoginError: value => value.error === 'login' });
  await waitFor(() => expect(document.querySelector('iframe')?.src).toBe('about:blank?accepted-login'));
  expect(operation).toHaveBeenCalledOnce();
  document.querySelector('iframe')!.dispatchEvent(new Event('load'));
  expect(await result).toEqual({ result: { success: true }, silentLoginSucceeded: true });
  expect(mocks.lease).toHaveBeenCalledExactlyOnceWith('fixture-retry');
  expect(operation).toHaveBeenCalledTimes(2);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(document.querySelector('iframe')).toBeNull();
});
it('does not open a login for successful requests or retry when the named login is unavailable', async () => {
  const success = vi.fn(async () => ({ success: true }));
  expect(await withSilentLogin({ service: 'fixture-success', operation: success, isLoginError: value => !value.success })).toEqual({ result: { success: true }, silentLoginSucceeded: false });
  expect(mocks.lease).not.toHaveBeenCalled();
  mocks.lease.mockRejectedValue(new Error('unavailable'));
  const failed = vi.fn(async () => ({ success: false, error: 'login' }));
  expect(await withSilentLogin({ service: 'fixture-missing', operation: failed, isLoginError: value => value.error === 'login' })).toEqual({ result: { success: false, error: 'login' }, silentLoginSucceeded: false });
  expect(failed).toHaveBeenCalledOnce();
  expect(document.querySelector('iframe')).toBeNull();
});
it('shares a pending login and releases its lease after a timeout', async () => {
  const operation = vi.fn(async () => ({ success: false, error: 'login' }));
  const options = { service: 'fixture-timeout', operation, isLoginError: (value: { error: string }) => value.error === 'login', timeoutMs: 30 };
  const results = await Promise.all([withSilentLogin(options), withSilentLogin(options)]);
  expect(results.every(value => value.silentLoginSucceeded === false)).toBe(true);
  expect(mocks.lease).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(operation).toHaveBeenCalledTimes(2);
  expect(document.querySelector('iframe')).toBeNull();
});

it('opens an independent lease after reset while an old login is still pending', async () => {
  const options = { service: 'fixture-selection', isLoginError: (value: { success: boolean }) => !value.success };
  const oldOperation = vi.fn(async () => ({ success: false }));
  const first = withSilentLogin({ ...options, operation: oldOperation });
  await waitFor(() => expect(document.querySelectorAll('iframe')).toHaveLength(1));
  const oldFrame = document.querySelector('iframe')!;
  resetSilentLoginState(options.service);
  const nextOperation = vi.fn().mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true });
  const second = withSilentLogin({ ...options, operation: nextOperation });
  await waitFor(() => expect(document.querySelectorAll('iframe')).toHaveLength(2));
  expect(mocks.lease).toHaveBeenCalledTimes(2);
  oldFrame.dispatchEvent(new Event('load'));
  expect((await first).silentLoginSucceeded).toBe(false);
  expect(oldOperation).toHaveBeenCalledOnce();
  document.querySelector('iframe')!.dispatchEvent(new Event('load'));
  expect((await second).silentLoginSucceeded).toBe(true);
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it('does not let a late retry failure restore the next session cooldown', async () => {
  const options = { service: 'fixture-retry-selection', isLoginError: (value: { success: boolean }) => !value.success };
  let finish!: (value: { success: boolean }) => void;
  const operation = vi.fn().mockResolvedValueOnce({ success: false }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = withSilentLogin({ ...options, operation });
  await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
  document.querySelector('iframe')!.dispatchEvent(new Event('load'));
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
  resetSilentLoginState(options.service);
  const current = vi.fn().mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
  const second = withSilentLogin({ ...options, operation: current });
  await waitFor(() => expect(mocks.lease).toHaveBeenCalledTimes(2));
  document.querySelector('iframe')!.dispatchEvent(new Event('load'));
  await second;
  finish({ success: false }); await first;
  const third = withSilentLogin({ ...options, operation: vi.fn().mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true }) });
  await waitFor(() => expect(mocks.lease).toHaveBeenCalledTimes(3));
  document.querySelector('iframe')!.dispatchEvent(new Event('load'));
  expect((await third).silentLoginSucceeded).toBe(true);
});
