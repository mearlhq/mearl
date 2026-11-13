import type { AppProfileSetting } from '@mearl/browser-core';
import {
  installDeviceChromeView,
  type DeviceChromeViewController,
} from '@mearl/browser-core/deviceChromeView';
import type { QuickDeviceChromeConfig } from '../../shared/quickAppProfile';
import type { DevicePreviewLayout } from '../../shared/devicePreviewPanel';
import { createDevicePreviewToolbar, devicePreviewToolbarStyle } from './devicePreviewToolbar';

const HOST_ATTRIBUTE = 'data-mearl-quick-device-chrome';
const LAYOUT_STYLE_ATTRIBUTE = 'data-mearl-quick-device-layout';
const ROOT_WEBVIEW_SELECTOR = 'iframe[data-mearl-root-webview]';

export interface QuickDeviceChromeManager {
  update(config: QuickDeviceChromeConfig | null): void;
  updateAppState(state: QuickDeviceChromeAppState): void;
  updateProfileSettings(available: boolean): void;
  updateTimeOverride(offsetMs: number | null, revision: number): void;
  destroy(): void;
}

interface DeviceChromeBridgeConfig {
  settings?: AppProfileSetting[];
  settingsGroup?: string;
  settingsUi?: 'runtime';
  profile: string;
  actions?: unknown;
  language?: string;
}

export interface QuickDeviceChromeAppState {
  statusBarBackground: string;
  textColor: string;
  bridgeConfig?: DeviceChromeBridgeConfig | null;
}

interface QuickDeviceChromeManagerOptions {
  captureScreenshot?: () => Promise<{ data: string }>;
  onSafeAreaMismatch?: () => void;
  showBridgeConfig?: (config: DeviceChromeBridgeConfig) => void;
  showProfileSettings?: () => void;
  previewPanel?: {
    label: string;
    resizeLabel: string;
    unavailableLabel: string;
    retryLabel: string;
    loadingLabel: string;
    toolbarLabel: string;
    initialLayout?: DevicePreviewLayout;
    requestToken(open: boolean, retryCapture: boolean): Promise<string | null>;
    url(token: string, viewer: string): string;
    subscribeReady(listener: (viewer: string) => void): () => void;
    loadLayout(): Promise<Pick<DevicePreviewLayout, 'width' | 'toolbarCollapsed' | 'panelOpen'>>;
    savePanelOpen(open: boolean): void;
    saveWidth(width: number): void;
    saveToolbarCollapsed(collapsed: boolean): void;
  };
  labels?: {
    screenshot: string;
    copied: string;
    downloaded: string;
    captureFailed: string;
    bridgeConfig: string;
  };
}

const DEFAULT_DEVICE_CHROME_STATE: QuickDeviceChromeAppState = {
  statusBarBackground: '#ffffff',
  textColor: '#0f131a',
  bridgeConfig: null,
};

function normalizedBarHeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(200, Math.max(0, Math.round(value)));
}

