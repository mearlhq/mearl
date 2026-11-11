// Debugger Manager
// 处理 Chrome Debugger API，实现请求拦截和响应修改

import { ResponseOverride } from '../../shared/types';
import {
  assertAppProfilePageRuntimeSupported,
  assertDeviceShellSupported,
} from '../../shared/chromiumVersion';
import {
  installAppProfileDocumentEnvironment,
  resolveAppDeviceUserAgent,
} from '@mearl/app-profiles';
import { getEnvironmentRevision, markEnvironmentMutation } from './environmentRevisions';
import { readPhysicalDeviceEnvironment } from './deviceEnvironmentObservation';
import { isSubset } from '../../shared/isSubset';
import { splitMockConditions } from '../../shared/mockConditions';
import { extractApiName } from './utils';
import { translateJson } from '../panel/utils/translate';
import type { GlobalTranslationTarget } from '../panel/utils/config';
import {
  buildEnableDeviceEnvironmentCommands,
  type DeviceEnvironmentObservation,
  buildEnableEmulationCommands,
  deviceEnvironmentObservationsEqual,
  buildDisableEmulationCommands,
  getDeviceSideBarWidth,
  type InjectedAppProfileConfig,
  type ResolvedEmulationConfig,
  type SafeAreaInsets,
  prepareMockResponseHeaders,
  serializeMockResponse,
  preparePausedDebuggerTarget,
  createRootWebViewNavigation,
  type WebViewFrameTree,
  type WebViewFrameEvent,
  type WebViewDocumentResponse,
} from '@mearl/browser-core';
import { buildAppProfileRuntimeProgram } from './appProfileRuntimeSource';
import {
  acquireDebuggerLease,
  cleanupDebuggerSession,
  handleDebuggerSessionDetach,
  isDebuggerSessionGoneError,
  registerSessionKeepAliveProvider,
  releaseDebuggerSession,
  type DebuggerLease,
} from './debuggerSessionManager';
import {
  clearEmulationConfigForTab,
  getEmulationConfigForTab,
  setEmulationConfigForTab,
} from './deviceEmulationState';
import {
  inheritsDeviceViewport,
  getDeviceShellBootstrapHeaderForTab,
  getDeviceShellForTab,
  type DeviceShellEmulationConfig,
} from './deviceShellRules';
import { getAppProfileBootstrapHeaderForTab, getAppProfileForTab } from './utils/appProfileRules';
import {
  listBusinessWebViewSessions,
  registerRequestCollectionWebView,
  startRequestCollection,
  stopRequestCollection,
} from './backgroundRequestCollector';

// 移动端模拟配置（与 native-host CDP backend 共享类型，避免漂移）
export type EmulationConfig = ResolvedEmulationConfig;

