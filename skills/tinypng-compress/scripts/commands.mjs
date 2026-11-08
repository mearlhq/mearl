import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const MAX_BYTES = 5 * 1024 * 1024;
export const CHUNK_BYTES = 144 * 1024;
const running = new Map();
const pendingDownloads = new Map();
const resources = new Map();
const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function isPermissionBlocked(error) {
  return error?.code === 'DOMAIN_PERMISSION_REQUIRED' && error.requestDispatched === false;
}

function thumbnailData(data) {
  if (data === undefined) return undefined;
  if (typeof data !== 'string' || data.length > 8192 || !data.startsWith('data:image/png;base64,')) throw new Error('Invalid thumbnail');
  const bytes = decode(data.slice('data:image/png;base64,'.length), 6144);
  if (imageType(bytes) !== 'image/png' || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 32 ||
      bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 32) throw new Error('Invalid thumbnail dimensions');
  return data;
}

export function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Expected PNG, JPEG or WebP');
}

function decode(data, maxBytes) {
  if (typeof data !== 'string' || !data.length || data.length % 4 || data.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid image chunk');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== data) throw new Error('Invalid image chunk');
  return bytes;
}

export function outputMetadata(response, inputSize) {
  const output = response.body?.output;
  if (response.status !== 201) throw new Error(`TinyPNG HTTP ${response.status}: ${String(response.body?.message || response.body?.error || 'Compression failed').slice(0, 200)}`);
  if (response.body?.input?.size !== inputSize || !output || !Number.isSafeInteger(output.size) || output.size < 1 || output.size > MAX_BYTES || !mimeExtensions[output.type] || !Number.isSafeInteger(output.width) || output.width < 1 || !Number.isSafeInteger(output.height) || output.height < 1) throw new Error('Invalid TinyPNG response');
  const url = new URL(output.url);
  if (url.protocol !== 'https:' || url.hostname !== 'tinify.cn' || url.port || url.username || url.password || url.search || url.hash || !/^\/backend\/opt\/output\/[a-z0-9]+$/.test(url.pathname)) throw new Error('Invalid TinyPNG output URL');
  return { size: output.size, type: output.type, width: output.width, height: output.height, url: url.href };
}

export function createCommands(invoke, { directory = join(homedir(), '.mearl/image-compress') } = {}) {
  const ensure = () => mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = (id, suffix) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid image id');
    return join(directory, `${id}.${suffix}`);
  };
  const read = id => JSON.parse(readFileSync(path(id, 'json'), 'utf8'));
  const save = job => {
    const destination = path(job.id, 'json');
    const temporary = `${destination}.tmp`;
    writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
    renameSync(temporary, destination);
  };
  const publicJob = job => ({
    id: job.id, name: job.name, size: job.size, received: job.received, type: job.type,
    ...(job.thumbnail ? { thumbnail: job.thumbnail } : {}),
    state: job.output ? 'done' : job.state === 'compressing' && !isRunning(job) ? 'interrupted' : job.state,
    ...(job.error && !job.output ? { error: job.error } : {}),
    ...(job.output ? { output: { size: job.output.size, type: job.output.type, width: job.output.width, height: job.output.height } } : {}),
  });
  const isRunning = job => {
    if (running.has(path(job.id, 'input'))) return true;
    if (!Number.isSafeInteger(job.runPid) || job.runPid < 1 || !Number.isSafeInteger(job.runUntil) || job.runUntil < Date.now()) return false;
    try { process.kill(job.runPid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
  };
  const records = () => {
    ensure();
    return readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => read(name.slice(0, -5)))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
  };
  const list = ({ offset = 0, limit = 50 } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid list pagination');
    const jobs = records().map(publicJob);
    const completed = jobs.filter(job => job.state === 'done');
    return {
      jobs: jobs.slice(offset, offset + limit), total: jobs.length,
      nextOffset: offset + limit < jobs.length ? offset + limit : null,
      summary: {
        done: completed.length, active: jobs.filter(job => ['compressing', 'downloading'].includes(job.state)).length,
        originalBytes: completed.reduce((sum, job) => sum + job.size, 0),
        outputBytes: completed.reduce((sum, job) => sum + job.output.size, 0),
      },
    };
  };
  const begin = ({ name, size, thumbnail } = {}) => {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) throw new Error('Each image must be between 1 byte and 5 MiB');
    if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid image filename');
    const preview = thumbnailData(thumbnail);
    ensure();
    const job = { id: randomUUID(), name: basename(name.replaceAll('\\', '/')), size, received: 0, index: 0, state: 'importing', createdAt: Date.now(), ...(preview ? { thumbnail: preview } : {}) };
    writeFileSync(path(job.id, 'input'), Buffer.alloc(0), { mode: 0o600 });
    save(job);
    return publicJob(job);
  };
  const append = ({ id, index, data } = {}) => {
    const job = read(id);
    if (job.state !== 'importing' || index !== job.index) throw new Error('Unexpected image chunk');
    const bytes = decode(data, CHUNK_BYTES);
    if (job.received + bytes.length > job.size) throw new Error('Image exceeds declared size');
    appendFileSync(path(id, 'input'), bytes);
    job.received += bytes.length; job.index += 1;
    if (job.received === job.size) {
      try { job.type = imageType(readFileSync(path(id, 'input'))); job.state = 'queued'; }
      catch (error) { job.state = 'error'; job.error = error.message; save(job); throw error; }
    }
    save(job);
    return publicJob(job);
  };
  const upload = async (bytes, type) => {
    const response = await invoke('send_request', {
      url: 'https://tinify.cn/backend/opt/shrink', method: 'POST',
      bodyFile: { base64: bytes.toString('base64'), contentType: type },
      responseType: 'json', timeout: 60000,
    }, { timeoutSec: 90 });
    return outputMetadata(response, bytes.length);
  };
  const compress = async ({ id } = {}) => {
    const key = path(id, 'input');
    if (running.has(key)) return running.get(key);
    const job = read(id);
    if (job.output) return publicJob(job);
    if (job.state !== 'queued') throw new Error('This upload cannot be repeated safely; remove it and add the image again');
    const work = (async () => {
      try {
        const bytes = readFileSync(key);
        if (bytes.length !== job.size || imageType(bytes) !== job.type) throw new Error('Imported image is incomplete');
        job.state = 'compressing'; job.runPid = process.pid; job.runUntil = Date.now() + 5 * 60 * 1000; delete job.error; save(job);
        job.output = await upload(bytes, job.type);
        job.state = 'done'; delete job.error; save(job);
        return publicJob(job);
      } catch (error) {
        job.state = isPermissionBlocked(error) ? 'queued' : 'error';
        job.error = error.message || String(error); save(job);
        throw error;
      }
    })();
    running.set(key, work);
    try { return await work; } finally { running.delete(key); }
  };
  const downloadOutput = async job => {
    const key = path(job.id, 'output');
    if (pendingDownloads.has(key)) return pendingDownloads.get(key);
    const work = (async () => {
      // Leave time for validation and chunk delivery within the toolbox's 60-second invocation window.
      const response = await invoke('send_request', {
        url: job.output.url, method: 'GET', withCookies: false, responseType: 'auto', timeout: 45000,
      }, { timeoutSec: 55 });
      if (response.status !== 200 || response.bodyType !== 'base64') throw new Error(`TinyPNG download HTTP ${response.status}`);
      const bytes = decode(response.body, MAX_BYTES);
      if (bytes.length !== job.output.size || imageType(bytes) !== job.output.type) throw new Error('Invalid compressed image');
      return bytes;
    })();
    pendingDownloads.set(key, work);
    try { return await work; } finally { pendingDownloads.delete(key); }
  };
  const releaseResource = ({ readId } = {}) => {
    const key = path(readId, 'resource');
    const resource = resources.get(key);
    if (resource) { clearTimeout(resource.timer); resources.delete(key); }
    return { released: Boolean(resource) };
  };
  const resourceChunk = async ({ id, index, source = 'output', readId } = {}) => {
    const job = read(id);
    if (source !== 'input' && source !== 'output') throw new Error('Invalid image source');
    if (source === 'output' ? !job.output : !job.type || job.received !== job.size) throw new Error('Image is not ready');
    const type = source === 'output' ? job.output.type : job.type;
    const size = source === 'output' ? job.output.size : job.size;
    const chunks = Math.ceil(size / CHUNK_BYTES);
    if (!Number.isSafeInteger(index) || index < 0 || index >= chunks) throw new Error('Invalid resource chunk index');
    let bytes;
    if (source === 'output') {
      if (index === 0) {
        if (readId !== undefined) throw new Error('A new read cannot reuse a resource id');
        bytes = await downloadOutput(job);
        if (chunks > 1) {
          readId = randomUUID();
          const timer = setTimeout(() => releaseResource({ readId }), 60000);
          timer.unref?.();
          resources.set(path(readId, 'resource'), { jobKey: path(id, 'input'), bytes, timer });
        }
      } else {
        const resource = resources.get(path(readId, 'resource'));
        if (!resource || resource.jobKey !== path(id, 'input')) throw new Error('Image read has expired');
        resource.timer.refresh?.();
        bytes = resource.bytes;
      }
      bytes = bytes.subarray(index * CHUNK_BYTES, Math.min(size, (index + 1) * CHUNK_BYTES));
      if (readId && index === chunks - 1) releaseResource({ readId });
    } else {
      bytes = Buffer.alloc(Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES));
      const descriptor = openSync(path(id, 'input'), 'r');
      try {
        if (readSync(descriptor, bytes, 0, bytes.length, index * CHUNK_BYTES) !== bytes.length) throw new Error('Image resource is incomplete');
      } finally { closeSync(descriptor); }
    }
    return { data: bytes.toString('base64'), chunks, type, ...(readId ? { readId } : {}), name: job.name.replace(/\.[^.]+$/, '') + '.' + mimeExtensions[type] };
  };
  const compressBatch = async ({ ids } = {}) => {
    if (!Array.isArray(ids) || ids.length < 1 || new Set(ids).size !== ids.length) {
      throw new Error('Expected unique image ids');
    }
    for (const id of ids) read(id);
    const result = { completed: 0, failed: 0, errors: [] };
    let permissionError;
    for (const id of ids) {
      try {
        if (permissionError && !read(id).output) throw permissionError;
        await compress({ id }); result.completed += 1;
      }
      catch (error) {
        if (isPermissionBlocked(error)) permissionError = error;
        result.failed += 1;
        if (result.errors.length < 10) result.errors.push({ id, error: (error.message || String(error)).slice(0, 500) });
      }
    }
    return result;
  };
  const remove = ({ id, all = false } = {}) => {
    const jobs = all === true ? records() : [read(id)];
    if (jobs.some(job => pendingDownloads.has(path(job.id, 'output')))) throw new Error('Image is still being downloaded');
    if (jobs.some(job => ['compressing', 'downloading'].includes(job.state) && isRunning(job))) throw new Error('Image is still being compressed');
    for (const job of jobs) {
      for (const [key, resource] of resources) {
        if (resource.jobKey === path(job.id, 'input')) {
          clearTimeout(resource.timer); resources.delete(key);
        }
      }
      for (const suffix of ['json', 'input', 'output']) rmSync(path(job.id, suffix), { force: true });
    }
    return { removed: true };
  };
  const file = async ({ filePath, outputPath } = {}) => {
    if (typeof filePath !== 'string' || typeof outputPath !== 'string') throw new Error('filePath and outputPath are required');
    if (resolve(filePath) === resolve(outputPath) || existsSync(outputPath)) throw new Error('outputPath must be a new file');
    const size = statSync(filePath).size;
    if (size < 1 || size > MAX_BYTES) throw new Error('Each image must be between 1 byte and 5 MiB');
    const bytes = readFileSync(filePath), type = imageType(bytes);
    if (bytes.length !== size) throw new Error('Input image changed while reading');
    const job = { id: randomUUID(), name: basename(filePath), size, received: size, type, output: await upload(bytes, type) };
    const compressed = await downloadOutput(job);
    writeFileSync(outputPath, compressed, { flag: 'wx', mode: 0o600 });
    return { name: job.name, size: job.size, type: job.type,
      output: { size: job.output.size, type: job.output.type, width: job.output.width, height: job.output.height },
      outputPath: resolve(outputPath) };
  };
  return { list, begin, append, compress, compressBatch, resourceChunk, releaseResource, remove, file };
}
