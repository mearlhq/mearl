import { parseAppProfileMenu, type AppProfileMenuEntry } from '../../../../shared/appProfileMenu';
import { FC, type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Settings,
  ChevronDown,
  ChevronRight,
  Columns2,
  Scan,
  TvMinimal,
  Smartphone,
  TabletSmartphone,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import { browserUiText } from '@mearl/preset/bundles';
import { t, initI18n, getCurrentLanguage } from '../../utils/i18n';
import {
  getConfig,
  updateConfig,
  onConfigChange,
  DEFAULT_CONFIG,
  type ExtensionConfig,
  type Language,
} from '../../utils/config';
import {
  BROWSER_CONTROL_GET_ACTION,
  BROWSER_CONTROL_SET_ACTION,
  NETWORK_CONTROL_STORAGE_PREFIX,
  type BrowserControlResponse,
} from '../../../../shared/browserControl';
import { useBrowserAppProfiles, useBrowserControl } from '../../utils/browserUiSettings';
import { ProfileInstallModal } from '../modal/ProfileInstallModal';
import { useFontSize } from '../../../../shared/hooks/useFontSize';
import { useDelayedHover } from '../../../../shared/hooks/useDelayedHover';
import { showToast } from '../../utils/toast';
import {
  getPageHostPermissionGranted,
  showHostPermissionPromptIfNeeded,
} from '../../hooks/useContentScriptUnreachableToast';
import {
  QUICK_APP_PROFILE_GET_ACTION,
  QUICK_APP_PROFILE_SET_ACTION,
  QUICK_APP_PROFILE_SET_VERSION_ACTION,
  QUICK_DEVICE_EMULATION_CLEAR_ACTION,
  QUICK_DEVICE_EMULATION_GET_ACTION,
  QUICK_DEVICE_EMULATION_SET_ACTION,
  QUICK_DEVICE_PHONE_FRAME_SET_ACTION,
  QUICK_DEVICE_SHELL_SET_ACTION,
  QUICK_DEVICE_SPLIT_SCREEN_SET_ACTION,
  QUICK_SIMULATION_AUTO_RULE_GET_ACTION,
  QUICK_SIMULATION_AUTO_RULE_SET_ACTION,
  QUICK_ADAPTIVE_DEVICE_PRESET_NAMES,
  QUICK_FIXED_DEVICE_PRESET_NAMES,
  getQuickDevicePresetDefaultOrientation,
  getQuickDevicePresetLabel,
  isQuickAdaptiveDevicePresetName,
  normalizeQuickDeviceFitToWindow,
  type QuickAppProfileName,
  type QuickAppProfileResponse,
  type QuickDeviceOrientation,
  type QuickDevicePresetName,
  type QuickDeviceEmulationResponse,
  type QuickSimulationAutoRule,
  type QuickSimulationAutoRuleResponse,
} from '../../../../shared/quickAppProfile';
import {
  BROWSER_EXTENSION_UPDATE_VERSION_KEY,
  UPDATE_SETUP_EXTENSION_ACTION,
  type ExtensionUpdateResponse,
} from '../../../../shared/extensionUpdate';
import {
  getExtensionInstallationInfo,
  type ExtensionInstallationInfo,
} from '../../../../shared/extensionInstallation';
import {
  compareReleaseVersions,
  fetchRemoteConfig,
  getExtensionChangelogUrl,
  getRemoteExtensionRelease,
  type RemoteConfig,
} from '../../../../shared/remoteConfig';

interface QuickSettingsMenuProps {
  inspectedTabId?: number;
  /** 点击「更多设置」时打开完整设置页 */
  onShowSettings: () => void;
  /** 与同一页面的 Banner 共用远端配置；未传时仅 setup 安装会按需拉取 */
  remoteConfig?: RemoteConfig | null;
  /**
   * 下拉面板对齐方式
   * - default：右边缘与齿轮对齐（panel 模式）
   * - far-right：相对窗口右侧贴边展示（popup / 侧边栏）
   */
  dropdownAlign?: 'default' | 'far-right';
}

const QUICK_SETTINGS_HOVER_DELAY_MS = 200;
const QUICK_SETTINGS_CLOSE_DELAY_MS = 200;

type SelectorMenu = 'app' | 'device';

const useDelayedSelectorMenus = (enabled: boolean) => {
  const [openMenu, setOpenMenu] = useState<SelectorMenu | null>(null);
  const openMenuRef = useRef<SelectorMenu | null>(null);
  const pendingMenuRef = useRef<SelectorMenu | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredRef = useRef<SelectorMenu | null>(null);
  const focusedRef = useRef<SelectorMenu | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOpenMenu(null);
      openMenuRef.current = null;
      hoveredRef.current = null;
      focusedRef.current = null;
    }
    return () => {
      if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
      openTimerRef.current = null;
      closeTimerRef.current = null;
      pendingMenuRef.current = null;
    };
  }, [enabled]);

  const clearOpenTimer = () => {
    if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
    pendingMenuRef.current = null;
  };

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const activateMenu = (menu: SelectorMenu) => {
    if (!enabled) return;
    clearCloseTimer();
    if (openMenuRef.current !== null) {
      clearOpenTimer();
      openMenuRef.current = menu;
      setOpenMenu(menu);
      return;
    }
    if (pendingMenuRef.current === menu) return;
    clearOpenTimer();
    pendingMenuRef.current = menu;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      pendingMenuRef.current = null;
      openMenuRef.current = menu;
      setOpenMenu(menu);
    }, QUICK_SETTINGS_HOVER_DELAY_MS);
  };

  const deactivateMenu = (menu: SelectorMenu) => {
    if (hoveredRef.current === menu || focusedRef.current === menu) return;
    if (pendingMenuRef.current === menu) clearOpenTimer();
    if (openMenuRef.current !== menu) return;
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      openMenuRef.current = null;
      setOpenMenu(null);
    }, QUICK_SETTINGS_CLOSE_DELAY_MS);
  };

  const getHandlers = (menu: SelectorMenu) => ({
    onMouseEnter: () => {
      hoveredRef.current = menu;
      activateMenu(menu);
    },
    onMouseLeave: () => {
      if (hoveredRef.current === menu) hoveredRef.current = null;
      deactivateMenu(menu);
    },
    onFocus: () => {
      focusedRef.current = menu;
      activateMenu(menu);
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      if (focusedRef.current === menu) focusedRef.current = null;
      deactivateMenu(menu);
    },
  });

  return {
    openMenu: enabled ? openMenu : null,
    appMenuHandlers: getHandlers('app'),
    deviceMenuHandlers: getHandlers('device'),
  };
};

interface AvailableExtensionUpdate {
  changelogUrl: string;
  kind: 'browser' | 'setup';
  version: string;
}

const persistConfig = (config: Partial<ExtensionConfig>) => {
  void updateConfig(config).catch(error => {
    console.error('[QuickSettingsMenu] Failed to persist config:', error);
  });
};

