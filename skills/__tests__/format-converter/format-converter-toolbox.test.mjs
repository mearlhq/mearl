// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(join(process.cwd(), 'package.json'));
const preact = require('preact'), hooks = require('preact/hooks'), htm = require('htm');
const assets = join(process.cwd(), 'skills/format-converter/assets/toolbox');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const missingDragProperties = ['ondrop', 'ondragover', 'ondragleave'].filter(name => !(name in HTMLElement.prototype));
afterEach(() => {
  preact.render(null, document.getElementById('app')); document.body.innerHTML = '';
  delete window.mearl; delete window.formatIcons; delete window.mearlFormatCodec; delete globalThis.mearlFormatCodec;
  for (const name of missingDragProperties) delete HTMLElement.prototype[name];
  vi.restoreAllMocks();
});
const input = (label, value) => {
  const field = document.querySelector(`textarea[aria-label="${label}"]`);
  field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
};
const value = label => document.querySelector(`textarea[aria-label="${label}"]`)?.value;
async function mount() {
  // Preact detects native event names from element properties omitted by happy-dom.
  for (const name of missingDragProperties) Object.defineProperty(HTMLElement.prototype, name, { value: null, configurable: true });
  document.body.innerHTML = '<div id="app"></div>';
  let onContextChange;
  const invoke = vi.fn(async command => command === 'host.clipboard.read' ? { type: 'text', data: '你好' } : null);
  window.mearl = {
    ready: async () => ({ locale: 'zh_CN' }), invoke, ui: { ...preact, ...hooks, html: htm.bind(preact.h) },
    onContextChange(callback) { onContextChange = callback; callback({ locale: 'zh_CN' }); return () => {}; },
  };
  for (const file of ['icons.js', 'codec.js', 'app.js']) {
    const source = await readFile(join(assets, file), 'utf8');
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
    if (file === 'codec.js') window.mearlFormatCodec = globalThis.mearlFormatCodec;
  }
  await vi.waitFor(() => expect(document.querySelectorAll('textarea')).toHaveLength(2));
  await vi.waitFor(() => expect(onContextChange).toBeTypeOf('function'));
  return { invoke, locale: locale => onContextChange({ locale }) };
}

