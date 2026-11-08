/**
 * App 容器模拟的 DNR 规则管理（per-tab session rules）
 *
 * 三类规则：
 * - 配置下发（每 tab 一条）：server-timing: mearl-app-profile;desc="<base64(config)>"
 *   early-inject.ts 在 document_start 同步读取，为该 tab 的所有 frame 安装容器模拟运行时
 * - 容器 UA（每 tab 一条）：改写所有 frame 请求的 user-agent 头；document_start
 *   使用同一份 profile 值初始化 navigator.userAgent。
 * - 容器文档剥头（全部模拟 tab 共享一条）：main_frame / sub_frame 响应移除
 *   X-Frame-Options / CSP（frame-ancestors 无法单独剥，整头移除），
 *   top 壳和容器 WebView 才能稳定加载带嵌入限制的页面
 *
 * ID 区间：999800–999899（999800 为共享剥头规则，999801–999849 按 tab 游标分配配置规则，
 * 对应的 UA 规则固定为配置规则 ID + 50）
 */

import type { InjectedAppProfileConfig, ResolvedEmulationConfig } from '@mearl/browser-core';
import { markEnvironmentMutation } from '../environmentRevisions';
import { updateAppProfileActionIcon } from './appProfileActionIcon';
import { appProfileRuntimePins, captureAppProfileHostCapabilities, replaceAppProfileRuntimePins } from '../appProfileHostCapabilities';
import { browserCapabilityRegistry } from '../browserCapabilityRegistry';

export const APP_PROFILE_SERVER_TIMING_KEY = 'mearl-app-profile';

const APP_PROFILE_STRIP_RULE_ID = 999800;
const APP_PROFILE_CONFIG_ID_START = 999801;
const APP_PROFILE_CONFIG_ID_END = 999849;
/** UA 规则与配置规则成对，ID 固定偏移避开分配冲突 */
const APP_PROFILE_UA_ID_OFFSET = 50;

interface AppProfileRulePayload {
  version: 1;
  config: InjectedAppProfileConfig;
  ownsDeviceEmulation: boolean;
  deviceEmulation?: ResolvedEmulationConfig;
}

interface AppProfileTabEntry {
  ruleId: number;
  config: InjectedAppProfileConfig;
  ownsDeviceEmulation: boolean;
  deviceEmulation?: ResolvedEmulationConfig;
}

interface ApplyAppProfileOptions {
  ownsDeviceEmulation?: boolean;
  deviceEmulation?: ResolvedEmulationConfig;
}

/** tabId → 配置规则。Service Worker 重启后会从 session rules 重建。 */
const appProfileTabs = new Map<number, AppProfileTabEntry>();

export async function getAppProfileBootstrapHeaderForTab(tabId: number) {
  await ensureHydrated();
  const current = appProfileTabs.get(tabId);
  if (!current) return undefined;
  const { ruleId: _ruleId, ...payload } = current;
  return {
    name: 'Server-Timing',
    value: `${APP_PROFILE_SERVER_TIMING_KEY};desc="${encodeConfig({ version: 1, ...payload })}"`,
  };
}
let ruleIdCursor = APP_PROFILE_CONFIG_ID_START;
let hydrationPromise: Promise<void> | null = null;

// 剥头规则是全部模拟 tab 共用的一条（tabIds 条件），而它的内容要从 appProfileTabs
// 快照重算。多 tab 并发 apply/clear 时若不串行，后完成的那次会把旧快照写回去，
// 把已生效或已清除的 tab 弄错。所以所有规则写入都排入同一串行队列。
let ruleQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = ruleQueue.then(operation, operation);
  // 队列本身不应因单次失败而断掉
  ruleQueue = result.catch(() => {});
  return result;
}

function allocateRuleId(): number {
  const used = new Set([...appProfileTabs.values()].map(e => e.ruleId));
  const maxAttempts = APP_PROFILE_CONFIG_ID_END - APP_PROFILE_CONFIG_ID_START + 1;
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = ruleIdCursor;
    ruleIdCursor =
      candidate >= APP_PROFILE_CONFIG_ID_END ? APP_PROFILE_CONFIG_ID_START : candidate + 1;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('No available app profile DNR rule id');
}

