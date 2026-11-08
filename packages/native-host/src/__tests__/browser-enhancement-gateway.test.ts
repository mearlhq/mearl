import { describe, expect, it, vi } from 'vitest';
import { DomainPermissionError, type BrowserEnhancementRequest } from '@mearl/browser-core';
import { BrowserEnhancementGateway } from '../browser-enhancement-gateway.js';
import { ControlSessionRegistry } from '../control-session.js';
import type { BrowserRecord } from '../browser-registry.js';
import { browserConnectionIdentity } from '../browser-registry.js';

function fixture() {
  const provider = {
    pid: 123, startedAt: 'start', socketPath: '/provider.sock', browserId: 'provider:fixture:space',
    transport: 'provider', provider: { id: 'fixture', protocolVersion: 3 },
    status: 'connected',
    capabilities: { controlSessionMode: 'external', actions: ['page_frames'], screenshot: 'none' },
  } as BrowserRecord;
  const browsers = [provider];
  const registry = new ControlSessionRegistry(() => 'native');
  const host = { pid: 345, socketPath: '/control.sock', ready: true, token: 'proof', enhancementProtocolVersion: 1 };
  const verify = vi.fn(async () => ({ tabId: 11, ready: true as const, mainFrameId: 'main', url: 'https://example.test' }));
  const tabs = vi.fn(async () => [7]);
  const invoke = vi.fn(async (request: BrowserEnhancementRequest) => request.operation === 'bind'
    ? { binding: { bindingId: 'binding', generation: 1, tabId: 7, mainFrameId: 'main', actions: ['set_timezone'] } }
    : { released: true });
  const gateway = new BrowserEnhancementGateway({
    browsers: () => browsers,
    controlHost: () => host as any,
    available: () => true,
    tabs,
    verifySource: verify,
    run: (action, data, work) => registry.run(undefined, action, data, work),
    invoke: invoke as any,
  });
  const call = (request: BrowserEnhancementRequest, proof = 'proof', deadline?: number) =>
    gateway.invoke(provider.browserId, proof, request, deadline, browserConnectionIdentity(provider), 11);
  const bind: BrowserEnhancementRequest = {
    operation: 'bind', owner: provider.browserId, tabId: 7, mainFrameId: 'main', actions: ['set_timezone'],
  };
  return { gateway, provider, browsers, registry, invoke, call, bind, host, verify, tabs };
}

