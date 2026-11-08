// Component Overlay (MAIN world)
// 在 picker 模式期间,把页面上所有 React/Rax 用户组件用描边 + 名字标签可视化出来,
// 类似 react-scan 但只在 picker 启动时画一次,scroll/resize 时跟随重新定位。

import {
  getReactFiberOn,
  getComponentName,
  getRaxOwnerInternal,
  getRaxComponentName,
  getRaxCurrentElement,
} from './sourceTracer';

// 用 injected/ 下的本地副本而不是上一级目录的 zIndexUtil ——
// 后者同时被 ISOLATED world 的 content-script 入口引用，Rollup 会抽成跨 entry 共享 chunk，
// 让 early-inject.js 顶部生成 `import`，Chrome content_scripts 拒载。详见 ./zIndexUtil.ts。
import { maxEffectiveZ } from './zIndexUtil';

// 每个 box 直接挂在 documentElement 上(不加容器):container 的 position:fixed
// 默认就会创建 stacking context,把内部 box 的 z-index 关在一个 0 层里 ——
// 页面上任何 z-index>0 的元素都会盖住整个 overlay。spmHighlight / pickHighlight
// 都是同样的"散装挂 documentElement"模式。这个 class 仅作清理标记。
const OVERLAY_BOX_CLASS = '__mtop_component_overlay_box__';

// 跳过这些"看了没用"的组件名 —— 都是包装层,会把视图糊掉
const SKIP_NAMES = new Set([
  // React 内置
  'Fragment',
  'Suspense',
  'Profiler',
  'StrictMode',
  'Provider',
  'Consumer',
  'ContextProvider',
  'ContextConsumer',
  'ForwardRef',
  'Memo',
  'Anonymous',
  // Rax 基础组件(本质是 host 包装,几乎每个 DOM 都会命中)
  'View',
  'Text',
  'Image',
  'ScrollView',
  'Touchable',
  'TouchableHighlight',
  'TouchableOpacity',
  'RecyclerView',
]);

interface OwnerEntry {
  id: any;
  name: string;
  hosts: Element[];
  box: HTMLDivElement;
}

function isUserComponentName(name: string | undefined): name is string {
  if (!name) return false;
  if (SKIP_NAMES.has(name)) return false;
  if (name.startsWith('_')) return false;
  // 必须大写字母开头(组件惯例);小写一般是 host
  return /^[A-Z]/.test(name);
}

type OwnerHit = { id: any; name: string } | null;

function findReactUserOwner(fiber: any, cache: WeakMap<object, OwnerHit>): OwnerHit {
  // 沿 .return 向上,沿途所有 fiber 都共享同一个 owner 结果 —— scan 大量同祖先的 DOM 时复用
  const path: any[] = [];
  let f = fiber;
  let hit: OwnerHit = null;
  while (f) {
    const cached = cache.get(f);
    if (cached !== undefined) {
      hit = cached;
      break;
    }
    path.push(f);
    const t = f.type;
    if (typeof t === 'function' || (t && typeof t === 'object')) {
      const name = getComponentName(f);
      if (isUserComponentName(name)) {
        hit = { id: f, name };
        break;
      }
    }
    f = f.return;
  }
  for (const node of path) cache.set(node, hit);
  return hit;
}

function findRaxUserOwner(el: Element): OwnerHit {
  let owner = getRaxOwnerInternal(el);
  while (owner) {
    const name = getRaxComponentName(owner);
    if (isUserComponentName(name)) return { id: owner, name };
    owner = getRaxCurrentElement(owner)?._owner ?? null;
  }
  return null;
}

function findUserOwner(el: Element, fiberCache: WeakMap<object, OwnerHit>): OwnerHit {
  const fiber = getReactFiberOn(el);
  if (fiber) {
    const hit = findReactUserOwner(fiber, fiberCache);
    if (hit) return hit;
  }
  return findRaxUserOwner(el);
}

// 6 色调色板:tailwind-300 描边 + 100 标签底色 + 700 标签文字,整体偏浅淡
const PALETTE: ReadonlyArray<{
  border: string;
  bg: string;
  labelBg: string;
  labelText: string;
}> = [
  {
    border: '#6ee7b7',
    bg: 'rgba(110,231,183,0.05)',
    labelBg: '#d1fae5',
    labelText: '#047857',
  }, // emerald
  {
    border: '#60a5fa',
    bg: 'rgba(96,165,250,0.05)',
    labelBg: '#dbeafe',
    labelText: '#1d4ed8',
  }, // blue (bumped to 400 for clearer blue identity)
  {
    border: '#67e8f9',
    bg: 'rgba(103,232,249,0.05)',
    labelBg: '#cffafe',
    labelText: '#0e7490',
  }, // cyan (replaces teal — teal at 300 reads as green next to emerald)
  {
    border: '#fcd34d',
    bg: 'rgba(252,211,77,0.05)',
    labelBg: '#fef3c7',
    labelText: '#b45309',
  }, // amber
  {
    border: '#fda4af',
    bg: 'rgba(253,164,175,0.05)',
    labelBg: '#ffe4e6',
    labelText: '#be123c',
  }, // rose
  {
    border: '#c4b5fd',
    bg: 'rgba(196,181,253,0.05)',
    labelBg: '#ede9fe',
    labelText: '#6d28d9',
  }, // violet
];

