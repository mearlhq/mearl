// 早期注入脚本（MAIN world，document_start）
// 通过 Server-Timing 响应头同步获取配置，确保在页面 JS 执行前生效

import { interceptEventSource } from './injected/eventSource';
import { interceptFetch, listenForOverrideMessages } from './injected/fetch';
import { interceptXHR } from './injected/xhr';
import { collectElementData, installElementCollectorBridge } from './injected/collectElement';
import { hookWindowOpen } from './injected/windowOpen';
import { installNetworkRoutes, readInjectedNetworkRoutes } from './injected/networkRoutes';
import type { NetworkRoutePlan } from '@mearl/preset/networkRoutes';
import { applyPageTimeOverride, listenForPageTimeOverride } from './injected/pageTime';
import type { InjectedAppProfileConfig } from '@mearl/browser-core/appProfileRuntime';

interface DeviceShellBootstrapConfig {
  platform: 'ios' | 'android';
  statusBarHeight: number;
  bottomBarHeight: number;
  sideBarWidth?: number;
  safeAreaInsets: { top: number; right: number; bottom: number; left: number };
  cutout: 'none' | 'dynamic-island' | 'notch' | 'side-camera';
}

/** 通用设备外壳使用的根 WebView。 */
function installDeviceShellRootWebView(): void {
  if (
    window !== window.top ||
    !/^https?:$/i.test(location.protocol) ||
    !/^(text\/html|application\/xhtml\+xml)$/i.test(document.contentType) ||
    document.documentElement?.hasAttribute('data-mearl-device-shell')
  )
    return;
  const businessUrl = location.href;
  try {
    const shellRoot = document.createElement('html');
    const shellHead = document.createElement('head');
    const charset = document.createElement('meta');
    const viewport = document.createElement('meta');
    const title = document.createElement('title');
    const shellBody = document.createElement('body');
    const frame = document.createElement('iframe');

    shellRoot.setAttribute('data-mearl-device-shell', '');
    shellBody.setAttribute('data-mearl-device-shell', '');
    charset.setAttribute('charset', 'utf-8');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width,initial-scale=1,viewport-fit=cover';
    shellHead.append(charset, viewport, title);
    shellRoot.append(shellHead, shellBody);
    shellRoot.style.cssText = 'width:100%;height:100%;margin:0;overflow:hidden;background:#fff;';
    shellBody.style.cssText = 'width:100%;height:100%;margin:0;overflow:hidden;background:#fff;';

    frame.name = '__mearl_root__';
    frame.setAttribute('data-mearl-root-webview', 'device-shell');
    frame.style.cssText =
      'position:fixed;left:0;right:0;top:0;bottom:0;width:100%;height:100%;border:0;display:block;background:#fff;z-index:0;';
    shellBody.appendChild(frame);

    const currentRoot = document.documentElement;
    if (currentRoot) document.replaceChild(shellRoot, currentRoot);
    else document.appendChild(shellRoot);
    if (typeof window.stop === 'function') window.stop();
    frame.src =
      (
        window as Window & { __mearlRootDocumentUrl__?: (url: string) => string }
      ).__mearlRootDocumentUrl__?.(businessUrl) ?? businessUrl;
  } catch (error) {
    console.warn('[Mearl Device Shell] 根 WebView 创建失败，保留当前页面', error);
  }
}

