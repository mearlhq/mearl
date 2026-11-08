export const AGENT_SIDE_PANEL_TOGGLE_ATTRIBUTE = 'data-mearl-side-panel-toggle';
// Classic content scripts are emitted as self-contained files, so their message contract lives
// with this entry instead of importing a module shared with extension pages.
export const GET_AGENT_SIDE_PANEL_STATE_ACTION = 'getAgentSidePanelState';
export const OPEN_AGENT_SIDE_PANEL_FROM_PAGE_ACTION = 'openAgentSidePanelFromPage';
export const AGENT_SIDE_PANEL_STATE_CHANGED_ACTION = 'agentSidePanelStateChanged';

export interface AgentSidePanelStateResponse {
  success: boolean;
  open: boolean;
}

interface AgentSidePanelToggle {
  destroy: () => void;
}

interface CreateAgentSidePanelToggleOptions {
  label: string;
  onOpen: () => Promise<void>;
}

export function isAgentSidePanelToggleElement(element: Element): boolean {
  return Boolean(element.closest(`[${AGENT_SIDE_PANEL_TOGGLE_ATTRIBUTE}]`));
}

export function shouldShowAgentFloatingButton(
  agentEnabled: boolean,
  floatingButtonEnabled: boolean,
  sidePanelOpen: boolean | null,
): boolean {
  return agentEnabled && floatingButtonEnabled && sidePanelOpen === false;
}

export function createAgentSidePanelToggle({
  label,
  onOpen,
}: CreateAgentSidePanelToggleOptions): AgentSidePanelToggle {
  const host = document.createElement('div');
  host.setAttribute(AGENT_SIDE_PANEL_TOGGLE_ATTRIBUTE, '');
  host.setAttribute('popover', 'manual');
  host.style.cssText = [
    'all: initial !important',
    'display: var(--mearl-side-panel-toggle-display, block) !important',
    'position: fixed !important',
    'top: 50% !important',
    'right: 0 !important',
    'z-index: 2147483647 !important',
    'width: 12px !important',
    'height: 48px !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'border: 0 !important',
    'border-radius: 0 !important',
    'background: transparent !important',
    'overflow: visible !important',
    'transform: translateY(-50%) !important',
    'pointer-events: auto !important',
    'contain: layout style !important',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      color-scheme: normal;
      --toggle-bg: rgba(168, 168, 168, 0.28);
      --toggle-bg-active: rgba(168, 168, 168, 0.38);
      --toggle-color: rgba(132, 132, 132, 0.92);
      --toggle-color-active: rgba(120, 120, 120, 0.98);
      --toggle-focus-ring: rgba(160, 160, 160, 0.24);
    }
    @media print {
      :host {
        --mearl-side-panel-toggle-display: none !important;
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    button {
      display: grid;
      position: relative;
      width: 12px;
      height: 48px;
      place-items: center;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 8px 0 0 8px;
      background: var(--toggle-bg);
      color: var(--toggle-color);
      cursor: pointer;
      outline: 0;
      animation: fade-in 160ms ease-out both;
      transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
    }
    button::before {
      content: '';
      position: absolute;
      inset: -4px 0 -4px -8px;
    }
    button:hover, button:focus-visible {
      background: var(--toggle-bg-active);
      color: var(--toggle-color-active);
    }
    button:focus-visible {
      box-shadow: 0 0 0 1px var(--toggle-focus-ring);
    }
    button:disabled { cursor: wait; opacity: 0.58; }
    .chevron { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8;
      stroke-linecap: round; stroke-linejoin: round; }
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      button { animation: none; transition: none; }
    }
  `;

  const button = document.createElement('button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.classList.add('chevron');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('aria-hidden', 'true');
  const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevronPath.setAttribute('d', 'm14 7-5 5 5 5');
  chevron.append(chevronPath);

  button.append(chevron);
  shadow.append(style, button);

  let destroyed = false;
  let observedRoot: HTMLElement | null = null;

  const showInTopLayer = () => {
    if (typeof host.showPopover !== 'function') return;

    try {
      if (!host.matches(':popover-open')) host.showPopover();
    } catch {
      // Fixed positioning remains available when the Popover API cannot promote this element.
      host.removeAttribute('popover');
    }
  };

  const attachHost = () => {
    if (destroyed || !document.documentElement) return;

    const root = document.documentElement;
    if (host.parentElement !== root) root.append(host);
    showInTopLayer();
  };

  const rootObserver = new MutationObserver(() => {
    if (!host.isConnected || host.parentElement !== document.documentElement) attachHost();
  });
  const observeCurrentRoot = () => {
    if (destroyed || !document.documentElement) return;

    const root = document.documentElement;
    if (observedRoot !== root) {
      rootObserver.disconnect();
      rootObserver.observe(root, { childList: true });
      observedRoot = root;
    }
    attachHost();
  };

  const documentObserver = new MutationObserver(() => {
    if (observedRoot !== document.documentElement) observeCurrentRoot();
  });

  host.addEventListener('toggle', () => {
    if (destroyed || typeof host.showPopover !== 'function') return;
    if (!host.matches(':popover-open')) queueMicrotask(attachHost);
  });
  documentObserver.observe(document, { childList: true });
  observeCurrentRoot();

  button.addEventListener('pointerdown', event => event.stopPropagation());
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;

    button.disabled = true;
    try {
      await onOpen();
    } finally {
      button.disabled = false;
    }
  });

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      rootObserver.disconnect();
      documentObserver.disconnect();
      host.remove();
    },
  };
}
