import { sendCdpPageCommand, monitorCdpPageDialogs } from './page-dialogs.js';
import {
  buildEnableEmulationCommands,
  getDeviceSideBarWidth,
  preparePausedDebuggerTarget,
  createRootWebViewNavigation,
  installRootWebViewDocumentTransport,
  type WebViewNavigationRequest,
  type WebViewDocumentResponse,
  type AppLayerUrlProxyConfig,
  type ResolvedEmulationConfig,
} from '@mearl/browser-core';
import {
  installDeviceChromeView,
  type DeviceChromeViewConfig,
} from '@mearl/browser-core/deviceChromeView';
import type { CdpChildSession, CdpClient } from './client.js';
import type { PageSession } from './cdp-session.js';
import {
  registerCdpFetchPauseHandler,
  unregisterCdpFetchPauseHandler,
} from './fetch-interceptor.js';

export type CdpDeviceShellCommandClient = CdpClient | CdpChildSession;

type DeviceShellConfig = DeviceChromeViewConfig & {
  /** App 运行时负责根容器与系统栏时，仅保留 CDP iframe 路由。 */
  rootContainerManagedByApp?: boolean;
};

interface ApplyCdpDeviceShellOptions {
  rootContainerManagedByApp?: boolean;
}

interface DeviceShellState {
  navigation: ReturnType<typeof createRootWebViewNavigation>;
  configKey: string;
  documentScriptIdentifier: string;
  emulation: ResolvedEmulationConfig;
  statusBarHeight: number;
  sideBarWidth: number;
  executionContexts: Map<CdpDeviceShellCommandClient, Map<string, number>>;
  attachedWebViews: Map<string, AttachedDeviceShellWebView>;
  nextAttachedOrder: number;
  childEnvironmentManagedByApp: boolean;
  rootContainerManagedByApp: boolean;
  activeFrameOffsetX: number;
  disposeListeners: Array<() => void>;
}

interface AttachedDeviceShellWebView {
  client: CdpChildSession;
  name: '__mearl_root__' | '__mearl_layer__';
  frameId?: string;
  order: number;
  disposeListeners: Array<() => void>;
}

const deviceShellStates = new WeakMap<PageSession, DeviceShellState>();
const navigationProxies = new WeakMap<PageSession, AppLayerUrlProxyConfig>();
const DEVICE_SHELL_BINDING = '__mearlCdpDeviceShellRelay';
const DEVICE_SHELL_RESPONSE = '__mearlCdpDeviceShellResponse';

export function setCdpDeviceShellNavigationProxy(
  session: PageSession,
  proxy?: AppLayerUrlProxyConfig,
): void {
  if (proxy) navigationProxies.set(session, proxy);
  else navigationProxies.delete(session);
}

/** 响应覆盖仍通过根文档交付，避免 Mock HTML 再次导航到业务地址。 */
export async function fulfillCdpDeviceShellDocument(
  session: PageSession,
  params: WebViewNavigationRequest,
  response: WebViewDocumentResponse,
): Promise<boolean> {
  return deviceShellStates.get(session)?.navigation.fulfillResponse(params, response) ?? false;
}

interface DeviceShellFrame {
  id: string;
  url: string;
  name?: string;
}

const FRAME_INTERACTIVITY_SETTLE_TIMEOUT_MS = 420;
const FRAME_INTERACTIVITY_POLL_MS = 20;

function findActiveWebView(
  frameTree: Record<string, any> | undefined,
): DeviceShellFrame | undefined {
  if (!frameTree) return undefined;
  let root =
    frameTree.frame?.name === '__mearl_root__' ? (frameTree.frame as DeviceShellFrame) : undefined;
  let layer =
    frameTree.frame?.name === '__mearl_layer__' ? (frameTree.frame as DeviceShellFrame) : undefined;
  for (const child of frameTree.childFrames ?? []) {
    const match = findActiveWebView(child);
    if (!match) continue;
    if (match.name === '__mearl_layer__') layer = match;
    else root ??= match;
  }
  return layer ?? root;
}

function collectDeviceShellFrames(
  frameTree: Record<string, any> | undefined,
  frames: DeviceShellFrame[] = [],
): DeviceShellFrame[] {
  if (!frameTree) return frames;
  if (frameTree.frame?.name === '__mearl_root__' || frameTree.frame?.name === '__mearl_layer__') {
    frames.push(frameTree.frame as DeviceShellFrame);
  }
  for (const child of frameTree.childFrames ?? []) collectDeviceShellFrames(child, frames);
  return frames;
}

