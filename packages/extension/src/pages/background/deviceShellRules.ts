/**
 * 设备外壳的 per-tab DNR 配置。
 *
 * 导航响应通过 Server-Timing 同步把外壳配置交给 document_start 脚本；同一规则移除
 * iframe 嵌入限制，使根 WebView 能加载原业务 URL。配置与设备参数一并持久化在 session
 * rule 中，MV3 service worker 重启后仍可恢复。
 */

import type { DeviceEnvironmentConfig, ResolvedEmulationConfig } from '@mearl/browser-core';
import { browserUiText } from '@mearl/preset/bundles';
import { getQuickDevicePresetLabel, isQuickDevicePresetName, type QuickDeviceChromeConfig } from '../../shared/quickAppProfile';
import { assertDeviceShellSupported } from '../../shared/chromiumVersion';
import { markEnvironmentMutation } from './environmentRevisions';
import { closeDevicePreviewPanel, getDevicePreviewPanelVisibility } from './devicePreviewPanel';
import { getAppProfileForTab } from './utils/appProfileRules';
import {
  DEVICE_PREVIEW_PANEL_WIDTH,
  DEVICE_PREVIEW_TOOLBAR_COLLAPSED,
  type DevicePreviewLayout,
} from '../../shared/devicePreviewPanel';

export const DEVICE_SHELL_SERVER_TIMING_KEY = 'mearl-device-shell';

const DEVICE_SHELL_RULE_ID_START = 999601;
const DEVICE_SHELL_RULE_ID_END = 999699;

export interface InheritedViewportDeviceEnvironmentConfig extends DeviceEnvironmentConfig {
  viewport: 'inherit';
}

export type DeviceShellEmulationConfig =
  | ResolvedEmulationConfig
  | InheritedViewportDeviceEnvironmentConfig;

export function inheritsDeviceViewport(
  config: DeviceShellEmulationConfig,
): config is InheritedViewportDeviceEnvironmentConfig {
  return 'viewport' in config && config.viewport === 'inherit';
}

interface DeviceShellRulePayload {
  version: 1;
  config: QuickDeviceChromeConfig;
  emulation: DeviceShellEmulationConfig;
  /** App 根容器是否使用双 WebView；固定设备仅横屏生效，自适应设备跟随外部 viewport。 */
  splitScreen?: boolean;
  previewLayout?: DevicePreviewLayout;
}

interface DeviceShellTabEntry extends DeviceShellRulePayload {
  ruleId: number;
}

const deviceShellTabs = new Map<number, DeviceShellTabEntry>();
let ruleIdCursor = DEVICE_SHELL_RULE_ID_START;
let hydrationPromise: Promise<void> | null = null;
let ruleQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = ruleQueue.then(operation, operation);
  ruleQueue = result.catch(() => {});
  return result;
}

function encodePayload(payload: DeviceShellRulePayload): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function decodeRule(rule: chrome.declarativeNetRequest.Rule): DeviceShellTabEntry | null {
  if (rule.id < DEVICE_SHELL_RULE_ID_START || rule.id > DEVICE_SHELL_RULE_ID_END) return null;
  const header = rule.action.responseHeaders?.find(
    candidate => candidate.header.toLowerCase() === 'server-timing',
  );
  const marker = `${DEVICE_SHELL_SERVER_TIMING_KEY};desc="`;
  const value = header?.value ?? '';
  const start = value.indexOf(marker);
  const end = start < 0 ? -1 : value.indexOf('"', start + marker.length);
  if (start < 0 || end < 0) return null;
  try {
    const payload = JSON.parse(
      decodeURIComponent(escape(atob(value.slice(start + marker.length, end)))),
    ) as DeviceShellRulePayload;
    if (payload.version !== 1 || !payload.config || !payload.emulation) {
      return null;
    }
    if (
      !inheritsDeviceViewport(payload.emulation) &&
      (!Number.isFinite(payload.emulation.width) || !Number.isFinite(payload.emulation.height))
    ) {
      return null;
    }
    return { ...payload, ruleId: rule.id };
  } catch {
    return null;
  }
}

async function ensureHydrated(): Promise<void> {
  if (typeof chrome.declarativeNetRequest?.getSessionRules !== 'function') return;
  hydrationPromise ??= chrome.declarativeNetRequest
    .getSessionRules()
    .then(rules => {
      for (const rule of rules) {
        const entry = decodeRule(rule);
        const tabId = rule.condition.tabIds?.[0];
        if (entry && tabId !== undefined) deviceShellTabs.set(tabId, entry);
      }
    })
    .catch(error => {
      hydrationPromise = null;
      throw error;
    });
  await hydrationPromise;
}

