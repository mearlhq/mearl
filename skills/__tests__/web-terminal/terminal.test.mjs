import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import register from '../../web-terminal/scripts/main.mjs';
import { wrapScript } from '../../web-terminal/scripts/shell.mjs';

const url = 'https://example.com/terminal/';

function makePlugin({ type = 'normal', rows = [], baseY = 0, cursorY = 0, viewportY = baseY, viewportRows = rows.length } = {}) {
  const roots = [];
  const document = {
    querySelectorAll: selector => roots.filter(root => root.isConnected && (selector === '.xterm') !== root.ghostty),
    dispatchEvent: vi.fn(),
  };
  function addPane(id, screen = {}) {
    const textarea = { dispatchEvent: vi.fn() };
    const root = {
      id, ownerDocument: document, isConnected: true, classList: { contains: () => false },
      ghostty: Boolean(screen.ghostty),
      dispatchEvent: vi.fn(),
      getClientRects: () => [1],
      closest: selector => id && ['[id]', '#' + id].includes(selector) ? root : null,
      querySelector: selector => ({
        '.xterm-helper-textarea': textarea,
        '.xterm-rows': screen.rows,
        '.xterm-accessibility-tree': screen.accessibility,
        '.xterm-screen': screen.canvas,
        ':scope > canvas': screen.ghostty ? {} : undefined,
        ':scope > textarea[aria-label="Terminal input"]': screen.ghostty ? textarea : undefined,
        ':scope > textarea': screen.ghostty ? textarea : undefined,
      })[selector],
    };
    roots.push(root);
    return { root, textarea };
  }

  const { root: element } = addPane('first');
  const buffer = {
    type,
    get length() { return rows.length; },
    baseY,
    viewportY,
    cursorY,
    cursorX: 0,
    getLine(index) {
      const { text, isWrapped } = rows[index];
      return {
        isWrapped,
        translateToString(trim, start, end) {
          const result = text.slice(start, end);
          return trim ? result.trimEnd() : result;
        },
      };
    },
  };
  const dispose = vi.fn();
  const registerOscHandler = vi.fn(() => ({ dispose }));
  const term = {
    buffer: { active: buffer }, element, rows: viewportRows, options: {}, input: vi.fn(),
    parser: { registerOscHandler },
    registerMarker: () => ({ line: buffer.baseY + buffer.cursorY, dispose: vi.fn() }),
  };
  class Event {
    constructor(type, options) { Object.assign(this, options, { type }); }
  }
  class DataTransfer {
    setData(_type, data) { this.data = data; }
    getData() { return this.data ?? ''; }
  }
  const browser = createContext({
    document, window: { term }, location: { href: url }, crypto: webcrypto,
    DataTransfer, ClipboardEvent: Event, KeyboardEvent: Event, MouseEvent: Event,
    CSS: { escape: value => value },
    setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
  });
  const commands = new Map();
  const invoke = vi.fn(async (_action, { expression, args }) => ({
    result: runInContext('(' + expression + ')', browser)(...args),
  }));
  const progress = vi.fn();
  register({ command: (signature, handler) => commands.set(signature.split(' ')[0], input => handler(input, { invoke, progress })) });
  return { commands, invoke, term, addPane, buffer, registerOscHandler, dispose, document, progress };
}

