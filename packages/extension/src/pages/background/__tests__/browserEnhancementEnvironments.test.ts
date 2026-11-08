import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppDeviceUserAgent } from '@mearl/app-profiles';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';
import { emptyDeviceUserAgentMetadata, resolveEmulationConfig, type BrowserEnhancementBinding, type DeviceEnvironmentObservation } from '@mearl/browser-core';

const state = vi.hoisted(() => ({
  device: undefined as ReturnType<typeof resolveEmulationConfig> | undefined,
  app: undefined as ReturnType<typeof resolveAppProfile>['injected'] | undefined,
  shell: false, deviceRevision: 0, appRevision: 0, reloads: 0, loader: 1,
  baseline: undefined as unknown as DeviceEnvironmentObservation, observed: undefined as unknown as DeviceEnvironmentObservation,
  values: {} as Record<string, any>, authorize: vi.fn(), failDevice: false, wrongPlatform: false,
}));
function sync() {
  const config = state.device;
  state.observed = config ? {
    userAgent: config.userAgent, platform: config.platform, userAgentMetadata: emptyDeviceUserAgentMetadata(),
    screen: { width: config.width, height: config.height, deviceScaleFactor: config.deviceScaleFactor, orientation: config.orientation + '-primary', angle: config.orientation === 'landscape' ? 90 : 0 },
    touchPoints: config.touch ? 5 : 0, safeAreaInsets: structuredClone(config.safeAreaInsets),
  } : structuredClone(state.baseline);
}
vi.mock('../debuggerSessionManager', () => ({ acquireDebuggerLease: async () => ({ release: vi.fn() }) }));
vi.mock('../environmentRevisions', () => ({ getEnvironmentRevision: async (_tab: number, component: string) => component === 'device' ? state.deviceRevision : state.appRevision }));
vi.mock('../deviceEmulationState', () => ({ getEmulationConfigForTab: () => state.device }));
vi.mock('../deviceShellRules', () => ({ getDeviceShellForTab: async () => state.shell ? { config: { fixture: true }, emulation: state.device!, splitScreen: false } : null }));
vi.mock('../utils/appProfileRules', () => ({ getAppProfileForTab: async () => state.app }));
vi.mock('../appProfileCatalog', () => ({ resolveAvailableAppProfile: async () => resolveAppProfile('reader') }));
vi.mock('../../../shared/appBridgeConfig', () => ({ loadStoredAppProfileOptions: async () => ({}), resolveStoredAppBridgeConfig: async () => undefined }));
vi.mock('../appProfileRuntimeSource', () => ({ buildAppProfileRuntimeProgram: async () => ({ registration: '', call: '' }) }));
vi.mock('../appProfileHostCapabilities', () => ({ captureAppProfileHostCapabilities: async (config: unknown) => config }));
vi.mock('../appProfileLifecycle', () => ({ applyAppProfileEnvironmentForTab: async (_tab: number, config: any) => { state.app = config; state.appRevision++; } }));
vi.mock('../agentHandlers/appProfileHandlers', () => ({ handleSetAppProfile: async (data: any, _active: unknown, context?: any) => {
  state.appRevision++; state.app = data.enabled ? structuredClone(context.current) : undefined;
  return { enabled: data.enabled, profile: state.app?.profile, reloaded: false };
} }));
vi.mock('../agentHandlers/emulationHandlers', () => ({ handleSetDeviceEmulation: async (data: any) => {
  state.deviceRevision++;
  if (state.failDevice) throw new Error('device receipt lost');
  state.device = data.enabled ? resolveEmulationConfig(data) : undefined; state.shell = data.enabled && data.deviceShell;
  if (state.app && state.device) { state.app = { ...state.app, statusBarHeight: state.device.safeAreaInsets.top, safeAreaInsets: state.device.safeAreaInsets }; state.appRevision++; }
  sync(); return { enabled: data.enabled, reloaded: false, deviceShell: Boolean(state.shell), splitScreen: false };
} }));
vi.mock('../debuggerManager', () => ({
  getSafeAreaInsetsForTab: () => undefined,
  recordHostEnvironmentObservation: vi.fn(),
  synchronizeAppDeviceIdentityForTab: async (_tabId: number, _baseline: unknown, options?: { preserveHostPlatform?: boolean }) => {
    state.deviceRevision++;
    const identity = resolveAppDeviceUserAgent(state.baseline, state.device, state.shell && state.app ? state.app.userAgent : undefined);
    state.observed.userAgent = identity.userAgent;
    state.observed.platform = state.wrongPlatform ? 'Wrong platform' : options?.preserveHostPlatform ? state.baseline.platform : state.device?.platform ?? state.baseline.platform;
    state.observed.userAgentMetadata = identity.userAgentMetadata;
    state.observed.safeAreaInsets = structuredClone(state.device?.safeAreaInsets ?? state.baseline.safeAreaInsets);
  },
  reloadTabInSession: async () => { state.reloads++; state.loader++; },
  getTabState: () => ({ timezoneOverrides: {} }), hydrateRecordedTimezoneSettings: vi.fn(), restoreRecordedTimezoneOwnership: vi.fn(),
}));
vi.mock('../quickDeviceSimulationState', () => ({ getQuickDeviceSimulationState: () => undefined, hydrateQuickDeviceSimulationState: async () => {} }));
vi.mock('../agentHandlers/tabHandlers', () => ({ navigateAndWait: async (_tab: number, _url: string, run: () => Promise<unknown>) => { await run(); return 'load'; } }));
vi.mock('../agentHandlers/snapshotHandlers', () => ({ handlePageFrames: async () => ({ frames: [{ frameId: 'main', isMainFrame: true }] }) }));
vi.mock('../agentHandlers/timezoneHandlers', () => ({ handleSetTimezone: vi.fn() }));
vi.mock('../tabPageOverrides', () => ({ getTabPageOverrides: async () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  state.baseline = { userAgent: 'Host', platform: 'Host', userAgentMetadata: { brands: [{brand:'Chromium',version:'156'}],fullVersionList:[{brand:'Chromium',version:'156.0.0.0'}],platform:'Host OS',platformVersion:'1',architecture:'arm',model:'',mobile:false },
    screen: { width: 1920, height: 1080, deviceScaleFactor: 1, orientation: 'landscape-primary', angle: 0 },
    touchPoints: 0, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
  Object.assign(state, { device: undefined, app: undefined, shell: false, deviceRevision: 0, appRevision: 0, reloads: 0, loader: 1, values: {}, failDevice: false, wrongPlatform: false });
  sync(); state.authorize.mockReset().mockResolvedValue(undefined);
  chrome.storage.session = { get: vi.fn(async (key: string) => ({ [key]: structuredClone(state.values[key]) })),
    set: vi.fn(async (next: object) => Object.assign(state.values, structuredClone(next))), remove: vi.fn(async (key: string) => { delete state.values[key]; }) } as any;
  chrome.tabs = { get: vi.fn(async () => ({ url: 'https://example.test/' })) } as any;
  chrome.debugger = { getTargets: vi.fn(async () => [{ id: 'target', tabId: 7, type: 'page' }]),
    sendCommand: vi.fn(async (_target, method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: String(state.loader) } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 2 };
      return { result: { value: structuredClone(state.observed) } };
    }) } as any;
});

