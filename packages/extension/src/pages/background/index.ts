import { handleRequestInspection, inspectBrowserRequest } from './requestInspection';
import {
  AGENT_ACCESS_PREFERENCE,
  AGENT_ACCESS_PROVIDERS,
  readAgentAccess,
} from '../../shared/agentAccess';
import { BROWSER_DOCUMENT_PROBE } from '../../shared/browserCapabilityMessages';
import { cleanupBrowserEnhancements } from './browserEnhancements';
import { cleanupEnvironmentRevisions } from './environmentRevisions';
import { resolveBrowserDocumentSender } from './browserDocuments';
import { initializePresetAutoUpdate } from './presetAutoUpdate';
import { PRESET_MANAGEMENT_ACTION } from '../../shared/presetAutoUpdate';
import { createInstallationService } from './installationService';
import { createNativeInstallationClient } from './nativeInstallationClient';
import { INSTALLATION_ACTION } from '../../shared/installation';
import { handleBrowserTracking } from './browserTracking';
import { initializeBrowserPureCapabilities } from './browserPureCapabilities';
import { handleBrowserUiService, initializeBrowserUiOperations } from './browserUiService';
import { handleExtensionServiceRequest } from './extensionServiceHandler';
import { createToolboxInstallQueue } from './toolboxInstallQueue';
import { TOOLBOX_INSTALL_QUEUE_PORT } from '../../shared/toolboxInstallQueue';
import {
  getAppProfileVariants,
  selectAppProfileVariant,
  setAppProfileSetting,
  setAppProfileRuntimeResponses,
} from './appProfileSettings';
import {
  refreshAppProfileForNavigation,
  removeUnavailableBasicAppProfiles,
} from './appProfileLifecycle';
import { getAppProfileCatalog } from './appProfileCatalog';
import {
  initializeQuickSimulationContextMenu,
  updateQuickSimulationContextMenu,
} from './quickSimulationContextMenu';
import { handleQuickDeviceToolbar } from './quickDeviceToolbar';
import { BROWSER_BUNDLE_ACTION, handleBrowserBundleRequest } from './browserBundleService';
// Background Service Worker for Mearl
// 处理 debugger API 和请求/响应拦截，以及 content-script 的实时消息转发

import { initializePluginPageHost } from './pluginPageHost';
import {
  refreshExternalServiceDefaults,
  updateExternalServicePreferences,
} from './externalServices';
import {
  SERVICE_DEFAULTS_REFRESH_ACTION,
  EXTERNAL_SERVICE_UPDATE_ACTION,
  SERVICE_DEFAULTS_CACHE_KEY,
} from '../../shared/externalServices';
import { openInstallPage } from './installPage';
import {
  clearAccountAutoLoginTab,
  getAccountIdentity,
  initializeAccountTracking,
  accountAutoLoginAvailability,
  startAccountAutoLogin,
  redirectAccountLoginTab,
} from './accountAutoLogin';
import { fetchApiSchema } from './api/requestMetadata';
import { handleBrowserView } from './browserViewService';
import { handleBrowserController, initializeBrowserControllers } from './browserControllers';
import {
  BROWSER_CONTROLLER_HOST_TARGET,
  BROWSER_CONTROLLER_OFFSCREEN_TARGET,
  BROWSER_CONTROLLER_EVENT_TARGET,
} from '../../shared/browserCapabilityMessages';
import { handleBrowserRequestUi } from './browserRequestUiService';
import { initializeBrowserRequestLogins } from './browserRequestLogin';
import {
  BROWSER_REQUEST_UI_ACTION,
  BROWSER_REQUEST_UI_CHANGED,
} from '../../shared/browserRequestUi';
import {
  BROWSER_CAPABILITY_HOST_TARGET,
  BROWSER_CAPABILITY_OFFSCREEN_TARGET,
} from '../../shared/browserCapabilityMessages';
import {
  getExtensionServiceTimeout,
  isExtensionUiServiceAction,
  isCloudConnectorAction,
} from '@mearl/browser-core';
import { isExtensionUiSender } from './extensionMessageTrust';
import { handleStartHeatmap, handleStopHeatmap, reconcileHeatmapService } from './heatmapHandler';
import { sendTabMessageToFrameIdsSafe, sendTabMessageToFramesSafe } from './frameMessaging';
import {
  clearSpmOverlayState,
  isSpmOverlayEnabled,
  restoreSpmOverlayForFrame,
  setSpmOverlayEnabled,
} from './spmOverlayState';
import { scanQrCodeFromImage, scanQrCodeFromElement } from './qrCodeHandler';
import {
  activateContentScriptsForOrigins,
  initializeContentScriptsForOrigins,
  reconcileContentScriptsForOrigins,
} from './contentScriptRegistrar';
import {
  clearActiveElementPickerSession,
  ensureElementPickerMainRuntime,
  ensureElementPickerMainRuntimeForFrames,
  getActiveElementPickerSession,
  getElementPickerPreviewFrameIds,
  restoreElementPickerSessionForFrame,
  selectElementPickerStartupFrames,
  selectInitialElementPickerFrame,
  setActiveElementPickerSession,
} from './elementPickerRuntime';
import { resolveToolboxPageFrame } from './toolboxPageFrame';
import {
  buildDnrDisplayData,
  scheduleDnrNotify,
  recordDnrMatch,
  removeDnrRuleMatch,
  cleanupDnrTab,
  resetDnrTabOnNavigation,
} from './dnrTracker';
import {
  initRedirectRules,
  setResourceRedirect,
  removeResourceRedirect,
  updateConfigRule,
} from './resourceRedirectRules';
import {
  addEnvSwitchCorsRule,
  getSettingsContextTabId,
  initEnvSwitchRules,
  cleanupNetworkControlForTab,
  setSettingsContextTabId,
} from './envSwitchRules';

import {
  BROWSER_CONTROL_GET_ACTION,
  BROWSER_CONTROL_SET_ACTION,
  BROWSER_CONTROL_CLEAR_ACTION,
} from '../../shared/browserControl';
import { handleBrowserControl } from './browserControlService';

import {
  enableModificationForTab,
  disableModificationForTab,
  refreshFetchPatterns,
  setResponseOverride,
  selectAppBridgeResponseOverride,
  removeResponseOverride,
  updateOverrideConditions,
  getOverrides,
  getDebuggerStatus,
  handleAppProfileChildTargetEvent,
  forgetChildDeviceSession,
  handleRequestPaused,
  handleRootWebViewFrameEvent,
  cleanupTab,
  handleDebuggerDetach,
  setGlobalTranslation,
  initDebuggerDevtoolsPorts,
  enableAppProfileDocumentBootstrapForTab,
  setAppProfileNavigationRefresh,
  updateAppProfileMainFrame,
  prepareDeviceShellWebViewEnvironmentForTab,
  restorePhoneFrameSafeAreaForTab,
  resetResponseOverrideCallCounts,
} from './debuggerManager';
import { cleanupTimeForTab, getTimeOverrideForTab } from './pageTimeOverride';
import {
  cleanupTabPageOverrides,
  disableTabPageOverride,
  ensureTabPageOverridesApplied,
  getTabPageOverrides,
  updateTabPageOverrides,
} from './tabPageOverrides';

import { notifyContentScriptUnreachable, resendProtocolRequest, sendTabMessageSafe } from './utils';
import {
  handleSendProtocolRequest,
  handleSendProtocolStreamRequest,
} from './agentHandlers/httpHandlers';
import {
  cleanupClosedTabAppProfile,
  getAppProfileForTab,
  refreshAppProfileActionIconForTab,
} from './utils/appProfileRules';
import { handleSetAppProfile } from './agentHandlers/appProfileHandlers';
import { getAppProfileUserInfo } from './utils/appProfileUserInfo';
import { getPanelIdentity } from './utils/userInfo';
import {
  getQuickDeviceEmulationState,
  getQuickDeviceEmulationStateWithGlobalDefault,
  refreshQuickDeviceFitToWindowForWindow,
  restoreQuickDeviceEmulationForTab,
  setQuickDevicePhoneFrame,
} from './quickDeviceEmulation';
import {
  applyQuickSimulationAutoRuleForTab,
  cleanupQuickSimulationAutoRuleTab,
  getQuickSimulationAutoRuleForTab,
  runQuickSimulationUpdateWithAutoRuleSync,
  setQuickAppSimulationWithAutoRuleSync,
  setQuickDeviceSimulationWithAutoRuleSync,
  setQuickSimulationAutoRuleForTab,
} from './quickSimulationAutoRules';
import { runSerializedQuickSimulationUpdate } from './quickSimulationUpdateQueue';
import { getRememberedQuickAppProfileForTab } from './quickDeviceSimulationState';
import { handleDebuggerSessionEvent } from './debuggerSessionManager';
import { AgentBridge, disconnectedAgentBridgeStatus } from './agentBridge';
import { getExtensionInstallationInfo } from '../../shared/extensionInstallation';
import { requestNativeHostOnce } from './nativeHostRequest';
import { startAppAuthorization, finishAppAuthorization } from './appAuthorization';
import {
  BROWSER_EXTENSION_UPDATE_VERSION_KEY,
  UPDATE_SETUP_EXTENSION_ACTION,
} from '../../shared/extensionUpdate';
import { initOverrideNotifier, notifyPanelOverrideChanged } from './overrideNotifier';
import {
  translateJson,
  getTranslationCache,
  type TranslateProgress,
} from '../panel/utils/translate';
import { saveDevRules, disableDevRule, autoApplyDevRules } from './devRulesService';
import {
  TAB_PAGE_OVERRIDES_GET_ACTION,
  TAB_PAGE_OVERRIDES_SET_ACTION,
} from '../../shared/tabPageOverrides';
import {
  cleanupCollector,
  forgetRequestCollectionWebView,
  flushRequestCollection,
  getCollectorSnapshot,
  recordBackgroundCapturedRequest,
  recordBackgroundProtocolStreamChunk,
  recordBackgroundProtocolStreamEnd,
  recordBackgroundProtocolStreamResponse,
  recordBackgroundProtocolStreamStart,
  setCollectorUpdateListener,
} from './backgroundRequestCollector';
import { DEVICE_PREVIEW_PANEL_STATE_ACTION } from '../../shared/devicePreviewPanel';
import {
  closeDevicePreviewPanel,
  connectDevicePreviewPanel,
  getDevicePreviewPanelToken,
  interruptDevicePreviewPanel,
  navigateDevicePreviewPanel,
  notifyDevicePreviewPanel,
  updateDevicePreviewPanel,
} from './devicePreviewPanel';
import { cleanupControlledTab } from './agentHandlers/controlledTabs';
import { groupAgentNavigationTarget } from './agentHandlers/agentTabGroups';
import { trackEvent } from '../../shared/analytics';
import { clearPageRefsForNavigation, disposePageRefs } from './agentHandlers/pageRefs';
import {
  AGENT_SIDE_PANEL_STATE_CHANGED_ACTION,
  AGENT_SIDE_PANEL_PRESENCE_PORT,
  GET_AGENT_SIDE_PANEL_STATE_ACTION,
  OPEN_AGENT_SIDE_PANEL_FROM_PAGE_ACTION,
  isToggleAgentSidePanelCommand,
  toggleAgentSidePanel,
  writeAgentSidePanelState,
} from '../../shared/agentSidePanelState';
import {
  clearAgentChatComposerPageContext,
  removeAgentChatComposerDraft,
} from '../../shared/agentChatComposerDraftStorage';
import type { ElementPickerPage } from '../content-script/elementCommentTypes';
import {
  QUICK_APP_PROFILE_GET_ACTION,
  QUICK_APP_PROFILE_SET_ACTION,
  QUICK_APP_PROFILE_SET_VERSION_ACTION,
  QUICK_DEVICE_CHROME_GET_ACTION,
  QUICK_DEVICE_EMULATION_CLEAR_ACTION,
  QUICK_DEVICE_EMULATION_GET_ACTION,
  QUICK_DEVICE_EMULATION_SET_ACTION,
  QUICK_DEVICE_PHONE_FRAME_SET_ACTION,
  QUICK_DEVICE_SHELL_SET_ACTION,
  QUICK_DEVICE_SPLIT_SCREEN_SET_ACTION,
  QUICK_SIMULATION_AUTO_RULE_GET_ACTION,
  QUICK_SIMULATION_AUTO_RULE_SET_ACTION,
  getQuickDevicePresetModel,
  getQuickDevicePresetOs,
  isQuickAppProfileName,
  isQuickDeviceOrientation,
  isQuickDevicePresetName,
  isQuickDeviceSelection,
  normalizeQuickDeviceSplitScreen,
} from '../../shared/quickAppProfile';
import {
  detachAgentChatTab,
  getAgentChatTabBindings,
  installAgentChatTabBindingObservers,
  registerAgentChatTab,
} from './agentChatTabBindings';
import { captureAppSimulatorScreenshot } from './appSimulatorScreenshot';
import { deleteQuickDeviceSimulationState } from './quickDeviceSimulationState';
import { cleanupClosedTabDeviceShell, getDeviceShellForTab } from './deviceShellRules';

