/**
 * SPM 浮层生命周期：跟踪页面上所有 SPM 候选元素的可见性 + DOM 变化，
 * 把"何时画"和"画什么"留给调用方（showAllSpmOverlay / heatmapOverlay 各自决定）。
 *
 * 集中维护 IntersectionObserver + MutationObserver + rAF + scroll/resize，
 * 两个 overlay 实现就不必各写一遍同样的骨架。
 */

import { SPM_SELECTOR, VISIBILITY_MARGIN, isSpmCandidate } from './spmHighlight';

const MUTATION_DEBOUNCE_MS = 120;
const ATTR_FILTER = ['data-spm', 'data-spm-abcd', 'data-spm-anchor-id', 'data-spm-click'];

export type SpmOverlayLifecycleHooks = {
  /**
   * 决定一个 SPM 候选元素是否需要被跟踪。允许带副作用（如顺便建立元素 → 业务标识的映射）。
   * 默认全部跟踪。
   */
  shouldTrack?: (el: Element) => boolean;
  /** 元素进入视口时调用（首次或重新可见） */
  onShow?: (el: Element) => void;
  /** 已跟踪元素的 SPM 属性变化且仍满足跟踪条件时调用 */
  onChange?: (el: Element) => void;
  /** 元素离开视口、被移出 DOM 或不再是 SPM 候选时调用 */
  onHide?: (el: Element) => void;
  /** rAF 节流后的统一回调，调用方在此读取 visible 集合重绘 */
  onTick: (visible: ReadonlySet<Element>) => void;
};

export type SpmOverlayLifecycle = {
  start: () => void;
  stop: () => void;
  scheduleTick: () => void;
};

export function createSpmOverlayLifecycle(hooks: SpmOverlayLifecycleHooks): SpmOverlayLifecycle {
  const observedEls = new Set<Element>();
  const visibleEls = new Set<Element>();
  const pendingObserve = new Set<Element>();
  const pendingChange = new Set<Element>();
  const pendingPrune = new Set<Element>();

  let viewportObserver: IntersectionObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let mutationTimer: ReturnType<typeof setTimeout> | null = null;
  let rafId: number | null = null;
  let cleanupListeners: (() => void) | null = null;

  const shouldTrack = hooks.shouldTrack ?? (() => true);

  function observe(el: Element) {
    if (observedEls.has(el)) return;
    if (!el.isConnected || !isSpmCandidate(el)) return;
    if (!shouldTrack(el)) return;
    observedEls.add(el);
    viewportObserver?.observe(el);
  }

  function unobserve(el: Element) {
    if (!observedEls.has(el)) return;
    observedEls.delete(el);
    viewportObserver?.unobserve(el);
    if (visibleEls.delete(el)) hooks.onHide?.(el);
  }

  function scheduleTick() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      hooks.onTick(visibleEls);
    });
  }

  function forEachCandidateIn(node: Node, cb: (el: Element) => void) {
    if (!(node instanceof Element)) return;
    if (isSpmCandidate(node)) cb(node);
    node.querySelectorAll(SPM_SELECTOR).forEach(cb);
  }

  function flushMutations() {
    mutationTimer = null;
    for (const el of pendingObserve) {
      if (!el.isConnected || !isSpmCandidate(el)) {
        pendingPrune.add(el);
        continue;
      }
      observe(el);
    }
    pendingObserve.clear();
    for (const el of pendingChange) {
      if (!el.isConnected || !isSpmCandidate(el)) {
        pendingPrune.add(el);
        continue;
      }
      if (!observedEls.has(el)) {
        observe(el);
        continue;
      }
      if (!shouldTrack(el)) {
        pendingPrune.add(el);
        continue;
      }
      hooks.onChange?.(el);
    }
    pendingChange.clear();
    for (const el of pendingPrune) {
      if (el.isConnected && isSpmCandidate(el) && shouldTrack(el)) continue;
      unobserve(el);
    }
    pendingPrune.clear();
    scheduleTick();
  }

  function start() {
    viewportObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const el = entry.target;
          if (!el.isConnected || !isSpmCandidate(el)) {
            unobserve(el);
            continue;
          }
          if (entry.isIntersecting) {
            if (!visibleEls.has(el)) {
              visibleEls.add(el);
              hooks.onShow?.(el);
            }
          } else if (visibleEls.delete(el)) {
            hooks.onHide?.(el);
          }
        }
        scheduleTick();
      },
      { root: null, rootMargin: `${VISIBILITY_MARGIN}px`, threshold: 0 },
    );

    document.querySelectorAll(SPM_SELECTOR).forEach(observe);

    mutationObserver = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach(n => forEachCandidateIn(n, el => pendingObserve.add(el)));
          r.removedNodes.forEach(n => forEachCandidateIn(n, el => pendingPrune.add(el)));
        } else if (r.type === 'attributes') {
          const el = r.target as Element;
          pendingChange.add(el);
        }
      }
      if (mutationTimer !== null) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(flushMutations, MUTATION_DEBOUNCE_MS);
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTR_FILTER,
    });

    const onScrollOrResize = () => scheduleTick();
    window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });
    cleanupListeners = () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };

    scheduleTick();
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (mutationTimer !== null) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    viewportObserver?.disconnect();
    viewportObserver = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    cleanupListeners?.();
    cleanupListeners = null;
    pendingObserve.clear();
    pendingChange.clear();
    pendingPrune.clear();
    observedEls.clear();
    visibleEls.clear();
  }

  return { start, stop, scheduleTick };
}
