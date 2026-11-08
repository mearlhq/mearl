// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { File } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(join(process.cwd(), 'package.json'));
const preact = require('preact'), hooks = require('preact/hooks'), htm = require('htm');
const root = join(process.cwd(), 'skills/notes-memory/assets/toolbox');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const missingDragProperties = ['ondrop', 'ondragover', 'ondragleave'].filter(name => !(name in HTMLElement.prototype));
const listTab = label => [...document.querySelectorAll('[aria-label="笔记列表"] button')].find(button => button.textContent === label);
afterEach(() => {
  preact.render(null, document.getElementById('app'));
  delete window.mearl; delete window.notesIcons; delete window.notesEditor; delete globalThis.notesEditor; delete window.notesImages; delete globalThis.notesImages; delete window.notesLinks; delete globalThis.notesLinks;
  document.body.innerHTML = '';
  for (const name of missingDragProperties) delete HTMLElement.prototype[name];
  vi.restoreAllMocks();
});
async function mount() {
  // Preact detects native event names from browser element properties; happy-dom omits drag handlers.
  for (const name of missingDragProperties) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: null });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:note-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.open = true; });
  document.body.innerHTML = '<div id="app"></div>';
  const initial = { id: 'one', title: '约定', body: '初始正文', tags: [], scope: 'personal', project: null, pinned: false, source: '', images: [], revision: 1, updatedBy: 'user', updatedAt: new Date().toISOString(), deletedAt: null };
  const records = new Map([
    ['one', initial], ['agent-note', { ...initial, id: 'agent-note', title: 'Agent 笔记', body: 'Agent 正文', updatedBy: 'agent' }],
  ]);
  const uploads = new Map();
  const invoke = vi.fn(async (command, input) => {
    if (command === 'tabs') return { tabs: [{ id: 42, title: '可收录页面', url: 'https://example.com/article' }] };
    if (command === 'host.tab.active') return { tabId: 42, title: '当前页面', url: 'https://example.com/article' };
    if (command === 'image-begin') { const uploadId = `image-${uploads.size}`; uploads.set(uploadId, input); return { uploadId }; }
    if (command === 'image-append') {
      const upload = uploads.get(input.uploadId), previous = records.get(upload.id);
      if (previous.revision !== upload.revision) throw new Error('NOTE_CONFLICT');
      const image = { id: input.uploadId, name: upload.name, type: upload.type, size: upload.size };
      const note = { ...previous, images: [...previous.images, image], revision: previous.revision + 1 };
      records.set(note.id, note); return { note: structuredClone(note), complete: true };
    }
    if (command === 'image-chunk') return { type: 'image/png', chunks: 1, data: png.toString('base64') };
    if (command === 'image-remove') {
      const previous = records.get(input.id);
      if (previous.revision !== input.revision) throw new Error('NOTE_CONFLICT');
      const note = { ...previous, images: previous.images.filter(image => image.id !== input.imageId), revision: previous.revision + 1 };
      records.set(note.id, note); return { note: structuredClone(note) };
    }
    if (command === 'page-list') return { notes: [...records.values()].filter(note => Boolean(note.deletedAt) === Boolean(input.trash) && (!input.query || `${note.title}\n${note.body}`.includes(input.query))).map(note => ({ ...note, excerpt: note.body })), nextOffset: null };
    if (command === 'get') return { note: structuredClone(records.get(input.id)) };
    if (command === 'create' || command === 'update') {
      const previous = records.get(input.id), id = input.id || `new-${records.size}`;
      const note = { ...initial, ...previous, ...input, id, revision: previous ? previous.revision + 1 : 1 };
      records.set(id, note); return { note: structuredClone(note) };
    }
    if (command === 'delete' || command === 'restore') {
      const previous = records.get(input.id);
      if (previous.revision !== input.revision) throw new Error('NOTE_CONFLICT');
      const note = { ...previous, revision: previous.revision + 1, deletedAt: command === 'delete' ? new Date().toISOString() : null };
      records.set(note.id, note); return { note: structuredClone(note) };
    }
    if (command === 'purge') {
      const previous = records.get(input.id);
      if (previous.revision !== input.revision) throw new Error('NOTE_CONFLICT');
      if (!previous.deletedAt) throw new Error('Only trashed notes can be permanently deleted');
      records.delete(input.id); return { id: input.id, deleted: true };
    }
    if (command === 'empty-trash') {
      const trashed = [...records.values()].filter(note => note.deletedAt);
      for (const note of trashed) records.delete(note.id);
      return { deleted: trashed.length };
    }
    if (command.startsWith('host.')) return null;
    throw new Error(command);
  });
  window.mearl = {
    ready: async () => ({ locale: 'zh_CN' }), invoke,
    ui: { ...preact, ...hooks, html: htm.bind(preact.h) },
    onContextChange(callback) { callback({ locale: 'zh_CN' }); return () => {}; },
    setAgentGuides: vi.fn(),
  };
  for (const file of ['icons.js', 'editor.js', 'images.js', 'links.js', 'app.js']) {
    const source = await readFile(join(root, file), 'utf8');
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
    if (file === 'editor.js') window.notesEditor = globalThis.notesEditor;
    if (file === 'images.js') window.notesImages = globalThis.notesImages;
    if (file === 'links.js') window.notesLinks = globalThis.notesLinks;
  }
  await vi.waitFor(() => expect(document.querySelector('aside').textContent).toContain('约定'));
  const select = async () => {
    [...document.querySelectorAll('aside button')].find(button => button.textContent.includes('约定')).click();
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('初始正文'));
  };
  const type = value => { const body = document.querySelector('textarea'); body.value = value; body.dispatchEvent(new Event('input', { bubbles: true })); };
  return { invoke, records, select, type };
}

