// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(join(process.cwd(), 'package.json'));
const preact = require('preact'), hooks = require('preact/hooks'), htm = require('htm');
const { act } = require('preact/test-utils');
afterEach(() => { preact.render(null, document.getElementById('app')); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(initial = []) {
  document.body.innerHTML = '<div id="app"></div>';
  const jobs = [...initial];
  const toast = vi.fn(), copyImage = vi.fn(async () => {}), start = vi.fn(async () => ({ taskId: 'op' })), operation = vi.fn(async () => ({ state: 'success' }));
  const invoke = vi.fn(async (command, input) => {
    if (command === 'host.toast') return toast(input.message, { type: input.type });
    if (command === 'host.clipboard.read') return { data: 'data:image/png;base64,cG5n' };
    if (command === 'host.clipboard.writeImage') return copyImage(input.data);
    if (command === 'host.task.start') return start(input.command, input.input);
    if (command === 'host.task.get') return operation(input.taskId);
    if (command === 'list') return { jobs: jobs.slice(input.offset, input.offset + input.limit).map(job => ({ ...job })), total: jobs.length,
      nextOffset: input.offset + input.limit < jobs.length ? input.offset + input.limit : null };
    if (command === 'begin') { const job = { ...input, id: 'job', state: 'importing' }; jobs.push(job); return job; }
    if (command === 'append') { const job = jobs.find(job => job.id === input.id); job.state = 'queued'; return job; }
    if (command === 'remove') jobs.splice(jobs.findIndex(job => job.id === input.id), 1);
    return {};
  });
  let notifyContext;
  const unsubscribeContext = vi.fn();
  window.mearl = {
    ready: async () => ({ locale: 'zh_CN' }), invoke,
    waitTask: async id => { const task = await operation(id); if (task.state === 'error') throw new Error(task.error); return task.result; },
    onContextChange: listener => { notifyContext = listener; return unsubscribeContext; },
    ui: { ...preact, ...hooks, html: htm.bind(preact.h) },
  };
  const root = join(process.cwd(), 'skills/tinypng-compress/assets/toolbox/');
  new Function(await readFile(join(root, 'icons.js'), 'utf8'))();
  await act(async () => { await new Function(`return ${await readFile(join(root, 'app.js'), 'utf8')}`)(); });
  await vi.waitFor(() => expect(document.querySelector('input[type=file]')).not.toBeNull());
  await act(async () => { await Promise.resolve(); });
  return { jobs, invoke, toast, copyImage, start, operation, changeContext: next => notifyContext(next), unsubscribeContext };
}
const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label);

describe('image compression toolbox UI', () => {
  it('switches languages in place while retaining images and the open preview', async () => {
    const { invoke, changeContext } = await mount([{ id: 'done', name: 'image.png', size: 100, state: 'done', thumbnail: 'data:image/png;base64,cG5n', output: { size: 50 } }]);
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'resource-chunk'
      ? { chunks: 1, data: 'cG5n', type: 'image/png', name: 'image.png' } : original(command, input));
    await act(async () => document.querySelector('[aria-label="预览图片"]').click());
    const preview = document.querySelector('dialog');
    const listReads = invoke.mock.calls.filter(([command]) => command === 'list').length;
    await act(async () => changeContext({ locale: 'en' }));
    expect(button('Choose images')).toBeDefined();
    expect(document.querySelector('[aria-label="Preview image"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Image preview"]')).toBe(preview);
    expect(document.body.textContent).toContain('Do not upload images containing sensitive information.');
    expect(document.documentElement.lang).toBe('en');
    expect(invoke.mock.calls.filter(([command]) => command === 'list')).toHaveLength(listReads);
    await act(async () => changeContext({ locale: 'zh_CN' }));
    expect(button('选择图片')).toBeDefined();
    expect(document.querySelector('dialog')).toBe(preview);
  });
  it('opens the file picker from the center without changing the empty-state content', async () => {
    await mount();
    const picker = document.querySelector('input[type=file]');
    const click = vi.spyOn(picker, 'click').mockImplementation(() => {});
    const empty = document.querySelector('section button');
    expect(empty.textContent).toContain('拖入图片，自动压缩');
    expect(empty.textContent).toContain('也可选择图片，或按 Ctrl/Cmd+V 粘贴');
    await act(async () => {
      document.querySelector('section').click();
      empty.parentElement.click();
    });
    expect(click).not.toHaveBeenCalled();
    expect(empty.classList.contains('h-full')).toBe(false);
    expect(empty.classList.contains('w-full')).toBe(false);
    await act(async () => empty.click());
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('header').textContent).not.toContain('0');
  });
  it('automatically starts a durable batch after importing pasted bytes', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount();
    await act(async () => button('粘贴').click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('append', { id: 'job', index: 0, data: 'cG5n' }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith('compress-batch', { ids: ['job'] }));
    expect(button('压缩全部')).toBeUndefined();
    expect(operation).toHaveBeenCalledWith('op');
    expect(document.body.textContent).toContain('图片会上传至 TinyPNG');
  });

  it('accepts another image when the list already has 20 items', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount(Array.from({ length: 20 }, (_, id) => ({ id: String(id), name: 'image.png', size: 100, state: 'queued' })));
    await act(async () => button('粘贴').click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('begin', expect.objectContaining({ size: 3 })));
    expect(start).toHaveBeenCalledWith('compress-batch', { ids: ['job'] });
    expect(document.body.textContent).not.toContain('/ 20');
  });

  it('uploads larger image chunks without exceeding the host request limit', async () => {
    const { invoke, start } = await mount();
    const bytes = Buffer.alloc(512 * 1024, 1);
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'host.clipboard.read'
      ? { data: `data:image/png;base64,${bytes.toString('base64')}` } : original(command, input));
    await act(async () => button('粘贴').click());
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith('compress-batch', { ids: ['job'] }));
    const chunks = invoke.mock.calls.filter(([command]) => command === 'append').map(([, input]) => input);
    expect(chunks).toHaveLength(4);
    expect(Buffer.concat(chunks.map(input => Buffer.from(input.data, 'base64')))).toEqual(bytes);
    expect(Buffer.from(chunks[0].data, 'base64')).toHaveLength(144 * 1024);
    for (const input of chunks) expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(256 * 1024);
  });

  it('keeps compressed images ready when a lazy download fails and permits retry', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount([{ id: 'failed', name: 'x.png', size: 100, state: 'done', thumbnail: 'data:image/png;base64,cG5n', output: { size: 50 } }]);
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'resource-chunk' ? Promise.reject(new Error('Network unavailable')) : original(command, input));
    await act(async () => document.querySelector('[aria-label="复制图片"]').click());
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('Network unavailable'), { type: 'error' }));
    expect(document.querySelector('[role=alert]')).toBeNull();
    expect(start).not.toHaveBeenCalled();
    invoke.mockImplementation((command, input) => command === 'resource-chunk'
      ? { chunks: 1, data: 'cG5n', type: 'image/png', name: 'x.png' } : original(command, input));
    await act(async () => document.querySelector('[aria-label="复制图片"]').click());
    await vi.waitFor(() => expect(copyImage).toHaveBeenCalledWith('data:image/png;base64,cG5n'));
  });

  it('uses local originals for missing thumbnails without requesting compressed results', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount([{ id: 'legacy', name: 'image.png', size: 200, state: 'done', output: { size: 50 } }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('resource-chunk', { id: 'legacy', index: 0, source: 'input' }));
    expect(invoke.mock.calls.some(([command, input]) => command === 'resource-chunk' && input.source === 'output')).toBe(false);
  });

  it('copies completed image bytes through the host bridge and reports success', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount([{ id: 'done', name: 'image.png', size: 200, state: 'done', output: { size: 3, width: 10, height: 20 } }]);
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'resource-chunk'
      ? { chunks: 2, readId: 'read-1', data: input.index === 0 ? 'cA==' : 'bmc=', type: 'image/png', name: 'image.png' }
      : original(command, input));
    await act(async () => document.querySelector('[aria-label="复制图片"]').click());
    await vi.waitFor(() => expect(copyImage).toHaveBeenCalledWith('data:image/png;base64,cG5n'));
    expect(toast).toHaveBeenCalledWith('图片已复制', { type: 'success' });
    expect(invoke).toHaveBeenCalledWith('resource-chunk', { id: 'done', index: 1, source: 'output', readId: 'read-1' });
    expect(invoke).toHaveBeenCalledWith('release-resource', { readId: 'read-1' });
  });

  it('releases the current read when a later chunk fails', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount([{ id: 'done', name: 'image.png', size: 200, state: 'done', thumbnail: 'data:image/png;base64,cG5n', output: { size: 3 } }]);
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => {
      if (command !== 'resource-chunk') return original(command, input);
      if (input.index === 0) return { chunks: 2, readId: 'read-1', data: 'cA==', type: 'image/png', name: 'image.png' };
      throw new Error('Chunk unavailable');
    });
    await act(async () => document.querySelector('[aria-label="复制图片"]').click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('release-resource', { readId: 'read-1' }));
    expect(copyImage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('Chunk unavailable'), { type: 'error' }));
  });

  it('reports denied image copies with a toast', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount([{ id: 'done', name: 'image.png', size: 200, state: 'done', output: { size: 3 } }]);
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'resource-chunk'
      ? { chunks: 1, data: 'cG5n', type: 'image/png', name: 'image.png' } : original(command, input));
    copyImage.mockRejectedValueOnce(new Error('permission denied'));
    await act(async () => document.querySelector('[aria-label="复制图片"]').click());
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('permission denied'), { type: 'error' }));
  });

  it('shows stored thumbnails and falls back to the image icon if decoding fails', async () => {
    const { invoke, toast, copyImage, start, operation } = await mount([{ id: 'preview', name: 'image.png', size: 100, state: 'done', thumbnail: 'data:image/png;base64,cG5n', output: { size: 50 } }]);
    const image = document.querySelector('section img');
    expect(image.getAttribute('src')).toBe('data:image/png;base64,cG5n');
    expect(invoke.mock.calls.some(([command]) => command === 'resource-chunk')).toBe(false);
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(document.querySelector('section img')).toBeNull();
    expect(document.querySelector('section svg')).not.toBeNull();
  });

  it('opens a full-size image preview and releases its URL when closed', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { invoke, toast, copyImage, start, operation } = await mount([{ id: 'preview', name: 'image.png', size: 100, type: 'image/png', state: 'done', thumbnail: 'data:image/png;base64,cG5n', output: { size: 50 } }]);
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'resource-chunk'
      ? { chunks: 1, data: 'cG5n', type: 'image/png', name: 'image.png' } : original(command, input));
    await act(async () => document.querySelector('[aria-label="预览图片"]').click());
    await vi.waitFor(() => expect(document.querySelector('dialog img')?.getAttribute('src')).toBe('blob:test-preview'));
    expect(document.querySelector('dialog').open).toBe(true);
    expect(invoke).toHaveBeenCalledWith('resource-chunk', { id: 'preview', index: 0, source: 'output' });
    expect(create).toHaveBeenCalled();
    await act(async () => document.querySelector('[aria-label="关闭预览"]').click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:test-preview');
  });

  it('loads further pages without applying an image-count cap', async () => {
    const jobs = Array.from({ length: 75 }, (_, index) => ({ id: String(index), name: `${index}.png`, size: 100, state: 'queued' }));
    const { invoke, toast, copyImage, start, operation } = await mount(jobs);
    const more = [...document.querySelectorAll('button')].find(element => element.textContent.startsWith('加载更多'));
    expect(more).not.toBeUndefined();
    await act(async () => more.click());
    expect(invoke).toHaveBeenCalledWith('list', { offset: 50, limit: 50 });
    await vi.waitFor(() => expect(document.querySelectorAll('[aria-label="预览图片"]')).toHaveLength(75));
  });

  it('downloads completed images across all pages', async () => {
    const jobs = Array.from({ length: 75 }, (_, index) => ({ id: String(index), name: `${index}.png`, size: 100, state: 'done', thumbnail: 'data:image/png;base64,cG5n', output: { size: 50 } }));
    const { invoke, toast, copyImage, start, operation } = await mount(jobs);
    const original = invoke.getMockImplementation(), ids = [];
    invoke.mockImplementation((command, input) => {
      if (command !== 'resource-chunk') return original(command, input);
      ids.push(input.id); return { chunks: 1, data: 'cG5n', type: 'image/png', name: `${input.id}.png` };
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await act(async () => button('下载全部').click());
    await vi.waitFor(() => expect(new Set(ids).size).toBe(75));
  });
});
