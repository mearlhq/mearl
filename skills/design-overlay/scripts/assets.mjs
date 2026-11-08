import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const CHUNK_CHARACTERS = 48 * 1024;
export const IMPORT_CHUNK_CHARACTERS = 192 * 1024;
export const RESOURCE_CHUNK_BYTES = 144 * 1024;
const RESOURCE_TTL = 15 * 60_000;
const DESIGN_TTL = 7 * 86400_000;

/** Assets use the host's validated browser-session namespace and bounded memory state. */
export function createAssetStore(state, owner) {
  const scopedKey = key => `${owner()}:${key}`;
  const get = async key => state('resources', 'get', { key: scopedKey(key) });
  const put = async (key, value, ttlMs = RESOURCE_TTL) => {
    const previous = await get(key);
    return state('resources', 'transact', { transaction: { operations: [{ type: 'put', key: scopedKey(key), value, expectedVersion: previous.version, ttlMs }] } });
  };
  const remove = async keys => {
    for (let offset = 0; offset < keys.length; offset += 4) {
      const entries = await state('resources', 'get-many', { keys: keys.slice(offset, offset + 4).map(scopedKey) });
      const operations = entries.entries.filter(entry => entry.exists).map(entry => ({ type: 'delete', key: entry.key, expectedVersion: entry.version }));
      if (operations.length) await state('resources', 'transact', { transaction: { operations } });
    }
  };
  const metadata = async id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid resource id');
    const entry = await get(id);
    if (!entry.exists || entry.value.kind !== 'resource') throw new Error('Resource is no longer available');
    return entry.value;
  };
  const catalog = async update => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const entry = await get('catalog');
      const ids = update(entry.value?.ids ?? []);
      try { await state('resources', 'transact', { transaction: { operations: [{ type: 'put', key: scopedKey('catalog'), value: { ids }, expectedVersion: entry.version, ttlMs: DESIGN_TTL }] } }); return ids; }
      catch (error) { if (error.code !== 'PLUGIN_STATE_CONFLICT' || attempt === 3) throw error; }
    }
  };
  const save = async content => {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_ASSET_BYTES) throw new Error('Resource exceeds 16 MiB');
    const id = randomBytes(32).toString('hex');
    const bytes = Buffer.from(content), chunks = Math.ceil(bytes.length / RESOURCE_CHUNK_BYTES);
    const keys = [];
    try {
      for (let index = 0; index < chunks; index++) {
        const key = `${id}:${index}`; keys.push(key);
        await put(key, { data: bytes.subarray(index * RESOURCE_CHUNK_BYTES, (index + 1) * RESOURCE_CHUNK_BYTES).toString('base64') });
      }
      await put(id, { kind: 'resource', chunks, bytes: bytes.length, pinned: false });
      await catalog(ids => [...ids, id]);
      return { id, chunks };
    } catch (error) { await remove(keys); throw error; }
  };
  const chunk = async ({ id, index }) => {
    const info = await metadata(id);
    if (!Number.isInteger(index) || index < 0 || index >= info.chunks) throw new Error('Invalid chunk index');
    const entry = await get(`${id}:${index}`);
    if (!entry.exists) throw new Error('Resource is incomplete');
    return { data: entry.value.data, encoding: 'base64', bytes: info.bytes, chunks: info.chunks };
  };
  const drop = async id => {
    const info = await metadata(id);
    await remove([id, ...Array.from({ length: info.chunks }, (_, index) => `${id}:${index}`)]);
    await catalog(ids => ids.filter(value => value !== id));
  };
  const list = async collection => {
    const entries = []; let cursor;
    do {
      const result = await state(collection, 'list', { limit: 200, ...(cursor ? { cursor } : {}) });
      entries.push(...result.entries.filter(entry => entry.key.startsWith(owner() + ':'))); cursor = result.nextCursor;
    } while (cursor);
    return entries;
  };
  return {
    save, chunk,
    async read(id) {
      const info = await metadata(id), parts = [];
      for (let index = 0; index < info.chunks; index++) parts.push(Buffer.from((await chunk({ id, index })).data, 'base64'));
      return Buffer.concat(parts).toString('utf8');
    },
    async pin(id) {
      const info = await metadata(id);
      for (let index = 0; index < info.chunks; index++) {
        const key = `${id}:${index}`, entry = await get(key);
        if (!entry.exists) throw new Error('Resource is incomplete');
        await put(key, entry.value, DESIGN_TTL);
      }
      await put(id, { ...info, pinned: true }, DESIGN_TTL);
    },
    async releaseComparisons() {
      const entry = await get('catalog');
      for (const id of entry.value?.ids ?? []) { const resource = await get(id); if (resource.exists && !resource.value.pinned) await drop(id); }
      const retained = [];
      for (const id of (await get('catalog')).value?.ids ?? []) if ((await get(id)).exists) retained.push(id);
      await catalog(() => retained);
    },
    async begin({ chunks }) {
      if (!Number.isInteger(chunks) || chunks < 1 || chunks > 512) throw new Error('Invalid chunk count');
      const uploadId = randomUUID();
      await put(uploadId, { kind: 'upload', chunks, next: 0, bytes: 0, keys: [] }, 10 * 60_000);
      return { uploadId };
    },
    async append({ uploadId, index, data }) {
      if (typeof uploadId !== 'string' || !/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('Invalid upload id');
      const entry = await get(uploadId);
      if (!entry.exists) throw new Error('Upload expired');
      const upload = entry.value;
      if (!Number.isInteger(index) || index !== upload.next) throw new Error('Unexpected chunk index');
      if (typeof data !== 'string' || !data || data.length > IMPORT_CHUNK_CHARACTERS) throw new Error('Invalid chunk data');
      upload.bytes += Buffer.byteLength(data);
      if (upload.bytes > MAX_ASSET_BYTES) { await remove([uploadId, ...upload.keys]); throw new Error('Design exceeds 16 MiB'); }
      for (let offset = 0; offset < data.length; offset += CHUNK_CHARACTERS) {
        const key = `${uploadId}:${index}:${offset}`;
        await put(key, { data: data.slice(offset, offset + CHUNK_CHARACTERS) }, 10 * 60_000); upload.keys.push(key);
      }
      upload.next++;
      if (upload.next !== upload.chunks) { await put(uploadId, upload, 10 * 60_000); return { next: upload.next }; }
      const keys = [uploadId, ...upload.keys];
      try {
        const parts = [];
        for (const key of upload.keys) { const part = await get(key); if (!part.exists) throw new Error('Upload expired'); parts.push(part.value.data); }
        const content = parts.join('');
        if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=\s]+$/.test(content) && !/^\s*(<svg\b|<\?xml\b)/.test(content)) throw new Error('Expected SVG, PNG or JPEG');
        await remove(keys);
        keys.length = 0;
        return { resource: await save(content) };
      } finally { await remove(keys); }
    },
    async loadSettings(url) {
      const key = scopedKey(createHash('sha256').update(url).digest('hex'));
      const saved = await state('settings', 'get', { key });
      return saved.exists ? saved.value.settings : null;
    },
    async saveSettings(url, settings, { pageInstanceId, settingsRevision }) {
      const key = scopedKey(createHash('sha256').update(url).digest('hex'));
      let previous;
      for (let attempt = 0; attempt < 4; attempt++) {
        previous = await state('settings', 'get', { key });
        if (previous.value?.pageInstanceId === pageInstanceId && previous.value.settingsRevision >= settingsRevision) return;
        try {
          await state('settings', 'transact', { transaction: { operations: [{ type: 'put', key, expectedVersion: previous.version, value: { url, settings, pageInstanceId, settingsRevision } }] } }); break;
        } catch (error) { if (error.code !== 'PLUGIN_STATE_CONFLICT' || attempt === 3) throw error; }
      }
      const old = previous.value?.settings.assetId;
      if (old && old !== settings.assetId && !(await list('settings')).some(entry => entry.value.settings.assetId === old)) {
        try { await drop(old); } catch (error) { if (!/no longer available/.test(error.message)) throw error; }
      }
    },
  };
}
