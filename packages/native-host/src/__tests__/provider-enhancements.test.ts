import { describe, expect, it, vi } from 'vitest';
import { ProviderEnhancementService } from '../provider-enhancements.js';
import type { BrowserRecord } from '../browser-registry.js';

function fixture() {
  const provider = {
    pid: 1, browserId: 'provider:fixture:space', providerBrowserId: 'space', startedAt: 'start',
    transport: 'provider', status: 'connected', provider: { id: 'fixture', protocolVersion: 3 },
    capabilities: { controlSessionMode: 'external', actions: ['page_frames'], screenshot: 'none' },
  } as BrowserRecord;
  const native = { pid: 2, browserId: 'native', socketPath: '/native.sock', startedAt: 'start', transport: 'extension' } as BrowserRecord;
  const browsers = [provider, native];
  const state = { frameId: 'main', bindingId: '' };
  const request = vi.fn(async (browser: BrowserRecord) => browser.transport === 'provider'
    ? { tabId: 11, ready: true, mainFrameId: state.frameId, url: 'https://example.test' }
    : { tabs: [{ tabId: 7, url: 'https://example.test' }] });
  const enhance = vi.fn(async (_browser: BrowserRecord, _owner: BrowserRecord, data: any, _deadline?: number) => {
    if (data.operation === 'probe') return { capabilities: { protocolVersion: 1, actions: ['set_timezone'] }, mainFrameId: 'main' };
    if (data.operation === 'bind') return { binding: { bindingId: 'binding', generation: 1, mainFrameId: 'main', tabId: 7, actions: ['set_timezone'] } };
    if (data.operation === 'release') return { released: true };
    return { result: { enabled: true } };
  });
  const service = new ProviderEnhancementService({ browsers: () => browsers, request, enhance: enhance as any });
  const bind = async () => {
    const result = await service.invoke(provider.browserId, { operation: 'bind', providerTabId: 11, actions: ['set_timezone'] });
    if ('binding' in result) state.bindingId = result.binding.bindingId;
    return result;
  };
  const invoke = () => service.invoke(provider.browserId, { operation: 'invoke', bindingId: state.bindingId, generation: 1, action: 'set_timezone', data: { tabId: 11, timezone: 'UTC' } });
  return { provider, native, browsers, state, service, request, enhance, bind, invoke };
}

