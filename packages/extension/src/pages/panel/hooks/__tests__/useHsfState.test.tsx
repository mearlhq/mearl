import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { requestUiFixture as legacyBrowserRequestUi } from '../../../../test/fixtures/requestUi';
import { useHsfState } from '../useHsfState';
import type { CapturedRequest } from '../../types';

const mocks = vi.hoisted(() => ({ state: null as any, open: vi.fn(), toast: vi.fn() }));
vi.mock('../useBrowserRequestUi', () => ({ useBrowserRequestUi: () => mocks.state }));
vi.mock('../useRequestMetadataLogin', () => ({
  useRequestMetadataLogin: () => ({ openLoginModal: mocks.open }),
  isRequestMetadataLoginError: () => true,
}));
vi.mock('../../utils/toast', () => ({ showToast: mocks.toast }));
vi.mock('../../utils/i18n', () => ({ getCurrentLanguage: () => 'en' }));
const request = {
  id: 1,
  apiName: 'mtop.example.test',
  source: 'protocol',
  version: '1.0',
} as unknown as CapturedRequest;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { selected: { revision: 'old' }, definition: legacyBrowserRequestUi };
});
for (const failure of [false, true])
  it(`loads a replacement provider while an old request is pending and discards its stale ${failure ? 'error' : 'result'}`, async () => {
    const old = deferred<any>(),
      next = deferred<any>();
    vi.mocked(chrome.runtime.sendMessage)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(() => useHsfState(request));
    act(() => {
      void result.current.onToggleHsf();
    });
    await waitFor(() => expect(result.current.hsfLoading).toBe(true));
    mocks.state = { ...mocks.state, selected: { revision: 'next' } };
    rerender();
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (failure) old.reject(new Error('Not logged in'));
      else
        old.resolve({
          success: true,
          data: { displayValue: 'Old', jumpUrl: 'https://old.example.com/' },
        });
    });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(result.current.hsfEnabled).toBe(true);
    expect(result.current.hsfLoading).toBe(true);
    await act(async () =>
      next.resolve({
        success: true,
        data: { displayValue: 'Next', jumpUrl: 'https://next.example.com/' },
      }),
    );
    expect(result.current.hsfDisplayValue).toBe('Next');
    expect(result.current.hsfLoading).toBe(false);
  });
it('does not let an old request failure disable the next selected request', async () => {
  const old = deferred<any>();
  vi.mocked(chrome.runtime.sendMessage)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({
      success: true,
      data: { displayValue: 'Second', jumpUrl: 'https://example.com/' },
    });
  const { result, rerender } = renderHook(({ current }) => useHsfState(current), {
    initialProps: { current: request },
  });
  act(() => {
    void result.current.onToggleHsf();
  });
  rerender({ current: { ...request, id: 2, apiName: 'mtop.second.test' } });
  await waitFor(() => expect(result.current.hsfDisplayValue).toBe('Second'));
  await act(async () => old.reject(new Error('Not logged in')));
  expect(result.current.hsfEnabled).toBe(true);
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});
