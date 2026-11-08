import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InjectedAppProfileConfig, ResolvedEmulationConfig } from '@mearl/browser-core';

const STRIP_RULE_ID = 999800;
const CONFIG_ID_START = 999801;
const runtime = vi.hoisted(() => ({
  pinPageRuntimes: vi.fn(),
  synchronizePageRuntimePins: vi.fn(),
}));
vi.mock('../../appProfileHostCapabilities', async original => ({ ...await original<typeof import('../../appProfileHostCapabilities')>(), captureAppProfileHostCapabilities: async (config: InjectedAppProfileConfig) => config }));
vi.mock('../../browserCapabilityRegistry', () => ({ browserCapabilityRegistry: () => runtime }));
afterEach(() => vi.unstubAllGlobals());

interface SessionRuleUpdate {
  removeRuleIds?: number[];
  addRules?: chrome.declarativeNetRequest.Rule[];
}

/**
 * updateSessionRules 的替身。slowWrites() 后每次写入需要一个宏任务才完成，并记录
 * 同时在飞的写入数（maxInFlight）——共享剥头规则的正确性依赖「读快照 + 写入」
 * 全程不交叠，因此 maxInFlight 就是串行不变量的直接度量。
 */
function createDnrStub() {
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  let slow = false;
  let inFlight = 0;
  let maxInFlight = 0;

  const updateSessionRules = vi.fn(async (update: SessionRuleUpdate) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (slow) await new Promise(resolve => setTimeout(resolve, 0));
      for (const id of update.removeRuleIds ?? []) rules.delete(id);
      for (const rule of update.addRules ?? []) rules.set(rule.id, rule);
    } finally {
      inFlight -= 1;
    }
  });

  return {
    rules,
    updateSessionRules,
    getSessionRules: vi.fn(async () => [...rules.values()]),
    slowWrites() {
      slow = true;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    stripTabIds(): number[] | undefined {
      return rules.get(STRIP_RULE_ID)?.condition.tabIds;
    },
  };
}

function sampleConfig(profile: string): InjectedAppProfileConfig {
  return {
    profile,
    label: profile,
    globals: {},
    bridges: [],
    activeEvents: [],
    maxTouchPoints: 5,
    statusBarHeight: 59,
    language: 'zh-Hans',
    userAgent: `Mozilla/5.0 Sample/${profile}/1.0`,
    navigatorPlatform: 'iPhone',
    platform: 'iOS',
    systemVersion: '17.5',
    clientType: 'iphone',
    actions: { open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [] },
    schemes: [],
  };
}

function sampleEmulation(): ResolvedEmulationConfig {
  return {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    scale: 1,
    mobile: true,
    userAgent: 'standard safari',
    platform: 'iPhone',
    platformVersion: '17.0',
    architecture: '',
    model: 'iPhone',
    touch: true,
    orientation: 'portrait',
    safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    appearance: { cutout: 'dynamic-island' },
  };
}

let dnr: ReturnType<typeof createDnrStub>;
let rulesModule: typeof import('../appProfileRules');

beforeEach(async () => {
  runtime.pinPageRuntimes.mockReset().mockResolvedValue(undefined);
  runtime.synchronizePageRuntimePins.mockReset().mockResolvedValue(undefined);
  dnr = createDnrStub();
  (global.chrome as unknown as Record<string, unknown>).declarativeNetRequest = {
    updateSessionRules: dnr.updateSessionRules,
    getSessionRules: dnr.getSessionRules,
  };
  (global.chrome as unknown as Record<string, unknown>).action = {
    setIcon: vi.fn((_: unknown, callback?: () => void) => callback?.()),
    setBadgeText: vi.fn((_: unknown, callback?: () => void) => callback?.()),
    setBadgeBackgroundColor: vi.fn(),
  };
  // 模块持有 tabId→规则的内存登记表，每个用例都要新实例
  vi.resetModules();
  rulesModule = await import('../appProfileRules');
});

const hostCapabilities = (sha256 = 'c'.repeat(64)) => ({ modules: { protocol: { sha256, revision: 'accepted', handlers: ['identity'] } }, bindings: { 'app.userInfo.resolve': { module: 'protocol', handler: 'identity' } } });

