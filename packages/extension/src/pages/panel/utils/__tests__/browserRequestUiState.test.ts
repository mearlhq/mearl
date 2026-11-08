import { beforeEach, expect, it, vi } from 'vitest';
import { requestUiFixture as legacyBrowserRequestUi } from '../../../../test/fixtures/requestUi';
const mocks = vi.hoisted(() => ({ list: vi.fn(), select: vi.fn() }));
vi.mock('@mearl/preset/bundles', async original => ({
  ...(await original<any>()),
  BrowserBundleStore: class {
    list = mocks.list;
  },
  selectBrowserRequestUi: mocks.select,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
it('shares the initial bundle read across concurrent consumers', async () => {
  mocks.list.mockResolvedValue({ bundles: [], errors: [] });
  mocks.select.mockReturnValue(undefined);
  const state = await import('../browserRequestUiState');
  await Promise.all([state.ensureBrowserRequestUiState(), state.ensureBrowserRequestUiState()]);
  expect(mocks.list).toHaveBeenCalledOnce();
});

it('rereads when a change arrives while an older verified snapshot is loading', async () => {
  let finish!: (value: any) => void;
  mocks.list
    .mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ bundles: ['new'], errors: [] });
  mocks.select.mockImplementation((bundles: string[]) => ({
    bundleId: 'test',
    revision: bundles[0],
    definition: legacyBrowserRequestUi,
  }));
  const state = await import('../browserRequestUiState');
  const first = state.refreshBrowserRequestUiState();
  const changed = state.refreshBrowserRequestUiState();
  finish({ bundles: ['old'], errors: [] });
  await Promise.all([first, changed]);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(state.getBrowserRequestUiState().selected?.revision).toBe('new');
  await state.ensureBrowserRequestUiState();
  expect(mocks.list).toHaveBeenCalledTimes(2);
});
it('rejects definitions that occupy another existing service setting and retains the current rendered definition', async () => {
  mocks.list.mockResolvedValue({ bundles: [], errors: [] });
  mocks.select.mockReturnValue({
    bundleId: 'test',
    revision: 'bad',
    definition: {
      ...legacyBrowserRequestUi,
      setting: { ...legacyBrowserRequestUi.setting, key: 'requestCasesEnabled' },
    },
  });
  const state = await import('../browserRequestUiState');
  await state.refreshBrowserRequestUiState();
  expect(state.getBrowserRequestUiState().selected).toBeNull();
});

it('clears selected metadata on uninstall instead of substituting a built-in service', async () => {
  mocks.list.mockResolvedValue({ bundles: [], errors: [] });
  mocks.select.mockReturnValue({ bundleId: 'test', revision: 'installed', definition: legacyBrowserRequestUi });
  const state = await import('../browserRequestUiState');
  await state.refreshBrowserRequestUiState();
  expect(state.getBrowserRequestUiState().definition).toEqual(legacyBrowserRequestUi);
  mocks.select.mockReturnValue(undefined);
  await state.refreshBrowserRequestUiState();
  expect(state.getBrowserRequestUiState()).toEqual({ selected: null, definition: null });
});