function deviceLayoutMarkup(config: QuickDeviceChromeConfig): string {
  const statusBarHeight = normalizedBarHeight(config.statusBarHeight);
  const sideBarWidth = normalizedBarHeight(config.sideBarWidth ?? 0);
  const frame = config.phoneFrame;
  const frameStyle = frame ? phoneFrameMarkup(frame.width, frame.height) : '';
  return `:root {
    --mearl-quick-device-status-bar-height: ${statusBarHeight}px;
    --mearl-quick-device-side-bar-width: ${sideBarWidth}px;
  }
  [data-mearl-app-titlebar] {
    top: var(--mearl-quick-device-status-bar-height) !important;
    right: var(--mearl-quick-device-side-bar-width) !important;
  }
  [data-mearl-app-titlebar-spacer] {
    height: calc(var(--mearl-quick-device-status-bar-height) + var(--mearl-app-navigation-bar-height, 0px)) !important;
    min-height: calc(var(--mearl-quick-device-status-bar-height) + var(--mearl-app-navigation-bar-height, 0px)) !important;
  }
  [data-mearl-root-webview]:not([data-mearl-app-viewport-mode]) {
    top: var(--mearl-quick-device-status-bar-height) !important;
    height: calc(100% - var(--mearl-quick-device-status-bar-height)) !important;
  }
  [data-mearl-root-webview]:not([data-mearl-split-pane]) {
    right: var(--mearl-quick-device-side-bar-width) !important;
    width: calc(100% - var(--mearl-quick-device-side-bar-width)) !important;
  }
  [data-mearl-layer]:not([data-mearl-split-pane]) {
    right: var(--mearl-quick-device-side-bar-width) !important;
    width: calc(100% - var(--mearl-quick-device-side-bar-width)) !important;
  }
  [data-mearl-root-overlay] {
    right: var(--mearl-quick-device-side-bar-width) !important;
    width: calc(100% - var(--mearl-quick-device-side-bar-width)) !important;
  }
  [data-mearl-root-overlay-sheet] > [data-mearl-root-webview] {
    top: 0 !important;
    right: 0 !important;
    width: 100% !important;
    height: 100% !important;
  }
  [data-mearl-root-webview][data-mearl-split-pane="left"] {
    width: calc((100% - var(--mearl-quick-device-side-bar-width)) / 2) !important;
  }
  [data-mearl-layer][data-mearl-split-pane="right"] {
    left: calc((100% - var(--mearl-quick-device-side-bar-width)) / 2) !important;
    right: var(--mearl-quick-device-side-bar-width) !important;
    width: calc((100% - var(--mearl-quick-device-side-bar-width)) / 2) !important;
  }
  [data-mearl-app-viewport-mode="normal"] {
    top: calc(var(--mearl-quick-device-status-bar-height) + var(--mearl-app-navigation-bar-height, 0px)) !important;
    height: calc(100% - var(--mearl-quick-device-status-bar-height) - var(--mearl-app-navigation-bar-height, 0px)) !important;
  }
  [data-mearl-app-viewport-mode="status-inset"] {
    top: var(--mearl-quick-device-status-bar-height) !important;
    height: calc(100% - var(--mearl-quick-device-status-bar-height)) !important;
  }
  ${frameStyle}`;
}

const MIN_PANEL_WIDTH = 260;
const MIN_PREVIEW_WIDTH = 220;
const MIN_DOCKED_PREVIEW_WIDTH = 640;
const PREVIEW_CONTROL_INSET = 12;
const PREVIEW_CONTROL_SIZE = 28;
const TOOLBAR_SIDE_GUTTER = PREVIEW_CONTROL_INSET + PREVIEW_CONTROL_SIZE + 4;
const MIN_DEBUG_PREVIEW_WIDTH = 440;
const PANEL_COMMIT_TIMEOUT_MS = 300;
const PANEL_READY_TIMEOUT_MS = 4000;
const PANEL_LOADING_DELAY_MS = 180;
const STARTUP_VIEWPORT_SETTLE_MS = 180;
const STARTUP_VIEWPORT_HEIGHT_TOLERANCE = 12;

type PreviewViewport = NonNullable<DevicePreviewLayout['viewport']>;

export function readPhoneFrameBootstrap(
  timing: readonly Pick<PerformanceServerTiming, 'name' | 'description'>[] | undefined,
):
  | {
      config: QuickDeviceChromeConfig;
      previewLayout: DevicePreviewLayout;
    }
  | undefined {
  if (
    !timing?.some(
      entry => entry.name === 'mearl-document' || entry.name === 'mearl-device-shell-start',
    )
  )
    return;
  for (const entry of timing) {
    if (entry.name !== 'mearl-device-shell') continue;
    try {
      const bytes = Uint8Array.from(atob(entry.description), character => character.charCodeAt(0));
      const { version, config, previewLayout } = JSON.parse(new TextDecoder().decode(bytes));
      const frame = config?.phoneFrame;
      if (
        version !== 1 ||
        !frame ||
        !previewLayout ||
        typeof previewLayout !== 'object' ||
        ![frame.width, frame.height, frame.maxScale ?? 1].every(
          value => Number.isFinite(value) && value > 0,
        ) ||
        !['ios', 'android'].includes(config.platform) ||
        !['none', 'dynamic-island', 'notch', 'side-camera'].includes(config.cutout)
      )
        continue;
      return { config, previewLayout };
    } catch {
      // An invalid navigation header leaves initialization to the background response.
    }
  }
}

function readPreviewViewport(): PreviewViewport {
  return {
    width: document.documentElement?.clientWidth || window.innerWidth,
    height: document.documentElement?.clientHeight || window.innerHeight,
  };
}

function previewGeometry(
  { width, height }: PreviewViewport,
  open: boolean,
  requestedWidth?: number,
) {
  const stacked = width < MIN_DOCKED_PREVIEW_WIDTH;
  const maxPanelWidth = width - MIN_PREVIEW_WIDTH;
  const defaultWidth = Math.round(width * 0.6);
  const panelWidth =
    open && !stacked
      ? Math.min(maxPanelWidth, Math.max(MIN_PANEL_WIDTH, requestedWidth ?? defaultWidth))
      : 0;
  const panelHeight = open && stacked ? Math.round(height * 0.45) : 0;
  return {
    width: width - panelWidth,
    height: height - panelHeight,
    panelWidth,
    panelHeight,
    maxPanelWidth,
  };
}