const segBtnClass = (active: boolean) =>
  clsx(
    'flex-1 px-1.5 py-1 text-2xs rounded border cursor-pointer text-center whitespace-nowrap',
    active
      ? 'bg-blue-600 text-white border-blue-600'
      : 'bg-bg-primary border-border text-text-primary hover:border-blue-400',
  );

const selectorMenuItemClass = (active: boolean, disabled: boolean) =>
  clsx(
    'flex w-full items-center whitespace-nowrap rounded px-1.5 py-1 text-left text-2xs transition-colors',
    active
      ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50'
      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
  );

const iconToggleButtonClass = (active: boolean, disabled: boolean) =>
  clsx(
    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors',
    active ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400' : 'text-text-secondary',
    disabled
      ? 'cursor-not-allowed opacity-40'
      : 'cursor-pointer hover:bg-bg-hover hover:text-text-primary',
  );

const switchClass = (enabled: boolean, animated: boolean) =>
  clsx(
    'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full focus:outline-none cursor-pointer',
    animated && 'transition-colors motion-reduce:transition-none',
    enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
  );

const switchThumbClass = (enabled: boolean, animated: boolean) =>
  clsx(
    'inline-block h-3 w-3 transform rounded-full bg-white',
    animated && 'transition-transform motion-reduce:transition-none',
    enabled ? 'translate-x-3.5' : 'translate-x-0.5',
  );

const getFixedFitToWindowFromResponse = (
  response: QuickDeviceEmulationResponse,
): boolean | undefined => {
  if (typeof response.fixedFitToWindow === 'boolean') return response.fixedFitToWindow;
  if (
    response.preset &&
    !isQuickAdaptiveDevicePresetName(response.preset) &&
    typeof response.fitToWindow === 'boolean'
  ) {
    return response.fitToWindow;
  }
  return undefined;
};

const getActiveTabId = async (): Promise<number | null> => {
  const devtoolsTabId = chrome.devtools?.inspectedWindow?.tabId;
  if (typeof devtoolsTabId === 'number') return devtoolsTabId;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
};

