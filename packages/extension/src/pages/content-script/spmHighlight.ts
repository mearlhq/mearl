import { createSpmOverlayLifecycle } from './spmOverlayLifecycle';
import { getEffectiveZIndex } from './zIndexUtil';

type Cleanup = () => void;

type OverlayStyle = {
  bg: string;
  border: string;
};

export type SpmHighlighter = {
  highlightSpmOnPage: (spm: string) => number;
  inspectSpmInPage: (spm: string) => number;
  clearSpmHighlight: () => void;
  toggleAllSpmOverlay: (enabled: boolean) => void;
  clearAllSpmOverlay: () => void;
};

const HOTZONE_SELECTOR = '[data-mtop-spm-hotzone]';
const ALL_OVERLAY_SELECTOR = '[data-mtop-spm-all-overlay]';
export const SPM_SELECTOR = '[data-spm-abcd],[data-spm-anchor-id],[data-spm-click],[data-spm]';
export const VISIBILITY_MARGIN = 200;

export function isSpmCandidate(el: Element): boolean {
  return (
    el.hasAttribute('data-spm-abcd') ||
    el.hasAttribute('data-spm-anchor-id') ||
    el.hasAttribute('data-spm-click') ||
    el.hasAttribute('data-spm')
  );
}

/**
 * 查找匹配 SPM 的 DOM 元素列表。
 * 有 D 段时只匹配 D 级元素，找不到不退化到粗粒度；无 D 段时定位到 C 层。
 */
export function findSpmElements(spmStr: string): Element[] {
  const parts = spmStr.split('.');
  const [, b, c, d] = parts;
  const matched: Element[] = [];

  if (parts.length >= 4 && c && d) {
    document
      .querySelectorAll(
        `[data-spm-abcd="${CSS.escape(spmStr)}"],[data-spm-anchor-id="${CSS.escape(spmStr)}"]`,
      )
      .forEach(el => matched.push(el));

    if (matched.length === 0) {
      // B→C→click(D)
      if (b) {
        document
          .querySelectorAll(
            `[data-spm="${CSS.escape(b)}"] [data-spm="${CSS.escape(c)}"] [data-spm-click*="locaid=${CSS.escape(d)}"]`,
          )
          .forEach(el => matched.push(el));
      }
      // B→C→spm(D)
      if (matched.length === 0 && b) {
        document
          .querySelectorAll(
            `[data-spm="${CSS.escape(b)}"] [data-spm="${CSS.escape(c)}"] [data-spm="${CSS.escape(d)}"]`,
          )
          .forEach(el => matched.push(el));
      }
      // C→click(D)
      if (matched.length === 0) {
        document
          .querySelectorAll(
            `[data-spm="${CSS.escape(c)}"] [data-spm-click*="locaid=${CSS.escape(d)}"]`,
          )
          .forEach(el => matched.push(el));
      }
      // C→spm(D)
      if (matched.length === 0) {
        document
          .querySelectorAll(`[data-spm="${CSS.escape(c)}"] [data-spm="${CSS.escape(d)}"]`)
          .forEach(el => matched.push(el));
      }
      // D 找不到，不退化到 C 层
    }
  } else if (parts.length === 3 && c) {
    document.querySelectorAll(`[data-spm="${CSS.escape(c)}"]`).forEach(el => matched.push(el));
    if (matched.length === 0) {
      document
        .querySelectorAll(`[data-spm-abcd*="${CSS.escape(spmStr)}"]`)
        .forEach(el => matched.push(el));
    }
  } else if (parts.length === 2) {
    const [seg1, seg2] = parts;
    // 优先用祖先→后代选择器：[data-spm="c1"] [data-spm="c2"]
    if (seg1 && seg2) {
      document
        .querySelectorAll(`[data-spm="${CSS.escape(seg1)}"] [data-spm="${CSS.escape(seg2)}"]`)
        .forEach(el => matched.push(el));
    }
    // fallback：匹配 body[data-spm=seg1]（原有逻辑）
    if (matched.length === 0 && seg1) {
      const bodyEl = document.body;
      if (bodyEl.getAttribute('data-spm') === seg1) matched.push(bodyEl);
    }
  }

  return matched;
}