/** 与 resourceRedirectRules 的 CONFIG 规则同一编码：UTF-8 安全 base64 JSON */
function encodeConfig(config: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(config))));
}

function decodeConfigRule(rule: chrome.declarativeNetRequest.Rule): AppProfileTabEntry | null {
  if (rule.id < APP_PROFILE_CONFIG_ID_START || rule.id > APP_PROFILE_CONFIG_ID_END) return null;
  const tabId = rule.condition.tabIds?.[0];
  const header = rule.action.responseHeaders?.find(
    candidate => candidate.header.toLowerCase() === 'server-timing',
  );
  const marker = `${APP_PROFILE_SERVER_TIMING_KEY};desc="`;
  const value = header?.value ?? '';
  const start = value.indexOf(marker);
  const end = start === -1 ? -1 : value.indexOf('"', start + marker.length);
  const encoded = start === -1 || end === -1 ? '' : value.slice(start + marker.length, end);
  if (tabId === undefined || !encoded) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(escape(atob(encoded)))) as AppProfileRulePayload;
    if (payload?.version !== 1) return null;
    const config = payload.config;
    if (!config || typeof config.profile !== 'string' || typeof config.userAgent !== 'string')
      return null;
    let deviceEmulation = payload.deviceEmulation;
    if (
      deviceEmulation &&
      (!Number.isFinite(deviceEmulation.width) ||
        !Number.isFinite(deviceEmulation.height) ||
        !Number.isFinite(deviceEmulation.deviceScaleFactor) ||
        typeof deviceEmulation.scale !== 'number' ||
        !Number.isFinite(deviceEmulation.scale) ||
        deviceEmulation.scale <= 0)
    )
      deviceEmulation = undefined;
    return {
      ruleId: rule.id,
      config,
      ownsDeviceEmulation: payload.ownsDeviceEmulation === true,
      deviceEmulation,
    };
  } catch {
    return null;
  }
}

/**
 * MV3 Service Worker 会随时被回收，但 DNR session rules 仍然存活。首次访问时以
 * DNR 为权威状态重建内存索引，避免已启用的 tab 在快捷设置中显示为未启用，
 * 也避免分配新 rule ID 时覆盖其他 tab 的规则。App profile 拥有的期望设备配置也随
 * 规则保存，worker 重启或 debugger 解绑后仍可在下次 WebView 导航前恢复。
 */
async function ensureHydrated(): Promise<void> {
  hydrationPromise ??= (async () => {
    const dnr = chrome.declarativeNetRequest;
    if (!dnr?.getSessionRules) return;
    const rules = await dnr.getSessionRules();
    for (const rule of rules) {
      const entry = decodeConfigRule(rule);
      const tabId = rule.condition.tabIds?.[0];
      if (entry && tabId !== undefined) appProfileTabs.set(tabId, entry);
    }
    if (typeof indexedDB !== 'undefined') {
      await browserCapabilityRegistry().synchronizePageRuntimePins(
        Object.fromEntries(
          [...appProfileTabs.entries()].flatMap(([tabId, entry]) => Object.entries(appProfileRuntimePins(`tab:${tabId}`, entry.config))),
        ),
      );
    }
  })().catch(error => {
    hydrationPromise = null;
    throw error;
  });
  await hydrationPromise;
}

export const hydrateAppProfileRules = () => ensureHydrated();

function buildStripRule(tabIds: number[]): chrome.declarativeNetRequest.Rule | undefined {
  if (tabIds.length === 0) return undefined;
  return {
    id: APP_PROFILE_STRIP_RULE_ID,
    priority: 100,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      responseHeaders: [
        {
          header: 'x-frame-options',
          operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
        },
        {
          header: 'content-security-policy',
          operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
        },
        {
          header: 'content-security-policy-report-only',
          operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
        },
      ],
    },
    condition: {
      resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
      tabIds,
    },
  };
}