async function readFrameOwnerInteractivity(
  client: CdpDeviceShellCommandClient,
  frameId: string,
): Promise<boolean | undefined> {
  try {
    const owner = await client.sendCommand('DOM.getFrameOwner', { frameId });
    if (owner.backendNodeId === undefined) return undefined;
    const described = await client.sendCommand('DOM.describeNode', {
      backendNodeId: owner.backendNodeId,
      depth: 0,
    });
    const attributes = described.node?.attributes as string[] | undefined;
    if (!attributes) return undefined;
    const names = new Set(attributes.filter((_, index) => index % 2 === 0));
    const ariaHiddenIndex = attributes.indexOf('aria-hidden');
    return (
      !names.has('inert') && (ariaHiddenIndex < 0 || attributes[ariaHiddenIndex + 1] !== 'true')
    );
  } catch {
    return undefined;
  }
}

async function resolveInteractiveWebViewFrame(
  client: CdpDeviceShellCommandClient,
): Promise<DeviceShellFrame | undefined> {
  const deadline = Date.now() + FRAME_INTERACTIVITY_SETTLE_TIMEOUT_MS;
  let fallback: DeviceShellFrame | undefined;
  do {
    const result = await client.sendCommand('Page.getFrameTree').catch(() => null);
    const frameTree = result?.frameTree;
    fallback = findActiveWebView(frameTree) ?? fallback;
    const candidates = collectDeviceShellFrames(frameTree);
    let inspected = false;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate.id === frameTree?.frame?.id) continue;
      const interactive = await readFrameOwnerInteractivity(client, candidate.id);
      if (interactive === undefined) continue;
      inspected = true;
      if (interactive) return candidate;
    }
    if (!inspected) return fallback;
    if (Date.now() >= deadline) return fallback;
    await new Promise(resolve => setTimeout(resolve, FRAME_INTERACTIVITY_POLL_MS));
  } while (Date.now() < deadline);
  return fallback;
}

function trackExecutionContexts(
  state: DeviceShellState,
  client: CdpDeviceShellCommandClient,
): Array<() => void> {
  const contexts = new Map(client.getDefaultExecutionContexts?.());
  state.executionContexts.set(client, contexts);
  return [
    client.on('Runtime.executionContextsCleared', () => contexts.clear()),
    client.on('Runtime.executionContextCreated', params => {
      const context = params?.context;
      const frameId = context?.auxData?.frameId;
      if (
        typeof frameId === 'string' &&
        context?.auxData?.isDefault === true &&
        typeof context.id === 'number'
      ) {
        contexts.set(frameId, context.id);
      }
    }),
    client.on('Runtime.executionContextDestroyed', params => {
      const executionContextId = params?.executionContextId;
      for (const [frameId, contextId] of contexts) {
        if (contextId === executionContextId) contexts.delete(frameId);
      }
    }),
  ];
}

