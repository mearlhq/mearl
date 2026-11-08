import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEnhancementBinding, BrowserEnhancementRequest } from '@mearl/browser-core';

const state = vi.hoisted(() => ({
  agent: null as string | null, settings: null as string | null,
  revision: 0, frameId: 'main-frame', drift: null as string | null,
  persistedSettings: null as string | null, settingsKnown: false,
  frames: vi.fn(), setTimezone: vi.fn(), release: vi.fn(),
}));
vi.mock('../browserEnhancementEnvironments', () => ({
  appDeviceEnvironmentHost: vi.fn(() => { throw new Error('Timezone must not start an App/device adapter'); }),
  invokeAppDeviceEnvironment: vi.fn(() => { throw new Error('Timezone must not start an App/device adapter'); }),
}));
vi.mock('../debuggerSessionManager', () => ({
  acquireDebuggerLease: async () => ({ release: state.release }),
}));
vi.mock('../debuggerManager', () => ({
  recordHostEnvironmentObservation: vi.fn(),
  getTabState: () => ({ timezoneOverrides: { agent: state.agent ?? undefined, settings: state.settings ?? undefined } }),
  restoreRecordedTimezoneOwnership: (_tabId: number, timezone: string) => { state.agent = timezone; },
  hydrateRecordedTimezoneSettings: (_tabId: number, timezone?: string) => {
    if (!state.settingsKnown) { state.settings = timezone ?? null; state.settingsKnown = true; }
  },
}));
vi.mock('../tabPageOverrides', () => ({ getTabPageOverrides: async () => ({ customTimezone: state.persistedSettings ?? '' }) }));
vi.mock('../environmentRevisions', () => ({ getEnvironmentRevision: async () => state.revision }));
vi.mock('../agentHandlers/snapshotHandlers', () => ({ handlePageFrames: state.frames }));
vi.mock('../agentHandlers/timezoneHandlers', () => ({ handleSetTimezone: state.setTimezone }));

const values: Record<string, unknown> = {};
const authorize = vi.fn(async () => {});
beforeEach(() => {
  Object.assign(state, { agent: null, settings: null, revision: 0, frameId: 'main-frame', drift: null, persistedSettings: null, settingsKnown: false });
  state.frames.mockImplementation(async () => ({ frames: [{ frameId: state.frameId, isMainFrame: true }] }));
  state.setTimezone.mockImplementation(async ({ timezone }: { timezone: string }) => {
    state.agent = timezone || null; state.revision++;
    return { enabled: Boolean(timezone), timezone: state.agent };
  });
  chrome.debugger = { getTargets: vi.fn(async () => [{ tabId: 7, type: 'page', id: 'target-7' }]), sendCommand: vi.fn(async (_target, method) => method === 'Page.createIsolatedWorld'
    ? { executionContextId: 42 }
    : { result: { value: state.drift ?? new Intl.DateTimeFormat('en', state.agent || state.settings ? { timeZone: (state.agent || state.settings)! } : {}).resolvedOptions().timeZone } }) } as any;
  chrome.storage.session = {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (next: object) => Object.assign(values, structuredClone(next))),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  } as any;
});
afterEach(() => {
  Object.keys(values).forEach(key => delete values[key]);
  vi.clearAllMocks(); vi.resetModules();
});

async function run(request: BrowserEnhancementRequest) {
  return (await import('../browserEnhancements')).handleBrowserEnhancement(request, authorize);
}
async function bind(owner = 'provider:space'): Promise<BrowserEnhancementBinding> {
  const result = await run({ operation: 'bind', owner, tabId: 7, mainFrameId: 'main-frame', actions: ['set_timezone'] });
  if (!('binding' in result)) throw new Error('Expected binding');
  return result.binding;
}
async function set(binding: BrowserEnhancementBinding, timezone = 'Europe/Paris') {
  return run({ operation: 'invoke', owner: 'provider:space', bindingId: binding.bindingId, generation: binding.generation,
    action: 'set_timezone', data: { tabId: 7, timezone } });
}
async function release(binding: BrowserEnhancementBinding) {
  return run({ operation: 'release', owner: 'provider:space', bindingId: binding.bindingId, generation: binding.generation });
}

