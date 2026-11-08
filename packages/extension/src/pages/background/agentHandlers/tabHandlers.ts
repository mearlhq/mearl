import { setBackgroundPageActivity } from '../backgroundPageActivity';
import { prepareTabForAgent } from './tabPreparation';
export { prepareTabForAgent, prepareTabForCapture } from './tabPreparation';
import { resolveAvailableAppProfile } from '../appProfileCatalog';
import { assertDeviceShellSupported, assertAppProfilePageRuntimeSupported } from '../../../shared/chromiumVersion';
/**
 * Agent handlers: tab_open, tab_close, tab_list, tab_group
 */

import {
  resolveEmulationConfig,
  resolvePageNavigateInput,
  selectMatchingTab,
  isControlledFaviconDataUrl,
  type ControlSource,
  type PageNavigateParams,
  type ResolvedEmulationConfig,
  type SafeAreaInsets,
  type TabCloseParams,
  type TabGroupParams,
  type TabOpenParams,
} from '@mearl/browser-core';
import {
  cleanupCollector,
  flushRequestCollection,
  getCaptureCheckpoint,
  startRequestCollection,
  stopRequestCollection,
} from '../backgroundRequestCollector';
import {
  enableAppProfileDocumentBootstrapForTab,
  enableEmulationForTab,
  enableSafeAreaInsetsForTab,
  emulationRuntimeStateMatches,
  navigateTabInSession,
  readEmulationRuntimeState,
  readSafeAreaRuntimeState,
  reapplyEmulationForTab,
  reapplySafeAreaInsetsForTab,
  reloadTabInSession,
  safeAreaRuntimeStateMatches,
  prepareDeviceShellWebViewEnvironmentForTab,
} from '../debuggerManager';
import { applyAppProfileForTab, clearAppProfileForTab } from '../utils/appProfileRules';
import {
  loadStoredAppProfileOptions,
  resolveStoredAppBridgeConfig,
} from '../../../shared/appBridgeConfig';
import { applyDeviceShellForTab, clearDeviceShellForTab } from '../deviceShellRules';
import { getPreferredDeviceChromeConfig } from '../quickAppProfilePreference';
import {
  cleanupControlledTab,
  getControlledWindowId,
  listControlledTabIds,
  markTabControlled,
} from './controlledTabs';
import { COLLECT_DNR_RULE_ID } from '../utils/dnr';
import { COLLECT_SERVER_TIMING_KEY } from '../../../shared/constants';
import { clearPageRefsForNavigation } from './pageRefs';
import { bindAgentChatTabFromSource, getAgentChatTabBindings } from '../agentChatTabBindings';
import { reloadContainerTopFrame } from '../utils/containerFrameTarget';
import {
  getAgentGroupWindowId,
  groupOpenedAgentTab,
  handoffAgentTabGroups,
} from './agentTabGroups';

// ─── DNR session rule for request collection flag ─────────────────────────────
//
// Injects a Server-Timing header scoped to specific tabIds via a DNR session
// rule, so early-inject.ts can detect "collect" mode at document_start and
// hook window.open to keep navigations within the same tab (preserving the
// CDP debugger session).

/** Set of tab IDs currently marked for collection via DNR */
const collectingTabIds = new Set<number>();

/**
 * Update the DNR session rule to inject the collection Server-Timing header
 * for all currently tracked tab IDs. Uses a single rule with tabIds condition.
 */
async function updateCollectDnrRule(): Promise<void> {
  if (collectingTabIds.size === 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [COLLECT_DNR_RULE_ID],
    });
    return;
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [COLLECT_DNR_RULE_ID],
    addRules: [
      {
        id: COLLECT_DNR_RULE_ID,
        priority: 100,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          responseHeaders: [
            {
              header: 'server-timing',
              operation: 'append' as chrome.declarativeNetRequest.HeaderOperation,
              value: `${COLLECT_SERVER_TIMING_KEY};desc="1"`,
            },
          ],
        },
        condition: {
          resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
          tabIds: [...collectingTabIds],
        },
      },
    ],
  });
}

/**
 * Mark a tab as collecting — adds it to the DNR session rule.
 */
export async function addCollectingTab(tabId: number): Promise<void> {
  collectingTabIds.add(tabId);
  await updateCollectDnrRule();
}

/**
 * Unmark a tab from collecting — removes it from the DNR session rule.
 */
export async function removeCollectingTab(tabId: number): Promise<void> {
  collectingTabIds.delete(tabId);
  try {
    await updateCollectDnrRule();
  } catch (error) {
    // 保留待清理标记，让后续 browser_release 能再次尝试同步 DNR 规则。
    collectingTabIds.add(tabId);
    throw error;
  }
}