async function installChildTarget(
  session: PageSession,
  state: DeviceShellState,
  params: Record<string, any>,
): Promise<void> {
  const sessionId = params.sessionId;
  if (typeof sessionId !== 'string') return;
  const child = session.client.createChildSession(sessionId);
  const disposeListeners = trackExecutionContexts(state, child);
  disposeListeners.push(monitorCdpPageDialogs(session, child));
  try {
    await preparePausedDebuggerTarget(
      async signal => {
        if (params.targetInfo?.type !== 'iframe' || deviceShellStates.get(session) !== state)
          return;
        await child.sendCommand('Page.enable');
        await child.sendCommand('Runtime.enable');
        signal.throwIfAborted();
        const frameName = await child
          .sendCommand('Runtime.evaluate', {
            expression: 'window.name',
            returnByValue: true,
          })
          .then(result => result.result?.value);
        signal.throwIfAborted();
        if (frameName !== '__mearl_root__' && frameName !== '__mearl_layer__') return;
        const frameTree = await child.sendCommand('Page.getFrameTree').catch(() => null);
        signal.throwIfAborted();
        state.attachedWebViews.set(sessionId, {
          client: child,
          name: frameName,
          frameId: frameTree?.frameTree?.frame?.id ?? params.targetInfo?.targetId,
          order: state.nextAttachedOrder++,
          disposeListeners,
        });
        if (frameName === '__mearl_root__') {
          disposeListeners.push(
            child.on('Fetch.requestPaused', params => {
              void handleRootNavigation(session, state, params, child);
            }),
          );
          await child.sendCommand('Fetch.enable', {
            patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
          });
          signal.throwIfAborted();
        }
        if (!state.childEnvironmentManagedByApp) {
          const childEmulation = state.sideBarWidth
            ? {
                ...state.emulation,
                safeAreaInsets: { ...state.emulation.safeAreaInsets, right: 0 },
              }
            : state.emulation;
          for (const { method, params: commandParams, optional } of buildEnableEmulationCommands(
            childEmulation,
          )) {
            signal.throwIfAborted();
            await child.sendCommand(method, commandParams).catch(error => {
              if (!optional) throw error;
            });
          }
        }
      },
      () => child.sendCommand('Runtime.runIfWaitingForDebugger'),
    );
  } finally {
    if (!state.attachedWebViews.has(sessionId)) {
      for (const dispose of disposeListeners) dispose();
      state.executionContexts.delete(child);
    }
  }
}

async function handleRootNavigation(
  session: PageSession,
  state: DeviceShellState,
  params: WebViewNavigationRequest,
  client: CdpDeviceShellCommandClient,
): Promise<void> {
  const originalHeaders = params.request.headers;
  try {
    if (deviceShellStates.get(session) === state && (await state.navigation.handle(params, client)))
      return;
  } catch {
    // 未被迁移处理器消费的请求继续沿原 WebView 加载。
  }
  await client
    .sendCommand(
      params.responseStatusCode != null || params.responseErrorReason != null
        ? 'Fetch.continueResponse'
        : 'Fetch.continueRequest',
      {
        requestId: params.requestId,
        ...(params.request.headers !== originalHeaders &&
          params.request.headers && {
            headers: Object.entries(params.request.headers).map(([name, value]) => ({
              name,
              value,
            })),
          }),
      },
    )
    .catch(() => {});
}

async function enableDeviceShellFrameRouting(
  session: PageSession,
  state: DeviceShellState,
): Promise<void> {
  state.disposeListeners.push(...trackExecutionContexts(state, session.client));
  state.disposeListeners.push(
    session.client.on('Target.attachedToTarget', params => {
      void installChildTarget(session, state, params).catch(() => {});
    }),
  );
  state.disposeListeners.push(
    session.client.on('Target.detachedFromTarget', params => {
      if (deviceShellStates.get(session) !== state) return;
      const attached = state.attachedWebViews.get(params?.sessionId);
      if (!attached) return;
      for (const dispose of attached.disposeListeners) dispose();
      state.executionContexts.delete(attached.client);
      state.attachedWebViews.delete(params.sessionId);
    }),
  );
  await session.client.sendCommand('Runtime.enable');
  await session.client.sendCommand('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: 'iframe' }, { exclude: true }],
  });
}

