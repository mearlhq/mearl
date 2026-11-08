import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../../shared/browserRequestUi';
const mocks = vi.hoisted(() => ({ request: vi.fn(), silent: vi.fn(), login: vi.fn(async (_service?: string, _open?: boolean) => {}) }));
vi.mock('../../utils/loginError', () => ({
  isLoginError: (error?: string) => error === 'login required',
}));
vi.mock('../../utils/browserUiSettings', () => ({
  callBrowserUiOperation: mocks.request,
  ensureBrowserUiSettings: async () => ({ logins: { capture: { url: 'https://login.example.test/', title: { en: 'Account' } } } }),
}));
vi.mock('../../utils/browserUiLogin', () => ({ setBrowserUiLoginOpen: mocks.login, useBrowserUiLogin: () => ({ definition: { url: 'https://login.example.test/', title: { en: 'Account' } } }) }));
vi.mock('../../utils/silentLogin', () => ({
  withSilentLogin: mocks.silent.mockImplementation(async ({ operation }: any) => ({
    result: await operation(),
    silentLoginSucceeded: false,
  })),
  resetSilentLoginState: vi.fn(),
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
it('retains a seeded document identity when the first verification fails without a login error', async () => {
  const account = await import('../useCaptureIdentity');
  const confirmed = vi.fn();
  const unsubscribe = account.subscribeCaptureIdentity(confirmed);
  account.acceptCaptureIdentity({ subject: 'existing', displayName: 'Existing', complete: true }, false);
  mocks.request.mockResolvedValue({ success: false, error: 'Network unavailable' });
  const hook = renderHook(() => account.useCaptureIdentity({ source: 'full', lazy: true }));
  await act(async () => {
    await hook.result.current.fetchUserInfo();
  });
  expect(hook.result.current.userInfo).toMatchObject({ subject: 'existing', displayName: 'Existing', complete: true });
  expect(hook.result.current.loginRequired).toBe(false);
  expect(confirmed).not.toHaveBeenCalled();
  await act(async () => {
    account.acceptCaptureIdentity({ subject: 'existing', displayName: 'Existing', complete: true }, false);
  });
  expect(hook.result.current.userInfo).toMatchObject({ subject: 'existing', displayName: 'Existing', complete: true });
  unsubscribe();
});
it('shares confirmed identity and login failure with all sibling consumers', async () => {
  const account = await import('../useCaptureIdentity');
  const first = renderHook(() => account.useCaptureIdentity({ source: 'full', lazy: true }));
  const second = renderHook(() => account.useCaptureIdentity({ source: 'full', lazy: true }));
  const confirmed = vi.fn();
  const unsubscribe = account.subscribeCaptureIdentity(confirmed);
  await act(async () => {
    account.acceptCaptureIdentity({ subject: 'new', complete: false }, false);
  });
  expect(first.result.current.userInfo).toMatchObject({ subject: 'new', complete: false });
  expect(second.result.current.userInfo).toMatchObject({ subject: 'new', complete: false });
  expect(confirmed).not.toHaveBeenCalled();
  mocks.request.mockResolvedValue({ success: false, error: 'login required' });
  await act(async () => {
    await first.result.current.fetchUserInfo();
  });
  expect(first.result.current.userInfo).toBeNull();
  expect(second.result.current.loginRequired).toBe(true);
  expect(confirmed).toHaveBeenCalledExactlyOnceWith(null, true);
  unsubscribe();
});

it('probes an externally hosted login without starting a competing silent login iframe', async () => {
  const account = await import('../useCaptureIdentity');
  const hook = renderHook(() => account.useCaptureIdentity({ source: 'full', lazy: true }));
  mocks.request.mockResolvedValue({ success: false, error: 'login required' });
  await act(async () => {
    await hook.result.current.fetchUserInfo({ silent: true, loginProbe: true });
  });
  expect(mocks.request).toHaveBeenCalledWith('capture.identity', { source: 'full' });
  expect(mocks.silent).not.toHaveBeenCalled();
  await act(async () => {
    await hook.result.current.fetchUserInfo({ silent: true });
  });
  expect(mocks.silent).toHaveBeenCalledOnce();
});

afterEach(() => vi.useRealTimers());
it('starts the original delayed login polling after acceptance and stops after a confirmed identity', async () => {
  vi.useFakeTimers();
  const account = await import('../useCaptureIdentity');
  const hook = renderHook(() => account.useCaptureIdentity({ source: 'full', lazy: true }));
  mocks.request.mockResolvedValue({ success: true, data: { subject: 'confirmed', complete: false } });
  await act(async () => { await hook.result.current.openLoginWindow(); });
  expect(hook.result.current.loginModalOpen).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('capture.identity', { source: 'full' });
  expect(hook.result.current.userInfo).toMatchObject({ subject: 'confirmed', complete: false });
  expect(hook.result.current.loginModalOpen).toBe(false);
  expect(mocks.login).toHaveBeenCalledWith('capture', false);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.silent).not.toHaveBeenCalled();
});

it('accepts provider-defined subjects, names and opaque claims', async () => {
  const account = await import('../useCaptureIdentity');
  const hook = renderHook(() => account.useCaptureIdentity({ lazy: true }));
  mocks.request.mockResolvedValue({ success: true, data: { subject: 'customer:42', displayName: 'Example user', complete: true, tenant: 'test' } });
  await act(async () => { await hook.result.current.fetchUserInfo(); });
  expect(hook.result.current.isLoggedIn).toBe(true);
  expect(hook.result.current.userInfo).toEqual({ subject: 'customer:42', displayName: 'Example user', complete: true, tenant: 'test' });
});

it('clears the old identity on selection changes and keeps a replacement fetch deduplicated', async () => {
  const account = await import('../useCaptureIdentity');
  account.acceptCaptureIdentity({ subject: 'old', complete: true }, false);
  const hook = renderHook(() => account.useCaptureIdentity({ lazy: true }));
  let finishOld!: (value: unknown) => void, finishNew!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  let old!: ReturnType<typeof hook.result.current.fetchUserInfo>;
  act(() => { old = hook.result.current.fetchUserInfo(); });
  const changed = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0];
  await act(async () => { changed({ action: BROWSER_REQUEST_UI_CHANGED }, {}, () => {}); });
  expect(hook.result.current.userInfo).toBeNull();
  let next!: typeof old;
  act(() => { next = hook.result.current.fetchUserInfo(); });
  await act(async () => { finishOld({ success: true, data: { subject: 'stale', complete: true } }); await old; });
  expect(hook.result.current.loading).toBe(true);
  act(() => { void hook.result.current.fetchUserInfo(); });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  await act(async () => { finishNew({ success: true, data: { subject: 'replacement', complete: false } }); await next; });
  expect(hook.result.current.userInfo?.subject).toBe('replacement');
});

it.each(['identity', 'save'])('does not start silent login after a stale %s error', async mode => {
  const account = await import('../useCaptureIdentity');
  const hook = renderHook(() => account.useCaptureIdentity({ lazy: true }));
  let finish!: (value: any) => void;
  const operation = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  mocks.request.mockImplementation(operation);
  mocks.silent.mockImplementationOnce(async ({ operation, isLoginError }: any) => {
    const result = await operation();
    if (isLoginError(result)) { await mocks.login('capture', true); await operation(); }
    return { result, silentLoginSucceeded: false };
  });
  let pending!: Promise<any>;
  act(() => { pending = mode === 'identity' ? hook.result.current.fetchUserInfo() : account.withCaptureAutoLogin(operation); });
  const completed = pending.catch(error => ({ success: false, error: String(error) }));
  await act(async () => { vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0]({ action: BROWSER_REQUEST_UI_CHANGED }, {}, () => {}); });
  await act(async () => { finish({ success: false, error: 'login required' }); await completed; });
  expect(mocks.login).not.toHaveBeenCalled();
  expect(operation).toHaveBeenCalledOnce();
  expect(hook.result.current.loginRequired).toBe(false);
});