describe('applyAppProfileForTab', () => {
  it('retains both versions during the rule write and restores references when DNR fails', async () => {
    const first = {
      ...sampleConfig('reader'),
      pageRuntime: { id: 'simulation/main', sha256: 'a'.repeat(64) },
      hostCapabilities: hostCapabilities(),
    };
    await rulesModule.applyAppProfileForTab(7, first);
    runtime.pinPageRuntimes.mockClear();
    dnr.updateSessionRules.mockRejectedValueOnce(new Error('DNR rejected'));
    const next = { ...first, pageRuntime: { ...first.pageRuntime, sha256: 'b'.repeat(64) }, hostCapabilities: hostCapabilities('d'.repeat(64)) };
    await expect(rulesModule.applyAppProfileForTab(7, next)).rejects.toThrow('DNR rejected');
    expect(runtime.pinPageRuntimes.mock.calls.map(([patch]) => patch)).toEqual([
      { 'tab:7': next.pageRuntime.sha256, 'tab:7:host:protocol': 'd'.repeat(64), 'rule:7': first.pageRuntime.sha256, 'rule:7:host:protocol': 'c'.repeat(64) },
      { 'tab:7': first.pageRuntime.sha256, 'tab:7:host:protocol': 'c'.repeat(64), 'rule:7': null, 'rule:7:host:protocol': null },
    ]);
    expect(await rulesModule.getAppProfileForTab(7)).toEqual(first);
  });
  it('rebuilds exact references from session rules on worker restart and releases a cleared tab', async () => {
    const config = {
      ...sampleConfig('reader'),
      pageRuntime: { id: 'simulation/main', sha256: 'a'.repeat(64) },
      hostCapabilities: hostCapabilities(),
    };
    await rulesModule.applyAppProfileForTab(7, config);
    vi.stubGlobal('indexedDB', {});
    vi.resetModules();
    const restored = await import('../appProfileRules');
    expect(await restored.getAppProfileForTab(7)).toEqual(config);
    expect(runtime.synchronizePageRuntimePins).toHaveBeenLastCalledWith({
      'tab:7': config.pageRuntime.sha256,
      'tab:7:host:protocol': 'c'.repeat(64),
    });
    await restored.clearAppProfileForTab(7);
    expect(runtime.pinPageRuntimes).toHaveBeenLastCalledWith({ 'tab:7': null, 'tab:7:host:protocol': null });
  });
  it('下发带 base64 配置的 server-timing 规则，并把该 tab 纳入共享剥头规则', async () => {
    const config = sampleConfig('reader');
    await rulesModule.applyAppProfileForTab(7, config);

    const configRule = dnr.rules.get(CONFIG_ID_START);
    expect(configRule?.condition.tabIds).toEqual([7]);
    expect(configRule?.condition.resourceTypes).toEqual(['main_frame', 'sub_frame']);

    const header = configRule?.action.responseHeaders?.[0];
    expect(header?.header).toBe('server-timing');
    expect(header?.operation).toBe('append');
    const encoded = /desc="([^"]+)"/.exec(header?.value ?? '')?.[1] ?? '';
    expect(JSON.parse(decodeURIComponent(escape(atob(encoded))))).toEqual({
      version: 1,
      config,
      ownsDeviceEmulation: false,
    });

    expect(dnr.stripTabIds()).toEqual([7]);
    expect(dnr.rules.get(STRIP_RULE_ID)?.condition.resourceTypes).toEqual([
      'main_frame',
      'sub_frame',
    ]);
    expect(await rulesModule.getAppProfileForTab(7)).toEqual(config);
    expect(await rulesModule.appProfileOwnsDeviceEmulation(7)).toBe(false);
  });

  it('Service Worker 重启后从 DNR 规则重建档案、设备配置与 rule ID 占用', async () => {
    const reader = sampleConfig('reader');
    const deviceEmulation = sampleEmulation();
    await rulesModule.applyAppProfileForTab(7, reader, {
      ownsDeviceEmulation: true,
      deviceEmulation,
    });

    vi.resetModules();
    rulesModule = await import('../appProfileRules');

    expect(await rulesModule.getAppProfileForTab(7)).toEqual(reader);
    expect(await rulesModule.getAppProfileDeviceEmulationForTab(7)).toEqual(deviceEmulation);
    expect(await rulesModule.appProfileOwnsDeviceEmulation(7)).toBe(true);
    await rulesModule.applyAppProfileForTab(8, sampleConfig('shop'));

    expect(dnr.rules.get(CONFIG_ID_START)?.condition.tabIds).toEqual([7]);
    expect(dnr.rules.get(CONFIG_ID_START + 1)?.condition.tabIds).toEqual([8]);
    expect(dnr.stripTabIds()).toEqual([7, 8]);
  });

  it('多 tab 各自一条配置规则，剥头规则累积全部 tabId', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));
    await rulesModule.applyAppProfileForTab(8, sampleConfig('shop'));

    expect(dnr.rules.get(CONFIG_ID_START)?.condition.tabIds).toEqual([7]);
    expect(dnr.rules.get(CONFIG_ID_START + 1)?.condition.tabIds).toEqual([8]);
    expect(dnr.stripTabIds()).toEqual([7, 8]);
    expect(await rulesModule.listAppProfileTabIds()).toEqual([7, 8]);
  });

  it('对同一 tab 重复应用会先清除旧规则，不残留旧 ruleId', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'), {
      ownsDeviceEmulation: true,
    });
    expect(await rulesModule.appProfileOwnsDeviceEmulation(7)).toBe(true);
    await rulesModule.applyAppProfileForTab(7, sampleConfig('shop'));

    expect(dnr.rules.has(CONFIG_ID_START)).toBe(false);
    expect(dnr.rules.get(CONFIG_ID_START + 1)?.condition.tabIds).toEqual([7]);
    expect((await rulesModule.getAppProfileForTab(7))?.profile).toBe('shop');
    expect(await rulesModule.appProfileOwnsDeviceEmulation(7)).toBe(false);
    expect(await rulesModule.listAppProfileTabIds()).toEqual([7]);
  });

  it('恢复页面尺寸时清除持久化设备配置但保留 App profile', async () => {
    const config = sampleConfig('reader');
    await rulesModule.applyAppProfileForTab(7, config, {
      ownsDeviceEmulation: true,
      deviceEmulation: sampleEmulation(),
    });

    const activeConfig = await rulesModule.releaseAppProfileDeviceEmulationForTab(7);

    expect(activeConfig).toEqual(config);
    expect(await rulesModule.getAppProfileForTab(7)).toEqual(config);
    expect(await rulesModule.getAppProfileDeviceEmulationForTab(7)).toBeUndefined();
    expect(await rulesModule.appProfileOwnsDeviceEmulation(7)).toBe(false);
    const currentRule = dnr.rules.get(CONFIG_ID_START + 1);
    const encoded = /desc="([^"]+)"/.exec(
      currentRule?.action.responseHeaders?.[0]?.value ?? '',
    )?.[1];
    expect(JSON.parse(decodeURIComponent(escape(atob(encoded ?? ''))))).toEqual({
      version: 1,
      config,
      ownsDeviceEmulation: false,
    });
  });

  it('切换到 Duo 展开横屏时同步档案安全区与状态栏 Cookie', async () => {
    const config: InjectedAppProfileConfig = {
      ...sampleConfig('reader'),
      safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
      deviceAppearance: {
        preset: 'iphone-15-pro',
        orientation: 'portrait',
        cutout: 'dynamic-island',
      },
      rootContainer: {
        enabled: false,
        initialCookies: [{ name: '_layer_barHeight', value: '59', domain: 'shop.com', path: '/' }],
      },
    };
    const duo: ResolvedEmulationConfig = {
      ...sampleEmulation(),
      width: 951,
      height: 669,
      orientation: 'landscape',
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
      appearance: { cutout: 'none' },
      presetName: 'iphone-duo-unfolded',
    };
    await rulesModule.applyAppProfileForTab(7, config);

    const activeConfig = await rulesModule.releaseAppProfileDeviceEmulationForTab(7, duo);

    expect(activeConfig).toMatchObject({
      statusBarHeight: 0,
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
      deviceAppearance: {
        preset: 'iphone-duo-unfolded',
        orientation: 'landscape',
        cutout: 'none',
      },
      rootContainer: {
        initialCookies: [{ name: '_layer_barHeight', value: '0' }],
      },
    });
    expect(await rulesModule.getAppProfileForTab(7)).toEqual(activeConfig);
  });

  it('页面导航后可按当前档案重新设置 tab 图标', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));
    const setIcon = chrome.action.setIcon as ReturnType<typeof vi.fn>;
    setIcon.mockClear();

    await rulesModule.refreshAppProfileActionIconForTab(7);

    expect(setIcon).toHaveBeenCalledWith(
      {
        tabId: 7,
        path: 'icons/app-profiles/generic-32.png',
      },
      expect.any(Function),
    );
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith(
      { tabId: 7, text: '' },
      expect.any(Function),
    );
  });

  it('普通 tab 导航不写入 tab 级图标', async () => {
    await rulesModule.refreshAppProfileActionIconForTab(99);

    expect(chrome.action.setIcon).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
  });
});