// ==================== Agent 初始化 ====================

// Agent Bridge 按需创建为单例；配置开启时 background 启动阶段会提前连接。
let agentBridge: AgentBridge | null = null;
let agentServiceEnabled = false;

const assertAgentServiceEnabled = () => {
  if (!agentServiceEnabled) throw new Error('Agent service is disabled');
};

/**
 * 初始化或重置 Agent Bridge。
 *
 * Bridge 是单例，与集成模式无关：它连接到任一已安装的 native-host，后者通过同一个
 * Unix socket 同时服务 MCP 与 Skills 客户端。集成模式仅是 UI 层「看哪份安装引导」的
 * 选择，不影响运行时连接。
 */
function ensureNativeBridge(reset = false): AgentBridge {
  if (!agentBridge) {
    try {
      agentBridge = new AgentBridge(
        devtoolsPorts,
        devtoolsPagePorts,
        () => agentServiceEnabled,
        (data, transport) => installationService.native(data, transport),
        {
          resolve: readAgentAccess,
          changed: enabled => {
            agentServiceEnabled = enabled;
          },
        },
      );
      console.log('[Background] Agent Bridge instance created');
    } catch (error) {
      console.warn('[Background] Agent Bridge creation failed:', error);
      throw error;
    }
  }

  if (reset) {
    agentBridge.reset();
  } else {
    agentBridge.start();
  }

  return agentBridge;
}

function ensureAgentBridge(reset = false): AgentBridge {
  assertAgentServiceEnabled();
  return ensureNativeBridge(reset);
}

// ==================== Agent 自动建联 ====================

// Management connects first; page access remains closed until the policy handshake.
const agentServiceReady = Promise.resolve()
  .then(async () => {
    if (await readAgentAccess()) ensureNativeBridge(false);
  })
  .catch(error => {
    console.warn('[Background] Failed to read Agent service config:', error);
  });

installAgentChatTabBindingObservers(async removed => {
  await agentServiceReady;
  if (!agentServiceEnabled) return;
  try {
    const bridge = ensureAgentBridge(false);
    await bridge
      .requestNativeHost('agent_chat_interrupt', { sessionId: removed.sessionId }, 15_000)
      .catch(() => {});
    await bridge
      .requestNativeHost('agent_chat_close', { sessionId: removed.sessionId }, 15_000)
      .catch(() => {});
  } catch {
    return;
  }
});

// ==================== 菜单和初始化 ====================

initializeAccountTracking();
initializeBrowserRequestLogins();
initializeBrowserControllers();
const installationService = createInstallationService({
  native: createNativeInstallationClient(() => ensureNativeBridge(false)),
});
const checkPresetUpdate = initializePresetAutoUpdate(() => installationService.autoUpdate());
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (message?.action !== INSTALLATION_ACTION) return;
  void installationService.external(message, sender).then(
    data => reply({ success: true, data }),
    error =>
      reply({ success: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
initializeBrowserPureCapabilities();
initializeBrowserUiOperations();
initializeQuickSimulationContextMenu();
void removeUnavailableBasicAppProfiles().catch(error => {
  console.warn('[AppProfile] Failed to remove unavailable UA-only bindings:', error);
});

chrome.runtime.onUpdateAvailable.addListener(details => {
  chrome.storage.local.set({ [BROWSER_EXTENSION_UPDATE_VERSION_KEY]: details.version }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[Background] Failed to persist the available extension update');
    }
  });
});

chrome.runtime.onInstalled.addListener(details => {
  void openInstallPage(details.reason);
  if (details.reason === 'install') {
    void trackEvent('extension_install');
  } else if (details.reason === 'update') {
    chrome.storage.local.remove(BROWSER_EXTENSION_UPDATE_VERSION_KEY, () => {
      void chrome.runtime.lastError;
    });
    void trackEvent('extension_update', {
      previous_version: details.previousVersion ?? 'unknown',
    });
  }

  // Chrome 会为声明了 side_panel 的扩展提供原生开关，这里确保只保留页面功能菜单。
  chrome.contextMenus.remove('openSidePanel', () => {
    void chrome.runtime.lastError;
  });

  chrome.contextMenus.create(
    {
      id: 'scanQrCode',
      title: chrome.i18n.getMessage('scanQrCode'),
      contexts: ['image', 'page'],
    },
    () => {
      if (chrome.runtime.lastError) {
        console.log('[Background] Context menu already exists:', chrome.runtime.lastError.message);
      }
    },
  );
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'scanQrCode' && tab?.id) {
    if (info.srcUrl) {
      scanQrCodeFromImage(info.srcUrl, tab.id);
    } else {
      scanQrCodeFromElement(tab.id);
    }
  }
});

interface SidePanelStateInfo {
  windowId: number;
}

interface SidePanelStateEvent {
  addListener: (listener: (info: SidePanelStateInfo) => void) => void;
}

const sidePanelPresencePorts = new Map<number, Set<chrome.runtime.Port>>();
const sidePanelStateWrites = new Map<number, Promise<void>>();
const lastQueuedSidePanelStates = new Map<number, boolean>();
const openAgentSidePanelWindowIds = new Set<number>();

const broadcastAgentSidePanelState = async (windowId: number, open: boolean) => {
  if (!agentServiceEnabled) return;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    await Promise.all(
      tabs.map(tab => {
        if (typeof tab.id !== 'number') return Promise.resolve();
        return chrome.tabs
          .sendMessage(tab.id, { action: AGENT_SIDE_PANEL_STATE_CHANGED_ACTION, open })
          .catch(() => {});
      }),
    );
  } catch {
    // 页面通知失败不影响侧边栏状态本身。
  }
};

const queueSidePanelStateWrite = (windowId: number, open: boolean) => {
  if (lastQueuedSidePanelStates.get(windowId) === open) return;
  lastQueuedSidePanelStates.set(windowId, open);

  const previous = sidePanelStateWrites.get(windowId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeAgentSidePanelState(windowId, open))
    .then(() => broadcastAgentSidePanelState(windowId, open))
    .catch(error => {
      if (lastQueuedSidePanelStates.get(windowId) === open) {
        lastQueuedSidePanelStates.delete(windowId);
      }
      console.warn('[Background] Failed to persist Agent Side Panel state:', error);
    })
    .finally(() => {
      if (sidePanelStateWrites.get(windowId) === next) sidePanelStateWrites.delete(windowId);
    });
  sidePanelStateWrites.set(windowId, next);
};

const sidePanelApi = chrome.sidePanel as typeof chrome.sidePanel & {
  onOpened?: SidePanelStateEvent;
  onClosed?: SidePanelStateEvent;
};
sidePanelApi.onOpened?.addListener(info => {
  openAgentSidePanelWindowIds.add(info.windowId);
  queueSidePanelStateWrite(info.windowId, true);
});
sidePanelApi.onClosed?.addListener(info => {
  openAgentSidePanelWindowIds.delete(info.windowId);
  queueSidePanelStateWrite(info.windowId, false);
});
const quickDeviceFitRefreshTimers = new Map<number, ReturnType<typeof setTimeout>>();
chrome.windows.onRemoved.addListener(windowId => {
  const fitRefreshTimer = quickDeviceFitRefreshTimers.get(windowId);
  if (fitRefreshTimer) clearTimeout(fitRefreshTimer);
  quickDeviceFitRefreshTimers.delete(windowId);
  sidePanelPresencePorts.delete(windowId);
  openAgentSidePanelWindowIds.delete(windowId);
  queueSidePanelStateWrite(windowId, false);
});

chrome.windows.onBoundsChanged?.addListener(window => {
  if (typeof window.id !== 'number') return;
  const windowId = window.id;
  const pending = quickDeviceFitRefreshTimers.get(windowId);
  if (pending) clearTimeout(pending);
  quickDeviceFitRefreshTimers.set(
    windowId,
    setTimeout(() => {
      quickDeviceFitRefreshTimers.delete(windowId);
      void refreshQuickDeviceFitToWindowForWindow(windowId).catch(error => {
        console.warn('[DeviceEmulation] Failed to refit devices after window resize:', error);
      });
    }, 150),
  );
});