export const QuickSettingsMenu: FC<QuickSettingsMenuProps> = ({
  inspectedTabId,
  onShowSettings,
  dropdownAlign = 'default',
  remoteConfig,
}) => {
  const getContextTabId = useCallback(() => inspectedTabId === undefined
    ? getActiveTabId() : Promise.resolve(inspectedTabId), [inspectedTabId]);
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [controlState, setControlState] = useState<{ key: string; tabId: number; value: string } | null>(null);
  const controlRevisionRef = useRef(0);
  const control = useBrowserControl(t);
  const controlKey = control ? JSON.stringify([control.bundleId, control.revision, control.definition.id]) : '';
  const controlValue = controlState?.key === controlKey ? controlState.value : null;
  const controlTabId = controlState?.key === controlKey ? controlState.tabId : null;
  const [pagePermissionGranted, setPagePermissionGranted] = useState<boolean | null>(null);
  const [appProfile, setAppProfile] = useState<QuickAppProfileName | null>(null);
  const installedProfiles = useBrowserAppProfiles();
  const [discoveredProfiles, setDiscoveredProfiles] = useState<{ source: AppProfileMenuEntry[]; profiles: AppProfileMenuEntry[] }>();
  const profileCatalog = discoveredProfiles?.source === installedProfiles ? discoveredProfiles.profiles : installedProfiles;
  const [otherProfilesExpanded, setOtherProfilesExpanded] = useState(false);
  const [profileInstallOpen, setProfileInstallOpen] = useState(false);
  const appSelectorRef = useRef<HTMLButtonElement>(null);
  const [appProfileReady, setAppProfileReady] = useState(false);
  const [appProfileLoading, setAppProfileLoading] = useState(false);
  const [deviceEmulationActive, setDeviceEmulationActive] = useState(false);
  const [deviceEmulationPreset, setDeviceEmulationPreset] = useState<QuickDevicePresetName | null>(
    null,
  );
  const [deviceOrientation, setDeviceOrientation] = useState<QuickDeviceOrientation>('portrait');
  const [fixedDeviceFitToWindow, setFixedDeviceFitToWindow] = useState(true);
  const [deviceEmulationLoading, setDeviceEmulationLoading] = useState(false);
  const [deviceEmulationReady, setDeviceEmulationReady] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [deviceShell, setDeviceShell] = useState(true);
  const [phoneFrame, setPhoneFrame] = useState(false);
  const [deviceSplitScreen, setDeviceSplitScreen] = useState(false);
  const [autoSimulationEnabled, setAutoSimulationEnabled] = useState(false);
  const [autoSimulationDomain, setAutoSimulationDomain] = useState<string | null>(null);
  const [autoSimulationReady, setAutoSimulationReady] = useState(false);
  const [autoSimulationLoading, setAutoSimulationLoading] = useState(false);
  const [editingVersion, setEditingVersion] = useState(false);
  const [versionDraft, setVersionDraft] = useState('');
  const {
    open: quickSettingsOpen,
    setOpen: setQuickSettingsOpen,
    scheduleOpen,
    scheduleClose: handleMouseLeave,
    cancelClose: clearCloseTimer,
  } = useDelayedHover();
  const { openMenu, appMenuHandlers, deviceMenuHandlers } =
    useDelayedSelectorMenus(quickSettingsOpen);
  const openProfileInstaller = () => {
    setQuickSettingsOpen(false);
    setProfileInstallOpen(true);
  };
  const closeProfileInstaller = () => {
    setProfileInstallOpen(false);
    setQuickSettingsOpen(true);
    requestAnimationFrame(() => appSelectorRef.current?.focus());
  };
  const [extensionInstallation, setExtensionInstallation] =
    useState<ExtensionInstallationInfo | null>(null);
  const [standaloneRemoteConfig, setStandaloneRemoteConfig] = useState<RemoteConfig | null>(null);
  const [browserUpdateVersion, setBrowserUpdateVersion] = useState<string | null>(null);
  const [ignoredUpdateVersion, setIgnoredUpdateVersion] = useState<string | null>(null);
  const [extensionUpdating, setExtensionUpdating] = useState(false);
  const [agentFloatingButtonTransitionReady, setAgentFloatingButtonTransitionReady] =
    useState(false);
  const lastAppProfileRef = useRef<QuickAppProfileName | null>(null);
  const lastDevicePresetRef = useRef<QuickDevicePresetName>('iphone-17-pro');
  const autoSimulationRuleRef = useRef<QuickSimulationAutoRule | null>(null);
  const { currentLevel, totalLevels, setLevel } = useFontSize();

  useEffect(() => {
    getConfig().then(nextConfig => {
      setConfig(nextConfig);
      setConfigReady(true);
    });
    const unsubscribe = onConfigChange(async changes => {
      if (changes.language) await initI18n(changes.language);
      setConfig(prev => ({ ...prev, ...changes }));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!control) return;
    let disposed = false;
    const refresh = async () => {
      const currentRevision = ++controlRevisionRef.current;
      try {
        const tabId = await getContextTabId();
        if (disposed || currentRevision !== controlRevisionRef.current) return;
        setControlState(previous => previous?.key === controlKey && previous.tabId === tabId ? previous : null);
        const response: BrowserControlResponse | undefined =
          tabId === null
            ? undefined
            : await chrome.runtime.sendMessage({ action: BROWSER_CONTROL_GET_ACTION, tabId });
        if (disposed || currentRevision !== controlRevisionRef.current) return;
        if (response?.success && tabId !== null)
          setControlState({ key: controlKey, tabId, value: response.value ?? control.definition.defaultValue });
      } catch {
        // Keep a confirmed selection for the same tab during a transient read failure.
      }
    };
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (
        area === 'session' &&
        Object.keys(changes).some(key => key.startsWith(NETWORK_CONTROL_STORAGE_PREFIX))
      ) {
        void refresh();
      }
    };
    const onActivated = () => {
      void refresh();
    };
    void refresh();
    chrome.tabs.onActivated?.addListener(onActivated);
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      disposed = true;
      controlRevisionRef.current += 1;
      chrome.tabs.onActivated?.removeListener(onActivated);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, [controlKey, getContextTabId]);

  useEffect(() => {
    getExtensionInstallationInfo()
      .then(setExtensionInstallation)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!extensionInstallation?.setupManagedPath || remoteConfig !== undefined) return;
    let cancelled = false;
    fetchRemoteConfig()
      .then(nextConfig => {
        if (!cancelled) setStandaloneRemoteConfig(nextConfig);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [extensionInstallation?.setupManagedPath, remoteConfig]);

  useEffect(() => {
    if (!extensionInstallation || extensionInstallation.setupManagedPath) return;
    let cancelled = false;
    chrome.storage.local.get([BROWSER_EXTENSION_UPDATE_VERSION_KEY], result => {
      if (cancelled || chrome.runtime.lastError) return;
      const version = result[BROWSER_EXTENSION_UPDATE_VERSION_KEY];
      setBrowserUpdateVersion(typeof version === 'string' ? version : null);
    });
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: chrome.storage.AreaName,
    ) => {
      if (areaName !== 'local') return;
      const version = changes[BROWSER_EXTENSION_UPDATE_VERSION_KEY]?.newValue;
      setBrowserUpdateVersion(typeof version === 'string' ? version : null);
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [extensionInstallation]);

  const availableExtensionUpdate = useMemo<AvailableExtensionUpdate | null>(() => {
    if (!extensionInstallation) return null;
    if (!extensionInstallation.setupManagedPath) {
      if (!browserUpdateVersion || ignoredUpdateVersion === browserUpdateVersion) return null;
      const changelogUrl = getExtensionChangelogUrl(browserUpdateVersion);
      const comparison = compareReleaseVersions(
        browserUpdateVersion,
        extensionInstallation.extensionVersion,
      );
      return changelogUrl && comparison !== null && comparison > 0
        ? { changelogUrl, kind: 'browser', version: browserUpdateVersion }
        : null;
    }

    const effectiveRemoteConfig =
      remoteConfig === undefined ? standaloneRemoteConfig : remoteConfig;
    if (!effectiveRemoteConfig) return null;
    const release = getRemoteExtensionRelease(effectiveRemoteConfig);
    if (!release) return null;
    const comparison = compareReleaseVersions(
      release.version,
      extensionInstallation.extensionVersion,
    );
    if (comparison === null || comparison <= 0 || ignoredUpdateVersion === release.version) {
      return null;
    }
    return { changelogUrl: release.changelogUrl, kind: 'setup', version: release.version };
  }, [
    browserUpdateVersion,
    extensionInstallation,
    ignoredUpdateVersion,
    remoteConfig,
    standaloneRemoteConfig,
  ]);

  useEffect(() => {
    if (pagePermissionGranted === null) return;
    const id = requestAnimationFrame(() => setAgentFloatingButtonTransitionReady(true));
    return () => cancelAnimationFrame(id);
  }, [pagePermissionGranted]);

  useEffect(() => {
    if (!quickSettingsOpen) return;
    let cancelled = false;
    chrome.runtime
      .sendMessage({ action: 'appProfileCatalogGet' })
      .then(result => {
        if (cancelled) return;
        if (!result?.success) return;
        const profiles = parseAppProfileMenu(result.profiles).filter(profile => profile.available !== false);
        setDiscoveredProfiles({ source: installedProfiles, profiles });
        if (!profiles.some(profile => profile.id === lastAppProfileRef.current))
          lastAppProfileRef.current = profiles[0]?.id ?? null;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [quickSettingsOpen, openMenu, installedProfiles]);

  const refreshPagePermission = async () => {
    const tabId = await getContextTabId();
    setPagePermissionGranted(await getPageHostPermissionGranted(tabId));
  };

  const refreshAppProfile = async (): Promise<QuickAppProfileResponse | undefined> => {
    const tabId = await getContextTabId();
    if (tabId === null) {
      setAppProfileReady(true);
      return undefined;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_APP_PROFILE_GET_ACTION,
        tabId,
      })) as QuickAppProfileResponse | undefined;
      if (response?.success) {
        const profile = response.profile ?? null;
        const lastProfile = profile ?? response.lastProfile;
        setAppProfile(profile);
        if (lastProfile) lastAppProfileRef.current = lastProfile;
        setAppVersion(response.appVersion ?? null);
      }
      return response;
    } catch {
      // 快捷设置仍可展示，用户点击时会再次解析当前 tab
      return undefined;
    } finally {
      setAppProfileReady(true);
    }
  };

  const refreshDeviceEmulation = async (): Promise<QuickDeviceEmulationResponse | undefined> => {
    const tabId = await getContextTabId();
    if (tabId === null) {
      setDeviceEmulationActive(false);
      setDeviceEmulationPreset(null);
      setDeviceEmulationReady(true);
      return undefined;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_DEVICE_EMULATION_GET_ACTION,
        tabId,
      })) as QuickDeviceEmulationResponse | undefined;
      const active = response?.success === true && response.active === true;
      const rememberedPreset = response?.success ? (response.preset ?? null) : null;
      const preset = active ? rememberedPreset : null;
      setDeviceEmulationActive(active);
      setDeviceEmulationPreset(preset);
      if (rememberedPreset) lastDevicePresetRef.current = rememberedPreset;
      if (response?.orientation) setDeviceOrientation(response.orientation);
      const fixedFitToWindow = response ? getFixedFitToWindowFromResponse(response) : undefined;
      if (fixedFitToWindow !== undefined) setFixedDeviceFitToWindow(fixedFitToWindow);
      if (typeof response?.deviceShell === 'boolean') setDeviceShell(response.deviceShell);
      setPhoneFrame(active && response?.phoneFrame === true);
      setDeviceSplitScreen(active && response?.splitScreen === true);
      return response;
    } catch {
      setDeviceEmulationActive(false);
      setDeviceEmulationPreset(null);
      return undefined;
    } finally {
      setDeviceEmulationReady(true);
    }
  };

  const refreshAutoSimulation = async (): Promise<QuickSimulationAutoRuleResponse | undefined> => {
    const tabId = await getContextTabId();
    if (tabId === null) {
      setAutoSimulationEnabled(false);
      setAutoSimulationDomain(null);
      setAutoSimulationReady(true);
      return undefined;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_SIMULATION_AUTO_RULE_GET_ACTION,
        tabId,
      })) as QuickSimulationAutoRuleResponse | undefined;
      if (response?.success) {
        const rule = response.rule ?? null;
        autoSimulationRuleRef.current = rule;
        setAutoSimulationEnabled(response.enabled === true);
        setAutoSimulationDomain(response.domain ?? null);
      }
      return response;
    } catch {
      return undefined;
    } finally {
      setAutoSimulationReady(true);
    }
  };

  const refreshSimulation = async () => {
    await Promise.all([refreshAppProfile(), refreshDeviceEmulation(), refreshAutoSimulation()]);
  };

  const openQuickSettings = (immediate = false) => {
    if (profileInstallOpen) return;
    if (immediate) setQuickSettingsOpen(true);
    else scheduleOpen();
    void refreshPagePermission();
    void refreshSimulation();
  };

  const handleShowSettings = () => {
    setQuickSettingsOpen(false);
    onShowSettings();
  };

  const handleExtensionUpdate = async () => {
    if (extensionUpdating || !availableExtensionUpdate) return;
    setExtensionUpdating(true);
    if (availableExtensionUpdate.kind === 'browser') {
      showToast(t('extensionUpdateReloading'), 'success');
      setTimeout(() => chrome.runtime.reload(), 100);
      return;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        action: UPDATE_SETUP_EXTENSION_ACTION,
      })) as ExtensionUpdateResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'Extension update failed');
      if (!response.updated) {
        setIgnoredUpdateVersion(availableExtensionUpdate.version);
        showToast(t('extensionAlreadyLatest'), 'info');
        setExtensionUpdating(false);
        return;
      }
      showToast(t('extensionUpdateReloading'), 'success');
    } catch {
      showToast(t('extensionUpdateFailed'), 'error');
      setExtensionUpdating(false);
    }
  };

  const handleOpenExtensionChangelog = () => {
    const url = availableExtensionUpdate?.changelogUrl;
    if (!url) return;
    void chrome.tabs.create({ url, active: true });
  };

  const handleLanguageChange = async (language: Language) => {
    if (language === config.language) return;
    await initI18n(language);
    setConfig(prev => ({ ...prev, language }));
    persistConfig({ language });
  };

  const agentFloatingButtonActive =
    config.agentFloatingButtonEnabled && pagePermissionGranted === true;

  const handleAgentFloatingButtonToggle = () => {
    if (!config.agentEnabled || pagePermissionGranted === null) return;

    if (agentFloatingButtonActive) {
      setConfig(prev => ({ ...prev, agentFloatingButtonEnabled: false }));
      persistConfig({ agentFloatingButtonEnabled: false });
      return;
    }

    if (!config.agentFloatingButtonEnabled) {
      setConfig(prev => ({ ...prev, agentFloatingButtonEnabled: true }));
      persistConfig({ agentFloatingButtonEnabled: true });
    }
    if (!pagePermissionGranted) {
      void getContextTabId().then(tabId => showHostPermissionPromptIfNeeded(tabId));
    }
  };

  const handleControlChange = async (value: string) => {
    if (!control) return;
    const revision = ++controlRevisionRef.current;
    try {
      // 点击期间活动 tab 发生变化时，不把刚才看到的设置写给另一个页面。
      const tabId = await getContextTabId();
      if (tabId === null || (controlTabId !== null && tabId !== controlTabId)) {
        throw new Error('Target tab is unavailable or changed');
      }
      const response = (await chrome.runtime.sendMessage({
        action: BROWSER_CONTROL_SET_ACTION,
        tabId,
        value, controlId: control.definition.id, bundleId: control.bundleId, revision: control.revision,
      })) as BrowserControlResponse | undefined;
      if (!response?.success)
        throw new Error(response?.error || 'Failed to change browser control');
      if (revision === controlRevisionRef.current) setControlState({ key: controlKey, tabId, value: response.value ?? value });
      showToast(browserUiText(control.definition.messages.changed, getCurrentLanguage()), 'info');
    } catch {
      showToast(browserUiText(control.definition.messages.failed, getCurrentLanguage()), 'error');
    }
  };

  const handleAutoSimulationToggle = async () => {
    if (
      !autoSimulationReady ||
      !autoSimulationDomain ||
      autoSimulationLoading ||
      !appProfileReady ||
      !deviceEmulationReady
    ) {
      return;
    }
    const tabId = await getContextTabId();
    if (tabId === null) return;
    const enabled = !autoSimulationEnabled;
    if (enabled && (await getPageHostPermissionGranted(tabId)) !== true) {
      await showHostPermissionPromptIfNeeded(tabId);
      return;
    }

    const profile = appProfile ?? lastAppProfileRef.current ?? profileCatalog[0]?.id;
    if (enabled && !profile) return;
    const preset = deviceEmulationPreset ?? lastDevicePresetRef.current;
    const rememberedRule = autoSimulationRuleRef.current;
    const rememberedDevice =
      rememberedRule?.deviceSelection.preset === preset
        ? rememberedRule.deviceSelection
        : undefined;
    setAutoSimulationLoading(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_SIMULATION_AUTO_RULE_SET_ACTION,
        tabId,
        enabled,
        ...(enabled
          ? {
              profile,
              ...(appVersion ? { appVersion } : {}),
              deviceSelection: {
                preset,
                orientation: rememberedDevice?.orientation ?? deviceOrientation,
                fitToWindow:
                  rememberedDevice?.fitToWindow ??
                  normalizeQuickDeviceFitToWindow(preset, fixedDeviceFitToWindow),
                deviceShell: rememberedDevice?.deviceShell ?? deviceShell,
                splitScreen: rememberedDevice?.splitScreen ?? deviceSplitScreen,
              },
              applyToTab: true,
            }
          : {}),
      })) as QuickSimulationAutoRuleResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'Automatic simulation failed');
      autoSimulationRuleRef.current = response.rule ?? null;
      setAutoSimulationEnabled(response.enabled === true);
      setAutoSimulationDomain(response.domain ?? autoSimulationDomain);
      if (enabled) await Promise.all([refreshAppProfile(), refreshDeviceEmulation()]);
    } catch {
      showToast(t('deviceSimulationAutoChangeFailed'), 'error');
      await refreshAutoSimulation();
    } finally {
      setAutoSimulationLoading(false);
    }
  };

  const handleAppProfileChange = async (selected: QuickAppProfileName | null) => {
    if (!appProfileReady || appProfileLoading || deviceEmulationLoading) return;
    if (selected === appProfile) return;
    const tabId = await getContextTabId();
    if (tabId === null) {
      showToast(t('appSimulationChangeFailed'), 'error');
      return;
    }

    const nextProfile = selected;
    if (nextProfile !== null && (await getPageHostPermissionGranted(tabId)) !== true) {
      await showHostPermissionPromptIfNeeded(tabId);
      return;
    }
    const devicePreset = deviceEmulationPreset ?? lastDevicePresetRef.current;
    setAppProfileLoading(true);
    setDeviceEmulationLoading(true);
    setEditingVersion(false);
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_APP_PROFILE_SET_ACTION,
        tabId,
        profile: nextProfile,
        ...(nextProfile
          ? {
              deviceSelection: {
                preset: devicePreset,
                orientation: deviceOrientation,
                fitToWindow: normalizeQuickDeviceFitToWindow(devicePreset, fixedDeviceFitToWindow),
                deviceShell,
                splitScreen: deviceEmulationActive && deviceSplitScreen,
              },
            }
          : {}),
      })) as QuickAppProfileResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'App profile update failed');
      const profile = response.profile ?? null;
      const lastProfile = profile ?? response.lastProfile;
      setAppProfile(profile);
      if (lastProfile) lastAppProfileRef.current = lastProfile;
      if (!profile && autoSimulationEnabled) {
        autoSimulationRuleRef.current = null;
        setAutoSimulationEnabled(false);
      }
      setAppVersion(response.appVersion ?? null);
      if (response.device?.success) {
        const active = response.device.active === true;
        setPhoneFrame(active && response.device.phoneFrame === true);
        const rememberedPreset = response.device.preset ?? null;
        setDeviceEmulationActive(active);
        setDeviceEmulationPreset(active ? rememberedPreset : null);
        if (rememberedPreset) lastDevicePresetRef.current = rememberedPreset;
        if (response.device.orientation) {
          setDeviceOrientation(response.device.orientation);
        }
        const fixedFitToWindow = getFixedFitToWindowFromResponse(response.device);
        if (fixedFitToWindow !== undefined) setFixedDeviceFitToWindow(fixedFitToWindow);
        if (typeof response.device.deviceShell === 'boolean') {
          setDeviceShell(response.device.deviceShell);
        }
        if (typeof response.device.splitScreen === 'boolean') {
          setDeviceSplitScreen(response.device.splitScreen);
        }
      }
    } catch (error) {
      console.warn('[QuickSettings] App simulation failed:', error);
      showToast(t('appSimulationChangeFailed'), 'error');
    } finally {
      setAppProfileLoading(false);
      setDeviceEmulationLoading(false);
    }
  };

  const handleDeviceShellToggle = async () => {
    if (!deviceEmulationActive || deviceEmulationLoading) return;
    const tabId = await getContextTabId();
    if (tabId === null) {
      showToast(t('deviceSimulationChangeFailed'), 'error');
      return;
    }
    const next = !deviceShell;
    setDeviceEmulationLoading(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_DEVICE_SHELL_SET_ACTION,
        tabId,
        deviceShell: next,
      })) as QuickDeviceEmulationResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'Device shell update failed');
      setDeviceShell(response.deviceShell === true);
      setPhoneFrame(response.phoneFrame === true);
      if (typeof response.splitScreen === 'boolean') {
        setDeviceSplitScreen(response.splitScreen);
      }
    } catch {
      showToast(t('deviceSimulationChangeFailed'), 'error');
    } finally {
      setDeviceEmulationLoading(false);
    }
  };

  const handlePhoneFrameToggle = async () => {
    if (deviceEmulationLoading) return;
    const tabId = await getContextTabId();
    if (tabId === null) {
      showToast(t('deviceSimulationChangeFailed'), 'error');
      return;
    }
    setDeviceEmulationLoading(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_DEVICE_PHONE_FRAME_SET_ACTION,
        tabId,
        enabled: !phoneFrame,
      })) as QuickDeviceEmulationResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'Phone frame update failed');
      setPhoneFrame(response.phoneFrame === true);
    } catch {
      showToast(t('deviceSimulationChangeFailed'), 'error');
    } finally {
      setDeviceEmulationLoading(false);
    }
  };

  const handleDevicePresetChange = async (
    preset: QuickDevicePresetName | null,
    orientation: QuickDeviceOrientation = preset && preset !== deviceEmulationPreset
      ? getQuickDevicePresetDefaultOrientation(preset)
      : deviceOrientation,
    fitToWindow: boolean = preset
      ? normalizeQuickDeviceFitToWindow(preset, fixedDeviceFitToWindow)
      : fixedDeviceFitToWindow,
  ) => {
    if (deviceEmulationLoading) return;
    if (
      (preset === null && !deviceEmulationActive) ||
      (preset !== null &&
        deviceEmulationActive &&
        preset === deviceEmulationPreset &&
        orientation === deviceOrientation &&
        fitToWindow === normalizeQuickDeviceFitToWindow(preset, fixedDeviceFitToWindow))
    ) {
      return;
    }
    const tabId = await getContextTabId();
    if (tabId === null) {
      showToast(t('deviceSimulationChangeFailed'), 'error');
      return;
    }
    if (preset !== null && (await getPageHostPermissionGranted(tabId)) !== true) {
      await showHostPermissionPromptIfNeeded(tabId);
      return;
    }
    setDeviceEmulationLoading(true);
    try {
      const nextSplitScreen =
        deviceEmulationActive && preset === deviceEmulationPreset ? deviceSplitScreen : false;
      const response = (await chrome.runtime.sendMessage({
        action:
          preset === null ? QUICK_DEVICE_EMULATION_CLEAR_ACTION : QUICK_DEVICE_EMULATION_SET_ACTION,
        tabId,
        ...(preset === null
          ? {}
          : {
              preset,
              orientation,
              fitToWindow,
              deviceShell,
              splitScreen: nextSplitScreen,
            }),
      })) as QuickDeviceEmulationResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'Device emulation update failed');
      const active = response.active === true;
      const rememberedPreset = response.preset ?? preset;
      const activePreset = active ? rememberedPreset : null;
      setDeviceEmulationActive(active);
      setDeviceEmulationPreset(activePreset);
      if (!active && autoSimulationEnabled) {
        autoSimulationRuleRef.current = null;
        setAutoSimulationEnabled(false);
      }
      if (rememberedPreset) lastDevicePresetRef.current = rememberedPreset;
      if (response.orientation) {
        setDeviceOrientation(response.orientation);
      } else if (active) {
        setDeviceOrientation(orientation);
      }
      const fixedFitToWindow = getFixedFitToWindowFromResponse(response);
      if (fixedFitToWindow !== undefined) setFixedDeviceFitToWindow(fixedFitToWindow);
      if (typeof response.deviceShell === 'boolean') setDeviceShell(response.deviceShell);
      setPhoneFrame(active && response.phoneFrame === true);
      if (typeof response.splitScreen === 'boolean') {
        setDeviceSplitScreen(response.splitScreen);
      }
    } catch {
      showToast(t('deviceSimulationChangeFailed'), 'error');
    } finally {
      setDeviceEmulationLoading(false);
    }
  };

  const handleDeviceOrientationToggle = () => {
    if (!deviceEmulationPreset || deviceEmulationLoading) return;
    const nextOrientation = deviceOrientation === 'portrait' ? 'landscape' : 'portrait';
    void handleDevicePresetChange(deviceEmulationPreset, nextOrientation);
  };

  const handleDeviceSplitScreenToggle = async () => {
    const adaptive = isQuickAdaptiveDevicePresetName(deviceEmulationPreset);
    if (
      appProfile === null ||
      !deviceShell ||
      !deviceEmulationActive ||
      (!adaptive && deviceOrientation !== 'landscape') ||
      deviceEmulationLoading
    ) {
      return;
    }
    const tabId = await getContextTabId();
    if (tabId === null) {
      showToast(t('deviceSimulationChangeFailed'), 'error');
      return;
    }
    const next = !deviceSplitScreen;
    setDeviceEmulationLoading(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_DEVICE_SPLIT_SCREEN_SET_ACTION,
        tabId,
        splitScreen: next,
      })) as QuickDeviceEmulationResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'Split screen update failed');
      setDeviceSplitScreen(response.splitScreen === true);
      setPhoneFrame(response.phoneFrame === true);
    } catch {
      showToast(t('deviceSimulationChangeFailed'), 'error');
    } finally {
      setDeviceEmulationLoading(false);
    }
  };

  const handleDeviceFitToWindowToggle = () => {
    if (!deviceEmulationPreset || deviceEmulationLoading) return;
    void handleDevicePresetChange(
      deviceEmulationPreset,
      deviceOrientation,
      !fixedDeviceFitToWindow,
    );
  };

  const handleVersionSubmit = async () => {
    const trimmed = versionDraft.trim();
    if (!trimmed || trimmed === appVersion) {
      setEditingVersion(false);
      return;
    }
    const tabId = await getContextTabId();
    if (tabId === null) {
      setEditingVersion(false);
      showToast(t('appSimulationChangeFailed'), 'error');
      return;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        action: QUICK_APP_PROFILE_SET_VERSION_ACTION,
        tabId,
        appVersion: trimmed,
      })) as QuickAppProfileResponse | undefined;
      if (!response?.success) throw new Error(response?.error || 'App version update failed');
      setAppVersion(response.appVersion ?? trimmed);
    } catch {
      showToast(t('appSimulationChangeFailed'), 'error');
    } finally {
      setEditingVersion(false);
    }
  };

  const getAppProfileLabel = (profile: QuickAppProfileName): string => {
    const entry = profileCatalog.find(item => item.id === profile);
    return entry?.definition?.labels ? browserUiText(entry.definition.labels, getCurrentLanguage()) : entry?.label ?? profile;
  };

  const hasAppProfiles = profileCatalog.length > 0;
  const hasAppMenu = hasAppProfiles || appProfile !== null;
  const primaryProfiles = profileCatalog.slice(0, 4);
  const additionalProfiles = profileCatalog.slice(4);
  const visibleProfiles = otherProfilesExpanded
    ? [...primaryProfiles, ...additionalProfiles]
    : primaryProfiles;

  const getDevicePresetLabel = (preset: QuickDevicePresetName) => getQuickDevicePresetLabel(preset, t);

  const renderDevicePresetOption = (preset: QuickDevicePresetName) => (
    <button
      key={preset}
      type="button"
      onClick={() =>
        void handleDevicePresetChange(deviceEmulationPreset === preset ? null : preset)
      }
      className={selectorMenuItemClass(deviceEmulationPreset === preset, deviceEmulationLoading)}
      role="menuitemradio"
      aria-checked={deviceEmulationPreset === preset}
      disabled={deviceEmulationLoading}
    >
      {getDevicePresetLabel(preset)}
    </button>
  );

  const selectedAppProfile = appProfile ?? lastAppProfileRef.current ?? profileCatalog[0]?.id;
  const appSelectorLabel = selectedAppProfile ? getAppProfileLabel(selectedAppProfile) : t('deviceSimulationApp');
  const deviceSelectorLabel = deviceEmulationActive
    ? deviceEmulationPreset
      ? getDevicePresetLabel(deviceEmulationPreset)
      : t('deviceSimulationCustom')
    : getDevicePresetLabel(lastDevicePresetRef.current);
  const deviceOrientationAction =
    deviceOrientation === 'landscape'
      ? t('deviceSimulationDisableLandscape')
      : t('deviceSimulationEnableLandscape');
  const devicePresetControlsAvailable =
    deviceEmulationActive &&
    deviceEmulationPreset !== null &&
    !isQuickAdaptiveDevicePresetName(deviceEmulationPreset);
  const deviceSplitScreenControlsAvailable =
    appProfile !== null &&
    deviceShell &&
    deviceEmulationActive &&
    deviceEmulationPreset !== null &&
    (isQuickAdaptiveDevicePresetName(deviceEmulationPreset) ||
      (devicePresetControlsAvailable && deviceOrientation === 'landscape'));
  const deviceFitToWindowActive = devicePresetControlsAvailable && fixedDeviceFitToWindow;
  const autoSimulationButtonDisabled =
    !autoSimulationReady ||
    !autoSimulationDomain ||
    autoSimulationLoading ||
    !appProfileReady ||
    !deviceEmulationReady;
  const autoSimulationHint = autoSimulationDomain
    ? autoSimulationEnabled
      ? t('deviceSimulationAutoEnabledHint', autoSimulationDomain)
      : t('deviceSimulationAutoHint', autoSimulationDomain)
    : t('deviceSimulationAutoUnavailable');

  const fontSizeLabels = [
    t('fontSizeSmall'),
    t('fontSizeDefault'),
    t('fontSizeLarge'),
    t('fontSizeMax'),
  ];

  return (
    <div className="relative flex" onMouseEnter={() => openQuickSettings()} onMouseLeave={handleMouseLeave}>
      <button
        type="button"
        className="relative inline-flex p-0.5 rounded transition-colors cursor-pointer text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:outline focus-visible:outline-blue-500"
        title={t('settings')}
        aria-label={t('settings')}
        aria-expanded={quickSettingsOpen}
        onClick={() => openQuickSettings(true)}
      >
        <Settings size={14} aria-hidden="true" />
        {availableExtensionUpdate && (
          <span
            className="absolute -right-0.5 -top-0.5 h-1 w-1 rounded-full bg-red-500 ring-1 ring-bg-primary"
            data-testid="extension-update-dot"
          />
        )}
      </button>

      <div
        data-quick-settings-open={quickSettingsOpen}
        onMouseEnter={clearCloseTimer}
        className={clsx(
          'absolute top-full pt-1 z-50 w-60',
          quickSettingsOpen ? 'visible pointer-events-auto' : 'invisible pointer-events-none',
          dropdownAlign === 'far-right' ? '-right-2' : 'right-0',
        )}
      >
        <div className="w-full bg-bg-primary border border-border rounded shadow-lg">
          <div className="p-3 space-y-3">
            {availableExtensionUpdate && (
              <div className="rounded border border-red-200 bg-red-50/80 p-2 dark:border-red-900 dark:bg-red-950/30">
                <div className="mb-1.5 text-2xs font-medium text-text-primary">
                  {t('extensionUpdateAvailable', availableExtensionUpdate.version)}
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleExtensionUpdate()}
                    disabled={extensionUpdating}
                    className={clsx(
                      'inline-flex flex-1 items-center justify-center gap-1 rounded bg-blue-600 px-2 py-1 text-2xs text-white transition-colors',
                      extensionUpdating
                        ? 'cursor-not-allowed opacity-60'
                        : 'cursor-pointer hover:bg-blue-700',
                    )}
                  >
                    {extensionUpdating ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="h-3 w-3" aria-hidden="true" />
                    )}
                    {extensionUpdating ? t('extensionUpdating') : t('extensionUpdateNow')}
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenExtensionChangelog}
                    className="inline-flex flex-1 cursor-pointer items-center justify-center gap-1 rounded border border-border bg-bg-primary px-2 py-1 text-2xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    {t('extensionChangelog')}
                  </button>
                </div>
              </div>
            )}

            {/* 语言 */}
            <div>
              <div className="text-2xs text-text-secondary mb-1">{t('language')}</div>
              <div className="flex gap-1">
                <button
                  onClick={() => handleLanguageChange('zh_CN')}
                  className={segBtnClass(config.language === 'zh_CN')}
                >
                  {t('chinese')}
                </button>
                <button
                  onClick={() => handleLanguageChange('en')}
                  className={segBtnClass(config.language === 'en')}
                >
                  {t('english')}
                </button>
              </div>
            </div>

            {/* 字号 */}
            <div>
              <div className="text-2xs text-text-secondary mb-1">{t('fontSize')}</div>
              <div className="flex gap-1">
                {Array.from({ length: totalLevels }, (_, index) => (
                  <button
                    key={index}
                    onClick={() => setLevel(index)}
                    className={segBtnClass(currentLevel === index)}
                  >
                    {fontSizeLabels[index] ?? index + 1}
                  </button>
                ))}
              </div>
            </div>

            {control && (
              <div>
                <div className="text-2xs text-text-secondary mb-1" title={browserUiText(control.definition.description, getCurrentLanguage())}>
                  {browserUiText(control.definition.label, getCurrentLanguage())}
                </div>
                <div className="flex gap-1">
                  {control.definition.options.map(option => (
                    <button
                      key={option.value}
                      onClick={() => handleControlChange(option.value)}
                      aria-pressed={controlValue === option.value}
                      className={segBtnClass(controlValue === option.value)}
                    >
                      {browserUiText(option.label, getCurrentLanguage())}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 设备模拟 */}
            <div>
              <div className="mb-1 flex min-h-5 items-center justify-between">
                <span className="min-w-0 truncate pr-1 text-2xs text-text-secondary">
                  {t('deviceSimulation')}
                </span>
                <div className="flex items-center gap-0.5" data-testid="device-control-actions">
                  {deviceSplitScreenControlsAvailable && (
                    <button
                      type="button"
                      onClick={() => void handleDeviceSplitScreenToggle()}
                      className={iconToggleButtonClass(deviceSplitScreen, deviceEmulationLoading)}
                      title={t('deviceSimulationSplitScreenHint')}
                      aria-label={t('deviceSimulationSplitScreen')}
                      aria-pressed={deviceSplitScreen}
                      disabled={deviceEmulationLoading}
                    >
                      <Columns2
                        className="h-3 w-3"
                        aria-hidden="true"
                        data-testid="device-split-screen-toggle-icon"
                      />
                    </button>
                  )}
                  {devicePresetControlsAvailable && (
                    <button
                      type="button"
                      onClick={handleDeviceOrientationToggle}
                      className={iconToggleButtonClass(
                        deviceOrientation === 'landscape',
                        deviceEmulationLoading,
                      )}
                      title={deviceOrientationAction}
                      aria-label={deviceOrientationAction}
                      aria-pressed={deviceOrientation === 'landscape'}
                      disabled={deviceEmulationLoading}
                    >
                      <TvMinimal
                        className="h-3 w-3"
                        aria-hidden="true"
                        data-testid="device-landscape-toggle-icon"
                      />
                    </button>
                  )}
                  {devicePresetControlsAvailable && !phoneFrame && (
                    <button
                      type="button"
                      onClick={handleDeviceFitToWindowToggle}
                      className={iconToggleButtonClass(
                        deviceFitToWindowActive,
                        deviceEmulationLoading,
                      )}
                      title={t('deviceSimulationFitToWindowHint')}
                      aria-label={t('deviceSimulationFitToWindow')}
                      aria-pressed={deviceFitToWindowActive}
                      disabled={deviceEmulationLoading}
                    >
                      <Scan
                        className="h-3 w-3"
                        aria-hidden="true"
                        data-testid="device-fit-to-window-icon"
                      />
                    </button>
                  )}
                  {deviceEmulationActive && (
                    <button
                      onClick={() => void handleDeviceShellToggle()}
                      className={iconToggleButtonClass(deviceShell, deviceEmulationLoading)}
                      title={t('deviceSimulationShellHint')}
                      aria-label={t('deviceSimulationShell')}
                      aria-pressed={deviceShell}
                      disabled={deviceEmulationLoading}
                    >
                      <Smartphone className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                  {devicePresetControlsAvailable && deviceShell && !deviceSplitScreen && (
                    <button
                      type="button"
                      onClick={() => void handlePhoneFrameToggle()}
                      className={iconToggleButtonClass(phoneFrame, deviceEmulationLoading)}
                      title={t('deviceSimulationPhoneFrameHint')}
                      aria-label={t('deviceSimulationPhoneFrame')}
                      aria-pressed={phoneFrame}
                      disabled={deviceEmulationLoading}
                    >
                      <TabletSmartphone className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                  {appProfile &&
                    appVersion &&
                    (editingVersion ? (
                      <input
                        type="text"
                        value={versionDraft}
                        onChange={event => setVersionDraft(event.target.value)}
                        onBlur={() => void handleVersionSubmit()}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void handleVersionSubmit();
                          if (event.key === 'Escape') setEditingVersion(false);
                        }}
                        autoFocus
                        className="w-16 h-4 px-1 py-0 text-2xs leading-none text-text-primary bg-bg-secondary border border-border rounded outline-none focus:border-blue-500"
                        placeholder={t('appSimulationVersionPlaceholder')}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setVersionDraft(appVersion);
                          setEditingVersion(true);
                        }}
                        className="h-4 text-2xs leading-none text-text-secondary hover:text-blue-500 transition-colors cursor-pointer"
                        title={t('appSimulationVersion')}
                      >
                        v{appVersion}
                      </button>
                    ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1">
                <div className="relative col-span-1 min-w-0" {...appMenuHandlers}>
                  <button
                    ref={appSelectorRef}
                    type="button"
                    onClick={() => {
                      if (hasAppMenu) void handleAppProfileChange(appProfile ? null : selectedAppProfile ?? null);
                      else openProfileInstaller();
                    }}
                    className={clsx(
                      segBtnClass(appProfile !== null),
                      'flex w-full min-w-0 items-center justify-between gap-1',
                    )}
                    aria-pressed={appProfile !== null}
                    aria-haspopup={hasAppMenu ? 'menu' : 'dialog'}
                    disabled={hasAppMenu && (!appProfileReady || appProfileLoading)}
                    title={appProfile ? t('appSimulationCancelHint') : hasAppMenu ? appSelectorLabel : t('appProfileInstallAction')}
                  >
                    <span className="truncate">{appSelectorLabel}</span>
                    {hasAppMenu
                      ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                      : <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />}
                  </button>
                  {hasAppMenu && <div
                    className={clsx(
                      'absolute left-0 top-full z-30 min-w-full pt-1 transition-opacity',
                      openMenu === 'app'
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0',
                    )}
                  >
                    <div
                      className="max-h-[min(14rem,45vh)] min-w-28 overflow-y-auto overscroll-contain rounded border border-border bg-bg-primary p-1 shadow-lg"
                      role="menu"
                      aria-label={t('deviceSimulationApp')}
                    >
                      {visibleProfiles.map(({ id, available }) => {
                        const profile = id as QuickAppProfileName;
                        return (
                          <button
                            key={profile}
                            type="button"
                            onClick={() =>
                              void handleAppProfileChange(appProfile === profile ? null : profile)
                            }
                            className={selectorMenuItemClass(
                              appProfile === profile,
                              !appProfileReady || appProfileLoading,
                            )}
                            role="menuitemradio"
                            aria-checked={appProfile === profile}
                            disabled={!appProfileReady || appProfileLoading || available === false}
                          >
                            {getAppProfileLabel(profile)}
                          </button>
                        );
                      })}
                      {!otherProfilesExpanded && additionalProfiles.length > 0 && (
                        <button
                          type="button"
                          role="menuitem"
                          aria-expanded={false}
                          onClick={() => setOtherProfilesExpanded(true)}
                          className="mt-1 flex w-full cursor-pointer items-center justify-between gap-2 border-t border-border px-1.5 py-1 text-left text-2xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                        >
                          {t('appSimulationShowMore')}
                          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                        </button>
                      )}
                      {visibleProfiles.length > 0 && (
                        <div role="separator" className="mx-1.5 my-0.75 border-t border-border" />
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        aria-haspopup="dialog"
                        onClick={openProfileInstaller}
                        className={clsx(selectorMenuItemClass(false, false), 'gap-1')}
                      >
                        <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {t('appProfileInstallAction')}
                      </button>
                    </div>
                  </div>}
                </div>
                <div className="col-span-2 flex min-w-0 gap-1">
                  <div className="relative min-w-0 flex-1" {...deviceMenuHandlers}>
                    <button
                      type="button"
                      onClick={() =>
                        void handleDevicePresetChange(
                          deviceEmulationActive ? null : lastDevicePresetRef.current,
                        )
                      }
                      className={clsx(
                        segBtnClass(deviceEmulationActive),
                        'flex w-full min-w-0 items-center justify-between gap-1',
                      )}
                      aria-pressed={deviceEmulationActive}
                      aria-haspopup="menu"
                      disabled={deviceEmulationLoading}
                      title={deviceSelectorLabel}
                    >
                      <span className="truncate">{deviceSelectorLabel}</span>
                      <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                    </button>
                    <div
                      className={clsx(
                        'absolute right-0 top-full z-30 min-w-full pt-1 transition-opacity',
                        openMenu === 'device'
                          ? 'pointer-events-auto opacity-100'
                          : 'pointer-events-none opacity-0',
                      )}
                    >
                      <div
                        className="grid w-max max-w-[calc(100vw-1rem)] grid-cols-2 gap-1 rounded border border-border bg-bg-primary p-1 shadow-lg"
                        role="menu"
                        aria-label={t('deviceSimulationMobileDevice')}
                      >
                        <div className="min-w-32 border-r border-border pr-1">
                          <div className="mb-1 border-b border-border pb-1">
                            {renderDevicePresetOption(QUICK_ADAPTIVE_DEVICE_PRESET_NAMES[1])}
                          </div>
                          {QUICK_FIXED_DEVICE_PRESET_NAMES.filter(
                            preset => !preset.startsWith('iphone-') && !preset.startsWith('ipad-'),
                          ).map(renderDevicePresetOption)}
                        </div>
                        <div className="min-w-32 pl-1">
                          <div className="mb-1 border-b border-border pb-1">
                            {renderDevicePresetOption(QUICK_ADAPTIVE_DEVICE_PRESET_NAMES[0])}
                          </div>
                          {QUICK_FIXED_DEVICE_PRESET_NAMES.filter(
                            preset => preset.startsWith('iphone-') || preset.startsWith('ipad-'),
                          ).map(renderDevicePresetOption)}
                        </div>
                      </div>
                    </div>
                  </div>
                  {(hasAppProfiles || autoSimulationEnabled) && <button
                    type="button"
                    onClick={() => void handleAutoSimulationToggle()}
                    className={clsx(
                      iconToggleButtonClass(autoSimulationEnabled, autoSimulationButtonDisabled),
                      'h-6 w-6 self-center border border-border',
                    )}
                    title={autoSimulationHint}
                    aria-label={t('deviceSimulationAuto')}
                    aria-pressed={autoSimulationEnabled}
                    disabled={autoSimulationButtonDisabled}
                  >
                    <Zap className="h-3 w-3" aria-hidden="true" />
                  </button>}
                </div>
              </div>
            </div>

            {configReady && config.agentEnabled && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-text-secondary">{t('agentFloatingButton')}</span>
                <button
                  onClick={handleAgentFloatingButtonToggle}
                  className={switchClass(
                    agentFloatingButtonActive,
                    agentFloatingButtonTransitionReady,
                  )}
                  role="switch"
                  aria-checked={agentFloatingButtonActive}
                  aria-label={t('agentFloatingButton')}
                  disabled={pagePermissionGranted === null}
                >
                  <span
                    className={switchThumbClass(
                      agentFloatingButtonActive,
                      agentFloatingButtonTransitionReady,
                    )}
                  />
                </button>
              </div>
            )}
          </div>

          {/* 更多设置 */}
          <div className="border-t border-border px-3 py-2">
            <button
              onClick={handleShowSettings}
              className="w-full flex items-center justify-between text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <Settings size={13} />
                {t('moreSettings')}
              </span>
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      </div>
      {profileInstallOpen && <ProfileInstallModal onClose={closeProfileInstaller} />}
    </div>
  );
};