function phoneFrameMarkup(width: number, height: number): string {
  const radius = Math.min(42, Math.min(width, height) * 0.1);
  return `
  :root {
    --mearl-phone-system-background: #fff;
    --mearl-phone-system-text: #0f131a;
    overflow: hidden !important;
    background: radial-gradient(ellipse at top, #f7f8fa, #e1e4e9) !important;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --mearl-phone-system-background: #1c1e23;
      --mearl-phone-system-text: #f5f6f8;
      background: radial-gradient(ellipse at top, #282b31, #15171b) !important;
    }
  }
  body {
    position: absolute !important;
    top: var(--mearl-phone-frame-top, 50%) !important;
    left: var(--mearl-phone-frame-left, 50%) !important;
    width: ${width}px !important;
    height: ${height}px !important;
    margin: 0 !important;
    border-radius: var(--mearl-device-frame-radius, ${radius}px) !important;
    overflow: hidden !important;
    background: var(--mearl-phone-system-background) !important;
    transform: translate(-50%, -50%) scale(var(--mearl-phone-frame-scale, 1)) !important;
    box-shadow: 0 0 0 8px #141619, 0 0 0 10px #3c4046, 0 16px 40px 10px #070a1345 !important;
  }`;
}

function createPreviewControls(
  options: NonNullable<QuickDeviceChromeManagerOptions['previewPanel']>,
  onChange: () => void,
  viewport: () => PreviewViewport,
  initialLayout?: DevicePreviewLayout,
) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483601 !important; pointer-events: none !important; color-scheme: light dark !important; }
    .debug-toggle, .toolbar-toggle, iframe { position: absolute; pointer-events: auto; box-sizing: border-box; }
    .debug-toggle, .toolbar-toggle { display: grid; place-items: center;
      width: ${PREVIEW_CONTROL_SIZE}px; height: ${PREVIEW_CONTROL_SIZE}px; padding: 0;
      border: 0; background: transparent; color: light-dark(#19212d, #ecedf2);
      cursor: pointer; }
    .debug-toggle { top: 10px; }
    .toolbar-toggle { top: 42px; }
    .debug-toggle[hidden] + .toolbar-toggle { top: 10px; }
    :is(.debug-toggle, .toolbar-toggle)[hidden] { display: none; }
    .debug-toggle[aria-expanded="true"] { color: light-dark(#2359d2, #96b5ff); }
    .panel-status { position: absolute; right: 0; bottom: 0; z-index: 1;
      display: grid; place-content: center; justify-items: center; gap: 8px; box-sizing: border-box;
      pointer-events: none; background: light-dark(#fff, #1c1f24);
      color: light-dark(#19212d, #ecedf2); font: 12px system-ui, sans-serif; }
    .panel-status[hidden] { display: none; }
    .panel-status[data-error="true"] { color: light-dark(#a52c32, #ff9698); }
    .panel-retry { pointer-events: auto; border: 0; border-radius: 4px; padding: 4px 8px;
      background: transparent; color: light-dark(#19212d, #ecedf2); font: inherit; cursor: pointer; }
    .panel-retry:hover { background: light-dark(#eef1f5, #2c323c); }
    .panel-retry:focus-visible { outline: 2px solid light-dark(#2359d2, #96b5ff); outline-offset: 2px; }
    .panel-status[data-error="false"]::before { content: ''; width: 16px; height: 16px;
      border: 2px solid light-dark(#dce1e8, #383e48); border-top-color: currentColor; border-radius: 50%;
      animation: panel-spinner 700ms linear infinite; }
    @keyframes panel-spinner { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .panel-status::before { animation: none !important; } }
    iframe { right: 0; bottom: 0; border: 0; background: light-dark(#fff, #1c1f24); }
    iframe[data-dock="right"] { border-left: 1px solid light-dark(#dce1e8, #383e48); }
    iframe[data-dock="bottom"] { border-top: 1px solid light-dark(#dce1e8, #383e48); }
    [role="separator"] { position: absolute; top: 0; bottom: 0; width: 9px; z-index: 1;
      pointer-events: auto; touch-action: none; cursor: col-resize; }
    [role="separator"]::after { content: ''; position: absolute; width: 2px; height: 24px;
      top: calc(50% - 12px); left: 4px; border-radius: 2px; background: light-dark(#a6b0bf, #687486); }
    [role="separator"]:focus-visible { outline: none; }
    [role="separator"]:focus-visible::after {
      outline: 1px solid light-dark(#64748b, #a6b0bf); outline-offset: 2px; }
    ${devicePreviewToolbarStyle}
  `;
  const button = document.createElement('button');
  button.className = 'debug-toggle';
  button.type = 'button';
  button.title = options.label;
  button.setAttribute('aria-label', options.label);
  button.innerHTML = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20v-9M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4zM14.12 3.88 16 2
      M21 21a4 4 0 0 0-3.81-4M21 5a4 4 0 0 1-3.55 3.97M22 13h-4M3 21a4 4 0 0 1 3.81-4
      M3 5a4 4 0 0 0 3.55 3.97M6 13H2M8 2l1.88 1.88M9 7.13V6a3 3 0 1 1 6 0v1.13"/>
  </svg>`;
  button.setAttribute('aria-expanded', 'false');
  const toolbarButton = document.createElement('button');
  toolbarButton.className = 'toolbar-toggle';
  toolbarButton.type = 'button';
  toolbarButton.title = options.toolbarLabel;
  toolbarButton.setAttribute('aria-label', options.toolbarLabel);
  toolbarButton.setAttribute('aria-expanded', 'false');
  toolbarButton.setAttribute('aria-controls', 'device-preview-toolbar');
  toolbarButton.innerHTML = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <path d="M4 7h5m4 0h7M4 12h10m4 0h2M4 17h2m4 0h10"/>
    <path d="M9 5v4m5 1v4m-8 1v4"/>
  </svg>`;
  const status = document.createElement('div');
  status.className = 'panel-status';
  status.hidden = true;
  const statusLabel = document.createElement('div');
  statusLabel.setAttribute('role', 'status');
  const retryButton = document.createElement('button');
  retryButton.className = 'panel-retry';
  retryButton.type = 'button';
  retryButton.textContent = options.retryLabel;
  retryButton.hidden = true;
  status.append(statusLabel, retryButton);
  const divider = document.createElement('div');
  divider.tabIndex = 0;
  divider.hidden = true;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', options.resizeLabel);
  divider.setAttribute('aria-valuemin', String(MIN_PANEL_WIDTH));
  const toolbar = createDevicePreviewToolbar(initialLayout?.toolbar);
  root.append(style, toolbar.element, button, toolbarButton, status, divider);
  let frame: HTMLIFrameElement | null = null;
  let viewer: string | null = null;
  let commitTimer: number | undefined;
  let readyTimer: number | undefined;
  let loadingTimer: number | undefined;
  let destroyed = false;
  let preferencesLoaded = initialLayout !== undefined;
  let panelOpen =
    typeof initialLayout?.panelOpen === 'boolean' ? initialLayout.panelOpen : undefined;
  const shouldOpen = (width: number) =>
    width >= MIN_DEBUG_PREVIEW_WIDTH &&
    (panelOpen ?? (preferencesLoaded && width >= MIN_DOCKED_PREVIEW_WIDTH));
  let open = shouldOpen(viewport().width);
  const showStatus = (label = '', isError = false) => {
    statusLabel.textContent = label;
    retryButton.hidden = !isError;
    status.dataset.error = String(isError);
    status.hidden = !open || !label;
  };
  let toolbarChanged = false;
  const validWidth = (width: unknown): width is number =>
    typeof width === 'number' && Number.isFinite(width) && width >= MIN_PANEL_WIDTH;
  const initialWidth = initialLayout?.width;
  let requestedWidth = validWidth(initialWidth) ? initialWidth : undefined;
  let drag: { pointerId: number; x: number; width: number } | undefined;
  const area = () => previewGeometry(viewport(), open, requestedWidth);
  toolbar.element.hidden = initialLayout?.toolbarCollapsed === true;
  if (!initialLayout) {
    void options
      .loadLayout()
      .catch((): Awaited<ReturnType<typeof options.loadLayout>> => ({}))
      .then(({ width, toolbarCollapsed, panelOpen: storedOpen }) => {
        if (destroyed) return;
        const hideToolbar = !toolbarChanged && toolbarCollapsed === true;
        const applyWidth = requestedWidth === undefined && validWidth(width);
        if (hideToolbar) toolbar.element.hidden = true;
        if (applyWidth) requestedWidth = width;
        if (panelOpen === undefined && typeof storedOpen === 'boolean') {
          panelOpen = storedOpen;
          if (!panelOpen) void request(false);
        }
        preferencesLoaded = true;
        onChange();
      });
  }

  const resize = () => {
    const { width: viewportWidth } = viewport();
    const nextOpen = shouldOpen(viewportWidth);
    if (open !== nextOpen) {
      open = nextOpen;
      if (open && !frame) void request(true);
    }
    const { panelWidth, panelHeight, maxPanelWidth } = area();
    status.hidden = !open || !statusLabel.textContent;
    status.style.width = panelWidth ? `${panelWidth}px` : '100%';
    status.style.height = panelHeight ? `${panelHeight}px` : '100%';
    button.hidden = viewportWidth < MIN_DEBUG_PREVIEW_WIDTH;
    toolbarButton.hidden = !toolbar.element.hidden;
    button.style.right = toolbarButton.style.right = `${panelWidth + PREVIEW_CONTROL_INSET}px`;
    button.setAttribute('aria-expanded', String(open));
    divider.hidden = panelWidth === 0;
    divider.style.right = `${panelWidth - 4}px`;
    divider.setAttribute('aria-valuenow', String(panelWidth));
    divider.setAttribute('aria-valuemax', String(maxPanelWidth));
    if (frame) {
      frame.hidden = !open;
      frame.style.width = panelWidth ? `${panelWidth}px` : '100%';
      frame.style.height = panelHeight ? `${panelHeight}px` : '100%';
      frame.dataset.dock = panelWidth ? 'right' : 'bottom';
    }
  };

  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    divider.focus();
    divider.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, x: event.clientX, width: area().panelWidth };
  });
  divider.addEventListener('pointermove', event => {
    if (drag?.pointerId !== event.pointerId) return;
    const { panelWidth, maxPanelWidth } = area();
    if (!panelWidth) return;
    requestedWidth = Math.min(
      maxPanelWidth,
      Math.max(MIN_PANEL_WIDTH, Math.round(drag.width + drag.x - event.clientX)),
    );
    onChange();
  });
  divider.addEventListener('lostpointercapture', () => {
    if (drag && requestedWidth !== undefined) options.saveWidth(requestedWidth);
    drag = undefined;
  });
  divider.addEventListener('keydown', event => {
    const { panelWidth, maxPanelWidth } = area();
    switch (event.key) {
      case 'ArrowLeft':
        requestedWidth = Math.min(maxPanelWidth, panelWidth + 20);
        break;
      case 'ArrowRight':
        requestedWidth = Math.max(MIN_PANEL_WIDTH, panelWidth - 20);
        break;
      case 'Home':
        requestedWidth = MIN_PANEL_WIDTH;
        break;
      case 'End':
        requestedWidth = maxPanelWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    options.saveWidth(requestedWidth);
    onChange();
  });

  const removeFrame = () => {
    window.clearTimeout(commitTimer);
    window.clearTimeout(readyTimer);
    frame?.remove();
    frame = null;
    viewer = null;
  };
  const mountFrame = (token: string, retry: boolean) => {
    removeFrame();
    const mounted = document.createElement('iframe');
    frame = mounted;
    viewer = crypto.getRandomValues(new Uint32Array(4)).join('-');
    mounted.name = '__mearl_preview_panel__';
    mounted.title = options.label;
    mounted.src = options.url(token, viewer);
    mounted.hidden = !open;
    root.appendChild(mounted);
    if (!retry) {
      // A committed extension document is cross-origin. An accessible blank document
      // is still the initial iframe and does not need the full renderer deadline.
      commitTimer = window.setTimeout(() => {
        if (open && frame === mounted && mounted.contentDocument?.URL === 'about:blank') {
          mountFrame(token, true);
          onChange();
        }
      }, PANEL_COMMIT_TIMEOUT_MS);
    }
    readyTimer = window.setTimeout(() => {
      if (!retry) {
        void request(true, { automaticRetry: true });
      } else {
        removeFrame();
        showStatus(options.unavailableLabel, true);
        onChange();
      }
    }, PANEL_READY_TIMEOUT_MS);
  };
  const request = async (
    enable: boolean,
    { automaticRetry = false, retryCapture = false } = {},
  ) => {
    if (button.disabled) return;
    button.disabled = true;
    if (!automaticRetry) {
      window.clearTimeout(loadingTimer);
      showStatus(retryCapture ? options.loadingLabel : '');
      if (enable && !retryCapture) {
        loadingTimer = window.setTimeout(
          () => showStatus(options.loadingLabel),
          PANEL_LOADING_DELAY_MS,
        );
      }
    }
    if (!enable) removeFrame();
    try {
      const token = await options.requestToken(enable, retryCapture);
      if (destroyed) return;
      if (enable) {
        if (!token) throw new Error('Device preview panel is unavailable');
        mountFrame(token, automaticRetry);
      }
    } catch {
      if (!destroyed && open === enable) {
        window.clearTimeout(loadingTimer);
        removeFrame();
        showStatus(options.unavailableLabel, true);
      }
    } finally {
      button.disabled = false;
      if (!destroyed) {
        onChange();
        if (!enable && open && !frame) void request(true);
      }
    }
  };
  retryButton.addEventListener('click', event => {
    if (event.isTrusted && open && !retryButton.hidden) void request(true, { retryCapture: true });
  });
  button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    panelOpen = !open;
    options.savePanelOpen(panelOpen);
    if (!panelOpen) {
      open = false;
      void request(false);
    }
    onChange();
  });
  const setToolbarCollapsed = (event: MouseEvent, collapsed: boolean) => {
    if (!event.isTrusted) return;
    toolbarChanged = true;
    toolbar.element.hidden = collapsed;
    options.saveToolbarCollapsed(collapsed);
    onChange();
    (collapsed ? toolbarButton : toolbar.collapseButton).focus();
  };
  toolbarButton.addEventListener('click', event => setToolbarCollapsed(event, false));
  toolbar.collapseButton.addEventListener('click', event => setToolbarCollapsed(event, true));
  const receivePanelMessage = (event: MessageEvent) => {
    if (!frame || !event.isTrusted || event.source !== frame.contentWindow) return;
    const { protocol, host } = new URL(frame.src);
    if (event.origin !== `${protocol}//${host}`) return;
    if (event.data?.type === 'mearl-device-preview-reconnect') void request(true);
  };
  const unsubscribeReady = options.subscribeReady(readyViewer => {
    if (readyViewer !== viewer) return;
    window.clearTimeout(commitTimer);
    window.clearTimeout(readyTimer);
    window.clearTimeout(loadingTimer);
    showStatus();
  });
  window.addEventListener('message', receivePanelMessage);
  resize();
  if (open) void request(true);
  else if (panelOpen === false) void request(false);

  return {
    host,
    resize,
    area,
    toolbar,
    destroy() {
      destroyed = true;
      window.clearTimeout(loadingTimer);
      window.removeEventListener('message', receivePanelMessage);
      unsubscribeReady();
      removeFrame();
      host.remove();
    },
  };
}

/** 系统状态区与 WebView 相邻，底部操作区覆盖 WebView 并由页面安全区避让。 */
export function createQuickDeviceChromeManager(
  options: QuickDeviceChromeManagerOptions = {},
): QuickDeviceChromeManager {
  let config: QuickDeviceChromeConfig | null = null;
  let appState = DEFAULT_DEVICE_CHROME_STATE;
  let profileSettings = false;
  let host: HTMLElement | null = null;
  let layoutStyle: HTMLStyleElement | null = null;
  let view: DeviceChromeViewController | null = null;
  let layoutActive = false;
  let remountTimer: number | null = null;
  let healthTimer: number | null = null;
  let destroyed = false;
  let timeOffsetMs: number | null = null;
  let timeRevision = -1;
  let previewControls: ReturnType<typeof createPreviewControls> | null = null;
  let initialPreviewLayout = options.previewPanel?.initialLayout;
  let startupViewport = initialPreviewLayout?.viewport;
  let viewportSettleTimer: number | undefined;
  let safeAreaObserver: ResizeObserver | undefined;

  const isTopFrame = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  const sharedViewState = () => {
    const useFrameColors = config?.phoneFrame && appState === DEFAULT_DEVICE_CHROME_STATE;
    return {
      statusBarBackground: useFrameColors
        ? 'var(--mearl-phone-system-background)'
        : appState.statusBarBackground,
      textColor: useFrameColors ? 'var(--mearl-phone-system-text)' : appState.textColor,
      bottomActionEnabled: Boolean(
        (profileSettings && options.showProfileSettings) ||
        (appState.bridgeConfig && options.showBridgeConfig),
      ),
      timeOffsetMs,
    };
  };

  const ensureHost = (): HTMLElement => {
    if (host) return host;
    host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, '');
    host.attachShadow({ mode: 'open' });
    return host;
  };

  const ensureLayoutStyle = (): HTMLStyleElement => {
    if (layoutStyle) return layoutStyle;
    layoutStyle = document.createElement('style');
    layoutStyle.setAttribute(LAYOUT_STYLE_ATTRIBUTE, '');
    return layoutStyle;
  };

  const viewport = (): PreviewViewport => {
    const actual = readPreviewViewport();
    if (
      startupViewport?.width === actual.width &&
      Math.abs(startupViewport.height - actual.height) <= STARTUP_VIEWPORT_HEIGHT_TOLERANCE
    ) {
      return startupViewport;
    }
    return actual;
  };

  const resizePhoneFrame = () => {
    previewControls?.resize();
    const frame = config?.phoneFrame;
    const rule = layoutStyle?.sheet?.cssRules[0] as CSSStyleRule | undefined;
    if (!frame || !rule) return;
    const { width, height, panelWidth, panelHeight } =
      previewControls?.area() ?? previewGeometry(viewport(), false);
    const toolbar = previewControls?.toolbar;
    const gutter =
      viewport().width >= MIN_DEBUG_PREVIEW_WIDTH ? TOOLBAR_SIDE_GUTTER : PREVIEW_CONTROL_INSET;
    const toolbarMaxWidth = width - 2 * gutter;
    const compact = toolbarMaxWidth < 318;
    const toolbarSpace = toolbar && !toolbar.element.hidden ? (compact ? 72 : 42) : 0;
    const centerY = (height + toolbarSpace) / 2;
    const scale = Math.min(
      frame.maxScale ?? 1,
      Math.max(
        0.01,
        Math.min((width - 48) / frame.width, (height - 48 - toolbarSpace) / frame.height),
      ),
    );
    if (toolbar) {
      toolbar.element.classList.toggle('compact', compact);
      toolbar.element.style.left = `${width / 2}px`;
      toolbar.element.style.top = `${centerY - (frame.height * scale) / 2 - 16}px`;
      toolbar.element.style.maxWidth = `${toolbarMaxWidth}px`;
      toolbar.updateLayout(width, height);
    }
    rule.style.setProperty('--mearl-phone-frame-left', panelWidth ? `${width / 2}px` : '50%');
    rule.style.setProperty(
      '--mearl-phone-frame-top',
      startupViewport || toolbarSpace || panelHeight ? `${centerY}px` : '50%',
    );
    rule.style.setProperty('--mearl-phone-frame-scale', String(scale));
  };

  const onViewportResize = () => {
    if (startupViewport) {
      // Chrome can report transient heights while replacing the top-level renderer.
      window.clearTimeout(viewportSettleTimer);
      viewportSettleTimer = window.setTimeout(() => {
        startupViewport = undefined;
        resizePhoneFrame();
      }, STARTUP_VIEWPORT_SETTLE_MS);
    }
    resizePhoneFrame();
  };

  const mount = (allowRetry = true): void => {
    if (destroyed || !isTopFrame) return;
    if (!document.querySelector(ROOT_WEBVIEW_SELECTOR)) {
      host?.remove();
      layoutStyle?.remove();
      if (config && allowRetry && remountTimer === null) {
        remountTimer = window.setTimeout(() => {
          remountTimer = null;
          mount(false);
        }, 0);
      }
      return;
    }
    let layoutAttached = false;
    if (layoutActive && document.head) {
      const currentLayoutStyle = ensureLayoutStyle();
      if (currentLayoutStyle.parentNode !== document.head) {
        document.head.appendChild(currentLayoutStyle);
        layoutAttached = true;
      }
    }
    if (config && document.body) {
      const currentHost = ensureHost();
      if (currentHost.parentNode !== document.body) document.body.appendChild(currentHost);
    }
    if (config?.phoneFrame && options.previewPanel) {
      if (!previewControls) {
        previewControls = createPreviewControls(
          options.previewPanel,
          resizePhoneFrame,
          viewport,
          initialPreviewLayout,
        );
        initialPreviewLayout = undefined;
      }
      if (previewControls.host.parentNode !== document.documentElement) {
        document.documentElement.appendChild(previewControls.host);
      }
    }
    if (layoutAttached) onViewportResize();
  };

  const observer = new MutationObserver(() => mount());
  if (isTopFrame) observer.observe(document, { childList: true, subtree: true });

  if (isTopFrame) window.addEventListener('resize', onViewportResize);

  const stopHealthCheck = (): void => {
    if (healthTimer === null) return;
    window.clearInterval(healthTimer);
    healthTimer = null;
  };

  const startHealthCheck = (): void => {
    if (healthTimer !== null || !isTopFrame) return;
    // 部分 WebView 在整体替换 documentElement 时不会可靠派发 document 级 mutation。
    healthTimer = window.setInterval(() => {
      if (!config || destroyed) return;
      if (!host?.isConnected || (layoutActive && !layoutStyle?.isConnected)) mount(false);
    }, 250);
  };

  return {
    update(nextConfig) {
      if (destroyed || !isTopFrame) return;
      config = nextConfig;
      safeAreaObserver?.disconnect();
      safeAreaObserver = undefined;
      if (!config?.phoneFrame) {
        previewControls?.destroy();
        previewControls = null;
        startupViewport = undefined;
        window.clearTimeout(viewportSettleTimer);
      }
      if (!config) {
        appState = DEFAULT_DEVICE_CHROME_STATE;
        layoutActive = false;
        if (remountTimer !== null) window.clearTimeout(remountTimer);
        remountTimer = null;
        stopHealthCheck();
        view?.destroy();
        view = null;
        host?.remove();
        layoutStyle?.remove();
        layoutStyle = null;
        return;
      }

      layoutActive = true;
      ensureLayoutStyle().textContent = deviceLayoutMarkup(config);
      const currentHost = ensureHost();
      currentHost.setAttribute(HOST_ATTRIBUTE, config.platform);
      view?.destroy();
      view = installDeviceChromeView(currentHost.shadowRoot!, config, {
        captureScreenshot: options.captureScreenshot,
        onBottomAction: () => {
          const bridgeConfig = appState.bridgeConfig;
          if (bridgeConfig?.settingsUi === 'runtime' && options.showBridgeConfig)
            options.showBridgeConfig(bridgeConfig);
          else if (profileSettings && options.showProfileSettings) options.showProfileSettings();
          else if (bridgeConfig) options.showBridgeConfig?.(bridgeConfig);
        },
        labels: options.labels
          ? {
              screenshot: options.labels.screenshot,
              copied: options.labels.copied,
              downloaded: options.labels.downloaded,
              captureFailed: options.labels.captureFailed,
              bottomAction: options.labels.bridgeConfig,
            }
          : undefined,
        initialState: sharedViewState(),
      });
      const captureStyle = document.createElement('style');
      captureStyle.textContent =
        ':host { display: var(--mearl-device-chrome-display, block) !important; }';
      currentHost.shadowRoot!.append(captureStyle);
      if (config.phoneFrame && options.onSafeAreaMismatch && typeof ResizeObserver === 'function') {
        const { top, right, bottom, left } = config.safeAreaInsets;
        const expectedWidth = left + (config.sideBarWidth ? 0 : right);
        const probe = document.createElement('span');
        // DevTools can change the native env() values without resizing the shell viewport.
        probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;
          width:calc(env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px));
          height:calc(env(safe-area-inset-top, 0px) + env(safe-area-inset-bottom, 0px));`;
        currentHost.shadowRoot!.append(probe);
        const observer = new ResizeObserver(([entry]) => {
          if (safeAreaObserver !== observer || !entry || !probe.isConnected) return;
          const { width, height } = entry.contentRect;
          if (width !== expectedWidth || height !== top + bottom) options.onSafeAreaMismatch?.();
        });
        safeAreaObserver = observer;
        observer.observe(probe);
      }
      void previewControls?.toolbar.refresh();
      mount();
      resizePhoneFrame();
      startHealthCheck();
    },
    updateAppState(nextState) {
      if (destroyed || !isTopFrame) return;
      appState = nextState;
      view?.updateState(sharedViewState());
    },
    updateProfileSettings(available) {
      if (destroyed || !isTopFrame) return;
      profileSettings = available;
      view?.updateState(sharedViewState());
    },
    updateTimeOverride(nextOffsetMs, revision) {
      if (
        destroyed ||
        !isTopFrame ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        revision < timeRevision ||
        (nextOffsetMs !== null && !Number.isFinite(nextOffsetMs))
      ) {
        return;
      }
      timeOffsetMs = nextOffsetMs;
      timeRevision = revision;
      view?.updateState({ timeOffsetMs });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      previewControls?.destroy();
      previewControls = null;
      config = null;
      appState = DEFAULT_DEVICE_CHROME_STATE;
      observer.disconnect();
      safeAreaObserver?.disconnect();
      safeAreaObserver = undefined;
      window.removeEventListener('resize', onViewportResize);
      window.clearTimeout(viewportSettleTimer);
      if (remountTimer !== null) window.clearTimeout(remountTimer);
      remountTimer = null;
      stopHealthCheck();
      view?.destroy();
      view = null;
      host?.remove();
      layoutStyle?.remove();
      host = null;
      layoutStyle = null;
      layoutActive = false;
      timeOffsetMs = null;
      timeRevision = -1;
    },
  };
}