describe('native enhancement trust and control boundary', () => {
  it('reverifies inspection target proof before dispatch without accepting a binding', async () => {
    const f = fixture(), url = `chrome-extension://${'a'.repeat(32)}/src/pages/browser-transport/index.html`;
    const request: BrowserEnhancementRequest = { operation: 'inspect', owner: f.provider.browserId, tabId: 7, targetId: 'physical', actions: ['set_app_profile'], navigationOrigin: 'https://example.test' };
    await expect(f.call(request)).rejects.toThrow('cannot negotiate');
    Object.assign(f.host, { enhancementPreparationVersion: 1 });
    f.verify.mockResolvedValue({ tabId: 11, ready: true, targetId: 'other', url: 'chrome://newtab/' } as any);
    await expect(f.call(request)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(f.invoke).not.toHaveBeenCalled();
    f.verify.mockResolvedValue({ tabId: 11, ready: true, targetId: 'physical', url: 'chrome://newtab/' } as any);
    f.invoke.mockResolvedValue({ preparation: { tabId: 7, targetId: 'physical', url, capabilities: { protocolVersion: 1, preparationVersion: 1, actions: ['set_app_profile'] } } } as any);
    expect(await f.call(request)).toHaveProperty('preparation.url', url);
    expect(f.registry.list()).toEqual([]);
    await expect(f.call({ operation: 'release', owner: f.provider.browserId, bindingId: 'binding', generation: 1 })).rejects.toThrow('BINDING_NOT_FOUND');
    f.invoke.mockRejectedValue(new Error('Invalid browser enhancement request'));
    await expect(f.call(request)).rejects.toThrow('BROWSER_ENHANCEMENT_UNSUPPORTED');
  });
  it('takes initial environments only from the reverified external owner, never from request payloads', async () => {
    const f = fixture();
    const device = { userAgent: 'Host', platform: 'Host', userAgentMetadata: null,
      screen: { width: 1920, height: 1080, deviceScaleFactor: 1, orientation: 'landscape-primary', angle: 0 },
      touchPoints: 0, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    await f.call({ ...f.bind, initialEnvironment: { device, preserveHostPlatform: true } });
    expect(f.invoke).toHaveBeenLastCalledWith(f.bind, undefined);
    f.verify.mockResolvedValue({ tabId: 11, ready: true, mainFrameId: 'main', url: 'https://example.test', initialEnvironment: { device } } as any);
    await f.call({ ...f.bind, initialEnvironment: { device: { ...device, userAgent: 'Caller forged' } } });
    expect(f.invoke).toHaveBeenLastCalledWith({ ...f.bind, initialEnvironment: { device } }, undefined);
    f.verify.mockResolvedValue({ tabId: 11, ready: true, mainFrameId: 'main', url: 'https://example.test', initialEnvironment: { device, preserveHostPlatform: true } } as any);
    f.invoke.mockClear();
    await expect(f.call(f.bind)).rejects.toThrow('cannot preserve the captured host environment');
    expect(f.invoke).not.toHaveBeenCalled();
    Object.assign(f.host, { enhancementHostEnvironmentVersion: 1 });
    await f.call({ ...f.bind, initialEnvironment: { device } });
    expect(f.invoke).toHaveBeenLastCalledWith({ ...f.bind, initialEnvironment: { device, preserveHostPlatform: true } }, undefined);
  });
  it('verifies metadata-only source targets at the physical mutation boundary', async () => {
    const f = fixture();
    f.verify.mockResolvedValue({ tabId: 11, ready: true, targetId: 'target-7', url: 'https://example.test' } as any);
    await expect(f.call(f.bind)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    const bind = { ...f.bind, targetId: 'target-7' };
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async request => {
      const result = await invoke(request);
      return 'binding' in result ? { binding: { ...result.binding, targetId: 'target-7' } } : result;
    });
    await f.call(bind);
    f.verify.mockResolvedValue({ tabId: 11, ready: true, targetId: 'other', url: 'https://example.test' } as any);
    f.invoke.mockClear();
    await expect(f.call({ operation: 'release', owner: f.provider.browserId, bindingId: 'binding', generation: 1 })).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('accepts the control host proof without claiming an automation session', async () => {
    const f = fixture();
    expect(await f.call(f.bind)).toMatchObject({ binding: { tabId: 7 } });
    expect(f.registry.list()).toEqual([]);
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith(f.bind, undefined);
  });

  it('rejects forged trust, owner and connection identity before Extension dispatch', async () => {
    const f = fixture();
    await expect(f.call(f.bind, 'wrong')).rejects.toThrow('UNTRUSTED_HOST');
    await expect(f.call({ ...f.bind, owner: 'other' } as any)).rejects.toThrow('OWNER_CONFLICT');
    await expect(f.gateway.invoke(f.provider.browserId, 'proof', f.bind, undefined, 'stale', 11)).rejects.toThrow('OWNER_CHANGED');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('respects existing Mearl sessions on the physical page', async () => {
    const f = fixture();
    const session = f.registry.create('extension');
    f.registry.claim(session.sessionId, 7, 'attached');
    await expect(f.call(f.bind)).rejects.toThrow('TAB_CONTROLLED_BY_SESSION');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('cannot turn the narrow binding into a page-input or different-page action', async () => {
    const f = fixture();
    await f.call(f.bind);
    f.invoke.mockClear();
    const request = { operation: 'invoke', owner: f.provider.browserId, bindingId: 'binding', generation: 1, action: 'set_timezone', data: { tabId: 8, timezone: 'UTC' } };
    await expect(f.call(request as any)).rejects.toThrow('SCOPE_MISMATCH');
    await expect(f.call({ ...request, action: 'page_eval', data: { tabId: 7, expression: '42' } } as any)).rejects.toThrow('SCOPE_MISMATCH');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('checks deadlines again after waiting for a physical-page operation', async () => {
    const f = fixture();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const first = f.registry.run(undefined, 'set_timezone', { tabId: 7 }, async () => gate);
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const next = f.call(f.bind, 'proof', 1200);
      const rejected = expect(next).rejects.toThrow('deadline exceeded');
      now = 1300; finish(); await first; await rejected;
      expect(f.invoke).not.toHaveBeenCalled();
    } finally { finish(); clock.mockRestore(); }
  });

  it('does not let a retired Provider dispatch a queued operation', async () => {
    const f = fixture();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const first = f.registry.run(undefined, 'set_timezone', { tabId: 7 }, async () => gate);
    const next = f.call(f.bind);
    const rejected = expect(next).rejects.toThrow('OWNER_CHANGED');
    f.browsers[0] = { ...f.provider, pid: 456 };
    finish(); await first; await rejected;
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('rechecks the issuing host after waiting for the physical page', async () => {
    const f = fixture();
    let finish!: () => void;
    const first = f.registry.run(undefined, 'set_timezone', { tabId: 7 }, () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    const next = f.call(f.bind);
    const rejected = expect(next).rejects.toThrow('UNTRUSTED_HOST');
    f.host.token = 'replacement';
    finish(); await first; await rejected;
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('checks external control again at the front of the physical page queue', async () => {
    const f = fixture();
    let finish!: () => void;
    const first = f.registry.run(undefined, 'set_timezone', { tabId: 7 }, () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    const next = f.call(f.bind);
    const rejected = expect(next).rejects.toThrow('EXTERNAL_CONTROL_PAUSED');
    f.verify.mockResolvedValueOnce({ tabId: 11, ready: false } as any);
    finish(); await first; await rejected;
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('passes the full physical payload to shared-resource conflict checks', async () => {
    const f = fixture();
    f.invoke.mockResolvedValueOnce({ binding: { bindingId: 'binding', generation: 1, tabId: 7, mainFrameId: 'main', actions: ['set_app_profile'] } } as any);
    await f.call({ ...f.bind, actions: ['set_app_profile'] } as any);
    const session = f.registry.create('extension');
    f.registry.claim(session.sessionId, 8, 'attached');
    f.invoke.mockClear();
    await expect(f.call({ operation: 'invoke', owner: f.provider.browserId, bindingId: 'binding', generation: 1,
      action: 'set_app_profile', data: { tabId: 7, enabled: false, networkControl: { id: 'environment', value: 'pre' } } })).rejects.toThrow('BROWSER_RESOURCE_CONFLICT');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('requires explicit rebind before a new Provider process can use a prior physical binding', async () => {
    const f = fixture(); await f.call(f.bind);
    f.browsers[0] = { ...f.provider, pid: 456 };
    const release = { operation: 'release', owner: f.provider.browserId, bindingId: 'binding', generation: 1 } as const;
    const sourceIdentity = browserConnectionIdentity(f.browsers[0]!);
    await expect(f.gateway.invoke(f.provider.browserId, 'proof', release, undefined, sourceIdentity, 11)).rejects.toThrow('BINDING_NOT_FOUND');
    await f.gateway.invoke(f.provider.browserId, 'proof', f.bind, undefined, sourceIdentity, 11);
    expect(await f.gateway.invoke(f.provider.browserId, 'proof', release, undefined, sourceIdentity, 11)).toEqual({ released: true });
  });

  it('keeps permission and Agent-service rejection distinguishable from missing support', async () => {
    const f = fixture();
    f.invoke.mockRejectedValueOnce(new DomainPermissionError('set_timezone', 'example.test'));
    await expect(f.call(f.bind)).rejects.toThrow('BROWSER_ENHANCEMENT_PERMISSION_DENIED');
    f.invoke.mockRejectedValueOnce(new Error('Agent service is disabled'));
    await expect(f.call(f.bind)).rejects.toThrow('BROWSER_ENHANCEMENT_AGENT_DISABLED');
  });

  it('bounds cached bindings and retires only confirmed closed page metadata', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async request => request.operation === 'bind' ? { binding: {
      bindingId: `binding-${request.tabId}`, generation: 1, tabId: request.tabId, mainFrameId: 'main', actions: ['set_timezone'],
    } } : { released: true });
    const bind = (tabId: number) => f.call({ ...f.bind, tabId } as any);
    for (let tabId = 0; tabId < 512; tabId++) await bind(tabId);
    f.tabs.mockResolvedValueOnce(Array.from({ length: 512 }, (_, index) => index));
    await expect(bind(512)).rejects.toThrow('binding limit');
    expect(f.invoke).toHaveBeenCalledTimes(512);
    f.tabs.mockResolvedValueOnce([511]);
    await expect(bind(512)).resolves.toMatchObject({ binding: { tabId: 512 } });
    await expect(f.call({ operation: 'release', owner: f.provider.browserId, bindingId: 'binding-0', generation: 1 })).rejects.toThrow('BINDING_NOT_FOUND');
    expect(f.invoke.mock.calls.every(([request]) => request.operation === 'bind')).toBe(true);
  });

  it('reserves the last cache slot before concurrent physical bind effects', async () => {
    const f = fixture();
    const response = (tabId: number) => ({ binding: { bindingId: `binding-${tabId}`, generation: 1, tabId, mainFrameId: 'main', actions: ['set_timezone'] } });
    f.invoke.mockImplementation(async request => response((request as any).tabId) as any);
    const bind = (tabId: number) => f.call({ ...f.bind, tabId } as any);
    for (let tabId = 0; tabId < 511; tabId++) await bind(tabId);
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.invoke.mockImplementationOnce(async request => {
      entered(); await new Promise<void>(resolve => { finish = resolve; });
      return response((request as any).tabId) as any;
    });
    const last = bind(511); await started;
    try { await expect(bind(512)).rejects.toThrow('binding limit'); }
    finally { finish(); await last; }
    expect(f.invoke).toHaveBeenCalledTimes(512);
  });
});
