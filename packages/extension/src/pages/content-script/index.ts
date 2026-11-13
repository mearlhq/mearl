// Content Script for Mearl
// 负责注入代码到页面上下文，并转发消息到 background

import { createDnrIndicatorManager, DnrIndicatorMode, DnrRule } from './dnrIndicator';
import {
  i18nMessage,
  isExtensionContextValid,
  safeSendMessage,
  safeStorageSyncGet,
} from './chromeSafe';
import { findSseOverride } from './sseOverrideMatch';
import {
  AGENT_SIDE_PANEL_STATE_CHANGED_ACTION,
  GET_AGENT_SIDE_PANEL_STATE_ACTION,
  OPEN_AGENT_SIDE_PANEL_FROM_PAGE_ACTION,
  createAgentSidePanelToggle,
  shouldShowAgentFloatingButton,
  type AgentSidePanelStateResponse,
} from './agentSidePanelToggle';
import type { ElementPickerPage } from './elementCommentTypes';
import { listenAppBridgeRelay } from './appBridgeRelay';
import { installAppBridgeConfigOverlay } from './appBridgeConfigOverlay';
import { installFrameVisualRuntime } from './frameVisualRuntime';
import { installElementPickerRuntime } from './elementPickerRuntime';
import type { QuickDeviceChromeConfig } from '../../shared/quickAppProfile';
import {
  createQuickDeviceChromeManager,
  readPhoneFrameBootstrap,
  type QuickDeviceChromeAppState,
} from './deviceChrome';
import { installAccountAutoLoginCountdown } from './accountAutoLogin';
import { installWebsiteInstallationBridge } from './installationWebsite';

// Classic content script 的模块图必须自包含，协议值留在入口中可避免 shared 生成额外 chunk。
const QUICK_DEVICE_CHROME_GET_ACTION = 'quickDeviceChromeGet';
const QUICK_DEVICE_CHROME_UPDATE_ACTION = 'quickDeviceChromeUpdate';
const DEVICE_PREVIEW_PANEL_WIDTH = 'device-preview-panel-width';
const DEVICE_PREVIEW_PANEL_OPEN = 'device-preview-panel-open';
const DEVICE_PREVIEW_TOOLBAR_COLLAPSED = 'device-preview-toolbar-collapsed';