async function sendEmulationCommands(
  target: number | chrome.debugger.Debuggee,
  commands: ReturnType<typeof buildEnableEmulationCommands>,
  signal?: AbortSignal,
) {
  const debuggee = typeof target === 'number' ? { tabId: target } : target;
  for (const { method, params, optional } of commands) {
    signal?.throwIfAborted();
    const host =
      !('sessionId' in debuggee && debuggee.sessionId) && typeof debuggee.tabId === 'number'
        ? await currentHostEnvironment(debuggee.tabId)
        : undefined;
    if (host?.conflicted)
      throw new Error('ENVIRONMENT_STATE_CONFLICT: the physical host environment changed');
    const effective =
      host && method === 'Emulation.setUserAgentOverride'
        ? host.identity
        : host?.preserveInput && method === 'Emulation.setEmitTouchEventsForMouse'
          ? { enabled: false }
          : params;
    signal?.throwIfAborted();
    try {
      await chrome.debugger.sendCommand(debuggee, method, effective);
    } catch (error) {
      if (!optional || isDebuggerSessionGoneError(error)) {
        throw new Error(`${method}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      console.warn(`[debuggerManager] optional emulation command unavailable: ${method}`);
    }
  }
}

async function buildTabEmulationCommands(
  tabId: number,
  config: EmulationConfig,
  resetViewport = false,
) {
  if (!(await getDeviceShellForTab(tabId))?.config.phoneFrame) {
    return buildEnableEmulationCommands(config);
  }
  const [metrics, ...environment] = buildEnableEmulationCommands({ ...config, scale: 1 });
  // The shell uses the browser's available space. Its iframe keeps the preset viewport.
  return [
    ...(resetViewport ? [{ method: 'Emulation.clearDeviceMetricsOverride', params: {} }] : []),
    { ...metrics, params: { ...metrics.params, width: 0, height: 0 } },
    ...environment,
  ];
}

export async function updateDeviceFrameViewportForTab(
  tabId: number,
  config: EmulationConfig,
): Promise<void> {
  await withDebuggerSession(tabId, 'device-frame-viewport', async () => {
    const commands = await buildTabEmulationCommands(tabId, config, true);
    await sendEmulationCommands(
      tabId,
      commands.filter(
        ({ method }) =>
          method === 'Emulation.clearDeviceMetricsOverride' ||
          method === 'Emulation.setDeviceMetricsOverride' ||
          method === 'Emulation.setVisibleSize',
      ),
    );
    setEmulationConfigForTab(tabId, config);
  });
}

// 实时翻译目标语言，由 background/index.ts 通过 setGlobalTranslation 更新
let globalTranslation: GlobalTranslationTarget = 'none';

export function setGlobalTranslation(target: GlobalTranslationTarget) {
  globalTranslation = target;
}

// devtools panel 端口映射（由 background/index.ts 注入）
let devtoolsPorts: Map<number, chrome.runtime.Port> | null = null;

export function initDebuggerDevtoolsPorts(ports: Map<number, chrome.runtime.Port>) {
  devtoolsPorts = ports;
}

function notifyPanelAutoTranslated(tabId: number, apiName: string, duration?: number) {
  const port = devtoolsPorts?.get(tabId);
  if (port) {
    try {
      port.postMessage({ action: 'requestAutoTranslated', tabId, apiName, duration });
    } catch {
      // panel 可能已关闭
    }
  }
}

/**
 * 定向通知 debugger 状态变化
 * - Panel: 通过 devtoolsPorts 发送
 * - Content Script: 通过 chrome.tabs.sendMessage 发送
 */
function notifyDebuggerStatusChanged(tabId: number, attached: boolean) {
  const action = attached ? 'debuggerAttached' : 'debuggerDetached';

  // 1. 通知 Panel（通过 port，定向）
  const port = devtoolsPorts?.get(tabId);
  if (port) {
    try {
      port.postMessage({ action });
    } catch {
      // panel 可能已关闭
    }
  }

  // 2. 通知 Content Script（通过 tabs.sendMessage，定向）
  chrome.tabs.sendMessage(tabId, { action }).catch(() => {
    // Content script 可能未加载，忽略
  });
}

// ==================== 日志缓冲区 ====================

// 每个 tab 的功能状态。各功能通过独立 lease 共享 debugger session，功能状态与
// session 生命周期分别维护，避免临时动作释放其他功能仍在使用的连接。
interface TabState {
  hostEnvironment?: {
    deviceRevision: number;
    appRevision: number;
    identity: {
      userAgent: string;
      platform: string;
      userAgentMetadata: NonNullable<DeviceEnvironmentObservation['userAgentMetadata']>;
    };
    preserveInput: boolean;
    conflicted?: true;
    observation?: DeviceEnvironmentObservation;
  };
  modificationActive: boolean;
  modificationLease?: DebuggerLease;
  responseOverrides: Map<string, ResponseOverride[]>;
  responseOverrideCallCounts: Map<string, number>;
  requestStates: Map<string, { startTime: number; selectedOverride?: ResponseOverride }>;
  interceptGenericRequests: boolean;
  timezoneOverrides: Partial<Record<TimezoneOverrideSource, string>>;
  timezoneSettingsKnown: boolean;
  safeAreaInsetsOverride?: SafeAreaInsets;
  appProfilePageLease?: Promise<DebuggerLease>;
  appProfileMainFrameId?: string;
  appProfileUserAgent?: string;
  appProfileDefinitionRefreshPending?: boolean;
  rootWebViewNavigation?: ReturnType<typeof createRootWebViewNavigation>;
  childDeviceScripts?: Map<string, string>;
  rootWebViewSessionId?: string;
  appProfileDocumentBootstrap?: {
    identifier: string;
    configKey: string;
    needsChildRuntime?: boolean;
  };
  appProfileChildTargetEnvironment?: {
    configKey: string;
    ready: boolean;
    source: string;
    userAgent: string;
    platform: string;
    safeAreaInsets: SafeAreaInsets;
    emulationConfig: DeviceShellEmulationConfig;
    preserveChildViewport: boolean;
  };
}

export type TimezoneOverrideSource = 'agent' | 'settings';

const tabStates = new Map<number, TabState>();

/** Derived from the last successful Root identity write; any later ordinary App/device write expires it. */
async function currentHostEnvironment(tabId: number) {
  const host = tabStates.get(tabId)?.hostEnvironment;
  if (!host) return undefined;
  try {
    const [device, app] = await Promise.all([
      getEnvironmentRevision(tabId, 'device'),
      getEnvironmentRevision(tabId, 'app'),
    ]);
    return tabStates.get(tabId)?.hostEnvironment === host &&
      device === host.deviceRevision &&
      app === host.appRevision
      ? host
      : undefined;
  } catch {
    return undefined;
  }
}

export async function recordHostEnvironmentObservation(
  tabId: number,
  observation: DeviceEnvironmentObservation,
): Promise<void> {
  const host = await currentHostEnvironment(tabId);
  if (host && !host.conflicted) host.observation = structuredClone(observation);
}

async function assertHostEnvironment(tabId: number, signal?: AbortSignal) {
  const host = await currentHostEnvironment(tabId);
  if (!host) return;
  if (host.conflicted)
    throw new Error('ENVIRONMENT_STATE_CONFLICT: the physical host environment changed');
  signal?.throwIfAborted();
  const observed = await readPhysicalDeviceEnvironment(tabId);
  if ((await currentHostEnvironment(tabId)) !== host)
    throw new Error('ENVIRONMENT_STATE_CONFLICT: the host environment owner changed');
  signal?.throwIfAborted();
  // Before the transaction commits, only its completed identity write is known. Once
  // committed, validate the whole observation before our own child-target writes start.
  const expected = host.observation ?? {
    ...observed,
    userAgent: host.identity.userAgent,
    platform: host.identity.platform,
    userAgentMetadata: host.identity.userAgentMetadata,
  };
  if (!deviceEnvironmentObservationsEqual(observed, expected)) {
    host.conflicted = true;
    throw new Error('ENVIRONMENT_STATE_CONFLICT: the physical host environment changed');
  }
}

let refreshAppProfileNavigation:
  | ((
      tabId: number,
      beforeApply?: () => Promise<void>,
    ) => Promise<InjectedAppProfileConfig | undefined>)
  | undefined;
export function setAppProfileNavigationRefresh(
  handler: NonNullable<typeof refreshAppProfileNavigation>,
): void {
  refreshAppProfileNavigation = handler;
}

export function updateAppProfileMainFrame(
  tabId: number,
  frame: { id?: string; parentId?: string },
): void {
  const state = tabStates.get(tabId);
  if (state && frame.id && !frame.parentId) {
    state.appProfileMainFrameId = frame.id;
    state.appProfileDefinitionRefreshPending = false;
  }
}

export function handleRootWebViewFrameEvent(
  tabId: number,
  method: string,
  params: WebViewFrameEvent,
): string | undefined {
  return tabStates.get(tabId)?.rootWebViewNavigation?.handleFrameEvent(method, params);
}

export function allowLocalRootWebViewReload(
  tabId: number,
  frameId: string,
  url: string,
): (() => void) | undefined {
  return tabStates.get(tabId)?.rootWebViewNavigation?.allowLocalReload(frameId, url);
}

async function initializeRootWebViewNavigationForTab(
  tabId: number,
  state: TabState,
): Promise<void> {
  state.rootWebViewNavigation ??= createRootWebViewNavigation({
    keepSameOriginNavigation: true,
    client: {
      sendCommand: (method, payload) => chrome.debugger.sendCommand({ tabId }, method, payload),
    },
    shellHeaders: async forDocument => {
      const deviceHeader = await getDeviceShellBootstrapHeaderForTab(tabId, forDocument);
      if (!deviceHeader) return undefined;
      const appHeader = await getAppProfileBootstrapHeaderForTab(tabId);
      return appHeader ? [deviceHeader, appHeader] : [deviceHeader];
    },
    preserveOrigin: async (current, destination) => {
      const proxy = (await getAppProfileForTab(tabId))?.layerUrlProxy;
      return Boolean(
        proxy &&
        current.hostname.startsWith(proxy.sourceHostPrefix) &&
        proxy.targetHostSuffixes.some(
          host => destination.hostname === host || destination.hostname.endsWith(`.${host}`),
        ),
      );
    },
  });
  const tree = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')) as {
    frameTree?: WebViewFrameTree;
  };
  if (tree?.frameTree) state.rootWebViewNavigation.initialize(tree.frameTree);
}

// 设备/时区模拟是会话级 override，靠 session 持续 attach 才能生效，但它们的 lease 即用即还
// （否则一个长持有的 lease 会让域引用计数难以推理）。登记 keep-alive provider，
// 让 detachIfUnused 在还有 override 的 tab 上不要 detach。
// 外部断开（用户取消、DevTools 挤占）不做自动重连：两种 detach reason
// （target_closed / canceled_by_user）都表示该会话不应该继续，handleDebuggerDetach
// 负责把派生状态一并丢弃。
registerSessionKeepAliveProvider({
  shouldKeepAttached: tabId => {
    if (getEmulationConfigForTab(tabId)) return true;
    const state = tabStates.get(tabId);
    if (state?.appProfileDocumentBootstrap) return true;
    if (state?.appProfileChildTargetEnvironment?.ready) return true;
    if (state?.safeAreaInsetsOverride) return true;
    const overrides = state?.timezoneOverrides;
    return Boolean(overrides?.agent ?? overrides?.settings);
  },
});

function ensureTabState(tabId: number): TabState {
  let state = tabStates.get(tabId);
  if (!state) {
    state = {
      modificationActive: false,
      responseOverrides: new Map(),
      responseOverrideCallCounts: new Map(),
      requestStates: new Map(),
      interceptGenericRequests: false,
      timezoneOverrides: {},
      timezoneSettingsKnown: false,
    };
    tabStates.set(tabId, state);
  }
  return state;
}

// 构建 Fetch 拦截规则列表
function buildFetchPatterns(includeGeneric: boolean) {
  const protocolPatterns = [
    { urlPattern: '*', requestStage: 'Request', resourceType: 'XHR' },
    { urlPattern: '*', requestStage: 'Request', resourceType: 'Fetch' },
    { urlPattern: '*', requestStage: 'Response', resourceType: 'XHR' },
    { urlPattern: '*', requestStage: 'Response', resourceType: 'Fetch' },
  ];
  const documentPatterns = [
    { urlPattern: '*', requestStage: 'Request', resourceType: 'Document' },
    { urlPattern: '*', requestStage: 'Response', resourceType: 'Document' },
  ];
  if (!includeGeneric) return [...protocolPatterns, ...documentPatterns];
  return [
    ...protocolPatterns,
    ...documentPatterns,
    ...['Script', 'Stylesheet'].flatMap(resourceType =>
      ['Request', 'Response'].map(requestStage => ({
        urlPattern: '*',
        resourceType,
        requestStage,
      })),
    ),
  ];
}

function configureWebViewFetch(
  tabId: number,
  sessionId: string,
  state: TabState,
): Promise<unknown> {
  const target = { tabId, sessionId };
  if (state.modificationActive) {
    return chrome.debugger.sendCommand(target, 'Fetch.enable', {
      patterns: buildFetchPatterns(state.interceptGenericRequests),
    });
  }
  if (state.rootWebViewSessionId === sessionId) {
    return chrome.debugger.sendCommand(target, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
  }
  return chrome.debugger.sendCommand(target, 'Fetch.disable');
}

async function updateWebViewFetch(tabId: number, state: TabState): Promise<void> {
  await Promise.all(
    listBusinessWebViewSessions(tabId).map(async sessionId => {
      try {
        await configureWebViewFetch(tabId, sessionId, state);
      } catch (error) {
        if (
          listBusinessWebViewSessions(tabId).includes(sessionId) &&
          !/Session with given id not found/i.test(String(error)) &&
          !isDebuggerSessionGoneError(error)
        )
          throw error;
      }
    }),
  );
}

// 启用修改功能（Fetch 拦截 + 日志缓冲）
export async function enableModificationForTab(tabId: number) {
  const state = ensureTabState(tabId);
  if (state.modificationActive) return;

  await startRequestCollection(tabId, 'response-modification');
  let lease: DebuggerLease | undefined;
  try {
    lease = await acquireDebuggerLease(tabId, {
      consumer: 'response-modification',
      domains: ['Fetch', 'Runtime'],
      domainParams: {
        Fetch: { patterns: buildFetchPatterns(state.interceptGenericRequests) },
      },
      onInvalidated: () => {
        state.modificationLease = undefined;
      },
    });
    state.modificationLease = lease;
    state.modificationActive = true;
    await updateWebViewFetch(tabId, state);
    notifyDebuggerStatusChanged(tabId, true);
  } catch (error) {
    state.modificationLease = undefined;
    state.modificationActive = false;
    await updateWebViewFetch(tabId, state).catch(() => {});
    await lease?.release();
    await stopRequestCollection(tabId, 'response-modification');
    throw error;
  }
}

// 禁用修改功能
export async function disableModificationForTab(tabId: number) {
  const state = tabStates.get(tabId);
  if (!state || !state.modificationActive) {
    await stopRequestCollection(tabId, 'response-modification');
    return;
  }

  const lease = state.modificationLease;
  state.modificationLease = undefined;
  state.modificationActive = false;
  await updateWebViewFetch(tabId, state).catch(() => {});
  await lease?.release();
  notifyDebuggerStatusChanged(tabId, false);
  await stopRequestCollection(tabId, 'response-modification');
}

// 更新 XHR/Fetch 全量拦截开关（在 Requests 子模式切换时调用）
export async function refreshFetchPatterns(tabId: number, includeGeneric: boolean) {
  const state = tabStates.get(tabId);
  if (!state) return;

  state.interceptGenericRequests = includeGeneric;

  // 仅在 modification 开启时重新注册规则
  if (state.modificationActive) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable', {});
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: buildFetchPatterns(includeGeneric),
      });
      await updateWebViewFetch(tabId, state);
    } catch {
      // debugger 可能已被其他方式断开，忽略错误
    }
  }
}

// 生成 override id
function generateOverrideId(): string {
  return crypto.randomUUID();
}

// 设置响应覆盖（id 相同则替换；无 id 时替换同 API 无条件项或追加）
export async function setResponseOverride(tabId: number, override: ResponseOverride) {
  const state = ensureTabState(tabId);
  const key = override.apiName.toLowerCase();
  const list = state.responseOverrides.get(key) || [];

  if (override.id) {
    const idx = list.findIndex(o => o.id === override.id);
    if (idx >= 0) {
      list[idx] = override;
    } else {
      list.push(override);
    }
  } else {
    override.id = generateOverrideId();
    const noCondIdx = list.findIndex(o => !o.conditions || Object.keys(o.conditions).length === 0);
    if (noCondIdx >= 0 && (!override.conditions || Object.keys(override.conditions).length === 0)) {
      list[noCondIdx] = override;
    } else {
      list.push(override);
    }
  }
  state.responseOverrides.set(key, list);
  state.responseOverrideCallCounts.clear();

  if (!state.modificationActive) {
    await enableModificationForTab(tabId);
  }
}

// 移除响应覆盖（传 id 删单条，不传 id 删该 API 全部）
export function removeResponseOverride(tabId: number, apiName: string, id?: string) {
  const state = tabStates.get(tabId);
  if (!state) return;

  const key = apiName.toLowerCase();
  if (!id) {
    state.responseOverrideCallCounts.clear();
    state.responseOverrides.delete(key);
    return;
  }
  const list = state.responseOverrides.get(key);
  if (!list) return;
  const filtered = list.filter(o => o.id !== id);
  if (filtered.length === 0) {
    state.responseOverrides.delete(key);
  } else {
    state.responseOverrides.set(key, filtered);
  }
  if (id) state.responseOverrideCallCounts.clear();
}

// 页面刷新或导航后，顺序 Mock 从第 1 次调用重新开始。
export function resetResponseOverrideCallCounts(tabId: number): void {
  tabStates.get(tabId)?.responseOverrideCallCounts.clear();
}

// 更新响应覆盖的生效条件（按 id 定位）
export function updateOverrideConditions(
  tabId: number,
  apiName: string,
  id: string,
  conditions: Record<string, any> | undefined,
  responseData?: any,
) {
  const state = tabStates.get(tabId);
  if (!state) return;

  const list = state.responseOverrides.get(apiName.toLowerCase());
  if (!list) return;
  const override = list.find(o => o.id === id);
  if (override) {
    override.conditions = conditions && Object.keys(conditions).length > 0 ? conditions : undefined;
    state.responseOverrideCallCounts.clear();
    if (responseData !== undefined) {
      override.modifiedData = responseData;
      override.responseData = responseData;
    }
  }
}

// 尝试将字符串解析为 JSON，失败则返回原字符串
function tryParseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// 检查请求是否满足 override 的生效条件（深度子集匹配）
export function matchesConditions(
  override: ResponseOverride,
  request: { url: string; postData?: string },
): boolean {
  const { requestConditions } = splitMockConditions(override.conditions);
  if (!requestConditions) return true;

  const requestData: Record<string, any> = {};

  try {
    const url = new URL(request.url);
    url.searchParams.forEach((value, key) => {
      requestData[key] = tryParseJson(value);
    });
  } catch {
    /* ignore */
  }

  if (request.postData) {
    try {
      const json = JSON.parse(request.postData);
      if (typeof json === 'object' && json !== null) {
        Object.assign(requestData, json);
      }
    } catch {
      try {
        const decoded = new URLSearchParams(request.postData);
        decoded.forEach((value, key) => {
          requestData[key] = tryParseJson(value);
        });
      } catch {
        /* ignore */
      }
    }
  }

  if (isSubset(requestConditions, requestData)) return true;
  // 兼容简写：条件直接写 data 内层字段时，也尝试匹配 requestData.data
  if (requestData.data && typeof requestData.data === 'object') {
    return isSubset(requestConditions, requestData.data);
  }
  return false;
}

function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// 先按请求条件选择场景，再按该场景的调用次数选择最近的顺序响应。
export function selectResponseOverride(
  overrides: ResponseOverride[],
  request: { url: string; postData?: string },
  callCounts: Map<string, number>,
): ResponseOverride | undefined {
  const matched = overrides.filter(override => matchesConditions(override, request));
  if (matched.length === 0) return undefined;
  const first = matched.reduce((best, override) => {
    const bestSize = Object.keys(
      splitMockConditions(best.conditions).requestConditions ?? {},
    ).length;
    const currentSize = Object.keys(
      splitMockConditions(override.conditions).requestConditions ?? {},
    ).length;
    return currentSize > bestSize ? override : best;
  });
  const conditionsKey = stableStringify(
    splitMockConditions(first.conditions).requestConditions ?? {},
  );
  const scenarioKey = `${first.apiName.toLowerCase()}\0${conditionsKey}`;
  const sequence = matched
    .filter(
      override =>
        splitMockConditions(override.conditions).sequenceIndex !== undefined &&
        stableStringify(splitMockConditions(override.conditions).requestConditions ?? {}) ===
          conditionsKey,
    )
    .sort(
      (a, b) =>
        splitMockConditions(a.conditions).sequenceIndex! -
        splitMockConditions(b.conditions).sequenceIndex!,
    );
  if (sequence.length === 0) return first;

  const callIndex = callCounts.get(scenarioKey) ?? 0;
  callCounts.set(scenarioKey, callIndex + 1);
  return [...sequence]
    .reverse()
    .find(override => splitMockConditions(override.conditions).sequenceIndex! <= callIndex);
}

// 获取所有覆盖配置（flatten）
export function getOverrides(tabId: number): ResponseOverride[] {
  const state = tabStates.get(tabId);
  if (!state) return [];
  const result: ResponseOverride[] = [];
  for (const list of state.responseOverrides.values()) {
    result.push(...list);
  }
  return result;
}

export function selectAppBridgeResponseOverride(
  tabId: number,
  apiName: string,
  request: { url: string; postData?: string },
): ResponseOverride | undefined {
  const state = tabStates.get(tabId);
  if (!state?.modificationActive) return;
  const overrides = state.responseOverrides.get(apiName.toLowerCase());
  if (overrides)
    return selectResponseOverride(overrides, request, state.responseOverrideCallCounts);
}

// ==================== 移动端模拟 ====================

export type SafeAreaRuntimeState = SafeAreaInsets;

async function buildAppProfileDocumentBootstrapScript(
  config: InjectedAppProfileConfig,
): Promise<string> {
  const runtime = await buildAppProfileRuntimeProgram('config', config);
  const serializedConfig = JSON.stringify(config).replace(/[\u2028\u2029]/g, character =>
    character === '\u2028' ? '\\u2028' : '\\u2029',
  );
  return `;(() => {
    const config = ${serializedConfig};
    ${runtime.registration}
    if (window === window.top) {
      (${installAppProfileDocumentEnvironment.toString()})(config, {globals:"always",safeAreaVariables:true});
    } else {
      ${runtime.call};
    }
  })();`;
}

async function buildAppProfileChildTargetBootstrapScript(
  config: InjectedAppProfileConfig,
  emulation: DeviceShellEmulationConfig,
  preserveChildViewport = false,
): Promise<string> {
  return `${buildDeviceShellChildTargetBootstrapScript(emulation, preserveChildViewport)}${await buildAppProfileDocumentBootstrapScript(config)}`;
}

function buildDeviceShellChildTargetBootstrapScript(
  emulation: DeviceShellEmulationConfig,
  preserveChildViewport = false,
): string {
  const fixedViewport = 'width' in emulation ? emulation : null;
  const deviceEnvironment = {
    devicePixelRatio: preserveChildViewport ? null : (fixedViewport?.deviceScaleFactor ?? null),
    screenWidth: preserveChildViewport ? null : (fixedViewport?.width ?? null),
    screenHeight: preserveChildViewport ? null : (fixedViewport?.height ?? null),
    safeAreaInsets: emulation.safeAreaInsets,
  };
  const installDeviceEnvironment = (environment: typeof deviceEnvironment) => {
    const define = (target: object, key: string, value: number) => {
      try {
        Object.defineProperty(target, key, { configurable: true, get: () => value });
      } catch {
        // 浏览器已提供不可配置的原生值时保留原值
      }
    };
    if (environment.devicePixelRatio !== null) {
      define(window, 'devicePixelRatio', environment.devicePixelRatio);
    }
    if (environment.screenWidth !== null && environment.screenHeight !== null) {
      define(screen, 'width', environment.screenWidth);
      define(screen, 'availWidth', environment.screenWidth);
      define(screen, 'height', environment.screenHeight);
      define(screen, 'availHeight', environment.screenHeight);
    }
    const applySafeArea = () => {
      const root = document.documentElement;
      if (!root) return false;
      root.style.setProperty('--safe-area-inset-top', `${environment.safeAreaInsets.top}px`);
      root.style.setProperty('--safe-area-inset-right', `${environment.safeAreaInsets.right}px`);
      root.style.setProperty('--safe-area-inset-bottom', `${environment.safeAreaInsets.bottom}px`);
      root.style.setProperty('--safe-area-inset-left', `${environment.safeAreaInsets.left}px`);
      return true;
    };
    if (!applySafeArea()) {
      const observer = new MutationObserver(() => {
        if (applySafeArea()) observer.disconnect();
      });
      observer.observe(document, { childList: true });
    }
  };
  return `;(${installDeviceEnvironment.toString()})(${JSON.stringify(deviceEnvironment)});`;
}

/** 新文档脚本依赖 Page 域，模拟期间持有域引用，避免短期页面操作结束后禁用它。 */
async function retainAppProfilePageDomain(tabId: number): Promise<void> {
  const state = ensureTabState(tabId);
  if (!state.appProfilePageLease) {
    const pending = acquireDebuggerLease(tabId, {
      consumer: 'app-profile-page',
      domains: ['Page', 'Fetch'],
      domainParams: { Fetch: { patterns: buildFetchPatterns(state.interceptGenericRequests) } },
      onInvalidated: () => {
        if (state.appProfilePageLease !== pending) return;
        state.appProfilePageLease = undefined;
        state.appProfileDocumentBootstrap = undefined;
        state.appProfileMainFrameId = undefined;
        state.appProfileUserAgent = undefined;
        state.rootWebViewNavigation?.dispose();
        state.rootWebViewNavigation = undefined;
      },
    });
    state.appProfilePageLease = pending;
    void pending.catch(() => {
      if (state.appProfilePageLease === pending) state.appProfilePageLease = undefined;
    });
  }
  await state.appProfilePageLease;
}

/**
 * CDP 的 new-document 脚本早于业务 JS。顶层只预置无副作用的容器环境，等待标准
 * document_start 链路创建根容器；业务 WebView 则直接安装完整运行时，确保桥和判端同步就位。
 */
export async function enableAppProfileDocumentBootstrapForTab(
  tabId: number,
  config: InjectedAppProfileConfig,
): Promise<void> {
  if (config.pageRuntime) assertAppProfilePageRuntimeSupported();
  const state = ensureTabState(tabId);
  const configKey = JSON.stringify(config);
  const source = await buildAppProfileDocumentBootstrapScript(config);
  await withDebuggerSession(tabId, 'app-profile-document-bootstrap', async () => {
    await retainAppProfilePageDomain(tabId);
    if (!state.appProfileMainFrameId) {
      const tree = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')) as {
        frameTree?: { frame?: { id?: string } };
      };
      state.appProfileMainFrameId = tree.frameTree?.frame?.id;
    }
    // Service Worker 的合成/缓存响应不经过 DNR，模拟配置和嵌入响应头必须走网络链路。
    await chrome.debugger.sendCommand({ tabId }, 'Network.setBypassServiceWorker', {
      bypass: true,
    });
    if (state.appProfileDocumentBootstrap?.configKey === configKey) return;

    const previous = state.appProfileDocumentBootstrap;
    if (previous?.identifier) {
      await chrome.debugger
        .sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', {
          identifier: previous.identifier,
        })
        .catch(() => {});
    }
    state.appProfileDocumentBootstrap = undefined;

    const result = (await chrome.debugger.sendCommand(
      { tabId },
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
    )) as { identifier?: string };
    if (!result?.identifier) {
      throw new Error('Chrome did not return an app profile bootstrap script identifier');
    }
    try {
      if (config.pageRuntime || previous?.needsChildRuntime) {
        const autoAttach = Boolean(config.pageRuntime || state.appProfileChildTargetEnvironment);
        await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
          autoAttach,
          waitForDebuggerOnStart: autoAttach,
          flatten: true,
          ...(autoAttach ? { filter: [{ type: 'iframe' }, { exclude: true }] } : {}),
        });
      }
    } catch (error) {
      await chrome.debugger
        .sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', {
          identifier: result.identifier,
        })
        .catch(() => {});
      throw error;
    }
    state.appProfileDocumentBootstrap = {
      identifier: result.identifier,
      configKey,
      ...(config.pageRuntime ? { needsChildRuntime: true } : {}),
    };
    state.appProfileUserAgent = config.userAgent;
  }).catch(async error => {
    if (!state.appProfileDocumentBootstrap) {
      await chrome.debugger
        .sendCommand({ tabId }, 'Network.setBypassServiceWorker', {
          bypass: Boolean(state.appProfileChildTargetEnvironment),
        })
        .catch(() => {});
      const pageLease = state.appProfilePageLease;
      state.appProfilePageLease = undefined;
      await pageLease?.then(lease => lease.release()).catch(() => {});
    }
    throw error;
  });
}

/** 停止后续文档的 App 桥注入；设备外壳独立管理业务 WebView 的自动附加策略。 */
export async function disableAppProfileDocumentBootstrapForTab(tabId: number): Promise<void> {
  const state = ensureTabState(tabId);
  const current = state?.appProfileDocumentBootstrap;
  const pageLease = state.appProfileChildTargetEnvironment ? undefined : state.appProfilePageLease;
  if (pageLease) state.appProfilePageLease = undefined;

  await withDebuggerSession(tabId, 'app-profile-document-bootstrap', async () => {
    state.appProfileDocumentBootstrap = undefined;
    state.appProfileUserAgent = undefined;
    if (current?.needsChildRuntime && !state.appProfileChildTargetEnvironment) {
      await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    }
    await chrome.debugger.sendCommand({ tabId }, 'Network.setBypassServiceWorker', {
      bypass: Boolean(state.appProfileChildTargetEnvironment),
    });
    if (current) {
      await chrome.debugger
        .sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', {
          identifier: current.identifier,
        })
        .catch(() => {});
    }
    await pageLease?.then(lease => lease.release());
  });
}

function safeAreaInsetsParams(insets: SafeAreaInsets): Record<string, unknown> {
  return {
    insets: {
      top: insets.top,
      topMax: insets.top,
      right: insets.right,
      rightMax: insets.right,
      bottom: insets.bottom,
      bottomMax: insets.bottom,
      left: insets.left,
      leftMax: insets.left,
    },
  };
}

/**
 * 只覆盖 CSS env(safe-area-inset-*)，保留 DevTools 当前管理的视口、DPR、UA 和触控状态。
 * App 快捷模拟依赖它补齐原生 WebView 安全区，同时不接管用户选择的设备尺寸。
 */
export async function enableSafeAreaInsetsForTab(
  tabId: number,
  insets: SafeAreaInsets,
): Promise<void> {
  const state = ensureTabState(tabId);
  const previous = state.safeAreaInsetsOverride;
  state.safeAreaInsetsOverride = { ...insets };
  try {
    await withDebuggerSession(tabId, 'safe-area-emulation', async () => {
      await markEnvironmentMutation(tabId, 'device');
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setSafeAreaInsetsOverride',
        safeAreaInsetsParams(insets),
      );
    });
  } catch (error) {
    state.safeAreaInsetsOverride = previous;
    throw error;
  }
}

/** 同一 session 内先清后设，确保参数相同时也会重新建立已丢失的 override。 */
export async function reapplySafeAreaInsetsForTab(
  tabId: number,
  insets: SafeAreaInsets,
): Promise<void> {
  const state = ensureTabState(tabId);
  const previous = state.safeAreaInsetsOverride;
  state.safeAreaInsetsOverride = { ...insets };
  try {
    await withDebuggerSession(tabId, 'safe-area-emulation', async () => {
      await markEnvironmentMutation(tabId, 'device');
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setSafeAreaInsetsOverride', {
        insets: {},
      });
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setSafeAreaInsetsOverride',
        safeAreaInsetsParams(insets),
      );
    });
  } catch (error) {
    state.safeAreaInsetsOverride = previous;
    throw error;
  }
}

/**
 * 在现有模拟会话中刷新 CSS 安全区，不改变安全区或设备模拟的所有权。
 * 新建 WebView 导航前调用，确保新文档从初始化阶段就能读取 env(safe-area-inset-*)。
 */
export async function refreshSafeAreaInsetsForTab(
  tabId: number,
  insets: SafeAreaInsets,
): Promise<void> {
  await withDebuggerSession(tabId, 'safe-area-refresh', async () => {
    await sendEmulationCommands(tabId, [
      {
        method: 'Emulation.setSafeAreaInsetsOverride',
        params: { insets: {} },
        optional: true,
      },
      {
        method: 'Emulation.setSafeAreaInsetsOverride',
        params: safeAreaInsetsParams(insets),
        optional: true,
      },
    ]);
  });
}

/** The DevTools device toolbar can clear Chromium's CSS insets on an active preview. */
export async function restorePhoneFrameSafeAreaForTab(tabId: number): Promise<void> {
  const shell = await getDeviceShellForTab(tabId);
  const state = tabStates.get(tabId);
  const environment = state?.appProfileChildTargetEnvironment;
  if (!shell?.config.phoneFrame || !state || !environment?.ready) return;

  const params = safeAreaInsetsParams(environment.safeAreaInsets);
  const setInsets = (target: chrome.debugger.Debuggee & { sessionId?: string }) =>
    chrome.debugger.sendCommand(target, 'Emulation.setSafeAreaInsetsOverride', params);
  // The top CDP session also applies its insets to same-process WebViews.
  await setInsets({ tabId });
  if (state.appProfileChildTargetEnvironment !== environment) return;
  await Promise.all(
    Array.from(state.childDeviceScripts?.keys() ?? [], sessionId =>
      setInsets({ tabId, sessionId }).catch(() => {
        // A navigating frame may have detached. New frame targets receive insets during setup.
      }),
    ),
  );
}

/**
 * 为业务 WebView 注册设备环境。UA 字符串使用 App profile；iOS WebView 不提供 Chromium
 * UA Client Hints，因此该次覆盖不携带 metadata，避免 Chrome 按桌面 Chrome 重新解释设备指标。
 */
export async function prepareAppProfileWebViewEnvironmentForTab(
  tabId: number,
  config: InjectedAppProfileConfig,
  persistedDeviceConfig?: EmulationConfig,
): Promise<void> {
  const deviceConfig = persistedDeviceConfig ?? getEmulationConfigForTab(tabId);
  if (!deviceConfig) {
    await clearDeviceShellWebViewEnvironmentForTab(tabId);
    return;
  }

  await prepareDeviceShellWebViewEnvironmentForTab(tabId, deviceConfig, config);
}

function resolveDeviceShellChildEnvironment(
  deviceConfig: DeviceShellEmulationConfig,
  appProfile?: InjectedAppProfileConfig,
): {
  appProfile?: InjectedAppProfileConfig;
  safeAreaInsets: SafeAreaInsets;
} {
  const presetName = 'presetName' in deviceConfig ? deviceConfig.presetName : undefined;
  const sideRail = getDeviceSideBarWidth(presetName, deviceConfig.orientation) > 0;
  const shellInsets = sideRail
    ? deviceConfig.safeAreaInsets
    : (appProfile?.safeAreaInsets ?? deviceConfig.safeAreaInsets);
  const safeAreaInsets = sideRail ? { ...shellInsets, right: 0 } : shellInsets;
  return {
    ...(appProfile && {
      appProfile: sideRail ? { ...appProfile, statusBarHeight: 0, safeAreaInsets } : appProfile,
    }),
    safeAreaInsets,
  };
}

export async function prepareDeviceShellWebViewEnvironmentForTab(
  tabId: number,
  deviceConfig: DeviceShellEmulationConfig,
  appProfile?: InjectedAppProfileConfig,
  options: { splitScreen?: boolean } = {},
): Promise<void> {
  assertDeviceShellSupported();
  await assertHostEnvironment(tabId);
  const { appProfile: childAppProfile, safeAreaInsets: insets } =
    resolveDeviceShellChildEnvironment(deviceConfig, appProfile);
  const preserveViewport = inheritsDeviceViewport(deviceConfig);
  const preserveChildViewport =
    preserveViewport || (options.splitScreen === true && deviceConfig.orientation === 'landscape');

  const state = ensureTabState(tabId);
  const webViewConfig: DeviceShellEmulationConfig = {
    ...deviceConfig,
    userAgent: appProfile?.userAgent ?? deviceConfig.userAgent,
    safeAreaInsets: insets,
  };
  const configKey = JSON.stringify([childAppProfile ?? null, webViewConfig, preserveChildViewport]);
  if (
    state.appProfileChildTargetEnvironment?.configKey === configKey &&
    state.appProfileChildTargetEnvironment.ready
  ) {
    return;
  }

  const source = childAppProfile
    ? await buildAppProfileChildTargetBootstrapScript(
        childAppProfile,
        webViewConfig,
        preserveChildViewport,
      )
    : buildDeviceShellChildTargetBootstrapScript(webViewConfig, preserveChildViewport);
  const environment = {
    configKey,
    ready: false,
    source,
    userAgent: appProfile?.userAgent ?? deviceConfig.userAgent,
    platform: deviceConfig.platform,
    safeAreaInsets: insets,
    emulationConfig: webViewConfig,
    preserveChildViewport,
  };
  state.appProfileChildTargetEnvironment = environment;
  await withDebuggerSession(tabId, 'device-shell-webview-environment', async () => {
    await retainAppProfilePageDomain(tabId);
    await initializeRootWebViewNavigationForTab(tabId, state);
    await chrome.debugger.sendCommand({ tabId }, 'Network.setBypassServiceWorker', {
      bypass: true,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'iframe' }, { exclude: true }],
    });
    const commands = (
      preserveViewport
        ? buildEnableDeviceEnvironmentCommands(webViewConfig)
        : await buildTabEmulationCommands(tabId, webViewConfig as EmulationConfig)
    ).map(command =>
      command.method === 'Emulation.setUserAgentOverride'
        ? {
            ...command,
            params: {
              userAgent: appProfile?.userAgent ?? deviceConfig.userAgent,
              platform: deviceConfig.platform,
            },
          }
        : command,
    );
    await ensureDeviceShellParentEnvironment(
      tabId,
      commands,
      webViewConfig,
      appProfile?.userAgent ?? deviceConfig.userAgent,
    );
    if (state.appProfileChildTargetEnvironment === environment) environment.ready = true;
  }).catch(async error => {
    if (state.appProfileChildTargetEnvironment === environment) {
      state.appProfileChildTargetEnvironment = undefined;
      await chrome.debugger
        .sendCommand({ tabId }, 'Network.setBypassServiceWorker', {
          bypass: Boolean(state.appProfileDocumentBootstrap),
        })
        .catch(() => {});
      if (!state.appProfileDocumentBootstrap) {
        const lease = state.appProfilePageLease;
        state.appProfilePageLease = undefined;
        state.rootWebViewNavigation?.dispose();
        state.rootWebViewNavigation = undefined;
        await lease?.then(current => current.release()).catch(() => {});
      }
    }
    throw error;
  });
}

export async function clearDeviceShellWebViewEnvironmentForTab(tabId: number): Promise<void> {
  const state = ensureTabState(tabId);
  state.appProfileChildTargetEnvironment = undefined;
  state.hostEnvironment = undefined;
  state.rootWebViewNavigation?.dispose();
  state.rootWebViewNavigation = undefined;
  const scripts = state.childDeviceScripts;
  state.childDeviceScripts = undefined;
  await withDebuggerSession(tabId, 'device-shell-webview-environment', async () => {
    await Promise.all(
      Array.from(scripts ?? [], ([sessionId, identifier]) => {
        const target = { tabId, sessionId };
        return chrome.debugger
          .sendCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })
          .catch(() => {});
      }),
    );
    await chrome.debugger.sendCommand({ tabId }, 'Network.setBypassServiceWorker', {
      bypass: Boolean(state.appProfileDocumentBootstrap),
    });
    await chrome.debugger
      .sendCommand({ tabId }, 'Target.setAutoAttach', {
        autoAttach: Boolean(state.appProfileDocumentBootstrap?.needsChildRuntime),
        waitForDebuggerOnStart: Boolean(state.appProfileDocumentBootstrap?.needsChildRuntime),
        flatten: true,
        ...(state.appProfileDocumentBootstrap?.needsChildRuntime
          ? { filter: [{ type: 'iframe' }, { exclude: true }] }
          : {}),
      })
      .catch(() => {});
    if (!state.appProfileDocumentBootstrap) {
      const lease = state.appProfilePageLease;
      state.appProfilePageLease = undefined;
      await lease?.then(current => current.release()).catch(() => {});
    }
  });
}

async function registerChildDeviceScript(
  state: TabState,
  target: chrome.debugger.Debuggee & { sessionId: string },
  source: string,
): Promise<void> {
  const scripts = (state.childDeviceScripts ??= new Map());
  const previous = scripts.get(target.sessionId);
  const { identifier } = (await chrome.debugger.sendCommand(
    target,
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source,
    },
  )) as { identifier?: string };
  if (!identifier) return;
  scripts.set(target.sessionId, identifier);
  if (previous) {
    await chrome.debugger.sendCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', {
      identifier: previous,
    });
  }
}

export function forgetChildDeviceSession(tabId: number, sessionId: string): void {
  const state = tabStates.get(tabId);
  if (!state) return;
  state.childDeviceScripts?.delete(sessionId);
  if (state.rootWebViewSessionId === sessionId) state.rootWebViewSessionId = undefined;
  for (const key of state.requestStates.keys()) {
    if (key.startsWith(`${sessionId}:`)) state.requestStates.delete(key);
  }
}

export async function refreshChildDeviceScripts(tabId: number): Promise<void> {
  const state = tabStates.get(tabId);
  const environment = state?.appProfileChildTargetEnvironment;
  if (!state || !environment) return;
  await Promise.all(
    Array.from(state.childDeviceScripts?.keys() ?? [], async sessionId => {
      const target = { tabId, sessionId };
      await chrome.debugger.sendCommand(target, 'Network.setUserAgentOverride', {
        userAgent: environment.userAgent,
        platform: environment.platform,
      });
      await chrome.debugger
        .sendCommand(
          target,
          'Emulation.setSafeAreaInsetsOverride',
          safeAreaInsetsParams(environment.safeAreaInsets),
        )
        .catch(() => {});
      await registerChildDeviceScript(state, target, environment.source);
    }),
  );
}

/**
 * 业务 WebView 的 OOPIF 有独立 CDP target。自动附加会先暂停 iframe target，并通过
 * frame 元数据区分容器创建的 root/layer，不依赖尚未建立的脚本上下文。业务 target 在首行脚本前补齐设备环境；
 * 普通 iframe 仅注册动态运行时，由 document_start 配置安装桥，不接管导航与视口。
 */
export async function handleAppProfileChildTargetEvent(
  tabId: number,
  method: string,
  params: any,
  persistedConfig?: InjectedAppProfileConfig,
  persistedDeviceConfig?: DeviceShellEmulationConfig,
  splitScreen = false,
): Promise<void> {
  if (method !== 'Target.attachedToTarget') return;
  const sessionId = params?.sessionId;
  if (typeof sessionId !== 'string') return;

  const target = { tabId, sessionId };
  const registerPageRuntime = async (signal: AbortSignal) => {
    const config = persistedConfig ?? (await getAppProfileForTab(tabId));
    signal.throwIfAborted();
    if (!config?.pageRuntime) return;
    const { registration } = await buildAppProfileRuntimeProgram('config', config);
    signal.throwIfAborted();
    await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', {
      source: registration,
    });
    signal.throwIfAborted();
    return registration;
  };
  try {
    const source = await preparePausedDebuggerTarget(
      async signal => {
        if (String(params?.targetInfo?.url ?? '').startsWith('chrome-extension://')) return;
        const targetType = params?.targetInfo?.type;
        let frameName: string | undefined;
        if (targetType === 'iframe') {
          await chrome.debugger.sendCommand(target, 'Page.enable');
          signal.throwIfAborted();
          const tree = (await chrome.debugger.sendCommand(target, 'Page.getFrameTree')) as
            | {
                frameTree?: WebViewFrameTree;
              }
            | undefined;
          signal.throwIfAborted();
          const frame = tree?.frameTree?.frame;
          frameName = frame?.name;
          // An auto-attached iframe can have an empty URL until Chrome resumes its renderer.
          if (
            frameName === '__mearl_preview_panel__' ||
            frame?.url?.startsWith('chrome-extension://')
          )
            return;
          if (frameName !== '__mearl_root__' && frameName !== '__mearl_layer__') {
            return registerPageRuntime(signal);
          }
        }
        let environment = tabStates.get(tabId)?.appProfileChildTargetEnvironment;
        if (!environment && !persistedDeviceConfig) {
          const [profile, deviceShell] = await Promise.all([
            getAppProfileForTab(tabId),
            getDeviceShellForTab(tabId),
          ]);
          signal.throwIfAborted();
          persistedConfig ??= profile ?? undefined;
          persistedDeviceConfig = deviceShell?.emulation;
          splitScreen = deviceShell?.splitScreen ?? splitScreen;
        }
        if (!environment && persistedDeviceConfig) {
          const preserveViewport = inheritsDeviceViewport(persistedDeviceConfig);
          const { appProfile: childAppProfile, safeAreaInsets } =
            resolveDeviceShellChildEnvironment(persistedDeviceConfig, persistedConfig);
          const userAgent = persistedConfig?.userAgent ?? persistedDeviceConfig.userAgent;
          const preserveChildViewport =
            preserveViewport || (splitScreen && persistedDeviceConfig.orientation === 'landscape');
          environment = {
            configKey: JSON.stringify([
              childAppProfile ?? null,
              persistedDeviceConfig,
              preserveChildViewport,
            ]),
            ready: true,
            source: childAppProfile
              ? await buildAppProfileChildTargetBootstrapScript(
                  childAppProfile,
                  {
                    ...persistedDeviceConfig,
                    userAgent,
                    safeAreaInsets,
                  },
                  preserveChildViewport,
                )
              : buildDeviceShellChildTargetBootstrapScript(
                  {
                    ...persistedDeviceConfig,
                    safeAreaInsets,
                  },
                  preserveChildViewport,
                ),
            userAgent,
            platform: persistedDeviceConfig.platform,
            safeAreaInsets,
            emulationConfig: {
              ...persistedDeviceConfig,
              userAgent,
              safeAreaInsets,
            },
            preserveChildViewport,
          };
        }
        signal.throwIfAborted();
        if (targetType === 'iframe') {
          const identity = environment
            ? { userAgent: environment.userAgent, platform: environment.platform }
            : persistedConfig && {
                userAgent: persistedConfig.userAgent,
                platform: persistedConfig.navigatorPlatform,
              };
          if (identity) {
            await assertHostEnvironment(tabId, signal);
            // Each OOPIF owns its network identity. Omitting metadata clears desktop
            // Client Hints without applying a device override to the physical Root.
            await chrome.debugger.sendCommand(target, 'Network.setUserAgentOverride', identity);
            signal.throwIfAborted();
          }
          if (!environment) return registerPageRuntime(signal);
          await registerRequestCollectionWebView(tabId, sessionId);
          signal.throwIfAborted();
          const commands = (
            inheritsDeviceViewport(environment.emulationConfig)
              ? buildEnableDeviceEnvironmentCommands(environment.emulationConfig)
              : await buildTabEmulationCommands(
                  tabId,
                  environment.emulationConfig as EmulationConfig,
                )
          ).map(command => ({
            ...command,
            ...(command.method === 'Emulation.setUserAgentOverride'
              ? {
                  params: {
                    userAgent: environment.userAgent,
                    platform: environment.platform,
                  },
                }
              : {}),
          }));
          // Chromium permits touch on OOPIFs, but device metrics are top-level only.
          await sendEmulationCommands(
            target,
            commands.filter(command => command.method === 'Emulation.setTouchEmulationEnabled'),
            signal,
          );
          await chrome.debugger
            .sendCommand(
              target,
              'Emulation.setSafeAreaInsetsOverride',
              safeAreaInsetsParams(environment.safeAreaInsets),
            )
            .catch(() => {});
          signal.throwIfAborted();
          await registerChildDeviceScript(ensureTabState(tabId), target, environment.source);
          signal.throwIfAborted();
          const state = ensureTabState(tabId);
          if (frameName === '__mearl_root__') state.rootWebViewSessionId = sessionId;
          if (frameName === '__mearl_root__' || state.modificationActive) {
            await configureWebViewFetch(tabId, sessionId, state);
            signal.throwIfAborted();
          }
          // 业务 WebView target 建立及其 UA override 可能让 Chrome 重算外层设备指标；只在
          // 明确的 root/layer WebView 上检查父环境，普通广告和验证码 iframe 不触碰父 target。
          // 状态仍正确时不重设 viewport，避免 clear + set 在跳转中间暴露一帧桌面尺寸。
          await ensureDeviceShellParentEnvironment(
            tabId,
            commands,
            environment.emulationConfig,
            environment.userAgent,
            signal,
          );
          signal.throwIfAborted();
          return environment.source;
        }
      },
      () => chrome.debugger.sendCommand(target, 'Runtime.runIfWaitingForDebugger', {}),
    );
    if (source)
      await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: source });
  } catch (error) {
    console.warn(`[debuggerManager] failed to prepare child WebView target on tab ${tabId}`, error);
  }
}

/** 清除快捷 App 模拟拥有的安全区，不修改其余设备模拟字段。 */
export async function disableSafeAreaInsetsForTab(tabId: number): Promise<void> {
  const state = tabStates.get(tabId);
  if (!state?.safeAreaInsetsOverride) return;

  state.safeAreaInsetsOverride = undefined;
  await withDebuggerSession(tabId, 'safe-area-emulation', async () => {
    await chrome.debugger
      .sendCommand({ tabId }, 'Emulation.setSafeAreaInsetsOverride', { insets: {} })
      .catch(() => {
        // session 已被外部断开时 override 也已随之消失
      });
  });
}

/**
 * 设备模拟已经写入完整安全区时，仅释放独立安全区租约，避免后续清理覆盖新设备的参数。
 */
export function releaseSafeAreaInsetsOwnershipForTab(tabId: number): void {
  const state = tabStates.get(tabId);
  if (state) state.safeAreaInsetsOverride = undefined;
}

export function getSafeAreaInsetsForTab(tabId: number): SafeAreaInsets | undefined {
  const insets = tabStates.get(tabId)?.safeAreaInsetsOverride;
  return insets ? { ...insets } : undefined;
}

/** 读取页面实际解析出的 CSS env 安全区，避免只验证配置登记而误报成功。 */
export async function readSafeAreaRuntimeState(
  tabId: number,
): Promise<SafeAreaRuntimeState | null> {
  try {
    return await withDebuggerSession(tabId, 'safe-area-check', async () => {
      const result = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(() => {
          const probe = document.createElement('div');
          probe.style.cssText = [
            'position:fixed',
            'visibility:hidden',
            'pointer-events:none',
            'padding-top:env(safe-area-inset-top)',
            'padding-right:env(safe-area-inset-right)',
            'padding-bottom:env(safe-area-inset-bottom)',
            'padding-left:env(safe-area-inset-left)'
          ].join(';');
          document.documentElement.appendChild(probe);
          const style = getComputedStyle(probe);
          const value = {
            top: parseFloat(style.paddingTop) || 0,
            right: parseFloat(style.paddingRight) || 0,
            bottom: parseFloat(style.paddingBottom) || 0,
            left: parseFloat(style.paddingLeft) || 0
          };
          probe.remove();
          return value;
        })()`,
        returnByValue: true,
      })) as { result?: { value?: SafeAreaRuntimeState }; exceptionDetails?: unknown };
      if (result.exceptionDetails) return null;
      return result.result?.value ?? null;
    });
  } catch {
    return null;
  }
}