function parseSpmInput(rawInput: string): string {
  if (!rawInput) return rawInput;
  if (!/^https?:\/\//i.test(rawInput)) return rawInput;

  try {
    const u = new URL(rawInput);
    return u.searchParams.get('spm') ?? rawInput;
  } catch {
    return rawInput;
  }
}

function getAllOverlaySpmLabel(spmValue: string): string {
  const parts = spmValue.split('.');
  if (parts.length === 5) {
    return parts[3] || spmValue;
  }
  return parts[parts.length - 1] || spmValue;
}

function getHotzoneSpmLabel(spmValue: string): string {
  const parts = spmValue.split('.');
  if (parts.length >= 4) {
    return `${parts[2]}.${parts[3]}`;
  }
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  }
  return spmValue;
}

export function createSpmHighlighter(): SpmHighlighter {
  let spmHotzoneTimer: ReturnType<typeof setTimeout> | null = null;
  let spmHotzoneRafId: number | null = null;

  let spmAllOverlayCleanup: Cleanup | null = null;

  function clearHotzoneState() {
    if (spmHotzoneRafId !== null) {
      cancelAnimationFrame(spmHotzoneRafId);
      spmHotzoneRafId = null;
    }
    if (spmHotzoneTimer !== null) {
      clearTimeout(spmHotzoneTimer);
      spmHotzoneTimer = null;
    }
    document.querySelectorAll(HOTZONE_SELECTOR).forEach(el => el.remove());
  }

  function clearAllSpmOverlay() {
    spmAllOverlayCleanup?.();
    spmAllOverlayCleanup = null;
    document.querySelectorAll(ALL_OVERLAY_SELECTOR).forEach(el => el.remove());
  }

  function getSpmStyle(el: Element): OverlayStyle | null {
    if (el.hasAttribute('data-spm-click'))
      return { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.8)' };
    if (el.hasAttribute('data-spm-abcd') || el.hasAttribute('data-spm-anchor-id')) {
      return { bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.8)' };
    }
    if (el.hasAttribute('data-spm'))
      return { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.8)' };
    return null;
  }

  function getSpmLabel(el: Element): string {
    const spmAbcd = el.getAttribute('data-spm-abcd') || el.getAttribute('data-spm-anchor-id');
    if (spmAbcd) {
      return getAllOverlaySpmLabel(spmAbcd);
    }

    const spmClick = el.getAttribute('data-spm-click');
    if (spmClick) {
      const m = spmClick.match(/locaid=([^,;|&]+)/);
      return m ? m[1] : spmClick;
    }

    const spm = el.getAttribute('data-spm');
    if (spm) {
      return getAllOverlaySpmLabel(spm);
    }

    return '';
  }

  function showAllSpmOverlay() {
    clearAllSpmOverlay();

    const overlayMap = new Map<Element, HTMLDivElement>();

    function removeOverlayForEl(el: Element) {
      const o = overlayMap.get(el);
      if (!o) return;
      o.remove();
      overlayMap.delete(el);
    }

    function updateOverlayForEl(el: Element) {
      const o = overlayMap.get(el);
      if (!o) return;

      const style = getSpmStyle(el);
      if (!style) {
        removeOverlayForEl(el);
        return;
      }

      o.style.borderColor = style.border;
      o.style.background = style.bg;

      const labelText = getSpmLabel(el);
      let label = o.querySelector(':scope > span') as HTMLSpanElement | null;
      if (!labelText) {
        label?.remove();
        return;
      }

      if (!label) {
        label = document.createElement('span');
        label.style.cssText =
          'position:absolute;top:0;left:0;color:#fff;font-size:9px;font-family:monospace;line-height:1;padding:1px 3px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;';
        o.appendChild(label);
      }
      label.style.background = style.border;
      label.textContent = labelText;
    }

    function addOverlayForEl(el: Element) {
      if (overlayMap.has(el)) return;
      const style = getSpmStyle(el);
      if (!style) return;

      const o = document.createElement('div');
      o.setAttribute('data-mtop-spm-all-overlay', '1');
      const zIndex = getEffectiveZIndex(el);
      o.style.cssText = `position:fixed;z-index:${zIndex};pointer-events:none;box-sizing:border-box;border:1px solid ${style.border};background:${style.bg};`;
      overlayMap.set(el, o);
      updateOverlayForEl(el);
      document.documentElement.appendChild(o);
    }

    function updatePositions(visible: ReadonlySet<Element>) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      for (const [el, o] of overlayMap) {
        if (!visible.has(el)) {
          removeOverlayForEl(el);
          continue;
        }
        const r = el.getBoundingClientRect();
        const isOutsideViewport =
          (r.width === 0 && r.height === 0) ||
          r.bottom < -VISIBILITY_MARGIN ||
          r.right < -VISIBILITY_MARGIN ||
          r.top > vh + VISIBILITY_MARGIN ||
          r.left > vw + VISIBILITY_MARGIN;
        if (isOutsideViewport) {
          o.style.display = 'none';
          continue;
        }
        o.style.top = `${r.top}px`;
        o.style.left = `${r.left}px`;
        o.style.width = `${r.width}px`;
        o.style.height = `${r.height}px`;
        o.style.display = 'block';
      }
    }

    const lifecycle = createSpmOverlayLifecycle({
      onShow: addOverlayForEl,
      onChange: updateOverlayForEl,
      onHide: removeOverlayForEl,
      onTick: updatePositions,
    });
    lifecycle.start();

    spmAllOverlayCleanup = () => {
      lifecycle.stop();
      for (const o of overlayMap.values()) o.remove();
      overlayMap.clear();
    };
  }

  function highlightSpmOnPage(spm: string): number {
    clearHotzoneState();
    if (!spm) return 0;

    const spmStr = parseSpmInput(spm);

    const matched = findSpmElements(spmStr);
    if (matched.length === 0) return 0;

    if (matched.length === 1) {
      matched[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const hotzoneLabelText = getHotzoneSpmLabel(spmStr);

    const overlays = matched.map(el => {
      const o = document.createElement('div');
      o.setAttribute('data-mtop-spm-hotzone', '1');
      const zIndex = getEffectiveZIndex(el);
      o.style.cssText = `position:fixed;z-index:${zIndex};pointer-events:none;box-sizing:border-box;border:1px solid #ef4444;border-radius:2px;background:rgba(239,68,68,0.1);transition:none!important;animation:none!important;`;

      let lb: HTMLDivElement | null = null;
      if (hotzoneLabelText) {
        lb = document.createElement('div');
        lb.style.cssText =
          'position:absolute;background:#ef4444;color:#fff;font-size:10px;font-family:monospace;padding:1px 5px;border-radius:2px;white-space:nowrap;max-width:72vw;overflow:hidden;text-overflow:ellipsis;pointer-events:none;transition:none!important;animation:none!important;';
        lb.textContent = hotzoneLabelText;
        o.appendChild(lb);
      }

      document.documentElement.appendChild(o);
      return { el, o, lb };
    });

    function updateHotzonePositions() {
      spmHotzoneRafId = null;
      if (!overlays.some(({ el }) => el.isConnected)) { clearHotzoneState(); return; }
      const vw = window.innerWidth;
      for (const { el, o, lb } of overlays) {
        const r = el.getBoundingClientRect();
        o.style.top = `${r.top}px`;
        o.style.left = `${r.left}px`;
        o.style.width = `${r.width}px`;
        o.style.height = `${r.height}px`;

        if (lb) {
          const labelRight = vw - r.right < 160;
          const labelBelow = r.top < 20;
          lb.style.left = labelRight ? 'auto' : '0';
          lb.style.right = labelRight ? '0' : 'auto';
          lb.style.top = labelBelow ? 'calc(100% + 2px)' : '-18px';
        }
      }
      // The locate highlight lives for only three seconds. Sample every paint instead of
      // waiting for a scroll event to enqueue another frame behind smooth scrolling.
      spmHotzoneRafId = requestAnimationFrame(updateHotzonePositions);
    }

    updateHotzonePositions();

    spmHotzoneTimer = setTimeout(() => clearHotzoneState(), 3000);
    return matched.length;
  }

  function inspectSpmInPage(spm: string): number {
    if (!spm) return 0;
    const spmStr = parseSpmInput(spm);
    // 清除上一次标记（content-script 与 main world 共享 DOM，但不共享 window）
    document
      .querySelectorAll('[data-mtop-inspect]')
      .forEach(el => el.removeAttribute('data-mtop-inspect'));
    const matched = findSpmElements(spmStr);
    if (matched.length > 0) {
      matched[0].setAttribute('data-mtop-inspect', '1');
    }
    return matched.length;
  }

  return {
    highlightSpmOnPage,
    inspectSpmInPage,
    clearSpmHighlight: clearHotzoneState,
    toggleAllSpmOverlay: (enabled: boolean) => {
      if (enabled) showAllSpmOverlay();
      else clearAllSpmOverlay();
    },
    clearAllSpmOverlay,
  };
}
