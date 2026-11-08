export interface DeviceChromeViewConfig {
  platform: 'ios' | 'android';
  statusBarHeight: number;
  bottomBarHeight: number;
  /** 右侧系统控件区域宽度；Duo 纵向系统栏使用。 */
  sideBarWidth?: number;
  cutout: 'none' | 'dynamic-island' | 'notch' | 'side-camera';
}

export interface DeviceChromeViewState {
  statusBarVisible: boolean;
  statusBarBackground: string;
  textColor: string;
  bottomActionEnabled?: boolean;
  timeOffsetMs?: number | null;
}

export interface DeviceChromeViewLabels {
  screenshot: string;
  copied: string;
  downloaded: string;
  captureFailed: string;
  bottomAction: string;
}

export interface DeviceChromeViewOptions {
  captureScreenshot?: () => Promise<{ data: string }>;
  onBottomAction?: () => void;
  labels?: Partial<DeviceChromeViewLabels>;
  initialState?: Partial<DeviceChromeViewState>;
}

export interface DeviceChromeViewController {
  updateState(state: Partial<DeviceChromeViewState>): void;
  destroy(): void;
}

/** Shared DOM-only device chrome. The function body is self-contained so CDP can serialize it. */
export function installDeviceChromeView(
  root: ShadowRoot | HTMLElement,
  config: DeviceChromeViewConfig,
  options: DeviceChromeViewOptions = {},
): DeviceChromeViewController {
  const ownerDocument = root.ownerDocument;
  const browser = ownerDocument.defaultView ?? window;
  const NativeDate = browser.Date;
  const nativeNow = NativeDate.now.bind(NativeDate);
  const labels: DeviceChromeViewLabels = {
    screenshot: 'Screenshot',
    copied: 'Copied',
    downloaded: 'Downloaded',
    captureFailed: 'Capture failed',
    bottomAction: 'App simulation settings',
    ...options.labels,
  };
  const state: DeviceChromeViewState = {
    statusBarVisible: true,
    statusBarBackground: '#ffffff',
    textColor: '#0f131a',
    bottomActionEnabled: false,
    timeOffsetMs: null,
    ...options.initialState,
  };
  const normalizedBarHeight = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(200, Math.max(0, Math.round(value)));
  };
  const statusBarHeight = normalizedBarHeight(config.statusBarHeight);
  const bottomBarHeight = normalizedBarHeight(config.bottomBarHeight);
  const sideBarWidth = normalizedBarHeight(config.sideBarWidth ?? 0);
  const cutout = config.platform === 'ios' ? config.cutout : 'none';
  const sideBarTimeTop = cutout === 'side-camera' ? 77 : 25;
  const sideBarIndicatorsTop = cutout === 'side-camera' ? 101 : 49;
  const cutoutMarkup =
    cutout === 'none'
      ? ''
      : cutout === 'dynamic-island'
        ? `<button id="device-cutout" type="button" data-kind="${cutout}" data-state="idle"><svg id="cutout-camera" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 5.5 7.7 3.8h4.6l1.2 1.7h2.2c1 0 1.8.8 1.8 1.8v7c0 1-.8 1.8-1.8 1.8H4.3c-1 0-1.8-.8-1.8-1.8v-7c0-1 .8-1.8 1.8-1.8z"/><circle cx="10" cy="10.5" r="3.2"/></svg><svg id="cutout-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.2 3.2 7.8-7.8"/></svg></button>`
        : `<span id="device-cutout" data-kind="${cutout}" aria-hidden="true"></span>`;
  const statusIndicatorsMarkup =
    sideBarWidth > 0
      ? `<svg id="duo-status-icon" viewBox="0 0 48 48" aria-hidden="true"><path id="duo-battery-arc" d="M6.7 34A20 20 0 1 1 41.3 34"/><g id="duo-wifi"><path d="M15.5 21Q24 13.5 32.5 21M19.5 25.5Q24 21.5 28.5 25.5"/><path d="M21.5 29.5Q24 27.4 26.5 29.5L24.7 31.7Q24 32.5 23.3 31.7Z"/></g><g id="duo-signal-arc"><circle cx="14" cy="41.3" r="1.8"/><circle cx="21" cy="43.8" r="1.8"/><circle cx="28" cy="43.8" r="1.8"/><circle cx="35" cy="41.3" r="1.8"/></g></svg>`
      : `<svg id="signal" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
          <svg id="wifi" viewBox="1 3.8 22 17.2"><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M12 20h.01"/></svg>
          <svg id="battery" viewBox="0 0 28 13"><rect id="battery-outline" x=".65" y=".65" width="23" height="11.7" rx="3.1"/><rect id="battery-level" x="2.35" y="2.35" width="19.6" height="8.3" rx="1.7"/><path id="battery-cap" d="M25 4.1c1.1.35 1.7 1.15 1.7 2.4s-.6 2.05-1.7 2.4z"/></svg>`;

  root.innerHTML = `<style>
    :host {
      all: initial !important;
      position: fixed !important;
      inset: 0 !important;
      display: block !important;
      z-index: 2147483600 !important;
      overflow: visible !important;
      pointer-events: none !important;
      contain: layout style !important;
      isolation: isolate !important;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      pointer-events: none !important;
    }
    #device-chrome {
      position: absolute;
      inset: 0;
      overflow: visible;
      color: #0f131a;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif;
      font-synthesis: none;
      -webkit-font-smoothing: antialiased;
      text-rendering: geometricPrecision;
      user-select: none;
    }
    .system-bar {
      position: absolute;
      left: 0;
      right: 0;
      background: #ffffff;
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
    #status-bar {
      top: 0;
      height: calc(${statusBarHeight}px + 1px);
      min-height: 0;
      overflow: visible;
    }
    #status-content {
      position: relative;
      z-index: 1;
      height: ${statusBarHeight}px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 21px 0 27px;
      font-size: 15px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: -.25px;
      font-variant-numeric: tabular-nums;
    }
    #time {
      position: relative;
      z-index: 1;
      min-width: 54px;
      text-align: left;
    }
    #status-indicators {
      position: relative;
      z-index: 1;
      height: 14px;
      display: flex;
      align-items: center;
      gap: 6.5px;
    }
    #status-indicators svg {
      display: block;
      overflow: visible;
      fill: none;
      stroke: currentColor;
    }
    #signal {
      width: 18px;
      height: 12px;
      fill: currentColor !important;
      stroke: none !important;
    }
    #wifi {
      width: 18px;
      height: 14px;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #battery {
      width: 28px;
      height: 13px;
      stroke-width: 1.25;
    }
    #battery-outline { opacity: .42; }
    #battery-level { fill: currentColor; stroke: none; }
    #battery-cap { fill: currentColor; stroke: none; opacity: .45; }
    #device-cutout {
      appearance: none;
      position: absolute;
      left: 50%;
      z-index: 2;
      display: var(--mearl-device-cutout-display, block);
      border: 0;
      padding: 0;
      max-height: 100%;
      transform: translateX(-50%);
      background: #000;
      color: #fff;
      box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .08);
    }
    #device-cutout[data-kind="dynamic-island"] {
      top: 50%;
      width: 126px;
      height: min(37px, calc(100% - 4px));
      display: var(--mearl-device-cutout-display, flex);
      align-items: center;
      justify-content: center;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      pointer-events: auto !important;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      transition: width 320ms cubic-bezier(.34, 1.56, .64, 1), transform 160ms ease;
    }
    #device-cutout[data-kind="dynamic-island"]:active {
      transform: translate(-50%, -50%) scale(.97);
    }
    #device-cutout[data-kind="dynamic-island"]:focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }
    #device-cutout[data-kind="dynamic-island"][data-state="copied"],
    #device-cutout[data-kind="dynamic-island"][data-state="downloaded"],
    #device-cutout[data-kind="dynamic-island"][data-state="failed"] {
      width: 154px;
      padding: 0 10px;
      justify-content: space-between;
    }
    #cutout-camera, #cutout-check {
      display: none;
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #device-cutout[data-state="copied"] #cutout-camera,
    #device-cutout[data-state="downloaded"] #cutout-camera,
    #device-cutout[data-state="failed"] #cutout-camera,
    #device-cutout[data-state="copied"] #cutout-check,
    #device-cutout[data-state="downloaded"] #cutout-check,
    #device-cutout[data-state="failed"] #cutout-check {
      display: block;
    }
    #device-cutout[data-kind="notch"] {
      top: 0;
      width: 164px;
      height: min(31px, 100%);
      border-radius: 0 0 18px 18px;
    }
    #device-chrome[data-cutout="side-camera"] #status-content {
      padding-right: 64px;
    }
    #device-cutout[data-kind="side-camera"] {
      top: 50%;
      right: 18px;
      left: auto;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      transform: translateY(-50%);
    }
    #device-chrome[data-side-bar="true"] #status-bar {
      left: auto;
      right: 0;
      width: ${sideBarWidth}px;
      height: 100%;
      border-left: 1px solid rgba(15, 23, 42, .06);
    }
    #device-chrome[data-side-bar="true"] #status-content {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      padding: 0;
    }
    #device-chrome[data-side-bar="true"] #device-cutout[data-kind="side-camera"] {
      display: none;
    }
    #device-chrome[data-side-bar="true"][data-cutout="side-camera"] #status-bar::after {
      content: "";
      position: fixed;
      top: 25px;
      right: ${Math.max(0, Math.round((sideBarWidth - 36) / 2))}px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: radial-gradient(circle at center, #243f86 0 1.5px, #050505 2.5px);
      box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .08);
    }
    #device-chrome[data-side-bar="true"] #time {
      position: absolute;
      top: ${sideBarTimeTop}px;
      left: 0;
      width: 100%;
      min-width: 0;
      text-align: center;
      font-size: 13px;
    }
    #device-chrome[data-side-bar="true"] #status-indicators {
      position: absolute;
      top: ${sideBarIndicatorsTop}px;
      left: 50%;
      width: 44px;
      height: 44px;
      transform: translateX(-50%);
      display: block;
    }
    #duo-status-icon {
      width: 44px;
      height: 44px;
      fill: none;
      stroke: currentColor;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #duo-wifi { stroke-width: 2.5; }
    #duo-wifi path:last-child { fill: currentColor; stroke: none; }
    #duo-status-icon circle { fill: currentColor; stroke: none; }
    #device-chrome[data-side-bar="true"] #bottom-bar { right: ${sideBarWidth}px; }
    #bottom-bar {
      bottom: 0;
      height: ${bottomBarHeight}px;
      min-height: 0;
      background: transparent;
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
    #gesture-surface {
      appearance: none;
      position: absolute;
      left: 50%;
      bottom: 0;
      width: 166px;
      max-width: calc(100% - 32px);
      height: 24px;
      transform: translateX(-50%);
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
    }
    #gesture-surface[data-interactive="true"] {
      pointer-events: auto !important;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    #gesture-surface[data-interactive="true"]:focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: -2px;
    }
    #gesture-indicator {
      position: absolute;
      left: 50%;
      bottom: 8px;
      width: 134px;
      max-width: 100%;
      height: 5px;
      transform: translateX(-50%);
      border-radius: 999px;
      background: currentColor;
      opacity: .92;
      transition: transform 120ms ease, opacity 120ms ease;
    }
    #gesture-surface[data-interactive="true"]:hover #gesture-indicator {
      opacity: 1;
      transform: translateX(-50%) scaleX(1.05);
    }
    #device-chrome[data-platform="android"] {
      font-family: Roboto, "Noto Sans SC", "Segoe UI", sans-serif;
    }
    #device-chrome[data-platform="android"] #status-content {
      padding: 0 12px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0;
    }
    #device-chrome[data-platform="android"] #status-indicators {
      gap: 5px;
      transform: scale(.86);
      transform-origin: right center;
    }
    #device-chrome[data-platform="android"] #gesture-indicator {
      bottom: 6px;
      width: 108px;
      height: 4px;
      opacity: .82;
    }
    @media(prefers-reduced-motion: reduce) {
      #device-cutout, #gesture-indicator { transition: none; }
    }
  </style>
  <div id="device-chrome" data-platform="${config.platform}" data-cutout="${cutout}" data-side-bar="${sideBarWidth > 0}">
    <div id="status-bar" class="system-bar" data-mearl-device-status-bar>
      <div id="status-content">
        <span id="time"></span>
        ${cutoutMarkup}
        <span id="status-indicators" aria-hidden="true">
          ${statusIndicatorsMarkup}
        </span>
      </div>
    </div>
    <div id="bottom-bar" class="system-bar" data-mearl-device-bottom-bar>
      <button id="gesture-surface" type="button" data-interactive="false" disabled aria-hidden="true"><span id="gesture-indicator" aria-hidden="true"></span></button>
    </div>
  </div>`;

  const deviceChrome = root.querySelector<HTMLElement>('#device-chrome');
  const statusBar = root.querySelector<HTMLElement>('#status-bar');
  const statusContent = root.querySelector<HTMLElement>('#status-content');
  const time = root.querySelector<HTMLElement>('#time');
  const cutoutButton = root.querySelector<HTMLButtonElement>('#device-cutout');
  const cutoutStatusPath = root.querySelector<SVGPathElement>('#cutout-check path');
  const gestureSurface = root.querySelector<HTMLButtonElement>('#gesture-surface');
  let screenshotPending = false;
  let resetTimer: number | null = null;
  let destroyed = false;

  const updateTime = (): void => {
    if (!time) return;
    const now = new NativeDate(nativeNow() + (state.timeOffsetMs ?? 0));
    time.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  };
  updateTime();
  const timeTimer = browser.setInterval(updateTime, 30_000);

  const setCutoutState = (nextState: 'idle' | 'copied' | 'downloaded' | 'failed'): void => {
    if (!cutoutButton || cutoutButton.tagName !== 'BUTTON') return;
    cutoutButton.dataset.state = nextState;
    const label =
      nextState === 'copied'
        ? labels.copied
        : nextState === 'downloaded'
          ? labels.downloaded
          : nextState === 'failed'
            ? labels.captureFailed
            : labels.screenshot;
    cutoutButton.setAttribute('aria-label', label);
    cutoutButton.title = label;
    cutoutStatusPath?.setAttribute(
      'd',
      nextState === 'failed' ? 'M5.5 5.5l9 9m0-9-9 9' : 'm4.5 10.5 3.2 3.2 7.8-7.8',
    );
  };

  const screenshotBlob = (data: string): Blob => {
    const binary = browser.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new browser.Blob([bytes], { type: 'image/png' });
  };

  const downloadScreenshot = (blob: Blob): void => {
    const link = ownerDocument.createElement('a');
    const objectUrl = browser.URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = `mearl-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.style.display = 'none';
    ownerDocument.body.appendChild(link);
    link.click();
    link.remove();
    browser.setTimeout(() => browser.URL.revokeObjectURL(objectUrl), 1_000);
  };

  const applyState = (): void => {
    if (statusBar) {
      statusBar.style.display = state.statusBarVisible || sideBarWidth > 0 ? '' : 'none';
      statusBar.style.background = state.statusBarBackground;
    }
    if (statusContent && sideBarWidth > 0) {
      statusContent.style.visibility = state.statusBarVisible ? '' : 'hidden';
    }
    if (deviceChrome) deviceChrome.style.color = state.textColor;
    if (gestureSurface) {
      const interactive = Boolean(state.bottomActionEnabled && options.onBottomAction);
      gestureSurface.dataset.interactive = String(interactive);
      gestureSurface.disabled = !interactive;
      gestureSurface.setAttribute('aria-hidden', String(!interactive));
      if (interactive) {
        gestureSurface.setAttribute('aria-label', labels.bottomAction);
        gestureSurface.title = labels.bottomAction;
      } else {
        gestureSurface.removeAttribute('aria-label');
        gestureSurface.removeAttribute('title');
      }
    }
  };

  if (cutoutButton?.tagName === 'BUTTON') {
    setCutoutState('idle');
    cutoutButton.disabled = !options.captureScreenshot;
    cutoutButton.addEventListener('click', () => {
      if (
        destroyed ||
        !options.captureScreenshot ||
        screenshotPending ||
        cutoutButton.dataset.state !== 'idle'
      ) {
        return;
      }
      screenshotPending = true;
      cutoutButton.setAttribute('aria-busy', 'true');
      void options
        .captureScreenshot()
        .then(({ data }) => screenshotBlob(data))
        .then(async blob => {
          const ClipboardItemConstructor = browser.ClipboardItem;
          if (browser.navigator.clipboard?.write && ClipboardItemConstructor) {
            try {
              await browser.navigator.clipboard.write([
                new ClipboardItemConstructor({ 'image/png': blob }),
              ]);
              setCutoutState('copied');
              return;
            } catch {
              // Downloading keeps the action useful when clipboard permission is unavailable.
            }
          }
          downloadScreenshot(blob);
          setCutoutState('downloaded');
        })
        .catch(() => setCutoutState('failed'))
        .finally(() => {
          screenshotPending = false;
          if (destroyed) return;
          cutoutButton.setAttribute('aria-busy', 'false');
          resetTimer = browser.setTimeout(() => {
            resetTimer = null;
            if (!screenshotPending) setCutoutState('idle');
          }, 1_600);
        });
    });
  }

  gestureSurface?.addEventListener('click', () => {
    if (!destroyed && state.bottomActionEnabled) options.onBottomAction?.();
  });
  applyState();

  return {
    updateState(nextState) {
      if (destroyed) return;
      Object.assign(state, nextState);
      applyState();
      updateTime();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      browser.clearInterval(timeTimer);
      if (resetTimer !== null) browser.clearTimeout(resetTimer);
      root.replaceChildren();
    },
  };
}
