import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TAB_PAGE_OVERRIDES,
  tabPageOverridesStorageKey,
} from '../../../shared/tabPageOverrides';

const debuggerMocks = vi.hoisted(() => ({
  enableTimezoneForTab: vi.fn(async () => undefined),
  disableTimezoneForTab: vi.fn(async () => undefined),
}));
const timeMocks = vi.hoisted(() => ({
  enableTimeForTab: vi.fn(async () => ({ offsetMs: 5_000, revision: 1 })),
  disableTimeForTab: vi.fn(async () => ({ offsetMs: null, revision: 2 })),
  getTimeOverrideForTab: vi.fn(
    async (): Promise<{ offsetMs: number | null; revision: number } | null> => null,
  ),
  sendTimeOverrideForTab: vi.fn(async () => undefined),
}));

vi.mock('../debuggerManager', () => debuggerMocks);
vi.mock('../pageTimeOverride', () => timeMocks);
vi.mock('../contentScriptRegistrar', () => ({ ensureContentScriptsForOrigins: vi.fn() }));
vi.mock('../frameMessaging', () => ({ getTabFrameIds: async () => [0, 2] }));

interface SessionRuleUpdate {
  removeRuleIds?: number[];
  addRules?: chrome.declarativeNetRequest.Rule[];
}

