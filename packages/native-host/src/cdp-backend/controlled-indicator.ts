/**
 * CDP 模式的受控页面视觉标识。
 *
 * 与扩展模式共享同一套 Mearl favicon 变体，本地操作显示绿色圆点角标，云端操作
 * 显示紫色云朵角标。图标通过 data URL 内联到新文档脚本，不依赖扩展资源或网络。
 *
 * 注入通过 Page.addScriptToEvaluateOnNewDocument + runImmediately 完成：脚本在
 * PageSession 存续期内跨导航生效；控制来源变化时替换脚本并立即更新当前文档。
 */

import { createControlledFaviconDataUrl, type ControlSource } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { ensureCdpDomain } from './domain-manager.js';

interface InjectedIndicator {
  identifier: string | null;
  controlSource: ControlSource;
}

/** page session → 当前跨导航脚本及其控制来源 */
const injectedSessions = new WeakMap<PageSession, InjectedIndicator>();
/** 同一会话串行切换和释放，确保每个跨导航脚本的 identifier 都能被回收。 */
const indicatorQueues = new WeakMap<PageSession, Promise<void>>();

function enqueueIndicatorOperation(
  session: PageSession,
  operation: () => Promise<void>,
): Promise<void> {
  const queued = (indicatorQueues.get(session) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  indicatorQueues.set(session, queued);
  return queued.finally(() => {
    if (indicatorQueues.get(session) === queued) {
      indicatorQueues.delete(session);
    }
  });
}

function createFaviconScript(controlSource: ControlSource): string {
  const iconDataUrl = createControlledFaviconDataUrl(controlSource);
  return `(() => {
  if (window !== window.top) return;
  const ICON = ${JSON.stringify(iconDataUrl)};
  const existing = window.__mearlControlledFavicon__;
  if (existing && typeof existing === 'object') {
    existing.iconHref = ICON;
    document.querySelectorAll('link[data-mearl-favicon]').forEach(link => {
      link.href = ICON;
    });
    if (typeof existing.apply === 'function') {
      existing.apply();
      return;
    }
    if (existing.observer) existing.observer.disconnect();
  }
  const state = {
    originalIcons: [],
    capturedIcons: false,
    iconHref: ICON,
    apply: null,
    observer: null,
    onReady: null,
  };
  window.__mearlControlledFavicon__ = state;
  const apply = () => {
    const head = document.head;
    if (!head) return;
    const pageIcons = Array.from(
      document.querySelectorAll('link[rel~="icon"]:not([data-mearl-favicon])')
    );
    if (!state.capturedIcons && pageIcons.length > 0) {
      state.originalIcons = pageIcons.map(link => link.cloneNode(true));
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
})();`;
}

const RESTORE_FAVICON_SCRIPT = `(() => {
  if (window !== window.top) return;
  const state = window.__mearlControlledFavicon__;
  if (state && typeof state === 'object' && state.observer) {
    state.observer.disconnect();
  }
  if (state && typeof state === 'object' && state.onReady) {
    document.removeEventListener('DOMContentLoaded', state.onReady);
  }
  document.querySelectorAll('link[data-mearl-favicon]').forEach(link => link.remove());
  if (state && typeof state === 'object' && document.head) {
    for (const icon of state.originalIcons || []) document.head.appendChild(icon);
  }
  delete window.__mearlControlledFavicon__;
})();`;

/**
 * 确保受控标识已注入到该 page session。相同来源幂等；来源变化时替换跨导航脚本，
 * runImmediately 同步更新当前文档。任何异常都不阻断 agent 动作本身。
 */
export async function ensureControlledIndicator(
  session: PageSession,
  controlSource: ControlSource = 'local',
): Promise<void> {
  return enqueueIndicatorOperation(session, async () => {
    const current = injectedSessions.get(session);
    if (current?.controlSource === controlSource) return;

    injectedSessions.set(session, { identifier: null, controlSource });
    try {
      await ensureCdpDomain(session.client, 'Page');
      if (current?.identifier) {
        await session.client
          .sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: current.identifier,
          })
          .catch(() => {});
      }
      const result = await session.client.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: createFaviconScript(controlSource),
        runImmediately: true,
      });
      injectedSessions.set(session, {
        identifier: result?.identifier ?? null,
        controlSource,
      });
    } catch {
      injectedSessions.delete(session);
    }
  });
}

/** browser_release 使用：停止跨导航注入并恢复当前文档的 favicon。 */
export async function releaseControlledIndicator(session: PageSession): Promise<void> {
  return enqueueIndicatorOperation(session, async () => {
    const current = injectedSessions.get(session);
    injectedSessions.delete(session);

    if (current?.identifier) {
      await session.client
        .sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: current.identifier,
        })
        .catch(() => {});
    }
    await session.client
      .sendCommand('Runtime.evaluate', { expression: RESTORE_FAVICON_SCRIPT })
      .catch(() => {});
  });
}