function serializeForSource(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, character =>
    character === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

function installDeviceShell(
  config: DeviceShellConfig,
  installChromeView: typeof installDeviceChromeView,
  bindingName: string,
  responseName: string,
): void {
  if (config.rootContainerManagedByApp && !config.sideBarWidth) return;
  const browser = globalThis as unknown as {
    top: unknown;
    location: { protocol: string; href: string };
    document: any;
    addEventListener(
      type: string,
      listener: (event: { source: unknown; data: Record<string, unknown> | null }) => void,
    ): void;
    MutationObserver: new (callback: () => void) => {
      disconnect(): void;
      observe(target: unknown, options: { childList: boolean; subtree?: boolean }): void;
    };
    setTimeout(callback: () => void, timeout: number): number;
    clearTimeout(timer: number): void;
    stop?: () => void;
  };
  const target = globalThis as unknown as Record<string, unknown>;
  const document = browser.document;
  if (
    browser.top !== globalThis ||
    !/^https?:$/i.test(browser.location.protocol) ||
    !/^(text\/html|application\/xhtml\+xml)$/i.test(document.contentType)
  )
    return;
  if (!document.documentElement) {
    const observer = new browser.MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      installDeviceShell(config, installChromeView, bindingName, responseName);
    });
    observer.observe(document, { childList: true });
    return;
  }
  if (config.rootContainerManagedByApp) {
    const style = document.createElement('style');
    style.textContent = `
      [data-mearl-root-webview][data-mearl-split-pane="left"] {
        width: calc((100% - ${config.sideBarWidth}px) / 2) !important;
      }
      [data-mearl-layer][data-mearl-split-pane="right"] {
        left: calc((100% - ${config.sideBarWidth}px) / 2) !important;
        right: ${config.sideBarWidth}px !important;
        width: calc((100% - ${config.sideBarWidth}px) / 2) !important;
      }
      [data-mearl-app-titlebar] { right: ${config.sideBarWidth}px !important; }
    `;
    const chromeHost = document.createElement('div');
    chromeHost.setAttribute('data-mearl-device-chrome-host', '');
    const chromeView = installChromeView(chromeHost.attachShadow({ mode: 'open' }), config);
    const mount = () => {
      if (!document.querySelector('[data-mearl-root-webview]')) return;
      if (document.head && style.parentNode !== document.head) document.head.appendChild(style);
      if (document.body && chromeHost.parentNode !== document.body) {
        document.body.appendChild(chromeHost);
      }
    };
    const observer = new browser.MutationObserver(mount);
    observer.observe(document, { childList: true, subtree: true });
    mount();
    browser.addEventListener('message', event => {
      const message = event.data;
      const state = message?.state as Record<string, unknown> | undefined;
      if (
        message?.source === 'mearl-app-bridge' &&
        message.type === 'titleBarState' &&
        typeof state?.statusBarBackground === 'string' &&
        typeof state.textColor === 'string'
      ) {
        chromeView.updateState({
          statusBarBackground: state.statusBarBackground,
          textColor: state.textColor,
        });
      }
    });
    return;
  }
  const businessUrl = browser.location.href;
  try {
    const shellRoot = document.createElement('html');
    const shellHead = document.createElement('head');
    const charset = document.createElement('meta');
    const viewport = document.createElement('meta');
    const title = document.createElement('title');
    const style = document.createElement('style');
    const shellBody = document.createElement('body');
    const frame = document.createElement('iframe');
    const chromeHost = document.createElement('div');

    shellRoot.setAttribute('data-mearl-device-shell', '');
    shellBody.setAttribute('data-mearl-device-shell', '');
    charset.setAttribute('charset', 'utf-8');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width,initial-scale=1,viewport-fit=cover';
    style.textContent = `
      :root, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #fff; }
      [data-mearl-root-webview] {
        position: fixed; left: 0; right: ${config.sideBarWidth ?? 0}px; top: ${config.statusBarHeight}px;
        width: calc(100% - ${config.sideBarWidth ?? 0}px); height: calc(100% - ${config.statusBarHeight}px);
        border: 0; display: block; background: #fff; z-index: 0;
      }
    `;
    shellHead.append(charset, viewport, title, style);
    shellRoot.append(shellHead, shellBody);

    frame.name = '__mearl_root__';
    frame.setAttribute('data-mearl-root-webview', 'device-shell');
    frame.addEventListener('load', () => {
      if (frame.getAttribute('src') && frame.getAttribute('src') !== 'about:blank') {
        frame.setAttribute('data-mearl-webview-ready', '');
        frame.contentWindow?.postMessage(
          { source: 'mearl-app-bridge', type: 'requestTitleBarState' },
          '*',
        );
      }
    });
    chromeHost.setAttribute('data-mearl-device-chrome-host', '');
    const pendingScreenshots = new Map<
      number,
      {
        resolve: (result: { data: string }) => void;
        reject: (error: Error) => void;
        timer: number;
      }
    >();
    let nextScreenshotId = 1;
    target[responseName] = (
      requestId: number,
      result: { data?: unknown; error?: unknown },
    ): void => {
      const pending = pendingScreenshots.get(requestId);
      if (!pending) return;
      pendingScreenshots.delete(requestId);
      browser.clearTimeout(pending.timer);
      if (typeof result?.data === 'string') pending.resolve({ data: result.data });
      else pending.reject(new Error(String(result?.error ?? 'Screenshot failed')));
    };
    const binding = target[bindingName];
    const captureScreenshot =
      typeof binding === 'function'
        ? () =>
            new Promise<{ data: string }>((resolve, reject) => {
              const requestId = nextScreenshotId++;
              const timer = browser.setTimeout(() => {
                pendingScreenshots.delete(requestId);
                reject(new Error('Screenshot timed out'));
              }, 15_000);
              pendingScreenshots.set(requestId, { resolve, reject, timer });
              try {
                (binding as (payload: string) => void)(
                  JSON.stringify({ type: 'screenshot', requestId }),
                );
              } catch (error) {
                pendingScreenshots.delete(requestId);
                browser.clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            })
        : undefined;
    const chromeView = installChromeView(chromeHost.attachShadow({ mode: 'open' }), config, {
      captureScreenshot,
    });
    browser.addEventListener('message', event => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      const state = message?.state as Record<string, unknown> | undefined;
      if (
        message?.source !== 'mearl-app-bridge' ||
        message.type !== 'titleBarState' ||
        typeof state?.statusBarBackground !== 'string' ||
        typeof state.textColor !== 'string'
      ) {
        return;
      }
      chromeView.updateState({
        statusBarVisible: state.mode !== 'hidden',
        statusBarBackground: state.statusBarBackground,
        textColor: state.textColor,
      });
    });
    shellBody.append(frame, chromeHost);

    const currentRoot = document.documentElement;
    if (currentRoot) document.replaceChild(shellRoot, currentRoot);
    else document.appendChild(shellRoot);
    // The Fetch interceptor supplies an empty shell document. Stopping its
    // parser here can leave embedded Chromium hosts waiting for their first paint.
    frame.src =
      (target.__mearlRootDocumentUrl__ as ((url: string) => string) | undefined)?.(businessUrl) ??
      businessUrl;
  } catch (error) {
    console.warn('[Mearl Device Shell] failed to create root WebView', error);
  }
}