const toggleAgentSidePanelForWindow = async (windowId: number): Promise<boolean> => {
  const open = openAgentSidePanelWindowIds.has(windowId);
  const nextOpen = !open;

  try {
    const operation = toggleAgentSidePanel(windowId, open);
    if (!operation) return open;
    if (open) {
      openAgentSidePanelWindowIds.delete(windowId);
    } else {
      openAgentSidePanelWindowIds.add(windowId);
    }
    await operation;
    queueSidePanelStateWrite(windowId, nextOpen);
    return nextOpen;
  } catch (error) {
    if (open) {
      openAgentSidePanelWindowIds.add(windowId);
    } else {
      openAgentSidePanelWindowIds.delete(windowId);
    }
    console.warn('[Background] Failed to toggle Agent Side Panel:', error);
    throw error;
  }
};

chrome.commands.onCommand.addListener((command, tab) => {
  const windowId = tab?.windowId;
  if (!isToggleAgentSidePanelCommand(command) || typeof windowId !== 'number') return;

  // Chrome 要求 sidePanel.open() 在快捷键事件的同步调用栈内执行，以保留用户手势。
  void toggleAgentSidePanelForWindow(windowId).catch(() => {});
});

setAppProfileNavigationRefresh(refreshAppProfileForNavigation);

// 存储 devtools panel 的连接端口（用于转发实时消息）
const devtoolsPorts = new Map<number, chrome.runtime.Port>();
// 存储 devtools_page 的连接端口（用于 page_inspect 读取 Elements 当前选区）
const devtoolsPagePorts = new Map<number, chrome.runtime.Port>();
const elementPickerStartGenerations = new Map<number, number>();

// ── Panel 实时采集通知 ────────────────────────────────────────────────────────

function postToPanel(tabId: number, message: Record<string, unknown>): void {
  const port = devtoolsPorts.get(tabId);
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // panel 已关闭
  }
}

// 面板按业务文档的跨文档导航分段。设备壳内的根 WebView 由 CDP 上报。
function notifyPanelDocumentCommit(tabId: number, url: string, timestampMs: number): void {
  void navigateDevicePreviewPanel(tabId, timestampMs, url);
  postToPanel(tabId, { action: 'mainFrameCommitted', url, timestampMs });
}

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  notifyPanelDocumentCommit(details.tabId, details.url, details.timeStamp);
});

setCollectorUpdateListener((tabId, update) => {
  updateDevicePreviewPanel(tabId, update);
  postToPanel(tabId, { action: 'collectorUpdate', update });
});

async function activatePanelDebuggerCapture(tabId: number, since: number): Promise<void> {
  postToPanel(tabId, { action: 'requestCaptureSourceChanged', source: 'debugger', since });
  await flushRequestCollection(tabId, { allowDecodeFailure: true });
  if (!getDebuggerStatus(tabId)) return;
  postToPanel(tabId, {
    action: 'collectorSnapshot',
    snapshot: getCollectorSnapshot(tabId),
  });
}

async function enablePanelModification(tabId: number): Promise<void> {
  const since = Date.now();
  await enableModificationForTab(tabId);
  await activatePanelDebuggerCapture(tabId, since);
}

async function setPanelResponseOverride(tabId: number, data: any): Promise<void> {
  const wasActive = getDebuggerStatus(tabId);
  const since = Date.now();
  await setResponseOverride(tabId, data);
  if (!wasActive) await activatePanelDebuggerCapture(tabId, since);
}

function nextElementPickerStartGeneration(tabId: number): number {
  const generation = (elementPickerStartGenerations.get(tabId) ?? 0) + 1;
  elementPickerStartGenerations.set(tabId, generation);
  return generation;
}

// 初始化 Override Notifier（避免循环依赖）
initOverrideNotifier(devtoolsPorts);
// 初始化 debuggerManager 中的 panel 端口引用（用于翻译通知）
initDebuggerDevtoolsPorts(devtoolsPorts);
initializePluginPageHost((action, data) =>
  ensureNativeBridge(false).requestNativeHost(action, data, 120_000),
);

// 从 storage 中读取初始实时翻译设置
chrome.storage.sync.get(['globalTranslation'], result => {
  if (result.globalTranslation && result.globalTranslation !== 'none') {
    setGlobalTranslation(result.globalTranslation);
  }
});

chrome.permissions.onAdded.addListener(permissions => {
  const origins = (permissions.origins ?? []).filter(Boolean);
  if (origins.length === 0) return;
  void activateContentScriptsForOrigins(origins);
});

chrome.permissions.onRemoved.addListener(() => {
  chrome.permissions.getAll(permissions => {
    if (chrome.runtime.lastError) return;
    void reconcileContentScriptsForOrigins((permissions.origins ?? []).filter(Boolean));
  });
});

chrome.permissions.getAll(permissions => {
  if (chrome.runtime.lastError) return;
  const origins = (permissions.origins ?? []).filter(Boolean);
  void initializeContentScriptsForOrigins(origins);
});

// 初始化资源重定向规则（清理遗留规则）
initRedirectRules();

// 初始化全局 SSE 配置，并清理旧版全局环境规则。
void initEnvSwitchRules().catch(error =>
  console.warn('[Protocol] Failed to initialize environment rules:', error),
);

// 监听 storage 变化，实时更新
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    (area === 'local' && (changes[AGENT_ACCESS_PREFERENCE] || changes[AGENT_ACCESS_PROVIDERS])) ||
    (area === 'sync' && changes.agentEnabled)
  ) {
    void (async () => {
      if (agentBridge || (await readAgentAccess()))
        await ensureNativeBridge(false).refreshAgentAccess();
    })().catch(error => console.warn('[Background] Agent access refresh failed:', error));
  }
  if (
    (area === 'sync' && changes.trackingMetadataEnabled) ||
    (area === 'session' && changes[SERVICE_DEFAULTS_CACHE_KEY])
  ) {
    void reconcileHeatmapService().catch(() => {});
  }
  if (area === 'sync') {
    if (changes.sseMonitoringEnabled !== undefined) {
      void updateConfigRule();
    }

    // 与 sessionStorage 内容相关的配置变化时，回写所有已打开 Panel 的 tab
    // （UA 通过 DNR + Server-Timing 传递，不走 sessionStorage）
    if (changes.language !== undefined || changes.sseMonitoringEnabled !== undefined) {
      for (const tabId of devtoolsPorts.keys()) {
        injectConfigToSessionStorage(tabId).catch(() => {});
      }
    }
  }
});

// ==================== 消息监听 ====================

// 监听来自 content-script 的实时消息
const getQuickActiveDeviceContext = (tabId: number) => {
  const state = getQuickDeviceEmulationState(tabId);
  if (!state.active || !state.preset || !isQuickDevicePresetName(state.preset)) return null;
  return {
    preset: state.preset,
    orientation: state.orientation ?? 'portrait',
    os: getQuickDevicePresetOs(state.preset),
    deviceModel: getQuickDevicePresetModel(state.preset),
  };
};