export function safeAreaRuntimeStateMatches(
  state: SafeAreaRuntimeState | null,
  expected: SafeAreaInsets,
): boolean {
  return Boolean(
    state &&
    state.top === expected.top &&
    state.right === expected.right &&
    state.bottom === expected.bottom &&
    state.left === expected.left,
  );
}

/**
 * 在一个 debugger lease 内执行 CDP 命令，并对「session 在 acquire 之后被断开」重试一次。
 *
 * acquire 只能保证获取那一刻 session 活着；它与 sendCommand 之间的窗口无法消除（跨 site 导航、
 * DevTools 挤占都会断开），表现为间歇性的 "Debugger is not attached"。第二次 acquire 会探测
 * 到已断并重连，所以重试能收敛；仍失败则是真故障，原错抛出。
 */
async function withDebuggerSession<T>(
  tabId: number,
  consumer: string,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const lease = await acquireDebuggerLease(tabId, { consumer });
    try {
      return await run();
    } catch (error) {
      if (attempt >= 1 || !isDebuggerSessionGoneError(error)) {
        console.warn(
          '[debuggerManager] command failed',
          JSON.stringify({
            tabId,
            consumer,
            generation: lease.generation,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
      console.warn(
        `[debuggerManager] ${consumer} lost its session mid-command on tab ${tabId}; retrying once`,
        JSON.stringify({
          generation: lease.generation,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      handleDebuggerSessionDetach(tabId, 'command_failed', lease.generation);
    } finally {
      await lease.release();
    }
  }
}

/**
 * 启用移动端模拟。复用已存在的 debugger session；重复调用会用新配置覆盖旧配置。
 * 与 modification 完全独立——同时开启时各自管理自己的关闭。
 */
export async function enableEmulationForTab(tabId: number, config: EmulationConfig): Promise<void> {
  await withDebuggerSession(tabId, 'device-emulation', async () => {
    await markEnvironmentMutation(tabId, 'device');
    await sendEmulationCommands(tabId, await buildTabEmulationCommands(tabId, config, true));
    // 登记在 release 之前：detachIfUnused 依据登记表保持 attach
    setEmulationConfigForTab(tabId, config);
  });
}

/** Commit shared UA/safe-area fields once after the App/device intents and document scripts agree. */
export async function synchronizeAppDeviceIdentityForTab(
  tabId: number,
  baseline: DeviceEnvironmentObservation,
  options: { preserveHostPlatform?: boolean; preserveHostInput?: boolean } = {},
): Promise<void> {
  const device = getEmulationConfigForTab(tabId);
  const shell = await getDeviceShellForTab(tabId);
  const app = await getAppProfileForTab(tabId);
  const { userAgent, userAgentMetadata } = resolveAppDeviceUserAgent(
    baseline,
    device,
    shell && app ? app.userAgent : undefined,
  );
  if (!userAgentMetadata)
    throw new Error(
      'ENVIRONMENT_BASELINE_UNSUPPORTED: native Client Hints must be captured before an override',
    );
  const identity = {
    userAgent,
    platform: options.preserveHostPlatform
      ? baseline.platform
      : (device?.platform ?? baseline.platform),
    userAgentMetadata,
  };
  await withDebuggerSession(tabId, 'app-device-identity', async () => {
    await markEnvironmentMutation(tabId, 'device');
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', identity);
    if (options.preserveHostInput)
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmitTouchEventsForMouse', {
        enabled: false,
      });
    await chrome.debugger.sendCommand(
      { tabId },
      'Emulation.setSafeAreaInsetsOverride',
      safeAreaInsetsParams(device?.safeAreaInsets ?? baseline.safeAreaInsets),
    );
    ensureTabState(tabId).hostEnvironment =
      (device || app) && (options.preserveHostPlatform || options.preserveHostInput)
        ? {
            deviceRevision: await getEnvironmentRevision(tabId, 'device'),
            appRevision: await getEnvironmentRevision(tabId, 'app'),
            identity,
            preserveInput: Boolean(options.preserveHostInput),
          }
        : undefined;
  });
}

/**
 * 重新下发设备模拟：在同一个 session 内先 clear 再重设。
 *
 * 参数不变时重复下发 setDeviceMetricsOverride 是 no-op，不会让已失效的 override 重新生效，
 * 所以必须先 clear。而 disable + enable 分两步调不行：disableEmulationForTab 会先清登记，
 * 使 shouldKeepAttached 变 false，release 时把 session detach 掉，两步之间就多出一个
 * detach + 重新 attach 的竞态窗口。
 */
export async function reapplyEmulationForTab(
  tabId: number,
  config: EmulationConfig,
): Promise<void> {
  await withDebuggerSession(tabId, 'device-emulation', async () => {
    await markEnvironmentMutation(tabId, 'device');
    await sendEmulationCommands(tabId, buildDisableEmulationCommands());
    await sendEmulationCommands(tabId, await buildTabEmulationCommands(tabId, config));
    setEmulationConfigForTab(tabId, config);
  });
}

export interface EmulationRuntimeState {
  screenWidth: number;
  deviceScaleFactor: number;
  userAgent: string;
  maxTouchPoints: number;
}

async function ensureDeviceShellParentEnvironment(
  tabId: number,
  commands: ReturnType<typeof buildEnableEmulationCommands>,
  config: DeviceShellEmulationConfig,
  expectedUserAgent: string,
  signal?: AbortSignal,
): Promise<void> {
  if (inheritsDeviceViewport(config)) {
    await sendEmulationCommands(tabId, commands, signal);
    return;
  }
  if ((await getDeviceShellForTab(tabId))?.config.phoneFrame) {
    // The preview's iframe owns the preset dimensions. DevTools may size the outer viewport.
    await sendEmulationCommands(
      tabId,
      commands.filter(
        ({ method }) =>
          method !== 'Emulation.setDeviceMetricsOverride' && method !== 'Emulation.setVisibleSize',
      ),
      signal,
    );
    return;
  }
  if (!('width' in config)) {
    throw new Error('Fixed device shell environment requires viewport metrics');
  }

  const runtimeState = await readEmulationRuntimeStateForTarget(tabId);
  signal?.throwIfAborted();
  if (emulationRuntimeStateMatches(runtimeState, config, expectedUserAgent)) return;

  const metricsMatch = emulationMetricsMatch(runtimeState, config);
  if (!metricsMatch) {
    // Chrome 偶尔保留了配置登记但丢失实际 viewport；此时相同参数可能被当成 no-op，
    // 仅在运行态确实不匹配时 clear，避免正常跳转重绘当前页面。
    await sendEmulationCommands(tabId, buildDisableEmulationCommands(), signal);
  }
  await sendEmulationCommands(
    tabId,
    metricsMatch
      ? commands.filter(command => command.method !== 'Emulation.setDeviceMetricsOverride')
      : commands,
    signal,
  );
}

function emulationMetricsMatch(
  state: EmulationRuntimeState | null,
  config: EmulationConfig,
): boolean {
  return Boolean(
    state &&
    state.screenWidth === config.width &&
    Math.abs(state.deviceScaleFactor - config.deviceScaleFactor) < 0.01,
  );
}

export function emulationRuntimeStateMatches(
  state: EmulationRuntimeState | null,
  config: EmulationConfig,
  expectedUserAgent = config.userAgent,
): boolean {
  return Boolean(
    emulationMetricsMatch(state, config) &&
    state?.userAgent === expectedUserAgent &&
    (config.touch ? state.maxTouchPoints > 0 : state.maxTouchPoints === 0),
  );
}

async function readEmulationRuntimeStateForTarget(
  target: number | chrome.debugger.Debuggee,
): Promise<EmulationRuntimeState | null> {
  const debuggee = typeof target === 'number' ? { tabId: target } : target;
  const result = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
    expression: `({
      screenWidth: window.screen.width,
      deviceScaleFactor: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints
    })`,
    returnByValue: true,
  })) as { result?: { value?: EmulationRuntimeState }; exceptionDetails?: unknown };
  if (result.exceptionDetails) return null;
  return result.result?.value ?? null;
}

/**
 * 读取当前文档的实际模拟态。
 *
 * 必须走 lease：reload 后 session 可能已断，裸 sendCommand 会把「读不到」和「模拟未生效」
 * 压成同一个结果，掩盖真正原因。screen.width 比 innerWidth 稳，不受滚动条与页面缩放影响。
 */
export async function readEmulationRuntimeState(
  tabId: number,
): Promise<EmulationRuntimeState | null> {
  try {
    return await withDebuggerSession(tabId, 'emulation-check', () =>
      readEmulationRuntimeStateForTarget(tabId),
    );
  } catch {
    return null;
  }
}

/**
 * 在 CDP session 内重载页面。
 *
 * chrome.tabs.reload() 会间歇性导致 debugger session 被断开（实测：reload 后读取模拟态
 * 报 "not attached"，Emulation override 随之丢失）。Page.reload 是 session 内部的命令，
 * 不经由 tabs API 重新接管标签页，因此不会把自己所在的 session 弄掉。
 */
export async function reloadTabInSession(
  tabId: number,
  options: { startWithDeviceShell?: boolean } = {},
): Promise<void> {
  await withDebuggerSession(tabId, 'emulation-reload', async () => {
    const state = tabStates.get(tabId);
    const cancel =
      options.startWithDeviceShell && !state?.modificationActive
        ? state?.rootWebViewNavigation?.prepareShellReload()
        : undefined;
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: false });
    } catch (error) {
      cancel?.();
      throw error;
    }
  });
}

