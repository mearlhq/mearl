import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeviceCaptureMockImport } from '../useDeviceCaptureMockImport';
import { CapturedRequest } from '../../../panel/types';

vi.mock('../../panel/utils/i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../../panel/utils/toast', () => ({
  showToast: vi.fn(),
}));

const baseRequest = (id: number, apiName: string): CapturedRequest =>
  ({
    id,
    apiName,
    url: `https://example.com/h5/${apiName}/1.0`,
    responseBody: { ok: true },
  }) as CapturedRequest;

describe('useDeviceCaptureMockImport', () => {
  it('应匹配最近一条同 apiName 的请求并导入', async () => {
    const applyMockOverride = vi.fn().mockResolvedValue(undefined);
    const modificationEnabledRef = { current: false };
    const requests = [baseRequest(1, 'a.b.c'), baseRequest(2, 'a.b.c')];

    const { result } = renderHook(() =>
      useDeviceCaptureMockImport({ platformId: 'device',
        requests,
        supportsModify: true,
        modificationEnabled: false,
        modificationEnabledRef,
        setModificationEnabled: vi.fn(),
        applyMockOverride,
      }),
    );

    await act(async () => {
      const res = await result.current.addMockOverride({
        apiName: 'a.b.c',
        responseData: { mocked: true },
      });
      expect(res.success).toBe(true);
    });

    expect(applyMockOverride).toHaveBeenCalledWith(requests[1], { mocked: true });
    expect(modificationEnabledRef.current).toBe(true);
  });

  it('无匹配请求时应抛出错误', async () => {
    const applyMockOverride = vi.fn();
    const modificationEnabledRef = { current: true };

    const { result } = renderHook(() =>
      useDeviceCaptureMockImport({ platformId: 'device',
        requests: [baseRequest(1, 'other.api')],
        supportsModify: true,
        modificationEnabled: true,
        modificationEnabledRef,
        setModificationEnabled: vi.fn(),
        applyMockOverride,
      }),
    );

    await expect(
      result.current.addMockOverride({ apiName: 'a.b.c', responseData: {} }),
    ).rejects.toThrow();
    expect(applyMockOverride).not.toHaveBeenCalled();
  });
});

it('keeps modification disabled when the accepted provider rejects import preparation', async () => {
  const prepareOverride = vi.fn(async () => { throw new Error('Missing device identity'); });
  const applyMockOverride = vi.fn(), setModificationEnabled = vi.fn();
  const modificationEnabledRef = { current: false };
  const request = baseRequest(3, 'a.b.c');
  const { result } = renderHook(() => useDeviceCaptureMockImport({ platformId: 'device', requests: [request], supportsModify: true, modificationEnabled: false, modificationEnabledRef, setModificationEnabled, prepareOverride, applyMockOverride }));
  await expect(result.current.addMockOverride({ apiName: 'a.b.c', responseData: {} })).rejects.toThrow('Missing device identity');
  expect(prepareOverride).toHaveBeenCalledWith(request);
  expect(applyMockOverride).not.toHaveBeenCalled();
  expect(setModificationEnabled).not.toHaveBeenCalled();
  expect(modificationEnabledRef.current).toBe(false);
});

it.each(['second', 'first-again'])('does not enable modification after switching channels during import preparation: %s', async destination => {
  let finish!: () => void;
  const prepareOverride = () => new Promise<void>(resolve => { finish = resolve; });
  const applyMockOverride = vi.fn(), setModificationEnabled = vi.fn();
  const modificationEnabledRef = { current: false };
  const { result, rerender } = renderHook(({ platformId }) => useDeviceCaptureMockImport({ platformId, requests: [baseRequest(1, 'a.b.c')], supportsModify: true, modificationEnabled: false, modificationEnabledRef, setModificationEnabled, prepareOverride, applyMockOverride }), { initialProps: { platformId: 'first' } });
  const pending = result.current.addMockOverride({ apiName: 'a.b.c', responseData: {} });
  const rejected = expect(pending).rejects.toThrow('Capture platform changed');
  rerender({ platformId: 'second' });
  if (destination === 'first-again') rerender({ platformId: 'first' });
  await act(async () => { finish(); await rejected; });
  expect(setModificationEnabled).not.toHaveBeenCalled();
  expect(applyMockOverride).not.toHaveBeenCalled();
});
