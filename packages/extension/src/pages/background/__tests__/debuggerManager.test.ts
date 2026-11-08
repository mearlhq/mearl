vi.mock('../requestInspection', async () => { const { requestMetadataFixture } = await import('../../../test/fixtures/requestMetadata'); return { inspectBrowserRequest: vi.fn(async input => requestMetadataFixture(input)) }; });
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';
import { emptyDeviceUserAgentMetadata, resolveEmulationConfig, type DeviceEnvironmentObservation } from '@mearl/browser-core';

vi.mock('../appProfileRuntimeSource', async () => {
  const { buildAppProfileRuntimeCallSource } =
    await import('@mearl/browser-core/appProfileRuntime');
  return {
    buildAppProfileRuntimeProgram: vi.fn(async (config: string) => ({
      registration: '',
      call: buildAppProfileRuntimeCallSource(config),
    })),
  };
});

const mockChrome = {
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    onEvent: {
      addListener: vi.fn(),
    },
    onDetach: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    remove: vi.fn(),
    sendMessage: vi.fn(),
    onRemoved: {
      addListener: vi.fn(),
    },
  },
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  storage: {
    local: {
      get: vi.fn((_keys: string[], callback: (result: Record<string, unknown>) => void) => {
        callback({});
      }),
      set: vi.fn((_items: Record<string, unknown>, callback?: () => void) => {
        callback?.();
      }),
    },
    onChanged: {
      addListener: vi.fn(),
    },
  },
};

global.chrome = mockChrome as any;