function buildProfileRules(
  tabId: number,
  ruleId: number,
  config: InjectedAppProfileConfig,
  ownsDeviceEmulation: boolean,
  deviceEmulation?: ResolvedEmulationConfig,
): chrome.declarativeNetRequest.Rule[] {
  const payload: AppProfileRulePayload = {
    version: 1,
    config,
    ownsDeviceEmulation,
    ...(deviceEmulation ? { deviceEmulation } : {}),
  };
  return [
    {
      id: ruleId,
      priority: 100,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        responseHeaders: [
          {
            header: 'server-timing',
            operation: 'append' as chrome.declarativeNetRequest.HeaderOperation,
            value: `${APP_PROFILE_SERVER_TIMING_KEY};desc="${encodeConfig(payload)}"`,
          },
        ],
      },
      condition: {
        resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
        tabIds: [tabId],
      },
    },
    {
      id: ruleId + APP_PROFILE_UA_ID_OFFSET,
      priority: 100,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: 'user-agent',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: config.userAgent,
          },
        ],
      },
      condition: { tabIds: [tabId] },
    },
  ];
}

/** 为 tab 下发容器模拟配置：后续导航（含 iframe）的 document_start 将安装运行时 */
export async function applyAppProfileForTab(
  tabId: number,
  incomingConfig: InjectedAppProfileConfig,
  options: ApplyAppProfileOptions = {},
): Promise<void> {
  await runExclusive(async () => {
    await ensureHydrated();
    const config = await captureAppProfileHostCapabilities(incomingConfig);
    const previous = appProfileTabs.get(tabId);
    const ruleId = allocateRuleId();
    const nextTabIds = [...new Set([...appProfileTabs.keys(), tabId])];
    const stripRule = buildStripRule(nextTabIds);
    const changedRuntime = JSON.stringify(appProfileRuntimePins('tab', previous?.config)) !== JSON.stringify(appProfileRuntimePins('tab', config));
    if (changedRuntime)
      await browserCapabilityRegistry().pinPageRuntimes({
        ...replaceAppProfileRuntimePins(`tab:${tabId}`, previous?.config, config),
        ...appProfileRuntimePins(`rule:${tabId}`, previous?.config),
        ...(!previous?.config.pageRuntime ? { [`rule:${tabId}`]: null } : {}),
      });
    try {
      await markEnvironmentMutation(tabId, 'app');
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [
          APP_PROFILE_STRIP_RULE_ID,
          ruleId,
          ruleId + APP_PROFILE_UA_ID_OFFSET,
          ...(previous ? [previous.ruleId, previous.ruleId + APP_PROFILE_UA_ID_OFFSET] : []),
        ],
        addRules: [
          ...buildProfileRules(
            tabId,
            ruleId,
            config,
            options.ownsDeviceEmulation === true,
            options.deviceEmulation,
          ),
          ...(stripRule ? [stripRule] : []),
        ],
      });
    } catch (error) {
      if (changedRuntime)
        await browserCapabilityRegistry().pinPageRuntimes({
          ...replaceAppProfileRuntimePins(`tab:${tabId}`, config, previous?.config),
          ...replaceAppProfileRuntimePins(`rule:${tabId}`, previous?.config),
        });
      throw error;
    }
    appProfileTabs.set(tabId, {
      ruleId,
      config,
      ownsDeviceEmulation: options.ownsDeviceEmulation === true,
      deviceEmulation: options.deviceEmulation,
    });
    if (Boolean(previous?.config.settingsGroup) !== Boolean(config.settingsGroup)) {
      void chrome.tabs.sendMessage(tabId, {
        action: 'appProfileSettingsAvailability',
        available: Boolean(config.settingsGroup),
      }, { frameId: 0 }).catch(() => {});
    }
    if (changedRuntime)
      await browserCapabilityRegistry().pinPageRuntimes({ ...replaceAppProfileRuntimePins(`rule:${tabId}`, previous?.config), [`rule:${tabId}`]: null });
    await updateAppProfileActionIcon(tabId, config).catch(error => {
      console.warn('[AppProfile] Failed to update action icon:', error);
    });
  });
}