export function listCollectingMarkerTabIds(): number[] {
  return Array.from(collectingTabIds);
}

// ─── Tab focus restore ────────────────────────────────────────────────────────

const TAB_RESTORE_STORAGE_KEY = 'agentTabRestoreTargets';

interface TabRestoreTarget {
  tabId: number;
  windowId: number;
}

interface TabActivationResult {
  requested: true;
  mode: 'background' | 'foreground';
  tabActive: boolean;
  windowFocused?: boolean;
  windowState?: string;
  visibilityState?: string;
}

const fallbackRestoreTargets = new Map<number, TabRestoreTarget>();
let restoreTargetQueue: Promise<void> = Promise.resolve();

async function readRestoreTargets(): Promise<Record<string, TabRestoreTarget>> {
  if (!chrome.storage?.session) return Object.fromEntries(fallbackRestoreTargets);
  const stored = await chrome.storage.session.get(TAB_RESTORE_STORAGE_KEY);
  return stored[TAB_RESTORE_STORAGE_KEY] ?? {};
}

async function writeRestoreTargets(targets: Record<string, TabRestoreTarget>): Promise<void> {
  fallbackRestoreTargets.clear();
  for (const [tabId, target] of Object.entries(targets)) {
    fallbackRestoreTargets.set(Number(tabId), target);
  }
  if (chrome.storage?.session) {
    await chrome.storage.session.set({ [TAB_RESTORE_STORAGE_KEY]: targets });
  }
}

async function recordRestoreTarget(tabId: number, target: TabRestoreTarget): Promise<void> {
  restoreTargetQueue = restoreTargetQueue
    .catch(() => {})
    .then(async () => {
      const targets = await readRestoreTargets();
      targets[String(tabId)] = target;
      await writeRestoreTargets(targets);
    });
  await restoreTargetQueue;
}

async function takeRestoreTarget(tabId: number): Promise<TabRestoreTarget | undefined> {
  let result: TabRestoreTarget | undefined;
  restoreTargetQueue = restoreTargetQueue
    .catch(() => {})
    .then(async () => {
      const targets = await readRestoreTargets();
      result = targets[String(tabId)];
      delete targets[String(tabId)];
      await writeRestoreTargets(targets);
    });
  await restoreTargetQueue;
  return result;
}

async function getActiveTabForRestore(): Promise<TabRestoreTarget | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id === undefined ? undefined : { tabId: tab.id, windowId: tab.windowId };
}

async function isAgentForegroundPrevented(): Promise<boolean> {
  const stored = await chrome.storage.sync.get('agentPreventForeground');
  return stored.agentPreventForeground !== false;
}

async function restoreActiveTab(target: TabRestoreTarget | undefined): Promise<void> {
  if (!target) return;
  try {
    await chrome.tabs.get(target.tabId);
    await chrome.tabs.update(target.tabId, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } catch {
    // The previous tab or window may have been closed while the temporary tab was in use.
  }
}

async function readTabVisibilityState(tabId: number): Promise<string | undefined> {
  if (!chrome.scripting?.executeScript) return undefined;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.visibilityState,
      injectImmediately: true,
    });
    return typeof result?.result === 'string' ? result.result : undefined;
  } catch {
    return undefined;
  }
}

