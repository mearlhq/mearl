import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 192 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_FIELDS = ['title', 'body', 'tags', 'scope', 'project', 'pinned', 'source', 'updatedBy'];
const IMAGE_LIMIT = 5 * 1024 * 1024;
const IMAGE_CHUNK = 48 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Unsupported image data');
}
function imagePaths(directory, id) {
  return { metadata: join(directory, 'uploads', `${id}.json`), data: join(directory, 'uploads', `${id}.part`) };
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value;
}
function fields(input, allowed) {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unsupported field: ${key}`);
}
function text(value, name, max, empty = true) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`${name} must be ${empty ? '0' : '1'}–${max} characters`);
  return value;
}
function bool(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}
async function projectPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('project must be an absolute directory');
  const path = await realpath(value);
  if (!(await stat(path)).isDirectory()) throw new Error('project must be a directory');
  return path;
}
function noteId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid note id');
  return value;
}
function summary(note, query = '') {
  const { body, ...metadata } = note;
  const position = query ? body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase().split(/\s+/)[0]) : 0;
  const start = Math.max(0, position - 80);
  return { ...metadata, excerpt: body.slice(start, start + 280) };
}
function bodyTitle(body, fallback) {
  return body.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || fallback;
}
async function load(file) {
  try {
    if ((await stat(file)).size > MAX_STORE_BYTES) throw new Error('Notes store exceeds 32 MiB');
    const store = JSON.parse(await readFile(file, 'utf8'));
    if (store.version !== 1 || !Array.isArray(store.notes)) throw new Error('Invalid notes store');
    for (const note of store.notes) {
      delete note.memory; delete note.done; note.images ??= [];
      if (note.updatedBy === 'user') note.title = bodyTitle(note.body, note.title);
    }
    return store;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, notes: [] };
    throw error;
  }
}
async function lock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'write.lock');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); }
      finally { await handle.close(); }
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(file), pid = Number(await readFile(file, 'utf8'));
        // A process can exit between acquiring the lock and writing its PID.
        if (Date.now() - info.mtimeMs > 30_000) {
          let alive = true;
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
          } else alive = false;
          if (!alive) await rm(file, { force: true });
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(30);
    }
  }
  throw new Error('Notes are busy. Retry shortly.');
}
async function content(input, previous) {
  const scope = input.scope ?? previous?.scope ?? 'personal';
  if (scope !== 'personal' && scope !== 'project') throw new Error('scope must be personal or project');
  if (scope === 'personal' && input.project != null) throw new Error('Personal notes cannot have a project');
  const project = scope === 'project' ? await projectPath(input.project ?? previous?.project) : null;
  const title = text(input.title ?? previous?.title ?? '', 'title', 200, false).trim();
  const body = text(input.body ?? previous?.body ?? '', 'body', MAX_BODY_BYTES);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Note body exceeds 192 KiB');
  const tags = input.tags ?? previous?.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 20) throw new Error('tags must contain at most 20 strings');
  const updatedBy = input.updatedBy ?? 'agent';
  if (updatedBy !== 'user' && updatedBy !== 'agent') throw new Error('updatedBy must be user or agent');
  const result = {
    title: updatedBy === 'user' ? bodyTitle(body, title) : title, body, scope, project, tags: [...new Set(tags.map(tag => text(tag, 'tag', 50, false).trim()))],
    pinned: bool(input.pinned, 'pinned', previous?.pinned ?? false),
    source: text(input.source ?? previous?.source ?? '', 'source', 500), updatedBy,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 768 * 1024) throw new Error('Encoded note exceeds 768 KiB');
  return result;
}

/** Toolbox and Agent commands share a plugin store on their execution machine. */
export async function invokeNotesStore(value, directory = resolve(process.env.MEARL_NOTES_DIR || join(homedir(), '.mearl', 'notes'))) {
  const request = record(value);
  fields(request, ['operation', 'input']);
  const operation = request.operation;
  if (!['list', 'search', 'get', 'create', 'update', 'delete', 'restore', 'purge', 'empty-trash', 'image-begin', 'image-append', 'image-cancel', 'image-chunk', 'image-remove'].includes(operation)) throw new Error('Unknown notes operation');
  const input = record(request.input ?? {}), file = join(directory, 'notes.json');
  if (operation === 'list' || operation === 'search') {
    fields(input, ['query', 'scope', 'project', 'memoryOnly', 'trash', 'offset', 'limit']);
    const query = text(input.query ?? '', 'query', 500).trim();
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const memoryOnly = operation === 'search' || bool(input.memoryOnly, 'memoryOnly');
    const trash = bool(input.trash, 'trash');
    const project = input.project === undefined ? undefined : await projectPath(input.project);
    if (input.scope !== undefined && input.scope !== 'personal' && input.scope !== 'project') throw new Error('Invalid scope');
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid pagination');
    const notes = (await load(file)).notes.filter(note => {
      if (Boolean(note.deletedAt) !== trash || (memoryOnly && note.deletedAt)) return false;
      if (input.scope && note.scope !== input.scope) return false;
      if (memoryOnly && note.scope === 'project' && note.project !== project) return false;
      if (project && note.scope === 'project' && note.project !== project) return false;
      const haystack = `${note.title}\n${note.tags.join(' ')}\n${note.body}`.toLocaleLowerCase();
      return terms.every(term => haystack.includes(term));
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { notes: notes.slice(offset, offset + limit).map(note => summary(note, query)), total: notes.length, nextOffset: offset + limit < notes.length ? offset + limit : null };
  }
  if (operation === 'get') {
    fields(input, ['id', 'memoryOnly', 'project']);
    const id = noteId(input.id), memoryOnly = bool(input.memoryOnly, 'memoryOnly');
    const project = input.project === undefined ? undefined : await projectPath(input.project);
    const note = (await load(file)).notes.find(note => note.id === id);
    if (!note || (memoryOnly && (note.deletedAt || (note.scope === 'project' && note.project !== project)))) throw new Error('Note is unavailable');
    return { note };
  }
  if (operation === 'image-chunk') {
    fields(input, ['id', 'imageId', 'index']);
    const id = noteId(input.id), imageId = noteId(input.imageId), index = input.index ?? 0;
    const image = (await load(file)).notes.find(note => note.id === id)?.images.find(image => image.id === imageId);
    if (!image) throw new Error('Image is unavailable');
    const chunks = Math.ceil(image.size / IMAGE_CHUNK);
    if (!Number.isSafeInteger(index) || index < 0 || index >= chunks) throw new Error('Invalid image chunk');
    const handle = await open(join(directory, 'images', id, imageId), 'r');
    try {
      const bytes = Buffer.alloc(Math.min(IMAGE_CHUNK, image.size - index * IMAGE_CHUNK));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, index * IMAGE_CHUNK);
      if (bytesRead !== bytes.length) throw new Error('Incomplete image file');
      return { ...image, chunks, data: bytes.toString('base64') };
    } finally { await handle.close(); }
  }
  const imageFields = {
    'image-begin': ['id', 'revision', 'name', 'type', 'size'],
    'image-append': ['uploadId', 'index', 'data'], 'image-cancel': ['uploadId'], 'image-remove': ['id', 'revision', 'imageId'],
  };
  fields(input, imageFields[operation] ?? (operation === 'empty-trash' ? [] : operation === 'create' ? CONTENT_FIELDS : operation === 'update' ? ['id', 'revision', ...CONTENT_FIELDS] : operation === 'purge' ? ['id', 'revision'] : ['id', 'revision', 'updatedBy']));
  const release = await lock(directory);
  let rollback;
  try {
    const store = await load(file), now = new Date().toISOString();
    let note, cleanup, result;
    if (operation === 'image-cancel') {
      const paths = imagePaths(directory, noteId(input.uploadId));
      await rm(paths.metadata, { force: true }); await rm(paths.data, { force: true });
      return { cancelled: true };
    }
    if (operation === 'image-begin') {
      const id = noteId(input.id);
      note = store.notes.find(note => note.id === id);
      if (!note || note.deletedAt) throw new Error('Note is unavailable');
      if (note.revision !== input.revision) throw new Error('NOTE_CONFLICT: Note changed. Reload before saving.');
      if (note.images.length >= 12) throw new Error('A note can contain at most 12 images');
      const name = text(input.name, 'name', 200, false);
      if (!IMAGE_TYPES.includes(input.type) || !Number.isSafeInteger(input.size) || input.size < 12 || input.size > IMAGE_LIMIT) throw new Error('Images must be PNG, JPEG or WebP, up to 5 MiB');
      const uploads = join(directory, 'uploads'); await mkdir(uploads, { recursive: true, mode: 0o700 });
      // Interrupted transfers expire; completed images live alongside their note until removed.
      for (const entry of await readdir(uploads)) {
        if (!/^[a-f0-9-]+\.(json|part)$/.test(entry)) continue;
        const path = join(uploads, entry);
        if (Date.now() - (await stat(path)).mtimeMs > 86400000) await rm(path, { force: true });
      }
      const uploadId = randomUUID(), paths = imagePaths(directory, uploadId);
      await writeFile(paths.data, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      await writeFile(paths.metadata, JSON.stringify({ id: note.id, revision: note.revision, name, type: input.type, size: input.size, next: 0, received: 0 }), { flag: 'wx', mode: 0o600 });
      return { uploadId };
    }
    if (operation === 'image-append') {
      const uploadId = noteId(input.uploadId), paths = imagePaths(directory, uploadId);
      const upload = JSON.parse(await readFile(paths.metadata, 'utf8'));
      if (input.index !== upload.next || typeof input.data !== 'string' || input.data.length > IMAGE_CHUNK * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new Error('Invalid image chunk');
      const bytes = Buffer.from(input.data, 'base64');
      if (!bytes.length || upload.received + bytes.length > upload.size) throw new Error('Invalid image size');
      note = store.notes.find(note => note.id === upload.id);
      if (!note || note.deletedAt) throw new Error('Note is unavailable');
      if (note.revision !== upload.revision) throw new Error('NOTE_CONFLICT: Note changed. Reload before saving.');
      if ((await stat(paths.data)).size !== upload.received) throw new Error('Interrupted image upload. Start again.');
      await appendFile(paths.data, bytes);
      upload.next++; upload.received += bytes.length;
      if (upload.received < upload.size) {
        await writeFile(paths.metadata, JSON.stringify(upload), { mode: 0o600 });
        return { complete: false };
      }
      if (imageType(await readFile(paths.data)) !== upload.type) throw new Error('Image type does not match its content');
      const image = { id: uploadId, name: upload.name, type: upload.type, size: upload.size };
      const folder = join(directory, 'images', note.id); await mkdir(folder, { recursive: true, mode: 0o700 });
      const target = join(folder, uploadId); await rename(paths.data, target);
      rollback = () => rm(target, { force: true });
      note.images.push(image); note.revision++; note.updatedAt = now; note.updatedBy = 'user';
      cleanup = () => rm(paths.metadata, { force: true });
      result = { note, complete: true };
    } else if (operation === 'empty-trash') {
      const trashed = store.notes.filter(note => note.deletedAt);
      store.notes = store.notes.filter(note => !note.deletedAt);
      cleanup = () => Promise.all(trashed.map(note => rm(join(directory, 'images', note.id), { recursive: true, force: true })));
      result = { deleted: trashed.length };
    } else if (operation === 'create') {
      note = { ...await content(input), id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, deletedAt: null, images: [] };
      store.notes.push(note);
    } else {
      const id = noteId(input.id);
      note = store.notes.find(note => note.id === id);
      if (!note) throw new Error('Note is unavailable');
      if (input.revision !== note.revision) throw new Error('NOTE_CONFLICT: Note changed. Reload before saving.');
      if ((operation === 'update' || operation === 'image-remove') && note.deletedAt) throw new Error('Restore the note before editing');
      if (operation === 'purge') {
        if (!note.deletedAt) throw new Error('Only trashed notes can be permanently deleted');
        store.notes = store.notes.filter(item => item.id !== id);
        cleanup = () => rm(join(directory, 'images', id), { recursive: true, force: true });
      } else if (operation === 'image-remove') {
        const imageId = noteId(input.imageId);
        if (!note.images.some(image => image.id === imageId)) throw new Error('Image is unavailable');
        note.images = note.images.filter(image => image.id !== imageId); note.updatedBy = 'user';
        cleanup = () => rm(join(directory, 'images', id, imageId), { force: true });
      } else if (operation === 'update') Object.assign(note, await content(input, note));
      else {
        if (input.updatedBy !== undefined && input.updatedBy !== 'user' && input.updatedBy !== 'agent') throw new Error('updatedBy must be user or agent');
        note.updatedBy = input.updatedBy ?? 'agent';
        note.deletedAt = operation === 'delete' ? now : null;
      }
      if (operation !== 'purge') { note.revision++; note.updatedAt = now; }
    }
    if (operation !== 'purge' && note?.updatedBy === 'user') note.title = bodyTitle(note.body, note.title);
    const serialized = JSON.stringify(store);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error('Notes store exceeds 32 MiB');
    const temporary = join(directory, `notes-${randomUUID()}.tmp`);
    try { await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    rollback = null;
    await cleanup?.();
    return result ?? (operation === 'purge' ? { id: note.id, deleted: true } : { note });
  } catch (error) {
    await rollback?.().catch(() => {});
    throw error;
  } finally { await release(); }
}
