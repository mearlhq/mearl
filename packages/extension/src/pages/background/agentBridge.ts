import {
  extensionPageDialogShortcut,
  withExtensionPageDialogs,
  getExtensionPageDialogs,
  runPageScript,
} from './pageDialogs';
import { handleGetCapabilities } from './capabilityDiscovery';
import { handleBrowserEnhancement } from './browserEnhancements';
import { getEnhancementTabUrl } from './browserEnhancementTarget';
import { runSerializedQuickSimulationUpdate } from './quickSimulationUpdateQueue';
import { MEARL_NATIVE_HOST_NAMES } from '@mearl/browser-core';
import { getExtensionVersion } from '../../shared/extensionVersion';
import {
  setBackgroundPageActivity,
  releaseBackgroundPageActivities,
  resumeFrozenPage,
} from './backgroundPageActivity';
import { handlePluginPageRuntime } from './pluginPageHost';
import { synchronizeBrowserPreset } from './browserPresetSync';
import { installProfileFromSetup } from './profileInstallation';
import { capturePageDownload } from './agentHandlers/downloadHandlers';
import { executePageUserScript } from './pageUserScripts';
/**
 * Agent Bridge - 通过 Native Messaging 与 Agent Server 通信
 *
 * 职责：连接管理、消息路由。
 * 具体业务逻辑委托给 agentHandlers/ 下各模块。
 */

import {
  handleCaptureCheckpoint,
  handleGetRequests,
  handleGetLogs,
  handleGetEvents,
} from './agentHandlers/requestHandlers';
import { handleSetMock, handleGetMocks } from './agentHandlers/mockHandlers';
import { handleSendRequest } from './agentHandlers/httpHandlers';
import {
  handleSendRequestFileAbort,
  handleSendRequestFileChunk,
  handleSendRequestFileStart,
} from './agentHandlers/sendRequestFileTransfer';
import { handleRequestPermission } from './agentHandlers/permissionHandlers';
import {
  handleExportCookies,
  handleGetCookie,
  handleSetCookie,
} from './agentHandlers/cookieHandlers';
import {
  handleSetRule,
  handleGetRules,
  handlePageScreenshot,
  getDevtoolsSelectedElement,
} from './agentHandlers/browserHandlers';
import {
  handleTabOpen,
  handleTabClose,
  handleTabList,
  handleTabGroup,
  handlePageNavigate,
  prepareTabForAgent,
} from './agentHandlers/tabHandlers';
import { markTabControlled } from './agentHandlers/controlledTabs';
import { handoffAgentTabGroups, resumeAgentTabGroups } from './agentHandlers/agentTabGroups';
import {
  handlePageClick,
  handlePageDrag,
  handlePageType,
  handlePageScroll,
  handlePageHover,
  handlePageEval,
  handlePageInspect,
  handlePagePress,
  handlePageWait,
  handlePageUpload,
  startExtensionPageObservation,
  finishExtensionPageObservation,
  detectExtensionContainerNavigation,
  disposeExtensionPageObservation,
  type ExtensionPageObservationCheckpoint,
} from './agentHandlers/interactionHandlers';
import { handlePageSnapshot, handlePageFrames } from './agentHandlers/snapshotHandlers';
import { enrichExtensionPageChangeSetWithRefs } from './agentHandlers/pageRefs';
import { handleSetDeviceEmulation } from './agentHandlers/emulationHandlers';
import { handleSetAppSimulation } from './quickDeviceEmulation';
import { handleSetTimezone } from './agentHandlers/timezoneHandlers';
import { handleBrowserRelease } from './agentHandlers/releaseHandlers';
import type { AgentHandlerContext } from './agentHandlers/types';
import {
  EXTENSION_RPC_VERSION,
  ExtensionRpcError,
  extensionRpcErrorCode,
  isExtensionUiServiceAction,
  runPageAct,
  runActionBatch,
  actionRequiresTabId,
  validateRequiredActionTabId,
  describePageActionFailure,
  isPageActAction,
  shouldObservePageAction,
  splitObservedActionPayload,
  actionRequiresDomainCheck,
  normalizeControlSource,
  URL_PARAM_ACTIONS,
  DomainPermissionError,
  type DomainPermissionFailure,
  type ControlSource,
  type ExtensionBrowserAction,
  resolvePageEvalExpression,
  type PageActAction,
  type PageDiagnosticsOptions,
  type RunActionsParams,
  type HostToExtensionActionMap,
} from '@mearl/browser-core';
import { isAgentDomainAuthorized } from '../../shared/proxyPermissions';
import { getAnalyticsClientId } from '../../shared/analytics';
import { startExtensionNavigationObserver } from './agentHandlers/navigationObserver';
import { isAgentActionAllowedByInternalBoundary } from './agentMessageTrust';
import { getExtensionInstallationInfo } from '../../shared/extensionInstallation';
import { openToolboxToolTab } from '../../shared/toolboxTab';

type InternalBrowserAction =
  keyof HostToExtensionActionMap | 'get_browser_info' | '__toolbox_open' | '__extension_reload';

type SingleExtensionBrowserAction =
  Exclude<ExtensionBrowserAction, 'run_actions'> | InternalBrowserAction;

interface MessageFromAgent {
  id: string;
  action: ExtensionBrowserAction | InternalBrowserAction;
  data: any;
  /** Set only by native-host for private helpers and prepared file references. */
  trustedInternal?: boolean;
  /** Origin of the browser-control request; omitted by older native hosts. */
  controlSource?: ControlSource | 'cloud';
}

interface MessageToAgent {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  errorDetails?: DomainPermissionFailure;
}

export type AgentIntegrationMode = 'mcp' | 'skills';

export interface AgentBridgeStatus {
  connected: boolean;
  attempts: number;
  maxAttempts: number;
  nativeHostVersion: string | null;
  nativeRpcCompatible?: boolean | null;
  extensionVersion: string;
}

