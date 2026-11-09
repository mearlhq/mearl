/**
 * 受控标签页登记与视觉标识。
 *
 * Agent 操作过的标签页统一登记在这里（storage.session 持久化，Service Worker
 * 重启后不丢），并把页面 favicon 替换为插件 icon 作为“该页面正被 Agent 操控”
 * 的视觉标识。登记表同时是功能上的唯一事实来源：
 *   - tab_open 的 closeExisting 依据它找到所有 agent 标签页并关闭
 *   - 新开的 agent 标签页优先进入已有受控标签页所在的窗口，保持聚拢
 *
 * favicon 替换通过 chrome.scripting.executeScript 注入，不需要附加 debugger；
 * 插件本就只能控制 host 白名单内的页面，注入范围与可控范围一致。注入只作用
 * 于当前文档，导航后不主动补打：agent 的每个动作都会经 markTabControlled 重新
 * 注入，只要 agent 还在操作这个页面，标识就会自然恢复；页内幂等由注入脚本
 * 自身的 guard 保证。登记和释放不等待图标脚本，因为冻结的文档可能一直不响应。
 */

import { createControlledFaviconDataUrl, type ControlSource } from '@mearl/browser-core';

// ─── 登记表（tabId → 登记时间戳） ────────────────────────────────────────────

const REGISTRY_STORAGE_KEY = 'agentControlledTabs';

/** storage.session 不可用时（如测试环境）的内存兜底 */
let fallbackRegistry: Record<string, number> = {};
let registryQueue: Promise<void> = Promise.resolve();

async function readRegistry(): Promise<Record<string, number>> {
  if (!chrome.storage?.session) return { ...fallbackRegistry };
  const stored = await chrome.storage.session.get(REGISTRY_STORAGE_KEY);
  return stored[REGISTRY_STORAGE_KEY] ?? {};
}

async function writeRegistry(registry: Record<string, number>): Promise<void> {
  fallbackRegistry = { ...registry };
  if (chrome.storage?.session) {
    await chrome.storage.session.set({ [REGISTRY_STORAGE_KEY]: registry });
  }
}

/** 串行化读改写，防止并发登记互相覆盖 */
function mutateRegistry(mutator: (registry: Record<string, number>) => boolean): Promise<void> {
  registryQueue = registryQueue
    .catch(() => {})
    .then(async () => {
      const registry = await readRegistry();
      if (mutator(registry)) {
        await writeRegistry(registry);
      }
    });
  return registryQueue;
}

/** 返回所有已登记的受控 tabId，按登记时间从新到旧排列 */
export async function listControlledTabIds(): Promise<number[]> {
  const registry = await readRegistry();
  return Object.entries(registry)
    .sort((a, b) => b[1] - a[1])
    .map(([tabId]) => Number(tabId));
}

function unregisterControlledTab(tabId: number): Promise<void> {
  return mutateRegistry(registry => {
    if (!(String(tabId) in registry)) return false;
    delete registry[String(tabId)];
    return true;
  });
}

/**
 * 选择受控标签页所在的 normal 窗口，供 tab_open 决定新标签页开在哪。
 * 优先最近登记且仍然存活的标签页；没有可用窗口时返回 undefined。
 */
export async function getControlledWindowId(): Promise<number | undefined> {
  for (const tabId of await listControlledTabIds()) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      if (win.type === 'normal') return tab.windowId;
    } catch {
      // 标签页或窗口已关闭 — 跳过过期条目
    }
  }
  return undefined;
}

// ─── favicon 指示器 ──────────────────────────────────────────────────────────

function injectFavicon<Args extends unknown[]>(
  injection: chrome.scripting.ScriptInjection<Args, void>,
): void {
  try {
    void chrome.scripting.executeScript(injection).catch(() => {});
  } catch {
    // The extension context can disappear before the browser accepts the injection.
  }
}

/**
 * 在页面里替换 favicon（在目标页的 isolated world 执行）。只处理顶层 frame；
 * 移除页面自带的 icon link 并插入指向插件 icon 的 link，用 MutationObserver
 * 对抗 SPA 运行时改回 favicon。data-mearl-favicon 属性用于区分自己插入的
 * 节点，保证 apply 幂等；guard 标记随文档销毁，新文档重新注入即重新生效。
 */
