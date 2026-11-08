// MAIN world 的 z-index 计算副本（跟 ../zIndexUtil 是同一段逻辑）。
// 必须独立于外层文件，否则 Rollup 会把它抽成跨 entry 共享 chunk，导致
// early-inject.js 顶部出现 `import` —— Chrome content_scripts 不支持 ESM,
// 会直接 "Cannot use import statement outside a module" 拒载。
// 修改时请同步修改 ../zIndexUtil.ts。

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
