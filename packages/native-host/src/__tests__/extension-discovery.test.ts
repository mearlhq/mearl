import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  providers: [] as any[],
  notify: () => {},
  error: () => {},
  close: vi.fn(),
  reads: vi.fn(),
  registerBrowser: vi.fn(),
  unregisterBrowser: vi.fn(),
  touchFocus: vi.fn(),
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
vi.mock('@mearl/daemon-core', async importOriginal => ({
  ...(await importOriginal<typeof import('@mearl/daemon-core')>()),
  keyedDir: () => '/fixture',
  ensureDir: vi.fn(),
}));
vi.mock('@mearl/provider/host', () => ({
  INSTALLED_PROVIDERS_SUBDIR: 'providers/installed',
  listInstalledProviders: () => {
    state.reads();
    return state.providers;
  },
}));
vi.mock('../browser-identity.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../browser-identity.js')>()),
  detectNativeBrowserBundleId: () => 'com.citrolabs.ego.lite',
}));
vi.mock('../browser-registry.js', () => ({
  registerBrowser: state.registerBrowser,
  unregisterBrowser: state.unregisterBrowser,
  touchFocus: state.touchFocus,
}));

import { ExtensionBrowserProvider } from '../builtin-providers/extension.js';
import { canDiscoverExtension, watchExtensionDiscovery } from '../extension-discovery.js';

const ego = {
  providerId: 'ego',
  extensionAgentDefault: { macBundleIds: ['com.citrolabs.ego.lite'] },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.providers = [];
});
afterEach(() => vi.useRealTimers());

it('suppresses discovery only for matching native bundle identities', () => {
  state.providers = [{ extensionAgentDefault: {} }, ego];
  expect(canDiscoverExtension(undefined)).toBe(true);
  expect(state.reads).not.toHaveBeenCalled();
  expect(canDiscoverExtension('com.google.Chrome')).toBe(true);
  expect(canDiscoverExtension('com.citrolabs.ego.lite')).toBe(false);
  state.providers = [{ extensionAgentDefault: { macBundleIds: 'com.citrolabs.ego.lite' } }];
  expect(canDiscoverExtension('com.citrolabs.ego.lite')).toBe(true);
});

it('does no idle polling and coalesces installation events without duplicate notifications', () => {
  const changed = vi.fn();
  const discovery = watchExtensionDiscovery('com.citrolabs.ego.lite', changed);
  expect(discovery.allowed()).toBe(true);
  state.reads.mockClear();
  vi.advanceTimersByTime(60_000);
  expect(state.reads).not.toHaveBeenCalled();
  state.providers = [ego];
  for (let i = 0; i < 100; i++) state.notify();
  vi.advanceTimersByTime(50);
  expect(state.reads).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  expect(discovery.allowed()).toBe(false);
  state.notify();
  vi.advanceTimersByTime(50);
  expect(changed).toHaveBeenCalledOnce();
  discovery.close();
  expect(state.close).toHaveBeenCalledOnce();
  state.reads.mockClear();
  state.notify();
  vi.advanceTimersByTime(60_000);
  expect(state.reads).not.toHaveBeenCalled();
});

it('suppresses discovery when installation watching fails', () => {
  const changed = vi.fn();
  const discovery = watchExtensionDiscovery('com.citrolabs.ego.lite', changed);
  state.error();
  expect(discovery.allowed()).toBe(false);
  expect(changed).toHaveBeenCalledOnce();
  expect(state.close).toHaveBeenCalledOnce();
  discovery.close();
});

it('keeps toolbox browser calls available as Ego enters and leaves discovery', async () => {
  state.providers = [ego];
  const onDiscoveryChange = vi.fn();
  const provider = new ExtensionBrowserProvider({
    socketPath: '/fixture/native.sock',
    daemon: false,
    log: vi.fn(),
    onDisconnect: vi.fn(),
    onRequest: vi.fn(),
    onPing: vi.fn(),
    onDiscoveryChange,
    getPresetInstallationRevision: async () => null,
  });
  const send = vi.spyOn(provider, 'send').mockImplementation(() => {});
  const receive = (message: Record<string, unknown>) => provider['handleMessage'](message);
  const setAgentAccess = (enabled: boolean) =>
    receive({ type: 'agent_access', revision: 0, enabled });
  const listTabs = provider.createPluginInvoker(true);
  const runToolbox = async () => {
    const pending = listTabs('tab_list', {});
    const request = send.mock.lastCall?.[0];
    expect(request?.action).toBe('tab_list');
    receive({ id: request?.id, success: true, data: { tabs: [] } });
    await expect(pending).resolves.toEqual({ tabs: [] });
  };
  try {
    receive({ type: 'ping', browserId: 'ego-extension', version: '3.1.0', agentAccessProtocol: 1 });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pong', agentPolicy: { revision: 0, providerIds: [] } }),
      ),
    );
    setAgentAccess(true);
    receive({ type: 'browser_focus' });
    expect(provider.discoveryAllowed).toBe(false);
    expect(state.registerBrowser).not.toHaveBeenCalled();
    expect(state.touchFocus).not.toHaveBeenCalled();
    await runToolbox();

    state.providers = [];
    state.notify();
    vi.advanceTimersByTime(50);
    expect(onDiscoveryChange).toHaveBeenCalledOnce();
    expect(state.registerBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ browserId: 'ego-extension' }),
    );

    state.unregisterBrowser.mockClear();
    state.providers = [ego];
    state.notify();
    vi.advanceTimersByTime(50);
    expect(state.unregisterBrowser).toHaveBeenCalledOnce();
    expect(onDiscoveryChange).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_policy' }));
    await runToolbox();

    setAgentAccess(false);
    await expect(listTabs('tab_list', {})).rejects.toThrow('Extension Agent access is disabled');
  } finally {
    provider.dispose();
  }
});