(function () {
  installFrameVisualRuntime();
  installElementPickerRuntime();

  // 防止重复注入
  if ((window as any).__mearlInjected) {
    return;
  }
  (window as any).__mearlInjected = true;
  installWebsiteInstallationBridge();

  const isTopFrame = window.top === window;
  const phoneFrameBootstrap = isTopFrame
    ? readPhoneFrameBootstrap(
        (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
          ?.serverTiming,
      )
    : undefined;

  if (isTopFrame) installAccountAutoLoginCountdown(window.location.href);

  const appBridgeActive = listenAppBridgeRelay();
  const showProfileSettings = isTopFrame
    ? installAppBridgeConfigOverlay(appBridgeActive)
    : undefined;
  const deviceChromeManager = isTopFrame
    ? createQuickDeviceChromeManager({
        showProfileSettings,
        onSafeAreaMismatch() {
          void safeSendMessage({ action: 'quickDeviceSafeAreaChanged' });
        },
        previewPanel: {
          label: i18nMessage('devicePreviewPanel') || 'Debug',
          resizeLabel: i18nMessage('devicePreviewPanelResize') || 'Resize debug panel',
          unavailableLabel: i18nMessage('devicePreviewCaptureUnavailable') || 'Capture unavailable',
          retryLabel: i18nMessage('retry') || 'Retry',
          loadingLabel: i18nMessage('loading') || 'Loading…',
          toolbarLabel: i18nMessage('devicePreviewToolbar') || 'Device toolbar',
          initialLayout: phoneFrameBootstrap?.previewLayout,
          async requestToken(open, retryCapture) {
            const result = await safeSendMessage<{ success?: boolean; token?: string | null }>({
              action: 'devicePreviewPanelState',
              open,
              retryCapture,
            });
            if (!result?.success) {
              // Only a user-initiated retry may reload a document whose extension context is gone.
              if (retryCapture && !isExtensionContextValid()) window.location.reload();
              throw new Error('Device preview panel is unavailable');
            }
            return result.token ?? null;
          },
          url: (token, viewer) =>
            chrome.runtime.getURL(
              `src/pages/device-preview-panel/index.html?viewer=${viewer}#${token}`,
            ),
          subscribeReady(listener) {
            const onMessage = (message: { action?: string; viewer?: string }) => {
              if (
                message.action === 'devicePreviewPanelReady' &&
                typeof message.viewer === 'string'
              )
                listener(message.viewer);
            };
            chrome.runtime.onMessage.addListener(onMessage);
            return () => chrome.runtime.onMessage.removeListener(onMessage);
          },
          async loadLayout() {
            const result = await chrome.storage.local.get([
              DEVICE_PREVIEW_PANEL_OPEN,
              DEVICE_PREVIEW_PANEL_WIDTH,
              DEVICE_PREVIEW_TOOLBAR_COLLAPSED,
            ]);
            return {
              width: result[DEVICE_PREVIEW_PANEL_WIDTH],
              panelOpen: result[DEVICE_PREVIEW_PANEL_OPEN],
              toolbarCollapsed: result[DEVICE_PREVIEW_TOOLBAR_COLLAPSED] === true,
            };
          },
          saveWidth: width => {
            void chrome.storage.local.set({ [DEVICE_PREVIEW_PANEL_WIDTH]: width }).catch(() => {});
          },
          savePanelOpen: open => {
            void chrome.storage.local.set({ [DEVICE_PREVIEW_PANEL_OPEN]: open }).catch(() => {});
          },
          saveToolbarCollapsed: collapsed => {
            void chrome.storage.local
              .set({ [DEVICE_PREVIEW_TOOLBAR_COLLAPSED]: collapsed })
              .catch(() => {});
          },
        },
        async captureScreenshot() {
          const response = await safeSendMessage<{
            success?: boolean;
            data?: string;
            error?: unknown;
          }>({ action: 'appBridgeScreenshot' });
          if (response?.success !== true || typeof response.data !== 'string') {
            throw new Error(String(response?.error ?? 'screenshot failed'));
          }
          return { data: response.data };
        },
        showBridgeConfig(config) {
          window.postMessage(
            {
              source: 'mearl-app-bridge',
              type: 'showBridgeConfig',
              profile: config.profile,
              actions: config.actions,
              settings: config.settings,
              settingsUi: config.settingsUi,
              settingsGroup: config.settingsGroup,
              locale: chrome.i18n.getUILanguage(),
              language: config.language,
            },
            '*',
          );
        },
        labels: {
          screenshot: i18nMessage('agentCapGetScreenshot') || 'Screenshot',
          copied: i18nMessage('deviceChromeScreenshotCopied') || 'Copied',
          downloaded: i18nMessage('deviceChromeScreenshotDownloaded') || 'Downloaded',
          captureFailed: i18nMessage('deviceChromeScreenshotFailed') || 'Capture failed',
          bridgeConfig: i18nMessage('appBridgeConfig') || 'App simulation settings',
        },
      })
    : null;
  if (deviceChromeManager && isExtensionContextValid()) {
    window.addEventListener('message', event => {
      if (event.source !== window) return;
      const data = event.data as
        | {
            source?: unknown;
            type?: unknown;
            state?: Partial<QuickDeviceChromeAppState> & {
              bridgeConfig?: QuickDeviceChromeAppState['bridgeConfig'];
            };
          }
        | undefined;
      if (
        data?.source !== 'mearl-app-profile-runtime' ||
        data.type !== 'device-chrome-state' ||
        typeof data.state?.statusBarBackground !== 'string' ||
        typeof data.state.textColor !== 'string'
      ) {
        return;
      }
      deviceChromeManager.updateAppState({
        statusBarBackground: data.state.statusBarBackground,
        textColor: data.state.textColor,
        bridgeConfig:
          data.state.bridgeConfig && typeof data.state.bridgeConfig.profile === 'string'
            ? {
                profile: data.state.bridgeConfig.profile,
                actions: data.state.bridgeConfig.actions,
                settings: data.state.bridgeConfig.settings,
                settingsUi: data.state.bridgeConfig.settingsUi,
                settingsGroup: data.state.bridgeConfig.settingsGroup,
                language:
                  typeof data.state.bridgeConfig.language === 'string'
                    ? data.state.bridgeConfig.language
                    : undefined,
              }
            : null,
      });
    });
    if (phoneFrameBootstrap) deviceChromeManager.update(phoneFrameBootstrap.config);
    let receivedUpdate = false;
    let receivedProfileSettings = false;
    chrome.runtime.onMessage.addListener(message => {
      if (message.action === 'appProfileSettingsAvailability') {
        receivedProfileSettings = true;
        deviceChromeManager.updateProfileSettings(message.available === true);
        return;
      }
      if (message.action !== QUICK_DEVICE_CHROME_UPDATE_ACTION) return;
      receivedUpdate = true;
      deviceChromeManager.update(
        (message.config as QuickDeviceChromeConfig | null | undefined) ?? null,
      );
    });
    void safeSendMessage<{
      success?: boolean;
      config?: QuickDeviceChromeConfig | null;
      profileSettings?: boolean;
    }>({
      action: QUICK_DEVICE_CHROME_GET_ACTION,
    }).then(response => {
      if (!receivedProfileSettings)
        deviceChromeManager.updateProfileSettings(response?.profileSettings === true);
      if (receivedUpdate) return;
      const config = response?.success ? (response.config ?? null) : null;
      if (
        !phoneFrameBootstrap ||
        JSON.stringify(config) !== JSON.stringify(phoneFrameBootstrap.config)
      )
        deviceChromeManager.update(config);
    });
  }

  // 每个 frame 上报自身位置，由后台按发送方 tab 的环境决定是否补 CORS 规则。
  void safeSendMessage({ action: 'networkControlReportOrigin' });
  installInjectedMessageRelay(isTopFrame);

  // 页面加载时自动解析 dev rules 里的 \a 和 \b 占位符
  // 仅在主 frame 执行，避免 iframe 覆盖主页面解析结果
  if (isTopFrame) {
    safeSendMessage({
      action: 'autoApplyDevRules',
      url: window.location.href,
    });
  }

  if (!isTopFrame) {
    return;
  }

  // Agent 服务与悬浮入口开关启用、侧边栏关闭时才挂载按钮；Shadow DOM 用于隔离业务页面样式。
  let agentSidePanelToggle: ReturnType<typeof createAgentSidePanelToggle> | null = null;
  let agentServiceEnabled = false;
  let agentFloatingButtonEnabled = false;
  let agentSidePanelOpen: boolean | null = null;
  let floatingButtonConfigRevision = 0;
  let sidePanelStateRevision = 0;

  const mountAgentSidePanelToggle = () => {
    if (agentSidePanelToggle || !isExtensionContextValid()) return;
    agentSidePanelToggle = createAgentSidePanelToggle({
      label: i18nMessage('openAgentSidePanelFromPage') || 'Open Protocol side panel',
      async onOpen() {
        const response = await safeSendMessage<AgentSidePanelStateResponse>({
          action: OPEN_AGENT_SIDE_PANEL_FROM_PAGE_ACTION,
        });
        if (!response?.success) return;
        sidePanelStateRevision += 1;
        agentSidePanelOpen = response.open;
        syncAgentFloatingButton();
      },
    });
  };

  const syncAgentFloatingButton = () => {
    if (
      shouldShowAgentFloatingButton(
        agentServiceEnabled,
        agentFloatingButtonEnabled,
        agentSidePanelOpen,
      )
    ) {
      mountAgentSidePanelToggle();
      return;
    }
    agentSidePanelToggle?.destroy();
    agentSidePanelToggle = null;
  };

  const initialFloatingButtonConfigRevision = floatingButtonConfigRevision;
  safeStorageSyncGet<{ agentEnabled: boolean; agentFloatingButtonEnabled: boolean }>(
    { agentEnabled: true, agentFloatingButtonEnabled: false },
    result => {
      if (floatingButtonConfigRevision !== initialFloatingButtonConfigRevision) return;
      agentServiceEnabled = result.agentEnabled;
      agentFloatingButtonEnabled = result.agentFloatingButtonEnabled;
      syncAgentFloatingButton();
    },
  );

  const initialSidePanelStateRevision = sidePanelStateRevision;
  void safeSendMessage<AgentSidePanelStateResponse>({
    action: GET_AGENT_SIDE_PANEL_STATE_ACTION,
  }).then(response => {
    if (sidePanelStateRevision !== initialSidePanelStateRevision) return;
    agentSidePanelOpen = response?.success ? response.open : false;
    syncAgentFloatingButton();
  });

  if (isExtensionContextValid()) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (
        areaName !== 'sync' ||
        (changes.agentEnabled === undefined && changes.agentFloatingButtonEnabled === undefined)
      ) {
        return;
      }
      floatingButtonConfigRevision += 1;
      if (changes.agentEnabled !== undefined) {
        agentServiceEnabled = changes.agentEnabled.newValue !== false;
      }
      if (changes.agentFloatingButtonEnabled !== undefined) {
        agentFloatingButtonEnabled = changes.agentFloatingButtonEnabled.newValue === true;
      }
      syncAgentFloatingButton();
    });
  }

  // ==================== 日志捕获 (for MCP) ====================
  // 日志捕获通过 Debugger Log domain 获取
  // 无需预先开启"修改响应"功能

  // ==================== DNR 规则指示圆点 ====================
  const dnrIndicator = createDnrIndicatorManager({
    getIndicatorMode(callback) {
      safeStorageSyncGet<{ dnrIndicatorMode: DnrIndicatorMode }>(
        { dnrIndicatorMode: 'dot' },
        result => {
          callback(result.dnrIndicatorMode);
        },
      );
    },
    sendMessage(message) {
      void safeSendMessage(message);
    },
    getMessage: i18nMessage,
  });
  void safeSendMessage<{ rules?: DnrRule[] }>({ action: 'getDnrIndicatorRules' }).then(response => {
    dnrIndicator.updateDnrIndicator(response?.rules ?? []);
  });

  // ==================== 右键二维码识别（canvas/svg）====================
  let lastContextMenuTarget: Element | null = null;
  document.addEventListener('contextmenu', e => {
    lastContextMenuTarget = e.target as Element;
  });

  // ==================== 原有的消息监听 ====================

  // 监听来自 background 的 debugger 状态变化
  if (isExtensionContextValid()) {
    try {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (
          message.action === AGENT_SIDE_PANEL_STATE_CHANGED_ACTION &&
          typeof message.open === 'boolean'
        ) {
          sidePanelStateRevision += 1;
          agentSidePanelOpen = message.open;
          syncAgentFloatingButton();
          return;
        }

        if (message.action === 'pageTimeOverride') {
          deviceChromeManager?.updateTimeOverride(
            message.offsetMs === null ||
              (typeof message.offsetMs === 'number' && Number.isFinite(message.offsetMs))
              ? message.offsetMs
              : null,
            typeof message.revision === 'number' ? message.revision : 0,
          );
          window.postMessage(
            {
              source: 'mearl-content',
              type: 'PAGE_TIME_OVERRIDE',
              offsetMs: message.offsetMs,
              revision: message.revision,
            },
            '*',
          );
          sendResponse({ ok: true });
          return true;
        }

        if (message.action === 'debuggerAttached') {
          // debugger 已连接，启用 override
          window.postMessage(
            {
              source: 'mearl-content',
              type: 'UPDATE_OVERRIDE_ENABLED',
              enabled: true,
            },
            '*',
          );
        } else if (message.action === 'debuggerDetached') {
          // debugger 已断开，禁用 override
          window.postMessage(
            {
              source: 'mearl-content',
              type: 'UPDATE_OVERRIDE_ENABLED',
              enabled: false,
            },
            '*',
          );
        }

        if (message.action === 'getContextMenuTargetBounds') {
          if (lastContextMenuTarget) {
            const rect = lastContextMenuTarget.getBoundingClientRect();
            sendResponse({
              x: rect.x * devicePixelRatio,
              y: rect.y * devicePixelRatio,
              w: rect.width * devicePixelRatio,
              h: rect.height * devicePixelRatio,
            });
          } else {
            sendResponse(null);
          }
          return true;
        } else if (message.action === 'ping') {
          // 心跳检测：用于 panel 检测 content script 是否存活
          const topPage: ElementPickerPage = {
            url: window.location.href,
            title: document.title,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
            },
          };
          sendResponse({ alive: true, topPage });
          return true;
        } else if (message.action === 'updateDnrIndicator') {
          dnrIndicator.updateDnrIndicator((message.rules ?? []) as DnrRule[]);
        }
      });

      void safeSendMessage<{ offsetMs?: number | null; revision?: number }>({
        action: 'getPageTimeOverride',
      }).then(response => {
        if (!response || !Object.hasOwn(response, 'offsetMs')) return;
        deviceChromeManager?.updateTimeOverride(response.offsetMs ?? null, response.revision ?? 0);
        window.postMessage(
          {
            source: 'mearl-content',
            type: 'PAGE_TIME_OVERRIDE',
            offsetMs: response.offsetMs ?? null,
            revision: response.revision ?? 0,
          },
          '*',
        );
      });
    } catch {
      // ignore
    }
  }
})();

