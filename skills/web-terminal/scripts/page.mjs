// Serialized into the target browser document. Keep dependencies explicit.
export function terminalPage(request, runCommand, selectViewport) {
  const { action, selector, paneId, url, data, keys, lines } = request;
  const registry = window[Symbol.for('mearl.terminal.commands')];
  if (action === 'status') {
    const record = registry?.records.get(request.executionId);
    return record?.read?.(request.includeOutput) ?? record?.result
      ?? { status: 'missing', executionId: request.executionId };
  }
  if (url !== undefined && location.href !== url) {
    return { error: '目标 URL 已变化，终端输入未发送' };
  }

  const instances = [window.term, window.terminal, ...Object.values(window.mearlTerminals ?? {})]
    .filter(term => term?.element?.isConnected && typeof term.buffer?.active?.getLine === 'function');
  const ghosttyRoots = new Set(Array.from(
    document.querySelectorAll('[role="textbox"][contenteditable="true"][aria-label="Terminal input"]'),
  ).filter(root => root.querySelector(':scope > canvas')
    && root.querySelector(':scope > textarea[aria-label="Terminal input"]')));
  const roots = new Set([...document.querySelectorAll('.xterm'), ...ghosttyRoots, ...instances.map(term => term.element)]);
  const paneKey = Symbol.for('mearl.terminal.panes');
  const paneIds = window[paneKey] ??= new WeakMap();
  const findRows = root => [root.querySelector('.xterm-rows'), root.querySelector('.xterm-accessibility-tree')]
    .find(element => element?.children.length);
  const canSelect = root => Boolean(root.querySelector('.xterm-screen')
    && typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function'
    && !root.classList.contains('enable-mouse-events') && !root.querySelector('.composition-view.active'));
  const panes = [...roots].filter(root => !root.closest('.terminal-sticky-scroll')
    && root.getClientRects().length && (root.checkVisibility?.({ visibilityProperty: true }) ?? true)).map(root => {
    const term = instances.find(instance => instance.element === root);
    const ghostty = ghosttyRoots.has(root) || typeof term?.getViewportY === 'function';
    const textarea = term?.textarea ?? root.querySelector(ghostty ? ':scope > textarea' : '.xterm-helper-textarea');
    const source = term ? 'buffer' : findRows(root) ? 'viewport' : canSelect(root) ? 'selection' : null;
    const rawInput = typeof term?.input === 'function';
    const canInput = !term?.options?.disableStdin && (rawInput || Boolean(textarea && !textarea.disabled && !textarea.readOnly));
    const nativeExec = typeof term?.parser?.registerOscHandler === 'function' && typeof term.registerMarker === 'function';
    const execMode = canInput && (nativeExec ? 'buffer' : source ? 'screen' : null);
    return { root, term, textarea, source, canInput, execMode, ghostty, rawInput };
  });

  if (action === 'list') {
    return { url: location.href, panes: panes.map(({ root, source, textarea, canInput, execMode, ghostty }) => {
      if (!paneIds.has(root)) {
        const bytes = crypto.getRandomValues(new Uint8Array(12));
        paneIds.set(root, Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''));
      }
      const containerId = root.closest('[id]')?.id ?? null;
      const candidate = containerId && '#' + CSS.escape(containerId);
      const selector = candidate && panes.filter(pane => pane.root.closest(candidate)).length === 1 ? candidate : null;
      return {
        containerId, selector, source, paneId: paneIds.get(root), engine: ghostty ? 'ghostty-web' : 'xterm.js',
        focused: root.ownerDocument.activeElement === root || Boolean(textarea && root.ownerDocument.activeElement === textarea),
        input: canInput, exec: Boolean(execMode), execMode: execMode || null,
      };
    }) };
  }

  const matching = paneId ? panes.filter(pane => paneIds.get(pane.root) === paneId)
    : selector ? panes.filter(pane => pane.root.closest(selector)) : panes;
  if (!matching.length) return { error: paneId ? '当前面板已隐藏或已重建，请重新 list' : '当前文档中没有匹配的可见 Web 终端' };
  if (matching.length !== 1) return { error: '发现多个终端，请用 paneId 或 selector 指定终端' };
  const { root, term, textarea, canInput, execMode, ghostty, rawInput } = matching[0];
  const identity = term ?? root;

  function readText(limit, viewport = false) {
    const buffer = term?.buffer.active;
    if (!buffer) {
      const screen = findRows(root);
      const selected = !screen && canSelect(root) ? selectViewport(root) : null;
      if (selected?.error) return selected;
      if (!screen && !selected) return { error: '当前渲染器未提供可读文本，请用 screen 核对视口' };
      const rows = screen ? Array.from(screen.children, row => row.textContent.replaceAll('\u00a0', ' '))
        : selected.text.replaceAll('\r\n', '\n').split('\n');
      while (rows.length && rows.at(-1).trimEnd() === '') rows.pop();
      return {
        url: location.href, source: screen ? 'viewport' : 'selection', buffer: null,
        lineCount: Math.min(limit, rows.length), truncated: rows.length > limit, text: rows.slice(-limit).join('\n'),
      };
    }

    // Keep content drawn below the cursor and discard unused trailing viewport rows.
    // Ghostty reports its scroll offset from the bottom, while xterm uses an absolute buffer row.
    const base = ghostty ? Math.max(0, buffer.length - term.rows) : buffer.baseY;
    let first = 0;
    if (viewport) {
      first = ghostty ? Math.max(0, base - Math.floor(term.getViewportY?.() ?? 0)) : buffer.viewportY;
    }
    let end = viewport ? Math.min(buffer.length, first + term.rows) : buffer.length;
    const cursorLine = base + buffer.cursorY;
    const minimumEnd = cursorLine >= first && cursorLine < end ? cursorLine + 1 : first;
    while (end > minimumEnd && !buffer.getLine(end - 1)?.translateToString(true)) end--;
    const start = Math.max(first, end - limit);
    let text = '';
    for (let index = start; index < end; index++) {
      const wrapped = index + 1 < end && buffer.getLine(index + 1)?.isWrapped;
      text += buffer.getLine(index)?.translateToString(!wrapped) ?? '';
      if (!wrapped && index + 1 < end) text += '\n';
    }
    return { url: location.href, source: 'buffer', buffer: buffer.type, lineCount: end - start, truncated: start > first, text };
  }

  function sendText(data) {
    if (rawInput) {
      term.input(data, true);
      return;
    }
    const text = data.endsWith('\r') ? data.slice(0, -1) : data;
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text) || (text !== data && /[\n\t]/.test(text))) {
      return '当前终端支持粘贴文本和独立按键，请使用 terminal key 发送控制键';
    }
    if (text) {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }
    if (text !== data) {
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
      }));
    }
  }

  if (action === 'read') return readText(lines, request.view === 'viewport');
  if (!canInput) return { error: '当前终端不接受输入' };
  if (action === 'exec') {
    if (!execMode) return { error: '当前终端缺少可读的文本，无法确认命令结果' };
    if (request.capture === 'buffer' && execMode !== 'buffer') {
      return { error: '当前终端没有可用的缓冲区命令解析接口' };
    }
    if (term?.buffer.active.type === 'alternate') return { error: '请先从备用屏幕返回 shell 提示符' };
    return runCommand(request, {
      identity, term, execMode: request.capture === 'screen' ? 'screen' : execMode, readText, sendText,
    });
  }

  registry?.active.get(identity)?.read?.(false);
  const pending = registry?.active.get(identity);
  const interrupt = keys?.length === 1 && keys[0].name === 'Ctrl+C';
  if (pending && !interrupt) return { error: '终端有正在执行的命令，使用 status 查看或用 Ctrl+C 中断' };
  if (keys) {
    if (ghostty && !rawInput && keys.some(key => key.name === 'Ctrl+V')) {
      return { error: '当前 Ghostty Web 面板将 Ctrl+V 留给浏览器粘贴，请用 terminal send 输入文本' };
    }
    for (const key of keys) {
      if (rawInput && (!ghostty || !textarea || key.name === 'Ctrl+V')) {
        const sequence = key.application && term.modes?.applicationCursorKeysMode ? key.application : key.data;
        term.input(sequence, true);
      } else {
        const options = {
          key: key.browserKey, code: key.physicalCode, keyCode: key.code, ctrlKey: key.ctrl, shiftKey: key.shift,
          bubbles: true, cancelable: true,
        };
        const keyDownAllowed = textarea.dispatchEvent(new KeyboardEvent('keydown', options));
        if (key.charCode && keyDownAllowed) {
          textarea.dispatchEvent(new KeyboardEvent('keypress', { ...options, charCode: key.charCode }));
        }
      }
    }
    pending?.interrupt?.();
  } else {
    const error = sendText(data);
    if (error) return { error };
  }
  return { dispatched: true, ...(pending && { executionId: pending.result.executionId }) };
}