function resolveDeviceShellConfig(
  emulation: ResolvedEmulationConfig,
  options: ApplyCdpDeviceShellOptions,
): DeviceShellConfig {
  const platform = /iPhone|iPad|iPod|Mac/i.test(emulation.platform) ? 'ios' : 'android';
  const sideBarWidth = getDeviceSideBarWidth(emulation.presetName, emulation.orientation);
  return {
    platform,
    statusBarHeight: sideBarWidth
      ? 0
      : emulation.orientation === 'landscape'
        ? 24
        : Math.max(0, Math.round(emulation.safeAreaInsets.top)),
    bottomBarHeight: Math.max(0, Math.round(emulation.safeAreaInsets.bottom)),
    ...(sideBarWidth ? { sideBarWidth } : {}),
    cutout: platform === 'ios' ? emulation.appearance.cutout : 'none',
    ...(options.rootContainerManagedByApp ? { rootContainerManagedByApp: true } : {}),
  };
}

function buildDeviceShellSource(config: DeviceShellConfig): string {
  return `;(${installRootWebViewDocumentTransport.toString()})();(${installDeviceShell.toString()})(${serializeForSource(config)},(${installDeviceChromeView.toString()}),${JSON.stringify(DEVICE_SHELL_BINDING)},${JSON.stringify(DEVICE_SHELL_RESPONSE)});`;
}

async function evaluateDeviceShellContext(
  session: PageSession,
  contextId: number | undefined,
  expression: string,
  options: Record<string, unknown> = {},
): Promise<any> {
  return sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    expression,
    ...(contextId === undefined ? {} : { contextId }),
    ...options,
  });
}