/** 在当前 debugger session 内发起页面导航，供需要在首个请求前设置 override 的流程使用。 */
export async function navigateTabInSession(tabId: number, url: string): Promise<void> {
  await withDebuggerSession(tabId, 'page-navigation', async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
  });
}

/** 关闭移动端模拟。无其他消费者/override 时一并 detach，避免长期占用 session */
export async function disableEmulationForTab(tabId: number): Promise<void> {
  if (!getEmulationConfigForTab(tabId)) return;
  await markEnvironmentMutation(tabId, 'device');
  clearEmulationConfigForTab(tabId);
  const lease = await acquireDebuggerLease(tabId, { consumer: 'device-emulation' });
  try {
    for (const { method, params } of buildDisableEmulationCommands()) {
      await chrome.debugger.sendCommand({ tabId }, method, params).catch(() => {
        // session 可能已被外部断开
      });
    }
  } finally {
    await lease.release();
  }
}

// ==================== 时区模拟 ====================

/** Hydrate only bookkeeping from the latest saved UI preference, without sending CDP effects. */
export function hydrateRecordedTimezoneSettings(tabId: number, timezone?: string): void {
  const state = ensureTabState(tabId);
  if (state.timezoneSettingsKnown) return;
  state.timezoneSettingsKnown = true;
  if (timezone) state.timezoneOverrides.settings = timezone;
}