describe('terminal plugin', () => {
  it('reads bounded scrollback and merges soft wraps without including unused viewport rows', async () => {
    const { commands, invoke } = makePlugin({ baseY: 2, cursorY: 1, rows: [
      { text: 'old log' }, { text: 'hello ' }, { text: 'world', isWrapped: true }, { text: '$ ' }, { text: ' ' },
    ] });
    await expect(commands.get('read')({ tabId: '42', lines: '3', frameId: '7' })).resolves.toEqual({
      tabId: 42, url, source: 'buffer', buffer: 'normal', lineCount: 3, truncated: true, text: 'hello world\n$',
    });
    expect(invoke).toHaveBeenCalledWith('page_eval', expect.objectContaining({ tabId: 42, frameId: '7' }));
  });

  it('reads the alternate screen including rows drawn below the cursor', async () => {
    const { commands } = makePlugin({ type: 'alternate', rows: [
      { text: 'TUI' }, { text: '' }, { text: 'status bar' }, { text: '' },
    ] });
    await expect(commands.get('read')({ tabId: 42 })).resolves.toMatchObject({
      buffer: 'alternate', text: 'TUI\n\nstatus bar', lineCount: 3, truncated: false,
    });
  });

  it('dispatches literal input on the matching page and rejects stale targets and read-only input', async () => {
    const { commands, term } = makePlugin();
    const send = commands.get('send');
    const data = 'hello\r';
    await expect(send({ tabId: 42, url, data })).resolves.toEqual({ tabId: 42, dispatched: true });
    await expect(send({ tabId: 42, url: url + 'other', data })).rejects.toThrow('目标 URL 已变化');
    term.options.disableStdin = true;
    await expect(send({ tabId: 42, url, data })).rejects.toThrow('当前终端不接受输入');
    expect(term.input).toHaveBeenCalledExactlyOnceWith(data, true);
  });

  it('requires a pane selector and supports text and keys on DOM-rendered terminals', async () => {
    const { commands, addPane, term } = makePlugin();
    const { textarea } = addPane('second', {
      rows: { children: [] },
      accessibility: { children: [{ textContent: 'second pane' }, { textContent: '\u00a0' }] },
    });
    await expect(commands.get('list')({ tabId: 42 })).resolves.toMatchObject({
      panes: [
        { source: 'buffer', exec: true, execMode: 'buffer', selector: '#first' },
        { source: 'viewport', exec: true, execMode: 'screen', selector: '#second' },
      ],
    });
    await expect(commands.get('read')({ tabId: 42 })).rejects.toThrow('发现多个终端');
    const input = { tabId: 42, selector: '#second' };
    await expect(commands.get('read')(input)).resolves.toMatchObject({ source: 'viewport', text: 'second pane' });
    await commands.get('send')({ ...input, url, data: 'printf hello\r' });
    await commands.get('key')({ ...input, url, key: 'ArrowUp' });
    expect(textarea.dispatchEvent.mock.calls.map(([event]) => [event.type, event.clipboardData?.data ?? event.key]))
      .toEqual([['paste', 'printf hello'], ['keydown', 'Enter'], ['keydown', 'ArrowUp']]);
    textarea.dispatchEvent.mockClear().mockReturnValue(true);
    await commands.get('key')({ ...input, url, key: ':', keys: ['q', '!', 'Enter'] });
    expect(textarea.dispatchEvent.mock.calls.filter(([event]) => event.type === 'keypress').map(([event]) => event.key))
      .toEqual([':', 'q', '!']);
    expect(term.input).not.toHaveBeenCalled();
  });

  it('captures output and exit code from matching OSC boundaries, excluding the command echo', async () => {
    const rows = [{ text: '$ wrapped command' }, { text: '' }];
    const { commands, buffer, registerOscHandler, dispose } = makePlugin({ rows, cursorY: 1 });
    const input = { tabId: 42, url, script: 'printf hello\nexit 7', waitMs: 0 };
    const result = await commands.get('exec')(input);
    const handler = registerOscHandler.mock.calls[0][1];
    const id = result.executionId;
    expect(result.status).toBe('running');
    expect(handler('another-id;start')).toBe(false);
    await expect(commands.get('exec')(input)).rejects.toThrow('已有正在执行');
    handler(id + ';7');
    handler(id + ';start');
    rows[1].text = 'hello';
    buffer.cursorX = 5;
    handler(id + ';7');
    await expect(commands.get('status')({ tabId: 42, executionId: id })).resolves.toMatchObject({
      status: 'completed', success: false, exitCode: 7, text: 'hello', truncated: false,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out execution queryable and records a dispatched interrupt', async () => {
    const { commands, term } = makePlugin();
    const result = await commands.get('exec')({ tabId: 42, url, script: 'sleep 10', waitMs: 1 });
    expect(result).toMatchObject({ status: 'timeout', success: false });
    const executionId = result.executionId;
    await expect(commands.get('status')({ tabId: 42, executionId })).resolves.toMatchObject({ status: 'running' });
    await expect(commands.get('key')({ tabId: 42, url, key: 'Ctrl+C' })).resolves.toMatchObject({ executionId });
    expect(term.input).toHaveBeenLastCalledWith('\x03', true);
    await expect(commands.get('status')({ tabId: 42, executionId })).resolves.toMatchObject({ status: 'interrupt-sent' });
  });

  it('keeps the final output line when a command ends with a newline and the line limit is one', async () => {
    const rows = [{ text: '' }, { text: '' }, { text: '' }];
    const { commands, buffer, registerOscHandler } = makePlugin({ rows });
    const { executionId } = await commands.get('exec')({ tabId: 42, url, script: 'printf output', lines: 1, waitMs: 0 });
    const handler = registerOscHandler.mock.calls[0][1];
    handler(executionId + ';start');
    rows[0].text = 'first';
    rows[1].text = 'last';
    buffer.cursorY = 2;
    handler(executionId + ';0');
    await expect(commands.get('status')({ tabId: 42, executionId })).resolves.toMatchObject({
      status: 'completed', exitCode: 0, text: 'last\n', truncated: true,
    });
  });

  it('reads text from WebGL via the terminal copy event and preserves an existing selection', async () => {
    const { commands, addPane, document } = makePlugin();
    const { root } = addPane('webgl', { canvas: {
      getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 480 }),
    } });
    let selected = false;
    root.dispatchEvent.mockImplementation(event => {
      if (event.type === 'mousedown') {
        selected = false;
        return false;
      }
      if (event.type === 'copy' && selected) {
        event.clipboardData.setData('text/plain', 'webgl output\n\n');
        return false;
      }
      return true;
    });
    document.dispatchEvent.mockImplementation(event => { if (event.type === 'mousemove') selected = true; });

    const input = { tabId: 42, selector: '#webgl' };
    await expect(commands.get('read')(input)).resolves.toMatchObject({ source: 'selection', text: 'webgl output' });
    expect(selected).toBe(false);
    selected = true;
    await expect(commands.get('read')(input)).rejects.toThrow('终端已有选区');
    expect(selected).toBe(true);
  });

  it('captures only marked command output and identifies truncated screen results', async () => {
    const { commands, addPane } = makePlugin();
    const children = [{ textContent: 'old prompt' }];
    addPane('dom', { rows: { children } });
    const { executionId } = await commands.get('exec')({
      tabId: 42, selector: '#dom', url, script: 'printf hello', waitMs: 0,
    });
    const { screenMarkers } = wrapScript('printf hello', executionId, 'posix');
    const status = () => commands.get('status')({ tabId: 42, executionId });
    children.push({ textContent: 'echo that looks like output' });
    await expect(status()).resolves.toMatchObject({ status: 'running', capture: 'screen' });
    expect((await status()).text).toBeUndefined();
    children.push({ textContent: screenMarkers.start }, { textContent: 'partial' });
    await expect(status()).resolves.toMatchObject({ status: 'running', text: 'partial' });
    children.splice(0, children.length, { textContent: 'remaining' },
      { textContent: screenMarkers.end + '7]' }, { textContent: 'next prompt' });
    await expect(status()).resolves.toMatchObject({ status: 'completed', exitCode: 7, text: 'remaining', truncated: true });
  });

  it('matches TUI text only in the active viewport', async () => {
    const { commands } = makePlugin({ baseY: 2, viewportRows: 2, rows: [
      { text: 'old prompt' }, { text: 'previous output' }, { text: 'ready now' }, { text: '' },
    ] });
    await expect(commands.get('wait')({ tabId: 42, text: 'old prompt', waitMs: 0 })).resolves.toMatchObject({
      status: 'timeout', text: 'ready now',
    });
    await expect(commands.get('wait')({ tabId: 42, text: 'ready now', waitMs: 0 })).resolves.toMatchObject({ status: 'matched' });
  });

  it('discovers accessible terminal frames and reports unavailable ones', async () => {
    const { commands, invoke } = makePlugin();
    const child = 'https://example.org/terminal/';
    invoke.mockResolvedValueOnce({ frames: [
      { frameId: '1', url, isMainFrame: true },
      { frameId: '2', url: child, isMainFrame: false },
      { frameId: '3', url: 'about:blank', isMainFrame: false },
    ] });
    invoke.mockResolvedValueOnce({ result: { url, panes: [{ source: 'buffer', selector: '#first' }] } });
    invoke.mockRejectedValueOnce(new Error('Domain permission required'));
    await expect(commands.get('discover')({ tabId: 42 })).resolves.toEqual({
      tabId: 42,
      terminals: [{ frameId: '1', url, panes: [{ source: 'buffer', selector: '#first' }] }],
      unavailable: [{ frameId: '2', url: child, error: 'Domain permission required' }],
    });
    expect(invoke.mock.calls.map(([action, params]) => [action, params.frameId])).toEqual([
      ['page_frames', undefined], ['page_eval', '1'], ['page_eval', '2'],
    ]);
  });

  it('reports new output during follow and returns the final result', async () => {
    const { commands, invoke, progress } = makePlugin();
    const executionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    invoke.mockResolvedValueOnce({ result: { executionId, status: 'running', text: 'first' } });
    invoke.mockResolvedValueOnce({ result: { executionId, status: 'completed', exitCode: 0, text: 'first second' } });
    await expect(commands.get('follow')({ tabId: 42, executionId, waitMs: 1000 })).resolves.toMatchObject({
      status: 'completed', exitCode: 0, text: 'first second',
    });
    expect(progress.mock.calls.map(([event]) => event.data)).toEqual([
      { executionId, mode: 'append', text: 'first' },
      { executionId, mode: 'append', text: ' second' },
    ]);
  });

  it('preserves Unicode and normalizes CRLF in the PowerShell script payload', () => {
    const script = "[Console]::WriteLine('输出')\r\nexit 23";
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const { buffer, screen } = wrapScript(script, id, 'powershell');
    for (const command of [buffer, screen]) {
      const [, encoded] = command.match(/-EncodedCommand '([A-Za-z0-9+/=]+)'/);
      expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script.replaceAll('\r\n', '\n'));
      expect(command.endsWith('\r')).toBe(true);
    }
  });

  it('can use visible markers on an exposed terminal when OSC is filtered', async () => {
    const rows = [{ text: 'prompt' }, { text: '' }, { text: '' }];
    const { commands, buffer, registerOscHandler, term } = makePlugin({ rows, viewportRows: 3 });
    const { executionId } = await commands.get('exec')({
      tabId: 42, url, script: 'exit 33', capture: 'screen', waitMs: 0,
    });
    const { screenMarkers } = wrapScript('exit 33', executionId, 'posix');
    rows[0].text = screenMarkers.start;
    rows[1].text = 'visible result';
    rows[2].text = screenMarkers.end + '33]';
    buffer.cursorY = 2;
    expect(registerOscHandler).not.toHaveBeenCalled();
    expect(term.input.mock.lastCall[0]).toContain('[+%s]');
    await expect(commands.get('status')({ tabId: 42, executionId })).resolves.toMatchObject({
      status: 'completed', capture: 'screen', exitCode: 33, text: 'visible result',
    });
  });

  it.each([200, 199])('captures Ghostty command output from scrollback with a %i-line limit', async lines => {
    const rows = [{ text: 'old prompt' }, { text: '' }, { text: '' }];
    const { commands, buffer, term } = makePlugin({ rows, viewportRows: 3 });
    term.getViewportY = () => 10;
    delete term.parser;
    const { executionId, capture } = await commands.get('exec')({
      tabId: 42, url, script: 'exit 19', waitMs: 0, lines,
    });
    expect(capture).toBe('screen');

    const { screenMarkers } = wrapScript('exit 19', executionId, 'posix');
    const output = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
    rows.splice(1, rows.length, ...[screenMarkers.start, ...output, '', screenMarkers.end + '19]', 'prompt'].map(text => ({ text })));
    buffer.cursorY = 2;
    await expect(commands.get('status')({ tabId: 42, executionId })).resolves.toMatchObject({
      status: 'completed', exitCode: 19, text: output.slice(-lines).join('\n') + '\n', truncated: lines < output.length,
    });
  });

  it('targets a visible ID-less pane by its document-scoped pane ID', async () => {
    const { commands, addPane } = makePlugin();
    const { root, textarea } = addPane(null, { rows: { children: [{ textContent: 'other pane' }] } });
    const listed = await commands.get('list')({ tabId: 42 });
    const { paneId, selector } = listed.panes[1];
    expect(selector).toBeNull();
    expect((await commands.get('list')({ tabId: 42 })).panes[1].paneId).toBe(paneId);
    await expect(commands.get('read')({ tabId: 42, paneId })).resolves.toMatchObject({ text: 'other pane' });
    root.checkVisibility = () => false;
    await expect(commands.get('send')({ tabId: 42, paneId, url, data: 'test' })).rejects.toThrow('面板已隐藏或已重建');
    expect(textarea.dispatchEvent).not.toHaveBeenCalled();
  });

  it('excludes the VS Code sticky scroll terminal from pane discovery', async () => {
    const { commands, addPane } = makePlugin();
    const { root } = addPane('sticky');
    root.closest = selector => selector === '.terminal-sticky-scroll' ? {} : null;
    const { panes } = await commands.get('list')({ tabId: 42 });
    expect(panes.map(pane => pane.containerId)).toEqual(['first']);
  });

  it('discovers private Ghostty and sends physical keyboard codes through its textarea', async () => {
    const { commands, addPane, term } = makePlugin();
    const { textarea } = addPane('ghostty', { ghostty: true });
    const { panes } = await commands.get('list')({ tabId: 42 });
    const pane = panes.find(item => item.engine === 'ghostty-web');
    expect(pane).toMatchObject({ source: null, input: true, exec: false });
    const input = { tabId: 42, paneId: pane.paneId, url };
    await expect(commands.get('key')({ ...input, key: 'Enter', keys: ['Ctrl+V'] })).rejects.toThrow('terminal send');
    expect(textarea.dispatchEvent).not.toHaveBeenCalled();
    await commands.get('send')({ ...input, data: 'printf test\r' });
    await commands.get('key')({ ...input, key: 'Ctrl+C' });
    expect(textarea.dispatchEvent.mock.calls.map(([event]) => [event.type, event.code ?? event.clipboardData?.data]))
      .toEqual([['paste', 'printf test'], ['keydown', 'Enter'], ['keydown', 'KeyC']]);
    expect(term.input).not.toHaveBeenCalled();
  });

  it('sends Ctrl+V as terminal input when the Ghostty instance is public', async () => {
    const { commands, term } = makePlugin();
    term.getViewportY = () => 0;
    term.textarea = { dispatchEvent: vi.fn() };
    await expect(commands.get('key')({ tabId: 42, url, key: 'Ctrl+V' })).resolves.toMatchObject({ dispatched: true });
    expect(term.input).toHaveBeenCalledExactlyOnceWith('\x16', true);
    expect(term.textarea.dispatchEvent).not.toHaveBeenCalled();
  });

  it('uses the Ghostty scroll offset to read a scrolled viewport', async () => {
    const { commands, term } = makePlugin({ viewportRows: 2, rows: [
      { text: 'first' }, { text: 'second' }, { text: 'third' }, { text: 'current' }, { text: 'prompt' },
    ], cursorY: 1 });
    term.getViewportY = () => 2.5;
    await expect(commands.get('read')({ tabId: 42, view: 'viewport' })).resolves.toMatchObject({
      source: 'buffer', text: 'second\nthird',
    });
    await expect(commands.get('read')({ tabId: 42, lines: 2 })).resolves.toMatchObject({ text: 'current\nprompt' });
  });
});
