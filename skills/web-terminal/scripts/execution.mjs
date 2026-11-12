// Serialized into the browser alongside terminalPage.
export function executeInTerminal({ executionId, commandLines, lines, url }, pane) {
  const { identity, term: terminal, execMode, readText, sendText } = pane;
  const key = Symbol.for('mearl.terminal.commands');
  const registry = window[key] ??= { records: new Map(), active: new WeakMap() };
  registry.active.get(identity)?.read?.(false);
  if (registry.active.has(identity)) return { error: '终端已有正在执行的命令' };
  const viewportOnly = !terminal;
  if (execMode === 'screen') {
    const initial = readText(1, viewportOnly);
    if (initial.error) return initial;
  }

  if (registry.records.size >= 32) {
    const finished = [...registry.records].find(([, record]) => record.result.status !== 'running');
    if (!finished) return { error: '当前文档正在跟踪的命令太多' };
    registry.records.delete(finished[0]);
  }

  const record = {
    result: { executionId, status: 'running', capture: execMode },
    read: readExecution,
    interrupt: () => finish('interrupt-sent'),
  };
  const prefix = executionId + ';';
  let listener;
  let expiry;
  let marker;
  let startColumn;
  let started = false;
  const { start: startMarker, end: endMarker } = commandLines.screenMarkers;

  function parseExitCode(text) {
    if (!/^-?\d{1,10}$/.test(text)) return undefined;
    const code = Number(text);
    return code >= -2147483648 && code <= 2147483647 ? code : undefined;
  }

  function finish(status, details = {}) {
    listener?.dispose();
    marker?.dispose();
    clearTimeout(expiry);
    registry.active.delete(identity);
    record.result = { executionId, status, capture: execMode, ...details };
    record.interrupt = undefined;
    record.read = function () { return this.result; };
  }

  function collectOutput() {
    const buffer = terminal.buffer.active;
    if (buffer.type !== 'normal' || !marker) return { text: '', truncated: true };
    const endLine = buffer.baseY + buffer.cursorY;
    if (endLine < marker.line) return { text: '', truncated: true };
    const lastContentLine = buffer.cursorX === 0 && endLine > marker.line ? endLine - 1 : endLine;
    const startLine = Math.max(0, marker.line, lastContentLine - lines + 1);
    let truncated = marker.isDisposed || marker.line < startLine;
    let text = '';
    for (let row = startLine; row <= lastContentLine; row++) {
      const wrapped = row < endLine && buffer.getLine(row + 1)?.isWrapped;
      const start = row === marker.line ? startColumn : 0;
      const end = row === endLine ? buffer.cursorX : undefined;
      text += buffer.getLine(row)?.translateToString(!wrapped, start, end) ?? '';
      if (!wrapped && row < endLine) text += '\n';
      if (text.length > 65536) {
        text = text.slice(-65536);
        truncated = true;
      }
    }
    return { text, truncated };
  }

  function readExecution(includeOutput) {
    if (location.href !== url || (terminal?.element ?? identity).isConnected === false) {
      finish('target-changed');
      return record.result;
    }
    if (execMode === 'buffer') {
      return includeOutput && started ? { ...record.result, ...collectOutput() } : record.result;
    }

    // Leave room for the command boundaries and prompt in the scrollback search.
    const margin = Math.min(terminal?.rows ?? 0, 200) + 4;
    const snapshot = readText(Math.max(200, lines + margin), viewportOnly);
    if (snapshot.error) return { ...record.result, observationError: snapshot.error };
    if (snapshot.buffer === 'alternate') return record.result;
    const rows = snapshot.text.split('\n');
    const start = rows.findIndex(row => row.trimEnd() === startMarker);
    if (start !== -1) started = true;
    let exitCode;
    const end = rows.findIndex((row, index) => {
      const line = row.trimEnd();
      if (index <= start || !line.startsWith(endMarker) || !line.endsWith(']')) return false;
      exitCode = parseExitCode(line.slice(endMarker.length, -1));
      return exitCode !== undefined;
    });
    if (end === -1 && (!started || !includeOutput)) return record.result;
    const content = rows.slice(start + 1, end === -1 ? undefined : end);
    const newline = end !== -1 && content.at(-1) === '';
    if (newline) content.pop();
    const text = content.slice(-lines).join('\n') + (newline && content.length ? '\n' : '');
    const details = { text: text.slice(-65536), truncated: start === -1 || content.length > lines || text.length > 65536 };
    if (end === -1) return { ...record.result, ...details };

    finish('completed', { ...details, exitCode });
    return record.result;
  }

  if (execMode === 'buffer') {
    listener = terminal.parser.registerOscHandler(6973, payload => {
      if (!payload.startsWith(prefix)) return false;
      const value = payload.slice(prefix.length);
      if (value === 'start' && !started) {
        started = true;
        startColumn = terminal.buffer.active.cursorX;
        try { marker = terminal.registerMarker(0); } catch { /* Older xterm builds can gate the marker API. */ }
      } else if (started) {
        const exitCode = parseExitCode(value);
        if (exitCode !== undefined) finish('completed', { exitCode, ...collectOutput() });
      }
      return true;
    });
  }

  registry.active.set(identity, record);
  registry.records.set(executionId, record);
  expiry = setTimeout(() => finish('expired'), 600000);
  try {
    const error = sendText(commandLines[execMode]);
    if (error) {
      finish('input-rejected');
      registry.records.delete(executionId);
      return { error };
    }
  } catch (error) {
    finish('dispatch-uncertain', { errorMessage: String(error) });
  }
  return record.result;
}