/** Re-associate a persisted, reverified binding without replaying its browser command. */
export function restoreRecordedTimezoneOwnership(tabId: number, timezone: string): void {
  const state = ensureTabState(tabId);
  if (state.timezoneOverrides.agent !== undefined && state.timezoneOverrides.agent !== timezone)
    throw new Error('ENVIRONMENT_STATE_CONFLICT');
  state.timezoneOverrides.agent = timezone;
}

/** 使用 CDP 原生时区覆盖；与 Mock、移动端模拟共享 debugger session。 */
export async function enableTimezoneForTab(
  tabId: number,
  timezone: string,
  source: TimezoneOverrideSource = 'agent',
): Promise<void> {
  if (source === 'agent') await markEnvironmentMutation(tabId, 'timezone');
  const state = ensureTabState(tabId);
  const previousTimezone = state.timezoneOverrides[source];
  const settingsKnown = state.timezoneSettingsKnown;
  if (source === 'settings') state.timezoneSettingsKnown = true;
  state.timezoneOverrides[source] = timezone;
  const effectiveTimezone = state.timezoneOverrides.agent ?? state.timezoneOverrides.settings;

  const lease = await acquireDebuggerLease(tabId, { consumer: 'timezone-emulation' });
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', {
      timezoneId: effectiveTimezone,
    });
  } catch (error) {
    state.timezoneSettingsKnown = settingsKnown;
    if (previousTimezone === undefined) delete state.timezoneOverrides[source];
    else state.timezoneOverrides[source] = previousTimezone;
    throw error;
  } finally {
    await lease.release();
  }
}