// 配置就绪后的初始化逻辑
function initInterception(config: {
  language: string;
  sseMonitoringEnabled: boolean;
  networkRoutes?: NetworkRoutePlan;
}) {
  // 全局开关：是否启用 override 功能（默认关闭）
  if (typeof window.__MEARL_OVERRIDE_ENABLED__ === 'undefined') {
    window.__MEARL_OVERRIDE_ENABLED__ = false;
  }

  // 保存配置供其他模块使用
  window.__mearlConfig = {
    language: config.language || 'zh_CN',
    sseMonitoringEnabled: config.sseMonitoringEnabled !== false,
  };

  // 环境切换：在 fetch/XHR 劫持之前安装，使 URL 改写发生在最内层（最接近网络），
  // 这样既能改写网关域名，又不影响上层 interceptFetch 对原始 URL 的匹配逻辑。
  if (config.networkRoutes) {
    installNetworkRoutes(config.networkRoutes);

  }

  // 初始化各个模块
  listenForOverrideMessages();

  // fetch 劫持必须无条件安装：它同时承担 fetch-based SSE 的 mock override，
  // 不应被 sseMonitoringEnabled 关闭。SSE 响应上报分支的开关判断下沉到 fetch.ts 内部。
  interceptFetch();

  // EventSource / XHR 劫持仅用于 SSE 实时监听，受开关直接控制即可
  // （需在 envSwitch 之后安装，使 URL 改写位于最内层，不影响实时 URL 归一化与去重）
  if (config.sseMonitoringEnabled !== false) {
    interceptEventSource();
    interceptXHR();
  }


  // 通知 content script 已准备好
  window.postMessage(
    {
      source: 'mearl-injected',
      type: 'READY',
    },
    '*',
  );
}