describe('Debugger Manager', () => {
  it.each([false, true])('commits the final App UA and restores native identity with preserveHostPlatform=%s', async preserveHostPlatform => {
    const tabId = preserveHostPlatform ? 99002 : 99001;
    const dnr = chrome.declarativeNetRequest;
    const session = chrome.storage.session, values: Record<string, unknown> = {};
    chrome.storage.session = {
      get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]]))),
      set: vi.fn(async (next: object) => { Object.assign(values, next); }),
      remove: vi.fn(async (keys: string[]) => { keys.forEach(key => { delete values[key]; }); }),
    } as any;
    chrome.declarativeNetRequest = { getSessionRules: vi.fn(async () => []), updateSessionRules: vi.fn(async () => {}) } as any;
    const previousSend = mockChrome.debugger.sendCommand.getMockImplementation();
    const identities: Array<Record<string, unknown>> = [];
    let physicalPlatform = 'Host';
    let widthOffset = 0;
    const physicalObservation = () => ({ userAgent: identities.at(-1)?.userAgent ?? 'Native', platform: physicalPlatform,
      userAgentMetadata: identities.at(-1)?.userAgentMetadata ?? emptyDeviceUserAgentMetadata(),
      screen: { width: device.width + widthOffset, height: device.height, deviceScaleFactor: device.deviceScaleFactor, orientation: 'portrait-primary', angle: 0 },
      touchPoints: 5, safeAreaInsets: device.safeAreaInsets,
    } as DeviceEnvironmentObservation);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_target, method, params) => {
      if (method === 'Emulation.setUserAgentOverride') { identities.push(params); physicalPlatform = params.platform; }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', loaderId: 'loader' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 991 };
      if (method === 'Runtime.evaluate' && params?.expression?.includes('observeDeviceEnvironment')) return { result: { value: physicalObservation() } };
      return {};
    });
    const { enableEmulationForTab, disableEmulationForTab, synchronizeAppDeviceIdentityForTab, recordHostEnvironmentObservation, prepareDeviceShellWebViewEnvironmentForTab, handleAppProfileChildTargetEvent, cleanupTab } = await import('../debuggerManager');
    const { applyAppProfileForTab, clearAppProfileForTab } = await import('../utils/appProfileRules');
    const { applyDeviceShellForTab, clearDeviceShellForTab } = await import('../deviceShellRules');
    const { getDeviceChromeConfig } = await import('../../../shared/quickAppProfile');
    const device = resolveEmulationConfig({ enabled: true, preset: 'iphone-15-pro' });
    const app = resolveAppProfile('reader').injected;
    const native: DeviceEnvironmentObservation = { userAgent: 'Native', platform: 'Host', userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: '156' }], fullVersionList: [{ brand: 'Chromium', version: '156.0.0.0' }],
      platform: 'Host OS', platformVersion: '1', architecture: 'arm', model: '', mobile: false,
    }, screen: { width: 1920, height: 1080, deviceScaleFactor: 2, orientation: 'landscape-primary', angle: 0 },
      touchPoints: 0, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    try {
      await applyAppProfileForTab(tabId, app);
      await applyDeviceShellForTab(tabId, getDeviceChromeConfig(device), device);
      await enableEmulationForTab(tabId, device);
      expect(identities.at(-1)?.userAgent).toBe(device.userAgent);
      await synchronizeAppDeviceIdentityForTab(tabId, native, preserveHostPlatform ? { preserveHostPlatform, preserveHostInput: true } : undefined);
      expect(identities.at(-1)).toEqual({ userAgent: app.userAgent, platform: preserveHostPlatform ? native.platform : device.platform, userAgentMetadata: emptyDeviceUserAgentMetadata() });
      expect(mockChrome.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Emulation.setEmitTouchEventsForMouse').at(-1)?.[2])
        .toEqual(preserveHostPlatform ? { enabled: false } : { enabled: true, configuration: 'mobile' });
      if (preserveHostPlatform) {
        await recordHostEnvironmentObservation(tabId, physicalObservation());
        mockChrome.debugger.sendCommand.mockClear();
        await prepareDeviceShellWebViewEnvironmentForTab(tabId, device, app);
        expect(identities.at(-1)).toEqual({ userAgent: app.userAgent, platform: native.platform, userAgentMetadata: emptyDeviceUserAgentMetadata() });
        const conversions = mockChrome.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Emulation.setEmitTouchEventsForMouse');
        expect(conversions.length).toBeGreaterThan(0);
        expect(conversions.every(call => (call[2] as any).enabled === false)).toBe(true);
        const send = mockChrome.debugger.sendCommand.getMockImplementation()!;
        mockChrome.debugger.sendCommand.mockImplementation(async (target, method, params) => {
          if (target.sessionId && method === 'Page.getFrameTree') return { frameTree: { frame: { name: '__mearl_root__' } } };
          if (!target.sessionId && method === 'Runtime.evaluate' && !params?.expression?.includes('observeDeviceEnvironment')) return { result: { value: {
            screenWidth: device.width, deviceScaleFactor: device.deviceScaleFactor, userAgent: app.userAgent, maxTouchPoints: 5,
          } } };
          return send(target, method, params);
        });
        mockChrome.debugger.sendCommand.mockClear();
        await handleAppProfileChildTargetEvent(tabId, 'Target.attachedToTarget', {
          sessionId: 'owned-webview', targetInfo: { type: 'iframe' },
        });
        expect(mockChrome.debugger.sendCommand.mock.calls.some(call => call[1] === 'Emulation.setUserAgentOverride' || call[1] === 'Emulation.setEmitTouchEventsForMouse')).toBe(false);
        expect(mockChrome.debugger.sendCommand.mock.calls.some(call => call[1] === 'Emulation.setDeviceMetricsOverride' || call[1] === 'Emulation.clearDeviceMetricsOverride')).toBe(false);
        for (const drift of ['platform', 'screen']) {
          widthOffset = 0;
          await synchronizeAppDeviceIdentityForTab(tabId, native, { preserveHostPlatform: true, preserveHostInput: true });
          await recordHostEnvironmentObservation(tabId, physicalObservation());
          if (drift === 'platform') physicalPlatform = 'External'; else widthOffset = 1;
          for (const suffix of ['first', 'later']) {
            mockChrome.debugger.sendCommand.mockClear();
            await handleAppProfileChildTargetEvent(tabId, 'Target.attachedToTarget', { sessionId: drift + suffix, targetInfo: { type: 'iframe' } });
            expect(physicalPlatform).toBe(drift === 'platform' ? 'External' : native.platform);
            expect(widthOffset).toBe(drift === 'screen' ? 1 : 0);
            expect(mockChrome.debugger.sendCommand.mock.calls.some(call => !call[0].sessionId && call[1].startsWith('Emulation.'))).toBe(false);
            expect(mockChrome.debugger.sendCommand.mock.calls.some(call => call[1] === 'Network.setUserAgentOverride')).toBe(false);
          }
        }
        widthOffset = 0;
        mockChrome.debugger.sendCommand.mockImplementation(send);
        const { markEnvironmentMutation } = await import('../environmentRevisions');
        for (const [index, component] of (['app', 'device'] as const).entries()) {
          await synchronizeAppDeviceIdentityForTab(tabId, native, { preserveHostPlatform: true, preserveHostInput: true });
          await markEnvironmentMutation(tabId, component);
          mockChrome.debugger.sendCommand.mockClear();
          await prepareDeviceShellWebViewEnvironmentForTab(tabId, { ...device, width: device.width + index + 1 }, app);
          expect(identities.at(-1)?.platform).toBe(device.platform);
          expect(mockChrome.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Emulation.setEmitTouchEventsForMouse').at(-1)?.[2])
            .toEqual({ enabled: true, configuration: 'mobile' });
        }
      }
      await clearAppProfileForTab(tabId);
      await synchronizeAppDeviceIdentityForTab(tabId, native, preserveHostPlatform ? { preserveHostPlatform, preserveHostInput: true } : undefined);
      expect(identities.at(-1)?.userAgent).toBe(device.userAgent);
      expect(identities.at(-1)?.platform).toBe(preserveHostPlatform ? native.platform : device.platform);
      expect(identities.at(-1)?.userAgentMetadata).toMatchObject({ platform: device.platform, mobile: device.mobile });
      await clearDeviceShellForTab(tabId); await disableEmulationForTab(tabId);
      await synchronizeAppDeviceIdentityForTab(tabId, native);
      expect(identities.at(-1)).toEqual({ userAgent: native.userAgent, platform: native.platform, userAgentMetadata: native.userAgentMetadata });
    } finally {
      await clearAppProfileForTab(tabId); await clearDeviceShellForTab(tabId); cleanupTab(tabId);
      chrome.declarativeNetRequest = dnr;
      await (await import('../environmentRevisions')).cleanupEnvironmentRevisions(tabId);
      chrome.storage.session = session;
      mockChrome.debugger.sendCommand.mockImplementation(previousSend ?? (async () => undefined));
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enableModificationForTab', () => {
    it('should attach debugger and enable Fetch domain', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.tabs.sendMessage.mockResolvedValue(undefined);

      const { enableModificationForTab } = await import('../debuggerManager');
      await enableModificationForTab(1);

      expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
      expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Fetch.enable',
        expect.objectContaining({
          patterns: expect.arrayContaining([expect.objectContaining({ urlPattern: '*', resourceType: 'XHR' })]),
        }),
      );
    });

    it('should not attach debugger twice if already attached', async () => {
      const { enableModificationForTab } = await import('../debuggerManager');

      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      await enableModificationForTab(2);
      mockChrome.debugger.attach.mockClear();

      await enableModificationForTab(2);

      expect(mockChrome.debugger.attach).not.toHaveBeenCalled();
    });

    it('should handle debugger attach failure', async () => {
      const error = new Error('Already attached');
      mockChrome.debugger.attach.mockRejectedValue(error);
      mockChrome.debugger.sendCommand.mockRejectedValue(new Error('Debugger is unavailable'));

      const { enableModificationForTab } = await import('../debuggerManager');

      await expect(enableModificationForTab(3)).rejects.toThrow('Already attached');
    });
  });

  describe('disableModificationForTab', () => {
    it('should detach debugger', async () => {
      mockChrome.debugger.detach.mockResolvedValue(undefined);
      mockChrome.tabs.sendMessage.mockResolvedValue(undefined);
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      const { enableModificationForTab, disableModificationForTab } =
        await import('../debuggerManager');

      await enableModificationForTab(4);
      await disableModificationForTab(4);

      expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 4 });
    });

    it('should do nothing if debugger not attached', async () => {
      const { disableModificationForTab } = await import('../debuggerManager');

      await disableModificationForTab(999);

      expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
    });
  });

  describe('timezone override', () => {
    it('attaches debugger and applies the CDP timezone', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      const { enableTimezoneForTab } = await import('../debuggerManager');
      await enableTimezoneForTab(1001, 'Asia/Shanghai');

      expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1001 }, '1.3');
      expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1001 },
        'Emulation.setTimezoneOverride',
        { timezoneId: 'Asia/Shanghai' },
      );
    });

    it('clears the timezone and detaches an idle session', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.detach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      const { enableTimezoneForTab, disableTimezoneForTab } = await import('../debuggerManager');
      await enableTimezoneForTab(1002, 'America/New_York');
      await disableTimezoneForTab(1002);

      expect(mockChrome.debugger.sendCommand).toHaveBeenLastCalledWith(
        { tabId: 1002 },
        'Emulation.setTimezoneOverride',
        { timezoneId: '' },
      );
      expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1002 });
    });

    it('keeps the shared debugger session while modification is active', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.detach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      const { enableModificationForTab, enableTimezoneForTab, disableTimezoneForTab } =
        await import('../debuggerManager');
      await enableModificationForTab(1003);
      await enableTimezoneForTab(1003, 'Europe/London');
      mockChrome.debugger.detach.mockClear();
      await disableTimezoneForTab(1003);

      expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
    });

    it('releases state when the initial timezone command fails', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.detach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockRejectedValue(new Error('Invalid timezone'));

      const { enableTimezoneForTab, getTabState } = await import('../debuggerManager');

      await expect(enableTimezoneForTab(1004, 'Invalid/Timezone')).rejects.toThrow(
        'Invalid timezone',
      );
      expect(getTabState(1004)?.timezoneOverrides).toEqual({});
      expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1004 });
    });

    it('keeps an agent override when the settings override is removed', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      const { enableTimezoneForTab, disableTimezoneForTab } = await import('../debuggerManager');
      await enableTimezoneForTab(1005, 'America/New_York', 'agent');
      await enableTimezoneForTab(1005, 'Asia/Shanghai', 'settings');
      await disableTimezoneForTab(1005, 'settings');

      expect(mockChrome.debugger.sendCommand).toHaveBeenLastCalledWith(
        { tabId: 1005 },
        'Emulation.setTimezoneOverride',
        { timezoneId: 'America/New_York' },
      );
      expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
    });

    it('restores a settings override when the agent override is removed', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      const { enableTimezoneForTab, disableTimezoneForTab } = await import('../debuggerManager');
      await enableTimezoneForTab(1006, 'Asia/Shanghai', 'settings');
      await enableTimezoneForTab(1006, 'America/New_York', 'agent');
      await disableTimezoneForTab(1006, 'agent');

      expect(mockChrome.debugger.sendCommand).toHaveBeenLastCalledWith(
        { tabId: 1006 },
        'Emulation.setTimezoneOverride',
        { timezoneId: 'Asia/Shanghai' },
      );
      expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
    });
  });

  describe('setResponseOverride', () => {
    it('should set override and auto-enable debugger', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride } = await import('../debuggerManager');

      const override = {
        apiName: 'mtop.test.api',
        responseData: { success: true },
        duration: 100,
        disabled: false,
      };

      await setResponseOverride(5, override);

      expect(mockChrome.debugger.attach).toHaveBeenCalled();
    });

    it('should update existing override', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, getOverrides } = await import('../debuggerManager');

      const override1 = {
        apiName: 'mtop.test.api',
        responseData: { data: 1 },
        duration: 0,
        disabled: false,
      };

      const override2 = {
        apiName: 'mtop.test.api',
        responseData: { data: 2 },
        duration: 0,
        disabled: false,
      };

      await setResponseOverride(6, override1);
      await setResponseOverride(6, override2);

      const overrides = getOverrides(6);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].responseData.data).toBe(2);
    });
  });

  describe('removeResponseOverride', () => {
    it('should remove specific override', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, removeResponseOverride, getOverrides } =
        await import('../debuggerManager');

      await setResponseOverride(7, {
        apiName: 'mtop.api.one',
        responseData: {},
        duration: 0,
        disabled: false,
      });

      await setResponseOverride(7, {
        apiName: 'mtop.api.two',
        responseData: {},
        duration: 0,
        disabled: false,
      });

      removeResponseOverride(7, 'mtop.api.one');

      const overrides = getOverrides(7);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].apiName).toBe('mtop.api.two');
    });
  });

  describe('updateOverrideConditions', () => {
    it('should update conditions on an override', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, updateOverrideConditions, getOverrides } =
        await import('../debuggerManager');

      await setResponseOverride(8, {
        id: 'test-id-1',
        apiName: 'mtop.test.api',
        responseData: {},
        duration: 0,
      });

      updateOverrideConditions(8, 'mtop.test.api', 'test-id-1', { itemId: '123' });

      const overrides = getOverrides(8);
      expect(overrides[0].conditions).toEqual({ itemId: '123' });
    });

    it('should clear conditions when empty object is passed', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, updateOverrideConditions, getOverrides } =
        await import('../debuggerManager');

      await setResponseOverride(9, {
        id: 'test-id-2',
        apiName: 'mtop.test.api',
        responseData: {},
        duration: 0,
      });

      updateOverrideConditions(9, 'mtop.test.api', 'test-id-2', { itemId: '123' });
      updateOverrideConditions(9, 'mtop.test.api', 'test-id-2', {});

      const overrides = getOverrides(9);
      expect(overrides[0].conditions).toBeUndefined();
    });
  });

  describe('multi-override per API', () => {
    it('should support multiple overrides for the same API with different ids', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, getOverrides } = await import('../debuggerManager');

      await setResponseOverride(10, {
        id: 'override-a',
        apiName: 'mtop.test.api',
        responseData: { scene: 'a' },
        conditions: { itemId: '111' },
      });

      await setResponseOverride(10, {
        id: 'override-b',
        apiName: 'mtop.test.api',
        responseData: { scene: 'b' },
        conditions: { itemId: '222' },
      });

      const overrides = getOverrides(10);
      expect(overrides).toHaveLength(2);
      expect(overrides.map(o => o.id)).toEqual(['override-a', 'override-b']);
    });

    it('should replace override with same id', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, getOverrides } = await import('../debuggerManager');

      await setResponseOverride(11, {
        id: 'same-id',
        apiName: 'mtop.test.api',
        responseData: { version: 1 },
      });

      await setResponseOverride(11, {
        id: 'same-id',
        apiName: 'mtop.test.api',
        responseData: { version: 2 },
      });

      const overrides = getOverrides(11);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].responseData.version).toBe(2);
    });

    it('should remove single override by id', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, removeResponseOverride, getOverrides } =
        await import('../debuggerManager');

      await setResponseOverride(12, {
        id: 'keep-me',
        apiName: 'mtop.test.api',
        responseData: { keep: true },
      });

      await setResponseOverride(12, {
        id: 'remove-me',
        apiName: 'mtop.test.api',
        responseData: { keep: false },
      });

      removeResponseOverride(12, 'mtop.test.api', 'remove-me');

      const overrides = getOverrides(12);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].id).toBe('keep-me');
    });

    it('should remove all overrides for an API when no id given', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, removeResponseOverride, getOverrides } =
        await import('../debuggerManager');

      await setResponseOverride(13, {
        id: 'a',
        apiName: 'mtop.test.api',
        responseData: {},
      });

      await setResponseOverride(13, {
        id: 'b',
        apiName: 'mtop.test.api',
        responseData: {},
      });

      removeResponseOverride(13, 'mtop.test.api');

      const overrides = getOverrides(13);
      expect(overrides).toHaveLength(0);
    });
  });

  describe('response sequences', () => {
    it('keeps counters isolated by matching scenario', async () => {
      const { selectResponseOverride } = await import('../debuggerManager');
      const overrides = [
        {
          id: 'item-a-0',
          apiName: 'mtop.test.api',
          conditions: { itemId: 'a', $index: 0 },
          responseData: 1,
        },
        {
          id: 'item-a-1',
          apiName: 'mtop.test.api',
          conditions: { itemId: 'a', $index: 1 },
          responseData: 2,
        },
        {
          id: 'item-b-0',
          apiName: 'mtop.test.api',
          conditions: { itemId: 'b', $index: 0 },
          responseData: 10,
        },
        {
          id: 'item-b-1',
          apiName: 'mtop.test.api',
          conditions: { itemId: 'b', $index: 1 },
          responseData: 20,
        },
      ];
      const counts = new Map<string, number>();

      expect(
        selectResponseOverride(overrides, { url: 'https://x.test?itemId=a' }, counts)?.responseData,
      ).toBe(1);
      expect(
        selectResponseOverride(overrides, { url: 'https://x.test?itemId=b' }, counts)?.responseData,
      ).toBe(10);
      expect(
        selectResponseOverride(overrides, { url: 'https://x.test?itemId=a' }, counts)?.responseData,
      ).toBe(2);
    });

    it('prefers the most specific matching scenario regardless of configuration order', async () => {
      const { selectResponseOverride } = await import('../debuggerManager');
      const broad = {
        id: 'broad',
        apiName: 'mtop.test.api',
        conditions: { itemId: 'a', $index: 0 },
        responseData: 'broad',
      };
      const specific = {
        id: 'specific',
        apiName: 'mtop.test.api',
        conditions: { itemId: 'a', page: 2, $index: 0 },
        responseData: 'specific',
      };
      const request = { url: 'https://x.test?itemId=a&page=2' };

      expect(selectResponseOverride([broad, specific], request, new Map())?.responseData).toBe(
        'specific',
      );
      expect(selectResponseOverride([specific, broad], request, new Map())?.responseData).toBe(
        'specific',
      );
    });

    it('keeps using the last configured response after the sequence ends', async () => {
      const { selectResponseOverride } = await import('../debuggerManager');
      const request = { url: 'https://x.test' };
      const sequence = [
        { id: 'first', apiName: 'api', conditions: { $index: 0 }, responseData: 1 },
        { id: 'second', apiName: 'api', conditions: { $index: 1 }, responseData: 2 },
      ];

      const counts = new Map<string, number>();
      selectResponseOverride(sequence, request, counts);
      selectResponseOverride(sequence, request, counts);
      expect(selectResponseOverride(sequence, request, counts)?.responseData).toBe(2);
    });

    it.each([undefined, 200])('resumes a paused request when inspection fails at status %s', async responseStatusCode => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      const { setResponseOverride, handleRequestPaused, cleanupTab } = await import('../debuggerManager');
      const { inspectBrowserRequest } = await import('../requestInspection');
      const tabId = responseStatusCode === undefined ? 99031 : 99032;
      await setResponseOverride(tabId, { apiName: 'example.query', responseData: { mocked: true } });
      vi.mocked(inspectBrowserRequest).mockRejectedValueOnce(new Error('Pure browser runtime failed'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockChrome.debugger.sendCommand.mockClear();
      try {
        await handleRequestPaused(tabId, { requestId: 'inspection-failed', request: { method: 'GET', url: 'https://example.test/query' }, responseStatusCode });
        expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId }, 'Fetch.continueRequest', { requestId: 'inspection-failed' });
        expect(mockChrome.debugger.sendCommand.mock.calls.some(call => call[1] === 'Fetch.fulfillRequest')).toBe(false);
        expect(warn).toHaveBeenCalled();
      } finally { warn.mockRestore(); await cleanupTab(tabId); }
    });

    it('selects consecutive mock responses once per request', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, handleRequestPaused, resetResponseOverrideCallCounts } =
        await import('../debuggerManager');
      const tabId = 27;
      const apiName = 'mtop.test.sequence';
      for (const [sequenceIndex, state] of ['fallback', 1, 2].entries()) {
        await setResponseOverride(tabId, {
          apiName,
          conditions: { $index: sequenceIndex },
          responseData: { state },
          duration: 0,
        });
      }

      const request = { method: 'POST', url: `https://h5api.example/h5/${apiName}/1.0` };
      await handleRequestPaused(tabId, { requestId: 'sequence-1', request });
      await handleRequestPaused(tabId, { requestId: 'sequence-2', request });
      await handleRequestPaused(tabId, { requestId: 'sequence-3', request });
      await handleRequestPaused(tabId, { requestId: 'sequence-overflow', request });
      resetResponseOverrideCallCounts(tabId);
      await handleRequestPaused(tabId, { requestId: 'sequence-after-refresh', request });

      const fulfilled = mockChrome.debugger.sendCommand.mock.calls
        .filter(call => call[1] === 'Fetch.fulfillRequest')
        .map(call => JSON.parse(Buffer.from(call[2].body, 'base64').toString()));
      expect(fulfilled).toEqual([
        { state: 'fallback' },
        { state: 1 },
        { state: 2 },
        { state: 2 },
        { state: 'fallback' },
      ]);
    });

    it('applies response overrides on the business WebView session', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      const { setResponseOverride, handleRequestPaused, disableModificationForTab, cleanupTab } =
        await import('../debuggerManager');
      const { registerRequestCollectionWebView, forgetRequestCollectionWebView } =
        await import('../backgroundRequestCollector');
      const tabId = 99033;
      const sessionId = 'business-webview';
      const target = { tabId, sessionId };
      const url = 'https://example.test/api/query';
      try {
        await registerRequestCollectionWebView(tabId, sessionId);
        await setResponseOverride(tabId, { apiName: '/api/query', url, responseData: { mocked: true } });
        expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(target, 'Fetch.enable', {
          patterns: expect.arrayContaining([{ urlPattern: '*', resourceType: 'Fetch', requestStage: 'Response' }]),
        });

        const request = { requestId: 'same-id', request: { method: 'GET', url } };
        const unrelated = { ...request, request: { method: 'GET', url: 'https://example.test/api/other' } };
        await handleRequestPaused(tabId, request, sessionId);
        await handleRequestPaused(tabId, unrelated);
        await handleRequestPaused(tabId, { ...request, responseStatusCode: 200, responseHeaders: [] }, sessionId);
        expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(target, 'Fetch.fulfillRequest', expect.objectContaining({
          requestId: 'same-id',
          responseCode: 200,
          body: btoa(JSON.stringify({ mocked: true })),
        }));

        await disableModificationForTab(tabId);
        expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(target, 'Fetch.disable');
      } finally {
        forgetRequestCollectionWebView(tabId);
        await cleanupTab(tabId);
      }
    });

    it('wraps duration mock responses with the requested JSONP callback', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, handleRequestPaused } = await import('../debuggerManager');
      const tabId = 28;
      const apiName = 'mtop.test.jsonp';
      await setResponseOverride(tabId, {
        apiName,
        responseData: { data: { mocked: true } },
        duration: 0,
      });

      await handleRequestPaused(tabId, {
        requestId: 'jsonp-duration',
        request: {
          method: 'GET',
          url: `https://h5api.example/h5/${apiName}/1.0?callback=mtopjsonp42&type=jsonp`,
        },
      });

      const fulfilled = mockChrome.debugger.sendCommand.mock.calls.find(
        call => call[1] === 'Fetch.fulfillRequest',
      )?.[2];
      expect(Buffer.from(fulfilled.body, 'base64').toString()).toBe(
        'mtopjsonp42({"data":{"mocked":true}});',
      );
      expect(fulfilled.responseHeaders).toContainEqual({
        name: 'content-type',
        value: 'application/javascript; charset=utf-8',
      });
    });

    it('preserves JSONP transport when modifying a real response', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.runtime.sendMessage.mockResolvedValue(undefined);

      const { setResponseOverride, handleRequestPaused } = await import('../debuggerManager');
      const tabId = 29;
      const apiName = 'mtop.test.jsonp.response';
      await setResponseOverride(tabId, {
        apiName,
        responseData: { ret: ['SUCCESS::调用成功'] },
      });
      const request = {
        method: 'GET',
        url: `https://h5api.example/h5/${apiName}/1.0?jsonp=callback_7`,
      };

      await handleRequestPaused(tabId, { requestId: 'jsonp-response', request });
      await handleRequestPaused(tabId, {
        requestId: 'jsonp-response',
        request,
        responseStatusCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Content-Encoding', value: 'gzip' },
          { name: 'X-Test', value: 'kept' },
        ],
      });

      const fulfilled = mockChrome.debugger.sendCommand.mock.calls.find(
        call => call[1] === 'Fetch.fulfillRequest',
      )?.[2];
      expect(Buffer.from(fulfilled.body, 'base64').toString()).toBe(
        'callback_7({"ret":["SUCCESS::调用成功"]});',
      );
      expect(fulfilled.responseHeaders).toEqual([
        { name: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        { name: 'X-Test', value: 'kept' },
      ]);
    });
  });

  describe('getOverrides', () => {
    it('should return empty array for non-existent tab', async () => {
      const { getOverrides } = await import('../debuggerManager');

      const overrides = getOverrides(999);
      expect(overrides).toEqual([]);
    });
  });

  describe('getDebuggerStatus', () => {
    it('should return false for non-existent tab', async () => {
      const { getDebuggerStatus } = await import('../debuggerManager');

      const status = getDebuggerStatus(999);
      expect(status).toBe(false);
    });

    it('should return true after debugger attached', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);

      const { enableModificationForTab, getDebuggerStatus } = await import('../debuggerManager');

      await enableModificationForTab(9);

      const status = getDebuggerStatus(9);
      expect(status).toBe(true);
    });
  });

  describe('releaseDebuggerControlForTab', () => {
    it('detaches and discards session-level mock state without closing the tab', async () => {
      mockChrome.debugger.attach.mockResolvedValue(undefined);
      mockChrome.debugger.detach.mockResolvedValue(undefined);
      mockChrome.debugger.sendCommand.mockResolvedValue(undefined);
      mockChrome.tabs.sendMessage.mockResolvedValue(undefined);

      const { getOverrides, releaseDebuggerControlForTab, setResponseOverride } =
        await import('../debuggerManager');
      await setResponseOverride(1007, {
        apiName: 'mtop.release.test',
        responseData: { ok: true },
      });

      await expect(releaseDebuggerControlForTab(1007)).resolves.toBe(true);

      expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1007 });
      expect(getOverrides(1007)).toEqual([]);
      expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
    });
  });
});

