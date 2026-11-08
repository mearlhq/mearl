globalThis.notesLinks = (() => {
  function find(text) {
    const links = [];
    for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`，。！？；：、【】「」『』“”‘’]+/giu)) {
      let value = match[0].replace(/[.,;:!?]+$/, '');
      const pairs = { ')': '(', ']': '[', '}': '{', '）': '（' };
      while (value) {
        const last = value.at(-1), opening = pairs[last];
        if (opening && value.split(last).length > value.split(opening).length) value = value.slice(0, -1).replace(/[.,;:!?]+$/, '');
        else break;
      }
      if (value.length > 8192) continue;
      try {
        const url = new URL(/^www\./i.test(value) ? `https://${value}` : value);
        if (!url.hostname || url.username || url.password) continue;
        links.push({ start: match.index, end: match.index + value.length, url: url.href });
      } catch { /* Incomplete links remain ordinary editable text. */ }
    }
    return links;
  }

  function measure(textarea) {
    const links = find(textarea.value);
    if (!links.length) return [];
    const document = textarea.ownerDocument, bounds = textarea.getBoundingClientRect();
    const left = bounds.left + textarea.clientLeft, top = bounds.top + textarea.clientTop;
    const computed = document.defaultView.getComputedStyle(textarea), mirror = document.createElement('div');
    // Mirror text layout so wrapped links and scrolled notes use the clicked glyph, not a stale caret.
    for (const property of [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
      'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'lineHeight',
      'letterSpacing', 'wordSpacing', 'textAlign', 'textIndent', 'textTransform',
      'tabSize', 'direction', 'wordBreak', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    ]) mirror.style[property] = computed[property];
    Object.assign(mirror.style, {
      position: 'fixed', left: `${left}px`, top: `${top}px`, width: `${textarea.clientWidth}px`, height: `${textarea.clientHeight}px`,
      boxSizing: 'border-box', margin: '0', border: '0', overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none',
      whiteSpace: textarea.wrap === 'off' ? 'pre' : 'pre-wrap',
    });
    mirror.setAttribute('aria-hidden', 'true');
    const text = document.createTextNode(textarea.value + '\u200b');
    mirror.appendChild(text);
    document.body.appendChild(mirror);
    try {
      mirror.scrollTop = textarea.scrollTop; mirror.scrollLeft = textarea.scrollLeft;
      const range = document.createRange(), rectangles = [];
      for (const link of links) {
        range.setStart(text, link.start); range.setEnd(text, link.end);
        for (const rect of range.getClientRects()) {
          const clipped = { left: Math.max(left, rect.left), top: Math.max(top, rect.top), right: Math.min(left + textarea.clientWidth, rect.right), bottom: Math.min(top + textarea.clientHeight, rect.bottom) };
          if (clipped.right > clipped.left && clipped.bottom > clipped.top) rectangles.push({ ...clipped, url: link.url, start: link.start });
        }
      }
      return rectangles;
    } finally { mirror.remove(); }
  }
  const hit = (rectangles, x, y) => rectangles.find(rect => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
  function atPoint(textarea, x, y) {
    const bounds = textarea.getBoundingClientRect(), left = bounds.left + textarea.clientLeft, top = bounds.top + textarea.clientTop;
    if (x < left || y < top || x >= left + textarea.clientWidth || y >= top + textarea.clientHeight) return null;
    return hit(measure(textarea), x, y)?.url || null;
  }

  function decorate(textarea, overlay) {
    const document = textarea.ownerDocument, view = document.defaultView;
    let active = false, disposed = false, dirty = true, frame = null, pointer = null, rectangles = [], hovered = undefined;
    const modified = event => !event.altKey && (event.metaKey || event.ctrlKey || (event.type === 'keydown' && ['Meta', 'Control'].includes(event.key)));
    const hover = () => {
      const current = active && pointer ? hit(rectangles, pointer.x, pointer.y) : null;
      textarea.classList.toggle('is-link-hover', Boolean(current));
      const start = current?.start ?? null;
      if (hovered === start) return;
      hovered = start;
      for (const mark of overlay.children) mark.classList.toggle('is-hovered', Boolean(current && Number(mark.dataset.start) === current.start));
    };
    const reset = () => {
      active = false; rectangles = []; hovered = undefined; dirty = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null; overlay.replaceChildren(); textarea.classList.remove('is-link-hover');
    };
    const render = () => {
      frame = null;
      if (disposed || !active) return;
      rectangles = measure(textarea); dirty = false;
      const bounds = overlay.getBoundingClientRect();
      const marks = rectangles.map(rect => {
        const mark = document.createElement('span');
        mark.className = 'note-link-mark'; mark.dataset.start = String(rect.start);
        Object.assign(mark.style, { left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
        return mark;
      });
      overlay.replaceChildren(...marks); hovered = undefined; hover();
    };
    const refresh = () => {
      dirty = true;
      if (!disposed && active && frame === null) frame = view.requestAnimationFrame(render);
    };
    const mode = event => {
      const next = Boolean(modified(event));
      if (next === active) return;
      active = next;
      if (active) refresh(); else reset();
    };
    const move = event => {
      pointer = { x: event.clientX, y: event.clientY }; mode(event);
      if (active && !dirty) hover();
    };
    const leave = () => { pointer = null; hover(); };
    const hidden = () => { if (document.visibilityState === 'hidden') reset(); };
    textarea.addEventListener('pointermove', move); textarea.addEventListener('pointerenter', move); textarea.addEventListener('pointerleave', leave);
    textarea.addEventListener('input', refresh);
    view.addEventListener('keydown', mode); view.addEventListener('keyup', mode); view.addEventListener('blur', reset);
    view.addEventListener('resize', refresh); view.addEventListener('scroll', refresh, true);
    document.addEventListener('visibilitychange', hidden);
    const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(refresh) : null;
    resize?.observe(textarea);
    return {
      refresh,
      dispose() {
        disposed = true; reset(); resize?.disconnect();
        textarea.removeEventListener('pointermove', move); textarea.removeEventListener('pointerenter', move); textarea.removeEventListener('pointerleave', leave);
        textarea.removeEventListener('input', refresh);
        view.removeEventListener('keydown', mode); view.removeEventListener('keyup', mode); view.removeEventListener('blur', reset);
        view.removeEventListener('resize', refresh); view.removeEventListener('scroll', refresh, true);
        document.removeEventListener('visibilitychange', hidden);
      },
    };
  }
  return { find, atPoint, decorate };
})();