async function activateTabForAgent(
  tabId: number,
  windowId: number,
  preventForeground: boolean,
  url: string,
  signal?: AbortSignal,
): Promise<TabActivationResult> {
  signal?.throwIfAborted();
  if (preventForeground) {
    const tab = await chrome.tabs.get(tabId);
    if (/^https?:\/\//.test(url)) await setBackgroundPageActivity(tabId, true, signal);
    const visibilityState = await readTabVisibilityState(tabId);
    return {
      requested: true,
      mode: 'background',
      tabActive: tab.active === true,
      ...(visibilityState ? { visibilityState } : {}),
    };
  }
  await setBackgroundPageActivity(tabId, false);
  const updatedTab = await chrome.tabs.update(tabId, { active: true });
  const currentWindowId = updatedTab?.windowId ?? windowId;
  let updatedWindow = await chrome.windows.update(currentWindowId, { focused: true });
  if (updatedWindow?.state === 'minimized') {
    updatedWindow = await chrome.windows.update(currentWindowId, {
      focused: true,
      state: 'normal',
    });
  }

  let visibilityState: string | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    visibilityState = await readTabVisibilityState(tabId);
    if (visibilityState === 'visible' || visibilityState === undefined) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return {
    requested: true,
    mode: 'foreground',
    tabActive: updatedTab?.active ?? true,
    ...(updatedWindow?.focused !== undefined ? { windowFocused: updatedWindow.focused } : {}),
    ...(updatedWindow?.state ? { windowState: updatedWindow.state } : {}),
    ...(visibilityState ? { visibilityState } : {}),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PAGE_LOAD_TIMEOUT_MS = 30000;
/**
 * 判定「本次调用到底有没有产生导航」的宽限。onBeforeNavigate 由浏览器进程在发起
 * 网络请求前派发，与页面加载快慢无关，所以这个窗口只需覆盖事件派发延迟。
 */
const NAVIGATION_START_GRACE_MS = 150;
/**
 * 设备模拟「下发 → 重载 → 校验」的尝试轮数。每轮都是一次真实重载，用户看得见（页面会在
 * 非模拟态与模拟态之间闪一下），所以只给一次兜底，而不是靠多轮重试撞成功率。
 */
const EMULATION_APPLY_ATTEMPTS = 2;

/** 本次等待是因何结束的，走宽限分支时用于排查 */
type TabLoadSettledBy =
  /** 新文档已提交并加载完成 */
  | 'commit'
  /** 纯同文档导航（SPA pushState / hash），本次调用没有触发跨文档导航 */
  | 'same-document'
  /** 本次调用没有产生导航，页面已处于 complete */
  | 'no-navigation';

/**
 * 等待导航真正完成。
 *
 * 所有调用点都是「刚发起导航/reload」之后，而 chrome.tabs.update / reload 返回时新导航尚未
 * 提交，tab.status 往往还是前一个文档的 'complete'。单看 status 会把「上一页已加载完」
 * 误当成本次导航已完成，让调用方拿到即将被丢弃的文档（设备模拟 override 就是这样丢的）。
 *
 * 判据取自 webNavigation 的确定信号而不是时间窗口：
 * - onCommitted：新文档已提交，再等一次 tabs.onUpdated complete
 * - onHistoryStateUpdated / onReferenceFragmentUpdated：同文档导航，文档本身未重载，直接完成；
 *   但仅在尚未观察到跨文档导航时才算——SPA 在重载过程中也会调 replaceState
 * - 上述信号与 loading 均未出现：本次调用没有产生导航（如 goBack 无历史可退），
 *   当前已 complete 则直接返回，避免白白等到超时
 */
interface WaitForTabLoadOptions {
  /** 导航命令已返回；在此之前不启动「未产生导航」宽限计时。 */
  navigationCommandSettled?: Promise<void>;
  signal?: AbortSignal;
}

export function waitForTabLoad(
  tabId: number,
  url: string,
  options: WaitForTabLoadOptions = {},
): Promise<TabLoadSettledBy> {
  return new Promise<TabLoadSettledBy>((resolve, reject) => {
    let settled = false;
    let navigationStarted = false;
    let crossDocumentNavigationStarted = false;
    let committed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const isTargetFrame = (details: { tabId: number; frameId: number }) =>
      details.tabId === tabId && details.frameId === 0;

    const onBeforeNavigate = (
      details: chrome.webNavigation.WebNavigationParentedCallbackDetails,
    ) => {
      if (isTargetFrame(details)) {
        navigationStarted = true;
        crossDocumentNavigationStarted = true;
      }
    };
    const onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (isTargetFrame(details)) {
        navigationStarted = true;
        crossDocumentNavigationStarted = true;
        committed = true;
      }
    };
    const onSameDocument = (
      details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ) => {
      if (!isTargetFrame(details)) return;
      // 跨文档导航正在进行时忽略同文档事件：SPA 在重载过程中会调 replaceState 做路由
      // 初始化，那只是本次导航的中间步骤，不是它的结束。误认为结束会让调用方在文档
      // 还在重建时就继续，后续 CDP 命令打在正在销毁的上下文上。
      if (crossDocumentNavigationStarted) return;
      finish('same-document');
    };
    const onTabUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (info.status === 'loading') {
        navigationStarted = true;
        return;
      }
      // 只有新文档已提交后的 complete 才算本次导航完成
      if (info.status === 'complete' && committed) finish('commit');
    };

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDocument);
      options.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };

    function finish(settledBy: TabLoadSettledBy): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(settledBy);
    }

    function onAbort(): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Navigation wait aborted: ${url}`));
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Page load timeout after ${PAGE_LOAD_TIMEOUT_MS}ms: ${url}`));
    }, PAGE_LOAD_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocument);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocument);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    void (options.navigationCommandSettled ?? Promise.resolve()).then(() => {
      if (settled) return;
      graceTimer = setTimeout(() => {
        if (settled || navigationStarted) return;
        void chrome.tabs
          .get(tabId)
          .then(currentTab => {
            if (settled || navigationStarted) return;
            if (currentTab.status === 'complete') {
              console.warn(
                `[waitForTabLoad] no navigation observed for tab ${tabId} within ${NAVIGATION_START_GRACE_MS}ms after the command settled; treating current document as settled: ${url}`,
              );
              finish('no-navigation');
            }
          })
          .catch(error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      }, NAVIGATION_START_GRACE_MS);
    });
  });
}