function listenForDeviceShellRequests(session: PageSession, state: DeviceShellState): () => void {
  return session.client.on('Runtime.bindingCalled', params => {
    if (params?.name !== DEVICE_SHELL_BINDING || deviceShellStates.get(session) !== state) return;
    let request: { type?: unknown; requestId?: unknown };
    try {
      request = JSON.parse(params.payload);
    } catch {
      return;
    }
    if (request.type !== 'screenshot' || typeof request.requestId !== 'number') return;
    const requestId = request.requestId;
    const contextId =
      typeof params.executionContextId === 'number' ? params.executionContextId : undefined;
    const reply = (result: { data?: string; error?: string }) =>
      evaluateDeviceShellContext(
        session,
        contextId,
        `globalThis[${JSON.stringify(DEVICE_SHELL_RESPONSE)}]?.(${requestId},${serializeForSource(result)})`,
      );

    void (async () => {
      let hiddenState: { value?: string; priority?: string } | undefined;
      try {
        const hidden = await evaluateDeviceShellContext(
          session,
          contextId,
          `(() => {
            const root = document.documentElement;
            if (!root) return {};
            const property = '--mearl-device-cutout-display';
            const value = root.style.getPropertyValue(property);
            const priority = root.style.getPropertyPriority(property);
            root.style.setProperty(property, 'none', 'important');
            return { value, priority };
          })()`,
          { returnByValue: true },
        );
        hiddenState = hidden.result?.value;
        await evaluateDeviceShellContext(
          session,
          contextId,
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          { awaitPromise: true },
        );
        const result = await session.client.sendCommand('Page.captureScreenshot', {
          format: 'png',
        });
        await reply({ data: result.data });
      } catch (error) {
        await reply({ error: error instanceof Error ? error.message : String(error) }).catch(
          () => {},
        );
      } finally {
        if (hiddenState) {
          await evaluateDeviceShellContext(
            session,
            contextId,
            `(() => {
              const root = document.documentElement;
              if (!root) return;
              const property = '--mearl-device-cutout-display';
              const state = ${serializeForSource(hiddenState)};
              if (root.style.getPropertyValue(property) !== 'none') return;
              if (state.value) root.style.setProperty(property, state.value, state.priority);
              else root.style.removeProperty(property);
            })()`,
          ).catch(() => {});
        }
      }
    })();
  });
}

export function isCdpDeviceShellActive(session: PageSession): boolean {
  return deviceShellStates.has(session);
}

export function setCdpDeviceShellChildEnvironmentManagedByApp(
  session: PageSession,
  managed: boolean,
): void {
  const state = deviceShellStates.get(session);
  if (state) state.childEnvironmentManagedByApp = managed;
}

export async function resolveCdpDeviceShellPageEndpoint(session: PageSession): Promise<{
  client: CdpDeviceShellCommandClient;
  frameId?: string;
  url?: string;
}> {
  const state = deviceShellStates.get(session);
  if (!state) return { client: session.client };
  const updateActiveFrameOffset = (name: DeviceShellFrame['name'] | undefined): void => {
    state.activeFrameOffsetX =
      state.rootContainerManagedByApp && name === '__mearl_layer__'
        ? (state.emulation.width - state.sideBarWidth) / 2
        : 0;
  };

  const attached = Array.from(state.attachedWebViews.values())
    .filter(webView => !webView.client.closed)
    .sort((left, right) => right.order - left.order);
  const activeInParent = await resolveInteractiveWebViewFrame(session.client);
  const attachedActive = activeInParent
    ? attached.find(webView => webView.frameId === activeInParent.id)
    : undefined;
  if (attachedActive) {
    updateActiveFrameOffset(attachedActive.name);
    return { client: attachedActive.client, url: activeInParent?.url };
  }

  const attachedRoot = attached.find(webView => webView.name === '__mearl_root__');
  if (attachedRoot) {
    const active = await resolveInteractiveWebViewFrame(attachedRoot.client);
    if (active && active.id !== attachedRoot.frameId) {
      updateActiveFrameOffset(active.name);
      return { client: attachedRoot.client, frameId: active.id, url: active.url };
    }
    updateActiveFrameOffset(active?.name ?? attachedRoot.name);
    return { client: attachedRoot.client, url: active?.url };
  }

  if (!activeInParent) throw new Error('Device shell business WebView is not ready');
  updateActiveFrameOffset(activeInParent.name);
  return {
    client: session.client,
    frameId: activeInParent.id,
    url: activeInParent.url,
  };
}