describe('per-tab page overrides', () => {
  let storedValues: Record<string, unknown>;
  let sessionRules: Map<number, chrome.declarativeNetRequest.Rule>;
  let overridesModule: typeof import('../tabPageOverrides');

  beforeEach(async () => {
    storedValues = {};
    sessionRules = new Map();
    vi.clearAllMocks();

    chrome.tabs = { get: vi.fn(async () => ({ url: 'https://example.test/' })) } as any;
    chrome.permissions = {
      contains: vi.fn(async () => true),
      getAll: vi.fn(async () => ({ origins: ['https://example.test/*'] })),
      request: vi.fn(async () => true),
    } as any;
    chrome.scripting = { executeScript: vi.fn(async () => [{ result: true }]) } as any;
    chrome.storage.session = {
      get: vi.fn(async (key: string) => ({ [key]: storedValues[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(storedValues, values);
      }),
      remove: vi.fn(async (key: string) => {
        delete storedValues[key];
      }),
    } as unknown as typeof chrome.storage.session;
    chrome.declarativeNetRequest = {
      getSessionRules: vi.fn(async () => [...sessionRules.values()]),
      updateSessionRules: vi.fn(async (update: SessionRuleUpdate) => {
        for (const id of update.removeRuleIds ?? []) sessionRules.delete(id);
        for (const rule of update.addRules ?? []) sessionRules.set(rule.id, rule);
      }),
    } as unknown as typeof chrome.declarativeNetRequest;

    vi.resetModules();
    overridesModule = await import('../tabPageOverrides');
  });

  it('returns clean defaults for a new tab without applying another tab state', async () => {
    storedValues[tabPageOverridesStorageKey(11)] = {
      customUserAgent: 'Tab 11 UA',
      customUserAgentEnabled: true,
      customTimezone: 'Asia/Tokyo',
      customTime: 1_787_272_260_000,
    };

    await expect(overridesModule.getTabPageOverrides(12)).resolves.toEqual(
      DEFAULT_TAB_PAGE_OVERRIDES,
    );
    await overridesModule.ensureTabPageOverridesApplied(12);

    expect(debuggerMocks.enableTimezoneForTab).not.toHaveBeenCalled();
    expect(timeMocks.enableTimeForTab).not.toHaveBeenCalled();
    expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled();
  });

  it('stores and applies UA, timezone, and time only to the selected tab', async () => {
    const customTime = 1_787_272_260_000;
    await overridesModule.updateTabPageOverrides(21, {
      customUserAgent: 'Tab 21 UA',
      customUserAgentEnabled: true,
      customTimezone: 'Asia/Tokyo',
      customTime,
    });

    await expect(overridesModule.getTabPageOverrides(21)).resolves.toEqual({
      customUserAgent: 'Tab 21 UA',
      customUserAgentEnabled: true,
      customTimezone: 'Asia/Tokyo',
      customTime,
    });
    await expect(overridesModule.getTabPageOverrides(22)).resolves.toEqual(
      DEFAULT_TAB_PAGE_OVERRIDES,
    );
    expect(debuggerMocks.enableTimezoneForTab).toHaveBeenCalledWith(21, 'Asia/Tokyo', 'settings');
    expect(timeMocks.enableTimeForTab).toHaveBeenCalledWith(21, customTime, false);
    expect(timeMocks.sendTimeOverrideForTab).toHaveBeenCalledWith(21, {
      offsetMs: 5_000,
      revision: 1,
    });

    const rules = [...sessionRules.values()];
    const configRule = rules.find(rule => rule.action.responseHeaders?.length);
    const uaRule = rules.find(rule => rule.action.requestHeaders?.length);
    expect(configRule?.condition.tabIds).toEqual([21]);
    expect(uaRule?.condition.tabIds).toEqual([21]);
    expect(uaRule?.action.requestHeaders?.[0]?.value).toBe('Tab 21 UA');
    const encoded = /desc="([^"]+)"/.exec(
      configRule?.action.responseHeaders?.[0]?.value ?? '',
    )?.[1];
    expect(JSON.parse(decodeURIComponent(escape(atob(encoded ?? ''))))).toEqual({
      ua: 'Tab 21 UA',
      time: { offsetMs: 5_000, revision: 1 },
    });
  });

  it('creates a synchronous document config rule when only custom time is enabled', async () => {
    await overridesModule.updateTabPageOverrides(25, { customTime: 1_787_272_260_000 });

    const rules = [...sessionRules.values()];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.action.requestHeaders).toBeUndefined();
    const encoded = /desc="([^"]+)"/.exec(rules[0]?.action.responseHeaders?.[0]?.value ?? '')?.[1];
    expect(JSON.parse(decodeURIComponent(escape(atob(encoded ?? ''))))).toEqual({
      time: { offsetMs: 5_000, revision: 1 },
    });
    expect(rules[0]?.condition.resourceTypes).toEqual(['main_frame', 'sub_frame']);
  });

  it('applies the page timezone and preserves it across navigation when Chrome rejects native emulation', async () => {
    debuggerMocks.enableTimezoneForTab.mockRejectedValueOnce(
      new Error('Timezone override is only available to trusted clients'),
    );
    (chrome.permissions.contains as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await expect(
      overridesModule.updateTabPageOverrides(51, { customTimezone: 'Asia/Tokyo' }),
    ).rejects.toMatchObject({ origin: 'https://example.test/*' });
    expect(sessionRules.size).toBe(0);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();

    debuggerMocks.enableTimezoneForTab.mockRejectedValueOnce(
      new Error('Timezone override is only available to trusted clients'),
    );
    await overridesModule.grantTabTimezoneSiteAccess(
      51,
      { customTimezone: 'Asia/Tokyo' },
      'https://example.test/*',
    );
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://example.test/*'],
    });
    for (const frameId of [0, 2]) {
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 51, frameIds: [frameId] },
          world: 'MAIN',
          args: ['Asia/Tokyo', 1],
        }),
      );
    }
    const header = [...sessionRules.values()][0]?.action.responseHeaders?.[0]?.value;
    expect(JSON.parse(atob(/desc="([^"]+)"/.exec(header ?? '')?.[1] ?? ''))).toEqual({
      timezone: { timezone: 'Asia/Tokyo', revision: 1 },
    });
    await overridesModule.updateTabPageOverrides(51, { customTimezone: '' });
    expect(debuggerMocks.disableTimezoneForTab).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: ['', 2],
      }),
    );
    expect(sessionRules.size).toBe(0);
  });

  it('restores the preceding page timezone if the navigation rule cannot be saved', async () => {
    debuggerMocks.enableTimezoneForTab.mockRejectedValueOnce(
      new Error('Timezone override is only available to trusted clients'),
    );
    await overridesModule.updateTabPageOverrides(52, { customTimezone: 'Asia/Tokyo' });
    vi.mocked(chrome.declarativeNetRequest.updateSessionRules).mockRejectedValueOnce(
      new Error('rule update failed'),
    );
    await expect(
      overridesModule.updateTabPageOverrides(52, { customTimezone: 'Europe/London' }),
    ).rejects.toThrow('rule update failed');
    expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: ['Asia/Tokyo', 3],
      }),
    );
    await expect(overridesModule.getTabPageOverrides(52)).resolves.toMatchObject({
      customTimezone: 'Asia/Tokyo',
    });
  });

  it('returns the committed timezone to a document started during an update', async () => {
    debuggerMocks.enableTimezoneForTab.mockRejectedValueOnce(
      new Error('Timezone override is only available to trusted clients'),
    );
    const ruleUpdate = Promise.withResolvers<void>();
    const ruleUpdated = Promise.withResolvers<void>();
    vi.mocked(chrome.declarativeNetRequest.updateSessionRules).mockImplementationOnce(async () => {
      ruleUpdate.resolve();
      await ruleUpdated.promise;
    });

    const change = overridesModule.updateTabPageOverrides(53, { customTimezone: 'Asia/Tokyo' });
    await ruleUpdate.promise;
    const startup = overridesModule.getPageTimezoneOverride(53);
    ruleUpdated.resolve();
    await change;
    await expect(startup).resolves.toMatchObject({ timezone: 'Asia/Tokyo' });
  });

  it('clears a stale time override when saved page settings have time disabled', async () => {
    timeMocks.getTimeOverrideForTab.mockResolvedValueOnce({ offsetMs: 5_000, revision: 1 });

    await overridesModule.ensureTabPageOverridesApplied(25);

    expect(timeMocks.disableTimeForTab).toHaveBeenCalledWith(25, false);
    expect(timeMocks.sendTimeOverrideForTab).toHaveBeenCalledWith(25, {
      offsetMs: null,
      revision: 2,
    });
  });

  it('removes the document config rule after clearing a time-only override', async () => {
    await overridesModule.updateTabPageOverrides(26, { customTime: 1_787_272_260_000 });
    expect(sessionRules.size).toBe(1);

    await overridesModule.updateTabPageOverrides(26, { customTime: null });

    expect(sessionRules.size).toBe(0);
    expect(timeMocks.sendTimeOverrideForTab).toHaveBeenLastCalledWith(26, {
      offsetMs: null,
      revision: 2,
    });
  });

  it('quick-disables each field on its own tab and preserves the saved UA text', async () => {
    const key = tabPageOverridesStorageKey(31);
    storedValues[key] = {
      customUserAgent: 'Reusable UA',
      customUserAgentEnabled: true,
      customTimezone: 'Asia/Shanghai',
      customTime: 1_787_272_260_000,
    };

    await overridesModule.disableTabPageOverride(31, 'userAgent');
    await overridesModule.disableTabPageOverride(31, 'timezone');
    await overridesModule.disableTabPageOverride(31, 'pageTime');

    await expect(overridesModule.getTabPageOverrides(31)).resolves.toEqual({
      customUserAgent: 'Reusable UA',
      customUserAgentEnabled: false,
      customTimezone: '',
      customTime: null,
    });
    expect(debuggerMocks.disableTimezoneForTab).toHaveBeenCalledWith(31, 'settings');
    expect(timeMocks.disableTimeForTab).toHaveBeenCalledWith(31, false);
  });

  it('serializes concurrent patches so a later field update does not reset UA state', async () => {
    await Promise.all([
      overridesModule.updateTabPageOverrides(35, {
        customUserAgent: 'Tab 35 UA',
        customUserAgentEnabled: true,
      }),
      overridesModule.updateTabPageOverrides(35, { customTimezone: 'Asia/Shanghai' }),
    ]);

    await expect(overridesModule.getTabPageOverrides(35)).resolves.toEqual({
      customUserAgent: 'Tab 35 UA',
      customUserAgentEnabled: true,
      customTimezone: 'Asia/Shanghai',
      customTime: null,
    });
  });

  it('rejects invalid patches and quick-disable targets', async () => {
    await expect(
      overridesModule.updateTabPageOverrides(41, { customTimezone: 'Invalid/Timezone' }),
    ).rejects.toThrow('Invalid timezone');
    await expect(overridesModule.disableTabPageOverride(41, 'invalid')).rejects.toThrow(
      'Unknown DNR override',
    );
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });
});