export const emulationStateMatches = emulationRuntimeStateMatches;

/**
 * 下发设备模拟并 reload，直到实测生效。
 *
 * UA 与视口判端都是页面加载时一次性读取的，所以必须 reload 一次。这条链依赖一个随时可能被
 * 外部断开的 CDP session（跨 site 导航、DevTools 挤占都会断），override 随 session 消失，
 * 所以每一轮都重新下发再重载，并实测校验。
 *
 * @returns 最终是否处于目标模拟态
 */
export async function applyEmulationWithReload(
  tabId: number,
  config: ResolvedEmulationConfig,
  expectedUrl: string,
  expectedUserAgent = config.userAgent,
): Promise<boolean> {
  // 这条链跳得多且依赖易失的 session，失败时必须能看出是哪一步、差在哪个字段
  const trace = (step: string, detail?: unknown) =>
    console.info(`[emulation] tab ${tabId} ${step}`, JSON.stringify(detail ?? {}));

  for (let attempt = 0; attempt < EMULATION_APPLY_ATTEMPTS; attempt += 1) {
    if (attempt === 0) {
      await enableEmulationForTab(tabId, config);
    } else {
      // 同一个 session 上重试必须先 clear 再重设——参数不变时重复下发
      // setDeviceMetricsOverride 是 no-op
      await reapplyEmulationForTab(tabId, config);
    }

    const settledBy = await navigateAndWait(tabId, expectedUrl, () => reloadTabInSession(tabId));
    const state = await readEmulationRuntimeState(tabId);
    if (emulationStateMatches(state, config, expectedUserAgent)) {
      trace('verified', { attempt: attempt + 1, settledBy });
      return true;
    }
    trace('not in effect', {
      attempt: attempt + 1,
      settledBy,
      expected: { screenWidth: config.width, dpr: config.deviceScaleFactor, touch: config.touch },
      actual: state && {
        screenWidth: state.screenWidth,
        dpr: state.deviceScaleFactor,
        maxTouchPoints: state.maxTouchPoints,
      },
      uaMatched: state?.userAgent === expectedUserAgent,
    });
  }
  return false;
}

/**
 * 只下发安全区并重载，供插件快捷 App 模拟保留现有 DevTools 设备尺寸。
 * 页面通常在首屏初始化时读取 CSS env，因此每轮重设后都必须重新加载并实测。
 */
export async function applySafeAreaInsetsWithReload(
  tabId: number,
  insets: SafeAreaInsets,
  expectedUrl: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < EMULATION_APPLY_ATTEMPTS; attempt += 1) {
    if (attempt === 0) {
      await enableSafeAreaInsetsForTab(tabId, insets);
    } else {
      await reapplySafeAreaInsetsForTab(tabId, insets);
    }

    await navigateAndWait(tabId, expectedUrl, () => reloadTabInSession(tabId));
    const state = await readSafeAreaRuntimeState(tabId);
    if (safeAreaRuntimeStateMatches(state, insets)) return true;
  }
  return false;
}

/**
 * 发起导航并等它真正完成。
 *
 * 必须由本函数发起导航，而不是调用方先导航再等：chrome.tabs.update / reload 返回时
 * 导航可能已经提交，此后再挂 webNavigation 监听就错过了 onCommitted，一直等不到而
 * 退到「本次无导航」分支，等于没等。监听必须先挂、后导航。
 */
export async function navigateAndWait(
  tabId: number,
  expectedUrl: string,
  navigate: () => Promise<unknown>,
): Promise<TabLoadSettledBy> {
  let markNavigationCommandSettled!: () => void;
  const navigationCommandSettled = new Promise<void>(resolve => {
    markNavigationCommandSettled = resolve;
  });
  const controller = new AbortController();
  const settled = waitForTabLoad(tabId, expectedUrl, {
    navigationCommandSettled,
    signal: controller.signal,
  });
  try {
    await navigate();
    markNavigationCommandSettled();
  } catch (error) {
    markNavigationCommandSettled();
    controller.abort();
    void settled.catch(() => {});
    throw error;
  }
  return settled;
}

// ─── tab_open ─────────────────────────────────────────────────────────────────

