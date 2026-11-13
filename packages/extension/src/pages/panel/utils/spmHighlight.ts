/**
 * 在被检查页面中高亮匹配给定 SPM 的 DOM 元素。
 * DevTools 面板页不能直接使用 chrome.tabs，需经由 background service worker 中转。
 */
export function highlightSpmInPage(
  tabId: number,
  spm: string,
  onResult?: (found: number) => void,
): void {
  if (!spm) {
    onResult?.(0);
    return;
  }

  chrome.runtime.sendMessage({ action: 'highlightSpm', tabId, spm }, response => {
    if (chrome.runtime.lastError) {
      onResult?.(0);
      return;
    }
    onResult?.(typeof response?.found === 'number' ? response.found : 0);
  });
}

/** 清除页面上所有热区高亮 */
export function clearSpmHighlight(): void {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  chrome.runtime.sendMessage({ action: 'clearSpmHighlight', tabId });
}

/**
 * 使用 content-script 的 findSpmElements 查找元素，再通过 DevTools inspect() 定位到 Elements 面板。
 * content-script 找到元素后存到 window.__mtopSpmInspectTarget，panel 再 eval 调 inspect()。
 * 与 highlightSpmInPage 共享同一套查找逻辑，不再维护两份选择器代码。
 */
export function inspectSpmInElements(spm: string): void {
  if (!spm) return;
  const tabId = chrome.devtools.inspectedWindow.tabId;
  // 第一步：让 content-script 查找元素并存到 window.__mtopSpmInspectTarget
  chrome.runtime.sendMessage({ action: 'inspectSpm', tabId, spm }, () => {
    if (chrome.runtime.lastError) return;
    // 第二步：DOM 属性由 content-script 写入（共享 DOM），DevTools eval 运行在 main world 可直接读取
    chrome.devtools.inspectedWindow.eval(
      '(function(){var el=document.querySelector("[data-mtop-inspect]");if(el){el.removeAttribute("data-mtop-inspect");inspect(el);return true;}return false;})()',
      () => {
        void chrome.runtime.lastError;
      },
    );
  });
}

/** 切换页面上所有 SPM 节点的轮廓高亮 */
export function toggleSpmOverlay(tabId: number, enabled: boolean): void {
  chrome.runtime.sendMessage({ action: 'toggleSpmOverlay', tabId, enabled }, () => {
    void chrome.runtime.lastError; // suppress unchecked error warning
  });
}
