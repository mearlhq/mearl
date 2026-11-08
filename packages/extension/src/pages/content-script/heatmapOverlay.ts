/**
 * 热度地图渲染（DOM overlay 版）：
 * - 同一个 spm 在页面上可能命中多个 DOM 元素（如列表项、并排按钮）。这里按 spm 聚合：
 *   求所有命中元素的 bounding box 并集，画一个大边框 + 一个 label，避免重复 label 互相遮挡
 * - label 显示当前指标的值；边框/label 颜色按"档位"染色（5 档：蓝/青/绿/橙/红）
 * - 档位用对数空间下的五分位数划分（start() 时按 spm 唯一值算好，滚动颜色稳定）
 * - 纯展示，不带任何 hover/click 交互；overlay 全部 pointer-events:none，不影响页面
 *
 * 可见性 / DOM mutation / rAF / scroll 监听都委托给 spmOverlayLifecycle，本文件
 * 只负责"哪些元素映射到哪个 spm" + "如何按值染色"。
 */

import { findSpmElements } from './spmHighlight';
import { getEffectiveZIndex } from './zIndexUtil';
import { createSpmOverlayLifecycle, type SpmOverlayLifecycle } from './spmOverlayLifecycle';

const HEATMAP_OVERLAY_SELECTOR = '[data-mtop-heatmap-overlay]';

export type HeatmapMeasure = string;
export type HeatmapPoint = {
  spm: string;
  spmName: string | null;
  measures: Record<string, number>;
};

/**
 * 5 档主色（RGB 元组，运行时按档内透明度拼 rgba）：蓝 → 青 → 绿 → 橙 → 红
 * 同档内的 value 再按对数位置映射 alpha，让 0 与 1000 即使都在最低档也能区分深浅
 */
const TIER_RGB = [
  [59, 130, 246], // blue
  [6, 182, 212], // cyan
  [16, 185, 129], // green
  [245, 158, 11], // amber
  [239, 68, 68], // red
] as const;
const TIER_COUNT = TIER_RGB.length;

function colorForTier(tier: number, inTierNorm: number) {
  const [r, g, b] = TIER_RGB[Math.max(0, Math.min(TIER_COUNT - 1, tier))];
  const t = Math.max(0, Math.min(1, inTierNorm));
  // 同档内：边框 0.45..1.0；背景 0.04..0.16；label 始终实色
  const borderA = 0.45 + 0.55 * t;
  const bgA = 0.04 + 0.12 * t;
  return {
    border: `rgba(${r},${g},${b},${borderA.toFixed(3)})`,
    bg: `rgba(${r},${g},${b},${bgA.toFixed(3)})`,
    labelBg: `rgb(${r},${g},${b})`,
  };
}