describe('format converter toolbox', () => {
  it('detects encoded input and offers both encodings for plain text without a format selector', async () => {
    const { invoke } = await mount();
    expect(document.querySelector('[aria-pressed]')).toBeNull();
    expect(value('Base64')).toBeUndefined(); expect(value('URL 编码')).toBeUndefined();
    input('输入内容', '你好 🚀');
    await vi.waitFor(() => expect(value('Base64')).toBe('5L2g5aW9IPCfmoA='));
    expect(value('URL 编码')).toBe(encodeURIComponent('你好 🚀'));
    input('Base64', '5L2g5aW9');
    await vi.waitFor(() => expect(value('输入内容')).toBe('你好'));
    expect(value('URL 编码')).toBe('%E4%BD%A0%E5%A5%BD');
    input('输入内容', 'a+b%20c');
    await vi.waitFor(() => expect(value('文本')).toBe('a+b c'));
    input('文本', '你好 +');
    await vi.waitFor(() => expect(value('输入内容')).toBe('%E4%BD%A0%E5%A5%BD%20%2B'));
    expect(invoke.mock.calls.some(([command]) => command === 'convert')).toBe(false);
  });

  it('accepts initial input from the result card and keeps that side editable', async () => {
    await mount(); input('转换结果', '你好');
    await vi.waitFor(() => expect(value('Base64')).toBe('5L2g5aW9'));
    expect(document.querySelector('main').classList.contains('is-reversed')).toBe(true);
    input('输入内容', '你好呀');
    await vi.waitFor(() => expect(value('Base64')).toBe('5L2g5aW95ZGA'));
  });

  it('keeps URL structure through encoding and reverse edits', async () => {
    await mount();
    const url = 'https://docs.example.com/features/encoding';
    input('输入内容', url);
    await vi.waitFor(() => expect(value('URL 编码')).toBe(url));
    input('输入内容', 'https://example.com/你好 世界?q=你好&x=+#片段');
    const encoded = 'https://example.com/%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C?q=%E4%BD%A0%E5%A5%BD&x=+#%E7%89%87%E6%AE%B5';
    await vi.waitFor(() => expect(value('URL 编码')).toBe(encoded));
    input('URL 编码', encoded.replace('x=+', 'x=%26'));
    await vi.waitFor(() => expect(value('输入内容')).toBe('https://example.com/你好 世界?q=你好&x=%26#片段'));
    expect(value('Base64')).toBe(Buffer.from(value('输入内容')).toString('base64'));
  });

  it('detects timestamps and dates and preserves units during partial reverse edits', async () => {
    await mount(); input('输入内容', '1700000000');
    await vi.waitFor(() => expect(value('日期时间')).toBeDefined());
    const zone = document.querySelector('[aria-label="日期时区"]'); zone.value = 'utc'; zone.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(value('日期时间')).toBe('2023-11-14 22:13:20.000'));
    input('日期时间', '2023-11-15 06:');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(value('输入内容')).toBe('');
    input('日期时间', '2023-11-15 06:13:20+08:00');
    await vi.waitFor(() => expect(value('输入内容')).toBe('1700000000'));
    input('输入内容', '2023-11-14T22:13:20.123Z');
    await vi.waitFor(() => expect(value('时间戳 · 秒')).toBe('1700000000.123'));
    expect(value('时间戳 · 毫秒')).toBe('1700000000123');
    input('时间戳 · 秒', '1700000001.001');
    await vi.waitFor(() => expect(value('时间戳 · 毫秒')).toBe('1700000001001'));
    expect(value('输入内容')).toBe('2023-11-14 22:13:21.001');
  });

  it('keeps invalid result editable, clears stale output and recovers', async () => {
    await mount(); input('输入内容', '你好');
    await vi.waitFor(() => expect(value('Base64')).toBe('5L2g5aW9'));
    input('Base64', '??');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]').textContent).toContain('Base64'));
    expect(value('Base64')).toBe('??'); expect(value('输入内容')).toBe(''); expect(value('URL 编码')).toBe('');
    input('Base64', 'aGVsbG8=');
    await vi.waitFor(() => expect(value('输入内容')).toBe('hello'));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    document.querySelector('[aria-label="清空"]').click();
    await vi.waitFor(() => expect(value('输入内容')).toBe('')); expect(value('Base64')).toBeUndefined();
  });

  it('pastes into either card and copies results', async () => {
    const { invoke } = await mount();
    document.querySelector('[aria-label="粘贴 输入内容"]').click();
    await vi.waitFor(() => expect(value('Base64')).toBe('5L2g5aW9'));
    invoke.mockImplementation(async command => command === 'host.clipboard.read' ? { type: 'text', data: 'aGVsbG8=' } : null);
    document.querySelector('[aria-label="粘贴 Base64"]').click();
    await vi.waitFor(() => expect(value('输入内容')).toBe('hello'));
    document.querySelector('[aria-label="复制 URL 编码"]').click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('host.clipboard.writeText', { text: 'hello' }));
  });

  it('automatically previews image Base64 and accepts image clipboard and files', async () => {
    const { invoke } = await mount(); input('输入内容', png);
    await vi.waitFor(() => expect(document.querySelector('img').src).toBe(`data:image/png;base64,${png}`));
    invoke.mockImplementation(async command => command === 'host.clipboard.read' ? { type: 'image', data: `data:image/png;base64,${png}` } : null);
    document.querySelector('[aria-label="粘贴 图片"]').click();
    await vi.waitFor(() => expect(value('输入内容')).toBe(`data:image/png;base64,${png}`));
    document.querySelector('[aria-label="清空"]').click();
    await vi.waitFor(() => expect(document.querySelector('img')).toBeNull());
    const file = document.querySelector('input[type=file]');
    Object.defineProperty(file, 'files', { value: [new File([Buffer.from(png, 'base64')], 'dot.png', { type: 'image/png' })] });
    file.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(value('输入内容')).toBe(`data:image/png;base64,${png}`));
  });

  it('accepts pasted and dropped image files', async () => {
    await mount();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new File([Buffer.from(png, 'base64')], 'dot.png', { type: 'image/png' })] } });
    document.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
    document.querySelector('[aria-label="清空"]').click();
    await vi.waitFor(() => expect(document.querySelector('img')).toBeNull());
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([Buffer.from(png, 'base64')], 'dot.png', { type: 'image/png' })] } });
    document.querySelector('main').dispatchEvent(drop); expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  });

  it('preserves values on locale changes and selects large content for native copy', async () => {
    const { invoke, locale } = await mount(); input('输入内容', '你'.repeat(250001));
    await vi.waitFor(() => expect(value('Base64').length).toBeGreaterThan(1000000));
    document.querySelector('[aria-label="复制 Base64"]').click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('host.toast', expect.objectContaining({ message: expect.stringContaining('Ctrl/Cmd+C') })));
    expect(invoke.mock.calls.some(([command]) => command === 'host.clipboard.writeText')).toBe(false);
    expect(document.querySelector('textarea[aria-label="Base64"]').selectionEnd).toBe(value('Base64').length);
    locale('en');
    await vi.waitFor(() => expect(document.querySelector('textarea[aria-label="Input"]')).not.toBeNull());
    expect(value('Input').length).toBe(250001);
  });
});
