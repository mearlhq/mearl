import { getExtensionVersion } from '../../shared/extensionVersion';
import { useEffect, useState, useRef, FC } from 'react';
import {
  BellOff,
  Check,
  Clock3,
  Settings,
  ChevronRight,
  ChevronLeft,
  RotateCcw,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useFontSize } from '../../shared/hooks/useFontSize';
import { t, initI18n, getCurrentLanguage } from '../panel/utils/i18n';
import { browserUiText } from '@mearl/preset/bundles';
import { useBrowserUiSettings } from '../panel/utils/browserUiSettings';
import { useBrowserView } from '../panel/components/browser-view/viewState';
import { useBrowserRequestUi } from '../panel/hooks/useBrowserRequestUi';
import TranslationDictEditor from './components/TranslationDictEditor';
import AgentPermissionsSection from './components/AgentPermissionsSection';
import { ProfileInstallModal } from '../panel/components/modal/ProfileInstallModal';
import { Button } from './components/Button';
import {
  DEFAULT_CONFIG,
  getConfig,
  updateConfig,
  onConfigChange,
  type ExtensionConfig as Config,
  type Language,
  type GlobalTranslationTarget,
} from '../panel/utils/config';
import { formatCustomTime, parseCustomTime } from './customTime';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import {
  DEFAULT_TAB_PAGE_OVERRIDES,
  TAB_PAGE_OVERRIDES_GET_ACTION,
  TAB_PAGE_OVERRIDES_SET_ACTION,
  normalizeTabPageOverrides,
  tabPageOverridesStorageKey,
  type TabCustomTimezone,
  type TabPageOverrides,
  type TabPageOverridesResponse,
} from '../../shared/tabPageOverrides';

interface OptionsProps {
  embeddedTabId?: number;
}