function formatNumber(value: number, format: 'number' | 'percent'): string {
  if (format === 'percent') return `${(value * 100).toFixed(2)}%`;
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}w`;
  if (value >= 1000) return value.toLocaleString();
  return String(Number.isInteger(value) ? value : value.toFixed(2));
}

/**
 * 把一组值按对数空间划成 5 档；返回 6 个边界（包含 min 和 max），方便后续算档内归一化位置。
 * 用分位数确保每档元素数量大致均衡，长尾数据也能展开。
 */
function computeTierBounds(values: number[]): number[] {
  const logged = values
    .filter(v => v > 0)
    .map(v => Math.log(v + 1))
    .sort((a, b) => a - b);
  if (logged.length === 0) return [0, 0, 0, 0, 0, 0];
  const pick = (p: number) => logged[Math.min(logged.length - 1, Math.floor(logged.length * p))];
  return [logged[0], pick(0.2), pick(0.4), pick(0.6), pick(0.8), logged[logged.length - 1]];
}

/** 同时返回档位 + 该值在档内的归一化位置（0..1），用于档位上色 + 档内透明度 */
function valueToTier(value: number, bounds: number[]): { tier: number; inTierNorm: number } {
  if (value <= 0) return { tier: 0, inTierNorm: 0 };
  const logV = Math.log(value + 1);
  // 找到 logV 所在档：bounds[tier] <= logV <= bounds[tier+1]
  let tier = 0;
  for (let i = 1; i < TIER_COUNT; i++) {
    if (logV > bounds[i]) tier = i;
  }
  const low = bounds[tier];
  const high = bounds[tier + 1];
  const range = high - low;
  const inTierNorm = range > 1e-9 ? Math.max(0, Math.min(1, (logV - low) / range)) : 0.5;
  return { tier, inTierNorm };
}

export type HeatmapRenderer = {
  start: (measure: HeatmapMeasure, points: HeatmapPoint[], format?: 'number' | 'percent') => void;
  stop: () => void;
};

type OverlayHandle = {
  box: HTMLDivElement;
  label: HTMLSpanElement;
  /** spm 第一次出现时算好的 zIndex，后续滚动不重算；start() 重置 */
  z: number;
  /** 上一次写入的 value，用于短路颜色/textContent 写入；NaN 表示从未画过 */
  lastValue: number;
  /** 上一次写入的尺寸，用于短路 width/height 写入；位置不缓存（亚像素直写） */
  lastW: number;
  lastH: number;
};

/** 同一帧内复用的 group 累加器；render() 内每次 spm 第一次出现时填一个 */
type GroupAcc = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  z: number;
  value: number;
  /** true = 该 spm 是新的，需要写入 zIndex（已有 overlay 复用 handle.z） */
  isNew: boolean;
};

export function createHeatmapRenderer(): HeatmapRenderer {
  let currentMeasure: HeatmapMeasure = '';
  let currentFormat: 'number' | 'percent' = 'number';
  let pointBySpm = new Map<string, HeatmapPoint>();
  const elementToSpm = new Map<Element, string>();
  // 一个 spm 一个 overlay（合并 box）；key 是 spm 字符串而不是 Element
  const overlays = new Map<string, OverlayHandle>();
  // 6 个边界值（[min, p20, p40, p60, p80, max]，对数空间），start() 时一次性算好；
  // 后续滚动不重算 → 同一 spm 颜色稳定
  let tierBounds: number[] = [0, 0, 0, 0, 0, 0];
  let lifecycle: SpmOverlayLifecycle | null = null;
  // 模块级复用，避免每帧 new Map（high-freq GC 也会拖卡顿）
  const grouped = new Map<string, GroupAcc>();
  // 当前 measure 下"有值（>0）"的 spm 集合；start() / measure 切换时重算。
  // render 用它在循环里 short-circuit value=0 的元素，跳过它们的 getBoundingClientRect。
  const drawableSpms = new Set<string>();

  function getSpmValue(spm: string): number | null {
    const p = pointBySpm.get(spm);
    if (!p) return null;
    const v = p.measures[currentMeasure];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  function ensureOverlay(spm: string): OverlayHandle {
    let h = overlays.get(spm);
    if (h) return h;
    const box = document.createElement('div');
    box.setAttribute('data-mtop-heatmap-overlay', '1');
    // 用 transform 偏移定位（走 compositor，比 left/top 触发 layout/paint 便宜）
    // 必须先把 top/left 钉到 0，否则 fixed 元素初始位置会是 auto
    box.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'transform:translate3d(0,0,0)',
      'pointer-events:none',
      'box-sizing:border-box',
      'border-width:1px',
      'border-style:solid',
      'will-change:transform,width,height',
    ].join(';');
    const label = document.createElement('span');
    label.style.cssText = [
      'position:absolute',
      'top:0',
      'left:0',
      'color:#fff',
      'font-size:10px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",monospace',
      'line-height:1',
      'padding:1px 3px',
      'white-space:nowrap',
      'max-width:120px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'pointer-events:none',
    ].join(';');
    box.appendChild(label);
    document.documentElement.appendChild(box);
    h = { box, label, z: 0, lastValue: NaN, lastW: NaN, lastH: NaN };
    overlays.set(spm, h);
    return h;
  }

  function removeOverlay(spm: string) {
    const h = overlays.get(spm);
    if (!h) return;
    h.box.remove();
    overlays.delete(spm);
  }

  /**
   * lifecycle.onTick 回调：把"当前可见的、有数据的"元素按 spm 聚合，
   * 每个 spm 画一个 union box；不再可见的 spm 回收。
   *
   * 性能要点：
   * - drawableSpms 提前过滤 value=0 的元素，省掉它们的 getBoundingClientRect
   * - 用 transform: translate 代替 left/top（走 compositor，不触发 layout/paint）
   * - 位置/尺寸/颜色/text/zIndex 都按 OverlayHandle.lastXxx 缓存短路；只写变化的属性
   * - zIndex 只在新 spm 的第一个元素上算一次（不再取 group 内 max，省掉重复 getEffectiveZIndex）
   */
  function render(visible: ReadonlySet<Element>) {
    grouped.clear();
    for (const el of visible) {
      if (!el.isConnected) continue;
      const spm = elementToSpm.get(el);
      // 跳过没数据 / value<=0 的 spm，省一次 getBoundingClientRect
      if (!spm || !drawableSpms.has(spm)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      let acc = grouped.get(spm);
      if (acc === undefined) {
        const existing = overlays.get(spm);
        acc = {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          z: existing ? existing.z : getEffectiveZIndex(el),
          value: getSpmValue(spm) as number,
          isNew: !existing,
        };
        grouped.set(spm, acc);
      } else {
        if (r.left < acc.left) acc.left = r.left;
        if (r.top < acc.top) acc.top = r.top;
        if (r.right > acc.right) acc.right = r.right;
        if (r.bottom > acc.bottom) acc.bottom = r.bottom;
      }
    }

    for (const [spm, acc] of grouped) {
      const h = ensureOverlay(spm);
      // 位置：亚像素直写（不 round 不缓存）—— round 在 0.5 边界会跳整数引起抖动；
      // transform 走 compositor，每帧写也便宜。translate3d 强制 GPU layer。
      h.box.style.transform = `translate3d(${acc.left}px,${acc.top}px,0)`;

      // 尺寸：round 后短路 —— 元素尺寸正常不会变，缓存能省 layout
      const w = Math.round(acc.right - acc.left);
      const ht = Math.round(acc.bottom - acc.top);
      if (h.lastW !== w) {
        h.box.style.width = `${w}px`;
        h.lastW = w;
      }
      if (h.lastH !== ht) {
        h.box.style.height = `${ht}px`;
        h.lastH = ht;
      }

      if (h.lastValue !== acc.value) {
        const { tier, inTierNorm } = valueToTier(acc.value, tierBounds);
        const color = colorForTier(tier, inTierNorm);
        h.box.style.borderColor = color.border;
        h.box.style.background = color.bg;
        h.label.textContent = formatNumber(acc.value, currentFormat);
        h.label.style.background = color.labelBg;
        h.lastValue = acc.value;
      }

      if (acc.isNew) {
        h.box.style.zIndex = String(acc.z);
        h.z = acc.z;
      }
    }

    for (const spm of [...overlays.keys()]) {
      if (!grouped.has(spm)) removeOverlay(spm);
    }
  }

  /** lifecycle.shouldTrack 钩子：顺手把"直接挂了 abcd / anchor-id 且能匹配到数据"的元素建好映射 */
  function shouldTrack(el: Element): boolean {
    if (elementToSpm.has(el)) return true;
    const abcd = el.getAttribute('data-spm-abcd') || el.getAttribute('data-spm-anchor-id');
    if (abcd && pointBySpm.has(abcd)) {
      elementToSpm.set(el, abcd);
      return true;
    }
    return false;
  }

  function clearAll() {
    lifecycle?.stop();
    lifecycle = null;
    elementToSpm.clear();
    for (const h of overlays.values()) h.box.remove();
    overlays.clear();
    drawableSpms.clear();
    tierBounds = [0, 0, 0, 0, 0, 0];
    document.querySelectorAll(HEATMAP_OVERLAY_SELECTOR).forEach(n => n.remove());
  }

  function start(measure: HeatmapMeasure, points: HeatmapPoint[], format: 'number' | 'percent' = 'number') {
    clearAll();
    currentMeasure = measure;
    currentFormat = format;
    pointBySpm = new Map(points.map(p => [p.spm, p]));

    // 预跑 findSpmElements 把"非 abcd 直接命中"的元素（如祖先 B/C + data-spm-click 的 D）
    // 也建好映射；lifecycle 启动后的初始扫描走 SPM_SELECTOR 也会观察到它们。
    for (const spm of pointBySpm.keys()) {
      for (const el of findSpmElements(spm)) {
        if (!elementToSpm.has(el)) elementToSpm.set(el, spm);
      }
    }

    // 按"页面上实际能映射上的 spm 唯一集合"算分位（去重——同 spm 多元素只贡献一次值，
    // 避免某个被重复实例化 N 次的 spm 把档位分布压扁）。同时填 drawableSpms，
    // render 用它在循环里跳过 value<=0 的元素。
    const mappedSpms = new Set(elementToSpm.values());
    const allValues: number[] = [];
    for (const spm of mappedSpms) {
      const v = getSpmValue(spm);
      if (v === null) continue;
      allValues.push(v);
      if (v > 0) drawableSpms.add(spm);
    }
    tierBounds = computeTierBounds(allValues);

    // 不挂 onHide：单个元素离开视口不应该立即拆 overlay，
    // 因为同 spm 的其他元素可能还在视口里。render() 在 tick 时按"本次 grouped"集合统一回收。
    lifecycle = createSpmOverlayLifecycle({
      shouldTrack,
      onTick: render,
    });
    lifecycle.start();
  }

  return { start, stop: clearAll };
}

export { HEATMAP_OVERLAY_SELECTOR, TIER_RGB };
