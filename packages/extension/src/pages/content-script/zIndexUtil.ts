// z-index 计算工具：沿祖先链取一个能让 overlay 贴在目标 stacking context 上的 z 值
// ISOLATED world 的 spmHighlight / heatmapOverlay 用这一份；MAIN world 的 componentOverlay
// 用 injected/zIndexUtil.ts 的副本（不能合并 —— 见该文件顶部注释）。改这里时同步改那份。
// 必须保持纯 DOM 实现，不依赖 chrome.* / 其它仅在某一 world 可用的 API。

const Z_INDEX_CACHE_TTL = 1500;
const zIndexCache = new WeakMap<Element, { value: number; expiresAt: number }>();

export function getEffectiveZIndex(el: Element): number {
  const now = performance.now();
  const cached = zIndexCache.get(el);
  if (cached && cached.expiresAt > now) return cached.value;

  let node: HTMLElement | null = el as HTMLElement;
  let z = 0;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    if (style.position !== 'static' && style.zIndex !== 'auto') {
      const val = parseInt(style.zIndex, 10);
      if (!Number.isNaN(val)) z = val;
    }
    node = node.parentElement;
  }
  const value = z > 0 ? z + 1 : 10;
  zIndexCache.set(el, { value, expiresAt: now + Z_INDEX_CACHE_TTL });
  return value;
}

// componentOverlay 一个组件可能横跨多个 DOM 节点，需要沿用每个 host 各自的有效 z 取最大
export function maxEffectiveZ(hosts: ArrayLike<Element>): number {
  let max = 0;
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    if (!h.isConnected) continue;
    const z = getEffectiveZIndex(h);
    if (z > max) max = z;
  }
  return max || 10;
}