const MAX_RECONNECT_ATTEMPTS = 5;

function agentAuthorizationDomain(rawUrl: string): string | undefined {
  const url = new URL(rawUrl);
  // Browser-owned pages have no site permission origin; Chrome enforces debugger access.
  if (['chrome:', 'chrome-extension:', 'devtools:', 'about:'].includes(url.protocol)) {
    return undefined;
  }
  return url.hostname || undefined;
}

export function disconnectedAgentBridgeStatus(): AgentBridgeStatus {
  return {
    connected: false,
    attempts: 0,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    nativeHostVersion: null,
    extensionVersion: getExtensionVersion(),
  };
}

/**
 * Native messaging host names for both integration modes. Both names launch the
 * same binary and share a single Unix socket and handler set, so the bridge only
 * needs to connect to whichever manifest is installed — that one host then serves
 * MCP and Skills clients simultaneously. There is no per-mode runtime state.
 */
// setup 默认注册 Skills host；MCP-only 安装仍会在候选失败后自动切换。
const NATIVE_HOST_NAMES = Object.values(MEARL_NATIVE_HOST_NAMES);
const NATIVE_HOST_NOT_FOUND = 'Specified native messaging host not found';

function actionTargetsTab(action: string, data?: { reload?: unknown }): boolean {
  if (action === 'get_cookie' || action === 'set_cookie') {
    return action === 'set_cookie' && data?.reload === true;
  }
  return action !== 'tab_close' && actionRequiresTabId(action);
}

async function withAgentPageAction<T>(
  action: string,
  tabId: number,
  execute: () => Promise<T>,
): Promise<T> {
  if (isPageActAction(action)) await resumeFrozenPage(tabId);
  return withExtensionPageDialogs(tabId, execute, false);
}

// One successful handshake consumes the automatic update check for this
// extension service-worker lifetime, including bridge resets and reconnects.
let nativeHostUpdateCheckConsumed = false;

/** storage.local key for the stable per-installation browser id sent in the handshake. */
const BROWSER_ID_KEY = 'mearl_browser_id';

export class AgentBridge {
  private devtoolsPorts: Map<number, chrome.runtime.Port>;
  private devtoolsPagePorts: Map<number, chrome.runtime.Port>;
  private pendingQueries = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingNativeRequests = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nativePort: chrome.runtime.Port | null = null;
  private activityLifetime = new AbortController();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  private currentTabId: number | null = null;
  private isStarted = false;
  /**
   * Native host names to try, in order. When a connection never completes its
   * handshake (manifest not installed) we rotate to the next candidate, so the
   * bridge connects to whichever native-host is actually available.
   */
  private readonly hostCandidates: string[] = NATIVE_HOST_NAMES;
  private hostCandidateIndex = 0;
  /** Whether the current native connection completed a ping/pong handshake. */
  private currentConnectionGotPong = false;
  /** 本轮探测中确认不存在的候选；全部缺失时只输出一次状态日志。 */
  private readonly missingNativeHostCandidates = new Set<string>();
  private missingNativeHostsReported = false;
  /** Whether the current ping asked the Host to compare its installed release. */
  private currentConnectionChecksForUpdates = false;
  /** Version advertised by the native host during the current handshake. */
  private nativeHostVersion: string | null = null;
  private nativeRpcVersion: number | null = null;
  private nativePresetInstallationProtocol = 0;
  private handshakeReady: Promise<void> = Promise.resolve();
  private resolveHandshake: () => void = () => {};
  /** Stable identity for this browser installation, loaded from storage lazily. */
  private browserIdentity: { browserId: string; browserName: string } | null = null;
  private canHandleAgentActions: () => boolean;

  constructor(
    devtoolsPorts: Map<number, chrome.runtime.Port>,
    devtoolsPagePorts: Map<number, chrome.runtime.Port> = new Map(),
    canHandleAgentActions: () => boolean = () => true,
    private readonly installation?: (
      data: any,
      transport: (request: any) => Promise<any>,
    ) => Promise<unknown>,
  ) {
    this.devtoolsPorts = devtoolsPorts;
    this.devtoolsPagePorts = devtoolsPagePorts;
    this.canHandleAgentActions = canHandleAgentActions;
    this.watchActiveTab();
  }

  // Panel query (correlationId mechanism)

