/**
 * 全局字体大小管理模块
 *
 * 提供按级别 / 按比例调整字号的能力，并自动：
 * 1. 从 chrome.storage.local 恢复上次设置
 * 2. 监听 Ctrl/Cmd + / - / 0 快捷键
 * 3. 将变更持久化到 chrome.storage.local
 *
 * 使用方式：在页面入口 `import '@/shared/fontSize';` 即可自动初始化。
 */

const FONT_SIZE_LEVELS = [15, 16, 17, 18] as const;
const DEFAULT_LEVEL_INDEX = 1; // 16px — 标准浏览器默认值
const STORAGE_KEY = 'fontSizeLevelIndex';

let currentIndex = DEFAULT_LEVEL_INDEX;
const listeners = new Set<(index: number) => void>();

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function clamp(index: number): number {
  return Math.max(0, Math.min(index, FONT_SIZE_LEVELS.length - 1));
}

function apply(index: number) {
  currentIndex = clamp(index);
  document.documentElement.style.fontSize = `${FONT_SIZE_LEVELS[currentIndex]}px`;
  listeners.forEach(fn => fn(currentIndex));
}

function persist(index: number) {
  try {
    chrome?.storage?.local?.set({ [STORAGE_KEY]: index });
  } catch {
    // storage 不可用时静默忽略
  }
}

// ---------------------------------------------------------------------------
// Public API（供 React hook 或其他模块调用）
// ---------------------------------------------------------------------------

export const fontSize = {
  get levels() {
    return FONT_SIZE_LEVELS;
  },
  get currentIndex() {
    return currentIndex;
  },
  get currentSize() {
    return FONT_SIZE_LEVELS[currentIndex];
  },

  zoomIn() {
    const next = clamp(currentIndex + 1);
    if (next !== currentIndex) {
      apply(next);
      persist(next);
    }
  },

  zoomOut() {
    const next = clamp(currentIndex - 1);
    if (next !== currentIndex) {
      apply(next);
      persist(next);
    }
  },

  reset() {
    if (currentIndex !== DEFAULT_LEVEL_INDEX) {
      apply(DEFAULT_LEVEL_INDEX);
      persist(DEFAULT_LEVEL_INDEX);
    }
  },

  /** 直接设置到指定级别索引 */
  setLevel(index: number) {
    const clamped = clamp(index);
    if (clamped !== currentIndex) {
      apply(clamped);
      persist(clamped);
    }
  },

  /** 按比例设置，1.0 = 默认 (16px)，1.2 = 放大 20% */
  setScale(ratio: number) {
    const targetPx = FONT_SIZE_LEVELS[DEFAULT_LEVEL_INDEX] * ratio;
    let closestIndex = 0;
    let minDiff = Infinity;
    for (let i = 0; i < FONT_SIZE_LEVELS.length; i++) {
      const diff = Math.abs(FONT_SIZE_LEVELS[i] - targetPx);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }
    apply(closestIndex);
    persist(closestIndex);
  },

  /** 订阅变更，返回取消订阅函数 */
  subscribe(fn: (index: number) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
} as const;

// ---------------------------------------------------------------------------
// 自动初始化（import 即生效）
// ---------------------------------------------------------------------------

// 1. 从 storage 恢复（默认 16px 即浏览器默认值，无需显式设置）
try {
  chrome?.storage?.local?.get([STORAGE_KEY], (result: Record<string, unknown>) => {
    if (STORAGE_KEY in result && typeof result[STORAGE_KEY] === 'number') {
      apply(result[STORAGE_KEY] as number);
    }
    // 默认值 16px 不需要显式设置，浏览器本身就是 16px
  });
} catch {
  // storage 不可用，保持浏览器默认
}

// 2. 监听 storage 变更，实现跨窗口同步
try {
  chrome?.storage?.onChanged?.addListener(
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
      const newIndex = changes[STORAGE_KEY].newValue;
      if (typeof newIndex === 'number' && clamp(newIndex) !== currentIndex) {
        apply(newIndex);
      }
    },
  );
} catch {
  // storage 不可用时静默忽略
}

// 3. 绑定快捷键 Ctrl/Cmd + =/-/0
//    DevTools panel 中这些快捷键会被 Chrome 拦截用于缩放整个 DevTools 窗口，
//    preventDefault 无法阻止，因此在 panel 环境下不绑定。
const isDevToolsPanel = !!document.getElementById('app-container');

if (!isDevToolsPanel) {
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    const modKey = event.metaKey || event.ctrlKey;
    if (!modKey || event.altKey) return;

    switch (event.key) {
      case '=':
      case '+':
        event.preventDefault();
        fontSize.zoomIn();
        break;
      case '-':
        event.preventDefault();
        fontSize.zoomOut();
        break;
      case '0':
        event.preventDefault();
        fontSize.reset();
        break;
    }
  });
}
