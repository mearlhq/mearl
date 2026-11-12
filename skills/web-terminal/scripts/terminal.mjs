import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { terminalPage } from './page.mjs';
import { executeInTerminal } from './execution.mjs';
import { selectViewport } from './selection.mjs';
import { wrapScript } from './shell.mjs';

const expression = '(request) => (' + terminalPage.toString() + ')(request, '
  + executeInTerminal.toString() + ', ' + selectViewport.toString() + ')';
const keys = {
  Enter: [13, '\r'], Escape: [27, '\x1b'], Backspace: [8, '\x7f'], Tab: [9, '\t'],
  ArrowUp: [38, '\x1b[A', '\x1bOA'], ArrowDown: [40, '\x1b[B', '\x1bOB'],
  ArrowRight: [39, '\x1b[C', '\x1bOC'], ArrowLeft: [37, '\x1b[D', '\x1bOD'],
  Home: [36, '\x1b[H', '\x1bOH'], End: [35, '\x1b[F', '\x1bOF'],
  PageUp: [33, '\x1b[5~'], PageDown: [34, '\x1b[6~'], Delete: [46, '\x1b[3~'],
  F1: [112, '\x1bOP'], F2: [113, '\x1bOQ'], F3: [114, '\x1bOR'], F4: [115, '\x1bOS'],
  F5: [116, '\x1b[15~'], F6: [117, '\x1b[17~'], F7: [118, '\x1b[18~'], F8: [119, '\x1b[19~'],
  F9: [120, '\x1b[20~'], F10: [121, '\x1b[21~'], F11: [122, '\x1b[23~'], F12: [123, '\x1b[24~'],
};

function keyDetails(name) {
  if (Object.hasOwn(keys, name)) {
    const [code, data, application] = keys[name];
    return { name, browserKey: name, physicalCode: name, code, data, application };
  }
  if (name === 'Shift+Tab') return { name, browserKey: 'Tab', physicalCode: 'Tab', code: 9, shift: true, data: '\x1b[Z' };
  if (typeof name === 'string' && /^Ctrl\+[A-Z]$/.test(name)) {
    const code = name.charCodeAt(5);
    return { name, browserKey: name.at(-1).toLowerCase(), physicalCode: 'Key' + name.at(-1), code, ctrl: true, data: String.fromCharCode(code - 64) };
  }
  if (typeof name === 'string' && /^[\x20-\x7e]$/.test(name)) {
    return { name, browserKey: name, code: 0, charCode: name.charCodeAt(0), data: name };
  }
  throw new Error('key 支持单个 ASCII 字符、Enter、Escape、方向键、Home、End、PageUp、PageDown、Tab、Shift+Tab、Backspace、Delete、F1 到 F12 和 Ctrl+A 到 Ctrl+Z');
}

function integer(value, min, max, name) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(name + ' 必须是 ' + min + ' 到 ' + max + ' 之间的整数');
  }
  return number;
}

function targetUrl(url) {
  const target = typeof url === 'string' && URL.canParse(url) ? new URL(url) : null;
  if (!target || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('url 必须是 list 或 read 返回的 HTTP(S) 终端地址');
  }
  return target.href;
}

async function invokeTerminal(context, input, action, args = {}) {
  const { tabId, frameId, selector, paneId } = input;
  if (frameId !== undefined && (typeof frameId !== 'string' || !frameId.trim())) {
    throw new Error('frameId 必须是 page_frames 返回的 ID');
  }
  if (selector !== undefined && (typeof selector !== 'string' || !selector.trim())) {
    throw new Error('selector 必须是终端或其容器的 CSS 选择器');
  }
  if (paneId !== undefined && (typeof paneId !== 'string' || !/^[a-f0-9]{24}$/.test(paneId))) {
    throw new Error('paneId 必须是 list 或 discover 返回的 ID');
  }
  if (paneId !== undefined && selector !== undefined) throw new Error('paneId 和 selector 二选一');
  const params = {
    tabId: integer(tabId, 1, Number.MAX_SAFE_INTEGER, 'tabId'),
    frameId,
    executionWorld: 'main',
    expression,
    args: [{ action, selector, paneId, ...args }],
  };
  let result;
  try {
    ({ result } = await context.invoke('page_eval', params));
  } catch (error) {
    if (action !== 'exec' || error.requestDispatched === false) throw error;
    result = { status: 'dispatch-uncertain', executionId: args.executionId, errorMessage: error.message };
  }
  if (!result) throw new Error('页面未返回终端结果');
  if (result.error) throw new Error(result.error);
  return { tabId: Number(tabId), ...result };
}