export async function sendCdpDeviceShellPageCommand(
  session: PageSession,
  method: string,
  params: Record<string, any> = {},
  timeoutMs?: number,
): Promise<any> {
  const send = (
    client: CdpDeviceShellCommandClient,
    command: string,
    commandParams: Record<string, any>,
  ) => sendCdpPageCommand(session, client, command, commandParams, timeoutMs);
  const state = deviceShellStates.get(session);
  if (!state) return send(session.client, method, params);
  // Before the first HTTP navigation, only the outer document exists. Other
  // actions must still require a ready business WebView.
  if (method === 'Page.navigate' && !(await canLoadCdpDeviceShell(session))) {
    return send(session.client, method, params);
  }
  const endpoint = await resolveCdpDeviceShellPageEndpoint(session);
  if (endpoint.frameId === undefined) return send(endpoint.client, method, params);

  let contextId = state.executionContexts.get(endpoint.client)?.get(endpoint.frameId);
  if ((method === 'Runtime.evaluate' || method === 'DOM.resolveNode') && contextId === undefined) {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && contextId === undefined) {
      const currentEndpoint = await resolveCdpDeviceShellPageEndpoint(session);
      if (
        currentEndpoint.client !== endpoint.client ||
        currentEndpoint.frameId !== endpoint.frameId
      ) {
        return sendCdpDeviceShellPageCommand(session, method, params, timeoutMs);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      contextId = state.executionContexts.get(endpoint.client)?.get(endpoint.frameId);
    }
    if (contextId === undefined) {
      throw new Error('Device shell business WebView execution context is unavailable');
    }
  }
  const nextParams = { ...params };
  if (method === 'Runtime.evaluate' && contextId !== undefined) nextParams.contextId = contextId;
  if (method === 'DOM.resolveNode' && contextId !== undefined) {
    nextParams.executionContextId = contextId;
  }
  if (method === 'Accessibility.getFullAXTree') nextParams.frameId = endpoint.frameId;
  if (method === 'Page.navigate') nextParams.frameId = endpoint.frameId;
  if (method === 'Page.reload') {
    if (!endpoint.url) throw new Error('Device shell business WebView URL is unavailable');
    return send(endpoint.client, 'Page.navigate', {
      url: endpoint.url,
      frameId: endpoint.frameId,
    });
  }
  return send(endpoint.client, method, nextParams);
}

export async function getCdpDeviceShellInputOffset(
  session: PageSession,
): Promise<{ x: number; y: number }> {
  const state = deviceShellStates.get(session);
  if (!state) return { x: 0, y: 0 };
  if (state.rootContainerManagedByApp) {
    await resolveCdpDeviceShellPageEndpoint(session);
  }
  return { x: state.activeFrameOffsetX, y: state.statusBarHeight };
}

export async function applyCdpDeviceShell(
  session: PageSession,
  emulation: ResolvedEmulationConfig,
  options: ApplyCdpDeviceShellOptions = {},
): Promise<boolean> {
  const config = resolveDeviceShellConfig(emulation, options);
  const configKey = JSON.stringify(config);
  const previous = deviceShellStates.get(session);
  if (previous?.configKey === configKey) {
    previous.emulation = emulation;
    if (!previous.childEnvironmentManagedByApp) {
      await Promise.all(
        Array.from(previous.attachedWebViews.values()).map(async webView => {
          for (const { method, params, optional } of buildEnableEmulationCommands(emulation)) {
            await webView.client.sendCommand(method, params).catch(error => {
              if (!optional) throw error;
            });
          }
        }),
      );
    }
    return false;
  }
  if (previous) {
    previous.navigation.dispose();
    for (const dispose of previous.disposeListeners.splice(0)) dispose();
    for (const attached of previous.attachedWebViews.values()) {
      for (const dispose of attached.disposeListeners) dispose();
      if (attached.name === '__mearl_root__')
        await attached.client.sendCommand('Fetch.disable').catch(() => {});
    }
    previous.attachedWebViews.clear();
    previous.executionContexts.clear();
    await session.client
      .sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: previous.documentScriptIdentifier,
      })
      .catch(() => {});
    await session.client
      .sendCommand('Runtime.removeBinding', { name: DEVICE_SHELL_BINDING })
      .catch(() => {});
  }
  await session.client.sendCommand('Runtime.addBinding', { name: DEVICE_SHELL_BINDING });
  const result = await session.client.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: buildDeviceShellSource(config),
  });
  if (typeof result.identifier !== 'string' || !result.identifier) {
    deviceShellStates.delete(session);
    await session.client
      .sendCommand('Runtime.removeBinding', { name: DEVICE_SHELL_BINDING })
      .catch(() => {});
    throw new Error('Chrome did not return a device shell bootstrap script identifier');
  }
  const state: DeviceShellState = {
    navigation: createRootWebViewNavigation({
      client: session.client,
      shellHeaders: async () => (deviceShellStates.get(session) === state ? [] : undefined),
      preserveOrigin: (current, destination) => {
        const proxy = navigationProxies.get(session);
        return Boolean(
          proxy &&
          current.hostname.startsWith(proxy.sourceHostPrefix) &&
          proxy.targetHostSuffixes.some(
            host => destination.hostname === host || destination.hostname.endsWith(`.${host}`),
          ),
        );
      },
    }),
    configKey,
    documentScriptIdentifier: result.identifier,
    emulation,
    statusBarHeight: config.statusBarHeight,
    sideBarWidth: config.sideBarWidth ?? 0,
    executionContexts: new Map(),
    attachedWebViews: new Map(),
    nextAttachedOrder: 0,
    childEnvironmentManagedByApp: options.rootContainerManagedByApp === true,
    rootContainerManagedByApp: options.rootContainerManagedByApp === true,
    activeFrameOffsetX: 0,
    disposeListeners: [],
  };
  deviceShellStates.set(session, state);
  state.disposeListeners.push(listenForDeviceShellRequests(session, state));
  try {
    const tree = await session.client.sendCommand('Page.getFrameTree');
    if (tree.frameTree) state.navigation.initialize(tree.frameTree);
    for (const method of ['Page.frameAttached', 'Page.frameNavigated', 'Page.frameDetached']) {
      state.disposeListeners.push(
        session.client.on(method, params => state.navigation.handleFrameEvent(method, params)),
      );
    }
    await registerCdpFetchPauseHandler(
      session,
      'device-shell-navigation',
      150,
      async ({ params, isResponseStage }) =>
        !isResponseStage &&
        deviceShellStates.get(session) === state &&
        state.navigation.handle(params),
      [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    );
    await registerCdpFetchPauseHandler(
      session,
      'device-shell-document',
      50,
      async ({ params, isResponseStage }) =>
        isResponseStage &&
        deviceShellStates.get(session) === state &&
        state.navigation.handle(params),
      [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }],
    );
    await enableDeviceShellFrameRouting(session, state);
  } catch (error) {
    await clearCdpDeviceShell(session);
    throw error;
  }
  return true;
}

