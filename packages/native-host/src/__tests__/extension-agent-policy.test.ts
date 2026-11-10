import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  providers: [] as any[],
  notify: () => {},
  error: () => {},
  close: vi.fn(),
  reads: vi.fn(),
}));
vi.mock('node:fs', () => ({
  watch: (_path: string, callback: () => void) => {
    state.notify = callback;
    return {
      unref() {},
      on(_event: string, error: () => void) {
        state.error = error;
      },
      close: state.close,
    };
  },
}));
vi.mock('@mearl/daemon-core', () => ({ keyedDir: () => '/fixture', ensureDir: vi.fn() }));
vi.mock('@mearl/provider/host', () => ({
  INSTALLED_PROVIDERS_SUBDIR: 'providers/installed',
  listInstalledProviders: () => {
    state.reads();
    return state.providers;
  },
}));
import { providerIdsForBrowser, watchExtensionAgentPolicy } from '../extension-agent-policy.js';
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.providers = [];
});
afterEach(() => vi.useRealTimers());

it('matches only a native bundle identity and never scans for an unknown parent', () => {
  state.providers = [
    { providerId: 'ego', extensionAgentDefault: { macBundleIds: ['com.citrolabs.ego.lite'] } },
  ];
  expect(providerIdsForBrowser(undefined)).toEqual([]);
  expect(state.reads).not.toHaveBeenCalled();
  expect(providerIdsForBrowser('com.google.Chrome')).toEqual([]);
  expect(providerIdsForBrowser('com.citrolabs.ego.lite')).toEqual(['ego']);
});

it('does no idle polling and coalesces installation events without duplicate notifications', () => {
  const changed = vi.fn();
  const policy = watchExtensionAgentPolicy('com.citrolabs.ego.lite', changed);
  state.reads.mockClear();
  vi.advanceTimersByTime(60_000);
  expect(state.reads).not.toHaveBeenCalled();
  state.providers = [
    { providerId: 'ego', extensionAgentDefault: { macBundleIds: ['com.citrolabs.ego.lite'] } },
  ];
  for (let i = 0; i < 100; i++) state.notify();
  vi.advanceTimersByTime(50);
  expect(state.reads).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledExactlyOnceWith({ revision: 1, providerIds: ['ego'] });
  state.notify();
  vi.advanceTimersByTime(50);
  expect(changed).toHaveBeenCalledOnce();
  policy.close();
  expect(state.close).toHaveBeenCalledOnce();
  state.reads.mockClear();
  state.notify();
  vi.advanceTimersByTime(60_000);
  expect(state.reads).not.toHaveBeenCalled();
});

it('closes access instead of enabling a fallback when installation watching fails', () => {
  const changed = vi.fn();
  const policy = watchExtensionAgentPolicy('com.citrolabs.ego.lite', changed);
  state.error();
  expect(policy.current()).toMatchObject({ revision: 1, available: false });
  expect(changed).toHaveBeenCalledWith(policy.current());
  expect(state.close).toHaveBeenCalledOnce();
  policy.close();
});