async function removeAppProfileForTab(tabId: number, restoreActionIcon: boolean): Promise<void> {
  await runExclusive(async () => {
    await ensureHydrated();
    const entry = appProfileTabs.get(tabId);
    if (!entry) {
      if (restoreActionIcon) await updateAppProfileActionIcon(tabId).catch(() => {});
      return;
    }
    const nextTabIds = [...appProfileTabs.keys()].filter(id => id !== tabId);
    const stripRule = buildStripRule(nextTabIds);
    await markEnvironmentMutation(tabId, 'app');
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [
        APP_PROFILE_STRIP_RULE_ID,
        entry.ruleId,
        entry.ruleId + APP_PROFILE_UA_ID_OFFSET,
      ],
      ...(stripRule ? { addRules: [stripRule] } : {}),
    });
    appProfileTabs.delete(tabId);
    if (Object.keys(appProfileRuntimePins(`tab:${tabId}`, entry.config)).length)
      await browserCapabilityRegistry().pinPageRuntimes(replaceAppProfileRuntimePins(`tab:${tabId}`, entry.config));
    if (restoreActionIcon) {
      if (entry.config.settingsGroup) {
        void chrome.tabs.sendMessage(tabId, {
          action: 'appProfileSettingsAvailability',
          available: false,
        }, { frameId: 0 }).catch(() => {});
      }
      await updateAppProfileActionIcon(tabId).catch(error => {
        console.warn('[AppProfile] Failed to restore action icon:', error);
      });
    }
  });
}

/** 清除存活 tab 的容器模拟，并恢复工具栏图标。 */
export async function clearAppProfileForTab(tabId: number): Promise<void> {
  await removeAppProfileForTab(tabId, true);
}

/** 回收已关闭 tab 的容器模拟状态；此时不能再调用任何 tab 级 Chrome API。 */
export async function cleanupClosedTabAppProfile(tabId: number): Promise<void> {
  await removeAppProfileForTab(tabId, false);
}

export async function getAppProfileForTab(
  tabId: number,
): Promise<InjectedAppProfileConfig | undefined> {
  await ensureHydrated();
  return appProfileTabs.get(tabId)?.config;
}

export async function getAppProfileDeviceEmulationForTab(
  tabId: number,
): Promise<ResolvedEmulationConfig | undefined> {
  await ensureHydrated();
  return appProfileTabs.get(tabId)?.deviceEmulation;
}

function alignAppProfileWithDevice(
  config: InjectedAppProfileConfig,
  device: ResolvedEmulationConfig,
): InjectedAppProfileConfig {
  const statusBarHeight = device.safeAreaInsets.top;
  const previousStatusBarHeight = String(config.statusBarHeight);
  const initialCookies = config.rootContainer?.initialCookies?.map(cookie =>
    cookie.value === previousStatusBarHeight
      ? { ...cookie, value: String(statusBarHeight) }
      : cookie,
  );
  return {
    ...config,
    statusBarHeight,
    safeAreaInsets: device.safeAreaInsets,
    ...(device.presetName && {
      deviceAppearance: {
        preset: device.presetName,
        orientation: device.orientation,
        cutout: device.appearance.cutout,
      },
    }),
    ...(config.rootContainer && {
      rootContainer: {
        ...config.rootContainer,
        ...(initialCookies && { initialCookies }),
      },
    }),
  };
}

/**
 * 释放 App profile 对页面尺寸的所有权，并同步 DNR 中的持久化状态。
 * 传入设备配置时，档案的安全区、设备外观和状态栏 Cookie 同步采用该设备；后续刷新
 * 仍保留容器桥、UA 与系统栏，但不再恢复 profile 推荐的设备宽高。
 */
export async function releaseAppProfileDeviceEmulationForTab(
  tabId: number,
  device?: ResolvedEmulationConfig,
): Promise<InjectedAppProfileConfig | undefined> {
  await ensureHydrated();
  const entry = appProfileTabs.get(tabId);
  if (!entry) return undefined;
  const config = device ? alignAppProfileWithDevice(entry.config, device) : entry.config;
  if (entry.ownsDeviceEmulation || entry.deviceEmulation || device) {
    await applyAppProfileForTab(tabId, config);
  }
  return config;
}

/** 页面导航会让 Chrome 恢复 tab 级 action 图标，按当前档案重新同步一次。 */
export async function refreshAppProfileActionIconForTab(tabId: number): Promise<void> {
  const config = await getAppProfileForTab(tabId);
  if (!config) return;
  await updateAppProfileActionIcon(tabId, config);
}

export async function appProfileOwnsDeviceEmulation(tabId: number): Promise<boolean> {
  await ensureHydrated();
  return appProfileTabs.get(tabId)?.ownsDeviceEmulation === true;
}

export async function listAppProfileTabIds(): Promise<number[]> {
  await ensureHydrated();
  return [...appProfileTabs.keys()];
}