const runWithRestoredQuickDevice = <T>(tabId: number, task: () => Promise<T>): Promise<T> =>
  restoreQuickDeviceEmulationForTab(tabId).then(() =>
    runSerializedQuickSimulationUpdate(tabId, task),
  );

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'quickDeviceSafeAreaChanged') {
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.id !== chrome.runtime.id || sender.frameId !== 0) return;
    void runSerializedQuickSimulationUpdate(tabId, () =>
      restorePhoneFrameSafeAreaForTab(tabId),
    ).then(
      () => sendResponse({ success: true }),
      () => sendResponse({ success: false }),
    );
    return true;
  }
  if (message.action === 'quickDeviceToolbar') {
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.id !== chrome.runtime.id || sender.frameId !== 0) {
      sendResponse({ success: false });
      return;
    }
    void handleQuickDeviceToolbar(tabId, message.operation).then(
      state => sendResponse({ success: true, state }),
      () => sendResponse({ success: false }),
    );
    return true;
  }
  if (message.action === DEVICE_PREVIEW_PANEL_STATE_ACTION) {
    const tabId = sender.tab?.id;
    if (
      tabId === undefined ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      (message.open !== undefined && typeof message.open !== 'boolean')
    ) {
      sendResponse({ success: false });
      return;
    }
    void getDeviceShellForTab(tabId)
      .then(shell => {
        const open = shell?.config.phoneFrame ? message.open : false;
        sendResponse({
          success: true,
          token: getDevicePreviewPanelToken(tabId, open, message.retryCapture === true),
        });
      })
      .catch(() => sendResponse({ success: false }));
    return true;
  }
  if (message.target === BROWSER_DOCUMENT_PROBE) return;
  if (
    message.action === BROWSER_REQUEST_UI_CHANGED ||
    message.target === 'mearl-browser-pure-runtime' ||
    message.target === 'mearl-browser-pure-idle'
  )
    return;
  if (message.action === 'requestInspection') {
    void handleRequestInspection(message.data, sender).then(sendResponse);
    return true;
  }
  if (message.action === 'browserTracking') {
    void handleBrowserTracking(message.data, sender).then(sendResponse);
    return true;
  }
  if (
    message.action === 'browserUiService' ||
    message.action === 'browserView' ||
    message.action === BROWSER_REQUEST_UI_ACTION
  ) {
    const handler =
      message.action === 'browserView'
        ? typeof message.data?.operation === 'string' &&
          message.data.operation.startsWith('controller')
          ? handleBrowserController
          : handleBrowserView
        : message.action === 'browserUiService'
          ? handleBrowserUiService
          : handleBrowserRequestUi;
    const needsOwner =
      message.action === 'browserView' ||
      message.data?.operation === 'loginOpen' ||
      message.data?.operation === 'loginClose';
    const result = needsOwner
      ? resolveBrowserDocumentSender(sender, message.documentToken).then(from =>
          handler(message.data, from),
        )
      : handler(message.data, sender);
    void result.then(sendResponse, error =>
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  }

  if (
    message.target === BROWSER_CAPABILITY_HOST_TARGET ||
    message.target === BROWSER_CAPABILITY_OFFSCREEN_TARGET ||
    message.target === BROWSER_CONTROLLER_HOST_TARGET ||
    message.target === BROWSER_CONTROLLER_OFFSCREEN_TARGET ||
    message.target === BROWSER_CONTROLLER_EVENT_TARGET
  )
    return;
  if (message.action === 'mearlWebsiteInstallation') {
    void installationService.website(message, sender).then(
      data => sendResponse({ success: true, data }),
      error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  }
  if (message.action === INSTALLATION_ACTION) {
    void installationService.internal(message, sender).then(
      data => sendResponse({ success: true, data }),
      error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  }
  if (message.action === PRESET_MANAGEMENT_ACTION) {
    if (!isExtensionUiSender(sender, chrome.runtime.id)) return;
    const manage = async () => {
      switch (message.operation) {
        case 'status':
          return installationService.installedPresets();
        case 'install-url':
          return installationService.presetInstallUrl();
        case 'update':
          return checkPresetUpdate(true);
        case 'uninstall':
          return installationService.uninstallPreset(
            message.browserRevision,
            message.nativeRevision,
          );
        default:
          throw new Error('INVALID_INSTALLATION_REQUEST');
      }
    };
    void manage().then(
      data => sendResponse({ success: true, data }),
      error => sendResponse({ success: false, error: String(error) }),
    );
    return true;
  }
  if (message.action === BROWSER_BUNDLE_ACTION) {
    void handleBrowserBundleRequest(message.data, sender, { extensionId: chrome.runtime.id }).then(
      sendResponse,
    );
    return true;
  }
  if (
    message.action === SERVICE_DEFAULTS_REFRESH_ACTION ||
    message.action === EXTERNAL_SERVICE_UPDATE_ACTION
  ) {
    if (!isExtensionUiSender(sender, chrome.runtime.id)) {
      sendResponse({ success: false, error: 'Service settings require an extension UI' });
      return;
    }
    const operation =
      message.action === SERVICE_DEFAULTS_REFRESH_ACTION
        ? refreshExternalServiceDefaults()
        : updateExternalServicePreferences(message.patch ?? {});
    void operation.then(
      () => sendResponse({ success: true }),
      error => sendResponse({ success: false, error: String(error) }),
    );
    return true;
  }

  if (message.action === 'accountAutoLoginAvailable' || message.action === 'accountAutoLogin') {
    const tabId = sender.tab?.id;
    const pageUrl = sender.url ?? sender.tab?.url ?? '';
    if (typeof tabId !== 'number' || (sender.frameId !== undefined && sender.frameId !== 0)) {
      sendResponse({ success: false, available: false, reason: 'invalid-sender' });
      return true;
    }
    const action =
      message.action === 'accountAutoLoginAvailable'
        ? accountAutoLoginAvailability(tabId, pageUrl)
        : startAccountAutoLogin(tabId, pageUrl);
    void action.then(sendResponse).catch(() => sendResponse({ success: false, available: false }));
    return true;
  }
  if (message.action === 'accountIdentity' || message.action === 'accountRedirect') {
    if (!isExtensionUiSender(sender, chrome.runtime.id)) {
      sendResponse({ success: false, error: 'Extension UI required' });
      return;
    }
    const action =
      message.action === 'accountIdentity'
        ? getAccountIdentity({ cachedOnly: message.cachedOnly === true })
        : (async () => {
            const id =
              typeof message.tabId === 'number'
                ? message.tabId
                : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
            if (typeof id === 'number') await redirectAccountLoginTab(id);
          })();
    void action
      .then(data => sendResponse({ success: true, data }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === 'getDnrIndicatorRules') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ rules: [] });
      return true;
    }
    void buildDnrDisplayData(tabId)
      .then(rules => sendResponse({ rules }))
      .catch(() => sendResponse({ rules: [] }));
    return true;
  }

  if (message.action === UPDATE_SETUP_EXTENSION_ACTION) {
    void (async () => {
      try {
        const installation = await getExtensionInstallationInfo();
        if (!installation.setupManagedPath) {
          throw new Error('The running extension is not managed by Mearl setup');
        }
        const result = (await requestNativeHostOnce(
          'update_setup_extension',
          {
            currentVersion: installation.extensionVersion,
            setupManagedPath: installation.setupManagedPath,
          },
          3 * 60_000,
        )) as { updated?: boolean; version?: string };
        sendResponse({ success: true, ...result });
        if (result.updated) setTimeout(() => chrome.runtime.reload(), 500);
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true;
  }

  if (message.action === QUICK_DEVICE_EMULATION_GET_ACTION) {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'No browser tab found' });
      return true;
    }
    void restoreQuickDeviceEmulationForTab(tabId)
      .then(() => getQuickDeviceEmulationStateWithGlobalDefault(tabId))
      .then(sendResponse)
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === QUICK_SIMULATION_AUTO_RULE_GET_ACTION) {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'No browser tab found' });
      return true;
    }
    void getQuickSimulationAutoRuleForTab(tabId)
      .then(({ domain, rule }) =>
        sendResponse({ success: true, enabled: Boolean(rule), domain, ...(rule ? { rule } : {}) }),
      )
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === QUICK_SIMULATION_AUTO_RULE_SET_ACTION) {
    const tabId = message.tabId;
    const enabled = message.enabled;
    const validInput =
      enabled === false ||
      (enabled === true &&
        isQuickAppProfileName(message.profile) &&
        (message.appVersion === undefined || typeof message.appVersion === 'string') &&
        isQuickDeviceSelection(message.deviceSelection));
    if (
      typeof tabId !== 'number' ||
      !validInput ||
      (message.applyToTab !== undefined && typeof message.applyToTab !== 'boolean')
    ) {
      sendResponse({ success: false, error: 'Invalid automatic simulation request' });
      return true;
    }
    const input = enabled
      ? {
          profile: message.profile,
          ...(message.appVersion ? { appVersion: message.appVersion } : {}),
          deviceSelection: message.deviceSelection,
        }
      : null;
    void setQuickSimulationAutoRuleForTab(tabId, input)
      .then(async rule => {
        if (rule && message.applyToTab === true) {
          await applyQuickSimulationAutoRuleForTab(tabId);
        }
        const current = await getQuickSimulationAutoRuleForTab(tabId);
        sendResponse({
          success: true,
          enabled: Boolean(current.rule),
          domain: current.domain,
          ...(current.rule ? { rule: current.rule } : {}),
        });
      })
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === QUICK_DEVICE_CHROME_GET_ACTION) {
    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, config: null });
      return true;
    }
    void Promise.all([getDeviceShellForTab(tabId), getAppProfileForTab(tabId)])
      .then(([deviceShell, profile]) =>
        sendResponse({
          success: true,
          config: deviceShell?.config ?? null,
          profileSettings: Boolean(profile?.settingsGroup),
        }),
      )
      .catch(() => sendResponse({ success: false, config: null }));
    return true;
  }

  if (message.action === QUICK_DEVICE_EMULATION_SET_ACTION) {
    const tabId = message.tabId;
    const preset = message.preset;
    const orientation = message.orientation ?? 'portrait';
    const fitToWindow = message.fitToWindow ?? true;
    const deviceShell = message.deviceShell ?? true;
    const splitScreen = isQuickDevicePresetName(preset)
      ? normalizeQuickDeviceSplitScreen(message.splitScreen)
      : message.splitScreen;
    if (
      typeof tabId !== 'number' ||
      !isQuickDevicePresetName(preset) ||
      !isQuickDeviceOrientation(orientation) ||
      typeof fitToWindow !== 'boolean' ||
      typeof deviceShell !== 'boolean' ||
      typeof splitScreen !== 'boolean'
    ) {
      sendResponse({ success: false, error: 'Invalid device emulation request' });
      return true;
    }
    const deviceSelection = { preset, orientation, fitToWindow, deviceShell, splitScreen };
    void setQuickDeviceSimulationWithAutoRuleSync({ tabId, deviceSelection })
      .then(sendResponse)
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === QUICK_DEVICE_PHONE_FRAME_SET_ACTION) {
    const { tabId, enabled } = message;
    if (typeof tabId !== 'number' || typeof enabled !== 'boolean') {
      sendResponse({ success: false, error: 'Invalid phone frame request' });
      return true;
    }
    void restoreQuickDeviceEmulationForTab(tabId)
      .then(() => setQuickDevicePhoneFrame(tabId, enabled))
      .then(sendResponse, error => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (message.action === QUICK_DEVICE_SHELL_SET_ACTION) {
    const tabId = message.tabId;
    const deviceShell = message.deviceShell;
    if (typeof tabId !== 'number' || typeof deviceShell !== 'boolean') {
      sendResponse({ success: false, error: 'Invalid device shell request' });
      return true;
    }
    void restoreQuickDeviceEmulationForTab(tabId)
      .then(() => getQuickDeviceEmulationStateWithGlobalDefault(tabId))
      .then(state => {
        if (!state.active || !state.preset) throw new Error('No active device emulation');
        return setQuickDeviceSimulationWithAutoRuleSync({
          tabId,
          deviceSelection: {
            preset: state.preset,
            orientation: state.orientation ?? 'portrait',
            fitToWindow: state.fitToWindow ?? true,
            deviceShell,
            splitScreen: normalizeQuickDeviceSplitScreen(state.splitScreen),
          },
        });
      })
      .then(sendResponse)
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === QUICK_DEVICE_SPLIT_SCREEN_SET_ACTION) {
    const tabId = message.tabId;
    const splitScreen = message.splitScreen;
    if (typeof tabId !== 'number' || typeof splitScreen !== 'boolean') {
      sendResponse({ success: false, error: 'Invalid device split screen request' });
      return true;
    }
    void restoreQuickDeviceEmulationForTab(tabId)
      .then(() => getQuickDeviceEmulationStateWithGlobalDefault(tabId))
      .then(state => {
        if (!state.active || !state.preset) throw new Error('No active device emulation');
        return setQuickDeviceSimulationWithAutoRuleSync({
          tabId,
          deviceSelection: {
            preset: state.preset,
            orientation: state.orientation ?? 'portrait',
            fitToWindow: state.fitToWindow ?? true,
            deviceShell: state.deviceShell ?? true,
            splitScreen,
          },
        });
      })
      .then(sendResponse)
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === QUICK_DEVICE_EMULATION_CLEAR_ACTION) {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'No browser tab found' });
      return true;
    }
    void setQuickDeviceSimulationWithAutoRuleSync({ tabId, deviceSelection: null })
      .then(sendResponse)
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === 'appProfileCatalogGet') {
    void getAppProfileCatalog().then(
      result => {
        updateQuickSimulationContextMenu(
          result.profiles.some(profile => profile.available !== false),
        );
        sendResponse({ success: true, ...result });
      },
      error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  }

  if (message.action === QUICK_APP_PROFILE_GET_ACTION) {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'No browser tab found' });
      return true;
    }
    void (async () => {
      await restoreQuickDeviceEmulationForTab(tabId);
      const config = await getAppProfileForTab(tabId);
      const profile = config?.profile;
      const lastProfile = isQuickAppProfileName(profile)
        ? profile
        : await getRememberedQuickAppProfileForTab(tabId);
      const appVersion =
        config?.binding?.options.appVersion ?? config?.globals?.['__APP_VERSION__'] ?? null;
      const device = getQuickActiveDeviceContext(tabId);
      return {
        success: true,
        profile: isQuickAppProfileName(profile) ? profile : null,
        ...(lastProfile ? { lastProfile } : {}),
        appVersion,
        os: config ? (config.platform === 'Android' ? 'android' : 'ios') : device?.os,
      };
    })()
      .then(sendResponse)
      .catch(error => {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message.action === QUICK_APP_PROFILE_SET_ACTION) {
    const tabId = message.tabId;
    const profile = message.profile;
    const deviceSelection = message.deviceSelection;
    const validDeviceSelection =
      deviceSelection === undefined || isQuickDeviceSelection(deviceSelection);
    if (
      typeof tabId !== 'number' ||
      (profile !== null && !isQuickAppProfileName(profile)) ||
      !validDeviceSelection
    ) {
      sendResponse({ success: false, error: 'Invalid App profile request' });
      return true;
    }
    void setQuickAppSimulationWithAutoRuleSync({
      tabId,
      profile,
      ...(message.appVersion ? { appVersion: message.appVersion } : {}),
      ...(deviceSelection ? { deviceSelection } : {}),
    })
      .then(sendResponse)
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === QUICK_APP_PROFILE_SET_VERSION_ACTION) {
    const tabId = message.tabId;
    const appVersion = message.appVersion;
    if (typeof tabId !== 'number' || typeof appVersion !== 'string') {
      sendResponse({ success: false, error: 'Invalid version request' });
      return true;
    }
    void runWithRestoredQuickDevice(tabId, async () => {
      const config = await getAppProfileForTab(tabId);
      const profile = config?.profile;
      if (!profile || !isQuickAppProfileName(profile)) {
        return { success: false, error: 'No active app profile' };
      }
      return runQuickSimulationUpdateWithAutoRuleSync(
        tabId,
        current => ({
          profile: current.profile,
          appVersion,
          deviceSelection: current.deviceSelection,
        }),
        async () => {
          await handleSetAppProfile(
            {
              tabId,
              enabled: true,
              profile,
              appVersion,
              os: config.platform === 'Android' ? 'android' : 'ios',
              deviceModel: config.binding?.options.deviceModel ?? config.globals.__DEVICE_MODEL__,
            },
            () => null,
            { current: config },
          );
          return {
            success: true,
            profile,
            appVersion,
            os: config.platform === 'Android' ? 'android' : 'ios',
          };
        },
      );
    })
      .then(sendResponse)
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === 'getAgentChatTabBindings') {
    void getAgentChatTabBindings()
      .then(data => sendResponse({ success: true, data }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === 'registerAgentChatTab') {
    void registerAgentChatTab(
      message.data?.ownerTabId,
      message.data?.tabId,
      message.data?.sessionId,
    )
      .then(data => sendResponse({ success: true, data }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === 'detachAgentChatTab') {
    void detachAgentChatTab(message.data?.tabId)
      .then(data => sendResponse({ success: true, data }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.action === GET_AGENT_SIDE_PANEL_STATE_ACTION) {
    const windowId = sender.tab?.windowId;
    sendResponse({
      success: typeof windowId === 'number',
      open: typeof windowId === 'number' && openAgentSidePanelWindowIds.has(windowId),
    });
    return true;
  }

  if (message.action === OPEN_AGENT_SIDE_PANEL_FROM_PAGE_ACTION) {
    const windowId = sender.tab?.windowId;
    if (typeof windowId !== 'number') {
      sendResponse({ success: false, open: false, error: 'No browser window found' });
      return true;
    }

    if (openAgentSidePanelWindowIds.has(windowId)) {
      sendResponse({ success: true, open: true });
      return true;
    }

    // Chrome 要求 sidePanel.open() 在页面点击对应的消息调用栈内执行，以保留用户手势。
    void toggleAgentSidePanelForWindow(windowId)
      .then(() => sendResponse({ success: true, open: true }))
      .catch(error =>
        sendResponse({
          success: false,
          open: openAgentSidePanelWindowIds.has(windowId),
          error: String(error),
        }),
      );
    return true;
  }

  // 处理 getCurrentTab 请求（来自 content-script）
  if (message.action === 'getCurrentTab') {
    sendResponse({ tabId: sender.tab?.id });
    return true;
  }

  if (message.action === 'appBridgePrepareWebView') {
    const senderTabId = sender.tab?.id;
    if (senderTabId === undefined || sender.frameId !== 0) {
      sendResponse({ success: false, error: 'app profile is not active for this tab' });
      return true;
    }
    void Promise.all([getAppProfileForTab(senderTabId), getDeviceShellForTab(senderTabId)])
      .then(([config, deviceShell]) => {
        if (!config) throw new Error('app profile is not active for this tab');
        if (!deviceShell) throw new Error('device shell is not active for this tab');
        return enableAppProfileDocumentBootstrapForTab(senderTabId, config).then(() =>
          prepareDeviceShellWebViewEnvironmentForTab(senderTabId, deviceShell.emulation, config, {
            splitScreen: deviceShell.splitScreen,
          }),
        );
      })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (message.action === 'appBridgeScreenshot') {
    const senderTabId = sender.tab?.id;
    if (senderTabId === undefined || sender.frameId !== 0) {
      sendResponse({ success: false, error: 'app profile is not active for this tab' });
      return true;
    }
    void captureAppSimulatorScreenshot(senderTabId)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (
    message.action === 'appBridgeAuthCodeStart' ||
    message.action === 'appBridgeAuthCodeWait' ||
    message.action === 'appBridgeAuthCodeClose'
  ) {
    const senderTabId = sender.tab?.id;
    if (senderTabId === undefined) {
      sendResponse({ success: false, error: 'app profile is not active for this tab' });
      return true;
    }
    void (async () => {
      const operation =
        message.action === 'appBridgeAuthCodeStart'
          ? 'start'
          : message.action === 'appBridgeAuthCodeWait'
            ? 'wait'
            : 'close';
      const owner = { tabId: senderTabId, frameId: sender.frameId, documentId: sender.documentId };
      const progress =
        operation === 'close'
          ? undefined
          : (value: unknown) => {
              const phase = (value as { phase?: unknown } | null)?.phase;
              if (!['installing', 'connected', 'authorizing'].includes(String(phase))) return;
              void sendTabMessageSafe(
                senderTabId,
                { action: 'appBridgeAuthCodeProgress', requestId: message.requestId, phase },
                { frameId: sender.frameId, documentId: sender.documentId },
              );
            };
      let result;
      if (operation === 'start') {
        const config = await getAppProfileForTab(senderTabId);
        const authorization = config?.binding?.definition.authorization;
        if (!authorization || config!.actions.behaviors?.[authorization.method] !== 'authCode')
          throw new Error('Authorization is not enabled for this App profile');
        result = await startAppAuthorization(owner, authorization.hook, message.params, progress);
      } else
        result = await finishAppAuthorization(
          operation,
          owner,
          String(message.browserId ?? ''),
          message.params,
          progress,
        );
      sendResponse({
        success: true,
        ...(result as Record<string, unknown>),
        ...(operation === 'wait' ? { response: result } : {}),
      });
    })().catch(error =>
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  }

  if (message.action === 'appBridgeProfileVariants') {
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.id !== chrome.runtime.id || sender.frameId !== 0) {
      sendResponse({ success: false });
      return true;
    }
    void (async () => {
      if (message.profile !== undefined || message.next !== undefined) {
        if (typeof message.profile !== 'string' || typeof message.next !== 'string') {
          throw new Error('Invalid app profile variant');
        }
        await selectAppProfileVariant(tabId, message.profile, message.next);
        return { success: true };
      }
      const profile = await getAppProfileForTab(tabId);
      const variants = profile ? await getAppProfileVariants(tabId, profile.profile) : [];
      return {
        success: true,
        profile: profile?.profile,
        variants,
        actions: profile?.actions,
        language: profile?.language,
        settings: profile?.settings,
      };
    })().then(sendResponse, () => sendResponse({ success: false }));
    return true;
  }

  if (message.action === 'appBridgeSetSetting') {
    const tabId = sender.tab?.id;
    if (
      tabId === undefined ||
      sender.frameId !== 0 ||
      typeof message.profile !== 'string' ||
      typeof message.settingId !== 'string'
    ) {
      sendResponse({ success: false, error: 'Invalid app profile setting update' });
      return true;
    }
    void setAppProfileSetting(tabId, message.profile, message.settingId, message.value)
      .then(sendResponse)
      .catch(error => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (message.action === 'appBridgeUpdateResponses') {
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.frameId !== 0 || typeof message.profile !== 'string') {
      sendResponse({ success: false, error: 'Invalid App response update' });
      return true;
    }
    void setAppProfileRuntimeResponses(tabId, message.profile, message.responses)
      .then(sendResponse)
      .catch(error => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  // App 容器模拟：页面内需要扩展权限的桥调用由 content-script 中转到后台。
  // 这些能力会使用用户 Cookie，只受理「当前确实处于容器模拟态」的 tab：
  // DNR 登记表是容器模拟的权威开关，未登记的页面（含普通页面里的第三方 iframe）一律拒绝。
  if (message.action === 'appBridgeProtocol') {
    const senderTabId = sender.tab?.id;
    if (senderTabId === undefined) {
      sendResponse({ success: false, error: 'app profile is not active for this tab' });
      return true;
    }
    const payload = message.payload || {};
    const startTime = Date.now();
    const api = typeof payload.api === 'string' && payload.api ? payload.api : 'unknown';
    let requestMetadata: { namespace?: string; environment?: string } | undefined;
    void getAppProfileForTab(senderTabId)
      .then(config => {
        if (!config) throw new Error('app profile is not active for this tab');
        return handleSendProtocolRequest(
          payload,
          config.hostCapabilities,
          prepared => {
            requestMetadata = prepared.metadata;
          },
          request => selectAppBridgeResponseOverride(senderTabId, api, request),
        );
      })
      .then(result => {
        recordBackgroundCapturedRequest(senderTabId, {
          namespace: requestMetadata?.namespace,
          environment: requestMetadata?.environment,
          api,
          requestData: result.requestData ?? payload.data,
          response: result.response,
          success: result.success,
          duration: Date.now() - startTime,
          timestampMs: startTime,
        });
        sendResponse(result);
      })
      .catch(err => {
        const error = String(err);
        recordBackgroundCapturedRequest(senderTabId, {
          namespace: requestMetadata?.namespace,
          environment: requestMetadata?.environment,
          api,
          requestData: payload.data,
          success: false,
          duration: Date.now() - startTime,
          timestampMs: startTime,
          error,
        });
        sendResponse({ success: false, error });
      });
    return true;
  }

  if (message.action === 'appBridgeUserInfo') {
    const senderTabId = sender.tab?.id;
    if (senderTabId === undefined) {
      sendResponse({ success: false, error: 'app profile is not active for this tab' });
      return true;
    }
    void getAppProfileForTab(senderTabId)
      .then(config => {
        if (config?.actions.behaviors?.user_info !== 'userInfo') {
          throw new Error('user_info is not enabled for this app profile');
        }
        return getAppProfileUserInfo(sender.url || sender.tab?.url || '', config.hostCapabilities);
      })
      .then(response => sendResponse({ success: true, response }))
      .catch(error => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (message.action === 'appBridgeProtocolStream') {
    const senderTabId = sender.tab?.id;
    if (senderTabId === undefined) {
      sendResponse({ success: false, error: 'app profile is not active for this tab' });
      return true;
    }
    const streamPayload = message.payload || {};
    const frameId = sender.frameId;
    const sendStreamEvent = (eventType: 'onReceive' | 'onFinish' | 'onError', data: unknown) =>
      sendTabMessageSafe(
        senderTabId,
        {
          action: 'appBridgeProtocolStreamEvent',
          requestId: message.requestId,
          eventType,
          data,
        },
        { frameId, documentId: sender.documentId },
      );
    let streamEventQueue: Promise<unknown> = Promise.resolve();
    const enqueueStreamEvent = (eventType: 'onReceive' | 'onFinish' | 'onError', data: unknown) => {
      streamEventQueue = streamEventQueue.then(() => sendStreamEvent(eventType, data));
      return streamEventQueue;
    };
    const panelRequestId = `proxy-stream-${Date.now()}-${message.requestId}`;
    const streamStartTime = Date.now();
    let panelRequestStarted = false;
    let panelRequestMethod = ((streamPayload.method as string) || 'POST').toUpperCase();
    const recordStreamStart = (
      requestHeaders?: Array<{ name: string; value: string }>,
      method?: string,
      url?: string,
      metadata?: { namespace?: string; environment?: string },
    ) => {
      if (panelRequestStarted) return;
      panelRequestStarted = true;
      panelRequestMethod = method ?? panelRequestMethod;
      recordBackgroundProtocolStreamStart(senderTabId, {
        namespace: metadata?.namespace,
        environment: metadata?.environment,
        streamId: panelRequestId,
        api:
          typeof streamPayload.api === 'string' && streamPayload.api
            ? streamPayload.api
            : 'unknown',
        url,
        method: panelRequestMethod,
        requestHeaders: requestHeaders ?? [],
        requestData: streamPayload.data,
        timestampMs: streamStartTime,
      });
    };
    const recordStreamResponse = (response: {
      status: number;
      statusText: string;
      responseHeaders: Array<{ name: string; value: string }>;
    }) => {
      recordStreamStart();
      recordBackgroundProtocolStreamResponse(senderTabId, panelRequestId, response);
    };
    void (async () => {
      try {
        const config = await getAppProfileForTab(senderTabId);
        if (!config) throw new Error('app profile is not active for this tab');
        const result = await handleSendProtocolStreamRequest(
          streamPayload,
          data => {
            void enqueueStreamEvent('onReceive', data);
            recordBackgroundProtocolStreamChunk(senderTabId, panelRequestId, data);
          },
          metadata =>
            recordStreamStart(
              metadata.requestHeaders,
              metadata.method,
              metadata.url,
              metadata.metadata,
            ),
          recordStreamResponse,
          config.hostCapabilities,
        );
        await enqueueStreamEvent('onFinish', result.response);
        recordBackgroundProtocolStreamEnd(senderTabId, panelRequestId);
        sendResponse({ success: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordStreamStart();
        await enqueueStreamEvent('onError', {
          error: reason,
        });
        recordBackgroundProtocolStreamEnd(senderTabId, panelRequestId, { error: reason });
        sendResponse({ success: false, error: reason });
      }
    })();
    return true;
  }

  if (
    [BROWSER_CONTROL_GET_ACTION, BROWSER_CONTROL_SET_ACTION, BROWSER_CONTROL_CLEAR_ACTION].includes(
      message.action,
    )
  ) {
    void handleBrowserControl(message, sender).then(result => {
      if (result.success && message.action !== BROWSER_CONTROL_GET_ACTION)
        scheduleDnrNotify(message.tabId);
      sendResponse(result);
    });
    return true;
  }

  // origin 与 tabId 均取自发送方，跨域 iframe 不能为其他 tab 建立规则。
  if (
    message.action === 'networkControlReportOrigin' ||
    message.action === 'envSwitchReportOrigin'
  ) {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number' && sender.url) {
      void addEnvSwitchCorsRule(tabId, sender.url).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'getPageTimeOverride') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ offsetMs: null });
      return true;
    }
    getTimeOverrideForTab(tabId)
      .then(override => sendResponse(override ?? { offsetMs: null, revision: 0 }))
      .catch(() => sendResponse({ offsetMs: null, revision: 0 }));
    return true;
  }

  // 设置页上报当前页面，恢复该 tab 的页面覆盖。
  if (message.action === 'settingsSetContextTab') {
    void (async () => {
      try {
        const previousTabId = await getSettingsContextTabId();
        const nextTabId = typeof message.tabId === 'number' ? message.tabId : null;
        await setSettingsContextTabId(nextTabId);
        if (nextTabId !== null) await ensureTabPageOverridesApplied(nextTabId);
        if (previousTabId !== null && previousTabId !== nextTabId) scheduleDnrNotify(previousTabId);
        if (nextTabId !== null) scheduleDnrNotify(nextTabId);
        sendResponse({ ok: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('[Background] Failed to select settings context tab:', error);
        sendResponse({ ok: false, error: reason });
      }
    })();
    return true;
  }

  if (message.action === TAB_PAGE_OVERRIDES_GET_ACTION) {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'No browser tab found' });
      return true;
    }
    getTabPageOverrides(tabId)
      .then(overrides => sendResponse({ success: true, overrides }))
      .catch(error => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (message.action === TAB_PAGE_OVERRIDES_SET_ACTION) {
    const tabId = message.tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'No browser tab found' });
      return true;
    }
    updateTabPageOverrides(tabId, message.patch)
      .then(overrides => {
        scheduleDnrNotify(tabId);
        sendResponse({ success: true, overrides });
      })
      .catch(error => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (message.action === 'panel_user_info_get') {
    getPanelIdentity()
      .then(userId => sendResponse({ userId }))
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  if (message.action === 'saveDevRules') {
    if (!isExtensionUiSender(sender, chrome.runtime.id)) {
      sendResponse({ success: false, error: 'Extension UI required' });
      return;
    }
    void saveDevRules(message.forms, message.enabled).then(sendResponse);
    return true;
  }

  // 从 tooltip 关闭（禁用）一条 dev 规则
  if (message.action === 'disableDnrRule') {
    const ruleId: number = message.ruleId;
    const senderTabId = sender.tab?.id;
    disableDevRule(ruleId)
      .then(() => {
        if (senderTabId !== undefined) {
          removeDnrRuleMatch(senderTabId, ruleId);
          scheduleDnrNotify(senderTabId);
        }
        sendResponse({ success: true });
      })
      .catch(err => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.action === 'disableDnrOverride') {
    const senderTabId = sender.tab?.id;
    if (senderTabId === undefined) {
      sendResponse({ success: false, error: 'No browser tab found' });
      return true;
    }
    disableTabPageOverride(senderTabId, message.override)
      .then(() => {
        scheduleDnrNotify(senderTabId);
        sendResponse({ success: true });
      })
      .catch(err => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.action === 'autoApplyDevRules') {
    const tabUrl: string = message.url || sender.tab?.url || '';
    if (tabUrl)
      void autoApplyDevRules(tabUrl).catch(error =>
        console.warn('[Background] autoApplyDevRules failed:', error),
      );
    return;
  }

  // 处理来自 content-script 的 SSE 和 Fetch 消息
  if (sender.tab && message.source === 'mearl-content-script') {
    const tabId = sender.tab.id;
    if (tabId) {
      if (message.type === 'ELEMENT_PICKER_FRAME_READY') {
        void restoreElementPickerSessionForFrame(tabId, sender.frameId ?? 0);
        return;
      }
      if (message.type === 'FRAME_VISUAL_RUNTIME_READY') {
        void restoreSpmOverlayForFrame(tabId, sender.frameId ?? 0);
        return;
      }
      if (message.type === 'ELEMENT_PICKER_PAUSED') {
        void sendTabMessageToFramesSafe(tabId, { action: 'pauseElementPicker' });
        return;
      }
      if (message.type === 'ELEMENT_PICKER_RESUMED') {
        void sendTabMessageToFramesSafe(tabId, { action: 'resumeElementPicker' });
        return;
      }
      if (
        message.type === 'ELEMENT_PICKER_FRAME_ACTIVE' &&
        typeof message.frameToken === 'string'
      ) {
        void sendTabMessageToFramesSafe(tabId, {
          action: 'setElementPickerFrameActive',
          frameToken: message.frameToken,
        });
        return;
      }
      if (
        message.type === 'ELEMENT_PICKED' ||
        message.type === 'ELEMENT_PICK_CANCELLED' ||
        message.type === 'TRACE_RESULT'
      ) {
        clearActiveElementPickerSession(tabId);
        void sendTabMessageToFramesSafe(tabId, { action: 'stopElementPicker' });
      }
      if (
        message.type === 'ELEMENT_COMMENT_CONFIRMED' &&
        getActiveElementPickerSession(tabId)?.commentMode &&
        getActiveElementPickerSession(tabId)?.continuousCommentMode === false
      ) {
        clearActiveElementPickerSession(tabId);
      }
      // 转发给对应 tab 的 devtools panel
      if (typeof message.type === 'string' && message.type.startsWith('SSE_')) {
        notifyDevicePreviewPanel(tabId, { ...message, frameId: sender.frameId });
      }
      const port = devtoolsPorts.get(tabId);
      if (port) {
        try {
          port.postMessage({ ...message, frameId: sender.frameId });
        } catch {
          // 忽略错误：devtools 可能已关闭
        }
      }
    }
    return;
  }

  // 处理来自 devtools panel 的消息
  const tabId = message.tabId;
  if (isExtensionUiServiceAction(message.action)) {
    void handleExtensionServiceRequest(message, sender, {
      extensionId: chrome.runtime.id,
      ready: agentServiceReady,
      request: (action, data, timeoutMs) => {
        const agentBridgeRequired =
          action.startsWith('agent_chat_') || isCloudConnectorAction(action);
        const bridge = agentBridgeRequired ? ensureAgentBridge(false) : ensureNativeBridge(false);
        return bridge.requestNativeHost(action, data, timeoutMs);
      },
    }).then(sendResponse);
    return true;
  }

  if (message.action === 'agentQueryResponse' && agentBridge) {
    agentBridge.resolveQuery(message.correlationId, message.data);
    return true;
  }

  // 处理 Agent Bridge 初始化请求（来自 panel）
  if (message.action === 'initAgentBridge') {
    void agentServiceReady.then(() => {
      try {
        ensureAgentBridge(false);
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return true;
  }

  // 处理 Agent Bridge 重置请求（来自 panel）
  if (message.action === 'resetAgentBridge') {
    void agentServiceReady.then(() => {
      try {
        ensureNativeBridge(true);
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return true;
  }

  // 处理 Agent Bridge 禁用请求（来自 panel）
  if (message.action === 'disableAgentBridge') {
    if (agentBridge) {
      agentBridge.destroy();
      agentBridge = null;
    }

    chrome.runtime
      .sendMessage({
        action: 'agentStatusChanged',
        status: disconnectedAgentBridgeStatus(),
      })
      .catch(() => {
        // 忽略没有接收者的错误
      });

    sendResponse({ success: true });
    return true;
  }

  // 获取 Agent 状态
  if (message.action === 'getAgentStatus') {
    if (agentBridge) {
      sendResponse({ success: true, status: agentBridge.getStatus() });
    } else {
      sendResponse({
        success: true,
        status: disconnectedAgentBridgeStatus(),
      });
    }
    return true;
  }

  // 处理来自 devtools panel 的消息（tabId 已在上方声明）

  if (message.action === 'enableModification') {
    enablePanelModification(tabId)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'disableModification') {
    disableModificationForTab(tabId)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'refreshFetchPatterns') {
    refreshFetchPatterns(tabId, Boolean(message.includeGeneric))
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'setResponseOverride') {
    setPanelResponseOverride(tabId, message.data)
      .then(() => {
        notifyPanelOverrideChanged(tabId);
        sendResponse({ success: true, id: message.data.id });
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'removeResponseOverride') {
    removeResponseOverride(tabId, message.apiName, message.id);
    notifyPanelOverrideChanged(tabId);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'updateOverrideConditions') {
    updateOverrideConditions(
      tabId,
      message.apiName,
      message.id,
      message.conditions,
      message.responseData,
    );
    notifyPanelOverrideChanged(tabId);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'getOverrides') {
    const overrides = getOverrides(tabId);
    if (typeof message.url === 'string') {
      void inspectBrowserRequest({ url: message.url, body: message.requestBody })
        .then(metadata => {
          sendResponse({ overrides, apiName: metadata?.apiName ?? null });
        })
        .catch(error =>
          sendResponse({ error: error instanceof Error ? error.message : String(error) }),
        );
    } else sendResponse({ overrides });
    return true;
  }

  if (message.action === 'getDebuggerStatus') {
    const debuggerAttached = getDebuggerStatus(tabId);
    sendResponse({ debuggerAttached });
    return true;
  }

  if (message.action === 'setResourceRedirect') {
    setResourceRedirect(message.sourceUrl, message.redirectUrl)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'removeResourceRedirect') {
    removeResourceRedirect(message.sourceUrl)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'resendProtocolRequest') {
    resendProtocolRequest(tabId, message.data)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'startElementPicker') {
    const generation = nextElementPickerStartGeneration(tabId);
    clearActiveElementPickerSession(tabId);
    void (async () => {
      if (elementPickerStartGenerations.get(tabId) !== generation) {
        sendResponse({ success: false, cancelled: true });
        return;
      }
      type PickerPing = {
        success?: boolean;
        frameToken?: string;
        page?: ElementPickerPage;
      };
      const inPreview = (await getDeviceShellForTab(tabId))?.config.phoneFrame !== undefined;
      const previewRootFrameId = inPreview ? await resolveToolboxPageFrame(tabId) : undefined;
      if (inPreview && !previewRootFrameId) throw new Error('Business WebView is not ready');
      const ping = { action: 'pingElementPickerRuntime' };
      const pickerFrames = previewRootFrameId
        ? await sendTabMessageToFrameIdsSafe<PickerPing>(
            tabId,
            await getElementPickerPreviewFrameIds(tabId, previewRootFrameId),
            ping,
          )
        : await sendTabMessageToFramesSafe<PickerPing>(tabId, ping, { notifyOnUnreachable: true });
      if (elementPickerStartGenerations.get(tabId) !== generation) {
        sendResponse({ success: false, cancelled: true });
        return;
      }
      const pickerFrameIds = pickerFrames
        .filter(result => result.response.success === true)
        .map(result => result.frameId);
      if (pickerFrameIds.length === 0) {
        notifyContentScriptUnreachable(tabId);
        sendResponse({ success: false });
        return;
      }
      const topFramePage = pickerFrames.find(result => result.frameId === (previewRootFrameId ?? 0))
        ?.response.page;
      const tabPage = await chrome.tabs
        .get(tabId)
        .then(tab =>
          tab.url
            ? ({
                url: tab.url,
                title: tab.title ?? '',
              } satisfies ElementPickerPage)
            : undefined,
        )
        .catch(() => undefined);
      const session = {
        traceMode: !!message.traceMode,
        commentMode: !!message.commentMode,
        ...(message.continuousCommentMode !== undefined
          ? { continuousCommentMode: !!message.continuousCommentMode }
          : {}),
        commentLabels: message.commentLabels,
        topPage: topFramePage ?? tabPage,
        previewRootFrameId,
      };
      if (elementPickerStartGenerations.get(tabId) !== generation) {
        sendResponse({ success: false, cancelled: true });
        return;
      }
      setActiveElementPickerSession(tabId, session);
      const appProfileActive = Boolean(await getAppProfileForTab(tabId));
      const startupFrameIds = previewRootFrameId
        ? pickerFrameIds
        : selectElementPickerStartupFrames(pickerFrameIds, !!message.traceMode, appProfileActive);
      const targetFrameIds = message.traceMode
        ? await ensureElementPickerMainRuntimeForFrames(tabId, startupFrameIds)
        : startupFrameIds;
      if (targetFrameIds.length === 0) {
        if (elementPickerStartGenerations.get(tabId) === generation) {
          clearActiveElementPickerSession(tabId);
          notifyContentScriptUnreachable(tabId);
          sendResponse({ success: false });
        } else {
          sendResponse({ success: false, cancelled: true });
        }
        return;
      }
      if (elementPickerStartGenerations.get(tabId) !== generation) {
        sendResponse({ success: false, cancelled: true });
        return;
      }
      const frameResponses = await sendTabMessageToFrameIdsSafe<{ success?: boolean }>(
        tabId,
        targetFrameIds,
        {
          action: 'startElementPicker',
          ...session,
        },
        { notifyOnUnreachable: true },
      );
      if (elementPickerStartGenerations.get(tabId) !== generation) {
        sendResponse({ success: false, cancelled: true });
        return;
      }
      const startedFrameIds = frameResponses
        .filter(result => result.response.success === true)
        .map(result => result.frameId);
      if (startedFrameIds.length === 0) {
        clearActiveElementPickerSession(tabId);
        sendResponse({ success: false });
        return;
      }
      const initialActiveFrameId = startedFrameIds.includes(previewRootFrameId ?? -1)
        ? previewRootFrameId
        : selectInitialElementPickerFrame(startedFrameIds, appProfileActive);
      const initialFrameToken = pickerFrames.find(result => result.frameId === initialActiveFrameId)
        ?.response.frameToken;
      if (initialFrameToken) {
        await sendTabMessageToFrameIdsSafe(tabId, startedFrameIds, {
          action: 'setElementPickerFrameActive',
          frameToken: initialFrameToken,
        });
      }
      sendResponse({ success: true, frameIds: startedFrameIds });
    })().catch(error => {
      if (elementPickerStartGenerations.get(tabId) === generation)
        clearActiveElementPickerSession(tabId);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  if (message.action === 'cancelElementPicker') {
    nextElementPickerStartGeneration(tabId);
    clearActiveElementPickerSession(tabId);
    sendTabMessageToFramesSafe(tabId, { action: 'stopElementPicker' }).then(responses =>
      sendResponse({ success: true, frameIds: responses.map(result => result.frameId) }),
    );
    return true;
  }

  if (message.action === 'editElementComment') {
    sendTabMessageToFramesSafe(tabId, {
      action: 'editElementComment',
      commentId: message.commentId,
    }).then(responses =>
      sendResponse({ success: true, frameIds: responses.map(result => result.frameId) }),
    );
    return true;
  }

  if (message.action === 'removeElementCommentMarker') {
    sendTabMessageToFramesSafe(tabId, {
      action: 'removeElementCommentMarker',
      commentId: message.commentId,
    }).then(responses =>
      sendResponse({ success: true, frameIds: responses.map(result => result.frameId) }),
    );
    return true;
  }

  if (message.action === 'clearElementCommentMarkers') {
    sendTabMessageToFramesSafe(tabId, { action: 'clearElementCommentMarkers' }).then(responses =>
      sendResponse({ success: true, frameIds: responses.map(result => result.frameId) }),
    );
    return true;
  }

  if (message.action === 'traceHighlightField') {
    void (async () => {
      if (!(await ensureElementPickerMainRuntime(tabId))) {
        notifyContentScriptUnreachable(tabId);
        sendResponse({ count: 0 });
        return;
      }
      const response = await sendTabMessageSafe(
        tabId,
        { action: 'traceHighlightField', value: message.value },
        {
          notifyOnUnreachable: true,
          ...(typeof message.frameId === 'number' ? { frameId: message.frameId } : {}),
        },
      );
      sendResponse(response ?? { count: 0 });
    })();
    return true;
  }

  if (message.action === 'traceHighlightClear') {
    sendTabMessageSafe(tabId, { action: 'traceHighlightClear' }).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  if (message.action === 'highlightSpm') {
    sendTabMessageToFramesSafe<{ found?: number }>(
      tabId,
      { action: 'highlightSpm', spm: message.spm },
      { notifyOnUnreachable: true },
    ).then(results =>
      sendResponse({
        found: results.reduce((total, result) => total + (result.response.found ?? 0), 0),
      }),
    );
    return true;
  }

  if (message.action === 'inspectSpm') {
    sendTabMessageToFramesSafe<{ found?: number }>(
      tabId,
      { action: 'inspectSpm', spm: message.spm },
      { notifyOnUnreachable: true },
    ).then(results => {
      const matched = results.find(result => (result.response.found ?? 0) > 0);
      sendResponse({ ok: true, ...(matched ? { frameId: matched.frameId } : {}) });
    });
    return true;
  }

  if (message.action === 'clearSpmHighlight') {
    sendTabMessageToFramesSafe(tabId, { action: 'clearSpmHighlight' }).then(() =>
      sendResponse({ success: true }),
    );
    return true;
  }

  if (message.action === 'getSpmOverlayState') {
    sendResponse({ enabled: isSpmOverlayEnabled(tabId) });
    return true;
  }

  if (message.action === 'toggleSpmOverlay') {
    setSpmOverlayEnabled(tabId, Boolean(message.enabled));
    sendTabMessageToFramesSafe(
      tabId,
      { action: 'toggleSpmOverlay', enabled: message.enabled },
      { notifyOnUnreachable: !!message.enabled },
    ).then(results => sendResponse({ success: results.length > 0 }));
    return true;
  }

  if (message.action === 'startHeatmap') {
    handleStartHeatmap(tabId, message.spmAB, message.ds, message.measure)
      .then(sendResponse)
      .catch(err =>
        sendResponse({
          success: false,
          errorCode: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (message.action === 'stopHeatmap') {
    handleStopHeatmap(tabId).then(sendResponse);
    return true;
  }

  if (message.action === 'setGlobalTranslation') {
    setGlobalTranslation(message.target);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'getTranslationCache') {
    sendResponse({ success: true, cache: getTranslationCache() });
    return true;
  }

  if (message.action === 'translateJson') {
    translateJson(message.data, message.targetLang, (progress: TranslateProgress) => {
      // 发送翻译进度更新
      chrome.runtime
        .sendMessage({
          action: 'translateProgress',
          requestId: message.requestId,
          progress,
        })
        .catch(() => {
          // 忽略没有接收者的错误
        });
    })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Request metadata uses the accepted UI provider.
  if (message.action === 'getApiSchema') {
    fetchApiSchema(message.data)
      .then(result => sendResponse({ success: true, data: result }))
      .catch((error: Error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// ==================== Debugger 事件监听 ====================

// 监听 Fetch 请求暂停事件；诊断采集由 per-tab diagnostics collector 负责。
chrome.debugger.onEvent.addListener((source, method, params: any) => {
  if (source.tabId !== undefined && method === 'Target.attachedToTarget') {
    void handleAppProfileChildTargetEvent(source.tabId, method, params);
  }
  if (
    source.tabId !== undefined &&
    method === 'Target.detachedFromTarget' &&
    typeof params?.sessionId === 'string'
  ) {
    forgetChildDeviceSession(source.tabId, params.sessionId);
    forgetRequestCollectionWebView(source.tabId, params.sessionId);
    handleDebuggerSessionEvent(
      source.tabId,
      'Runtime.executionContextsCleared',
      {},
      params.sessionId,
    );
  }
  const eventSource = source as chrome.debugger.Debuggee & { sessionId?: string };
  if (source.tabId !== undefined) {
    handleDebuggerSessionEvent(source.tabId, method, params, eventSource.sessionId);
    if (
      method === 'Page.frameNavigated' &&
      (params?.frame?.name === '__mearl_root__' || params?.frame?.name === '__mearl_layer__')
    ) {
      // Each DevTools session restores its saved CSS insets when Blink commits a new document.
      void restorePhoneFrameSafeAreaForTab(source.tabId).catch(() => {});
    }
  }
  if (source.tabId !== undefined && eventSource.sessionId === undefined) {
    const businessUrl = handleRootWebViewFrameEvent(source.tabId, method, params ?? {});
    if (businessUrl) notifyPanelDocumentCommit(source.tabId, businessUrl, Date.now());
    if (method === 'Page.frameNavigated' && params.frame)
      updateAppProfileMainFrame(source.tabId, params.frame);
  }
  if (method === 'Fetch.requestPaused') {
    void handleRequestPaused(source.tabId!, params, eventSource.sessionId);
  }
});

// 监听 debugger 分离事件
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId) {
    handleDebuggerDetach(tabId, reason);
    forgetRequestCollectionWebView(tabId);
    interruptDevicePreviewPanel(tabId);
  }
});

// ==================== Tab 管理 ====================

chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  void groupAgentNavigationTarget(details);
});

// 清理已关闭的 tab
chrome.tabs.onRemoved.addListener(tabId => {
  closeDevicePreviewPanel(tabId);
  void Promise.all([
    cleanupBrowserEnhancements(tabId, { closed: true }),
    cleanupEnvironmentRevisions(tabId),
  ]).catch(error => console.warn('[Mearl] Closed page environment cleanup failed:', error));
  clearAccountAutoLoginTab(tabId);
  void deleteQuickDeviceSimulationState(tabId);
  cleanupQuickSimulationAutoRuleTab(tabId);
  cleanupTab(tabId);
  cleanupCollector(tabId);
  cleanupControlledTab(tabId);
  devtoolsPorts.delete(tabId);
  devtoolsPagePorts.delete(tabId);
  cleanupDnrTab(tabId);
  void cleanupTimeForTab(tabId).catch(() => {});
  void cleanupTabPageOverrides(tabId).catch(() => {});
  void cleanupNetworkControlForTab(tabId).catch(() => {});
  void getSettingsContextTabId()
    .then(contextTabId => (contextTabId === tabId ? setSettingsContextTabId(null) : undefined))
    .catch(() => {});
  elementPickerStartGenerations.delete(tabId);
  clearActiveElementPickerSession(tabId);
  clearSpmOverlayState(tabId);
  disposePageRefs(tabId);
  void cleanupClosedTabAppProfile(tabId).catch(() => {});
  void cleanupClosedTabDeviceShell(tabId);
  void removeAgentChatComposerDraft(tabId).catch(() => {});
});

// 页面导航时清除旧的 DNR 命中记录（含同 URL 刷新：changeInfo.url 此时为 undefined）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.status === 'complete') {
    void refreshAppProfileActionIconForTab(tabId).catch(error => {
      console.warn('[AppProfile] Failed to refresh action icon after navigation:', error);
    });
  }
  if (changeInfo.status === 'loading') {
    void applyQuickSimulationAutoRuleForTab(tabId, changeInfo.url).catch(error => {
      console.warn('[DeviceEmulation] Failed to apply automatic simulation rule:', error);
    });
    resetDnrTabOnNavigation(tabId);
    resetResponseOverrideCallCounts(tabId);
    clearPageRefsForNavigation(tabId);
    void clearAgentChatComposerPageContext(tabId).catch(() => {});
  }
});

// 监听 DNR 规则命中事件（需要 declarativeNetRequestFeedback 权限）
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(details => {
    const { tabId } = details.request;
    if (!tabId || tabId < 0) return;
    const { ruleId } = details.rule;
    recordDnrMatch(tabId, ruleId);
    scheduleDnrNotify(tabId);
  });
}

// ==================== DevTools 长连接 ====================

// 向 tab 注入配置到 sessionStorage（用于 early-inject.js 读取）
// 注意：sseMonitoringEnabled 的首选通道是 DNR + Server-Timing（document_start 同步可读），
// 这里同步写入仅作为兜底，处理 Server-Timing 不可用的场景（如 about:blank iframe、
// 被 CSP 剥离响应头等），以及让用户刚变更过的配置在下一次导航前拿到权威值。
async function injectConfigToSessionStorage(tabId: number) {
  const storage = await chrome.storage.sync.get(['language', 'sseMonitoringEnabled']);
  const config = {
    language: storage.language || 'zh_CN',
    sseMonitoringEnabled: storage.sseMonitoringEnabled !== false,
  };

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: (cfg: typeof config) => {
      try {
        sessionStorage.setItem('__mearl_config__', JSON.stringify(cfg));
      } catch {
        return;
      }
    },
    args: [config],
  });
}

const connectToolboxInstallQueue = createToolboxInstallQueue(
  async options => {
    await agentServiceReady;
    const action = 'agent_skills_install';
    return ensureNativeBridge(false).requestNativeHost(
      action,
      options,
      getExtensionServiceTimeout(action),
    );
  },
  () => ensureNativeBridge(false).requestNativeHost('toolbox_tools_list'),
);

chrome.runtime.onConnect.addListener(port => {
  if (port.name === TOOLBOX_INSTALL_QUEUE_PORT) {
    if (port.sender && isExtensionUiSender(port.sender, chrome.runtime.id)) {
      connectToolboxInstallQueue(port);
    } else {
      port.disconnect();
    }
    return;
  }
  if (connectDevicePreviewPanel(port)) return;
  if (port.name === AGENT_SIDE_PANEL_PRESENCE_PORT) {
    let windowId: number | null = null;
    port.onMessage.addListener(message => {
      const nextWindowId = (message as { windowId?: unknown })?.windowId;
      if (
        windowId !== null ||
        typeof nextWindowId !== 'number' ||
        !Number.isInteger(nextWindowId)
      ) {
        return;
      }
      windowId = nextWindowId;
      const ports = sidePanelPresencePorts.get(windowId) || new Set<chrome.runtime.Port>();
      ports.add(port);
      sidePanelPresencePorts.set(windowId, ports);
      openAgentSidePanelWindowIds.add(windowId);
      queueSidePanelStateWrite(windowId, true);
    });
    port.onDisconnect.addListener(() => {
      if (windowId === null) return;
      const ports = sidePanelPresencePorts.get(windowId);
      ports?.delete(port);
      if (ports?.size) {
        queueSidePanelStateWrite(windowId, true);
      } else {
        sidePanelPresencePorts.delete(windowId);
        openAgentSidePanelWindowIds.delete(windowId);
        queueSidePanelStateWrite(windowId, false);
      }
    });
  } else if (port.name.startsWith('devtools-panel-')) {
    const tabId = parseInt(port.name.split('-')[2], 10);
    if (!isNaN(tabId)) {
      devtoolsPorts.set(tabId, port);

      if (getDebuggerStatus(tabId)) {
        void activatePanelDebuggerCapture(tabId, Date.now()).catch(console.warn);
      } else {
        postToPanel(tabId, { action: 'requestCaptureSourceChanged', source: 'devtools' });
      }

      // Panel 打开时注入配置到 sessionStorage
      injectConfigToSessionStorage(tabId).catch(() => {});

      port.onDisconnect.addListener(() => {
        if (devtoolsPorts.get(tabId) === port) devtoolsPorts.delete(tabId);
      });
    }
  } else if (port.name.startsWith('devtools-page-')) {
    const tabId = parseInt(port.name.split('-')[2], 10);
    if (!isNaN(tabId)) {
      devtoolsPagePorts.set(tabId, port);
      port.onDisconnect.addListener(() => {
        devtoolsPagePorts.delete(tabId);
      });
    }
  }
});