/**
 * acquire 只保证获取那一刻 session 活着；它与 sendCommand 之间的窗口无法消除
 * （跨 site 导航、DevTools 挤占都会断开），表现为间歇性的 "Debugger is not attached"。
 */
describe('设备模拟下发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
  });

  it('将视觉缩放比例传给 CDP 设备指标', async () => {
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});

    const { enableEmulationForTab, cleanupTab } = await import('../debuggerManager');
    await enableEmulationForTab(4200, {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      scale: 0.75,
      mobile: true,
      touch: true,
      orientation: 'portrait',
      userAgent: 'ua',
    } as never);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4200 },
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        width: 393,
        height: 852,
        deviceScaleFactor: 3,
        scale: 0.75,
      }),
    );
    cleanupTab(4200);
  });

  it('switches the shell viewport and preserves framing during WebView recovery', async () => {
    const tabId = 4202;
    const config = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro', scale: 0.75 });
    const { getDeviceChromeConfig } = await import('../../../shared/quickAppProfile');
    const chromeConfig = getDeviceChromeConfig(config);
    const { applyDeviceShellForTab, clearDeviceShellForTab } = await import('../deviceShellRules');
    const {
      enableEmulationForTab,
      prepareDeviceShellWebViewEnvironmentForTab,
      handleAppProfileChildTargetEvent,
      cleanupTab,
    } = await import('../debuggerManager');
    const originalDnr = chrome.declarativeNetRequest;
    chrome.declarativeNetRequest = {
      getSessionRules: vi.fn(async () => []),
      updateSessionRules: vi.fn(async () => {}),
    } as unknown as typeof chrome.declarativeNetRequest;
    mockChrome.debugger.sendCommand.mockResolvedValue({});
    try {
      await applyDeviceShellForTab(tabId, {
        ...chromeConfig,
        phoneFrame: { width: config.width, height: config.height },
      }, config);
      await enableEmulationForTab(tabId, config);
      expect(mockChrome.debugger.sendCommand.mock.calls)
        .toEqual(expect.arrayContaining([
          [{ tabId }, 'Emulation.clearDeviceMetricsOverride', {}],
          [{ tabId }, 'Emulation.setDeviceMetricsOverride', expect.objectContaining({
            width: 0, height: 0, screenWidth: config.width, screenHeight: config.height,
            deviceScaleFactor: config.deviceScaleFactor, mobile: config.mobile, scale: 1,
          })],
        ]));

      await prepareDeviceShellWebViewEnvironmentForTab(tabId, config);
      mockChrome.debugger.sendCommand.mockClear();
      mockChrome.debugger.sendCommand.mockImplementation(async (target, method) => {
        if (target.sessionId && method === 'Page.getFrameTree') {
          return { frameTree: { frame: { name: '__mearl_root__' } } };
        }
        return {};
      });
      await handleAppProfileChildTargetEvent(tabId, 'Target.attachedToTarget', {
        sessionId: 'framed-webview',
        targetInfo: { type: 'iframe' },
      });
      const recoveryMethods = mockChrome.debugger.sendCommand.mock.calls.map(([, method]) => method);
      expect(recoveryMethods).toContain('Emulation.setSafeAreaInsetsOverride');
      expect(recoveryMethods).not.toContain('Emulation.clearDeviceMetricsOverride');
      expect(recoveryMethods).not.toContain('Emulation.setDeviceMetricsOverride');
      expect(recoveryMethods).not.toContain('Emulation.setVisibleSize');

      mockChrome.debugger.sendCommand.mockClear();
      await applyDeviceShellForTab(tabId, chromeConfig, config);
      await enableEmulationForTab(tabId, config);
      expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId }, 'Emulation.setDeviceMetricsOverride',
        expect.objectContaining({ width: config.width, height: config.height, scale: 0.75 }),
      );
      expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId }, 'Emulation.setVisibleSize',
        { width: Math.round(config.width * 0.75), height: Math.round(config.height * 0.75) },
      );
    } finally {
      await clearDeviceShellForTab(tabId);
      cleanupTab(tabId);
      chrome.declarativeNetRequest = originalDnr;
    }
  });

  it('session 在下发中途断开时重试一次并成功', async () => {
    let failedOnce = false;
    chrome.debugger.sendCommand = vi.fn((_target: unknown, method: string) => {
      // 存活探测放过，真正的 Emulation 命令第一次报「已断开」
      if (method === 'Runtime.evaluate') return Promise.resolve({});
      if (!failedOnce) {
        failedOnce = true;
        return Promise.reject(new Error('Debugger is not attached to the tab with id: 4201.'));
      }
      return Promise.resolve({});
    }) as any;

    const { enableEmulationForTab, cleanupTab } = await import('../debuggerManager');
    await expect(
      enableEmulationForTab(4201, {
        width: 393,
        height: 852,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        orientation: 'portrait',
        userAgent: 'ua',
      } as never),
    ).resolves.toBeUndefined();

    expect(failedOnce).toBe(true);
    cleanupTab(4201);
  });

  it('非断连类错误不重试，直接抛出', async () => {
    chrome.debugger.sendCommand = vi.fn((_target: unknown, method: string) =>
      method === 'Runtime.evaluate'
        ? Promise.resolve({})
        : Promise.reject(new Error('Invalid parameters')),
    ) as any;

    const { enableEmulationForTab, cleanupTab } = await import('../debuggerManager');
    await expect(
      enableEmulationForTab(4202, {
        width: 393,
        height: 852,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        orientation: 'portrait',
        userAgent: 'ua',
      } as never),
    ).rejects.toThrow('Invalid parameters');

    const emulationCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(call => String(call[1]).startsWith('Emulation.'));
    expect(emulationCalls).toHaveLength(1);
    cleanupTab(4202);
  });

  it('旧版 Chrome 不支持安全区指令时保留其余设备模拟', async () => {
    chrome.debugger.sendCommand = vi.fn((_target: unknown, method: string) =>
      method === 'Emulation.setSafeAreaInsetsOverride'
        ? Promise.reject(new Error("'Emulation.setSafeAreaInsetsOverride' wasn't found"))
        : Promise.resolve({}),
    ) as any;

    const { enableEmulationForTab, cleanupTab } = await import('../debuggerManager');
    await expect(
      enableEmulationForTab(4203, {
        width: 393,
        height: 852,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        orientation: 'portrait',
        userAgent: 'ua',
        safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
      } as never),
    ).resolves.toBeUndefined();

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4203 },
      'Emulation.setDeviceMetricsOverride',
      expect.anything(),
    );
    cleanupTab(4203);
  });
});