function outcome(result) {
  return { ...result, success: result.status === 'running' || (result.status === 'completed' && result.exitCode === 0) };
}

function executionId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) {
    throw new Error('executionId 必须是 exec 返回的 ID');
  }
  return value;
}

async function waitExecution(input, context, result, waitMs, reportOutput) {
  if (waitMs === 0) return outcome(result);
  const deadline = Date.now() + waitMs;
  while (result.status === 'running') {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...result, status: 'timeout', success: false };
    await delay(Math.min(remaining, result.capture === 'screen' ? 500 : 300), undefined, { signal: context.signal });
    try {
      result = await invokeTerminal(context, input, 'status', {
        executionId: result.executionId, includeOutput: Boolean(reportOutput),
      });
    } catch (error) {
      return { ...result, status: 'observation-failed', success: false, errorMessage: error.message };
    }
    reportOutput?.(result);
  }
  return outcome(result);
}

async function exec(input, context) {
  const { script, shell = 'posix', capture = 'auto', waitMs = 10000, lines = 200 } = input;
  if (!['auto', 'buffer', 'screen'].includes(capture)) throw new Error('capture 支持 auto、buffer 或 screen');
  const id = randomUUID();
  const wait = integer(waitMs, 0, 120000, 'waitMs');
  const result = await invokeTerminal(context, input, 'exec', {
    url: targetUrl(input.url), executionId: id, capture, commandLines: wrapScript(script, id, shell),
    lines: integer(lines, 1, 2000, 'lines'),
  });
  return waitExecution(input, context, result, wait);
}

async function follow(input, context) {
  const id = executionId(input.executionId);
  const wait = integer(input.waitMs ?? 10000, 0, 120000, 'waitMs');
  let previous = '';
  function report(result) {
    const { text } = result;
    if (typeof text !== 'string' || text === previous) return;
    const append = text.startsWith(previous);
    const chunk = append ? text.slice(previous.length) : text;
    previous = text;
    if (chunk || !append) context.progress({
      message: append ? chunk : '[终端输出已重绘]\n' + chunk,
      data: { executionId: id, mode: append ? 'append' : 'replace', text: chunk },
    });
  }

  const result = await invokeTerminal(context, input, 'status', { executionId: id, includeOutput: true });
  report(result);
  return waitExecution(input, context, result, wait, report);
}

async function discover(input, context) {
  if (input.frameId !== undefined) throw new Error('discover 扫描整个标签页，请用 list 指定 frameId');
  const tabId = integer(input.tabId, 1, Number.MAX_SAFE_INTEGER, 'tabId');
  const { frames } = await context.invoke('page_frames', { tabId });
  const terminals = [];
  const unavailable = [];
  for (const frame of frames) {
    context.signal?.throwIfAborted();
    if (!frame.isMainFrame && !/^https?:/.test(frame.url)) continue;
    const { frameId } = frame;
    try {
      const { panes, url } = await invokeTerminal(context, { tabId, frameId }, 'list');
      if (panes.length) terminals.push({ frameId, url, panes });
    } catch (error) {
      unavailable.push({ frameId, url: frame.url, error: error.message });
    }
  }
  return { tabId, terminals, unavailable };
}

