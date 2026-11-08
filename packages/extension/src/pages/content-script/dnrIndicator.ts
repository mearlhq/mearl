export type DnrIndicatorMode = 'number' | 'dot' | 'off';

export interface DnrRule {
  label: string;
  count?: number;
  ruleId?: number;
  canDisable?: boolean;
  disableTarget?: 'userAgent' | 'timezone' | 'pageTime';
}

interface CreateDnrIndicatorManagerOptions {
  getIndicatorMode: (callback: (mode: DnrIndicatorMode) => void) => void;
  sendMessage: (message: any) => void;
  getMessage: (name: string, substitutions?: string) => string;
}

interface DnrHostElement extends HTMLElement {
  __outsideTouchAc?: AbortController;
}

export function createDnrIndicatorManager({
  getIndicatorMode,
  sendMessage,
  getMessage,
}: CreateDnrIndicatorManagerOptions) {
  const DNR_POS_KEY = '__mtop_dnr_pos__';
  let dnrHost: DnrHostElement | null = null;
  let dnrIndicatorMode: DnrIndicatorMode = 'dot';
  let currentRules: DnrRule[] = [];

  getIndicatorMode(mode => {
    dnrIndicatorMode = mode;
    updateDnrIndicator(currentRules);
  });

  function loadDnrPos(): { top: number; right: number } | null {
    try {
      const s = localStorage.getItem(DNR_POS_KEY);
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }

  function saveDnrPos(top: number, right: number) {
    try {
      localStorage.setItem(DNR_POS_KEY, JSON.stringify({ top, right }));
    } catch {
      // ignore
    }
  }

  function escHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function removeHost() {
    if (!dnrHost) {
      return;
    }
    dnrHost.__outsideTouchAc?.abort();
    dnrHost.remove();
    dnrHost = null;
  }

  function getOrCreateDnrHost(): DnrHostElement {
    if (dnrHost) return dnrHost;

    const host = document.createElement('div') as DnrHostElement;
    const savedPos = loadDnrPos();
    host.style.cssText = savedPos
      ? `position:fixed;top:${savedPos.top}px;right:${savedPos.right}px;z-index:2147483647;pointer-events:auto;left:auto;`
      : 'position:fixed;top:8px;right:12px;z-index:2147483647;pointer-events:auto;';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .wrap { position: relative; display: inline-block; }
      .wrap::before {
        content: ''; position: absolute;
        top: 100%; left: -12px; right: -12px; height: 8px;
      }
      .dot {
        min-width: 16px; height: 16px; border-radius: 8px;
        background: #f97316; cursor: grab;
        box-shadow: 0 0 0 2px rgba(249,115,22,0.25);
        transition: box-shadow 0.15s;
        display: flex; align-items: center; justify-content: center;
        padding: 0 4px; box-sizing: border-box;
        font: 600 10px/1 -apple-system,'SF Pro Text',sans-serif;
        color: #fff; letter-spacing: 0.02em;
        user-select: none;
      }
      .dot:hover { box-shadow: 0 0 0 4px rgba(249,115,22,0.4); }
      .dot.dragging { cursor: grabbing; box-shadow: 0 0 0 4px rgba(249,115,22,0.4); }
      .dot.dot-only { min-width: 8px; width: 8px; height: 8px; border-radius: 50%; padding: 0; }
      .tooltip {
        display: none; position: absolute; top: calc(100% + 6px); right: 10px;
        background: rgba(15,15,15,0.96); color: #e5e7eb; border-radius: 8px;
        padding: 8px 12px; min-width: 220px; max-width: min(420px, calc(100vw - 20px));
        font: 12px/1.5 -apple-system,'SF Pro Text',sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.07);
        word-break: break-all; z-index: 1;
      }
      .wrap:hover .tooltip, .wrap.open .tooltip { display: block; }
      .title { font-weight:600; font-size:11px; color:#f97316; text-transform:uppercase;
        letter-spacing:0.05em; margin-bottom:6px; }
      .rule-item { display:flex; align-items:center; gap:6px; }
      .rule-item + .rule-item { border-top:1px solid rgba(255,255,255,0.08); margin-top:6px; padding-top:6px; }
      .rule-label { flex:1; min-width:0; color:#fbbf24; font-weight:500;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .url-item { flex-shrink:0; color:#6b7280; font-size:11px; white-space:nowrap; }
      .disable-btn {
        flex-shrink:0; padding:1px 5px; border-radius:4px;
        background:rgba(255,255,255,0.08); color:#9ca3af; font-size:10px;
        border:none; cursor:pointer; line-height:1.4; white-space:nowrap;
      }
      .disable-btn:hover { background:rgba(239,68,68,0.2); color:#f87171; }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const dot = document.createElement('div');
    dot.className = 'dot';
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';

    wrap.appendChild(dot);
    wrap.appendChild(tooltip);
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    const target = document.body ?? document.documentElement;
    target.appendChild(host);
    dnrHost = host;

    tooltip.addEventListener('click', (e: Event) => {
      const btn = (e.target as HTMLElement).closest('[data-disable-target]') as HTMLElement | null;
      if (!btn) return;
      const disableTarget = btn.getAttribute('data-disable-target');
      if (!disableTarget) return;
      const ruleId = Number(btn.getAttribute('data-rule-id'));
      if (disableTarget === 'rule' && !ruleId) return;
      btn.textContent = '...';
      (btn as HTMLButtonElement).disabled = true;
      sendMessage(
        disableTarget === 'rule'
          ? { action: 'disableDnrRule', ruleId }
          : { action: 'disableDnrOverride', override: disableTarget },
      );
    });

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hostStartRight = 0;
    let hostStartTop = 0;

    const startDrag = (startX: number, startY: number) => {
      isDragging = false;
      dragStartX = startX;
      dragStartY = startY;
      const rect = host.getBoundingClientRect();
      hostStartRight = window.innerWidth - rect.right;
      hostStartTop = rect.top;
    };

    const moveDrag = (x: number, y: number) => {
      const dx = Math.abs(x - dragStartX);
      const dy = Math.abs(y - dragStartY);
      if (!isDragging && dx < 4 && dy < 4) return;
      isDragging = true;
      dot.classList.add('dragging');
      const newRight = hostStartRight - (x - dragStartX);
      const newTop = hostStartTop + (y - dragStartY);
      host.style.right = Math.max(0, Math.min(window.innerWidth - 20, newRight)) + 'px';
      host.style.top = Math.max(0, Math.min(window.innerHeight - 20, newTop)) + 'px';
      host.style.left = 'auto';
    };

    const endDrag = () => {
      if (isDragging) {
        const rect = host.getBoundingClientRect();
        saveDnrPos(rect.top, window.innerWidth - rect.right);
      }
      dot.classList.remove('dragging');
    };

    dot.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      startDrag(e.clientX, e.clientY);

      const onMove = (ev: MouseEvent) => moveDrag(ev.clientX, ev.clientY);
      const onUp = () => {
        endDrag();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    dot.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        startDrag(e.touches[0].clientX, e.touches[0].clientY);

        const onMove = (ev: TouchEvent) => {
          if (ev.touches.length !== 1) return;
          moveDrag(ev.touches[0].clientX, ev.touches[0].clientY);
        };
        const onUp = () => {
          const wasDragging = isDragging;
          endDrag();
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onUp);
          if (!wasDragging) {
            wrap.classList.toggle('open');
          }
        };

        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
      },
      { passive: false },
    );

    const outsideTouchAc = new AbortController();
    host.__outsideTouchAc = outsideTouchAc;
    document.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (wrap.classList.contains('open') && !host.contains(e.target as Node)) {
          wrap.classList.remove('open');
        }
      },
      { passive: true, signal: outsideTouchAc.signal },
    );

    dot.addEventListener('click', (e: MouseEvent) => {
      if (isDragging) {
        e.stopPropagation();
        isDragging = false;
      }
    });

    return host;
  }

  function updateDnrIndicator(rules: DnrRule[]) {
    currentRules = rules;
    if (rules.length === 0 || dnrIndicatorMode === 'off') {
      removeHost();
      return;
    }

    const host = getOrCreateDnrHost();
    const dot = host.shadowRoot!.querySelector('.dot')!;
    dot.textContent = dnrIndicatorMode === 'number' ? String(rules.length) : '';
    dot.classList.toggle('dot-only', dnrIndicatorMode === 'dot');

    const tooltip = host.shadowRoot!.querySelector('.tooltip')!;
    const title =
      getMessage('dnrIndicatorTitle', String(rules.length)) || `DNR Rules (${rules.length})`;
    const disableLabel = getMessage('dnrDisableRule') || 'Disable';

    tooltip.innerHTML =
      `<div class="title">${title}</div>` +
      rules
        .map(
          r =>
            `<div class="rule-item">` +
            `<span class="rule-label">${escHtml(r.label)}</span>` +
            (r.count !== undefined
              ? `<span class="url-item">${getMessage('dnrHitCount', String(r.count)) || String(r.count)}</span>`
              : '') +
            (r.canDisable && (r.disableTarget || r.ruleId)
              ? `<button class="disable-btn" data-disable-target="${r.disableTarget ?? 'rule'}"${
                  r.ruleId ? ` data-rule-id="${r.ruleId}"` : ''
                }>${disableLabel}</button>`
              : '') +
            `</div>`,
        )
        .join('');
  }

  return {
    updateDnrIndicator,
    destroy: removeHost,
  };
}