describe('独立安全区模拟', () => {
  const insets = { top: 59, right: 0, bottom: 34, left: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});
  });

  it('只下发安全区字段，不修改现有设备指标', async () => {
    const { cleanupTab, enableSafeAreaInsetsForTab, getTabState } =
      await import('../debuggerManager');

    await enableSafeAreaInsetsForTab(4251, insets);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4251 },
      'Emulation.setSafeAreaInsetsOverride',
      {
        insets: {
          top: 59,
          topMax: 59,
          right: 0,
          rightMax: 0,
          bottom: 34,
          bottomMax: 34,
          left: 0,
          leftMax: 0,
        },
      },
    );
    expect(getTabState(4251)?.safeAreaInsetsOverride).toEqual(insets);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    cleanupTab(4251);
  });

  it('重设时在同一 session 内先清后设', async () => {
    const { cleanupTab, enableSafeAreaInsetsForTab, reapplySafeAreaInsetsForTab } =
      await import('../debuggerManager');
    await enableSafeAreaInsetsForTab(4252, insets);
    vi.mocked(chrome.debugger.sendCommand).mockClear();

    await reapplySafeAreaInsetsForTab(4252, insets);

    expect(vi.mocked(chrome.debugger.sendCommand).mock.calls.map(call => call[2])).toEqual([
      { insets: {} },
      {
        insets: {
          top: 59,
          topMax: 59,
          right: 0,
          rightMax: 0,
          bottom: 34,
          bottomMax: 34,
          left: 0,
          leftMax: 0,
        },
      },
    ]);
    cleanupTab(4252);
  });

  it('新 WebView 创建前刷新安全区但不新增独立模拟所有权', async () => {
    const { cleanupTab, getTabState, refreshSafeAreaInsetsForTab } =
      await import('../debuggerManager');

    await refreshSafeAreaInsetsForTab(4255, insets);

    expect(vi.mocked(chrome.debugger.sendCommand).mock.calls.map(call => call[2])).toEqual([
      { insets: {} },
      {
        insets: {
          top: 59,
          topMax: 59,
          right: 0,
          rightMax: 0,
          bottom: 34,
          bottomMax: 34,
          left: 0,
          leftMax: 0,
        },
      },
    ]);
    expect(getTabState(4255)?.safeAreaInsetsOverride).toBeUndefined();
    cleanupTab(4255);
  });

  it('相同 WebView 环境准备完成后直接复用已有配置', async () => {
    const { injected } = resolveAppProfile('reader');
    const { cleanupTab, getTabState, prepareDeviceShellWebViewEnvironmentForTab } =
      await import('../debuggerManager');
    const deviceConfig = {
      viewport: 'inherit' as const,
      mobile: true,
      userAgent: 'iphone adaptive ua',
      platform: 'iPhone',
      platformVersion: '17.5',
      architecture: '',
      model: 'iPhone',
      touch: true,
      orientation: 'portrait' as const,
      safeAreaInsets: insets,
      appearance: { cutout: 'dynamic-island' as const },
    };

    await prepareDeviceShellWebViewEnvironmentForTab(4257, deviceConfig, injected);
    expect(getTabState(4257)?.appProfileChildTargetEnvironment?.ready).toBe(true);
    vi.mocked(chrome.debugger.sendCommand).mockClear();

    await prepareDeviceShellWebViewEnvironmentForTab(4257, deviceConfig, injected);

    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    cleanupTab(4257);
  });

  it('Duo 展开横屏由外壳占用侧栏且子 WebView 不重复注入右安全区', async () => {
    const { injected } = resolveAppProfile('reader');
    const { cleanupTab, getTabState, prepareDeviceShellWebViewEnvironmentForTab } =
      await import('../debuggerManager');
    const deviceConfig = resolveEmulationConfig({
      enabled: true,
      preset: 'iphone-duo-unfolded',
    });

    await prepareDeviceShellWebViewEnvironmentForTab(4260, deviceConfig, injected);

    expect(getTabState(4260)?.appProfileChildTargetEnvironment?.safeAreaInsets).toEqual({
      top: 0,
      right: 0,
      bottom: 34,
      left: 0,
    });
    expect(getTabState(4260)?.appProfileChildTargetEnvironment?.source).toContain(
      '"statusBarHeight":0',
    );
    cleanupTab(4260);
  });

  it('restores phone frame and WebView insets without resetting device metrics', async () => {
    const tabId = 4261;
    const device = resolveEmulationConfig({ enabled: true, preset: 'iphone-duo-unfolded' });
    const shell = await import('../deviceShellRules');
    const { getDeviceChromeConfig } = await import('../../../shared/quickAppProfile');
    const {
      cleanupTab, getTabState, prepareDeviceShellWebViewEnvironmentForTab, restorePhoneFrameSafeAreaForTab,
    } = await import('../debuggerManager');
    const getShell = vi.spyOn(shell, 'getDeviceShellForTab').mockResolvedValue({
      config: { ...getDeviceChromeConfig(device), phoneFrame: { width: device.width, height: device.height } },
      emulation: device,
      splitScreen: false,
    });
    try {
      await prepareDeviceShellWebViewEnvironmentForTab(tabId, device);
      getTabState(tabId)!.childDeviceScripts = new Map([['webview', 'bootstrap']]);
      vi.mocked(chrome.debugger.sendCommand).mockClear();

      await restorePhoneFrameSafeAreaForTab(tabId);

      expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(2);
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId }, 'Emulation.setSafeAreaInsetsOverride',
        { insets: expect.objectContaining({ right: 0, bottom: 34 }) },
      );
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId, sessionId: 'webview' }, 'Emulation.setSafeAreaInsetsOverride',
        { insets: expect.objectContaining({ right: 0, bottom: 34 }) },
      );

      getShell.mockResolvedValue(null);
      vi.mocked(chrome.debugger.sendCommand).mockClear();
      await restorePhoneFrameSafeAreaForTab(tabId);
      expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    } finally {
      getShell.mockRestore();
      cleanupTab(tabId);
    }
  });

  it('debugger 解绑后新 WebView 仍按 profile 生命周期配置恢复设备指标与 App UA', async () => {
    const { injected } = resolveAppProfile('reader');
    const {
      cleanupTab,
      enableEmulationForTab,
      handleAppProfileChildTargetEvent,
      handleDebuggerDetach,
      prepareAppProfileWebViewEnvironmentForTab,
    } = await import('../debuggerManager');
    const deviceConfig = {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: 'standard safari',
      platform: 'iPhone',
      platformVersion: '17.0',
      architecture: '',
      model: 'iPhone',
      touch: true,
      orientation: 'portrait' as const,
      safeAreaInsets: insets,
      appearance: { cutout: 'dynamic-island' as const },
    };
    await enableEmulationForTab(4256, deviceConfig);
    handleDebuggerDetach(4256, 'target_closed');
    vi.mocked(chrome.debugger.sendCommand).mockClear();

    await prepareAppProfileWebViewEnvironmentForTab(4256, injected, deviceConfig);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4256 },
      'Target.setAutoAttach',
      expect.objectContaining({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'iframe' }, { exclude: true }],
      }),
    );

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4256 },
      'Emulation.setUserAgentOverride',
      expect.objectContaining({
        userAgent: expect.stringContaining('Sample/10.0.9'),
        platform: 'iPhone',
      }),
    );
    const appUaCall = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.find(
        call =>
          call[1] === 'Emulation.setUserAgentOverride' &&
          String((call[2] as { userAgent?: string })?.userAgent).includes('Sample/'),
      );
    expect(appUaCall?.[2]).not.toHaveProperty('userAgentMetadata');
    const methods = vi.mocked(chrome.debugger.sendCommand).mock.calls.map(call => call[1]);
    expect(methods.slice(0, 7)).toEqual([
      'Page.enable',
      'Fetch.enable',
      'Page.getFrameTree',
      'Network.setBypassServiceWorker',
      'Target.setAutoAttach',
      'Runtime.evaluate',
      'Emulation.clearDeviceMetricsOverride',
    ]);
    expect(methods).toContain('Emulation.setDeviceMetricsOverride');
    expect(methods.at(-1)).toBe('Emulation.setSafeAreaInsetsOverride');
    const metricsParams = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.find(call => call[1] === 'Emulation.setDeviceMetricsOverride')?.[2];
    expect(metricsParams).toEqual(
      expect.objectContaining({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true }),
    );

    handleDebuggerDetach(4256, 'target_closed');
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(
      async (target: chrome.debugger.Debuggee, method: string) => {
        if (
          (target as chrome.debugger.Debuggee & { sessionId?: string }).sessionId &&
          method === 'Page.getFrameTree'
        ) {
          return { frameTree: { frame: { name: '__mearl_layer__' } } };
        }
        return {};
      },
    );
    await handleAppProfileChildTargetEvent(
      4256,
      'Target.attachedToTarget',
      {
        sessionId: 'iframe-session-1',
        targetInfo: { type: 'iframe' },
      },
      injected,
      deviceConfig,
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-1' },
      'Emulation.setUserAgentOverride',
      expect.anything(),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-1' },
      'Network.setUserAgentOverride',
      { userAgent: injected.userAgent, platform: deviceConfig.platform },
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-1' },
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-1' },
      'Emulation.setDeviceMetricsOverride',
      expect.anything(),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-1' },
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('__STATUS_BAR_HEIGHT__') }),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-1' },
      'Runtime.runIfWaitingForDebugger',
      {},
    );
    const childBootstrapCall = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.find(
        call =>
          (call[0] as { sessionId?: string })?.sessionId === 'iframe-session-1' &&
          call[1] === 'Page.addScriptToEvaluateOnNewDocument',
      );
    expect((childBootstrapCall?.[2] as { source?: string })?.source).toContain('devicePixelRatio');
    expect((childBootstrapCall?.[2] as { source?: string })?.source).toContain('Sample/10.0.9');
    const childMethods = vi.mocked(chrome.debugger.sendCommand).mock.calls
      .filter(call => (call[0] as { sessionId?: string }).sessionId === 'iframe-session-1')
      .map(call => call[1]);
    const pageEnabled = childMethods.indexOf('Page.enable');
    const bootstrapRegistered = childMethods.indexOf('Page.addScriptToEvaluateOnNewDocument');
    expect(childMethods.indexOf('Network.setUserAgentOverride')).toBeLessThan(
      childMethods.indexOf('Runtime.runIfWaitingForDebugger'),
    );
    expect(childMethods.indexOf('Emulation.setTouchEmulationEnabled')).toBeLessThan(
      childMethods.indexOf('Runtime.runIfWaitingForDebugger'),
    );
    expect(pageEnabled).toBeGreaterThanOrEqual(0);
    expect(pageEnabled).toBeLessThan(bootstrapRegistered);
    expect(bootstrapRegistered).toBeLessThan(childMethods.indexOf('Runtime.runIfWaitingForDebugger'));
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-1' },
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'window.name' }),
    );

    vi.mocked(chrome.debugger.sendCommand).mockClear();
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(
      async (_target: chrome.debugger.Debuggee, method: string) =>
        method === 'Page.getFrameTree'
          ? { frameTree: { frame: { name: 'ad-frame' } } }
          : {},
    );
    await handleAppProfileChildTargetEvent(
      4256,
      'Target.attachedToTarget',
      {
        sessionId: 'iframe-session-2',
        targetInfo: { type: 'iframe' },
      },
      injected,
      deviceConfig,
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-2' },
      'Emulation.setUserAgentOverride',
      expect.anything(),
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-2' },
      'Network.setUserAgentOverride',
      expect.anything(),
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-2' },
      'Emulation.setTouchEmulationEnabled',
      expect.anything(),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4256, sessionId: 'iframe-session-2' },
      'Runtime.runIfWaitingForDebugger',
      {},
    );
    cleanupTab(4256);
  });

  it.each(['__mearl_root__', '__mearl_layer__', 'ad-frame'])('scopes App-only network identity to business WebViews (%s)', async frameName => {
    const { injected } = resolveAppProfile('reader');
    const { cleanupTab, handleAppProfileChildTargetEvent } = await import('../debuggerManager');
    const previous = vi.mocked(chrome.debugger.sendCommand).getMockImplementation();
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Page.getFrameTree' ? { frameTree: { frame: { name: frameName } } } : {});
    try {
      await handleAppProfileChildTargetEvent(4290, 'Target.attachedToTarget', {
        sessionId: 'app-only-child', targetInfo: { type: 'iframe' },
      }, injected);
      const calls = vi.mocked(chrome.debugger.sendCommand).mock.calls;
      const override = calls.find(call => call[1] === 'Network.setUserAgentOverride');
      if (frameName === 'ad-frame') expect(override).toBeUndefined();
      else {
        expect(override).toEqual([{ tabId: 4290, sessionId: 'app-only-child' },
          'Network.setUserAgentOverride', { userAgent: injected.userAgent, platform: injected.navigatorPlatform }]);
        expect(calls.indexOf(override!)).toBeLessThan(calls.findIndex(call => call[1] === 'Runtime.runIfWaitingForDebugger'));
      }
      expect(calls.some(call => call[1].startsWith('Emulation.'))).toBe(false);
    } finally {
      cleanupTab(4290);
      vi.mocked(chrome.debugger.sendCommand).mockImplementation(previous!);
    }
  });

  it('resumes the preview panel without installing the App runtime when its URL is still empty', async () => {
    const { injected } = resolveAppProfile('reader');
    const { handleAppProfileChildTargetEvent } = await import('../debuggerManager');
    mockChrome.debugger.sendCommand.mockImplementation(async (_target, method) =>
      method === 'Page.getFrameTree'
        ? { frameTree: { frame: { name: '__mearl_preview_panel__', url: '' } } }
        : {});
    await handleAppProfileChildTargetEvent(4291, 'Target.attachedToTarget', {
      sessionId: 'preview-panel', targetInfo: { type: 'iframe', url: '' },
    }, { ...injected, pageRuntime: { id: 'example/main', sha256: 'a'.repeat(64) } });

    expect(mockChrome.debugger.sendCommand.mock.calls.map(call => call[1])).toEqual([
      'Page.enable', 'Page.getFrameTree', 'Runtime.runIfWaitingForDebugger',
    ]);
  });

  it('固定机型在导航准备和新 WebView 挂载时不重复重设仍然有效的父 viewport', async () => {
    const { injected } = resolveAppProfile('reader');
    const {
      cleanupTab,
      handleAppProfileChildTargetEvent,
      prepareDeviceShellWebViewEnvironmentForTab,
    } = await import('../debuggerManager');
    const deviceConfig = {
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: 'iphone device ua',
      platform: 'iPhone',
      platformVersion: '26.0',
      architecture: '',
      model: 'iPhone',
      touch: true,
      orientation: 'portrait' as const,
      safeAreaInsets: insets,
      appearance: { cutout: 'dynamic-island' as const },
    };
    vi.mocked(chrome.debugger.attach).mockResolvedValue(undefined);
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(
      async (target: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (
          method === 'Page.getFrameTree' &&
          (target as chrome.debugger.Debuggee & { sessionId?: string }).sessionId
        ) {
          return { frameTree: { frame: { name: '__mearl_root__' } } };
        }
        if (
          method === 'Runtime.evaluate' &&
          (params as { expression?: string } | undefined)?.expression?.includes('screenWidth')
        ) {
          return {
            result: {
              value: {
                screenWidth: 402,
                deviceScaleFactor: 3,
                userAgent: injected.userAgent,
                maxTouchPoints: 5,
              },
            },
          };
        }
        return {};
      },
    );
    await prepareDeviceShellWebViewEnvironmentForTab(4259, deviceConfig, injected);

    let parentMethods = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(call => !(call[0] as { sessionId?: string }).sessionId)
      .map(call => call[1]);
    expect(parentMethods).toEqual([
      'Page.enable',
      'Fetch.enable',
      'Page.getFrameTree',
      'Network.setBypassServiceWorker',
      'Target.setAutoAttach',
      'Runtime.evaluate',
    ]);
    expect(parentMethods).not.toContain('Emulation.clearDeviceMetricsOverride');
    expect(parentMethods).not.toContain('Emulation.setDeviceMetricsOverride');

    vi.mocked(chrome.debugger.sendCommand).mockClear();

    await handleAppProfileChildTargetEvent(4259, 'Target.attachedToTarget', {
      sessionId: 'fixed-iframe-session',
      targetInfo: { type: 'iframe' },
    });

    parentMethods = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(call => !(call[0] as { sessionId?: string }).sessionId)
      .map(call => call[1]);
    expect(parentMethods).toEqual(['Runtime.evaluate']);
    expect(parentMethods).not.toContain('Emulation.clearDeviceMetricsOverride');
    expect(parentMethods).not.toContain('Emulation.setDeviceMetricsOverride');
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4259, sessionId: 'fixed-iframe-session' },
      'Emulation.setUserAgentOverride',
      expect.anything(),
    );
    cleanupTab(4259);
  });

  it('自适应 WebView 在准备和刷新恢复时保留浏览器已有 viewport', async () => {
    const {
      cleanupTab,
      handleAppProfileChildTargetEvent,
      prepareDeviceShellWebViewEnvironmentForTab,
    } = await import('../debuggerManager');
    const deviceConfig = {
      viewport: 'inherit' as const,
      mobile: true,
      userAgent: 'iphone adaptive ua',
      platform: 'iPhone',
      platformVersion: '26.0',
      architecture: '',
      model: 'iPhone',
      touch: true,
      orientation: 'portrait' as const,
      safeAreaInsets: insets,
      appearance: { cutout: 'dynamic-island' as const },
    };
    vi.mocked(chrome.debugger.attach).mockResolvedValue(undefined);
    vi.mocked(chrome.debugger.sendCommand).mockResolvedValue(undefined);

    await prepareDeviceShellWebViewEnvironmentForTab(4258, deviceConfig);

    let methods = vi.mocked(chrome.debugger.sendCommand).mock.calls.map(call => call[1]);
    expect(methods).toContain('Emulation.setUserAgentOverride');
    expect(methods).toContain('Emulation.setTouchEmulationEnabled');
    expect(methods).toContain('Emulation.setSafeAreaInsetsOverride');
    expect(methods).not.toContain('Emulation.clearDeviceMetricsOverride');
    expect(methods).not.toContain('Emulation.setDeviceMetricsOverride');

    vi.mocked(chrome.debugger.sendCommand).mockClear();
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(
      async (_target: chrome.debugger.Debuggee, method: string) =>
        method === 'Page.getFrameTree'
          ? { frameTree: { frame: { name: '__mearl_root__' } } }
          : {},
    );
    await handleAppProfileChildTargetEvent(4258, 'Target.attachedToTarget', {
      sessionId: 'adaptive-iframe-session',
      targetInfo: { type: 'iframe' },
    });

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4258, sessionId: 'adaptive-iframe-session' },
      'Network.setUserAgentOverride',
      { userAgent: 'iphone adaptive ua', platform: 'iPhone' },
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4258, sessionId: 'adaptive-iframe-session' },
      'Emulation.setUserAgentOverride',
      expect.anything(),
    );
    methods = vi.mocked(chrome.debugger.sendCommand).mock.calls.map(call => call[1]);
    expect(methods).not.toContain('Emulation.clearDeviceMetricsOverride');
    expect(methods).not.toContain('Emulation.setDeviceMetricsOverride');
    const childBootstrapCall = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.find(
        call =>
          (call[0] as { sessionId?: string })?.sessionId === 'adaptive-iframe-session' &&
          call[1] === 'Page.addScriptToEvaluateOnNewDocument',
      );
    expect((childBootstrapCall?.[2] as { source?: string })?.source).toContain(
      '"screenWidth":null',
    );
    expect((childBootstrapCall?.[2] as { source?: string })?.source).toContain(
      '"devicePixelRatio":null',
    );
    cleanupTab(4258);
  });

  it('横屏分屏保留父设备指标并让子 WebView 使用各自的自然宽度', async () => {
    const { injected } = resolveAppProfile('reader');
    const { cleanupTab, getTabState, prepareDeviceShellWebViewEnvironmentForTab } =
      await import('../debuggerManager');
    const deviceConfig = {
      width: 874,
      height: 402,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: 'iphone landscape ua',
      platform: 'iPhone',
      platformVersion: '26.0',
      architecture: '',
      model: 'iPhone',
      touch: true,
      orientation: 'landscape' as const,
      safeAreaInsets: insets,
      appearance: { cutout: 'dynamic-island' as const },
    };
    vi.mocked(chrome.debugger.attach).mockResolvedValue(undefined);
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async () => ({}) as never);

    await prepareDeviceShellWebViewEnvironmentForTab(4256, deviceConfig, injected, {
      splitScreen: true,
    });

    expect(getTabState(4256)?.appProfileChildTargetEnvironment?.preserveChildViewport).toBe(true);
    expect(getTabState(4256)?.appProfileChildTargetEnvironment?.source).toContain(
      '"screenWidth":null',
    );
    cleanupTab(4256);
  });

  it('恢复页面尺寸后关闭旧 WebView 设备环境且不残留设备安全区', async () => {
    const { injected } = resolveAppProfile('reader');
    const { cleanupTab, getTabState, prepareAppProfileWebViewEnvironmentForTab } =
      await import('../debuggerManager');
    const { clearEmulationConfigForTab } = await import('../deviceEmulationState');
    const deviceConfig = {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: 'standard safari',
      platform: 'iPhone',
      platformVersion: '17.0',
      architecture: '',
      model: 'iPhone',
      touch: true,
      orientation: 'portrait' as const,
      safeAreaInsets: insets,
      appearance: { cutout: 'dynamic-island' as const },
    };
    await prepareAppProfileWebViewEnvironmentForTab(4257, injected, deviceConfig);
    expect(getTabState(4257)?.appProfileChildTargetEnvironment).toBeDefined();
    clearEmulationConfigForTab(4257);
    vi.mocked(chrome.debugger.sendCommand).mockClear();

    await prepareAppProfileWebViewEnvironmentForTab(4257, injected);

    expect(getTabState(4257)?.appProfileChildTargetEnvironment).toBeUndefined();
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4257 },
      'Target.setAutoAttach',
      { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4257 },
      'Emulation.setDeviceMetricsOverride',
      expect.anything(),
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4257 },
      'Emulation.setSafeAreaInsetsOverride',
      expect.anything(),
    );
    cleanupTab(4257);
  });

  it('App WebView 使用客户端 UA 时不覆盖独立设备的逻辑配置', async () => {
    const { injected } = resolveAppProfile('reader');
    const { cleanupTab, enableEmulationForTab, prepareAppProfileWebViewEnvironmentForTab } =
      await import('../debuggerManager');
    const { getEmulationConfigForTab } = await import('../deviceEmulationState');
    const deviceConfig = {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      userAgent: 'standard safari',
      platform: 'iPhone',
      platformVersion: '17.0',
      architecture: '',
      model: 'iPhone',
      touch: true,
      orientation: 'portrait' as const,
      safeAreaInsets: insets,
      appearance: { cutout: 'dynamic-island' as const },
    };

    await enableEmulationForTab(4258, deviceConfig);
    await prepareAppProfileWebViewEnvironmentForTab(4258, injected, deviceConfig);

    expect(getEmulationConfigForTab(4258)).toEqual(deviceConfig);
    expect(getEmulationConfigForTab(4258)?.userAgent).toBe('standard safari');
    cleanupTab(4258);
  });

  it('读取页面实际 CSS env 值并用于精确校验', async () => {
    chrome.debugger.sendCommand = vi.fn((_target: unknown, method: string) =>
      method === 'Runtime.evaluate'
        ? Promise.resolve({ result: { value: insets } })
        : Promise.resolve({}),
    ) as any;
    const { cleanupTab, readSafeAreaRuntimeState, safeAreaRuntimeStateMatches } =
      await import('../debuggerManager');

    const actual = await readSafeAreaRuntimeState(4253);

    expect(actual).toEqual(insets);
    expect(safeAreaRuntimeStateMatches(actual, insets)).toBe(true);
    expect(safeAreaRuntimeStateMatches(actual, { top: 0, right: 0, bottom: 0, left: 0 })).toBe(
      false,
    );
    cleanupTab(4253);
  });

  it('关闭时只清空安全区并允许 session 释放', async () => {
    const { cleanupTab, disableSafeAreaInsetsForTab, enableSafeAreaInsetsForTab, getTabState } =
      await import('../debuggerManager');
    await enableSafeAreaInsetsForTab(4254, insets);
    vi.mocked(chrome.debugger.sendCommand).mockClear();

    await disableSafeAreaInsetsForTab(4254);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4254 },
      'Emulation.setSafeAreaInsetsOverride',
      { insets: {} },
    );
    expect(getTabState(4254)?.safeAreaInsetsOverride).toBeUndefined();
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 4254 });
    cleanupTab(4254);
  });
});

