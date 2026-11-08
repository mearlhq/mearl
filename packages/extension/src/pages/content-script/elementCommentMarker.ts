const MARKER_ATTRIBUTE = 'data-mearl-element-comment-marker';
const VIEWPORT_MARGIN = 4;

export interface ElementCommentMarker {
  destroy: () => void;
}

interface ElementCommentMarkerOptions {
  id: string;
  target: Element;
  label: string;
  onEdit: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function isElementCommentMarker(element: Element): boolean {
  return Boolean(element.closest(`[${MARKER_ATTRIBUTE}]`));
}

export function showElementCommentMarker({
  id,
  target,
  label,
  onEdit,
}: ElementCommentMarkerOptions): ElementCommentMarker {
  const host = document.createElement('span');
  host.setAttribute(MARKER_ATTRIBUTE, id);
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'z-index: 2147483647',
    'width: 22px',
    'height: 22px',
    'pointer-events: auto',
  ].join(';');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    button {
      display: grid;
      width: 22px;
      height: 22px;
      place-items: center;
      border: 2px solid #ffffff;
      border-radius: 50%;
      padding: 0;
      background: #2563eb;
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
      cursor: pointer;
      outline: 0;
      transform: scale(1);
      transition: transform 120ms ease, background 120ms ease;
    }
    button:hover, button:focus-visible { background: #1d4ed8; transform: scale(1.08); }
    svg {
      width: 11px;
      height: 11px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 2;
    }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.title = label;
  edit.setAttribute('aria-label', label);
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z');
  icon.append(path);
  edit.append(icon);
  shadow.append(style, edit);
  document.documentElement.append(host);

  let destroyed = false;
  let positionFrame = 0;

  const position = () => {
    positionFrame = 0;
    if (destroyed) return;
    if (!target.isConnected) {
      host.style.display = 'none';
      return;
    }
    const rect = target.getBoundingClientRect();
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'block';
    host.style.left = `${clamp(rect.right - 11, VIEWPORT_MARGIN, window.innerWidth - 26)}px`;
    host.style.top = `${clamp(rect.top - 11, VIEWPORT_MARGIN, window.innerHeight - 26)}px`;
  };

  const reposition = () => {
    if (destroyed || positionFrame) return;
    positionFrame = requestAnimationFrame(position);
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (positionFrame) cancelAnimationFrame(positionFrame);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('orientationchange', reposition);
    window.removeEventListener('scroll', reposition, true);
    resizeObserver?.disconnect();
    host.remove();
  };

  edit.addEventListener('pointerdown', event => event.stopPropagation());
  edit.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onEdit();
  });
  window.addEventListener('resize', reposition);
  window.addEventListener('orientationchange', reposition);
  window.addEventListener('scroll', reposition, true);
  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null;
  resizeObserver?.observe(target);
  position();

  return { destroy };
}