function installInjectedMessageRelay(isTopFrame: boolean): void {
  window.addEventListener('message', async event => {
    if (event.source === window && event.data && event.data.source === 'mearl-injected') {
      const message = event.data;
      if (!isTopFrame && (typeof message.type !== 'string' || !message.type.startsWith('SSE_'))) {
        return;
      }

      // 处理 injected.js 准备就绪消息
      if (message.type === 'READY') {
        // 初始化 override 开关状态
        const response = await safeSendMessage<{ tabId?: number }>({ action: 'getCurrentTab' });
        if (response?.tabId) {
          const debuggerResponse = await safeSendMessage<{ debuggerAttached?: boolean }>({
            action: 'getDebuggerStatus',
            tabId: response.tabId,
          });
          const enabled = debuggerResponse?.debuggerAttached || false;
          window.postMessage(
            {
              source: 'mearl-content',
              type: 'UPDATE_OVERRIDE_ENABLED',
              enabled,
            },
            '*',
          );
        }
        return;
      }

      // 处理 SSE override 查询请求
      if (message.type === 'QUERY_SSE_OVERRIDE') {
        const response = await safeSendMessage<{ tabId?: number }>({ action: 'getCurrentTab' });
        if (response?.tabId) {
          const tabId = response.tabId;

          // 获取 overrides（已 flatten，SSE 场景无 request body 不做条件匹配，取首个无条件的或第一条）
          const overridesResponse = await safeSendMessage<{
            overrides?: { url?: string; apiName: string; conditions?: Record<string, any> }[];
            apiName?: string | null;
          }>({
            action: 'getOverrides',
            tabId,
            url: message.url,
            requestBody: message.requestBody,
          });
          const overrides = overridesResponse?.overrides || [];
          const { url, requestId } = message;
          const apiName = overridesResponse?.apiName;

          const override = findSseOverride(overrides, { url, apiName });
          window.postMessage(
            {
              source: 'mearl-content',
              type: 'SSE_OVERRIDE_RESPONSE',
              requestId,
              override: override || null,
            },
            '*',
          );
        }
        return;
      }

      if (message.type === 'TRACE_RESULT' || message.type === 'TRACE_HIGHLIGHT_RESULT') {
        return;
      }

      // 转发其他消息到 background script
      const msg = { ...message, source: 'mearl-content-script' };
      safeSendMessage(msg);
    }
  });
}