  private queryPanel(tabId: number, query: Record<string, any>, timeoutMs = 8000): Promise<any> {
    // Prefer panel port (handles all query types); fall back to devtools-page port which
    // is available as long as DevTools is open (any tab), and handles getSelectedElement.
    const port = this.devtoolsPorts.get(tabId) ?? this.devtoolsPagePorts.get(tabId);
    if (!port) {
      return Promise.reject(
        new Error('Panel not connected for this tab. Please open DevTools for the inspected page.'),
      );
    }

    const correlationId = `agent_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(correlationId);
        reject(new Error('Panel query timeout: panel did not respond in time'));
      }, timeoutMs);

      this.pendingQueries.set(correlationId, { resolve, reject, timer });

      try {
        port.postMessage({ action: 'agentQuery', correlationId, query });
      } catch (e) {
        clearTimeout(timer);
        this.pendingQueries.delete(correlationId);
        reject(
          new Error(`Failed to send query to panel: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    });
  }

  resolveQuery(correlationId: string, data: any): void {
    const pending = this.pendingQueries.get(correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingQueries.delete(correlationId);
      pending.resolve(data);
    }
  }

  private getActiveTabId(): number | null {
    return this.currentTabId;
  }

  // Lifecycle

  start(): void {
    if (this.isStarted) return;
    console.log('[AgentBridge] Starting...');
    this.isStarted = true;
    this.setupNativeMessaging();
  }

  reset(): void {
    this.activityLifetime.abort();
    this.resolveHandshake();
    void releaseBackgroundPageActivities();
    console.log('[AgentBridge] Resetting connection...');

    // Drop the cached identity so it is re-read from storage and re-advertised
    // in the registry on the next handshake.
    this.browserIdentity = null;

    this.rejectPendingNativeRequests('AgentBridge reset');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.nativePort) {
      try {
        this.nativePort.disconnect();
      } catch {
        // ignore
      }
      this.nativePort = null;
    }

    this.reconnectAttempts = 0;
    this.missingNativeHostCandidates.clear();
    this.missingNativeHostsReported = false;
    this.isStarted = false;
    this.start();
  }

  getStatus(): AgentBridgeStatus {
    return {
      connected: this.nativePort !== null && this.currentConnectionGotPong,
      attempts: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      nativeHostVersion: this.nativeHostVersion,
      nativeRpcCompatible: this.currentConnectionGotPong
        ? this.nativeRpcVersion === EXTENSION_RPC_VERSION
        : null,
      extensionVersion: getExtensionVersion(),
    };
  }

  hasNativeConnection(): boolean {
    return this.nativePort !== null;
  }

  destroy(): void {
    this.activityLifetime.abort();
    this.resolveHandshake();
    void releaseBackgroundPageActivities();
    this.rejectPendingNativeRequests('AgentBridge destroyed');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.nativePort) {
      this.nativePort.disconnect();
      this.nativePort = null;
    }

    this.isStarted = false;
    this.reconnectAttempts = 0;

    for (const [, pending] of this.pendingQueries) {
      clearTimeout(pending.timer);
      pending.reject(new Error('AgentBridge destroyed'));
    }
    this.pendingQueries.clear();
  }

  // Tab tracking

  private watchActiveTab(): void {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) this.currentTabId = tabs[0].id;
    });

    chrome.tabs.onActivated.addListener(({ tabId }) => {
      this.currentTabId = tabId;
    });

    // 跨窗口切换时 onActivated 不会触发，需要额外监听窗口焦点变化
    chrome.windows.onFocusChanged.addListener(windowId => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      this.notifyFocus();
      chrome.tabs
        .query({ active: true, windowId })
        .then(tabs => {
          if (tabs[0]?.id) {
            this.currentTabId = tabs[0].id;
          }
        })
        .catch(() => {
          // ignore — window may have been closed
        });
    });

    chrome.tabs.onRemoved.addListener(tabId => {
      if (this.currentTabId === tabId) {
        this.currentTabId = null;
        chrome.tabs
          .query({ active: true, currentWindow: true })
          .then(tabs => {
            this.currentTabId = tabs[0]?.id ?? null;
          })
          .catch(() => {
            this.currentTabId = null;
          });
      }
    });
  }

  // Browser identity

  private deriveBrowserName(): string {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Chrome\//.test(ua)) return 'Chrome';
    return 'Browser';
  }

  /**
   * Load (or lazily generate + persist) this browser installation's stable id.
   * Sent in the handshake so a client can tell multiple browsers apart and
   * address a specific one.
   */
  private async ensureBrowserIdentity(): Promise<{
    browserId: string;
    browserName: string;
  }> {
    if (this.browserIdentity) return this.browserIdentity;
    const stored = await chrome.storage.local.get([BROWSER_ID_KEY]);
    let browserId = stored[BROWSER_ID_KEY] as string | undefined;
    if (!browserId) {
      browserId = crypto.randomUUID();
      await chrome.storage.local.set({ [BROWSER_ID_KEY]: browserId });
    }
    this.browserIdentity = { browserId, browserName: this.deriveBrowserName() };
    return this.browserIdentity;
  }

  /** Tell the native host this browser just gained focus, so it becomes the default target. */
  private notifyFocus(): void {
    if (!this.nativePort) return;
    try {
      this.nativePort.postMessage({ type: 'browser_focus' });
    } catch {
      // ignore — port may be mid-teardown
    }
  }

  // Native Messaging

  private setupNativeMessaging(): void {
    const hostName = this.hostCandidates[this.hostCandidateIndex];
    this.currentConnectionGotPong = false;
    this.currentConnectionChecksForUpdates = false;
    this.nativeHostVersion = null;
    this.nativeRpcVersion = null;
    this.nativePresetInstallationProtocol = 0;
    this.resolveHandshake();
    this.handshakeReady = new Promise(resolve => {
      this.resolveHandshake = resolve;
    });
    try {
      this.activityLifetime = new AbortController();
      const activityLifetime = this.activityLifetime;
      this.nativePort = chrome.runtime.connectNative(hostName);

      this.nativePort.onMessage.addListener((message: any) => {
        if (message.type === 'pong') {
          console.log('[AgentBridge] Native host responded to ping, connection stable');
          this.currentConnectionGotPong = true;
          this.missingNativeHostCandidates.clear();
          this.missingNativeHostsReported = false;
          if (this.currentConnectionChecksForUpdates) nativeHostUpdateCheckConsumed = true;
          this.currentConnectionChecksForUpdates = false;
          this.nativeHostVersion =
            typeof message.version === 'string' && message.version ? message.version : null;
          this.nativePresetInstallationProtocol = message.presetInstallationProtocol === 1 ? 1 : 0;
          this.nativeRpcVersion =
            typeof message.rpcVersion === 'number' ? message.rpcVersion : null;
          this.resolveHandshake();
          if (
            typeof message.presetInstallationRevision === 'string' &&
            /^[a-f0-9]{64}$/.test(message.presetInstallationRevision)
          ) {
            void this.synchronizePreset({
              operation: 'sync',
              installationRevision: message.presetInstallationRevision,
            }).catch(() => {});
          }
          this.reconnectAttempts = 0;
          this.notifyStatusChange();
          return;
        }
        if (message.type === 'control_sessions_changed') {
          chrome.runtime.sendMessage({ action: 'controlSessionsChanged' }).catch(() => {});
          return;
        }
        if (message.type === 'cloud_connector_status_changed') {
          chrome.runtime
            .sendMessage({
              action: 'cloudConnectorStatusChanged',
              data: message.data,
            })
            .catch(() => {});
          return;
        }
        if (message.type === 'agent_chat_event') {
          chrome.runtime
            .sendMessage({
              action: 'agentChatEvent',
              data: message.data,
            })
            .catch(() => {});
          return;
        }
        const pendingNativeRequest = message?.id
          ? this.pendingNativeRequests.get(message.id)
          : null;
        if (pendingNativeRequest) {
          clearTimeout(pendingNativeRequest.timer);
          this.pendingNativeRequests.delete(message.id);
          if (message.success) {
            pendingNativeRequest.resolve(message.data);
          } else {
            const code = extensionRpcErrorCode(message);
            pendingNativeRequest.reject(
              code
                ? new ExtensionRpcError(code, message.error || 'Native host service failed')
                : new Error(message.error || 'Unknown native host error'),
            );
          }
          return;
        }
        this.handleAgentMessage(message as MessageFromAgent);
      });

      this.nativePort.onDisconnect.addListener(() => {
        this.resolveHandshake();
        activityLifetime.abort();
        void releaseBackgroundPageActivities();
        const error = chrome.runtime.lastError;
        const missingCandidate =
          !this.currentConnectionGotPong &&
          error?.message?.includes(NATIVE_HOST_NOT_FOUND) === true;
        if (missingCandidate) {
          this.missingNativeHostCandidates.add(hostName);
          if (
            this.missingNativeHostCandidates.size === this.hostCandidates.length &&
            !this.missingNativeHostsReported
          ) {
            this.missingNativeHostsReported = true;
            console.info(
              '[AgentBridge] No registered Native Messaging host found; continuing low-frequency probes',
            );
          }
        } else if (error) {
          console.error('[AgentBridge] Native host disconnected:', error.message);
        } else {
          console.log('[AgentBridge] Native host disconnected');
        }
        this.rejectPendingNativeRequests(error?.message || 'Native host disconnected');
        this.nativePort = null;
        this.nativeHostVersion = null;
        this.notifyStatusChange();
        // If this candidate never completed a handshake, its manifest may not be
        // installed — rotate to the other host name on the next attempt so we
        // connect to whichever native-host is actually available.
        const shouldTryAlternate =
          missingCandidate &&
          this.hostCandidates.length > 1 &&
          this.missingNativeHostCandidates.size < this.hostCandidates.length;
        if (!this.currentConnectionGotPong && this.hostCandidates.length > 1) {
          this.hostCandidateIndex = (this.hostCandidateIndex + 1) % this.hostCandidates.length;
        }
        this.scheduleReconnect(shouldTryAlternate);
      });

      console.log(`[AgentBridge] Native messaging connected (${hostName}), sending ping...`);
      const extensionVersion = getExtensionVersion();
      const port = this.nativePort;
      const checkForUpdates = !nativeHostUpdateCheckConsumed;
      this.currentConnectionChecksForUpdates = checkForUpdates;
      const analyticsClientIdPromise = getAnalyticsClientId().catch(error => {
        console.warn('[AgentBridge] Failed to load analytics identity:', error);
        return undefined;
      });
      Promise.all([this.ensureBrowserIdentity(), analyticsClientIdPromise])
        .then(([identity, analyticsClientId]) => {
          // The port may have been torn down while we were reading storage.
          if (this.nativePort !== port) return;
          port.postMessage({
            type: 'ping',
            timestamp: Date.now(),
            version: extensionVersion,
            rpcVersion: EXTENSION_RPC_VERSION,
            checkForUpdates,
            browserId: identity.browserId,
            browserName: identity.browserName,
            ...(analyticsClientId ? { analyticsClientId } : {}),
          });
        })
        .catch(error => {
          console.warn('[AgentBridge] Failed to load browser identity, pinging without it:', error);
          if (this.nativePort === port) {
            port.postMessage({
              type: 'ping',
              timestamp: Date.now(),
              version: extensionVersion,
              rpcVersion: EXTENSION_RPC_VERSION,
              checkForUpdates,
            });
          }
        });
    } catch (error) {
      console.error('[AgentBridge] Failed to connect to native host:', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(immediate = false): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;

    // 前 5 次：指数退避低阶重连（1s → 2s → 4s → 8s → 16s）
    // 之后：切换到低频探测模式（每 60s 一次），持续尝试直到连接成功
    // 这样即使先装插件后装 Native Host，也能自动连上
    const isSlowProbe = this.reconnectAttempts > this.maxReconnectAttempts;
    const delay = immediate
      ? 0
      : isSlowProbe
        ? 60_000
        : Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    if (immediate) {
      console.info('[AgentBridge] Trying alternate Native Messaging host');
    } else if (isSlowProbe) {
      console.log(
        `[AgentBridge] Slow probe reconnect in ${delay / 1000}s (attempt ${this.reconnectAttempts})`,
      );
    } else {
      console.log(
        `[AgentBridge] Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.setupNativeMessaging();
    }, delay);
  }

  // Message routing

  /**
   * 会发起请求、触发导航或需要关联请求结果的操作。
   * 这些操作在执行前启动采集，确保首批网络事件不会丢失。
   */
  private static readonly REQUEST_CAPTURING_ACTIONS = new Set<MessageFromAgent['action']>([
    'tab_checkpoint',
    'capture_checkpoint',
    'get_requests',
    'get_logs',
    'get_events',
    'page_click',
    'page_type',
    'page_scroll',
    'page_hover',
    'page_eval',
    'page_press',
    'page_navigate',
    'page_upload',
    'set_device_emulation',
    'set_app_profile',
    'run_actions',
  ]);

  /**
   * Unified domain authorization check. Resolves the target domain based on
   * the action type (URL parameter vs. current tab) and verifies it against
   * the user's allowed-origins list. Actions in ACTIONS_SKIP_DOMAIN_CHECK
   * are passed through without any check.
   */
  private async assertAgentActionAuthorized(
    action: string,
    data: any,
    trustedInternal = false,
  ): Promise<void> {
    if (
      action === 'send_request' &&
      !trustedInternal &&
      data &&
      (Object.hasOwn(data, 'transferId') || Object.hasOwn(data, 'binaryBody'))
    ) {
      throw new Error('File transfer references require a trusted native-host request');
    }
    if (action === 'page_runtime') return;
    // Chunk receipt and cancellation only touch an existing transfer; start checks its target URL.
    if (action === '__send_request_files' && ['chunk', 'abort'].includes(data?.operation)) return;
    if (!actionRequiresDomainCheck(action)) return;

    let domain: string | undefined;

    if (
      URL_PARAM_ACTIONS.has(action) ||
      ((action === 'get_cookie' || action === 'set_cookie') && data?.url !== undefined)
    ) {
      const rawUrl = data?.url;
      if (!rawUrl) return; // handler will throw a proper validation error
      // Cookie-free requests keep the existing unrestricted proxy behavior. File uploads
      // still require target authorization because native-host reads local file content.
      if (
        action === 'send_request' &&
        data?.withCookies === false &&
        data?.bodyFile === undefined &&
        data?.transferId === undefined &&
        (!Array.isArray(data?.files) || data.files.length === 0)
      ) {
        return;
      }
      try {
        domain = agentAuthorizationDomain(rawUrl);
      } catch {
        return; // invalid URL — handler will throw
      }
    } else if (action === 'tab_close') {
      // tab_close: domain from the tab being closed
      if (typeof data?.tabId === 'number') {
        try {
          const tab = await chrome.tabs.get(data.tabId);
          if (tab?.url) domain = agentAuthorizationDomain(tab.url);
        } catch {
          return; // tab may already be closed
        }
      }
    } else {
      // Default: domain from the active / specified tab
      const tabId = typeof data?.tabId === 'number' ? data.tabId : this.getActiveTabId();
      if (!tabId) return;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url) domain = agentAuthorizationDomain(tab.url);
      } catch {
        return;
      }
    }

    const domains = new Set<string>();
    if (domain) domains.add(domain);
    if (action === 'set_cookie' && data?.url !== undefined && data?.reload === true) {
      const tab = await chrome.tabs.get(data.tabId);
      if (!tab.url) throw new Error('set_cookie: reload target has no URL');
      const reloadDomain = agentAuthorizationDomain(tab.url);
      if (reloadDomain) domains.add(reloadDomain);
    }
    await this.assertAgentDomainsAuthorized(action, domains);
  }

  private async assertAgentDomainsAuthorized(
    action: string,
    domains: Iterable<string>,
  ): Promise<void> {
    for (const domain of domains) {
      if (!(await isAgentDomainAuthorized(domain))) throw new DomainPermissionError(action, domain);
    }
  }

  private async assertEnhancementActionAuthorized(
    tabId: number,
    action: string,
    navigationOrigin?: string,
  ): Promise<void> {
    // A missing/transient tab lookup cannot bypass first-navigation or current-domain authorization.
    const currentUrl = await getEnhancementTabUrl(tabId);
    const domains = new Set<string>();
    for (const url of [currentUrl, ...(navigationOrigin ? [navigationOrigin] : [])]) {
      const domain = agentAuthorizationDomain(url);
      if (domain) domains.add(domain);
    }
    await this.assertAgentDomainsAuthorized(action, domains);
  }

  private async dispatchSingleAction(
    action: SingleExtensionBrowserAction,
    data: any,
    ctx: AgentHandlerContext,
    controlSource: ControlSource,
  ): Promise<any> {
    const shortcut = await extensionPageDialogShortcut(action, data);
    if (shortcut) return shortcut.data;
    const work = () => this.dispatchSingleActionRaw(action, data, ctx, controlSource);
    return typeof data?.tabId === 'number' && action.startsWith('page_')
      ? withExtensionPageDialogs(data.tabId, work)
      : work();
  }

  private async dispatchSingleActionRaw(
    action: SingleExtensionBrowserAction,
    data: any,
    ctx: AgentHandlerContext,
    controlSource: ControlSource,
  ): Promise<any> {
    switch (action) {
      case '__preset_installation':
        if (!this.installation) throw new Error('Preset installation view is unavailable');
        return this.installation(data, request =>
          this.requestNativeHost('preset_browser_transfer', request),
        );
      case '__preset_browser':
        return this.synchronizePreset(data);
      case '__profile_install':
        return installProfileFromSetup(data?.source);
      case 'tab_checkpoint':
      case 'capture_checkpoint':
        return handleCaptureCheckpoint(data, ctx);
      case 'get_capabilities':
        return handleGetCapabilities(data);
      case 'get_requests':
        return handleGetRequests(data, ctx);
      case 'get_logs':
        return handleGetLogs(data, ctx);
      case 'set_mock':
        return handleSetMock(data, ctx);
      case 'get_mocks':
        return handleGetMocks(data, ctx);
      case 'send_request':
        return handleSendRequest(data);
      case 'get_events':
        return handleGetEvents(data, ctx);
      case 'set_rule':
        return handleSetRule(data);
      case 'get_rules':
        return handleGetRules();
      case 'page_screenshot':
        return handlePageScreenshot(data, () => this.getActiveTabId());
      case 'tab_open':
        return handleTabOpen(data, controlSource, ctx.signal);
      case 'tab_close':
        return handleTabClose(data);
      case 'tab_list':
        return handleTabList();
      case 'tab_group':
        return handleTabGroup(data);
      case 'page_click':
        return handlePageClick(data, () => this.getActiveTabId());
      case 'page_drag':
        return handlePageDrag(data, () => this.getActiveTabId());
      case 'page_type':
        return handlePageType(data, () => this.getActiveTabId());
      case 'page_scroll':
        return handlePageScroll(data, () => this.getActiveTabId());
      case 'page_hover':
        return handlePageHover(data, () => this.getActiveTabId());
      case 'page_runtime':
        return handlePluginPageRuntime(data);
      case 'page_eval':
        if (data?.executionWorld === 'isolated') {
          if (data.frameId !== undefined)
            throw new Error('Plugin user scripts automatically target the current page');
          return executePageUserScript({
            tabId: data.tabId,
            worldId: data.worldId,
            code: resolvePageEvalExpression(data),
          });
        }
        if (data?.executionWorld !== undefined && data.executionWorld !== 'main') {
          throw new Error('Invalid page executionWorld');
        }
        return handlePageEval(data, () => this.getActiveTabId());
      case 'page_inspect':
        if (data?.selector === '$0') {
          const selected = await getDevtoolsSelectedElement(
            {
              tabId: data.tabId,
              includeOuterHTML: data.includeOuterHTML !== false,
            },
            ctx,
          );
          const inspected = await handlePageInspect({ ...data, selector: selected.selector }, () =>
            this.getActiveTabId(),
          );
          return {
            ...inspected,
            selector: '$0',
            resolvedSelector: selected.selector,
            source: 'devtools-selection',
            matches: inspected.matches.map((match, index) =>
              index === 0
                ? {
                    ...match,
                    selector: selected.selector,
                    attributes: selected.attributes,
                    xpath: selected.xpath,
                    ...(selected.sourceLocation ? { sourceLocation: selected.sourceLocation } : {}),
                    ...(selected.framework ? { framework: selected.framework } : {}),
                    ...(data.includeOuterHTML !== false && selected.outerHTML
                      ? { outerHTML: selected.outerHTML }
                      : {}),
                  }
                : match,
            ),
          };
        }
        return handlePageInspect(data, () => this.getActiveTabId());
      case 'page_press':
        return handlePagePress(data, () => this.getActiveTabId());
      case 'page_wait':
        return handlePageWait(data, () => this.getActiveTabId());
      case 'page_navigate':
        return handlePageNavigate(data, () => this.getActiveTabId());
      case 'page_snapshot':
        return handlePageSnapshot(data, () => this.getActiveTabId());
      case 'page_upload':
        return handlePageUpload(data, () => this.getActiveTabId());
      case 'page_frames':
        return handlePageFrames(data, () => this.getActiveTabId());
      case '__browser_enhancement':
        return handleBrowserEnhancement(data, (tabId, action, origin) =>
          this.assertEnhancementActionAuthorized(tabId, action, origin),
        );
      case 'set_device_emulation':
        return runSerializedQuickSimulationUpdate(data.tabId, () =>
          handleSetDeviceEmulation(data, () => this.getActiveTabId()),
        );
      case 'set_app_profile':
        return handleSetAppSimulation(data, () => this.getActiveTabId());
      case 'set_timezone':
        return runSerializedQuickSimulationUpdate(data.tabId, () =>
          handleSetTimezone(data, () => this.getActiveTabId()),
        );
      case 'get_cookie':
        return handleGetCookie(data);
      case 'set_cookie':
        return handleSetCookie(data);
      case '__control_deactivate': {
        const results = await Promise.allSettled(
          data.tabIds.map((tabId: number) => setBackgroundPageActivity(tabId, false)),
        );
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            failures.map(result => result.reason),
            'Failed to restore background page activity',
          );
        await handoffAgentTabGroups(data.tabIds);
        return { updated: true };
      }
      case '__control_cleanup': {
        const result = await handleBrowserRelease(data);
        if (result.released && data.returningToAgent) await resumeAgentTabGroups(data.tabIds);
        return result;
      }
      case '__capture_download':
        return capturePageDownload(data, async () => {
          await this.assertAgentActionAuthorized('page_click', data);
          return withAgentPageAction('page_click', data.tabId, () =>
            this.handleObservedPageAction(
              'page_click',
              { ...data.trigger, tabId: data.tabId },
              ctx,
              controlSource,
            ),
          );
        });
      case 'browser_release':
        return handleBrowserRelease();
      case 'request_permission':
        return handleRequestPermission(data);
      case '__export_cookies':
        return handleExportCookies(data);
      case '__send_request_files':
        switch (data?.operation) {
          case 'start':
            return handleSendRequestFileStart(data);
          case 'chunk':
            return handleSendRequestFileChunk(data);
          case 'abort':
            return handleSendRequestFileAbort(data);
          default:
            throw new Error('Invalid send_request file operation');
        }
      case 'get_browser_info':
        return {
          ...(await getExtensionInstallationInfo()),
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        };
      case '__toolbox_open': {
        const toolId = typeof data?.toolId === 'string' ? data.toolId : '';
        const query =
          data?.query && typeof data.query === 'object' && !Array.isArray(data.query)
            ? data.query
            : {};
        await openToolboxToolTab(toolId, query);
        return { opened: true, toolId, query };
      }
      case '__extension_reload':
        setTimeout(() => chrome.runtime.reload(), 100);
        return { success: true };
      default: {
        const unsupportedAction: never = action;
        throw new Error(`Unknown action: ${unsupportedAction}`);
      }
    }
  }

  private async handleAgentMessage(message: MessageFromAgent): Promise<void> {
    const signal = this.activityLifetime.signal;
    try {
      const enhancementRequiresAgent =
        message.action === '__browser_enhancement' && message.data?.operation !== 'release';
      if (
        !this.canHandleAgentActions() &&
        (message.trustedInternal !== true || enhancementRequiresAgent)
      ) {
        throw new Error('Agent service is disabled');
      }
      if (!isAgentActionAllowedByInternalBoundary(message.action, message.trustedInternal)) {
        throw new Error('Internal action is not available to agents');
      }

      validateRequiredActionTabId(message.action, message.data);
      const actionData = message.data;
      const controlSource = normalizeControlSource(message.controlSource);

      // Unified domain authorization check
      if (message.action !== '__browser_enhancement') {
        await this.assertAgentActionAuthorized(
          message.action,
          actionData,
          message.trustedInternal === true,
        );
      }

      const ctx: AgentHandlerContext = {
        queryPanel: this.queryPanel.bind(this),
        getActiveTabId: () => this.getActiveTabId(),
        signal,
      };

      const targetTabId = actionData?.tabId;
      const execute = async () => {
        if (
          (AgentBridge.REQUEST_CAPTURING_ACTIONS.has(message.action) &&
            !(message.action === 'page_eval' && actionData?.executionWorld === 'isolated')) ||
          (message.action === 'set_cookie' && actionData?.reload === true)
        ) {
          await runPageScript(targetTabId, () => prepareTabForAgent(targetTabId, controlSource));
        } else if (
          actionTargetsTab(message.action, actionData) &&
          typeof targetTabId === 'number'
        ) {
          markTabControlled(targetTabId, controlSource).catch(() => {});
        }

        let responseData: any;

        if (message.action === 'run_actions') {
          responseData = await this.handleRunActions(
            actionData,
            ctx,
            controlSource,
            message.trustedInternal === true,
          );
        } else if (shouldObservePageAction(message.action, actionData)) {
          responseData = await this.handleObservedPageAction(
            message.action,
            actionData,
            ctx,
            controlSource,
          );
        } else {
          responseData = await this.dispatchSingleAction(
            message.action,
            actionData,
            ctx,
            controlSource,
          );
        }

        return responseData;
      };
      const shortcut = await extensionPageDialogShortcut(message.action, actionData);
      const responseData = shortcut
        ? shortcut.data
        : typeof targetTabId === 'number' &&
            (message.action.startsWith('page_') || message.action === 'run_actions')
          ? await withAgentPageAction(message.action, targetTabId, execute).catch(async error => {
              // Page.enable may discover a modal that was already open before this request.
              if (message.action === 'page_snapshot') {
                const pending = await extensionPageDialogShortcut(message.action, actionData);
                if (pending) return pending.data;
              }
              throw error;
            })
          : await execute();

      this.sendToAgent({ id: message.id, success: true, data: responseData });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Panel not connected')) {
        // Silenced: expected when devtools panel is not open
      } else if (errorMessage.includes('Unknown action') || error instanceof TypeError) {
        console.error('[AgentBridge] Unexpected error:', errorMessage);
      } else {
        console.warn('[AgentBridge] Action failed:', errorMessage);
      }
      this.sendToAgent({
        id: message.id,
        success: false,
        error: errorMessage,
        ...(error instanceof DomainPermissionError
          ? {
              errorDetails: {
                code: error.code,
                action: error.action,
                domain: error.domain,
                requestDispatched: error.requestDispatched,
              },
            }
          : {}),
      });
    }
  }

  private async handleRunActions(
    data: RunActionsParams,
    ctx: AgentHandlerContext,
    controlSource: ControlSource,
    trustedInternal = false,
  ): Promise<any> {
    const preparedTabIds = new Set<number>();
    if (typeof data.tabId === 'number') preparedTabIds.add(data.tabId);
    return runActionBatch(data, async (action, payload) => {
      await this.assertAgentActionAuthorized(action, payload, trustedInternal);
      const tabId = payload.tabId;
      const shortcut = await extensionPageDialogShortcut(action, payload);
      if (shortcut) return { success: true, data: shortcut.data };
      const execute = async () => {
        if (
          typeof tabId === 'number' &&
          actionTargetsTab(action, payload) &&
          !preparedTabIds.has(tabId)
        ) {
          await runPageScript(tabId, () => prepareTabForAgent(tabId, controlSource));
          preparedTabIds.add(tabId);
        }
        return {
          success: true,
          data: await this.dispatchSingleAction(
            action as SingleExtensionBrowserAction,
            payload,
            ctx,
            controlSource,
          ),
        };
      };
      return typeof tabId === 'number' && action.startsWith('page_')
        ? withAgentPageAction(action, tabId, execute)
        : execute();
    });
  }

  /**
   * Page interaction actions execute with built-in observation by default.
   * Diagnostics are collected only when the caller requests them.
   * `run_actions` steps bypass this wrapper and stay lightweight.
   */
  private async handleObservedPageAction(
    action: PageActAction,
    data: any,
    ctx: AgentHandlerContext,
    controlSource: ControlSource,
  ): Promise<any> {
    const { actionData, observe, diagnostics } = splitObservedActionPayload(action, data);
    const tabId = actionData.tabId;
    if (observe === false) {
      if (!diagnostics) {
        return this.dispatchSingleAction(action, actionData, ctx, controlSource);
      }
      const checkpoint = await handleCaptureCheckpoint({ tabId }, ctx);
      let actionResult: any;
      let actionFailure: ReturnType<typeof describePageActionFailure> | undefined;
      try {
        actionResult = await this.dispatchSingleAction(action, actionData, ctx, controlSource);
      } catch (error) {
        actionFailure = describePageActionFailure(error);
      }
      const result = {
        action: {
          name: action,
          success: actionFailure === undefined,
          ...(actionResult !== undefined ? { data: actionResult } : {}),
          ...(actionFailure ? actionFailure : {}),
        },
      };
      if (actionFailure?.stage === 'precondition') return result;
      return {
        ...result,
        diagnostics: await this.collectPageDiagnostics(tabId, checkpoint.cursor, diagnostics, ctx),
      };
    }
    let extensionCheckpoint: ExtensionPageObservationCheckpoint | undefined;
    let diagnosticsCursor: string | undefined;
    const result = await runPageAct(
      { action, actionData, observe },
      {
        dialogs: getExtensionPageDialogs(tabId),
        startObservation: async () => {
          extensionCheckpoint = await startExtensionPageObservation(tabId);
          return extensionCheckpoint;
        },
        finishObservation: (checkpoint, options) =>
          finishExtensionPageObservation(
            tabId,
            extensionCheckpoint ?? { ...checkpoint, world: 'scripting' },
            options,
          ),
        startNavigationObserver: options =>
          startExtensionNavigationObserver(
            tabId,
            options.urlBefore,
            extensionCheckpoint?.containerFrameId ? { ...options, trackNetwork: false } : options,
          ),
        detectNavigation: (_checkpoint, timeoutMs) =>
          extensionCheckpoint
            ? detectExtensionContainerNavigation(tabId, extensionCheckpoint, timeoutMs)
            : Promise.resolve(null),
        executeAction: async (name, params) => {
          if (diagnostics) {
            diagnosticsCursor = (await handleCaptureCheckpoint({ tabId }, ctx)).cursor;
          }
          return this.dispatchSingleAction(name, { ...params, tabId }, ctx, controlSource);
        },
        finalizeObservation: observation => {
          if (observation.mode === 'delta') {
            return enrichExtensionPageChangeSetWithRefs(tabId, observation);
          }
          return Promise.resolve(observation);
        },
        disposeObservation: () =>
          extensionCheckpoint
            ? disposeExtensionPageObservation(
                tabId,
                extensionCheckpoint.world,
                extensionCheckpoint.containerFrameId,
                extensionCheckpoint.containerUrl,
              )
            : undefined,
      },
    );
    if (!diagnostics || !diagnosticsCursor || result.action.stage === 'precondition') {
      return result;
    }
    return {
      ...result,
      diagnostics: await this.collectPageDiagnostics(tabId, diagnosticsCursor, diagnostics, ctx),
    };
  }

  private async collectPageDiagnostics(
    tabId: number,
    after: string,
    diagnostics: PageDiagnosticsOptions,
    ctx: AgentHandlerContext,
  ): Promise<Record<string, any>> {
    const result: Record<string, any> = {};
    if (diagnostics.logs) {
      const options =
        diagnostics.logs === true
          ? { level: 'error' as const, limit: 100 }
          : { level: 'error' as const, limit: 100, ...diagnostics.logs };
      result.logs = await handleGetLogs({ ...options, tabId, after }, ctx);
    }
    if (diagnostics.requests) {
      const options =
        diagnostics.requests === true
          ? { source: 'all' as const, includeBody: false, count: 100 }
          : {
              source: 'all' as const,
              includeBody: false,
              count: 100,
              ...diagnostics.requests,
            };
      result.requests = await handleGetRequests({ ...options, tabId, after }, ctx);
    }
    if (diagnostics.events) {
      const options =
        diagnostics.events === true
          ? { source: 'all' as const, limit: 100 }
          : { source: 'all' as const, limit: 100, ...diagnostics.events };
      result.events = await handleGetEvents({ ...options, tabId, after }, ctx);
    }
    return result;
  }

  private sendToAgent(message: MessageToAgent): void {
    if (!this.nativePort) {
      console.error('[AgentBridge] Native port not connected');
      return;
    }
    try {
      this.nativePort.postMessage(message);
    } catch (error) {
      console.error('[AgentBridge] Failed to send message:', error);
    }
  }

  private rejectPendingNativeRequests(message: string): void {
    for (const [id, pending] of this.pendingNativeRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pendingNativeRequests.delete(id);
    }
  }

  private presetSynchronization: Promise<unknown> = Promise.resolve();
  private synchronizePreset(
    input: HostToExtensionActionMap['__preset_browser']['request'],
  ): Promise<unknown> {
    const run = () =>
      synchronizeBrowserPreset(input, request =>
        this.requestNativeHost('preset_browser_transfer', request),
      );
    if (input.operation === 'status') return run();
    const next = this.presetSynchronization.catch(() => {}).then(run);
    this.presetSynchronization = next;
    return next;
  }

  async supportsPresetInstallation(timeoutMs = 1500): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.handshakeReady,
        new Promise(resolve => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      return (
        this.nativePort !== null &&
        this.currentConnectionGotPong &&
        this.nativeRpcVersion === EXTENSION_RPC_VERSION &&
        this.nativePresetInstallationProtocol === 1
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async requestNativeHost(action: string, data: any = {}, timeoutMs = 15000): Promise<any> {
    if (!this.nativePort) {
      return Promise.reject(new Error('Native host is not connected'));
    }

    const port = this.nativePort;
    const startedAt = Date.now();
    if (isExtensionUiServiceAction(action) || action === 'preset_installation') {
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.handshakeReady,
          new Promise<never>((_, reject) => {
            handshakeTimer = setTimeout(
              () => reject(new Error('Native host handshake timed out')),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(handshakeTimer);
      }
      if (port !== this.nativePort) throw new Error('Native host disconnected before dispatch');
      if (this.nativeRpcVersion !== EXTENSION_RPC_VERSION) {
        throw new ExtensionRpcError(
          'PROTOCOL_MISMATCH',
          'Update the Mearl extension and local service, then reconnect.',
        );
      }
    }
    if (action === 'preset_installation' && this.nativePresetInstallationProtocol !== 1)
      throw new ExtensionRpcError(
        'UNSUPPORTED_ACTION',
        'The local service requires an update for preset installation.',
      );
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const id = `panel_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNativeRequests.delete(id);
        reject(new Error(`Native host request timeout after ${timeoutMs}ms`));
      }, remainingMs);

      this.pendingNativeRequests.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ id, action, data, rpcVersion: EXTENSION_RPC_VERSION });
      } catch (error) {
        clearTimeout(timer);
        this.pendingNativeRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notifyStatusChange(): void {
    const status = this.getStatus();
    chrome.runtime
      .sendMessage({
        action: 'agentStatusChanged',
        status,
      })
      .catch(() => {});
  }
}
