import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import register, { toolbox } from '../../notes-memory/scripts/main.mjs';

let directory;
afterEach(async () => { delete globalThis.notesEditor; vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });
const loadEditor = async () => {
  const source = await readFile(new URL('../../notes-memory/assets/toolbox/editor.js', import.meta.url), 'utf8');
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
  return globalThis.notesEditor;
};

describe('notes plugin and editor', () => {
  it('exposes only six Agent commands and keeps toolbox operations page-only', () => {
    const commands = new Map(), page = new Map(), invoke = vi.fn();
    register({ command(signature, handler) { commands.set(signature.split(' ')[0], handler); }, toolboxCommand(name, handler) { page.set(name, handler); }, invoke });
    expect([...commands.keys()]).toEqual(['list', 'search', 'get', 'create', 'update', 'delete']);
    expect([...page.keys()]).toEqual(['tabs', 'page-list', 'restore', 'purge', 'empty-trash', 'image-begin', 'image-append', 'image-cancel', 'image-chunk', 'image-remove']);
    for (const name of page.keys()) expect(toolbox.page.commands).toContain(name);
    for (const name of toolbox.page.commands) expect(commands.has(name) || page.has(name)).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('lists web page metadata using only read-only tab enumeration', async () => {
    const invoke = vi.fn().mockResolvedValue({ tabs: [
      { id: 1, title: '内部页', url: 'chrome://settings' },
      { id: 2, title: '文章', url: 'https://example.com', active: true },
    ] });
    const page = new Map();
    register({ command() {}, toolboxCommand(name, handler) { page.set(name, handler); }, invoke });
    expect(await page.get('tabs')()).toEqual({ tabs: [{ id: 2, title: '文章', url: 'https://example.com' }] });
    expect(invoke.mock.calls).toEqual([['tab_list', {}]]);
  });

  it('returns compact Agent summaries and pagination while retaining complete toolbox rows', async () => {
    directory = await mkdtemp(join(tmpdir(), 'notes-summary-')); vi.stubEnv('MEARL_NOTES_DIR', directory);
    const commands = new Map(), page = new Map();
    register({ command(signature, handler) { commands.set(signature.split(' ')[0], handler); }, toolboxCommand(name, handler) { page.set(name, handler); }, invoke: vi.fn() });
    for (let index = 0; index < 12; index++) await commands.get('create')({ title: `约定 ${index}`, body: `约定 ${index}\n${'验证流程 '.repeat(80)}`, tags: ['测试'], source: '用户要求' });
    const result = await commands.get('list')({});
    expect(result.notes).toHaveLength(10); expect(result.total).toBe(12); expect(result.nextOffset).toBe(10);
    for (const item of result.notes) {
      expect(Object.keys(item)).toEqual(['id', 'title', 'excerpt']);
      expect(item.excerpt.length).toBeLessThanOrEqual(160); expect(item.excerpt).toMatch(/^验证流程/);
    }
    const end = await commands.get('list')({ offset: 10 });
    expect(end.notes).toHaveLength(2); expect(end).not.toHaveProperty('nextOffset');
    expect((await commands.get('search')({ query: '验证流程', limit: 1 })).notes).toHaveLength(1);
    const rows = await page.get('page-list')({});
    expect(rows.notes).toHaveLength(12); expect(rows.nextOffset).toBeNull();
    expect(rows.notes[0]).toMatchObject({ revision: 1, updatedBy: 'agent', tags: ['测试'], source: '用户要求', images: [] });
    expect((await commands.get('get')({ id: result.notes[0].id })).note.body.length).toBeGreaterThan(160);
    const created = (await commands.get('create')({ title: '只有标题', body: '只有标题' })).note;
    expect((await commands.get('list')({ query: '只有标题' })).notes).toEqual([{ id: created.id, title: '只有标题' }]);
    const project = (await commands.get('create')({ title: '项目约定', body: '项目约定\n只用于当前项目', scope: 'project', project: directory })).note;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const { uploadId } = await page.get('image-begin')({ id: project.id, revision: project.revision, name: 'dot.png', type: 'image/png', size: png.length });
    await page.get('image-append')({ uploadId, index: 0, data: png.toString('base64') });
    expect((await commands.get('search')({ query: '只用于当前项目' })).total).toBe(0);
    expect((await commands.get('search')({ query: '只用于当前项目', project: directory })).notes).toEqual([
      { id: project.id, title: '项目约定', excerpt: '只用于当前项目', project: project.project, imageCount: 1 },
    ]);
  });

  it('shares plugin-local storage across commands without invoking host capabilities', async () => {
    directory = await mkdtemp(join(tmpdir(), 'notes-plugin-'));
    vi.stubEnv('MEARL_NOTES_DIR', directory);
    const handlers = new Map(), invoke = vi.fn();
    register({ command(signature, handler) { handlers.set(signature.split(' ')[0], handler); }, toolboxCommand() {}, invoke });
    const { note } = await handlers.get('create')({ title: '约定', body: '验证流程' });
    expect(await handlers.get('get')({ id: note.id })).toEqual({ note });
    expect((await handlers.get('search')({ query: '验证流程' })).notes).toHaveLength(1);
    await handlers.get('update')({ id: note.id, revision: note.revision, body: '新的流程' });
    expect(JSON.parse(await readFile(join(directory, 'notes.json'), 'utf8')).notes[0]).toMatchObject({ body: '新的流程', revision: 2 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('serializes autosave, retains edits made during a save and advances the revision', async () => {
    const createEditor = await loadEditor();
    let finish;
    const write = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementationOnce(async note => ({ note: { ...note, revision: 3 } }));
    const editor = createEditor({ id: 'note', revision: 1, body: 'old' }, write, vi.fn());
    editor.edit({ body: 'first' });
    const save = editor.save();
    editor.edit({ body: 'second' });
    const concurrentSave = editor.save();
    expect(write).toHaveBeenCalledTimes(1);
    finish({ note: { revision: 2 } });
    expect(await save).toBe(true);
    expect(await concurrentSave).toBe(true);
    expect(write.mock.calls[1][0]).toMatchObject({ body: 'second', revision: 2 });
    expect(editor.state()).toMatchObject({ note: { body: 'second', revision: 3 }, dirty: false, saving: false });
  });

  it('preserves an unsaved draft and stops autosave after a conflicting update', async () => {
    const createEditor = await loadEditor();
    const write = vi.fn().mockRejectedValue(new Error('NOTE_CONFLICT'));
    const editor = createEditor({ revision: 1, body: 'old' }, write, vi.fn());
    editor.edit({ body: 'my draft' });
    expect(await editor.save()).toBe(false);
    editor.edit({ body: 'my newer draft' });
    expect(await editor.save()).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(editor.state()).toMatchObject({ note: { body: 'my newer draft', revision: 1 }, dirty: true });
  });
});
