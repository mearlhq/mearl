/** A document-owned switch keeps page styling and translation controls isolated. */
export function createFloatingSwitch(host) {
  const element = document.createElement('div'); element.dataset.mearlTranslationFloating = host.identity.instanceId;
  element.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483000!important;width:40px!important;height:40px!important';
  const shadow = element.attachShadow({ mode: 'closed' }), style = document.createElement('style'), button = document.createElement('button'), spinner = document.createElement('span');
  style.textContent = ':host{color-scheme:light dark}button{all:unset;box-sizing:border-box;display:grid;place-items:center;width:40px;height:40px;border:1px solid light-dark(#d0d7de,#484f58);border-radius:12px;background:light-dark(#fff,#161b22);color:light-dark(#24292f,#e6edf3);box-shadow:0 2px 8px #0001;font:600 17px/1 system-ui;cursor:pointer;touch-action:none;user-select:none}button[aria-pressed="true"]{background:#2563eb;color:#fff;border-color:#2563eb}button:focus-visible{outline:2px solid #2563eb;outline-offset:3px}button:disabled{cursor:wait;opacity:.7}button.is-dragging{cursor:grabbing}.loading{box-sizing:border-box;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .85s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.loading{animation:none}}';
  spinner.className = 'loading'; spinner.setAttribute('aria-hidden', 'true');
  const chinese = navigator.language.startsWith('zh');
  let current = { enabled: false, mode: 'bilingual', pending: false }, position = { x: 1, y: .65 }, drag, suppressClick = false, clickTimer;
  const bounds = () => ({ x: Math.max(0, innerWidth - 72), y: Math.max(0, innerHeight - 72) });
  const place = () => {
    const available = bounds();
    element.style.setProperty('left', `${Math.min(16, Math.max(0, innerWidth - 40)) + position.x * available.x}px`, 'important');
    element.style.setProperty('top', `${Math.min(16, Math.max(0, innerHeight - 40)) + position.y * available.y}px`, 'important');
  };
  const update = patch => {
    current = { ...current, ...patch };
    const active = current.enabled && current.mode !== 'original';
    button.replaceChildren(current.pending ? spinner : document.createTextNode(chinese ? '译' : 'A'));
    button.disabled = current.pending;
    button.setAttribute('aria-busy', String(current.pending)); button.setAttribute('aria-pressed', String(active));
    const label = current.error || (active ? chinese ? '显示原文' : 'Show original' : current.enabled ? chinese ? '显示双语' : 'Show bilingual text' : chinese ? '翻译本页' : 'Translate this page');
    button.title = label; button.setAttribute('aria-label', label);
  };
  const move = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; button.classList.add('is-dragging');
    const available = bounds();
    position = { x: available.x ? Math.max(0, Math.min(1, drag.position.x + dx / available.x)) : 0, y: available.y ? Math.max(0, Math.min(1, drag.position.y + dy / available.y)) : 0 };
    place(); event.preventDefault();
  };
  const end = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const finished = drag; drag = undefined; button.classList.remove('is-dragging');
    if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
    if (finished.moved) {
      suppressClick = true; clearTimeout(clickTimer); clickTimer = setTimeout(() => { suppressClick = false; }, 0);
      if (event.type === 'pointercancel') { position = finished.position; place(); }
      else void host.emit('move', { ...position }).catch(error => update({ error: String(error.message || error) }));
    }
  };
  button.type = 'button';
  element.addEventListener('pointerdown', event => {
    if (current.pending || drag || event.button !== 0 || event.isPrimary === false) return;
    event.stopPropagation(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY, position: { ...position }, moved: false };
    if (event.isTrusted) button.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  });
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (suppressClick || current.pending) return;
    update({ pending: true, error: '' });
    void host.emit('toggle', {}).catch(error => update({ pending: false, error: String(error.message || error) }));
  });
  window.addEventListener('resize', place);
  shadow.append(style, button); update({});
  return {
    configure(saved) {
      if (saved !== undefined) {
        if (!saved || typeof saved !== 'object' || ['x', 'y'].some(key => !Number.isFinite(saved[key]) || saved[key] < 0 || saved[key] > 1)) throw new Error('Invalid floating switch position');
        position = { x: saved.x, y: saved.y };
      }
      place();
      if (!element.isConnected) document.documentElement.append(element);
    },
    update,
    dispose() {
      clearTimeout(clickTimer); window.removeEventListener('resize', place);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      drag = undefined; element.remove();
    },
  };
}