async function waitForText(input, context) {
  if (typeof input.text !== 'string' || !input.text.length || input.text.length > 4096) {
    throw new Error('text 必须是长度为 1 到 4096 的字符串');
  }
  const waitMs = integer(input.waitMs ?? 10000, 0, 120000, 'waitMs');
  const deadline = Date.now() + waitMs;
  while (true) {
    const result = await invokeTerminal(context, input, 'read', { lines: 200, view: 'viewport' });
    if (result.text.includes(input.text)) return { ...result, status: 'matched', success: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...result, status: 'timeout', success: false };
    await delay(Math.min(remaining, 500), undefined, { signal: context.signal });
  }
}

export function registerCommands(app) {
  function command(signature, fields, description, handler) {
    app.command(signature, (input, context) => {
      const unknown = Object.keys(input).filter(field => !['tabId', 'frameId', ...fields].includes(field));
      if (unknown.length) throw new Error('不支持的参数 ' + unknown.join(', '));
      return handler(input, context);
    }, description);
  }

  command('list <tabId>', [], '查看终端面板及读写、执行能力', (input, context) =>
    invokeTerminal(context, input, 'list'));
  command('discover <tabId>', [], '查找标签页及其 iframe 里的终端', discover);
  command('read <tabId> [lines]', ['selector', 'paneId', 'lines', 'view'], '读取缓冲区或当前视口的文本', (input, context) => {
    const { view = 'tail' } = input;
    if (!['tail', 'viewport'].includes(view)) throw new Error('view 支持 tail 或 viewport');
    return invokeTerminal(context, input, 'read', { lines: integer(input.lines ?? 40, 1, 200, 'lines'), view });
  });
  command('wait <tabId> <text>', ['selector', 'paneId', 'text', 'waitMs'], '等待当前视口出现指定的文本', waitForText);
  command('screen <tabId> <path>', ['selector', 'path'], '保存终端页面或指定元素的 PNG 截图', async (input, context) => {
    if (input.frameId !== undefined) throw new Error('screen 使用标签页视口，请用顶层 iframe 的 CSS 选择器裁切');
    if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('path 必须是 PNG 文件路径');
    const tabId = integer(input.tabId, 1, Number.MAX_SAFE_INTEGER, 'tabId');
    const path = resolve(input.path);
    const { data, meta } = await context.invoke('page_screenshot', { tabId, selector: input.selector, format: 'png' });
    if (meta?.format !== 'png' || typeof data !== 'string') throw new Error('页面未返回 PNG 截图');
    await writeFile(path, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 });
    return { tabId, path };
  });
  command('send <tabId> <url> <data>', ['selector', 'paneId', 'url', 'data'], '发送文本或原始终端输入', (input, context) => {
    const { data } = input;
    if (typeof data !== 'string' || !data || data.length > 4096) {
      throw new Error('data 必须是长度为 1 到 4096 的字符串');
    }
    return invokeTerminal(context, input, 'send', { url: targetUrl(input.url), data });
  });
  command('key <tabId> <url> <key> [keys...]', ['selector', 'paneId', 'url', 'key', 'keys'], '发送普通字符或控制键序列', (input, context) => {
    const { keys = [] } = input;
    if (!Array.isArray(keys) || keys.length > 31) throw new Error('单次最多发送 32 个按键');
    return invokeTerminal(context, input, 'key', { url: targetUrl(input.url), keys: [input.key, ...keys].map(keyDetails) });
  });
  command('exec <tabId> <url> <script>', ['selector', 'paneId', 'url', 'script', 'shell', 'capture', 'waitMs', 'lines'], '运行 shell 脚本并读取退出码', exec);
  command('status <tabId> <executionId>', ['executionId'], '查询命令的状态、当前输出或结果', async (input, context) =>
    outcome(await invokeTerminal(context, input, 'status', {
      executionId: executionId(input.executionId), includeOutput: true,
    })));
  command('follow <tabId> <executionId>', ['executionId', 'waitMs'], '持续输出命令的新结果，完成后返回退出码', follow);
}
