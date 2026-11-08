// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickDeviceChromeManager, readPhoneFrameBootstrap, type QuickDeviceChromeManager } from '../deviceChrome';
import { createDevicePreviewToolbar } from '../devicePreviewToolbar';

const iosConfig = {
  platform: 'ios',
  statusBarHeight: 47,
  bottomBarHeight: 34,
  safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
  cutout: 'dynamic-island',
} as const;

const androidConfig = {
  platform: 'android',
  statusBarHeight: 24,
  bottomBarHeight: 24,
  safeAreaInsets: { top: 24, right: 0, bottom: 24, left: 0 },
  cutout: 'none',
} as const;

const chromeHosts = (): NodeListOf<HTMLElement> =>
  document.querySelectorAll<HTMLElement>('[data-mearl-quick-device-chrome]');
const layoutStyle = (): HTMLStyleElement | null =>
  document.querySelector<HTMLStyleElement>('[data-mearl-quick-device-layout]');

describe('Quick device chrome', () => {
  let manager: QuickDeviceChromeManager;

  beforeEach(() => {
    document.documentElement.innerHTML =
      '<head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><iframe data-mearl-root-webview></iframe></body>';
    manager = createQuickDeviceChromeManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it('renders iOS status indicators, Dynamic Island and gesture indicator in Shadow DOM', () => {
    manager.update(iosConfig);

    const host = chromeHosts()[0]!;
    const shadow = host.shadowRoot!;
    expect(chromeHosts()).toHaveLength(1);
    expect(host).not.toHaveAttribute('aria-hidden');
    expect(host).not.toHaveAttribute('inert');
    expect(shadow.getElementById('device-chrome')).toHaveAttribute('data-platform', 'ios');
    expect(shadow.getElementById('status-bar')).toBeTruthy();
    expect(shadow.getElementById('status-bar')).toHaveStyle({
      display: 'block',
      background: '#ffffff',
    });
    expect(shadow.getElementById('device-chrome')).toHaveStyle({ color: '#0f131a' });
    expect(shadow.getElementById('time')).toHaveTextContent(/^\d{2}:\d{2}$/);
    expect(shadow.getElementById('signal')).toBeTruthy();
    expect(shadow.getElementById('wifi')).toBeTruthy();
    expect(shadow.getElementById('battery')).toBeTruthy();
    expect(shadow.getElementById('device-cutout')).toHaveAttribute('data-kind', 'dynamic-island');
    expect(shadow.getElementById('device-cutout')?.tagName).toBe('BUTTON');
    expect(shadow.getElementById('gesture-indicator')).toBeTruthy();
    expect(shadow.querySelector('style')).toHaveTextContent('height: 47px');
    expect(shadow.querySelector('style')).toHaveTextContent('height: calc(47px + 1px)');
    expect(shadow.querySelector('style')).toHaveTextContent('height: 34px');
    expect(shadow.querySelector('style')).toHaveTextContent('background: transparent');
    expect(shadow.querySelector('style')).toHaveTextContent('backdrop-filter: none');
    expect(shadow.querySelector('style')).not.toHaveTextContent('prefers-color-scheme');
    expect(shadow.querySelector('style')).toHaveTextContent('--mearl-device-cutout-display');
  });

  it('点击动态岛通过截图回调捕获当前页面', async () => {
    const captureScreenshot = vi.fn().mockRejectedValue(new Error('capture unavailable'));
    manager.destroy();
    manager = createQuickDeviceChromeManager({ captureScreenshot });
    manager.update(iosConfig);

    chromeHosts()[0]!.shadowRoot!.getElementById('device-cutout')!.click();

    await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledOnce());
  });

  it('reports a lost browser safe area while the phone frame is mounted', () => {
    const onSafeAreaMismatch = vi.fn();
    let resize: ResizeObserverCallback | undefined;
    let probe: Element | undefined;
    const disconnect = vi.fn();
    const observer = { observe: (element: Element) => { probe = element; }, disconnect };
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
        return observer;
      }
    });
    const report = (width: number, height: number) => resize?.([
      { target: probe, contentRect: { width, height } } as ResizeObserverEntry,
    ], observer as unknown as ResizeObserver);

    try {
      manager.destroy();
      manager = createQuickDeviceChromeManager({ onSafeAreaMismatch });
      manager.update({ ...iosConfig, phoneFrame: { width: 402, height: 874 } });
      expect(probe?.isConnected).toBe(true);
      report(0, 81);
      expect(onSafeAreaMismatch).not.toHaveBeenCalled();
      report(0, 0);
      expect(onSafeAreaMismatch).toHaveBeenCalledOnce();

      manager.update({
        ...iosConfig,
        statusBarHeight: 0,
        sideBarWidth: 84,
        safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
        phoneFrame: { width: 874, height: 402 },
      });
      report(0, 34);
      expect(onSafeAreaMismatch).toHaveBeenCalledOnce();

      manager.update(null);
      expect(disconnect).toHaveBeenCalled();
      report(0, 0);
      expect(onSafeAreaMismatch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('App 档案提供桥配置时点击底部手势条打开配置', () => {
    const showBridgeConfig = vi.fn();
    manager.destroy();
    manager = createQuickDeviceChromeManager({ showBridgeConfig });
    manager.update(iosConfig);
    manager.updateAppState({
      statusBarBackground: '#fff',
      textColor: '#111',
      bridgeConfig: { profile: 'wallet', actions: { noop: [] }, language: 'zh-HK' },
    });

    const gestureSurface = chromeHosts()[0]!.shadowRoot!.getElementById(
      'gesture-surface',
    ) as HTMLButtonElement;
    expect(gestureSurface.disabled).toBe(false);
    gestureSurface.click();

    expect(showBridgeConfig).toHaveBeenCalledWith({
      profile: 'wallet',
      actions: { noop: [] },
      language: 'zh-HK',
    });
  });

  it('updates the existing host with Android system chrome and no cutout', () => {
    manager.update({ ...iosConfig, cutout: 'notch' });
    const host = chromeHosts()[0]!;
    expect(host.shadowRoot!.getElementById('device-cutout')).toHaveAttribute('data-kind', 'notch');

    manager.update(androidConfig);

    expect(chromeHosts()).toHaveLength(1);
    expect(chromeHosts()[0]).toBe(host);
    expect(host).toHaveAttribute('data-mearl-quick-device-chrome', 'android');
    expect(host.shadowRoot!.getElementById('device-chrome')).toHaveAttribute(
      'data-platform',
      'android',
    );
    expect(host.shadowRoot!.getElementById('device-cutout')).toBeNull();
    expect(host.shadowRoot!.querySelector('style')).toHaveTextContent(
      '#device-chrome[data-platform="android"] #gesture-indicator',
    );
  });

  it('removes the chrome for a null update and does not duplicate hosts', () => {
    manager.update(iosConfig);
    manager.update(iosConfig);
    manager.update(androidConfig);

    expect(chromeHosts()).toHaveLength(1);

    manager.update(null);

    expect(chromeHosts()).toHaveLength(0);
  });

  it('does not render device chrome without an App root WebView', async () => {
    document.querySelector('[data-mearl-root-webview]')?.remove();

    manager.update(iosConfig);

    expect(chromeHosts()).toHaveLength(0);
    expect(layoutStyle()).toBeNull();

    const rootWebView = document.createElement('iframe');
    rootWebView.setAttribute('data-mearl-root-webview', '');
    document.body.appendChild(rootWebView);

    await vi.waitFor(() => expect(chromeHosts()).toHaveLength(1));
    expect(layoutStyle()).not.toBeNull();
  });

  it('publishes App layout values without overriding page-owned safe-area variables', () => {
    manager.update({
      ...iosConfig,
      statusBarHeight: 24,
      bottomBarHeight: 21,
      safeAreaInsets: { top: 0, right: 62, bottom: 21, left: 62 },
      cutout: 'none',
    });

    expect(layoutStyle()).toHaveTextContent('--mearl-quick-device-status-bar-height: 24px');
    expect(layoutStyle()).not.toHaveTextContent('--safe-area-inset-');
    expect(layoutStyle()).toHaveTextContent(
      '[data-mearl-root-webview]:not([data-mearl-app-viewport-mode])',
    );
    expect(layoutStyle()).not.toHaveTextContent('--mearl-quick-device-bottom-bar-height');

    manager.update(null);

    expect(layoutStyle()).toBeNull();
  });

  it('App 只更新设备状态栏样式，不改变其显隐', () => {
    manager.updateAppState({
      statusBarBackground: 'transparent',
      textColor: 'rgb(240, 240, 240)',
      bridgeConfig: { profile: 'shop' },
    });
    manager.update(iosConfig);

    let shadow = chromeHosts()[0]!.shadowRoot!;
    expect(shadow.getElementById('status-bar')).toHaveStyle({
      display: 'block',
      background: 'transparent',
    });
    expect(shadow.getElementById('device-chrome')).toHaveStyle({
      color: 'rgb(240, 240, 240)',
    });

    manager.update(androidConfig);
    shadow = chromeHosts()[0]!.shadowRoot!;
    expect(shadow.getElementById('status-bar')).toHaveStyle({
      display: 'block',
      background: 'transparent',
    });
  });

  it('reattaches the same host after body and documentElement replacement', async () => {
    manager.update(iosConfig);
    const host = chromeHosts()[0]!;
    const nextBody = document.createElement('body');
    const nextRootWebView = document.createElement('iframe');
    nextRootWebView.setAttribute('data-mearl-root-webview', '');
    nextBody.appendChild(nextRootWebView);

    document.documentElement.replaceChild(nextBody, document.body);

    await vi.waitFor(
      () => expect(nextBody.querySelector(`[data-mearl-quick-device-chrome]`)).toBe(host),
      { timeout: 3_000 },
    );

    const nextRoot = document.createElement('html');
    const finalBody = document.createElement('body');
    const finalRootWebView = document.createElement('iframe');
    finalRootWebView.setAttribute('data-mearl-root-webview', '');
    finalBody.appendChild(finalRootWebView);
    nextRoot.append(document.createElement('head'), finalBody);
    document.removeChild(document.documentElement);
    document.appendChild(nextRoot);

    await vi.waitFor(
      () => expect(document.body.querySelector(`[data-mearl-quick-device-chrome]`)).toBe(host),
      { timeout: 3_000 },
    );
    expect(chromeHosts()).toHaveLength(1);
  });

  it('does not alter viewport metadata or document layout styles', () => {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;
    document.documentElement.style.cssText = 'width: 82%; min-height: 91%;';
    document.body.style.cssText = 'width: 73%; height: 67%; padding: 13px;';
    const viewportContent = viewport.content;
    const rootStyle = document.documentElement.style.cssText;
    const bodyStyle = document.body.style.cssText;

    manager.update(iosConfig);
    manager.update(androidConfig);

    expect(viewport.content).toBe(viewportContent);
    expect(document.documentElement.style.cssText).toBe(rootStyle);
    expect(document.body.style.cssText).toBe(bodyStyle);
  });

  it('honors an explicit frame scale and still fits smaller windows', () => {
    let width = 1000;
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(1200);
    manager.update({ ...iosConfig, phoneFrame: { width: 400, height: 800, maxScale: 0.5 } });
    const scale = () => (layoutStyle()?.sheet?.cssRules[0] as CSSStyleRule)
      .style.getPropertyValue('--mearl-phone-frame-scale');
    expect(scale()).toBe('0.5');

    width = 168;
    window.dispatchEvent(new Event('resize'));
    expect(scale()).toBe('0.3');
  });

  it('applies the navigation layout and waits for the viewport to settle', async () => {
    const config = { ...iosConfig, phoneFrame: { width: 400, height: 800 } };
    const previewLayout = {
      width: 400,
      toolbarCollapsed: true,
      panel: { wide: true, open: false },
      viewport: { width: 1200, height: 848 },
      toolbar: {
        profile: { id: 'shop', label: '商店' },
        preset: { id: 'iphone-17-pro', label: 'iPhone 17 Pro' },
        orientation: 'portrait',
      },
    };
    const bootstrap = readPhoneFrameBootstrap([
      { name: 'mearl-document', description: 'fixture-token' },
      { name: 'mearl-device-shell', description: btoa(JSON.stringify({ version: 1, config })) },
      { name: 'mearl-device-shell', description: btoa(unescape(encodeURIComponent(JSON.stringify({ version: 1, config, previewLayout })))) },
    ]);
    expect(bootstrap).toEqual({ config, previewLayout });
    const { element } = createDevicePreviewToolbar(bootstrap?.previewLayout.toolbar);
    const selectedLabels = [...element.querySelectorAll('select')].map(select => select.selectedOptions[0]?.textContent);
    expect(selectedLabels).toEqual(['商店', 'iPhone 17 Pro']);
    let height = 844;
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1200);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockImplementation(() => height);
    const requestToken = vi.fn().mockResolvedValue('preview-token');
    const loadLayout = vi.fn().mockResolvedValue({ width: 500, toolbarCollapsed: false });
    manager.destroy();
    manager = createQuickDeviceChromeManager({
      previewPanel: {
        label: 'Debug',
        resizeLabel: 'Resize',
        unavailableLabel: 'Unavailable',
        retryLabel: 'Retry',
        loadingLabel: 'Loading',
        toolbarLabel: 'Device toolbar',
        requestToken,
        initialLayout: bootstrap?.previewLayout,
        url: () => 'about:blank',
        subscribeReady: () => () => {},
        loadLayout,
        saveWidth: vi.fn(),
        saveToolbarCollapsed: vi.fn(),
      },
    });
    manager.update(bootstrap!.config);

    const { style } = layoutStyle()!.sheet!.cssRules[0] as CSSStyleRule;
    expect(style.getPropertyValue('--mearl-phone-frame-left')).toBe('50%');
    expect(style.getPropertyValue('--mearl-phone-frame-top')).toBe('424px');
    expect(style.getPropertyValue('--mearl-phone-frame-scale')).toBe('1');
    expect(requestToken).not.toHaveBeenCalled();
    expect(loadLayout).not.toHaveBeenCalled();

    height = 840;
    window.dispatchEvent(new Event('resize'));
    expect(style.getPropertyValue('--mearl-phone-frame-scale')).toBe('1');
    expect(style.getPropertyValue('--mearl-phone-frame-top')).toBe('424px');
    await vi.waitFor(() => expect(style.getPropertyValue('--mearl-phone-frame-scale')).toBe('0.99'));
    expect(style.getPropertyValue('--mearl-phone-frame-top')).toBe('50%');
  });

  it('opens the preview panel only in wide windows and reuses it after collapsing', async () => {
    let width = 639;
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => width);
    const attachShadow = vi.spyOn(Element.prototype, 'attachShadow');
    const requestToken = vi.fn().mockResolvedValue('preview-token');
    manager.destroy();
    manager = createQuickDeviceChromeManager({
      previewPanel: {
        label: 'Debug',
        resizeLabel: 'Resize',
        unavailableLabel: 'Unavailable',
        retryLabel: 'Retry',
        loadingLabel: 'Loading',
        toolbarLabel: 'Device toolbar',
        requestToken,
        url: () => 'about:blank',
        subscribeReady: () => () => {},
        loadLayout: async () => ({}),
        saveWidth: vi.fn(),
        saveToolbarCollapsed: vi.fn(),
      },
    });
    manager.update({ ...iosConfig, phoneFrame: { width: 402, height: 874 } });
    const previewRoot = attachShadow.mock.results
      .map(result => result.value as ShadowRoot)
      .find(root => root.querySelector('.debug-toggle'))!;
    const debugToggle = previewRoot.querySelector<HTMLButtonElement>('.debug-toggle')!;
    const stageLeft = () => (layoutStyle()?.sheet?.cssRules[0] as CSSStyleRule)
      .style.getPropertyValue('--mearl-phone-frame-left');
    expect(stageLeft()).toBe('50%');
    expect(debugToggle.hidden).toBe(false);
    expect(requestToken).not.toHaveBeenCalled();

    width = 640;
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(stageLeft()).toBe('128px'));
    expect(debugToggle.hidden).toBe(true);
    expect(requestToken).toHaveBeenCalledExactlyOnceWith(true, true, false);
    await vi.waitFor(() => expect(previewRoot.querySelector('iframe')).not.toBeNull());
    const panel = previewRoot.querySelector('iframe')!;
    expect(panel.hidden).toBe(false);

    width = 639;
    window.dispatchEvent(new Event('resize'));
    expect(stageLeft()).toBe('50%');
    expect(panel.hidden).toBe(true);

    width = 1200;
    window.dispatchEvent(new Event('resize'));
    expect(stageLeft()).toBe('240px');
    expect(debugToggle.hidden).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(previewRoot.querySelector('iframe')).toBe(panel);
    expect(requestToken).toHaveBeenCalledOnce();
  });

  it.each([true, false])('retries an uncommitted preview iframe early (%s)', async blank => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
      vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(blank ? document : null);
      vi.spyOn(document, 'URL', 'get').mockReturnValue('about:blank');
      const requestToken = vi.fn().mockResolvedValue('preview-token');
      const url = vi.fn().mockReturnValue('about:blank');
      manager.destroy();
      manager = createQuickDeviceChromeManager({
        previewPanel: {
          label: 'Debug', resizeLabel: 'Resize', unavailableLabel: 'Unavailable', retryLabel: 'Retry',
          loadingLabel: 'Loading', toolbarLabel: 'Device toolbar',
          requestToken, url, subscribeReady: () => () => {},
          loadLayout: async () => ({}), saveWidth: vi.fn(), saveToolbarCollapsed: vi.fn(),
        },
      });
      manager.update({ ...iosConfig, phoneFrame: { width: 402, height: 874 } });
      await vi.advanceTimersByTimeAsync(300);
      expect(url).toHaveBeenCalledTimes(blank ? 2 : 1);
      expect(requestToken).toHaveBeenCalledOnce();
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  it('lets the user recover a preview that failed before its iframe was ready', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
    const attachShadow = vi.spyOn(Element.prototype, 'attachShadow');
    const requestToken = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue('preview-token');
    const url = vi.fn().mockReturnValue('about:blank');
    let ready!: (viewer: string) => void;
    manager.destroy();
    manager = createQuickDeviceChromeManager({
      previewPanel: {
        label: 'Debug', resizeLabel: 'Resize', unavailableLabel: 'Unavailable', retryLabel: 'Retry',
        loadingLabel: 'Loading', toolbarLabel: 'Device toolbar', requestToken, url,
        subscribeReady: listener => { ready = listener; return () => {}; },
        loadLayout: async () => ({}), saveWidth: vi.fn(), saveToolbarCollapsed: vi.fn(),
      },
    });
    manager.update({ ...iosConfig, phoneFrame: { width: 402, height: 874 } });
    const root = attachShadow.mock.results.map(result => result.value as ShadowRoot)
      .find(shadow => shadow.querySelector('.debug-toggle'))!;
    const status = root.querySelector<HTMLElement>('.panel-status')!;
    const retry = root.querySelector<HTMLButtonElement>('.panel-retry')!;
    await vi.waitFor(() => expect(retry.hidden).toBe(false));

    const click = new MouseEvent('click');
    Object.defineProperty(click, 'isTrusted', { value: true });
    retry.dispatchEvent(click);
    expect(retry.hidden).toBe(true);
    expect(status).toHaveTextContent('Loading');
    expect(requestToken).toHaveBeenLastCalledWith(true, true, true);
    await vi.waitFor(() => expect(root.querySelector('iframe')).not.toBeNull());

    ready(url.mock.calls[0]![1]);
    expect(status.hidden).toBe(true);
  });

  it('同步页面时间覆盖，并忽略较旧的状态', () => {
    const now = new Date(2026, 8, 5, 12, 34, 0);
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    manager.update(iosConfig);
    const nativeTime = chromeHosts()[0]!.shadowRoot!.getElementById('time')!.textContent;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);

    manager.updateTimeOverride(midnight.getTime() - now.getTime(), 2);
    expect(chromeHosts()[0]!.shadowRoot!.getElementById('time')).toHaveTextContent('00:00');

    manager.updateTimeOverride(null, 1);
    expect(chromeHosts()[0]!.shadowRoot!.getElementById('time')).toHaveTextContent('00:00');

    manager.updateTimeOverride(null, 3);
    expect(chromeHosts()[0]!.shadowRoot!.getElementById('time')).toHaveTextContent(nativeTime);
  });
  it('Duo 根半弹层只在外层避让侧栏，内部 WebView 填满弹层', () => {
    const frame = document.querySelector<HTMLElement>('[data-mearl-root-webview]')!;
    const overlay = document.createElement('div');
    const sheet = document.createElement('div');
    overlay.setAttribute('data-mearl-root-overlay', 'reader');
    sheet.setAttribute('data-mearl-root-overlay-sheet', '');
    sheet.style.cssText = 'width:100%;max-width:600px;height:80%;';
    overlay.appendChild(sheet);
    sheet.appendChild(frame);
    document.body.appendChild(overlay);
    manager.update({
      ...iosConfig,
      statusBarHeight: 0,
      sideBarWidth: 84,
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
      cutout: 'side-camera',
    });

    expect(getComputedStyle(overlay).right).toBe('84px');
    expect(getComputedStyle(overlay).width).toBe('calc(100% - 84px)');
    expect(getComputedStyle(sheet).maxWidth).toBe('600px');
    expect(getComputedStyle(frame).width).toBe('100%');
    expect(getComputedStyle(frame).right).toBe('0px');
    frame.setAttribute('data-mearl-app-viewport-mode', 'normal');
    expect(getComputedStyle(frame).height).toBe('100%');
    expect(getComputedStyle(frame).top).toBe('0px');
  });

  it('reserves the Duo side rail for root, pushed, and split-screen WebViews', () => {
    manager.update({
      ...iosConfig,
      statusBarHeight: 0,
      sideBarWidth: 84,
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
      cutout: 'side-camera',
    });

    expect(layoutStyle()).toHaveTextContent('--mearl-quick-device-side-bar-width: 84px');
    expect(layoutStyle()).toHaveTextContent('[data-mearl-layer]:not([data-mearl-split-pane])');
    expect(layoutStyle()).toHaveTextContent(
      '[data-mearl-root-webview][data-mearl-split-pane="left"]',
    );
    expect(layoutStyle()).toHaveTextContent('[data-mearl-layer][data-mearl-split-pane="right"]');
    expect(chromeHosts()[0]!.shadowRoot!.getElementById('device-chrome')).toHaveAttribute(
      'data-side-bar',
      'true',
    );
  });
});