export async function clearCdpDeviceShell(session: PageSession): Promise<boolean> {
  const state = deviceShellStates.get(session);
  if (!state) return false;
  deviceShellStates.delete(session);
  state.navigation.dispose();
  await unregisterCdpFetchPauseHandler(session, 'device-shell-document');
  await unregisterCdpFetchPauseHandler(session, 'device-shell-navigation');
  for (const dispose of state.disposeListeners.splice(0)) dispose();
  for (const attached of state.attachedWebViews.values()) {
    for (const dispose of attached.disposeListeners) dispose();
    if (attached.name === '__mearl_root__')
      await attached.client.sendCommand('Fetch.disable').catch(() => {});
  }
  state.attachedWebViews.clear();
  state.executionContexts.clear();
  await session.client
    .sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: state.documentScriptIdentifier,
    })
    .catch(() => {});
  await session.client
    .sendCommand('Runtime.removeBinding', { name: DEVICE_SHELL_BINDING })
    .catch(() => {});
  if (!state.childEnvironmentManagedByApp) {
    await session.client
      .sendCommand('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => {});
  }
  return true;
}

function hasLoadedRootWebView(frameTree: Record<string, any> | undefined): boolean {
  if (!frameTree) return false;
  const frame = frameTree.frame;
  if (
    frame?.name === '__mearl_root__' &&
    typeof frame.url === 'string' &&
    /^https?:/i.test(frame.url)
  ) {
    return true;
  }
  return Array.isArray(frameTree.childFrames)
    ? frameTree.childFrames.some((child: Record<string, any>) => hasLoadedRootWebView(child))
    : false;
}

/** The shell bootstrap only runs on HTTP documents; blank/new tabs prepare it for navigation. */
export async function canLoadCdpDeviceShell(session: PageSession): Promise<boolean> {
  const { frameTree } = await session.client.sendCommand('Page.getFrameTree');
  return /^https?:/i.test(frameTree?.frame?.url ?? '');
}

export async function waitForCdpDeviceShellLoad(
  session: PageSession,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await session.client.sendCommand('Page.getFrameTree').catch(() => null);
    if (hasLoadedRootWebView(result?.frameTree)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Device shell root WebView load timeout after ${timeoutMs}ms`);
}