function overrideFavicon(iconHref: string): void {
  if (window !== window.top) return;
  const marked = window as Window & {
    __mearlControlledFavicon__?: {
      observer?: MutationObserver;
      originalIcons: HTMLLinkElement[];
      capturedIcons: boolean;
      iconHref: string;
      apply?: () => void;
      onReady?: () => void;
    };
  };
  const existing = marked.__mearlControlledFavicon__;
  if (existing?.apply) {
    existing.iconHref = iconHref;
    document
      .querySelectorAll<HTMLLinkElement>('link[data-mearl-favicon]')
      .forEach(link => (link.href = iconHref));
    existing.apply();
    return;
  }
  existing?.observer?.disconnect();
  const state = {
    originalIcons: [] as HTMLLinkElement[],
    capturedIcons: false,
    iconHref,
    apply: undefined as (() => void) | undefined,
    observer: undefined as MutationObserver | undefined,
    onReady: undefined as (() => void) | undefined,
  };
  marked.__mearlControlledFavicon__ = state;
  const apply = () => {
    const head = document.head;
    if (!head) return;
    const pageIcons = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]:not([data-mearl-favicon])'),
    );
    if (!state.capturedIcons && pageIcons.length > 0) {
      state.originalIcons = pageIcons.map(link => link.cloneNode(true) as HTMLLinkElement);
      state.capturedIcons = true;
    }
    for (const link of pageIcons) {
      link.remove();
    }
    if (!head.querySelector('link[data-mearl-favicon]')) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = state.iconHref;
      link.setAttribute('data-mearl-favicon', '');
      head.appendChild(link);
    }
  };
  state.apply = apply;
  const start = () => {
    apply();
    state.observer = new MutationObserver(apply);
    state.observer.observe(document, { childList: true, subtree: true });
  };
  if (document.head) {
    start();
  } else {
    state.onReady = start;
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
}

/** 撤销当前文档的受控 favicon，并恢复接管前保存的 icon 节点。 */
function restoreFavicon(): void {
  if (window !== window.top) return;
  const marked = window as Window & {
    __mearlControlledFavicon__?:
      | boolean
      | {
          observer?: MutationObserver;
          originalIcons: HTMLLinkElement[];
          capturedIcons: boolean;
          iconHref: string;
          apply?: () => void;
          onReady?: () => void;
        };
  };
  const state = marked.__mearlControlledFavicon__;
  if (state && typeof state === 'object') {
    state.observer?.disconnect();
    if (state.onReady) {
      document.removeEventListener('DOMContentLoaded', state.onReady);
    }
  }
  document.querySelectorAll('link[data-mearl-favicon]').forEach(link => link.remove());
  if (state && typeof state === 'object' && document.head) {
    for (const icon of state.originalIcons) {
      document.head.appendChild(icon);
    }
  }
  delete marked.__mearlControlledFavicon__;
}

// ─── 对外入口 ────────────────────────────────────────────────────────────────

/**
 * 把标签页标记为受控：登记 + 向当前文档注入 favicon 标识。
 *
 * 幂等且 best-effort，供 agent 消息分发器对每个操作标签页的动作调用；导航后
 * 的新文档由下一次动作的调用重新覆盖。任何失败（标签页已关、无注入权限等）
 * 都不应阻断 agent 动作本身。
 */
export async function markTabControlled(
  tabId: number | null | undefined,
  controlSource: ControlSource = 'local',
): Promise<void> {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.id === undefined) return;
    await mutateRegistry(registry => {
      registry[String(tabId)] = Date.now();
      return true;
    });
    injectFavicon({
      target: { tabId },
      func: overrideFavicon,
      args: [createControlledFaviconDataUrl(controlSource)],
      injectImmediately: true,
    });
  } catch (error) {
    console.warn('[AgentBridge] Failed to mark tab as controlled:', error);
  }
}

/** browser_release 使用：撤销登记和当前文档的视觉标识，但保留标签页。 */
export async function releaseControlledTab(tabId: number): Promise<void> {
  await unregisterControlledTab(tabId);
  injectFavicon({
    target: { tabId },
    func: restoreFavicon,
    injectImmediately: true,
  });
}

/** 标签页关闭时的清理：撤销登记（页面内的注入随文档销毁，无需额外处理） */
export function cleanupControlledTab(tabId: number): void {
  void unregisterControlledTab(tabId);
}