/** 恢复浏览器默认时区；无其他消费者时释放 debugger session。 */
export async function disableTimezoneForTab(
  tabId: number,
  source: TimezoneOverrideSource = 'agent',
): Promise<void> {
  const state = tabStates.get(tabId);
  if (state && source === 'settings') state.timezoneSettingsKnown = true;
  if (!state?.timezoneOverrides[source]) return;

  if (source === 'agent') await markEnvironmentMutation(tabId, 'timezone');

  delete state.timezoneOverrides[source];
  const effectiveTimezone = state.timezoneOverrides.agent ?? state.timezoneOverrides.settings ?? '';

  const lease = await acquireDebuggerLease(tabId, { consumer: 'timezone-emulation' });
  try {
    await chrome.debugger
      .sendCommand({ tabId }, 'Emulation.setTimezoneOverride', { timezoneId: effectiveTimezone })
      .catch(() => {
        // session 可能已被外部断开
      });
  } finally {
    await lease.release();
  }
}

// 获取 debugger 状态（语义：modification 是否启用——驱动 Panel 的 Mock 开关 UI）
export function getDebuggerStatus(tabId: number): boolean {
  const state = tabStates.get(tabId);
  return state ? state.modificationActive : false;
}

// 获取 tab 状态（用于测试）
export function getTabState(tabId: number) {
  return tabStates.get(tabId);
}