(function () {
  'use strict';

  // 防止重复注入：early-inject 可能被静态 manifest 与动态 registerContentScripts 各注入一次，
  // 同一 MAIN world 执行两次会重复劫持 fetch/EventSource（导致 SSE 记录重复）。
  if (window.__mearlEarlyInjected) {
    return;
  }
  window.__mearlEarlyInjected = true;
  listenForPageTimeOverride();

  // ─── Read Server-Timing flags from navigation response ──────────────────
  // DNR rules inject Server-Timing headers that we read synchronously at
  // document_start to configure page-level behaviour.
  //
  // Configuration channels：
  // - mearl-config：base64(JSON) of { sse?: boolean }，全局 SSE 配置
  // - mearl-tab-page-override：当前 tab 的页面级配置，用于自定义 User-Agent 和时间
  // - mearl-collect：仅特定 tabIds 注入，值恒为 "1"，用于 Agent 采集模式
  // - mearl-agent-chat-tabs：允许统一对话内的页面保留原生新开窗口行为
  const CONFIG_SERVER_TIMING_KEY = 'mearl-config';
  const NETWORK_ROUTES_SERVER_TIMING_KEY = 'mearl-network-routes';
  const TAB_PAGE_OVERRIDE_SERVER_TIMING_KEY = 'mearl-tab-page-override';
  const COLLECT_SERVER_TIMING_KEY = 'mearl-collect';
  const AGENT_CHAT_ALLOW_NEW_TABS_SERVER_TIMING_KEY = 'mearl-agent-chat-tabs';
  const APP_PROFILE_SERVER_TIMING_KEY = 'mearl-app-profile';
  const DEVICE_SHELL_SERVER_TIMING_KEY = 'mearl-device-shell';

  let shouldCollect = false;
  let allowAgentChatNewTabs = false;
  let appProfileConfig: InjectedAppProfileConfig | null = null;
  let deviceShellConfig: DeviceShellBootstrapConfig | null = null;
  let deviceShellSplitScreen = false;
  // SSE 监听默认启用，Server-Timing 里明确 sse: false 时才禁用
  let sseMonitoringEnabled = true;
  // 环境切换目标：仅当配置启用时存在
  let networkRoutes: NetworkRoutePlan | undefined;

  const navEntries = performance.getEntriesByType('navigation');
  if (navEntries.length > 0) {
    const nav = navEntries[0] as PerformanceNavigationTiming;
    for (const timing of nav.serverTiming) {
      // 全局 SSE 配置
      if (timing.name === CONFIG_SERVER_TIMING_KEY && timing.description) {
        try {
          const json = decodeURIComponent(escape(atob(timing.description)));
          const cfg = JSON.parse(json) as { sse?: boolean };

          if (typeof cfg.sse === 'boolean') {
            sseMonitoringEnabled = cfg.sse;
          }
        } catch {
          // 解析失败保持默认
        }
      }

      if (timing.name === NETWORK_ROUTES_SERVER_TIMING_KEY && timing.description) {
        networkRoutes = readInjectedNetworkRoutes(timing.description);
      }


      if (timing.name === TAB_PAGE_OVERRIDE_SERVER_TIMING_KEY && timing.description) {
        try {
          const json = decodeURIComponent(escape(atob(timing.description)));
          const cfg = JSON.parse(json) as {
            ua?: string;
            time?: { offsetMs?: unknown; revision?: unknown };
          };
          const offsetMs = cfg.time?.offsetMs;
          const revision = cfg.time?.revision;
          if (
            typeof offsetMs === 'number' &&
            Number.isFinite(offsetMs) &&
            typeof revision === 'number' &&
            Number.isSafeInteger(revision) &&
            revision >= 0
          ) {
            applyPageTimeOverride(offsetMs, revision);
          }
          if (cfg.ua) {
            const ua = cfg.ua;
            Object.defineProperty(navigator, 'userAgent', {
              get: () => ua,
              configurable: true,
            });
          }
        } catch {
          // 解析失败保持原生 User-Agent
        }
      }

      // Request collection flag — hook window.open
      if (timing.name === COLLECT_SERVER_TIMING_KEY) {
        shouldCollect = true;
      }
      if (timing.name === AGENT_CHAT_ALLOW_NEW_TABS_SERVER_TIMING_KEY) {
        allowAgentChatNewTabs = true;
      }

      // App 容器模拟配置（per-tab，由 set_app_profile / tab_open appProfile 下发）
      if (timing.name === APP_PROFILE_SERVER_TIMING_KEY && timing.description) {
        try {
          const payload = JSON.parse(decodeURIComponent(escape(atob(timing.description)))) as {
            version: 1;
            config: InjectedAppProfileConfig;
          };
          if (payload.version === 1 && payload.config) appProfileConfig = payload.config;
        } catch {
          // 解析失败跳过容器模拟
        }
      }

      if (timing.name === DEVICE_SHELL_SERVER_TIMING_KEY && timing.description) {
        try {
          const decoded = JSON.parse(decodeURIComponent(escape(atob(timing.description)))) as {
            version?: unknown;
            config?: DeviceShellBootstrapConfig;
            splitScreen?: unknown;
          };
          if (decoded.version === 1 && decoded.config) {
            deviceShellConfig = decoded.config;
            deviceShellSplitScreen = decoded.splitScreen === true;
          }
        } catch {
          // 配置损坏时保留普通页面，避免只出现半个设备外壳。
        }
      }
    }
  }

  window.__MEARL_AGENT_CHAT_ALLOW_NEW_TABS__ = allowAgentChatNewTabs;

  // ─── window.open hook (collection mode only) ────────────────────────────
  // When this tab is in Agent collection mode, convert window.open(url) into
  // a same-tab navigation (location.href = url). This ensures the existing
  // CDP debugger session captures all requests — no new tab, no timing issues.
  if (shouldCollect) {
    hookWindowOpen();
  }

  // ─── App 容器模拟 ───
  // 在采集 hook 之后安装：容器运行时自己接管 window.open（同步为 top 真实导航），
  // 并绕过采集模式的同页跳转逻辑。
  if (appProfileConfig) {
    // Bound bridge runtimes can reuse the host's WebView when they do not manage a container.
    if (deviceShellConfig && appProfileConfig.pageRuntime && window === window.top) {
      Object.defineProperty(window, '__mearlInstallDeviceShellRootWebView__', {
        configurable: true,
        value: installDeviceShellRootWebView,
      });
    }
    const rootContainer = appProfileConfig.rootContainer;
    const duoPreset = appProfileConfig.deviceAppearance?.preset;
    const duoOrientation = appProfileConfig.deviceAppearance?.orientation;
    const duoSideRail = deviceShellConfig
      ? (deviceShellConfig.sideBarWidth ?? 0)
      : duoPreset === 'iphone-duo-folded' ||
          (duoPreset === 'iphone-duo-unfolded' && duoOrientation === 'landscape')
        ? 84
        : 0;
    appProfileConfig = deviceShellConfig
      ? {
          ...appProfileConfig,
          statusBarHeight: deviceShellConfig.statusBarHeight,
          safeAreaInsets:
            window === window.top || !duoSideRail
              ? deviceShellConfig.safeAreaInsets
              : { ...deviceShellConfig.safeAreaInsets, right: 0 },
          deviceAppearance: {
            preset: appProfileConfig.deviceAppearance?.preset ?? 'iphone-17-pro',
            orientation: appProfileConfig.deviceAppearance?.orientation ?? 'portrait',
            cutout: deviceShellConfig.cutout,
          },
          rootContainer: {
            ...rootContainer,
            enabled: true,
            splitScreen: deviceShellSplitScreen,
          },
          simulateSystemBars: true,
          externalDeviceChrome: true,
        }
      : {
          ...appProfileConfig,
          safeAreaInsets:
            window !== window.top && duoSideRail && appProfileConfig.safeAreaInsets
              ? { ...appProfileConfig.safeAreaInsets, right: 0 }
              : appProfileConfig.safeAreaInsets,
          rootContainer: { ...rootContainer, enabled: false },
          simulateSystemBars: false,
          externalDeviceChrome: false,
        };
    window.__mearlInstallAppProfileRuntime__(appProfileConfig);
    if (window !== window.top && duoSideRail) {
      // 业务 WebView 的宽度已扣除侧栏，右侧安全区变量在其内部为零。
      const installSideRailSafeArea = (): boolean => {
        const root = document.documentElement;
        if (!root) return false;
        const style = document.createElement('style');
        style.textContent = ':root { --safe-area-inset-right: 0px !important; }';
        root.appendChild(style);
        return true;
      };
      if (!installSideRailSafeArea()) {
        const observer = new MutationObserver(() => {
          if (installSideRailSafeArea()) observer.disconnect();
        });
        observer.observe(document, { childList: true });
      }
    }
  }
  // Basic UA profiles use the built-in device shell; bound runtimes own their App container.
  if (deviceShellConfig && !appProfileConfig?.pageRuntime) {
    installDeviceShellRootWebView();
  }

  // DevTools panel 可通过 inspectedWindow.eval 调用：window.__mearl_collectElement($0)
  window.__mearl_collectElement = collectElementData;
  installElementCollectorBridge();

  // 读取无时序要求的配置，由 panel 连接时异步写入 sessionStorage。
  // Server-Timing 是 document_start 同步通道的首选；sessionStorage 作为兜底，
  // 处理 Server-Timing 不可用的场景（如 about:blank iframe、被 CSP 剥离响应头等），
  // 同时也是下一次导航前纠正用户刚刚变更过的配置的可靠来源。
  let language = 'zh_CN';
  try {
    const storedConfig = sessionStorage.getItem('__mearl_config__');
    if (storedConfig) {
      const parsed = JSON.parse(storedConfig);
      if (parsed && typeof parsed.language === 'string') {
        language = parsed.language;
      }
      // sessionStorage 里明确给出时以它为准，避免 Server-Timing 未命中时被强制默认为 true
      if (parsed && typeof parsed.sseMonitoringEnabled === 'boolean') {
        sseMonitoringEnabled = parsed.sseMonitoringEnabled;
      }
    }
  } catch {
    // 解析失败，使用默认值
  }

  // 不依赖 panel 是否已打开，直接基于 Server-Timing / sessionStorage 决定拦截行为
  initInterception({ language, sseMonitoringEnabled, networkRoutes });
})();