describe('Provider enhancement mapping', () => {
  it.each(['preserveHostPlatform', 'preserveHostInput'])('refuses an Extension lacking the Creator %s policy before binding', async policy => {
    const f = fixture(), request = f.request.getMockImplementation()!, enhance = f.enhance.getMockImplementation()!;
    const device = { userAgent: 'Host', platform: 'Host', userAgentMetadata: null,
      screen: { width: 1920, height: 1080, deviceScaleFactor: 1, orientation: 'landscape-primary', angle: 0 },
      touchPoints: 0, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    f.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, mainFrameId: 'main', url: 'https://example.test', initialEnvironment: { device, [policy]: true } } as any
      : request(browser));
    await expect(f.bind()).rejects.toThrow('cannot preserve the captured host environment');
    expect(f.enhance.mock.calls.every(call => call[2].operation === 'probe')).toBe(true);
    f.enhance.mockImplementation(async (...args) => {
      const result = await enhance(...args);
      return 'capabilities' in result ? { ...result, capabilities: { ...result.capabilities, hostEnvironmentVersion: 1 } } : result;
    });
    expect(await f.bind()).toHaveProperty('binding.tabId', 7);
  });
  it('inspects a target-only browser document without probing or creating a binding', async () => {
    const f = fixture();
    f.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, targetId: 'physical', url: 'chrome://newtab/' } as any : { tabs: [{ tabId: 7, url: '' }] });
    const preparation = { tabId: 7, targetId: 'physical', url: `chrome-extension://${'a'.repeat(32)}/src/pages/browser-transport/index.html`,
      capabilities: { protocolVersion: 1, navigationOriginVersion: 1, preparationVersion: 1, actions: ['set_timezone'] } };
    f.enhance.mockResolvedValue({ preparation } as any);
    const request = { operation: 'inspect' as const, providerTabId: 11, actions: ['set_timezone' as const], navigationOrigin: 'https://example.test' };
    expect(await f.service.invoke(f.provider.browserId, request)).toEqual({ preparation: { ...preparation, nativeBrowserId: 'native', providerTabId: 11 } });
    expect(f.enhance.mock.calls.map(call => call[2].operation)).toEqual(['inspect']);
    await expect(f.service.invoke(f.provider.browserId, { operation: 'release', bindingId: 'binding', generation: 1 })).rejects.toThrow('BINDING_NOT_FOUND');
    delete (preparation.capabilities as any).preparationVersion;
    await expect(f.service.invoke(f.provider.browserId, request)).rejects.toThrow('BROWSER_ENHANCEMENT_UNSUPPORTED');
    preparation.capabilities.preparationVersion = 1;
    f.request.mockResolvedValueOnce({ tabId: 11, ready: true, mainFrameId: 'main', url: 'chrome://newtab/' });
    await expect(f.service.invoke(f.provider.browserId, request)).rejects.toThrow('physical target');
  });
  it('does not bind from partial discovery when the probe limit is exceeded', async () => {
    const f = fixture();
    f.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, targetId: 'physical', url: 'about:blank' } as any
      : { tabs: Array.from({ length: 129 }, (_, tabId) => ({ tabId, url: '' })) });
    f.enhance.mockImplementation(async (_browser, _provider, data) => ({
      capabilities: { protocolVersion: 1, actions: ['set_timezone'] }, mainFrameId: 'main', targetId: data.tabId === 0 ? 'physical' : 'unrelated',
    }));
    await expect(f.bind()).rejects.toThrow('Too many matching pages');
    expect(f.enhance).toHaveBeenCalledTimes(128);
    expect(f.enhance.mock.calls.every(call => call[2].operation === 'probe')).toBe(true);
  });

  it('continues within a browser after an unrelated browser-owned tab cannot be inspected', async () => {
    const f = fixture();
    f.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, targetId: 'physical', url: 'about:blank' } as any
      : { tabs: [{ tabId: 6, url: '' }, { tabId: 7, url: '' }] });
    const enhance = f.enhance.getMockImplementation()!;
    f.enhance.mockImplementation(async (browser, provider, data) => {
      if (data.tabId === 6) throw new Error('Cannot access a chrome:// URL');
      const result = await enhance(browser, provider, data);
      return 'capabilities' in result ? { ...result, targetId: 'physical' }
        : 'binding' in result ? { binding: { ...result.binding, targetId: 'physical' } } : result;
    });
    expect(await f.bind()).toMatchObject({ binding: { tabId: 7, targetId: 'physical' } });
    const deadline = f.enhance.mock.calls[0]?.[3];
    expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
  });
  it('probes a URL-less browser-owned page only with physical target proof', async () => {
    const f = fixture();
    f.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, targetId: 'target-7', url: 'chrome://newtab/' } as any
      : { tabs: [{ tabId: 7, url: '' }] });
    const enhance = f.enhance.getMockImplementation()!;
    f.enhance.mockImplementation(async (...args) => {
      const result = await enhance(...args);
      if ('capabilities' in result) return { ...result, targetId: 'target-7' };
      if ('binding' in result) return { binding: { ...result.binding, targetId: 'target-7' } };
      return result;
    });
    expect(await f.bind()).toMatchObject({ binding: { targetId: 'target-7', tabId: 7 } });
    const unproven = fixture();
    unproven.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, mainFrameId: 'main', url: 'chrome://newtab/' }
      : { tabs: [{ tabId: 7, url: '' }] });
    await expect(unproven.bind()).rejects.toThrow('UNAVAILABLE');
    expect(unproven.enhance).not.toHaveBeenCalled();
  });

  it('does not bind a URL-less page with another physical target', async () => {
    const f = fixture();
    f.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, targetId: 'another-target', url: 'chrome://newtab/' } as any
      : { tabs: [{ tabId: 7, url: '' }] });
    f.enhance.mockResolvedValueOnce({ capabilities: { protocolVersion: 1, actions: ['set_timezone'] }, mainFrameId: 'main', targetId: 'unrelated' } as any);
    await expect(f.bind()).rejects.toThrow('UNAVAILABLE');
    expect(f.enhance).toHaveBeenCalledOnce();
  });
  it.each(['EXTERNAL_CONTROL_PAUSED: user controls the Space', 'OWNER_CHANGED', 'probe timed out'])('preserves discovery uncertainty without presenting confirmed absence: %s', async message => {
    const f = fixture(); f.enhance.mockRejectedValueOnce(new Error(message));
    await expect(f.bind()).rejects.toThrow(message);
    expect(f.enhance.mock.calls.every(call => call[2].operation === 'probe')).toBe(true);
  });

  it('rejects malformed discovery rather than reporting a missing Extension', async () => {
    const f = fixture(); f.request.mockImplementation(async browser => browser.transport === 'provider'
      ? { tabId: 11, ready: true, mainFrameId: 'main', url: 'https://example.test' } : {} as any);
    await expect(f.bind()).rejects.toThrow('Invalid enhancement discovery response');
  });
  it('matches a metadata-only target proof and rejects missing or changed physical targets', async () => {
    const f = fixture();
    let targetId = 'target-7';
    f.request.mockImplementation(async (browser: BrowserRecord) => browser.transport === 'provider'
      ? { tabId: 11, ready: true, targetId, url: 'https://example.test' } as any
      : { tabs: [{ tabId: 7, url: 'https://example.test' }] });
    await expect(f.bind()).rejects.toThrow('UNAVAILABLE');
    const enhance = f.enhance.getMockImplementation()!;
    f.enhance.mockImplementation(async (...args) => {
      const result = await enhance(...args);
      if ('capabilities' in result) return { ...result, targetId: 'target-7' };
      if ('binding' in result) return { binding: { ...result.binding, targetId: 'target-7' } };
      return result;
    });
    await f.bind(); await f.invoke();
    targetId = 'another-target'; f.enhance.mockClear();
    await expect(f.invoke()).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(f.enhance).not.toHaveBeenCalled();
  });
  it('verifies the main frame and maps only the accepted Provider page to its physical tab', async () => {
    const f = fixture();
    expect(await f.bind()).toMatchObject({ binding: { providerTabId: 11, tabId: 7, nativeBrowserId: 'native' } });
    await f.invoke();
    expect(f.enhance).toHaveBeenLastCalledWith(f.native, f.provider,
      expect.objectContaining({ operation: 'invoke', owner: f.provider.browserId, data: { tabId: 7, timezone: 'UTC' } }), undefined, 11);
  });

  it('does not bind solely because the URL matches', async () => {
    const f = fixture(); f.state.frameId = 'other-frame';
    await expect(f.bind()).rejects.toThrow('BROWSER_ENHANCEMENT_UNAVAILABLE');
    expect(f.enhance.mock.calls.every(call => call[2].operation === 'probe')).toBe(true);
  });

  it('rechecks the Provider page after discovery and before each mutation', async () => {
    const f = fixture();
    await f.bind(); f.enhance.mockClear(); f.state.frameId = 'new-page';
    await expect(f.invoke()).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(f.enhance).not.toHaveBeenCalled();
  });

  it('requires rebind when the physical host has reconnected', async () => {
    const f = fixture(); await f.bind(); f.enhance.mockClear();
    f.native.pid = 3;
    await expect(f.invoke()).rejects.toThrow('native host changed');
    expect(f.enhance).not.toHaveBeenCalled();
  });

  it('does not let a restarted Provider inherit an earlier source binding before or after rebind', async () => {
    const f = fixture(); await f.bind();
    const old = f.state.bindingId;
    f.provider.pid = 99;
    await expect(f.invoke()).rejects.toThrow('BINDING_NOT_FOUND');
    await f.bind();
    expect(f.state.bindingId).not.toBe(old);
    await expect(f.service.invoke(f.provider.browserId, { operation: 'release', bindingId: old, generation: 1 })).rejects.toThrow('BINDING_NOT_FOUND');
    await expect(f.invoke()).resolves.toMatchObject({ result: { enabled: true } });
  });

  it('quarantines a failed mutation until explicit re-verification and binding', async () => {
    const f = fixture(); await f.bind();
    f.enhance.mockRejectedValueOnce(new Error('receipt lost'));
    await expect(f.invoke()).rejects.toThrow('receipt lost');
    const count = f.enhance.mock.calls.length;
    await expect(f.invoke()).rejects.toThrow('ENVIRONMENT_UNCONFIRMED');
    expect(f.enhance).toHaveBeenCalledTimes(count);
    await f.bind(); await expect(f.invoke()).resolves.toMatchObject({ result: { enabled: true } });
  });

  it('rejects simultaneous mutations rather than dispatching another write behind an uncertain result', async () => {
    const f = fixture(); await f.bind();
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.enhance.mockImplementationOnce(async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; }); return { result: {} };
    });
    const first = f.invoke(); await entered;
    try { await expect(f.invoke()).rejects.toThrow('BROWSER_ENHANCEMENT_BUSY'); }
    finally { finish(); await first; }
  });

  it('does not replace a binding while re-verification overlaps a mutation', async () => {
    const f = fixture(); await f.bind();
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.enhance.mockImplementationOnce(async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      return { capabilities: { protocolVersion: 1, actions: ['set_timezone'] }, mainFrameId: 'main' };
    });
    const rebinding = f.bind(); await entered;
    try { await expect(f.invoke()).rejects.toThrow('BROWSER_ENHANCEMENT_BUSY'); }
    finally { finish(); await rebinding; }
    await expect(f.invoke()).resolves.toMatchObject({ result: { enabled: true } });
  });

  it('quarantines malformed mutation replies at the broker, not just in one client', async () => {
    const f = fixture(); await f.bind();
    f.enhance.mockResolvedValueOnce({ released: true });
    await expect(f.invoke()).rejects.toThrow('Invalid enhancement invocation response');
    const count = f.enhance.mock.calls.length;
    await expect(f.invoke()).rejects.toThrow('ENVIRONMENT_UNCONFIRMED');
    expect(f.enhance).toHaveBeenCalledTimes(count);
  });

  it('does not let an unrelated browser denial hide a verified matching browser', async () => {
    const f = fixture();
    const unrelated = { ...f.native, browserId: 'unrelated', pid: 4 };
    f.browsers.unshift(unrelated);
    const implementation = f.enhance.getMockImplementation()!;
    f.enhance.mockImplementation(async (browser, provider, data) => {
      if (browser === unrelated) throw new Error('BROWSER_ENHANCEMENT_PERMISSION_DENIED: denied');
      return implementation(browser, provider, data);
    });
    expect(await f.bind()).toMatchObject({ binding: { nativeBrowserId: 'native' } });
  });

  it('preserves explicit permission denial when no matching authorized backend exists', async () => {
    const f = fixture(); f.enhance.mockRejectedValue(new Error('BROWSER_ENHANCEMENT_AGENT_DISABLED: disabled'));
    await expect(f.bind()).rejects.toThrow('BROWSER_ENHANCEMENT_AGENT_DISABLED');
  });

  it('reserves the final cache slot across simultaneous binds for different pages', async () => {
    const f = fixture();
    f.request.mockImplementation(async (browser, _action?: string, data?: any) => browser.transport === 'provider'
      ? { tabId: data.tabId, ready: true, mainFrameId: 'main', url: 'https://example.test' }
      : { tabs: [{ tabId: 7, url: 'https://example.test' }] });
    const bind = (providerTabId: number) => f.service.invoke(f.provider.browserId, { operation: 'bind', providerTabId, actions: ['set_timezone'] });
    for (let page = 0; page < 511; page++) await bind(page);
    const implementation = f.enhance.getMockImplementation()!;
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.enhance.mockImplementation(async (browser, provider, request) => {
      if (request.operation === 'bind') { entered(); await new Promise<void>(resolve => { finish = resolve; }); }
      return implementation(browser, provider, request);
    });
    const last = bind(511); await started;
    try { await expect(bind(512)).rejects.toThrow('binding limit'); }
    finally { finish(); await last; }
    expect(f.enhance.mock.calls.filter(call => call[2].operation === 'bind')).toHaveLength(512);
  });
});