function allocateRuleId(): number {
  const used = new Set([...deviceShellTabs.values()].map(entry => entry.ruleId));
  const count = DEVICE_SHELL_RULE_ID_END - DEVICE_SHELL_RULE_ID_START + 1;
  for (let index = 0; index < count; index += 1) {
    const candidate = ruleIdCursor;
    ruleIdCursor =
      candidate >= DEVICE_SHELL_RULE_ID_END ? DEVICE_SHELL_RULE_ID_START : candidate + 1;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('No available device shell DNR rule id');
}

function buildRule(
  tabId: number,
  ruleId: number,
  payload: DeviceShellRulePayload,
): chrome.declarativeNetRequest.Rule {
  return {
    id: ruleId,
    priority: 110,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      responseHeaders: [
        {
          header: 'server-timing',
          operation: 'append' as chrome.declarativeNetRequest.HeaderOperation,
          value: `${DEVICE_SHELL_SERVER_TIMING_KEY};desc="${encodePayload(payload)}"`,
        },
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
      tabIds: [tabId],
    },
  };
}

export async function applyDeviceShellForTab(
  tabId: number,
  config: QuickDeviceChromeConfig,
  emulation: DeviceShellEmulationConfig,
  options: { splitScreen?: boolean } = {},
): Promise<void> {
  assertDeviceShellSupported();
  await runExclusive(async () => {
    await ensureHydrated();
    const previous = deviceShellTabs.get(tabId);
    const ruleId = previous?.ruleId ?? allocateRuleId();
    const splitScreen =
      options.splitScreen === true &&
      (emulation.orientation === 'landscape' || inheritsDeviceViewport(emulation));
    const payload: DeviceShellRulePayload = {
      version: 1,
      config,
      emulation,
      ...(splitScreen ? { splitScreen: true } : {}),
    };
    await markEnvironmentMutation(tabId, 'device');
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: previous ? [previous.ruleId] : [],
      addRules: [buildRule(tabId, ruleId, payload)],
    });
    deviceShellTabs.set(tabId, { ...payload, ruleId });
    if (!config.phoneFrame) closeDevicePreviewPanel(tabId);
  });
}

export async function clearDeviceShellForTab(tabId: number): Promise<boolean> {
  return runExclusive(async () => {
    await ensureHydrated();
    const current = deviceShellTabs.get(tabId);
    if (!current) return false;
    await markEnvironmentMutation(tabId, 'device');
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [current.ruleId] });
    deviceShellTabs.delete(tabId);
    closeDevicePreviewPanel(tabId);
    return true;
  });
}

export async function getDeviceShellForTab(tabId: number): Promise<{
  config: QuickDeviceChromeConfig;
  emulation: DeviceShellEmulationConfig;
  splitScreen: boolean;
} | null> {
  await ensureHydrated();
  const current = deviceShellTabs.get(tabId);
  return current
    ? {
        config: current.config,
        emulation: current.emulation,
        splitScreen: current.splitScreen === true,
      }
    : null;
}

/** 合成的外壳文档也通过 Server-Timing 使用同一份 document_start 配置。 */
export async function getDeviceShellBootstrapHeaderForTab(tabId: number, forDocument = false) {
  await ensureHydrated();
  const current = deviceShellTabs.get(tabId);
  if (!current) return undefined;
  const { ruleId: _ruleId, ...payload } = current;
  if (forDocument && payload.config.phoneFrame) {
    const [preferences, tab, profile] = await Promise.all([
      chrome.storage.local.get([
        DEVICE_PREVIEW_PANEL_WIDTH,
        DEVICE_PREVIEW_TOOLBAR_COLLAPSED,
      ]).catch(() => null),
      chrome.tabs.get(tabId).catch(() => null),
      getAppProfileForTab(tabId).catch(() => undefined),
    ]);
    if (preferences) {
      const width = preferences[DEVICE_PREVIEW_PANEL_WIDTH];
      const preset = 'presetName' in payload.emulation ? payload.emulation.presetName : undefined;
      const labels = profile?.binding?.definition.labels;
      payload.previewLayout = {
        width: typeof width === 'number' ? width : undefined,
        toolbarCollapsed: preferences[DEVICE_PREVIEW_TOOLBAR_COLLAPSED] === true,
        panel: getDevicePreviewPanelVisibility(tabId),
        viewport: tab?.width && tab.height ? { width: tab.width, height: tab.height } : undefined,
        toolbar: isQuickDevicePresetName(preset) ? {
          profile: profile ? { id: profile.profile, label: labels ? browserUiText(labels, chrome.i18n.getUILanguage()) : profile.label } : null,
          preset: { id: preset, label: getQuickDevicePresetLabel(preset, key => chrome.i18n.getMessage(key)) },
          orientation: payload.emulation.orientation,
        } : undefined,
      };
    }
  }
  return {
    name: 'Server-Timing',
    value: `${DEVICE_SHELL_SERVER_TIMING_KEY};desc="${encodePayload(payload)}"`,
  };
}

export async function listDeviceShellTabIds(): Promise<number[]> {
  await ensureHydrated();
  return [...deviceShellTabs.keys()].sort((a, b) => a - b);
}

export async function cleanupClosedTabDeviceShell(tabId: number): Promise<void> {
  await clearDeviceShellForTab(tabId).catch(() => {});
}