describe('clearAppProfileForTab', () => {
  it('移除该 tab 的配置规则并从剥头规则中摘除', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));
    await rulesModule.applyAppProfileForTab(8, sampleConfig('shop'));

    await rulesModule.clearAppProfileForTab(7);

    expect(dnr.rules.has(CONFIG_ID_START)).toBe(false);
    expect(dnr.stripTabIds()).toEqual([8]);
    expect(await rulesModule.getAppProfileForTab(7)).toBeUndefined();
    expect(await rulesModule.appProfileOwnsDeviceEmulation(7)).toBe(false);
  });

  it('最后一个 tab 清除后整条剥头规则被移除', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));
    await rulesModule.clearAppProfileForTab(7);

    expect(dnr.rules.has(STRIP_RULE_ID)).toBe(false);
    expect(await rulesModule.listAppProfileTabIds()).toEqual([]);
  });

  it('未登记的 tab 不产生任何 DNR 写入', async () => {
    await rulesModule.clearAppProfileForTab(99);
    expect(dnr.updateSessionRules).not.toHaveBeenCalled();
  });

  it('DNR 写入失败时恢复登记，供后续清理路径重试', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));
    dnr.updateSessionRules.mockRejectedValueOnce(new Error('quota'));

    await expect(rulesModule.clearAppProfileForTab(7)).rejects.toThrow('quota');
    expect(await rulesModule.listAppProfileTabIds()).toEqual([7]);
  });
});