/**
 * Close all registered agent-controlled tabs and stop their request
 * collection.
 */
async function closeControlledTabs(scope?: number[]): Promise<void> {
  try {
    const tabIds = scope ?? (await listControlledTabIds());

    // Closing the tab invalidates any stalled debugger command before collection releases its lease.
    await Promise.all(
      tabIds.map(async id => {
        await chrome.tabs.remove(id).catch(() => {});
        cleanupControlledTab(id);
        await Promise.all([
          stopRequestCollection(id).catch(() => {}),
          removeCollectingTab(id).catch(() => {}),
          clearAppProfileForTab(id).catch(() => {}),
        ]);
      }),
    );
  } catch (error) {
    console.warn('[AgentBridge] Failed to close controlled tabs:', error);
  }
}

async function rollbackOpenedTab(tabId: number): Promise<void> {
  await setBackgroundPageActivity(tabId, false).catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
  cleanupControlledTab(tabId);
  cleanupCollector(tabId);
  await Promise.allSettled([
    stopRequestCollection(tabId),
    removeCollectingTab(tabId),
    clearAppProfileForTab(tabId),
    clearDeviceShellForTab(tabId),
  ]);
}

interface TabOpenEmulationResult {
  preset?: string;
  viewport: { width: number; height: number; deviceScaleFactor: number; scale: number };
  userAgent: string;
  mobile: boolean;
  touch: boolean;
  orientation: 'portrait' | 'landscape';
  deviceShell: boolean;
  splitScreen: boolean;
  /**
   * 首屏载入后实测的模拟态（视口 + UA 同时命中）。false 说明 Chrome 在导航链上
   * 丢弃了 override 且重下 + reload 仍未恢复，调用方需要知道页面可能仍是桌面态。
   */
  verified?: boolean;
}