describe('App profile 新文档运行时', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.sendCommand = vi.fn((_target: unknown, method: string) =>
      method === 'Page.addScriptToEvaluateOnNewDocument'
        ? Promise.resolve({ identifier: 'app-profile-script-1' })
        : Promise.resolve({}),
    ) as any;
  });

  it('clears request bookkeeping after delivering the top HTML response to its root WebView', async () => {
    const { createRootWebViewNavigation } = await import('@mearl/browser-core');
    const { enableModificationForTab, getTabState, handleRequestPaused, cleanupTab } =
      await import('../debuggerManager');
    const tabId = 4270;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Fetch.getResponseBody'
        ? { body: '<html>fixture</html>', base64Encoded: false }
        : {},
    );
    await enableModificationForTab(tabId);
    const state = getTabState(tabId)!;
    state.rootWebViewNavigation = createRootWebViewNavigation({
      client: {
        sendCommand: (method, payload) => chrome.debugger.sendCommand({ tabId }, method, payload),
      },
      shellHeaders: async () => [],
    });
    state.rootWebViewNavigation.initialize({ frame: { id: 'main', url: 'https://example.test/' } });
    const params = {
      requestId: 'document',
      frameId: 'main',
      resourceType: 'Document',
      request: { url: 'https://example.test/', method: 'GET', headers: {} },
    };
    try {
      await handleRequestPaused(tabId, params);
      expect(state.requestStates.has('document')).toBe(true);
      await handleRequestPaused(tabId, {
        ...params,
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      });
      expect(state.requestStates.has('document')).toBe(false);
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId },
        'Fetch.fulfillRequest',
        expect.objectContaining({ responseCode: 200 }),
      );
    } finally {
      cleanupTab(tabId);
    }
  });

  it.each([undefined, 0])(
    'delivers HTML response overrides through the root WebView (duration: %s)',
    async duration => {
      const { createRootWebViewNavigation } = await import('@mearl/browser-core');
      const { setResponseOverride, getTabState, handleRequestPaused, cleanupTab } =
        await import('../debuggerManager');
      const tabId = duration === undefined ? 4271 : 4272;
      const html = '<html>mocked document</html>';
      const responseHeaders = [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }];
      await setResponseOverride(tabId, {
        apiName: '/mock-document',
        responseData: html,
        responseHeaders,
        duration,
      });
      const state = getTabState(tabId)!;
      state.rootWebViewNavigation = createRootWebViewNavigation({
        client: {
          sendCommand: (method, payload) => chrome.debugger.sendCommand({ tabId }, method, payload),
        },
        shellHeaders: async () => [],
      });
      state.rootWebViewNavigation.initialize({
        frame: { id: 'main', url: 'https://example.test/mock-document' },
      });
      const params = {
        requestId: 'document',
        frameId: 'main',
        resourceType: 'Document',
        request: { url: 'https://example.test/mock-document', method: 'GET', headers: {} },
      };
      try {
        await handleRequestPaused(tabId, params);
        if (duration === undefined)
          await handleRequestPaused(tabId, { ...params, responseStatusCode: 200, responseHeaders });
        const delivery = vi
          .mocked(chrome.debugger.sendCommand)
          .mock.calls.find(
            call =>
              call[1] === 'Fetch.fulfillRequest' &&
              (call[2] as { requestId?: string }).requestId === 'document',
          )![2] as { responseHeaders: Array<{ name: string; value: string }> };
        const token = delivery.responseHeaders
          .find(header => header.value.startsWith('mearl-document;'))!
          .value.match(/desc="([^"]+)"/)![1];
        state.rootWebViewNavigation.handleFrameEvent('Page.frameAttached', {
          frameId: 'root',
          parentFrameId: 'main',
        });
        await handleRequestPaused(tabId, {
          ...params,
          requestId: 'replay',
          frameId: 'root',
          request: { ...params.request, url: 'https://example.test/.mearl-document/' + token },
        });
        expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
          { tabId },
          'Fetch.fulfillRequest',
          expect.objectContaining({ requestId: 'replay', body: btoa(html) }),
        );
        expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
          expect.anything(),
          'Fetch.getResponseBody',
          expect.anything(),
        );
        expect(state.requestStates.size).toBe(0);
      } finally {
        cleanupTab(tabId);
      }
    },
  );

  it('App 与外壳共享 Service Worker 绕过状态，最后一个模拟关闭后恢复', async () => {
    const {
      cleanupTab,
      enableAppProfileDocumentBootstrapForTab,
      disableAppProfileDocumentBootstrapForTab,
      prepareDeviceShellWebViewEnvironmentForTab,
      clearDeviceShellWebViewEnvironmentForTab,
    } = await import('../debuggerManager');
    const config = resolveAppProfile('reader').injected;
    const device = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const bypassCalls = () =>
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(call => call[1] === 'Network.setBypassServiceWorker')
        .map(call => call[2]);
    try {
      await enableAppProfileDocumentBootstrapForTab(4269, config);
      await prepareDeviceShellWebViewEnvironmentForTab(4269, device, config);
      await disableAppProfileDocumentBootstrapForTab(4269);
      expect(bypassCalls().at(-1)).toEqual({ bypass: true });
      await clearDeviceShellWebViewEnvironmentForTab(4269);
      expect(bypassCalls().at(-1)).toEqual({ bypass: false });

      await prepareDeviceShellWebViewEnvironmentForTab(4269, device);
      expect(bypassCalls().at(-1)).toEqual({ bypass: true });
      await enableAppProfileDocumentBootstrapForTab(4269, config);
      await clearDeviceShellWebViewEnvironmentForTab(4269);
      expect(bypassCalls().at(-1)).toEqual({ bypass: true });
      await disableAppProfileDocumentBootstrapForTab(4269);
      expect(bypassCalls().at(-1)).toEqual({ bypass: false });
    } finally {
      cleanupTab(4269);
    }
  });

  it('waits for a top-document update and forwards the new UA without affecting subframes', async () => {
    const {
      cleanupTab,
      enableAppProfileDocumentBootstrapForTab,
      handleRequestPaused,
      setAppProfileNavigationRefresh,
    } = await import('../debuggerManager');
    const config = resolveAppProfile('wallet', { appVersion: '15.0' }).injected;
    const refresh = vi.fn(async (_tabId: number, prepare?: () => Promise<void>) => {
      await prepare?.();
      return config;
    });
    setAppProfileNavigationRefresh(refresh);
    try {
      const original = vi.mocked(chrome.debugger.sendCommand).getMockImplementation()!;
      vi.mocked(chrome.debugger.sendCommand).mockImplementation((target, method, params) =>
        method === 'Page.getFrameTree'
          ? Promise.resolve({ frameTree: { frame: { id: 'main' } } })
          : original(target, method, params),
      );
      await enableAppProfileDocumentBootstrapForTab(4268, config);
      chrome.tabs.get = vi.fn().mockResolvedValue({ url: 'https://example.test/' });
      chrome.tabs.reload = vi.fn().mockResolvedValue(undefined);
      const request = {
        url: 'https://example.test/',
        method: 'GET',
        headers: { 'User-Agent': 'old', Accept: 'text/html' },
      };
      await handleRequestPaused(4268, {
        requestId: 'child',
        frameId: 'child',
        resourceType: 'Document',
        request,
      });
      expect(refresh).not.toHaveBeenCalled();
      await handleRequestPaused(4268, {
        requestId: 'main',
        frameId: 'main',
        resourceType: 'Document',
        request,
      });
      expect(refresh).toHaveBeenCalledWith(4268, expect.any(Function));
      expect(
        vi
          .mocked(chrome.debugger.sendCommand)
          .mock.calls.filter(call => call[1] === 'Page.getFrameTree'),
      ).toHaveLength(1);
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 4268 },
        'Fetch.fulfillRequest',
        {
          requestId: 'main',
          responseCode: 204,
          responseHeaders: [{ name: 'Cache-Control', value: 'no-store' }],
        },
      );
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 4268 }, 'Page.reload', {
        ignoreCache: false,
      });
      refresh.mockRejectedValueOnce(new Error('update failed'));
      await handleRequestPaused(4268, {
        requestId: 'failed',
        frameId: 'main',
        resourceType: 'Document',
        request,
      });
      expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
        { tabId: 4268 },
        'Fetch.continueRequest',
        {
          requestId: 'failed',
          headers: [
            { name: 'Accept', value: 'text/html' },
            { name: 'User-Agent', value: config.userAgent },
          ],
        },
      );
    } finally {
      setAppProfileNavigationRefresh(async () => undefined);
      cleanupTab(4268);
    }
  });

  it('在业务导航前注册分角色启动脚本并按相同配置幂等', async () => {
    const { injected } = resolveAppProfile('reader');
    const { cleanupTab, enableAppProfileDocumentBootstrapForTab, getTabState } =
      await import('../debuggerManager');

    await enableAppProfileDocumentBootstrapForTab(4261, injected);
    await enableAppProfileDocumentBootstrapForTab(4261, injected);

    const addCalls = vi
      .mocked(chrome.debugger.sendCommand)
      .mock.calls.filter(call => call[1] === 'Page.addScriptToEvaluateOnNewDocument');
    expect(addCalls).toHaveLength(1);
    const source = (addCalls[0]?.[2] as { source?: string })?.source ?? '';
    expect(source).toContain('Sample/10.0.9');
    expect(source).toContain('window === window.top');
    expect(source).toContain('__mearlAppProfile__');
    expect(getTabState(4261)?.appProfileDocumentBootstrap).toEqual({
      identifier: 'app-profile-script-1',
      configKey: JSON.stringify(injected),
    });
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    cleanupTab(4261);
  });

  it('清除 profile 时只移除 App 跨导航脚本', async () => {
    const { injected } = resolveAppProfile('reader');
    const {
      cleanupTab,
      disableAppProfileDocumentBootstrapForTab,
      enableAppProfileDocumentBootstrapForTab,
      getTabState,
    } = await import('../debuggerManager');
    await enableAppProfileDocumentBootstrapForTab(4262, injected);

    await disableAppProfileDocumentBootstrapForTab(4262);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4262 },
      'Page.removeScriptToEvaluateOnNewDocument',
      { identifier: 'app-profile-script-1' },
    );
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 4262 },
      'Target.setAutoAttach',
      expect.anything(),
    );
    expect(getTabState(4262)?.appProfileDocumentBootstrap).toBeUndefined();
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 4262 });
    cleanupTab(4262);
  });
});

