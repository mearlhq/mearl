// Read through xterm.js's selection and copy handlers. The DataTransfer is local to this event.
export function selectViewport(root) {
  const screen = root.querySelector('.xterm-screen');
  if (!screen || root.classList.contains('enable-mouse-events') || root.querySelector('.composition-view.active')) {
    return { error: '当前终端正在使用鼠标或输入法，请用 screen 核对视口' };
  }

  const doc = root.ownerDocument;
  const { left, top, right, bottom } = screen.getBoundingClientRect();
  if (right - left < 4 || bottom - top < 4) return { error: '终端视口尚未就绪' };

  function copy() {
    const clipboardData = new DataTransfer();
    const handled = !root.dispatchEvent(new ClipboardEvent('copy', { clipboardData, cancelable: true }));
    return { handled, text: clipboardData.getData('text/plain') };
  }
  function mouse(target, name, x, y) {
    return target.dispatchEvent(new MouseEvent(name, {
      clientX: x, clientY: y, button: 0, buttons: name === 'mouseup' ? 0 : 1,
      detail: 1, cancelable: true,
    }));
  }

  if (copy().handled) return { error: '终端已有选区，请保留该选区并用 screen 核对视口' };
  const previousFocus = doc.activeElement;
  const textarea = root.querySelector('.xterm-helper-textarea');
  const previousValue = textarea?.value;
  const selection = textarea && [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection];
  const x = left + 1;
  const y = top + 1;
  let accepted = false;
  try {
    accepted = !mouse(root, 'mousedown', x, y);
    if (!accepted) return { error: '页面未接受终端选择，请用 screen 核对视口' };
    mouse(doc, 'mousemove', right - 1, bottom - 1);
    mouse(doc, 'mouseup', right - 1, bottom - 1);
    const { handled, text } = copy();
    if (!handled) return { error: '页面未提供终端选区文本，请用 screen 核对视口' };
    return { text };
  } finally {
    if (accepted) {
      mouse(root, 'mousedown', x, y);
      mouse(doc, 'mouseup', x, y);
    }
    if (textarea && textarea.value !== previousValue) {
      textarea.value = previousValue;
      textarea.setSelectionRange(...selection);
    }
    if (doc.activeElement !== previousFocus) {
      if (previousFocus && previousFocus !== doc.body) previousFocus.focus({ preventScroll: true });
      else doc.activeElement?.blur();
    }
  }
}
