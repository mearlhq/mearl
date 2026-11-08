import { getTopLevelDomain } from '@mearl/browser-core';
import {
  getQuickDevicePresetModel,
  getQuickDevicePresetOs,
  isQuickAppProfileName,
  isQuickDeviceOrientation,
  isQuickDevicePresetName,
  normalizeQuickDeviceSelection,
  type QuickAppProfileName,
  type QuickDeviceSelection,
  type QuickSimulationAutoRule,
} from '../../shared/quickAppProfile';
import {
  clearQuickDeviceEmulation,
  restoreQuickDeviceEmulationForTab,
  setQuickAppSimulation,
  setQuickDeviceEmulation,
} from './quickDeviceEmulation';
import {
  getQuickDeviceSimulationState,
  hydrateQuickDeviceSimulationState,
} from './quickDeviceSimulationState';
import { getAppProfileForTab } from './utils/appProfileRules';

const STORAGE_KEY = 'quickSimulationAutoRules';

interface StoredQuickSimulationAutoRules {
  version: 1;
  rules: QuickSimulationAutoRule[];
}

export type QuickSimulationAutoRuleInput = Omit<QuickSimulationAutoRule, 'domain'>;

interface SetQuickAppSimulationWithAutoRuleParams {
  tabId: number;
  profile: QuickAppProfileName | null;
  appVersion?: string;
  deviceSelection?: QuickDeviceSelection;
}

interface SetQuickDeviceSimulationWithAutoRuleParams {
  tabId: number;
  deviceSelection: QuickDeviceSelection | null;
}

let storageWriteQueue: Promise<unknown> = Promise.resolve();
const tabApplyQueues = new Map<number, Promise<QuickSimulationAutoRule | undefined>>();

const normalizeHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

const isIpv4Address = (hostname: string): boolean =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) &&
  hostname.split('.').every(part => Number(part) <= 255);

export function getQuickSimulationRootDomain(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hostname = normalizeHostname(url.hostname);
    if (!hostname) return null;
    if (hostname === 'localhost' || hostname.includes(':') || isIpv4Address(hostname)) {
      return hostname;
    }
    return getTopLevelDomain(hostname);
  } catch {
    return null;
  }
}

const isStoredRule = (value: unknown): value is QuickSimulationAutoRule => {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<QuickSimulationAutoRule>;
  const device = rule.deviceSelection;
  return (
    typeof rule.domain === 'string' &&
    rule.domain === normalizeHostname(rule.domain) &&
    isQuickAppProfileName(rule.profile) &&
    (rule.appVersion === undefined || typeof rule.appVersion === 'string') &&
    Boolean(device) &&
    isQuickDevicePresetName(device?.preset) &&
    isQuickDeviceOrientation(device?.orientation) &&
    typeof device?.fitToWindow === 'boolean' &&
    typeof device?.deviceShell === 'boolean' &&
    (device.splitScreen === undefined || typeof device.splitScreen === 'boolean')
  );
};