describe('session 内重载与模拟态读取', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
  });

  it('并发模拟命令晚到的断连错误不会清除已恢复的页面会话', async () => {
    const { acquireDebuggerLease, getDebuggerSessionDebugState } =
      await import('../debuggerSessionManager');
    const { enableEmulationForTab, cleanupTab } = await import('../debuggerManager');
    const config = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const failures: Array<(error: Error) => void> = [];
    let metricsCalls = 0;
    chrome.debugger.sendCommand = vi.fn((_target, method) => {
      if (method === 'Emulation.setDeviceMetricsOverride' && metricsCalls++ < 2) {
        return new Promise((_resolve, reject) => failures.push(reject));
      }
      return Promise.resolve({});
    }) as any;
    const initial = await acquireDebuggerLease(4304, { consumer: 'initial-page' });
    const first = enableEmulationForTab(4304, config);
    const second = enableEmulationForTab(4304, config);
    await vi.waitFor(() => expect(failures).toHaveLength(2));

    failures[0]!(new Error('Debugger is not attached to the tab with id: 4304.'));
    await first;
    const invalidated = vi.fn();
    const restored = await acquireDebuggerLease(4304, {
      consumer: 'restored-page',
      domains: ['Page'],
      onInvalidated: invalidated,
    });
    failures[1]!(new Error('Debugger is not attached to the tab with id: 4304.'));
    await second;

    expect(invalidated).not.toHaveBeenCalled();
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(getDebuggerSessionDebugState(4304)?.generation).toBe(restored.generation);
    expect(getDebuggerSessionDebugState(4304)?.consumers).toContain('restored-page');
    await initial.release();
    await restored.release();
    cleanupTab(4304);
  });

  /**
   * chrome.tabs.reload() 会间歇性断开 debugger session，Emulation override 随之丢失
   * （实测：reload 后读取模拟态报 not attached，页面回到桌面态）。Page.reload 是 session
   * 内部命令，不经由 tabs API 重新接管标签页。
   */
  it('重载走 CDP Page.reload，不碰 chrome.tabs.reload', async () => {
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});
    const tabsReload = vi.fn();
    chrome.tabs = { reload: tabsReload } as any;

    const { reloadTabInSession, cleanupTab } = await import('../debuggerManager');
    await reloadTabInSession(4301);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 4301 },
      'Page.reload',
      expect.anything(),
    );
    expect(tabsReload).not.toHaveBeenCalled();
    cleanupTab(4301);
  });

  it('读取模拟态走 lease，session 已断时返回 null 而不是抛错', async () => {
    chrome.debugger.attach = vi.fn().mockRejectedValue(new Error('Cannot attach to this target.'));
    chrome.debugger.sendCommand = vi
      .fn()
      .mockRejectedValue(new Error('Debugger is not attached to the tab with id: 4302.'));

    const { readEmulationRuntimeState, cleanupTab } = await import('../debuggerManager');
    await expect(readEmulationRuntimeState(4302)).resolves.toBeNull();
    cleanupTab(4302);
  });

  it('表达式抛异常时按读不到处理', async () => {
    chrome.debugger.sendCommand = vi.fn((_target: unknown, method: string) =>
      method === 'Runtime.evaluate'
        ? Promise.resolve({ result: { value: undefined }, exceptionDetails: { text: 'boom' } })
        : Promise.resolve({}),
    ) as any;

    const { readEmulationRuntimeState, cleanupTab } = await import('../debuggerManager');
    await expect(readEmulationRuntimeState(4303)).resolves.toBeNull();
    cleanupTab(4303);
  });
});