describe('cleanupClosedTabAppProfile', () => {
  it('只回收规则状态，不访问已经关闭的 tab', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));
    const setIcon = chrome.action.setIcon as ReturnType<typeof vi.fn>;
    const setBadgeText = chrome.action.setBadgeText as ReturnType<typeof vi.fn>;
    setIcon.mockClear();
    setBadgeText.mockClear();

    await rulesModule.cleanupClosedTabAppProfile(7);

    expect(dnr.rules.has(CONFIG_ID_START)).toBe(false);
    expect(dnr.rules.has(CONFIG_ID_START + 50)).toBe(false);
    expect(dnr.rules.has(STRIP_RULE_ID)).toBe(false);
    expect(await rulesModule.listAppProfileTabIds()).toEqual([]);
    expect(setIcon).not.toHaveBeenCalled();
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});

describe('共享剥头规则的并发写入', () => {
  it('并发 apply 与 clear 串行落地，不会出现交叠的规则写入', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));

    dnr.slowWrites();
    await Promise.all([
      rulesModule.applyAppProfileForTab(8, sampleConfig('shop')),
      rulesModule.clearAppProfileForTab(7),
    ]);

    // 剥头规则的 tabIds 是从登记表重算的快照，一旦两个操作的「读快照 + 写入」交叠，
    // 后落地的那次就会把旧值写回。串行队列保证同时在飞的写入不超过一个。
    expect(dnr.maxInFlight).toBe(1);
    expect(dnr.stripTabIds()).toEqual([8]);
    expect(await rulesModule.listAppProfileTabIds()).toEqual([8]);
  });
});

/**
 * 容器 UA 走 DNR 请求头改写而不是 CDP Emulation.setUserAgentOverride：后者在导航时序上
 * 不可靠（实测：命令返回成功、session 也活着，页面读到的仍是桌面 UA），DNR 与导航时序无关。
 */
describe('容器 UA 的请求头改写规则', () => {
  it('与配置规则成对下发，覆盖该 tab 的全部请求', async () => {
    const config = sampleConfig('reader');
    await rulesModule.applyAppProfileForTab(7, config);

    const uaRule = dnr.rules.get(CONFIG_ID_START + 50);
    expect(uaRule?.condition.tabIds).toEqual([7]);
    // 不限 resourceTypes：页面的 mtop/接口请求也要带容器 UA
    expect(uaRule?.condition.resourceTypes).toBeUndefined();
    expect(uaRule?.action.requestHeaders).toEqual([
      { header: 'user-agent', operation: 'set', value: config.userAgent },
    ]);
  });

  it('清除时与配置规则一并移除', async () => {
    await rulesModule.applyAppProfileForTab(7, sampleConfig('reader'));
    await rulesModule.clearAppProfileForTab(7);

    expect(dnr.rules.has(CONFIG_ID_START)).toBe(false);
    expect(dnr.rules.has(CONFIG_ID_START + 50)).toBe(false);
  });
});