/** 返回仍保存 debugger 会话级状态的标签页，包括已被 Chrome 外部断开的会话。 */
export function listDebuggerControlTabIds(): number[] {
  return Array.from(tabStates.keys());
}

// 处理暂停的请求
export async function handleRequestPaused(tabId: number, params: any, sessionId?: string) {
  const { requestId, request, responseStatusCode, responseHeaders } = params;
  const requestKey = sessionId ? `${sessionId}:${requestId}` : requestId;
  const originalHeaders = request.headers;
  const state = tabStates.get(tabId);
  if (
    !sessionId &&
    !responseStatusCode &&
    !params.responseErrorReason &&
    params.resourceType === 'Document' &&
    request.method === 'GET' &&
    state?.appProfileDocumentBootstrap &&
    !state.appProfileDefinitionRefreshPending &&
    refreshAppProfileNavigation
  ) {
    let intercepted = false;
    const rootNavigation = state.rootWebViewNavigation;
    const isLocalRoot = rootNavigation?.isSameOriginRootNavigation(params);
    try {
      if ((params.frameId && state.appProfileMainFrameId === params.frameId) || isLocalRoot) {
        await refreshAppProfileNavigation(tabId, async () => {
          await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
            requestId,
            responseCode: 204,
            responseHeaders: [{ name: 'Cache-Control', value: 'no-store' }],
          });
          intercepted = true;
          state.appProfileDefinitionRefreshPending = true;
        });
      }
    } catch (error) {
      console.warn('[AppProfile] Navigation continues with the active definition:', error);
    }
    if (intercepted) {
      const tab = await chrome.tabs.get(tabId);
      const destination = request.url + (request.urlFragment ?? '');
      const clearSource = isLocalRoot && rootNavigation?.preserveNavigationSource(params);
      try {
        if (tab.url !== destination) await navigateTabInSession(tabId, destination);
        if (tab.url?.split('#', 1)[0] === request.url) await reloadTabInSession(tabId);
      } catch (error) {
        if (clearSource) clearSource();
        throw error;
      }
      return;
    }
  }

  const requestTarget = { tabId, ...(sessionId && { sessionId }) };
  if (state?.rootWebViewNavigation) {
    try {
      const client = {
        sendCommand: (method: string, payload?: Record<string, unknown>) =>
          chrome.debugger.sendCommand(requestTarget, method, payload),
      };
      const overriddenResponse =
        responseStatusCode != null && state.requestStates.get(requestKey)?.selectedOverride;
      if (!overriddenResponse && (await state.rootWebViewNavigation.handle(params, client))) {
        state.requestStates.delete(requestKey);
        return;
      }
    } catch (error) {
      console.warn('[DeviceShell] Failed to prepare root navigation:', error);
    }
  }
  // Fetch continuations explicitly carry the same UA as the document-start profile.
  const userAgent = sessionId ? undefined : state?.appProfileUserAgent;
  const resumeHeaders =
    responseStatusCode == null &&
    !params.responseErrorReason &&
    (userAgent || request.headers !== originalHeaders)
      ? [
          ...Object.entries(request.headers ?? {})
            .filter(([name]) => !userAgent || name.toLowerCase() !== 'user-agent')
            .map(([name, value]) => ({ name, value: String(value) })),
          ...(userAgent ? [{ name: 'User-Agent', value: userAgent }] : []),
        ]
      : undefined;
  const resume = () =>
    continueRequest(
      requestTarget,
      requestId,
      resumeHeaders,
      Boolean(sessionId && (responseStatusCode != null || params.responseErrorReason)),
    );
  if (
    !state ||
    params.responseErrorReason ||
    (sessionId &&
      (!state.modificationActive || !listBusinessWebViewSessions(tabId).includes(sessionId)))
  ) {
    state?.requestStates.delete(requestKey);
    await resume();
    return;
  }
  const fulfill = async (response: WebViewDocumentResponse & { requestId: string }) => {
    if (!sessionId && (await state.rootWebViewNavigation?.fulfillResponse(params, response)))
      return;
    await chrome.debugger.sendCommand(requestTarget, 'Fetch.fulfillRequest', response);
  };

  // 提取 API 名称，传入 postData 以支持代理请求
  let apiName: string | null;
  try {
    apiName = await extractApiName(request.url, request.postData);
  } catch (error) {
    console.warn('[Mearl] Request inspection failed; resuming paused request:', error);
    await resume();
    return;
  }
  // 对于非 mtop 请求（extractApiName 返回 null），回退到 URL pathname 查找覆盖配置（Requests 模式 mock）
  const overrideLookupKey =
    apiName ??
    (() => {
      try {
        return new URL(request.url).pathname;
      } catch {
        return null;
      }
    })();
  if (!overrideLookupKey) {
    await resume();
    return;
  }
  if (!responseStatusCode && request.method === 'OPTIONS') {
    await resume();
    return;
  }

  // 检查是否有该 API 的响应覆盖（数组中找第一个条件匹配的）
  let overrideList = state.responseOverrides.get(overrideLookupKey.toLowerCase());
  if (!overrideList && apiName === null) {
    for (const list of state.responseOverrides.values()) {
      const found = list.find(o => o.url === request.url);
      if (found) {
        overrideList = [found];
        break;
      }
    }
  }
  const override = !responseStatusCode
    ? overrideList
      ? selectResponseOverride(overrideList, request, state.responseOverrideCallCounts)
      : undefined
    : state.requestStates.get(requestKey)?.selectedOverride;

  // 请求阶段（还没有响应）
  if (!responseStatusCode) {
    // 记录请求开始时间，用于计算总耗时
    state.requestStates.set(requestKey, { startTime: Date.now(), selectedOverride: override });
    // 如果配置了 duration，在请求阶段 fulfill（精确控制总耗时，绕过真实服务器）
    // 缺少原始响应头时（如 agent set_mock）合成最小 content-type，保证仍能生效
    if (override && override.duration !== undefined) {
      if (override.duration > 0) {
        await new Promise(resolve => setTimeout(resolve, override.duration));
      }
      try {
        const rawBody = override.responseData;
        const { body: modifiedBody, isJsonp } = serializeMockResponse(request.url, rawBody);
        const base64Body = btoa(unescape(encodeURIComponent(modifiedBody)));
        const responseHeaders = override.responseHeaders ?? [
          {
            name: 'content-type',
            value: isJsonp
              ? 'application/javascript; charset=utf-8'
              : 'application/json; charset=utf-8',
          },
        ];
        await fulfill({
          requestId,
          responseCode: 200,
          responseHeaders: ensureCorsHeaders(
            prepareMockResponseHeaders(responseHeaders, isJsonp),
            request,
          ),
          body: base64Body,
        });
      } catch {
        await resume();
      }
      state.requestStates.delete(requestKey);
      return;
    }
    // 无 duration 配置，放行到服务器，响应阶段再处理 mock
    // SSE 请求的 mock 现在在 injected.ts 中处理，这里直接继续
    await resume();
    return;
  }

  // 普通请求的响应阶段拦截
  if (!override) {
    // 实时翻译：如果开启，获取响应体并翻译后再返回给页面
    const requestStartTime = state.requestStates.get(requestKey)?.startTime;
    state.requestStates.delete(requestKey);
    if (globalTranslation !== 'none') {
      try {
        const bodyResult = (await chrome.debugger.sendCommand(
          requestTarget,
          'Fetch.getResponseBody',
          {
            requestId,
          },
        )) as { body: string; base64Encoded: boolean };

        const bodyText = bodyResult.base64Encoded
          ? decodeURIComponent(escape(atob(bodyResult.body)))
          : bodyResult.body;

        let data: any;
        try {
          data = JSON.parse(bodyText);
        } catch {
          // 非 JSON，跳过翻译
          await resume();
          return;
        }

        const targetLang = globalTranslation as 'en' | 'zh-TW'; // 此处已被 globalTranslation !== 'none' 保护
        const result = await translateJson(data, targetLang);

        if (result.success && result.translatedData) {
          const modifiedBody = JSON.stringify(result.translatedData);
          const base64Body = btoa(unescape(encodeURIComponent(modifiedBody)));

          await fulfill({
            requestId,
            responseCode: responseStatusCode,
            responseHeaders: stripEncodingHeaders(responseHeaders),
            body: base64Body,
          });

          // 通知 panel 该 API 响应已被自动翻译，带上总耗时（网络 + 翻译）
          const totalDuration =
            requestStartTime !== undefined ? Date.now() - requestStartTime : undefined;
          notifyPanelAutoTranslated(tabId, overrideLookupKey, totalDuration);
          return;
        }
      } catch {
        // 翻译失败，继续返回原始响应
      }
    }
    await resume();
    return;
  }

  state.requestStates.delete(requestKey);
  // 修改响应（duration 已在请求阶段处理，这里是无 duration 的 mock）
  try {
    const rawBody = override.responseData;
    const { body: modifiedBody, isJsonp } = serializeMockResponse(request.url, rawBody);
    const base64Body = btoa(unescape(encodeURIComponent(modifiedBody)));

    await fulfill({
      requestId,
      responseCode: responseStatusCode,
      responseHeaders: prepareMockResponseHeaders(responseHeaders, isJsonp),
      body: base64Body,
    });
  } catch {
    await resume();
  }
}