function colorFor(name: string): (typeof PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const idx = ((h % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[idx];
}

function scanComponents(): Map<any, { name: string; hosts: Element[] }> {
  const map = new Map<any, { name: string; hosts: Element[] }>();
  const fiberCache = new WeakMap<object, OwnerHit>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let cur: Node | null = walker.currentNode;
  let count = 0;
  // 单次最多走 5000 个节点防极端长页面卡顿
  // 注意:不需要排除 overlay 自身的 box —— box 直接挂在 documentElement,
  // 而 walker 从 document.body 起,根本扫不到
  while (cur && count < 5000) {
    count++;
    const el = cur as Element;
    const hit = findUserOwner(el, fiberCache);
    if (hit) {
      let bucket = map.get(hit.id);
      if (!bucket) {
        bucket = { name: hit.name, hosts: [] };
        map.set(hit.id, bucket);
      }
      bucket.hosts.push(el);
    }
    cur = walker.nextNode();
  }
  return map;
}

function computeUnionRect(
  hosts: Element[],
): { left: number; top: number; right: number; bottom: number } | null {
  let l = Infinity,
    t = Infinity,
    r = -Infinity,
    b = -Infinity;
  for (const el of hosts) {
    if (!el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.left < l) l = rect.left;
    if (rect.top < t) t = rect.top;
    if (rect.right > r) r = rect.right;
    if (rect.bottom > b) b = rect.bottom;
  }
  if (l === Infinity) return null;
  return { left: l, top: t, right: r, bottom: b };
}

function makeBox(name: string): HTMLDivElement {
  const color = colorFor(name);
  const box = document.createElement('div');
  box.className = OVERLAY_BOX_CLASS;
  box.style.cssText = [
    'position:fixed',
    'box-sizing:border-box',
    `border:1.5px dashed ${color.border}`,
    `background:${color.bg}`,
    'pointer-events:none',
    'border-radius:2px',
    'display:none',
  ].join(';');
  const label = document.createElement('span');
  label.textContent = name;
  label.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    `background:${color.labelBg}`,
    `color:${color.labelText}`,
    'font-size:9px',
    'font-family:monospace',
    'line-height:1',
    'padding:1px 3px',
    'max-width:120px',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'white-space:nowrap',
    'pointer-events:none',
  ].join(';');
  box.appendChild(label);
  return box;
}

let overlayCleanup: (() => void) | null = null;

function hideOverlay() {
  overlayCleanup?.();
  overlayCleanup = null;
  for (const box of document.querySelectorAll(`.${OVERLAY_BOX_CLASS}`)) {
    box.remove();
  }
}

const MUTATION_DEBOUNCE_MS = 150;

function showOverlay() {
  hideOverlay();

  const entries = new Map<any, OwnerEntry>();
  let rafId: number | null = null;
  let mutationTimer: ReturnType<typeof setTimeout> | null = null;

  function position() {
    rafId = null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const entry of entries.values()) {
      const rect = computeUnionRect(entry.hosts);
      if (
        !rect ||
        rect.right < 0 ||
        rect.left > vw ||
        rect.bottom < 0 ||
        rect.top > vh ||
        rect.right - rect.left < 8 ||
        rect.bottom - rect.top < 8
      ) {
        entry.box.style.display = 'none';
        continue;
      }
      entry.box.style.display = 'block';
      entry.box.style.left = `${rect.left}px`;
      entry.box.style.top = `${rect.top}px`;
      entry.box.style.width = `${rect.right - rect.left}px`;
      entry.box.style.height = `${rect.bottom - rect.top}px`;
    }
  }

  function scheduleReposition() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(position);
  }

  function rebuild() {
    mutationTimer = null;
    const scan = scanComponents();
    // 卸载消失的 owner
    for (const [id, entry] of entries) {
      if (!scan.has(id)) {
        entry.box.remove();
        entries.delete(id);
      }
    }
    // 新增/更新
    for (const [id, { name, hosts }] of scan) {
      const existing = entries.get(id);
      if (existing) {
        existing.hosts = hosts;
        if (existing.name !== name) {
          existing.name = name;
          const label = existing.box.firstChild as HTMLElement | null;
          if (label) label.textContent = name;
        }
        // hosts 变了就刷新一下 z（开销由 zIndexCache 摊销）
        existing.box.style.zIndex = String(maxEffectiveZ(hosts));
      } else {
        const box = makeBox(name);
        box.style.zIndex = String(maxEffectiveZ(hosts));
        document.documentElement.appendChild(box);
        entries.set(id, { id, name, hosts, box });
      }
    }
    position();
  }

  function scheduleRebuild() {
    if (mutationTimer !== null) return;
    mutationTimer = setTimeout(rebuild, MUTATION_DEBOUNCE_MS);
  }

  rebuild();

  // 监听整树 childList:组件挂载/卸载会反映在子节点变化上。属性变化不关心 —— 不影响组件树。
  // 注意:box 直接挂在 documentElement,而 mo 只观察 document.body 子树,
  // 不会被自身 DOM 变更触发,无需排除自激
  const mo = new MutationObserver(() => scheduleRebuild());
  mo.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
  window.addEventListener('resize', scheduleReposition, { passive: true });

  overlayCleanup = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (mutationTimer !== null) clearTimeout(mutationTimer);
    mo.disconnect();
    window.removeEventListener('scroll', scheduleReposition, true);
    window.removeEventListener('resize', scheduleReposition);
  };
}

export function installComponentOverlay(): void {
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'mearl-content') return;

    if (data.type === 'SHOW_COMPONENT_OVERLAY') {
      try {
        showOverlay();
      } catch (err) {
        // 不让 picker 流程被打断，但记录下来便于排查
        console.warn('[mearl] componentOverlay show failed', err);
      }
    } else if (data.type === 'HIDE_COMPONENT_OVERLAY') {
      hideOverlay();
    }
  });
}