describe('quick notes toolbox', () => {
  it('opens the clicked link with Command or Ctrl after saving the latest draft', async () => {
    const { invoke, select, type, records } = await mount(); await select();
    type('参考 https://example.com/article');
    const body = document.querySelector('textarea');
    const hit = vi.spyOn(window.notesLinks, 'atPoint').mockReturnValue('https://example.com/article');
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 40 }));
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 2, ctrlKey: true }));
    expect(hit).not.toHaveBeenCalled();
    const commandClick = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, clientX: 30, clientY: 40 });
    body.dispatchEvent(commandClick); expect(commandClick.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('host.link.open', { url: 'https://example.com/article' }));
    expect(hit).toHaveBeenCalledWith(body, 30, 40);
    expect(records.get('one').body).toBe('参考 https://example.com/article');
    expect(invoke.mock.calls.findIndex(([command]) => command === 'update')).toBeLessThan(invoke.mock.calls.findIndex(([command]) => command === 'host.link.open'));
    await vi.waitFor(() => expect(body.readOnly).toBe(false));
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: 30, clientY: 40 }));
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'host.link.open')).toHaveLength(2));
  });

  it('keeps drafts open if saving fails and ignores modified clicks outside links', async () => {
    const { invoke, select, type } = await mount(); await select();
    const body = document.querySelector('textarea');
    const hit = vi.spyOn(window.notesLinks, 'atPoint').mockReturnValue(null);
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(invoke.mock.calls.some(([command]) => command === 'host.link.open')).toBe(false);
    type('https://example.com/unsaved'); hit.mockReturnValue('https://example.com/unsaved');
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'update' ? Promise.reject(new Error('NOTE_CONFLICT')) : original(command, input));
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('草稿已保留'));
    expect(invoke.mock.calls.some(([command]) => command === 'host.link.open')).toBe(false);
    expect(body.value).toBe('https://example.com/unsaved');
  });

  it('collects the active tab title and link without reading page contents', async () => {
    const { invoke, records, select, type } = await mount(); await select(); type('我的批注');
    expect(document.querySelector('button[aria-label="复制正文"]')).toBeNull();
    expect(document.querySelector('button[aria-label="导出 Markdown"]')).toBeNull();
    document.querySelector('[aria-label="收录页面"]').click();
    await vi.waitFor(() => expect(records.get('one').body).toBe('我的批注\n\n当前页面\nhttps://example.com/article'));
    expect(records.get('one').source).toBe('https://example.com/article');
    expect(invoke).toHaveBeenCalledWith('host.tab.active', {});
    expect(invoke.mock.calls.some(([command]) => command === 'capture')).toBe(false);
    expect(invoke.mock.calls.some(([command]) => command === 'tabs')).toBe(false);
    expect(records.size).toBe(2);
  });

  it('lets a fullscreen user choose a target without capturing an arbitrary tab', async () => {
    const { invoke, records } = await mount(), normal = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'host.tab.active' ? Promise.resolve(null) : normal(command, input));
    document.querySelector('[aria-label="收录页面"]').click();
    await vi.waitFor(() => expect(document.querySelector('section').textContent).toContain('选择要收录的网页'));
    expect(invoke.mock.calls.some(([command]) => command === 'capture')).toBe(false);
    [...document.querySelectorAll('section button')].find(button => button.textContent.includes('可收录页面')).click();
    await vi.waitFor(() => expect(records.get('new-2')?.body).toBe('可收录页面\nhttps://example.com/article'));
    expect(records.get('new-2').title).toBe('可收录页面');
    expect(invoke.mock.calls.some(([command]) => command === 'capture')).toBe(false);
  });

  it('replaces search with empty trash and clears the entire unfiltered trash', async () => {
    const { invoke, records, select, type } = await mount();
    records.set('discarded', { ...records.get('one'), id: 'discarded', title: '已删除', body: '回收内容', deletedAt: new Date().toISOString() });
    await select(); type('保留当前草稿');
    document.querySelector('[aria-label="搜索笔记"]').click();
    await vi.waitFor(() => expect(document.querySelector('input[type="search"]')).not.toBeNull());
    const search = document.querySelector('input[type="search"]');
    search.value = '不匹配的搜索'; search.dispatchEvent(new Event('input', { bubbles: true }));
    listTab('回收站').click();
    await vi.waitFor(() => expect(document.querySelector('aside').textContent).toContain('已删除'));
    expect(document.querySelector('[aria-label="搜索笔记"]')).toBeNull();
    expect(document.querySelector('input[type="search"]')).toBeNull();
    [...document.querySelectorAll('aside button')].find(button => button.textContent.includes('已删除')).click();
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('回收内容'));
    const clear = document.querySelector('[aria-label="清空回收站"]');
    expect(clear.classList.contains('icon-button')).toBe(true);
    expect(clear.querySelector('svg')).not.toBeNull(); clear.click();
    await vi.waitFor(() => expect(document.querySelector('aside').textContent).toContain('回收站是空的'));
    expect(invoke).toHaveBeenCalledWith('empty-trash', {});
    expect(records.has('discarded')).toBe(false);
    expect(records.size).toBe(2);
    expect(document.querySelector('textarea').value).toBe('保留当前草稿');
    expect(document.querySelector('[aria-label="清空回收站"]').disabled).toBe(true);
    listTab('笔记').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="搜索笔记"]')).not.toBeNull());
    expect(document.querySelector('[aria-label="清空回收站"]')).toBeNull();
  });

  it('pastes and drops image attachments without replacing unsaved text', async () => {
    const { records, select, type } = await mount(); await select(); type('图片的说明');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [new File([png], '粘贴.png', { type: 'image/png' })] } });
    document.dispatchEvent(paste); expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(records.get('one').images).toHaveLength(1));
    expect(records.get('one').body).toBe('图片的说明');
    await vi.waitFor(() => expect(document.querySelector('button[aria-label="添加图片（也可粘贴或拖入）"]').disabled).toBe(false));
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([png], '拖入.png', { type: 'image/png' })] } });
    document.querySelector('main').dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent || '').toBe('');
      expect(records.get('one').images).toHaveLength(2);
    });
    await vi.waitFor(() => expect(document.querySelector('[aria-label="预览图片：粘贴.png"] img')).not.toBeNull());
    document.querySelector('[aria-label="预览图片：粘贴.png"]').click();
    await vi.waitFor(() => expect(document.querySelector('dialog').open).toBe(true));
    expect(records.size).toBe(2);
  });

  it('creates an image-only note and removes an attachment at the latest revision', async () => {
    const { records, type } = await mount();
    const input = document.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { value: [new File([png], '截图.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(records.get('new-2')?.images).toHaveLength(1));
    expect(records.get('new-2')).toMatchObject({ title: '截图.png', body: '' });
    await vi.waitFor(() => expect(document.querySelector('[aria-label="移除图片：截图.png"]').disabled).toBe(false));
    type('图片说明\n补充内容');
    document.querySelector('[aria-label="移除图片：截图.png"]').click();
    await vi.waitFor(() => expect(records.get('new-2').images).toEqual([]));
    expect(records.get('new-2')).toMatchObject({ title: '图片说明', body: '图片说明\n补充内容' });
  });

  it('deletes another list item directly without opening it or replacing the editor', async () => {
    const { records, invoke, select } = await mount(); await select();
    document.querySelector('[aria-label="移到回收站：Agent 笔记"]').click();
    await vi.waitFor(() => expect(records.get('agent-note').deletedAt).not.toBeNull());
    expect(document.querySelector('textarea').value).toBe('初始正文');
    expect(invoke.mock.calls.filter(([command]) => command === 'get')).toHaveLength(1);
  });

  it('keeps controls at the same opacity while deletion is locked and still dims unavailable actions', async () => {
    const { invoke, records, select } = await mount(); await select();
    await vi.waitFor(() => expect(document.querySelector('main').getAttribute('aria-busy')).toBe('false'));
    const style = document.createElement('style');
    style.textContent = await readFile(join(root, 'style.css'), 'utf8'); document.body.append(style);
    const buttons = [...document.querySelectorAll('button')];
    const opacities = buttons.map(button => getComputedStyle(button).opacity);
    const normal = invoke.getMockImplementation();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    invoke.mockImplementation((command, input) => command === 'delete' ? pending.then(() => normal(command, input)) : normal(command, input));
    document.querySelector('[aria-label="移到回收站：Agent 笔记"]').click();
    await vi.waitFor(() => expect(listTab('笔记').disabled).toBe(true));
    expect(document.querySelector('main').getAttribute('aria-busy')).toBe('true');
    expect(buttons.map(button => getComputedStyle(button).opacity)).toEqual(opacities);
    document.querySelector('[aria-label="移到回收站：Agent 笔记"]').click(); listTab('回收站').click();
    expect(invoke.mock.calls.filter(([command]) => command === 'delete')).toHaveLength(1);
    expect(listTab('笔记').getAttribute('aria-pressed')).toBe('true');
    finish();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="移到回收站：Agent 笔记"]')).toBeNull());
    expect(records.get('agent-note').deletedAt).not.toBeNull();
    await vi.waitFor(() => expect(listTab('回收站').disabled).toBe(false)); listTab('回收站').click();
    await vi.waitFor(() => expect(document.querySelector('aside [title="Agent 笔记"]')).not.toBeNull());
    document.querySelector('aside [title="Agent 笔记"]').click();
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('Agent 正文'));
    const capture = document.querySelector('[aria-label="收录页面"]');
    expect(capture.disabled).toBe(true);
    expect(Number(getComputedStyle(capture).opacity)).toBe(0.4);
  });

  it('preserves the empty trash message while refreshing the same list', async () => {
    const { invoke, select, type } = await mount(); await select();
    const normal = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'update' ? Promise.reject(new Error('NOTE_CONFLICT')) : normal(command, input));
    type('未保存的草稿');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('草稿已保留'));
    listTab('回收站').click();
    await vi.waitFor(() => expect(document.querySelector('.empty-list')?.textContent).toBe('回收站是空的'));
    const empty = document.querySelector('.empty-list');
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    invoke.mockImplementation((command, input) => command === 'page-list' ? pending.then(() => normal(command, input)) : normal(command, input));
    const previousLoads = invoke.mock.calls.filter(([command]) => command === 'page-list').length;
    [...document.querySelectorAll('[role="alert"] button')].find(button => button.textContent === '重新读取（替换草稿）').click();
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'page-list')).toHaveLength(previousLoads + 1));
    expect(document.querySelector('.empty-list')).toBe(empty);
    finish();
    await vi.waitFor(() => expect(document.querySelector('main').getAttribute('aria-busy')).toBe('false'));
    expect(document.querySelector('.empty-list')).toBe(empty);
  });

  it('saves the current draft before deleting its row and restores it directly from trash', async () => {
    const { records, select, type } = await mount(); await select(); type('删除前保留的正文');
    document.querySelector('[aria-label="移到回收站：约定"]').click();
    await vi.waitFor(() => expect(records.get('one')).toMatchObject({ body: '删除前保留的正文', revision: 3 }));
    expect(records.get('one').deletedAt).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe(''));
    const trash = listTab('回收站');
    expect(trash.closest('aside')).not.toBeNull();
    await vi.waitFor(() => expect(trash.disabled).toBe(false)); trash.click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="恢复笔记：删除前保留的正文"]')).not.toBeNull());
    document.querySelector('[aria-label="恢复笔记：删除前保留的正文"]').click();
    await vi.waitFor(() => expect(records.get('one')).toMatchObject({ deletedAt: null, revision: 4 }));
    expect(records.get('one').body).toBe('删除前保留的正文');
  });
  it('opens search from its icon and restores the list when search is closed', async () => {
    await mount();
    expect(document.querySelector('input[type=search]')).toBeNull();
    document.querySelector('[aria-label="搜索笔记"]').click();
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('input[type=search]')));
    const search = document.querySelector('input[type=search]');
    search.value = 'Agent'; search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('aside').textContent).not.toContain('约定'));
    expect(document.querySelector('aside').textContent).toContain('Agent 笔记');
    document.querySelector('[aria-label="关闭搜索"]').click();
    await vi.waitFor(() => expect(document.querySelector('aside').textContent).toContain('约定'));
    expect(document.querySelector('input[type=search]')).toBeNull();
  });
  it('opens ready to write, derives a title and keeps editing the same note', async () => {
    const { invoke, records, type } = await mount();
    expect(document.activeElement).toBe(document.querySelector('textarea'));
    expect(invoke.mock.calls.some(([command]) => command === 'create')).toBe(false);
    type('随手记下想法\n详细内容');
    await vi.waitFor(() => expect(records.get('new-2')).toMatchObject({ title: '随手记下想法', body: '随手记下想法\n详细内容' }), { timeout: 2000 });
    type('随手记下想法\n继续补充');
    await vi.waitFor(() => expect(records.get('new-2').body).toBe('随手记下想法\n继续补充'), { timeout: 2000 });
    await vi.waitFor(() => expect(document.querySelector('aside button[title="随手记下想法"]').textContent).toBe('随手记下想法继续补充'));
    expect(invoke.mock.calls.filter(([command]) => command === 'create')).toHaveLength(1);
    expect(document.querySelector('[role="status"]').textContent).toBe('已保存');
  });

  it('updates existing titles from the first line while autosaving without a memory switch', async () => {
    const { records, select, type } = await mount();
    await select(); type('更新正文');
    expect(document.querySelector('input[type=checkbox]')).toBeNull();
    await vi.waitFor(() => expect(records.get('one')).toMatchObject({ title: '更新正文', body: '更新正文', updatedBy: 'user' }));
  });

  it('preserves the draft when a conflicting save blocks navigation', async () => {
    const { invoke, select, type } = await mount(); await select();
    const normal = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'update' ? Promise.reject(new Error('NOTE_CONFLICT')) : normal(command, input));
    type('尚未保存的草稿');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]').textContent).toContain('草稿已保留'), { timeout: 2000 });
    [...document.querySelectorAll('aside button')].find(button => button.textContent.includes('Agent 笔记')).click();
    expect(document.querySelector('textarea').value).toBe('尚未保存的草稿');
    expect(invoke.mock.calls.filter(([command]) => command === 'update')).toHaveLength(1);
  });

  it('reloads after a conflict without relying on sandbox-blocked native dialogs', async () => {
    const { invoke, records, select, type } = await mount(); await select();
    expect(window.confirm).toBeUndefined();
    const normal = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'update' ? Promise.reject(new Error('NOTE_CONFLICT')) : normal(command, input));
    type('保留在本地的草稿');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]').textContent).toContain('草稿已保留'));
    records.set('one', { ...records.get('one'), revision: 2, body: '别处保存的正文' });
    [...document.querySelectorAll('[role="alert"] button')].find(button => button.textContent === '重新读取（替换草稿）').click();
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('别处保存的正文'));
  });

  it('shows human and Agent notes together and saves before switching notes', async () => {
    const { records, select, type } = await mount(); await select();
    const list = document.querySelector('aside');
    expect(list.textContent).toContain('约定'); expect(list.textContent).toContain('Agent 笔记');
    expect(list.querySelector('[aria-label="最近由你编辑"]')).toBeNull();
    expect(list.querySelector('[aria-label="最近由 Agent 编辑"]')).not.toBeNull();
    expect(listTab('笔记').getAttribute('aria-pressed')).toBe('true');
    type('返回前保存'); [...document.querySelectorAll('aside button')].find(button => button.textContent.includes('Agent 笔记')).click();
    await vi.waitFor(() => expect(records.get('one').body).toBe('返回前保存'));
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('Agent 正文'));
  });

  it('keeps the editor and focus when switching lists and excludes autosaves from trash', async () => {
    const { records, select, type } = await mount(); await select(); type('继续记录');
    const trash = listTab('回收站'); trash.focus(); trash.click();
    await vi.waitFor(() => expect(document.querySelector('aside').textContent).toContain('回收站是空的'));
    expect(document.querySelector('textarea').value).toBe('继续记录');
    expect(document.activeElement).toBe(trash);
    await vi.waitFor(() => expect(records.get('one').body).toBe('继续记录'));
    expect(document.querySelector('aside [title="约定"]')).toBeNull();
    type('仍在回收站列表时写字');
    await vi.waitFor(() => expect(records.get('one').body).toBe('仍在回收站列表时写字'));
    expect(listTab('回收站').getAttribute('aria-pressed')).toBe('true');
    listTab('笔记').click();
    await vi.waitFor(() => expect(document.querySelector('aside [title="仍在回收站列表时写字"]')).not.toBeNull());
    expect(document.querySelector('textarea').value).toBe('仍在回收站列表时写字');
  });

  it('previews trash read-only and returns to the previous note', async () => {
    const { records, select, type } = await mount(); await select(); type('保留的正文');
    records.get('agent-note').deletedAt = new Date().toISOString();
    listTab('回收站').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="恢复笔记：Agent 笔记"]')).not.toBeNull());
    document.querySelector('aside [title="Agent 笔记"]').click();
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('Agent 正文'));
    expect(document.querySelector('textarea').readOnly).toBe(true);
    listTab('笔记').click();
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('保留的正文'));
    expect(document.querySelector('textarea').readOnly).toBe(false);
    expect(records.get('one').body).toBe('保留的正文');
  });

  it('permanently deletes a trashed note directly from its row', async () => {
    const { records, invoke, select } = await mount(); await select();
    records.get('agent-note').deletedAt = new Date().toISOString();
    listTab('回收站').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="彻底删除：Agent 笔记"]')).not.toBeNull());
    document.querySelector('aside [title="Agent 笔记"]').click();
    await vi.waitFor(() => expect(document.querySelector('textarea').readOnly).toBe(true));
    document.querySelector('[aria-label="彻底删除：Agent 笔记"]').click();
    await vi.waitFor(() => expect(records.has('agent-note')).toBe(false));
    await vi.waitFor(() => expect(document.querySelector('textarea').value).toBe('初始正文'));
    expect(document.querySelector('aside').textContent).toContain('回收站是空的');
    expect(invoke.mock.calls.filter(([command]) => command === 'purge')).toHaveLength(1);
  });
});
