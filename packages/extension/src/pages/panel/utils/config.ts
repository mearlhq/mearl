/**
 * 扩展配置类型定义和工具函数
 */

import { DEFAULT_QUERY_PRESETS, type UrlQueryPreset } from './urlQueryPresets';
import { toError } from './errors';
import {
  getBrowserRequestUiState,
  ensureBrowserRequestUiState,
  subscribeBrowserRequestUi,
  updateBrowserRequestUiPreference,
} from './browserRequestUiState';
import {
  EXTERNAL_SERVICE_KEYS,
  SERVICE_DEFAULTS_CACHE_KEY,
  SERVICE_DEFAULTS_REFRESH_ACTION,
  EXTERNAL_SERVICE_UPDATE_ACTION,
  readServiceDefaultsCache,
  isValidServiceDefaultsCache,
  resolveExternalServices,
  type ExternalServiceConfig,
} from '../../../shared/externalServices';

export type Language = 'zh_CN' | 'en';

export type GlobalTranslationTarget = 'none' | 'en' | 'zh-TW';

export interface ExtensionConfig extends ExternalServiceConfig {
  language: Language;
  sseMonitoringEnabled: boolean;
  agentEnabled: boolean;
  agentPreventForeground: boolean;
  agentFloatingButtonEnabled: boolean;
  globalTranslation: GlobalTranslationTarget;
  cloudServerUrl?: string;
  /** URL query 快捷参数预设，用户可自定义增删 */
  queryPresets: UrlQueryPreset[];
  /** 已向该用户呈现过的内置预设 id，用于新内置项自动补入而不复活已删除项 */
  seenBuiltinPresetIds: string[];
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  language: 'zh_CN',
  sseMonitoringEnabled: true,
  agentEnabled: true,
  agentPreventForeground: true,
  agentFloatingButtonEnabled: false,
  globalTranslation: 'none',
  accountsEnabled: false,
  requestCasesEnabled: false,
  requestMetadataEnabled: false,
  requestImportEnabled: false,
  trackingMetadataEnabled: false,
  queryPresets: DEFAULT_QUERY_PRESETS,
  // 已展示记录只允许补入新内置项，尊重用户删除已有项的选择。
  seenBuiltinPresetIds: ['immersiveTitleBar'],
};

/**
 * 获取扩展配置
 */
export const getConfig = async ({ localOnly = false }: { localOnly?: boolean } = {}): Promise<ExtensionConfig> => {
  const requestUi = localOnly ? getBrowserRequestUiState() : await ensureBrowserRequestUiState();
  // 自动默认值不能作为 storage.get 的回退值，否则无法识别用户偏好是否存在。
  const defaults = {
    ...DEFAULT_CONFIG,
    cloudServerUrl: undefined,
    accountsEnabled: null,
    requestCasesEnabled: null,
    requestMetadataEnabled: null,
    requestImportEnabled: null,
    trackingMetadataEnabled: null,
    ...(requestUi.definition ? { [requestUi.definition.setting.key]: null } : {}),
  };
  const [items, cache] = await Promise.all([
    new Promise<Partial<ExtensionConfig> & Record<string, unknown>>(resolve => {
      chrome.storage.sync.get(defaults, stored => resolve(stored));
    }),
    readServiceDefaultsCache(),
  ]);
  // 首屏使用已安装默认值；后台刷新通过 storage.onChanged 更新已打开的页面。
  if (!localOnly) {
    void Promise.resolve(chrome.runtime.sendMessage({ action: SERVICE_DEFAULTS_REFRESH_ACTION })).catch(
      () => {},
    );
  }
  const preference = requestUi.definition ? items[requestUi.definition.setting.key] : false;
  const services = resolveExternalServices(items, cache);
  const metadataDefault = !!requestUi.definition && isValidServiceDefaultsCache(cache) && cache.services?.[requestUi.definition.setting.key] === true;
  return {
    ...DEFAULT_CONFIG,
    ...items,
    ...services,
    requestMetadataEnabled:
      !!requestUi.selected && (typeof preference === 'boolean'
        ? preference
        : metadataDefault),
  };
};

/** 仅保存用户修改的字段；外部服务偏好由后台按当前默认值归一化。 */
export const updateConfig = async (config: Partial<ExtensionConfig>): Promise<void> => {
  const values = { ...config };
  if (typeof values.requestMetadataEnabled === 'boolean' && getBrowserRequestUiState().selected) {
    await updateBrowserRequestUiPreference(values.requestMetadataEnabled);
    delete values.requestMetadataEnabled;
  }
  const services: Partial<ExtensionConfig> = {};
  for (const key of EXTERNAL_SERVICE_KEYS) {
    if (typeof values[key] === 'boolean') services[key] = values[key];
    delete values[key];
  }
  if (Object.keys(services).length) {
    const response = await chrome.runtime.sendMessage({
      action: EXTERNAL_SERVICE_UPDATE_ACTION,
      patch: services,
    });
    if (!response?.success)
      throw new Error(response?.error || 'Failed to save service preferences');
  }
  if (!Object.keys(values).length) return;
  await new Promise<void>((resolve, reject) => {
    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) reject(toError(chrome.runtime.lastError));
      else resolve();
    });
  });
};

/**
 * 监听配置变化
 */
export const onConfigChange = (
  callback: (config: Partial<ExtensionConfig>) => void,
): (() => void) => {
  let revision = 0;
  let disposed = false;
  const refreshServices = async () => {
    const currentRevision = ++revision;
    const config = await getConfig();
    if (disposed || currentRevision !== revision) return;
    callback({
      accountsEnabled: config.accountsEnabled,
      requestCasesEnabled: config.requestCasesEnabled,
      requestMetadataEnabled: config.requestMetadataEnabled,
      requestImportEnabled: config.requestImportEnabled,
      trackingMetadataEnabled: config.trackingMetadataEnabled,
    });
  };
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName === 'session' && changes[SERVICE_DEFAULTS_CACHE_KEY]) {
      void refreshServices();
      return;
    }
    if (areaName !== 'sync') return;
    const configChanges: Partial<ExtensionConfig> = {};
    const keys = [...Object.keys(DEFAULT_CONFIG), 'cloudServerUrl'] as (keyof ExtensionConfig)[];
    for (const key of keys) {
      if (EXTERNAL_SERVICE_KEYS.some(service => service === key) || !changes[key]) continue;
      Object.assign(configChanges, { [key]: changes[key].newValue ?? DEFAULT_CONFIG[key] });
    }
    if (Object.keys(configChanges).length) callback(configChanges);
    if (
      EXTERNAL_SERVICE_KEYS.some(key => changes[key]) ||
      (getBrowserRequestUiState().definition && changes[getBrowserRequestUiState().definition!.setting.key])
    )
      void refreshServices();
  };
  const handleResume = () => {
    void refreshServices();
  };
  chrome.storage.onChanged.addListener(listener);
  const unsubscribeUi = subscribeBrowserRequestUi(() => {
    void refreshServices();
  });
  window.addEventListener('focus', handleResume);
  window.addEventListener('online', handleResume);
  // 订阅时重读默认值，接收 bootstrap 与页面挂载之间完成的刷新。
  void refreshServices();
  return () => {
    disposed = true;
    chrome.storage.onChanged.removeListener(listener);
    unsubscribeUi();
    window.removeEventListener('focus', handleResume);
    window.removeEventListener('online', handleResume);
  };
};