export async function handleTabOpen(
  data: TabOpenParams,
  controlSource: ControlSource = 'local',
  signal?: AbortSignal,
): Promise<{
  tabId: number;
  url: string;
  title: string;
  opened: boolean;
  reused: boolean;
  capture: ReturnType<typeof getCaptureCheckpoint>;
  activation?: TabActivationResult;
  emulation?: TabOpenEmulationResult;
  appProfile?: {
    profile: string;
    label: string;
    userAgent: string;
    os: 'ios' | 'android';
  };
}> {
  const {
    url,
    openerTabId,
    closeExisting = false,
    emulation,
    reuse = 'never',
    match,
    restoreFocusOnClose = false,
    group,
    appProfile,
  } = data;

  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('Invalid url: url must be a non-empty string');
  }
  if (!['never', 'prefer', 'require'].includes(reuse)) {
    throw new Error('Invalid reuse: expected "never", "prefer", or "require"');
  }
  if (openerTabId !== undefined && (!Number.isInteger(openerTabId) || openerTabId < 0)) {
    throw new Error('Invalid openerTabId: expected a non-negative integer');
  }
  if (closeExisting && reuse !== 'never') {
    throw new Error('tab_open closeExisting cannot be combined with tab reuse.');
  }
  if (closeExisting && openerTabId !== undefined) {
    throw new Error('tab_open closeExisting cannot be combined with openerTabId.');
  }
  if (group !== undefined && (typeof group !== 'string' || group.trim() === '')) {
    throw new Error('Invalid group: group must be a non-empty string');
  }
  if (data.os !== undefined && data.os !== 'ios' && data.os !== 'android') {
    throw new Error('Invalid os: expected "ios" or "android"');
  }
  if (data.os !== undefined && !appProfile) {
    throw new Error('tab_open os requires appProfile.');
  }
  if (data.bridgeConfig !== undefined && !appProfile) {
    throw new Error('tab_open bridgeConfig requires appProfile.');
  }

  const active = data.active === true;
  const preventForeground = active && (await isAgentForegroundPrevented());

  if (reuse !== 'never') {
    const bindingSnapshot = openerTabId === undefined ? null : await getAgentChatTabBindings();
    const openerBinding =
      openerTabId === undefined ? undefined : bindingSnapshot?.bindings[String(openerTabId)];
    const candidates = (await chrome.tabs.query({})).filter(tab => {
      const candidateBinding =
        tab.id === undefined ? undefined : bindingSnapshot?.bindings[String(tab.id)];
      return (
        !((data as any).__mearlBlockedTabIds ?? []).includes(tab.id) &&
        (!openerBinding ||
          !candidateBinding ||
          candidateBinding.ownerTabId === openerBinding.ownerTabId)
      );
    });
    const existing = selectMatchingTab(candidates, url, match);
    if (existing?.id !== undefined) {
      if (emulation || appProfile) {
        throw new Error(
          'tab_open cannot apply pre-navigation emulation or appProfile to a reused tab.',
        );
      }
      if (group) {
        await groupOpenedAgentTab(existing.id, group);
      } else if (active && !preventForeground) {
        await handoffAgentTabGroups([existing.id]);
      }
      if (openerTabId !== undefined) {
        await bindAgentChatTabFromSource(openerTabId, existing.id);
      }
      await prepareTabForAgent(existing.id, controlSource);
      await flushRequestCollection(existing.id);
      const capture = getCaptureCheckpoint(existing.id);
      const activation = active
        ? await activateTabForAgent(
            existing.id,
            existing.windowId,
            preventForeground,
            existing.url ?? url,
            signal,
          )
        : undefined;
      return {
        tabId: existing.id,
        url: existing.url || url,
        title: existing.title || '',
        opened: false,
        reused: true,
        capture,
        ...(activation ? { activation } : {}),
      };
    }
    if (reuse === 'require') {
      throw new Error('tab_open did not find a matching existing tab and reuse is "require".');
    }
  }

  // 先解析容器档案与 emulation 配置（档案名/preset/尺寸/UA 校验）——放在建 tab 之前，
  // 参数写错时快速失败，不至于留下一个空白 tab。
  const bridgeConfig = appProfile
    ? await resolveStoredAppBridgeConfig(appProfile, data.bridgeConfig)
    : undefined;
  const language = appProfile
    ? (await loadStoredAppProfileOptions(appProfile)).language
    : undefined;
  const resolvedProfile = appProfile
    ? await resolveAvailableAppProfile(appProfile, {
        os: data.os,
        language,
        devicePreset: emulation?.preset,
        orientation: emulation?.orientation,
        bridgeConfig,
      })
    : undefined;
  const emulationConfig = emulation
    ? resolveEmulationConfig({ ...emulation, enabled: true })
    : undefined;
  const splitScreen =
    emulation?.deviceShell === true &&
    emulation?.splitScreen === true &&
    emulationConfig?.orientation === 'landscape' &&
    Boolean(resolvedProfile);

  if (emulation?.deviceShell === true) assertDeviceShellSupported();
  if (resolvedProfile?.injected.pageRuntime) assertAppProfilePageRuntimeSupported();

  let targetWindowId: number | undefined;
  let openerTab: chrome.tabs.Tab | undefined;

  // Optionally close all existing agent-controlled tabs before opening a new one
  if (closeExisting) {
    await closeControlledTabs((data as any).__mearlSessionTabIds);
    const currentWindow = await chrome.windows.getCurrent();
    targetWindowId = currentWindow.id;
  } else if (openerTabId !== undefined) {
    openerTab = await chrome.tabs.get(openerTabId);
    targetWindowId = openerTab.windowId;
  } else {
    // Open into the window that already holds controlled tabs, keeping agent
    // tabs clustered in one window.
    targetWindowId = await getControlledWindowId();
  }
  if (group === undefined) {
    targetWindowId = (await getAgentGroupWindowId(openerTab?.incognito)) ?? targetWindowId;
  }

  const restoreTarget =
    active && !preventForeground && restoreFocusOnClose
      ? await getActiveTabForRestore()
      : undefined;

  const tab = await chrome.tabs.create({
    url: 'about:blank',
    active: active && !preventForeground,
    windowId: targetWindowId,
    ...(openerTab && openerTab.windowId === targetWindowId ? { openerTabId: openerTab.id } : {}),
  });
  const tabId = tab.id!;
  let activation: TabActivationResult | undefined;

  try {
    if (openerTabId !== undefined) {
      await bindAgentChatTabFromSource(openerTabId, tabId);
    }

    if (restoreTarget && restoreTarget.tabId !== tabId) {
      await recordRestoreTarget(tabId, restoreTarget);
    }

    // Register as controlled right away so closeExisting can reach this tab even
    // if the navigation below fails; the favicon injection on about:blank is a
    // silent no-op and the real document gets injected after load.
    await markTabControlled(tabId, controlSource);

    await groupOpenedAgentTab(tabId, group, active && !preventForeground);

    // 先 attach debugger 并启用 Network，首个请求即可采集。
    await startRequestCollection(tabId);
    await addCollectingTab(tabId);

    // 配置和 override 都在首次业务导航前就位，页面不会经历桌面态首屏。
    if (resolvedProfile) {
      resolvedProfile.injected.rootContainer = {
        ...resolvedProfile.injected.rootContainer,
        enabled: false,
      };
      resolvedProfile.injected.simulateSystemBars = false;
      resolvedProfile.injected.externalDeviceChrome = false;
      await applyAppProfileForTab(tabId, resolvedProfile.injected);
      await enableAppProfileDocumentBootstrapForTab(tabId, resolvedProfile.injected);
    }
    if (emulationConfig) {
      if (emulation?.deviceShell === true) {
        const shell = await getPreferredDeviceChromeConfig(emulationConfig, splitScreen, emulation.scale);
        const options = splitScreen ? { splitScreen: true } : undefined;
        await applyDeviceShellForTab(tabId, shell, emulationConfig, options);
        await enableEmulationForTab(tabId, emulationConfig);
        await prepareDeviceShellWebViewEnvironmentForTab(tabId, emulationConfig, resolvedProfile?.injected, options);
      } else {
        await enableEmulationForTab(tabId, emulationConfig);
      }
    }

    activation = active
      ? await activateTabForAgent(tabId, tab.windowId, preventForeground, url, signal)
      : undefined;
    await navigateAndWait(tabId, url, () => navigateTabInSession(tabId, url));

    if (emulationConfig) {
      const runtimeState = await readEmulationRuntimeState(tabId);
      const expectedRuntimeUa = resolvedProfile?.ua ?? emulationConfig.userAgent;
      if (!emulationStateMatches(runtimeState, emulationConfig, expectedRuntimeUa)) {
        throw new Error('tab_open could not establish the requested emulation state');
      }
    }

    await flushRequestCollection(tabId, { allowDecodeFailure: true });
    const capture = getCaptureCheckpoint(tabId);
    await markTabControlled(tabId, controlSource);

    const loadedTab = await chrome.tabs.get(tabId);
    if (activation) {
      const visibilityState = await readTabVisibilityState(tabId);
      if (visibilityState) activation.visibilityState = visibilityState;
      else delete activation.visibilityState;
    }
    return {
      tabId,
      url: loadedTab.url || url,
      title: loadedTab.title || '',
      opened: true,
      reused: false,
      capture,
      ...(activation ? { activation } : {}),
      ...(emulationConfig && {
        emulation: {
          preset: emulationConfig.presetName,
          viewport: {
            width: emulationConfig.width,
            height: emulationConfig.height,
            deviceScaleFactor: emulationConfig.deviceScaleFactor,
            scale: emulationConfig.scale ?? 1,
          },
          userAgent: emulationConfig.userAgent,
          mobile: emulationConfig.mobile,
          touch: emulationConfig.touch,
          orientation: emulationConfig.orientation,
          deviceShell: emulation?.deviceShell === true,
          splitScreen,
          verified: true,
        },
      }),
      ...(resolvedProfile && {
        appProfile: {
          profile: resolvedProfile.profile,
          label: resolvedProfile.label,
          userAgent: resolvedProfile.ua,
          os: resolvedProfile.injected.platform === 'Android' ? 'android' : 'ios',
        },
      }),
    };
  } catch (error) {
    await rollbackOpenedTab(tabId);
    throw new Error(
      `tab_open could not establish browser control: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

// ─── tab_close ────────────────────────────────────────────────────────────────

export async function handleTabClose(data: TabCloseParams): Promise<{
  success: boolean;
  restoredTabId?: number;
}> {
  if (!data.tabId || typeof data.tabId !== 'number') {
    throw new Error('Invalid tabId: tabId must be a number');
  }
  const restoreTarget = await takeRestoreTarget(data.tabId);
  // Close first so Chrome invalidates stalled Input/Network commands on the debugger target.
  await chrome.tabs.remove(data.tabId);
  cleanupControlledTab(data.tabId);
  const cleanupResults = await Promise.allSettled([
    stopRequestCollection(data.tabId),
    removeCollectingTab(data.tabId),
    clearAppProfileForTab(data.tabId),
    clearDeviceShellForTab(data.tabId),
  ]);
  for (const result of cleanupResults) {
    if (result.status === 'rejected') {
      console.warn(`[AgentBridge] Failed to clean up closed tab ${data.tabId}:`, result.reason);
    }
  }
  const allowedRestoreTarget =
    restoreTarget && !(await isAgentForegroundPrevented()) ? restoreTarget : undefined;
  await restoreActiveTab(allowedRestoreTarget);
  return { success: true, restoredTabId: allowedRestoreTarget?.tabId };
}

// ─── tab_list ─────────────────────────────────────────────────────────────────

interface TabListEntry {
  id: number;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  controlled?: boolean;
  groupId?: number;
  groupTitle?: string;
  groupColor?: chrome.tabGroups.ColorEnum;
}

export async function handleTabList(): Promise<{ tabs: TabListEntry[] }> {
  const tabs = await chrome.tabs.query({});

  const controlledTabIds = new Set(await listControlledTabIds());

  // Group IDs are unique across the browser session, including across windows.
  const groupMap = new Map<number, chrome.tabGroups.TabGroup>();
  try {
    const groups = await chrome.tabGroups.query({});
    for (const group of groups) {
      groupMap.set(group.id, group);
    }
  } catch {
    // Tab enumeration remains usable when group metadata is unavailable.
  }

  return {
    tabs: tabs.map(tab => {
      const entry: TabListEntry = {
        id: tab.id!,
        tabId: tab.id!,
        windowId: tab.windowId,
        url: tab.url || '',
        title: tab.title || '',
        active: tab.active || false,
        pinned: tab.pinned || false,
      };
      if (controlledTabIds.has(tab.id!) || isControlledFaviconDataUrl(tab.favIconUrl)) {
        entry.controlled = true;
      }
      if (tab.groupId !== undefined && tab.groupId !== -1) {
        entry.groupId = tab.groupId;
        const group = groupMap.get(tab.groupId);
        entry.groupTitle = group?.title || '';
        if (group?.color) entry.groupColor = group.color;
      }
      return entry;
    }),
  };
}

export async function handleTabGroup(
  data: TabGroupParams,
): Promise<
  { groupId: number; tabIds: number[]; title: string } | { tabIds: number[]; ungrouped: true }
> {
  const tabIds = data?.tabIds;
  if (data?.ungroup === true) {
    validateTabIds(tabIds, 1000);
    await chrome.tabs.ungroup(tabIds);
    return { tabIds, ungrouped: true };
  }
  validateTabIds(tabIds, 100);
  const title = data?.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 80) {
    throw new Error('Invalid title: expected 1-80 characters');
  }

  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id)));
  const windowId = tabs[0].windowId;
  if (tabs.some(tab => tab.windowId !== windowId)) {
    throw new Error('tab_group requires tabs from the same window');
  }
  const groupTitle = title.trim();
  const existing = (await chrome.tabGroups.query({ title: groupTitle, windowId })).find(
    group => group.title === groupTitle,
  );
  const groupId = existing
    ? await chrome.tabs.group({ tabIds, groupId: existing.id })
    : await chrome.tabs.group({ tabIds });
  if (!existing) {
    await chrome.tabGroups.update(groupId, { title: groupTitle });
  }
  return { groupId, tabIds, title: groupTitle };
}

function validateTabIds(tabIds: unknown, maximum: number): asserts tabIds is number[] {
  if (
    !Array.isArray(tabIds) ||
    tabIds.length === 0 ||
    tabIds.length > maximum ||
    tabIds.some(id => !Number.isSafeInteger(id) || id < 0) ||
    new Set(tabIds).size !== tabIds.length
  ) {
    throw new Error(`Invalid tabIds: expected 1-${maximum} distinct numeric tab IDs`);
  }
}

// ─── page_navigate ────────────────────────────────────────────────────────────

export async function handlePageNavigate(
  data: PageNavigateParams,
  getActiveTabId: () => number | null,
): Promise<{
  tabId: number;
  url: string;
  title: string;
  refreshed?: boolean;
  history?: 'back' | 'forward';
}> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }
  const input = resolvePageNavigateInput(data);

  if (input.mode === 'refresh') {
    const current = await chrome.tabs.get(tabId);
    clearPageRefsForNavigation(tabId);
    const reloadedFrame = await reloadContainerTopFrame(tabId);
    if (!reloadedFrame) {
      await navigateAndWait(tabId, current.url || '', () => reloadTabInSession(tabId));
    }
    const reloadedTab = await chrome.tabs.get(tabId);
    return {
      tabId,
      url: reloadedTab.url || current.url || '',
      title: reloadedTab.title || '',
      refreshed: true,
    };
  }

  if (input.mode === 'history') {
    const current = await chrome.tabs.get(tabId);
    clearPageRefsForNavigation(tabId);
    await navigateAndWait(tabId, current.url || '', () =>
      input.history === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId),
    );
    const loadedTab = await chrome.tabs.get(tabId);
    return {
      tabId,
      url: loadedTab.url || '',
      title: loadedTab.title || '',
      history: input.history,
    };
  }

  clearPageRefsForNavigation(tabId);
  await navigateAndWait(tabId, input.url, () => chrome.tabs.update(tabId, { url: input.url }));

  const loadedTab = await chrome.tabs.get(tabId);
  return { tabId, url: loadedTab.url || input.url, title: loadedTab.title || '' };
}
