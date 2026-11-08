import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), select: vi.fn() }));
vi.mock('@mearl/preset/bundles', async original => ({
  ...(await original<any>()),
  BrowserBundleStore: class {
    list = mocks.list;
  },
  selectBrowserView: mocks.select,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
it('rereads a changed graph after an in-flight read instead of retaining an obsolete provider', async () => {
  let finish!: (value: unknown) => void;
  mocks.list
    .mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ bundles: ['new'], errors: [] });
  mocks.select.mockImplementation((bundles: string[]) => ({
    bundleId: 'example',
    revision: bundles[0],
    definition: { preferences: {} },
  }));
  const state = await import('../viewState');
  const hook = renderHook(() => state.useBrowserView());
  const changed = state.refreshBrowserView();
  await act(async () => {
    finish({ bundles: ['old'], errors: [] });
    await changed;
  });
  await waitFor(() => expect(hook.result.current.selected?.revision).toBe('new'));
  expect(mocks.list).toHaveBeenCalledTimes(2);
});
it('keeps selections independent when two views share one installed bundle', async () => {
  mocks.list.mockResolvedValue({ bundles: [], errors: [] });
  mocks.select.mockImplementation((_bundles, slot) => ({
    bundleId: 'example',
    revision: slot,
    slot,
    definition: { preferences: {} },
  }));
  const state = await import('../viewState');
  await state.refreshBrowserView();
  const hook = renderHook(() => ({
    importer: state.useBrowserView('requestImport'),
    cases: state.useBrowserView('requestCases'),
  }));
  expect(hook.result.current.importer.selected?.slot).toBe('requestImport');
  expect(hook.result.current.cases.selected?.slot).toBe('requestCases');
});