it('releases a stale pending login before allowing the next selection to open', async () => {
  const account = await import('../useCaptureIdentity');
  const hook = renderHook(() => account.useCaptureIdentity({ lazy: true }));
  let finish!: () => void;
  mocks.login.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  let first!: Promise<void>;
  act(() => { first = hook.result.current.openLoginWindow(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0]({ action: BROWSER_REQUEST_UI_CHANGED }, {}, () => {}); });
  let second!: Promise<void>;
  act(() => { second = hook.result.current.openLoginWindow(); });
  expect(hook.result.current.loginModalOpen).toBe(false);
  await act(async () => { finish(); await first; await second; });
  expect(mocks.login.mock.calls).toEqual([['capture', true], ['capture', false], ['capture', true]]);
  expect(hook.result.current.loginModalOpen).toBe(true);
  mocks.request.mockResolvedValue({ success: true, data: { subject: 'current', complete: true } });
  await act(async () => { await hook.result.current.closeLoginWindow(); });
});

it('rejects a stale document identity even when its view revision has not changed', async () => {
  const account = await import('../useCaptureIdentity');
  renderHook(() => account.useCaptureIdentity({ lazy: true }));
  const selection = account.captureIdentitySelection();
  await act(async () => { vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0]({ action: BROWSER_REQUEST_UI_CHANGED }, {}, () => {}); });
  expect(() => account.acceptCaptureIdentity({ subject: 'stale', complete: true }, false, selection)).toThrow('provider changed');
});