/**
 * 移除 Content-Encoding 和 Content-Length 头
 * Fetch.fulfillRequest 的 body 是明文 JSON，原始的 gzip/br 等编码头会导致浏览器解压失败，内容变为空
 */
function stripEncodingHeaders(
  headers: Array<{ name: string; value: string }> | undefined,
): Array<{ name: string; value: string }> {
  if (!headers) return [];
  const STRIP = new Set(['content-encoding', 'content-length']);
  return headers.filter(h => !STRIP.has(h.name.toLowerCase()));
}

/**
 * 请求阶段 fulfill（duration mock）绕过了真实服务器，不会有真实的 CORS 响应头，
 * 跨域请求会被浏览器直接拦截。这里回填 Access-Control-Allow-Origin（回显请求方 Origin）
 * 及 Access-Control-Allow-Credentials，使跨域 mock 响应能被页面正常读取。
 */
function ensureCorsHeaders(
  headers: Array<{ name: string; value: string }>,
  request: { headers?: Record<string, string> },
): Array<{ name: string; value: string }> {
  const originEntry = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'origin',
  );
  const origin = originEntry?.[1];
  if (!origin) return headers;

  const result = headers.filter(
    h =>
      !['access-control-allow-origin', 'access-control-allow-credentials'].includes(
        h.name.toLowerCase(),
      ),
  );
  result.push({ name: 'Access-Control-Allow-Origin', value: origin });
  result.push({ name: 'Access-Control-Allow-Credentials', value: 'true' });
  return result;
}

// 继续请求
async function continueRequest(
  target: chrome.debugger.Debuggee,
  requestId: string,
  headers?: Array<{ name: string; value: string }>,
  response = false,
) {
  try {
    await chrome.debugger.sendCommand(
      target,
      response ? 'Fetch.continueResponse' : 'Fetch.continueRequest',
      {
        requestId,
        ...(headers && { headers }),
      },
    );
  } catch (error: any) {
    // 忽略常见的无害错误
    if (
      error?.message?.includes('Invalid InterceptionId') ||
      error?.message?.includes('No resource with given identifier found')
    ) {
      // 请求可能已完成或取消，这是正常的
      return;
    }
    console.warn('Failed to continue request:', error);
  }
}

// 清理 tab 状态
export function cleanupTab(tabId: number) {
  tabStates.get(tabId)?.rootWebViewNavigation?.dispose();
  cleanupDebuggerSession(tabId);
  tabStates.delete(tabId);
  clearEmulationConfigForTab(tabId);
}

/**
 * 释放指定标签页的全部 debugger 控制并丢弃会话级临时状态。
 * 标签页本身保留；持久化 DNR 规则等非 debugger 能力不受影响。
 */
export async function releaseDebuggerControlForTab(tabId: number): Promise<boolean> {
  const state = tabStates.get(tabId);
  const released = await releaseDebuggerSession(tabId);
  const shouldNotifyDetached = state?.modificationActive === true;
  state?.rootWebViewNavigation?.dispose();

  tabStates.delete(tabId);
  clearEmulationConfigForTab(tabId);

  if (shouldNotifyDetached) {
    notifyDebuggerStatusChanged(tabId, false);
  }
  return released;
}

// 处理 debugger 分离（session 整体消亡，会话派生状态一并清空）
export function handleDebuggerDetach(tabId: number, reason?: string) {
  console.info('[debuggerManager] session detached', JSON.stringify({ tabId, reason }));
  handleDebuggerSessionDetach(tabId, reason);
  clearEmulationConfigForTab(tabId);
  const state = tabStates.get(tabId);
  if (!state) return;

  state.rootWebViewNavigation?.dispose();
  state.rootWebViewNavigation = undefined;
  const wasModificationActive = state.modificationActive;
  state.modificationActive = false;
  state.modificationLease = undefined;
  state.timezoneOverrides = {};
  state.hostEnvironment = undefined;
  state.safeAreaInsetsOverride = undefined;
  state.appProfileDocumentBootstrap = undefined;
  state.appProfileChildTargetEnvironment = undefined;
  state.childDeviceScripts = undefined;
  state.rootWebViewSessionId = undefined;

  // 只在 modification 此前确实在用时才通知（与 enableModificationForTab 的 notify 配对）
  if (wasModificationActive) {
    notifyDebuggerStatusChanged(tabId, false);
  }
}