describe('scoped browser enhancements', () => {
  it('authorizes a same-target preparation page without frames, debugger commands or environment records', async () => {
    const url = `chrome-extension://${'a'.repeat(32)}/src/pages/browser-transport/index.html`;
    chrome.runtime.getURL = vi.fn(() => url);
    const request = { operation: 'inspect' as const, owner: 'provider:space', tabId: 7, targetId: 'target-7', actions: ['set_app_profile' as const], navigationOrigin: 'https://example.test' };
    expect(await run(request)).toMatchObject({ preparation: { tabId: 7, targetId: 'target-7', url, capabilities: { preparationVersion: 1 } } });
    expect(authorize).toHaveBeenCalledWith(7, 'set_app_profile', 'https://example.test');
    expect(state.frames).not.toHaveBeenCalled(); expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    expect(chrome.storage.session.set).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
  });
  it('rejects inspection identity changes and permission failures without acquiring a page session', async () => {
    const request = { operation: 'inspect' as const, owner: 'provider:space', tabId: 7, targetId: 'other', actions: ['set_app_profile' as const], navigationOrigin: 'https://example.test' };
    await expect(run(request)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(authorize).not.toHaveBeenCalled();
    authorize.mockRejectedValueOnce(new Error('permission denied'));
    await expect(run({ ...request, targetId: 'target-7' })).rejects.toThrow('permission denied');
    authorize.mockImplementationOnce(async () => { chrome.debugger.getTargets = vi.fn(async () => [{ tabId: 7, type: 'page', id: 'replacement' }]) as any; });
    await expect(run({ ...request, targetId: 'target-7' })).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(state.frames).not.toHaveBeenCalled(); expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });
  it('upgrades an existing frame-only binding without losing its active component journal', async () => {
    const original = await bind(); await set(original);
    const result = await run({ operation: 'bind', owner: 'provider:space', tabId: 7,
      mainFrameId: 'main-frame', targetId: 'target-7', actions: ['set_timezone'] });
    if (!('binding' in result)) throw new Error('Expected binding');
    expect(result.binding).toMatchObject({ bindingId: original.bindingId, targetId: 'target-7', generation: original.generation + 1 });
    await expect(release(original)).rejects.toThrow('BINDING_NOT_FOUND');
    expect(await release(result.binding)).toEqual({ released: true });
    expect(state.agent).toBeNull();
  });
  it('returns the physical target ID and fences target-backed bindings before any effect', async () => {
    expect(await run({ operation: 'probe', tabId: 7 })).toMatchObject({ targetId: 'target-7' });
    const request = { operation: 'bind' as const, owner: 'provider:space', tabId: 7, mainFrameId: 'main-frame', targetId: 'wrong', actions: ['set_timezone' as const] };
    await expect(run(request)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    const result = await run({ ...request, targetId: 'target-7' });
    if (!('binding' in result)) throw new Error('Expected binding');
    vi.mocked(chrome.debugger.getTargets).mockResolvedValue([{ tabId: 7, type: 'page', id: 'new-target' }] as any);
    await expect(set(result.binding)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(state.setTimezone).not.toHaveBeenCalled();
  });
  it('probes only verified support and reuses a matching page binding without changing its state', async () => {
    expect(await run({ operation: 'probe', tabId: 7 })).toMatchObject({ capabilities: { actions: expect.arrayContaining(['set_timezone']) }, mainFrameId: 'main-frame' });
    const first = await bind();
    expect(await bind()).toEqual(first);
    expect(state.setTimezone).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(7, 'set_timezone', undefined);
  });

  it('restores its agent override while preserving settings changed underneath it', async () => {
    const binding = await bind();
    await set(binding);
    state.settings = 'America/New_York';
    expect(await release(binding)).toEqual({ released: true });
    expect(state.agent).toBeNull();
    expect(state.settings).toBe('America/New_York');
    expect(values['browserEnhancement:7']).toBeUndefined();
  });

  it('rejects a non-default external baseline before writing or claiming recovery authority', async () => {
    const binding = await bind();
    state.drift = Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/New_York' ? 'Europe/Paris' : 'America/New_York';
    await expect(set(binding)).rejects.toThrow('ENVIRONMENT_BASELINE_UNSUPPORTED');
    expect(state.setTimezone).not.toHaveBeenCalled();
    expect(await release(binding)).toEqual({ released: true });
    expect(state.drift).toBeTruthy();
  });

  it.each(['agent', 'settings'] as const)('restores canonical timezone aliases for %s', async source => {
    state[source] = 'US/Eastern';
    if (source === 'settings') state.persistedSettings = 'US/Eastern';
    const binding = await bind();
    await set(binding);
    expect(await release(binding)).toEqual({ released: true });
    expect(state[source]).toBe('US/Eastern');
  });

  it.each(['revision', 'drift'] as const)('preserves later %s changes instead of clearing them', async kind => {
    const binding = await bind();
    await set(binding);
    if (kind === 'revision') state.revision++; else state.drift = 'UTC';
    expect(await release(binding)).toEqual({ released: false, conflicts: ['timezone:changed'] });
    expect(state.setTimezone).toHaveBeenCalledOnce();
    expect(values['browserEnhancement:7']).toBeDefined();
  });

  it('checks permission and physical page identity again before each write', async () => {
    const binding = await bind();
    authorize.mockRejectedValueOnce(new Error('domain denied'));
    await expect(set(binding)).rejects.toThrow('domain denied');
    state.frameId = 'different-page';
    await expect(set(binding)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
    expect(state.setTimezone).not.toHaveBeenCalled();
  });

  it('does not retarget an invocation or accept a stale generation/owner', async () => {
    const binding = await bind();
    await expect(set({ ...binding, generation: 2 })).rejects.toThrow('ENVIRONMENT_BINDING_NOT_FOUND');
    await expect(bind('other-owner')).rejects.toThrow('ENVIRONMENT_OWNER_CONFLICT');
    await expect(run({ operation: 'invoke', owner: 'provider:space', ...binding, action: 'set_timezone', data: { tabId: 8, timezone: 'UTC' } })).rejects.toThrow('cannot change');
    expect(state.setTimezone).not.toHaveBeenCalled();
  });

  it('retains the recovery record on a failed write and requires verification after worker restart', async () => {
    const binding = await bind();
    state.setTimezone.mockRejectedValueOnce(new Error('receipt lost'));
    await expect(set(binding)).rejects.toThrow('receipt lost');
    expect(await release(binding)).toEqual({ released: false, conflicts: ['timezone:unconfirmed'] });
    vi.resetModules();
    await expect(bind()).rejects.toThrow('ENVIRONMENT_BINDING_RECOVERY_REQUIRED');
    expect(values['browserEnhancement:7']).toBeDefined();
  });

  it('safely reconnects an empty binding after a worker restart', async () => {
    const first = await bind();
    vi.resetModules();
    const recovered = await bind();
    expect(recovered.bindingId).toBe(first.bindingId);
    expect(recovered.generation).toBe(first.generation + 1);
    expect(state.setTimezone).not.toHaveBeenCalled();
    expect(await release(recovered)).toEqual({ released: true });
  });

  it('re-associates a matching persisted effect without replaying its browser write', async () => {
    const first = await bind();
    await set(first);
    vi.resetModules();
    state.agent = null;
    state.drift = 'Europe/Paris';
    const recovered = await bind();
    expect(recovered.generation).toBe(first.generation + 1);
    expect(state.agent).toBe('Europe/Paris');
    expect(state.setTimezone).toHaveBeenCalledOnce();
    state.drift = null;
    expect(await release(recovered)).toEqual({ released: true });
  });

  it.each(['US/Eastern', 'America/Los_Angeles'])('recovers the latest saved settings %s when all worker timezone metadata was lost', async latest => {
    state.persistedSettings = 'US/Eastern';
    const first = await bind();
    await set(first);
    state.persistedSettings = latest;
    vi.resetModules();
    Object.assign(state, { agent: null, settings: null, settingsKnown: false, drift: 'Europe/Paris' });
    const recovered = await bind();
    expect(state.setTimezone).toHaveBeenCalledOnce();
    expect(state.settings).toBe(latest);
    state.drift = null;
    expect(await release(recovered)).toEqual({ released: true });
    expect(state.settings).toBe(latest);
    expect(state.agent).toBeNull();
  });

  it('clears confirmed-destroyed bindings and allows the page slot to be reused', async () => {
    const first = await bind();
    await (await import('../browserEnhancements')).cleanupBrowserEnhancements(7, { closed: true });
    expect(values['browserEnhancement:7']).toBeUndefined();
    expect((await bind()).bindingId).not.toBe(first.bindingId);
  });

  it('uses an isolated world to observe the timezone', async () => {
    const binding = await bind();
    await set(binding);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Runtime.evaluate', expect.objectContaining({ contextId: 42 }));
  });

  it('does not enqueue a private write behind an existing UI environment update', async () => {
    const binding = await bind();
    const queue = await import('../quickSimulationUpdateQueue');
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const ui = queue.runSerializedQuickSimulationUpdate(7, async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
    });
    await entered;
    try { await expect(set(binding)).rejects.toThrow('BROWSER_ENHANCEMENT_BUSY'); }
    finally { finish(); await ui; }
    expect(state.setTimezone).not.toHaveBeenCalled();
  });

  it('does not begin an effect after the absolute deadline expires during preparation', async () => {
    const binding = await bind();
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(chrome.storage.session.set).mockImplementationOnce(async next => {
      Object.assign(values, structuredClone(next)); now = 1200;
    });
    try {
      await expect(run({ operation: 'invoke', owner: 'provider:space', bindingId: binding.bindingId, generation: 1,
        action: 'set_timezone', data: { tabId: 7, timezone: 'UTC' }, deadline: 1100 })).rejects.toThrow('deadline exceeded');
      expect(state.setTimezone).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
});