const readRules = async (): Promise<QuickSimulationAutoRule[]> => {
  const result = (await chrome.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
  const stored = result[STORAGE_KEY] as Partial<StoredQuickSimulationAutoRules> | undefined;
  if (stored?.version !== 1 || !Array.isArray(stored.rules)) return [];
  return stored.rules.filter(isStoredRule).map(rule => ({
    ...rule,
    deviceSelection: normalizeQuickDeviceSelection(rule.deviceSelection),
  }));
};

const writeRules = (rules: QuickSimulationAutoRule[]): Promise<void> =>
  chrome.storage.local.set({
    [STORAGE_KEY]: { version: 1, rules } satisfies StoredQuickSimulationAutoRules,
  });

const getTabUrl = async (tabId: number): Promise<string | undefined> =>
  chrome.tabs.get(tabId).then(tab => tab.url);

export async function getQuickSimulationAutoRuleForUrl(
  url: string,
): Promise<QuickSimulationAutoRule | undefined> {
  const domain = getQuickSimulationRootDomain(url);
  if (!domain) return undefined;
  return (await readRules()).find(rule => rule.domain === domain);
}

export async function getQuickSimulationAutoRuleForTab(tabId: number): Promise<{
  domain: string | null;
  rule?: QuickSimulationAutoRule;
}> {
  const url = await getTabUrl(tabId);
  const domain = url ? getQuickSimulationRootDomain(url) : null;
  if (!domain) return { domain: null };
  return { domain, rule: (await readRules()).find(candidate => candidate.domain === domain) };
}

export function setQuickSimulationAutoRuleForTab(
  tabId: number,
  input: QuickSimulationAutoRuleInput | null,
): Promise<QuickSimulationAutoRule | undefined> {
  const operation = storageWriteQueue
    .catch(() => {})
    .then(async () => {
      const url = await getTabUrl(tabId);
      const domain = url ? getQuickSimulationRootDomain(url) : null;
      if (!domain) throw new Error('Automatic simulation requires an http(s) page');
      const rules = await readRules();
      const remaining = rules.filter(rule => rule.domain !== domain);
      if (!input) {
        await writeRules(remaining);
        return undefined;
      }
      const rule: QuickSimulationAutoRule = {
        domain,
        ...input,
        deviceSelection: normalizeQuickDeviceSelection(input.deviceSelection),
      };
      await writeRules([...remaining, rule]);
      return rule;
    });
  storageWriteQueue = operation;
  return operation;
}

const toRuleInput = (rule: QuickSimulationAutoRule): QuickSimulationAutoRuleInput => ({
  profile: rule.profile,
  ...(rule.appVersion ? { appVersion: rule.appVersion } : {}),
  deviceSelection: rule.deviceSelection,
});

/**
 * 手动变更模拟状态时，自动规则必须先于可能发生的 reload 落盘。页面导航监听会立即读取规则，
 * 因此规则更新和失败回滚统一在这里处理，调用方只描述目标规则与实际变更。
 */
export async function runQuickSimulationUpdateWithAutoRuleSync<T>(
  tabId: number,
  resolveNextRule: (current: QuickSimulationAutoRule) => QuickSimulationAutoRuleInput | null,
  update: () => Promise<T>,
): Promise<T> {
  const current = await getQuickSimulationAutoRuleForTab(tabId);
  if (!current.rule) return update();

  const previousRule = toRuleInput(current.rule);
  await setQuickSimulationAutoRuleForTab(tabId, resolveNextRule(current.rule));
  try {
    return await update();
  } catch (error) {
    await setQuickSimulationAutoRuleForTab(tabId, previousRule).catch(() => {});
    throw error;
  }
}

export async function setQuickAppSimulationWithAutoRuleSync(
  params: SetQuickAppSimulationWithAutoRuleParams,
): Promise<Record<string, unknown>> {
  return runQuickSimulationUpdateWithAutoRuleSync(
    params.tabId,
    current => {
      if (!params.profile) return null;
      const nextAppVersion =
        params.appVersion ?? (current.profile === params.profile ? current.appVersion : undefined);
      return {
        profile: params.profile,
        ...(nextAppVersion ? { appVersion: nextAppVersion } : {}),
        deviceSelection: params.deviceSelection ?? current.deviceSelection,
      };
    },
    () => setQuickAppSimulation(params),
  );
}

export function setQuickDeviceSimulationWithAutoRuleSync({
  tabId,
  deviceSelection,
}: SetQuickDeviceSimulationWithAutoRuleParams) {
  const normalizedSelection = deviceSelection
    ? normalizeQuickDeviceSelection(deviceSelection)
    : null;
  return runQuickSimulationUpdateWithAutoRuleSync(
    tabId,
    current =>
      normalizedSelection
        ? { ...toRuleInput(current), deviceSelection: normalizedSelection }
        : null,
    () =>
      normalizedSelection
        ? setQuickDeviceEmulation({ tabId, ...normalizedSelection })
        : clearQuickDeviceEmulation(tabId, { clearUnownedDevice: true }),
  );
}

const autoRuleMatchesTab = async (
  tabId: number,
  rule: QuickSimulationAutoRule,
): Promise<boolean> => {
  await hydrateQuickDeviceSimulationState(tabId);
  const [profile, device] = await Promise.all([
    getAppProfileForTab(tabId),
    Promise.resolve(getQuickDeviceSimulationState(tabId)),
  ]);
  const expectedPlatform =
    getQuickDevicePresetOs(rule.deviceSelection.preset) === 'android' ? 'Android' : 'iOS';
  return Boolean(
    profile?.profile === rule.profile &&
    profile.platform === expectedPlatform &&
    (profile.binding?.options.deviceModel ?? profile.globals.__DEVICE_MODEL__) === getQuickDevicePresetModel(rule.deviceSelection.preset) &&
    (rule.appVersion === undefined || (profile.binding?.options.appVersion ?? profile.globals.__APP_VERSION__) === rule.appVersion) &&
    device?.enabled &&
    device.preset === rule.deviceSelection.preset &&
    device.orientation === rule.deviceSelection.orientation &&
    device.fitToWindow === rule.deviceSelection.fitToWindow &&
    device.deviceShell === rule.deviceSelection.deviceShell &&
    (device.splitScreen ?? false) === (rule.deviceSelection.splitScreen ?? false),
  );
};

/** 页面进入已启用的根域时恢复并应用其端与设备选择；同一 tab 的导航按顺序处理。 */
export function applyQuickSimulationAutoRuleForTab(
  tabId: number,
  url?: string,
): Promise<QuickSimulationAutoRule | undefined> {
  const previous = tabApplyQueues.get(tabId) ?? Promise.resolve(undefined);
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const targetUrl = url ?? (await getTabUrl(tabId));
      if (!targetUrl) return undefined;
      await restoreQuickDeviceEmulationForTab(tabId);
      const rule = await getQuickSimulationAutoRuleForUrl(targetUrl);
      if (!rule) return undefined;
      if (!(await autoRuleMatchesTab(tabId, rule))) {
        await setQuickAppSimulation({
          tabId,
          profile: rule.profile,
          ...(rule.appVersion ? { appVersion: rule.appVersion } : {}),
          deviceSelection: rule.deviceSelection,
          updateGlobalDefault: false,
        });
      }
      return rule;
    });
  tabApplyQueues.set(tabId, operation);
  void operation.then(
    () => {
      if (tabApplyQueues.get(tabId) === operation) tabApplyQueues.delete(tabId);
    },
    () => {
      if (tabApplyQueues.get(tabId) === operation) tabApplyQueues.delete(tabId);
    },
  );
  return operation;
}

export function cleanupQuickSimulationAutoRuleTab(tabId: number): void {
  tabApplyQueues.delete(tabId);
}