const owner = 'provider:fixture:space';
async function run(request: any) { return (await import('../browserEnhancements')).handleBrowserEnhancement(request, state.authorize); }
async function bind(actions = ['set_device_emulation', 'set_app_profile'], preserveHostPlatform?: true, preserveHostInput?: true) {
  const result = await run({ operation: 'bind', owner, tabId: 7, mainFrameId: 'main', targetId: 'target', actions,
    navigationOrigin: 'https://example.test', initialEnvironment: { device: state.baseline, ...(preserveHostPlatform ? { preserveHostPlatform } : {}), ...(preserveHostInput ? { preserveHostInput } : {}) } });
  if (!('binding' in result)) throw new Error('Expected binding'); return result.binding;
}
async function invoke(binding: BrowserEnhancementBinding, action: string, data: object) {
  return run({ operation: 'invoke', owner, bindingId: binding.bindingId, generation: binding.generation, action, data: { tabId: 7, ...data } });
}
async function release(binding: BrowserEnhancementBinding) { return run({ operation: 'release', owner, bindingId: binding.bindingId, generation: binding.generation }); }

describe('scoped App/device environment composition', () => {
  it('retains the captured physical platform while App and device intents are changed and restored independently', async () => {
    const binding = await bind(undefined, true, true);
    await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader', emulation: { preset: 'iphone-15-pro', deviceShell: true } });
    expect(state.observed.platform).toBe(state.baseline.platform); expect(state.device?.platform).toBe('iPhone');
    expect(state.values['browserEnhancement:7'].initialEnvironment.preserveHostPlatform).toBe(true);
    expect(state.values['browserEnhancement:7'].initialEnvironment.preserveHostInput).toBe(true);
    await invoke(binding, 'set_app_profile', { enabled: false });
    expect(state.observed.platform).toBe(state.baseline.platform); expect(state.device?.platform).toBe('iPhone');
    expect(state.app).toBeUndefined();
    expect(await release(binding)).toEqual({ released: true });
    expect(state.observed).toEqual(state.baseline);
  });
  it('still rejects physical platform drift under the host-platform policy', async () => {
    const binding = await bind(undefined, true);
    await invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro' });
    state.observed.platform = 'iPhone';
    expect(await release(binding)).toMatchObject({ released: false, conflicts: ['device:changed'] });
    expect(state.device).toBeDefined();
  });
  it.each(['preserveHostPlatform', 'preserveHostInput'])('cannot reinterpret an active binding under a different %s policy', async policy => {
    const binding = await bind();
    await invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro' });
    await expect(run({ operation: 'bind', owner, tabId: 7, mainFrameId: 'main', targetId: 'target', actions: binding.actions,
      navigationOrigin: 'https://example.test', initialEnvironment: { device: state.baseline, [policy]: true } })).rejects.toThrow('previous host environment policy');
    expect(state.observed.platform).toBe('iPhone'); expect(state.values['browserEnhancement:7'].generation).toBe(binding.generation);
  });
  it('retains App/device journals through reordered storage and configuration keys', async () => {
    const reorder = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
    vi.mocked(chrome.storage.session.set).mockImplementation(async next => { Object.assign(state.values, reorder(next)); });
    const binding = await bind();
    await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader', emulation: { preset: 'iphone-15-pro', deviceShell: true } });
    state.app = reorder(state.app); state.device = reorder(state.device);
    expect(await run({ operation: 'probe', tabId: 7 })).toHaveProperty('capabilities');
    expect(await release(binding)).toEqual({ released: true });
    expect(state.observed).toEqual(state.baseline);
  });
  it('rejects a stored fingerprint whose value changed', async () => {
    const binding = await bind();
    await invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro' });
    state.values['browserEnhancement:7'].device.applied.value.config.width++;
    await expect(run({ operation: 'probe', tabId: 7 })).rejects.toThrow('invalid persisted binding');
    expect(state.device).toBeDefined();
  });
  it('rechecks physical resources on an unchanged binding before declaring it reverified', async () => {
    const binding = await bind();
    await invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro' });
    const request = { operation: 'bind', owner, tabId: 7, mainFrameId: 'main', targetId: 'target', actions: binding.actions,
      navigationOrigin: 'https://example.test', initialEnvironment: { device: state.baseline } };
    expect(await run(request)).toMatchObject({ binding: { bindingId: binding.bindingId, generation: binding.generation } });
    state.observed.screen.width++;
    await expect(run(request)).rejects.toThrow('environment changed (screen)');
    expect(state.device).toBeDefined();
    expect(state.values['browserEnhancement:7'].generation).toBe(binding.generation);
  });
  it('retains ownership across reordered transport keys while applying and restoring a device', async () => {
    const reordered = (value: DeviceEnvironmentObservation) => JSON.parse(JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).reverse()) : item));
    state.observed = reordered(state.baseline);
    const binding = await bind();
    await invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro' });
    state.observed = reordered(state.observed);
    expect(await release(binding)).toEqual({ released: true });
    expect(state.observed).toEqual(state.baseline);
  });
  it('requires a device scope before an App request can include emulation', async () => {
    const binding = await bind(['set_app_profile']);
    await expect(invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader', emulation: { preset: 'iphone-15-pro' } })).rejects.toThrow('SCOPE_MISMATCH');
    expect(state.appRevision).toBe(0); expect(state.deviceRevision).toBe(0); expect(state.reloads).toBe(0);
  });
  it('does not enable an App on a blank page without an authorized first destination', async () => {
    chrome.tabs.get = vi.fn(async () => ({ url: 'about:blank' })) as any;
    const result = await run({ operation: 'bind', owner, tabId: 7, mainFrameId: 'main', targetId: 'target', actions: ['set_app_profile'], initialEnvironment: { device: state.baseline } });
    if (!('binding' in result)) throw new Error('Expected binding');
    await expect(invoke(result.binding, 'set_app_profile', { enabled: true, profile: 'reader' })).rejects.toThrow('NAVIGATION_ORIGIN_REQUIRED');
    expect(state.appRevision).toBe(0); expect(state.deviceRevision).toBe(0); expect(state.reloads).toBe(0);
  });
  it('prepares an owned blank target without an unnecessary reload before its first business navigation', async () => {
    chrome.tabs.get = vi.fn(async () => ({ url: 'about:blank' })) as any;
    const binding = await bind();
    expect(await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader', emulation: { preset: 'iphone-15-pro', deviceShell: true }, reload: false })).toMatchObject({ result: { reloaded: false } });
    expect(state.reloads).toBe(0); expect(state.app?.profile).toBe('reader'); expect(state.device?.presetName).toBe('iphone-15-pro');
  });
  it('prepares both before the first navigation, then restores App independently of the device', async () => {
    const binding = await bind();
    await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader', emulation: { preset: 'iphone-15-pro', deviceShell: true }, reload: false });
    expect(state.app?.profile).toBe('reader'); expect(state.device?.presetName).toBe('iphone-15-pro');
    expect(state.observed.userAgent).toBe(state.app?.userAgent);
    expect(state.values['browserEnhancement:7'].app.baseline.value).toBeNull();
    expect(state.values['browserEnhancement:7'].device.baseline.value).toEqual({ config: null, shell: null });
    await invoke(binding, 'set_app_profile', { enabled: false });
    expect(state.app).toBeUndefined(); expect(state.device?.presetName).toBe('iphone-15-pro');
    expect(state.observed.userAgent).toBe(state.device?.userAgent);
    expect(await release(binding)).toEqual({ released: true });
    expect(state.device).toBeUndefined(); expect(state.observed).toEqual(state.baseline);
  });

  it('keeps App ownership through a legitimate device update and device removal', async () => {
    const binding = await bind();
    await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader' });
    await invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro', deviceShell: true });
    await invoke(binding, 'set_device_emulation', { enabled: true, preset: 'pixel-11', deviceShell: true });
    await invoke(binding, 'set_device_emulation', { enabled: false });
    expect(state.app?.profile).toBe('reader'); expect(state.device).toBeUndefined();
    expect(await release(binding)).toEqual({ released: true }); expect(state.app).toBeUndefined();
  });

  it('rejects unowned or changed baselines before a first environment effect', async () => {
    state.device = resolveEmulationConfig({ enabled: true, preset: 'iphone-15-pro' }); sync();
    await expect(bind()).rejects.toThrow('BASELINE_UNSUPPORTED');
    state.device = undefined; sync(); state.observed.touchPoints = 1;
    await expect(bind()).rejects.toThrow('BASELINE_UNSUPPORTED');
    expect(state.deviceRevision).toBe(0); expect(state.appRevision).toBe(0); expect(state.reloads).toBe(0);
  });

  it('preserves later UI changes and raw CDP changes during release', async () => {
    const binding = await bind(); await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader' });
    state.appRevision++;
    expect(await release(binding)).toEqual({ released: false, conflicts: ['app:changed'] });
    expect(state.app?.profile).toBe('reader');
    expect(state.values['browserEnhancement:7']).toBeDefined();
  });

  it('retains both affected journals if a device effect becomes unknown', async () => {
    const binding = await bind(); await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader' });
    state.failDevice = true;
    await expect(invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro' })).rejects.toThrow('receipt lost');
    expect(state.values['browserEnhancement:7'].device.phase).toBe('pending');
    expect(state.values['browserEnhancement:7'].app.phase).toBe('pending');
    expect(await release(binding)).toEqual({ released: false, conflicts: ['app:unconfirmed'] });
  });

  it('does not accept an incorrect platform or foreign Client Hints as a successful composition', async () => {
    const binding = await bind(); state.wrongPlatform = true;
    await expect(invoke(binding, 'set_device_emulation', { enabled: true, preset: 'iphone-15-pro' })).rejects.toThrow('EFFECT_UNCONFIRMED');
    expect(state.values['browserEnhancement:7'].device.phase).toBe('pending');
  });

  it('defers release if Client Hints become unobservable instead of adopting missing metadata', async () => {
    const binding = await bind(); await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader' });
    state.observed.userAgentMetadata = null;
    await expect(release(binding)).rejects.toThrow('OBSERVATION_UNAVAILABLE');
    expect(state.app?.profile).toBe('reader');
  });

  it('authorizes every requested component and the first destination origin', async () => {
    await bind();
    expect(state.authorize).toHaveBeenCalledWith(7, 'set_device_emulation', 'https://example.test');
    expect(state.authorize).toHaveBeenCalledWith(7, 'set_app_profile', 'https://example.test');
  });

  it('keeps deferred App removal unsupported until the current-document restoration path is confirmed', async () => {
    const binding = await bind(); await invoke(binding, 'set_app_profile', { enabled: true, profile: 'reader' });
    const revision = state.appRevision;
    await expect(invoke(binding, 'set_app_profile', { enabled: false, reload: false })).rejects.toThrow('requires a confirmed reload');
    expect(state.appRevision).toBe(revision); expect(state.app?.profile).toBe('reader');
  });
});