const Options: FC<OptionsProps> = ({ embeddedTabId }) => {
  const { definition: requestUiDefinition } = useBrowserRequestUi();
  const settings = useBrowserUiSettings();
  const importView = useBrowserView('requestImport');
  const casesView = useBrowserView('requestCases');
  const captureView = useBrowserView('captureLauncher');
  const declaredServices = new Set(Object.values(settings.operations ?? {}).map(operation => operation.setting).filter(Boolean));
  const availableServices = {
    accountsEnabled: declaredServices.has('accountsEnabled'),
    requestCasesEnabled: Boolean(casesView.selected || captureView.selected),
    requestMetadataEnabled: Boolean(requestUiDefinition),
    requestImportEnabled: Boolean(importView.selected),
    trackingMetadataEnabled: declaredServices.has('trackingMetadataEnabled'),
  };
  const hasServices = Object.values(availableServices).some(Boolean);
  const searchParams = new URLSearchParams(window.location.search);
  const profileConfirmation = searchParams.get('profileConfirmation');
  const isEmbedded = embeddedTabId !== undefined || searchParams.get('iframe') === '1';
  const parsedSettingsTabId = Number(searchParams.get('tabId'));
  const settingsTabId = embeddedTabId ?? (
    isEmbedded && Number.isInteger(parsedSettingsTabId) && parsedSettingsTabId > 0
      ? parsedSettingsTabId
      : null);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [isLoading, setIsLoading] = useState(true);
  const [showDict, setShowDict] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const [, forceUpdate] = useState({});
  const [uaInput, setUaInput] = useState(() => navigator.userAgent);
  const [uaEnabled, setUaEnabled] = useState(false);
  const [customTimezone, setCustomTimezone] = useState<TabCustomTimezone>('');
  const [customTime, setCustomTime] = useState<number | null>(null);
  const [showPermissions, setShowPermissions] = useState(false);
  const [customTimeInput, setCustomTimeInput] = useState('');

  const switchClass = (enabled: boolean) =>
    clsx(
      'relative inline-flex h-4 w-7 items-center rounded-full transition-colors focus:outline-none',
      {
        'bg-blue-600': enabled,
        'bg-gray-300 dark:bg-gray-600': !enabled,
      },
    );

  const switchThumbClass = (enabled: boolean) =>
    clsx('inline-block h-3 w-3 transform rounded-full bg-white transition-transform', {
      'translate-x-3.5': enabled,
      'translate-x-0.5': !enabled,
    });

  useEffect(() => {
    // 从 chrome.storage 加载配置
    getConfig().then(async loadedConfig => {
      setConfig(loadedConfig);
      let pageOverrides = DEFAULT_TAB_PAGE_OVERRIDES;
      if (settingsTabId !== null) {
        try {
          const response = (await chrome.runtime.sendMessage({
            action: TAB_PAGE_OVERRIDES_GET_ACTION,
            tabId: settingsTabId,
          })) as TabPageOverridesResponse | undefined;
          if (response?.success && response.overrides) pageOverrides = response.overrides;
        } catch {
          // 页面级配置读取失败时展示当前 tab 的默认值，不复用其他 tab 状态。
        }
      }
      const normalizedOverrides = normalizeTabPageOverrides(pageOverrides);
      setUaInput(normalizedOverrides.customUserAgent || navigator.userAgent);
      setUaEnabled(normalizedOverrides.customUserAgentEnabled);
      setCustomTimezone(normalizedOverrides.customTimezone);
      setCustomTime(normalizedOverrides.customTime);
      setCustomTimeInput(
        normalizedOverrides.customTime === null
          ? ''
          : formatCustomTime(normalizedOverrides.customTime, normalizedOverrides.customTimezone),
      );
      await initI18n(loadedConfig.language);
      if (embeddedTabId === undefined) setExtensionPageTitle(t('settings'));
      setIsLoading(false);
      forceUpdate({});
    });

    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session' || settingsTabId === null) return;
      const change = changes[tabPageOverridesStorageKey(settingsTabId)];
      if (!change) return;
      const next = normalizeTabPageOverrides(change.newValue);
      setUaInput(next.customUserAgent || navigator.userAgent);
      setUaEnabled(next.customUserAgentEnabled);
      setCustomTimezone(next.customTimezone);
      setCustomTime(next.customTime);
      setCustomTimeInput(
        next.customTime === null ? '' : formatCustomTime(next.customTime, next.customTimezone),
      );
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    const unsubscribe = onConfigChange(changes => {
      setConfig(previous => ({ ...previous, ...changes }));
    });

    // 组件卸载时清除定时器
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      chrome.storage.onChanged.removeListener(handleStorageChange);
      unsubscribe();
    };
  }, [embeddedTabId, settingsTabId]);

  const saveConfig = async (patch: Partial<Config>, afterSave?: () => Promise<void>) => {
    // 清除之前的定时器
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }

    setSaveStatus('saving');
    try {
      await updateConfig(patch);
      await afterSave?.();
      const resolved = await getConfig();
      setConfig(previous => ({
        ...previous,
        accountsEnabled: resolved.accountsEnabled,
        requestCasesEnabled: resolved.requestCasesEnabled,
        requestMetadataEnabled: resolved.requestMetadataEnabled,
        requestImportEnabled: resolved.requestImportEnabled,
        trackingMetadataEnabled: resolved.trackingMetadataEnabled,
      }));
      setSaveStatus('success');
      hideTimerRef.current = window.setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (error) {
      console.error('Failed to save config:', error);
      setConfig(await getConfig());
      setSaveStatus('error');
    }
  };

  const saveTabPageOverrides = async (patch: Partial<TabPageOverrides>) => {
    if (settingsTabId === null) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setSaveStatus('saving');
    try {
      const response = (await chrome.runtime.sendMessage({
        action: TAB_PAGE_OVERRIDES_SET_ACTION,
        tabId: settingsTabId,
        patch,
      })) as TabPageOverridesResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'Failed to save page overrides');
      setSaveStatus('success');
      hideTimerRef.current = window.setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (error) {
      console.error('Failed to save page overrides:', error);
      setSaveStatus('error');
    }
  };

  const handleLanguageChange = async (language: Language) => {
    const newConfig = { ...config, language };
    setConfig(newConfig);
    await initI18n(language);
    setExtensionPageTitle(t('settings'));
    forceUpdate({});
    void saveConfig({ language: newConfig.language });
  };

  const handleSSEMonitoringToggle = () => {
    const newConfig = { ...config, sseMonitoringEnabled: !config.sseMonitoringEnabled };
    setConfig(newConfig);
    void saveConfig({ sseMonitoringEnabled: newConfig.sseMonitoringEnabled });
  };

  const handleAgentEnabledToggle = () => {
    const newConfig = { ...config, agentEnabled: !config.agentEnabled };
    setConfig(newConfig);
    void saveConfig({ agentEnabled: newConfig.agentEnabled });
  };

  const handleAgentPreventForegroundToggle = () => {
    const agentPreventForeground = !config.agentPreventForeground;
    setConfig(previous => ({ ...previous, agentPreventForeground }));
    void saveConfig({ agentPreventForeground });
  };

  const handleAgentFloatingButtonToggle = () => {
    if (!config.agentEnabled) return;
    const newConfig = {
      ...config,
      agentFloatingButtonEnabled: !config.agentFloatingButtonEnabled,
    };
    setConfig(newConfig);
    void saveConfig({ agentFloatingButtonEnabled: newConfig.agentFloatingButtonEnabled });
  };

  const handleAccountEnabledToggle = () => {
    const newConfig = { ...config, accountsEnabled: !config.accountsEnabled };
    setConfig(newConfig);
    void saveConfig({ accountsEnabled: newConfig.accountsEnabled });
  };

  const handleRequestCasesEnabledToggle = () => {
    const newConfig = { ...config, requestCasesEnabled: !config.requestCasesEnabled };
    setConfig(newConfig);
    void saveConfig({ requestCasesEnabled: newConfig.requestCasesEnabled });
  };

  const handleRequestMetadataEnabledToggle = () => {
    const newConfig = { ...config, requestMetadataEnabled: !config.requestMetadataEnabled };
    setConfig(newConfig);
    void saveConfig({ requestMetadataEnabled: newConfig.requestMetadataEnabled });
  };

  const handleRequestImportEnabledToggle = () => {
    const newConfig = { ...config, requestImportEnabled: !config.requestImportEnabled };
    setConfig(newConfig);
    void saveConfig({ requestImportEnabled: newConfig.requestImportEnabled });
  };

  const handleTrackingMetadataEnabledToggle = () => {
    const newConfig = { ...config, trackingMetadataEnabled: !config.trackingMetadataEnabled };
    setConfig(newConfig);
    void saveConfig({ trackingMetadataEnabled: newConfig.trackingMetadataEnabled });
  };

  const handleGlobalTranslationChange = (target: GlobalTranslationTarget) => {
    const enableModification =
      config.globalTranslation !== 'none' && target === 'none' && settingsTabId !== null;
    const newConfig = { ...config, globalTranslation: target };
    setConfig(newConfig);
    void saveConfig({ globalTranslation: target }, async () => {
      const translation = await chrome.runtime.sendMessage({
        action: 'setGlobalTranslation',
        target,
      });
      if (!translation?.success) throw new Error(translation?.error || t('settingsSaveFailed'));
      if (enableModification) {
        const response = await chrome.runtime.sendMessage({
          action: 'enableModification',
          tabId: settingsTabId,
        });
        if (!response?.success) throw new Error(response?.error || t('settingsSaveFailed'));
      }
    });
  };

  const handleUaInputChange = (value: string) => {
    setUaInput(value);
    void saveTabPageOverrides({ customUserAgent: value });
  };

  const handleUaToggle = () => {
    const newEnabled = !uaEnabled;
    setUaEnabled(newEnabled);
    void saveTabPageOverrides({
      customUserAgentEnabled: newEnabled,
      ...(newEnabled ? { customUserAgent: uaInput } : {}),
    });
  };

  const handleUaReset = () => {
    setUaInput(navigator.userAgent);
    setUaEnabled(false);
    void saveTabPageOverrides({ customUserAgent: '', customUserAgentEnabled: false });
  };

  const handleTimezoneChange = (nextTimezone: TabCustomTimezone) => {
    setCustomTimezone(nextTimezone);
    if (customTime !== null) {
      setCustomTimeInput(formatCustomTime(customTime, nextTimezone));
    }
    void saveTabPageOverrides({ customTimezone: nextTimezone });
  };

  const handleCustomTimeChange = (value: string) => {
    setCustomTimeInput(value);
    if (!value) {
      setCustomTime(null);
      void saveTabPageOverrides({ customTime: null });
      return;
    }
    const nextCustomTime = parseCustomTime(value, customTimezone);
    if (nextCustomTime === null) return;
    setCustomTime(nextCustomTime);
    void saveTabPageOverrides({ customTime: nextCustomTime });
  };

  const handleUseCurrentTime = () => {
    const nextCustomTime = Date.now();
    setCustomTime(nextCustomTime);
    setCustomTimeInput(formatCustomTime(nextCustomTime, customTimezone));
    void saveTabPageOverrides({ customTime: nextCustomTime });
  };

  const timezoneOptions: Array<{ value: TabCustomTimezone; label: string }> = [
    { value: '', label: t('timezoneSystem') },
    { value: 'Asia/Shanghai', label: t('timezoneShanghai') },
    { value: 'Asia/Tokyo', label: t('timezoneTokyo') },
    { value: 'Asia/Singapore', label: t('timezoneSingapore') },
    { value: 'Europe/London', label: t('timezoneLondon') },
    { value: 'America/New_York', label: t('timezoneNewYork') },
    { value: 'America/Los_Angeles', label: t('timezoneLosAngeles') },
  ];

  const minHeight = embeddedTabId === undefined ? 'min-h-screen' : 'min-h-full';
  if (isLoading) {
    return (
      <div className={clsx(minHeight, 'bg-bg-primary flex items-center justify-center')}>
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className={clsx(minHeight, 'bg-bg-primary text-text-primary')}>
      <div className="max-w-4xl mx-auto py-6 px-6">
        {/* Dict sub-view */}
        {showDict ? (
          <>
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setShowDict(false)}
                className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                {t('settings')}
              </button>
              <span className="text-text-secondary text-xs">/</span>
              <span className="text-xs text-text-primary">{t('translationDict')}</span>
            </div>
            <TranslationDictEditor />
          </>
        ) : (
          <>
            {/* Header */}
            {!isEmbedded && (
              <div className="flex items-center justify-between pb-4">
                <div className="flex items-center gap-2">
                  <Settings className="w-5 h-5 text-blue-600" />
                  <h1 className="text-base font-medium">{t('settingsTitle')}</h1>
                  <span className="text-xs text-text-secondary">
                    v{getExtensionVersion()}
                  </span>
                </div>

                {/* Save Status */}
                {saveStatus === 'success' && (
                  <div className="flex items-center gap-1.5 text-xs text-green-600">
                    <Check className="w-3.5 h-3.5" />
                    <span>{t('settingsSaved')}</span>
                  </div>
                )}
                {saveStatus === 'error' && (
                  <span className="text-xs text-red-600">{t('settingsSaveFailed')}</span>
                )}
              </div>
            )}

            {/* Settings Sections */}
            <div className="space-y-6">
              {/* ── 通用 ── */}
              {(!isEmbedded || settingsTabId !== null) && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-text-secondary px-1">
                    {t('settingsGroupGeneral')}
                  </h3>

                  {/* Language & Font Size */}
                  {!isEmbedded && (
                    <div className="bg-bg-secondary border border-border rounded p-4">
                      <div className="flex flex-wrap gap-6">
                        {/* Language */}
                        <div className="flex-1 min-w-40">
                          <h2 className="text-xs font-medium mb-1.5 text-text-primary">
                            {t('language')}
                          </h2>
                          <div className="flex gap-2">
                            <Button
                              onClick={() => handleLanguageChange('zh_CN')}
                              variant={config.language === 'zh_CN' ? 'primary' : 'secondary'}
                            >
                              {t('chinese')}
                            </Button>
                            <Button
                              onClick={() => handleLanguageChange('en')}
                              variant={config.language === 'en' ? 'primary' : 'secondary'}
                            >
                              {t('english')}
                            </Button>
                          </div>
                        </div>

                        {/* Font Size */}
                        <div className="flex-1 min-w-40">
                          <h2 className="text-xs font-medium mb-1.5 text-text-primary">
                            {t('fontSize')}
                          </h2>
                          <FontSizeControl />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Custom User-Agent */}
                  {settingsTabId !== null && (
                    <div className="bg-bg-secondary border border-border rounded p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h2 className="text-xs font-medium mb-1.5 text-text-primary">
                            {t('customUserAgent')}
                          </h2>
                          <p className="text-xs text-text-secondary">{t('customUserAgentDesc')}</p>
                        </div>
                        <button
                          onClick={handleUaToggle}
                          className={switchClass(uaEnabled)}
                          role="switch"
                          aria-label={t('customUserAgent')}
                          aria-checked={uaEnabled}
                        >
                          <span className={switchThumbClass(uaEnabled)} />
                        </button>
                      </div>
                      {uaEnabled && (
                        <div className="relative mt-3">
                          <textarea
                            value={uaInput}
                            onChange={e => handleUaInputChange(e.target.value)}
                            rows={2}
                            className="w-full text-xs font-mono bg-bg-primary border border-border rounded px-3 py-2 pr-9 text-text-primary placeholder:text-text-secondary resize-none focus:outline-none focus:border-blue-400"
                          />
                          {uaInput !== navigator.userAgent && (
                            <button
                              onClick={handleUaReset}
                              className="absolute top-2 right-2 text-text-secondary hover:text-red-500 transition-colors"
                              title={t('uaReset')}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Custom Timezone and Time */}
                  {settingsTabId !== null && (
                    <div className="@container bg-bg-secondary border border-border rounded p-4">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                        <div className="min-w-0 @[760px]:col-span-2">
                          <h2 className="text-xs font-medium mb-1.5 text-text-primary">
                            {t('customDateTime')}
                          </h2>
                          <p className="text-xs text-text-secondary">{t('customDateTimeDesc')}</p>
                        </div>
                        <div className="ml-auto flex w-48 shrink-0 items-center gap-2 @[760px]:col-start-2 @[760px]:row-start-2 @[760px]:mt-3 @[760px]:self-center">
                          <div className="relative min-w-0 flex-1">
                            <input
                              id="custom-time"
                              aria-label={t('customTime')}
                              type="datetime-local"
                              step="60"
                              value={customTimeInput}
                              onChange={event => handleCustomTimeChange(event.target.value)}
                              onClick={event => event.currentTarget.showPicker()}
                              className="h-6 w-full rounded border border-border bg-bg-primary py-0 pl-2.5 pr-6 text-xs text-text-primary outline-none focus:border-blue-400 [&::-webkit-calendar-picker-indicator]:hidden"
                            />
                            {customTimeInput && (
                              <button
                                type="button"
                                onClick={() => handleCustomTimeChange('')}
                                className="absolute right-1 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                                title={t('customTimeClear')}
                                aria-label={t('customTimeClear')}
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={handleUseCurrentTime}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border bg-bg-primary text-text-primary transition-colors hover:border-blue-400"
                            title={t('customTimeNow')}
                            aria-label={t('customTimeNow')}
                          >
                            <Clock3 className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="col-span-2 mt-3 flex flex-wrap items-center gap-2 @[760px]:col-span-1 @[760px]:col-start-1 @[760px]:row-start-2">
                          {timezoneOptions.map(option => (
                            <Button
                              key={option.value}
                              onClick={() => handleTimezoneChange(option.value)}
                              variant={customTimezone === option.value ? 'primary' : 'secondary'}
                              aria-pressed={customTimezone === option.value}
                              title={option.value || undefined}
                            >
                              {option.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── 请求调试 ── */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-text-secondary px-1">
                  {t('settingsGroupRequest')}
                </h3>

                {/* SSE Monitoring */}
                <div className="bg-bg-secondary border border-border rounded p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h2 className="text-xs font-medium mb-1.5 text-text-primary">
                        {t('sseMonitoring')}
                      </h2>
                      <p className="text-xs text-text-secondary">{t('sseMonitoringDesc')}</p>
                    </div>
                    <button
                      onClick={handleSSEMonitoringToggle}
                      className={switchClass(config.sseMonitoringEnabled)}
                      role="switch"
                      aria-checked={config.sseMonitoringEnabled}
                    >
                      <span className={switchThumbClass(config.sseMonitoringEnabled)} />
                    </button>
                  </div>
                </div>

                {/* Global Translation */}
                <div className="bg-bg-secondary border border-border rounded p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h2 className="text-xs font-medium mb-1.5 text-text-primary">
                        {t('globalTranslation')}
                      </h2>
                      <p className="text-xs text-text-secondary mb-3">
                        {t('globalTranslationDesc')}
                      </p>
                    </div>
                    <button
                      onClick={() => setShowDict(true)}
                      className="flex items-center gap-0.5 text-xs text-text-secondary hover:text-blue-500 transition-colors shrink-0 ml-4 mt-0.5 cursor-pointer"
                      title={t('translationDict')}
                    >
                      {t('translationDict')}
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleGlobalTranslationChange('none')}
                      disabled={saveStatus === 'saving'}
                      variant={config.globalTranslation === 'none' ? 'primary' : 'secondary'}
                    >
                      {t('globalTranslationNone')}
                    </Button>
                    <Button
                      onClick={() => handleGlobalTranslationChange('en')}
                      disabled={saveStatus === 'saving'}
                      variant={config.globalTranslation === 'en' ? 'primary' : 'secondary'}
                    >
                      {t('english')}
                    </Button>
                    <Button
                      onClick={() => handleGlobalTranslationChange('zh-TW')}
                      disabled={saveStatus === 'saving'}
                      variant={config.globalTranslation === 'zh-TW' ? 'primary' : 'secondary'}
                    >
                      {t('traditionalChinese')}
                    </Button>
                  </div>
                </div>
              </div>

              {/* ── 服务集成 ── */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-text-secondary px-1">
                  {t('settingsGroupIntegration')}
                </h3>

                {/* Agent Service */}
                <div className="bg-bg-secondary border border-border rounded p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-xs font-medium text-text-primary">{t('mcpService')}</h2>
                      <button
                        onClick={handleAgentPreventForegroundToggle}
                        className={clsx(
                          'inline-flex cursor-pointer items-center gap-0.5 rounded border px-1 py-0 text-2xs transition-colors',
                          config.agentPreventForeground
                            ? 'border-blue-600 bg-blue-600 text-white'
                            : 'border-border text-text-secondary hover:bg-bg-primary',
                        )}
                        title={t('agentPreventForegroundDesc')}
                        aria-pressed={config.agentPreventForeground}
                      >
                        <BellOff className="w-3 h-3" aria-hidden="true" />
                        <span>{t('agentPreventForeground')}</span>
                      </button>
                    </div>
                    <button
                      onClick={handleAgentEnabledToggle}
                      className={switchClass(config.agentEnabled)}
                      role="switch"
                      aria-label={t('mcpService')}
                      aria-checked={config.agentEnabled}
                    >
                      <span className={switchThumbClass(config.agentEnabled)} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-4 mt-1.5">
                    <p className="text-xs text-text-secondary">{t('mcpServiceDesc')}</p>
                    <button
                      onClick={() => setShowPermissions(v => !v)}
                      className="shrink-0 flex items-center gap-0.5 text-xs text-text-secondary hover:text-blue-500 transition-colors"
                    >
                      {t('permissionsConfig')}
                      <ChevronRight
                        className={clsx(
                          'w-3.5 h-3.5 transition-transform',
                          showPermissions && 'rotate-90',
                        )}
                      />
                    </button>
                  </div>

                  {/* Sub: Agent Domain Permissions */}
                  {showPermissions && <AgentPermissionsSection />}
                </div>

                {/* Agent Side Panel Floating Entry */}
                {!isEmbedded && (
                  <div className="bg-bg-secondary border border-border rounded p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <h2 className="text-xs font-medium mb-1.5 text-text-primary">
                          {t('agentFloatingButton')}
                        </h2>
                        <p className="text-xs text-text-secondary">
                          {t('agentFloatingButtonDesc')}
                        </p>
                      </div>
                      <button
                        onClick={handleAgentFloatingButtonToggle}
                        className={clsx(
                          switchClass(config.agentFloatingButtonEnabled),
                          !config.agentEnabled && 'opacity-50 cursor-not-allowed',
                        )}
                        role="switch"
                        aria-checked={config.agentFloatingButtonEnabled}
                        aria-label={t('agentFloatingButton')}
                        disabled={!config.agentEnabled}
                      >
                        <span className={switchThumbClass(config.agentFloatingButtonEnabled)} />
                      </button>
                    </div>
                  </div>
                )}

                {/* External Services */}
                {hasServices && <div className="bg-bg-secondary border border-border rounded p-4">
                  <h2 className="text-xs font-medium mb-1 text-text-primary">
                    {t('externalServices')}
                  </h2>
                  <p className="text-xs text-text-secondary mb-3">{t('externalServicesDesc')}</p>
                  <div className="flex gap-2 flex-wrap">
                    {[
                      {
                        available: availableServices.accountsEnabled,
                        label: t('accountsServices'),
                        enabled: config.accountsEnabled,
                        onToggle: handleAccountEnabledToggle,
                      },
                      {
                        available: availableServices.requestCasesEnabled,
                        label: t('requestCasesServices'),
                        enabled: config.requestCasesEnabled,
                        onToggle: handleRequestCasesEnabledToggle,
                      },
                      {
                        available: availableServices.requestMetadataEnabled,
                        label: requestUiDefinition ? browserUiText(requestUiDefinition.setting.label, getCurrentLanguage()) : '',
                        enabled: config.requestMetadataEnabled,
                        onToggle: handleRequestMetadataEnabledToggle,
                      },
                      {
                        available: availableServices.requestImportEnabled,
                        label: t('requestImportServices'),
                        enabled: config.requestImportEnabled,
                        onToggle: handleRequestImportEnabledToggle,
                      },
                      {
                        available: availableServices.trackingMetadataEnabled,
                        label: t('trackingMetadataServices'),
                        enabled: config.trackingMetadataEnabled,
                        onToggle: handleTrackingMetadataEnabledToggle,
                      },
                    ].filter(item => item.available && item.label).map(({ label, enabled, onToggle }) => (
                      <Button
                        key={label}
                        onClick={onToggle}
                        disabled={saveStatus === 'saving'}
                        aria-pressed={enabled}
                        variant={enabled ? 'primary' : 'secondary'}
                        className={clsx(!enabled && 'line-through opacity-50')}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>}
              </div>
            </div>

            {/* Footer Info */}
            {!isEmbedded && (
              <div className="pt-4">
                <p className="text-xs text-text-secondary text-center">
                  © 2026 Mearl. A Chrome Extension for AI Agent
                </p>
              </div>
            )}
          </>
        )}
      </div>
      {profileConfirmation && (
        <ProfileInstallModal
          initialSource={searchParams.get('profileSource')}
          confirmation={profileConfirmation}
          onClose={() => void chrome.tabs.getCurrent().then(tab => {
            if (tab?.id !== undefined) return chrome.tabs.remove(tab.id);
          }).catch(() => {})}
        />
      )}
    </div>
  );
};

const FontSizeControl: FC = () => {
  const { currentLevel, setLevel } = useFontSize();
  const fontSizeLabels = [
    t('fontSizeSmall'),
    t('fontSizeDefault'),
    t('fontSizeLarge'),
    t('fontSizeMax'),
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {fontSizeLabels.map((label, index) => (
        <Button
          key={index}
          onClick={() => setLevel(index)}
          variant={currentLevel === index ? 'primary' : 'secondary'}
        >
          {label}
        </Button>
      ))}
    </div>
  );
};

export default Options;
