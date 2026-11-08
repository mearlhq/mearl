import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invokeNotesStore } from '../../notes-memory/scripts/store.mjs';

let directory, project;
const invoke = (operation, input = {}) => invokeNotesStore({ operation, input }, join(directory, 'data'));
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'notes-store-')));
  project = join(directory, 'project'); await mkdir(project);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('plugin notes store', () => {
  it('uses the first body line for human notes, including existing image-only notes', async () => {
    const { note } = await invoke('create', { title: 'image.png', body: '', updatedBy: 'user' });
    expect(note.title).toBe('image.png');
    const updated = await invoke('update', { id: note.id, revision: 1, body: '第一行\n更多信息', updatedBy: 'user' });
    expect(updated.note.title).toBe('第一行');
    const file = join(directory, 'data/notes.json'), data = JSON.parse(await readFile(file, 'utf8'));
    data.notes[0].title = 'image.png'; await writeFile(file, JSON.stringify(data));
    expect((await invoke('list')).notes[0].title).toBe('第一行');
    expect((await invoke('get', { id: note.id })).note.title).toBe('第一行');
  });
  it('stores chunked images as files, keeps them in trash and cleans them on purge', async () => {
    const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(60000)]);
    const { note } = await invoke('create', { title: '截图', body: '保留正文' });
    const upload = await invoke('image-begin', { id: note.id, revision: 1, name: '截图.png', type: 'image/png', size: bytes.length });
    await expect(invoke('image-append', { ...upload, index: 1, data: 'AAAA' })).rejects.toThrow('chunk');
    expect(await invoke('image-append', { ...upload, index: 0, data: bytes.subarray(0, 48 * 1024).toString('base64') })).toEqual({ complete: false });
    const saved = await invoke('image-append', { ...upload, index: 1, data: bytes.subarray(48 * 1024).toString('base64') });
    expect(saved).toMatchObject({ complete: true, note: { body: '保留正文', revision: 2, images: [{ id: upload.uploadId, name: '截图.png' }] } });
    const image = join(directory, 'data/images', note.id, upload.uploadId);
    expect(await readFile(image)).toEqual(bytes);
    const first = await invoke('image-chunk', { id: note.id, imageId: upload.uploadId, index: 0 });
    const second = await invoke('image-chunk', { id: note.id, imageId: upload.uploadId, index: 1 });
    expect(first.chunks).toBe(2);
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')])).toEqual(bytes);
    await expect(invoke('image-chunk', { id: note.id, imageId: upload.uploadId, index: 2 })).rejects.toThrow('chunk');
    const { note: other } = await invoke('create', { title: '另一篇' });
    await expect(invoke('image-chunk', { id: other.id, imageId: upload.uploadId })).rejects.toThrow('unavailable');
    const serialized = await readFile(join(directory, 'data/notes.json'), 'utf8');
    expect(serialized.length).toBeLessThan(2000); expect(serialized).not.toContain(bytes.toString('base64'));
    await invoke('delete', { id: note.id, revision: 2 });
    expect((await invoke('image-chunk', { id: note.id, imageId: upload.uploadId })).data).toBe(first.data);
    await invoke('purge', { id: note.id, revision: 3 });
    await expect(readFile(image)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates image uploads, detects conflicting edits, and removes attachments independently', async () => {
    const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(12)]);
    const { note } = await invoke('create', { title: '附件' });
    const input = { id: note.id, revision: 1, name: '图片.png', type: 'image/png', size: bytes.length };
    await expect(invoke('image-begin', { ...input, size: 6 * 1024 * 1024 })).rejects.toThrow('5 MiB');
    await expect(invoke('image-begin', { ...input, type: 'image/svg+xml' })).rejects.toThrow('PNG');
    const stale = await invoke('image-begin', input);
    await invoke('update', { id: note.id, revision: 1, body: '其他编辑器保存' });
    await expect(invoke('image-append', { ...stale, index: 0, data: bytes.toString('base64') })).rejects.toThrow('NOTE_CONFLICT');
    await invoke('image-cancel', stale);
    await expect(readFile(join(directory, 'data/uploads', `${stale.uploadId}.part`))).rejects.toMatchObject({ code: 'ENOENT' });
    const invalid = await invoke('image-begin', { ...input, revision: 2 });
    await expect(invoke('image-append', { ...invalid, index: 0, data: Buffer.alloc(bytes.length).toString('base64') })).rejects.toThrow('image data');
    await invoke('image-cancel', invalid);
    const upload = await invoke('image-begin', { ...input, revision: 2 });
    await invoke('image-append', { ...upload, index: 0, data: bytes.toString('base64') });
    await expect(invoke('image-remove', { id: note.id, imageId: upload.uploadId, revision: 2 })).rejects.toThrow('NOTE_CONFLICT');
    const removed = await invoke('image-remove', { id: note.id, imageId: upload.uploadId, revision: 3 });
    expect(removed.note).toMatchObject({ body: '其他编辑器保存', images: [], revision: 4 });
    await expect(readFile(join(directory, 'data/images', note.id, upload.uploadId))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('permanently deletes only trashed notes at the current revision', async () => {
    const { note } = await invoke('create', { title: '待清理', body: '删除后不保留正文' });
    await expect(invoke('purge', { id: note.id, revision: 1 })).rejects.toThrow('Only trashed');
    await invoke('delete', { id: note.id, revision: 1 });
    await expect(invoke('purge', { id: note.id, revision: 1 })).rejects.toThrow('NOTE_CONFLICT');
    expect((await invoke('list', { trash: true })).total).toBe(1);
    expect(await invoke('purge', { id: note.id, revision: 2 })).toEqual({ id: note.id, deleted: true });
    expect(JSON.parse(await readFile(join(directory, 'data/notes.json'), 'utf8')).notes).toEqual([]);
    await expect(invoke('get', { id: note.id })).rejects.toThrow('unavailable');
    await expect(invoke('restore', { id: note.id, revision: 2 })).rejects.toThrow('unavailable');
  });

  it('empties all trash and its images while preserving active and restored notes', async () => {
    const { note: active } = await invoke('create', { title: '保留' });
    const { note: restored } = await invoke('create', { title: '已恢复' });
    await invoke('delete', { id: restored.id, revision: 1 });
    await invoke('restore', { id: restored.id, revision: 2 });
    const { note } = await invoke('create', { title: '待清空' });
    const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(12)]);
    const upload = await invoke('image-begin', { id: note.id, revision: 1, name: '图片.png', type: 'image/png', size: bytes.length });
    await invoke('image-append', { ...upload, index: 0, data: bytes.toString('base64') });
    await invoke('delete', { id: note.id, revision: 2 });
    for (let index = 0; index < 51; index++) {
      const { note: discarded } = await invoke('create', { title: `回收 ${index}`, scope: 'project', project });
      await invoke('delete', { id: discarded.id, revision: 1 });
    }
    await expect(invoke('empty-trash', { query: '待清空' })).rejects.toThrow('Unsupported field');
    expect(await invoke('empty-trash')).toEqual({ deleted: 52 });
    expect((await invoke('list', { trash: true })).total).toBe(0);
    expect((await invoke('list')).notes.map(note => note.id).sort()).toEqual([active.id, restored.id].sort());
    await expect(readFile(join(directory, 'data/images', note.id, upload.uploadId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await invoke('empty-trash')).toEqual({ deleted: 0 });
  });
  it('recalls active personal and current-project notes without a memory switch', async () => {
    const { note: personal } = await invoke('create', { title: '发布约定', body: '必须验证' });
    await invoke('create', { title: '发布项目', scope: 'project', project });
    const other = join(directory, 'other'); await mkdir(other);
    await invoke('create', { title: '发布其他项目', scope: 'project', project: other });
    await invoke('create', { title: '发布草稿', body: '尚未决定' });
    const { note: discarded } = await invoke('create', { title: '发布旧约定' });
    await invoke('delete', { id: discarded.id, revision: 1 });
    const file = join(directory, 'data/notes.json'), store = JSON.parse(await readFile(file, 'utf8'));
    store.notes[0].memory = false; await writeFile(file, JSON.stringify(store));
    expect((await invoke('search', { query: '发布' })).total).toBe(2);
    expect((await invoke('get', { id: personal.id, memoryOnly: true })).note).not.toHaveProperty('memory');
    expect((await invoke('search', { query: '发布', project })).total).toBe(3);
    expect((await invoke('list', { query: '发布', memoryOnly: true })).total).toBe(2);
    expect((await invoke('list', { query: '发布', memoryOnly: true, project })).total).toBe(3);
    expect((await invoke('list')).total).toBe(4);
    expect((await invoke('list', { trash: true })).notes[0].id).toBe(discarded.id);
    expect((await invoke('search', { trash: true })).total).toBe(0);
    await expect(invoke('get', { id: discarded.id, memoryOnly: true })).rejects.toThrow('unavailable');
  });

  it('preserves partial updates and uses revisions for editing, trash and restore', async () => {
    const { note } = await invoke('create', { title: '约定', body: '# 验证', tags: ['测试', '测试'], source: '用户要求' });
    const updated = await invoke('update', { id: note.id, revision: 1, body: '新的约定', updatedBy: 'user' });
    expect(updated.note).toMatchObject({ title: '新的约定', tags: ['测试'], source: '用户要求', revision: 2, updatedBy: 'user' });
    await expect(invoke('update', { id: note.id, revision: 1, body: '覆盖' })).rejects.toThrow('NOTE_CONFLICT');
    await expect(invoke('delete', { id: note.id })).rejects.toThrow('NOTE_CONFLICT');
    await invoke('delete', { id: note.id, revision: 2 });
    await expect(invoke('update', { id: note.id, revision: 3, body: '覆盖' })).rejects.toThrow('Restore');
    expect((await invoke('restore', { id: note.id, revision: 3 })).note).toMatchObject({ deletedAt: null, revision: 4 });
    const results = await invoke('search', { query: '新的 测试' });
    expect(results.total).toBe(1); expect(results.notes[0]).not.toHaveProperty('body');
  });

  it('serializes concurrent writes and canonicalizes project paths', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => invoke('create', { title: `笔记 ${index}` })));
    expect(await invoke('list', { limit: 5 })).toMatchObject({ total: 12, nextOffset: 5 });
    expect((await invoke('list', { offset: 10 })).notes).toHaveLength(2);
    const alias = join(directory, 'alias'); await symlink(project, alias);
    const { note } = await invoke('create', { title: '项目约定', scope: 'project', project: alias });
    expect(note.project).toBe(project);
    await expect(invoke('get', { id: note.id, memoryOnly: true })).rejects.toThrow('unavailable');
    expect((await invoke('get', { id: note.id, memoryOnly: true, project: alias })).note.id).toBe(note.id);
    const results = await Promise.allSettled(['甲', '乙'].map(body => invoke('update', { id: note.id, revision: 1, body })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects unsupported fields, invalid scope and oversized data without losing notes', async () => {
    await invoke('create', { title: '保留' });
    for (const input of [
      { title: '' }, { title: '无效', scope: 'unknown' }, { title: '无效', project },
      { title: '无效', memory: true }, { title: '无效', tags: [''] }, { title: '无效', typo: true },
      { title: '无效', scope: 'project', project: 'relative' }, { title: '无效', body: '汉'.repeat(100000) },
    ]) await expect(invoke('create', input)).rejects.toThrow();
    await expect(invoke('list', { limit: 101 })).rejects.toThrow();
    await expect(invoke('get', { id: '../../' })).rejects.toThrow('Invalid note id');
    expect((await invoke('list')).total).toBe(1);
  });
});
