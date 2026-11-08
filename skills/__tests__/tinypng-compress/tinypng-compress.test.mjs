import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_BYTES, MAX_BYTES, createCommands, outputMetadata } from '../../tinypng-compress/scripts/commands.mjs';
import register, { toolbox } from '../../tinypng-compress/scripts/main.mjs';

const directories = [];
afterEach(() => { vi.useRealTimers(); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
const png = size => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(size - 8, 255)]);
const output = png(32);
function setup(respond) {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-compress-')); directories.push(directory);
  const invoke = vi.fn(respond || (async (_action, request) => request.method === 'POST' ? {
    status: 201, body: { input: { size: Buffer.from(request.bodyFile.base64, 'base64').length }, output: { size: output.length, width: 96, height: 96, type: 'image/png', url: 'https://tinify.cn/backend/opt/output/test123' } },
  } : { status: 200, bodyType: 'base64', body: output.toString('base64') }));
  return { directory, invoke, commands: createCommands(invoke, { directory }) };
}
function importImage(commands, bytes = png(200)) {
  const job = commands.begin({ name: '图片.png', size: bytes.length });
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index += 1) commands.append({ id: job.id, index, data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
  return job;
}

describe('image compression plugin', () => {
  it('registers both toolbox modes and keeps local paths outside the page whitelist', () => {
    const invoke = vi.fn(), command = vi.fn(), toolboxCommand = vi.fn(); register({ invoke, command, toolboxCommand });
    expect(toolbox.displayMode ?? 'both').toBe('both');
    expect(toolbox.page.commands).not.toContain('file');
    expect(command.mock.calls.map(([name]) => name)).toEqual(['file']);
    expect(toolboxCommand.mock.calls.map(([name]) => name)).toEqual(['list', 'begin', 'append', 'compress', 'compress-batch', 'resource-chunk', 'release-resource', 'remove']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('compresses without downloading and consumes downloads without saving result copies', async () => {
    const { commands, invoke, directory } = setup(); const bytes = png(CHUNK_BYTES + 29);
    const job = importImage(commands, bytes);
    const [first, second] = await Promise.all([commands.compress({ id: job.id }), commands.compress({ id: job.id })]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: 'done', size: bytes.length, output: { size: 32, width: 96, height: 96 } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, `${job.id}.output`))).toBe(false);
    const [action, request] = invoke.mock.calls[0];
    expect(action).toBe('send_request'); expect(request.url).toBe('https://tinify.cn/backend/opt/shrink');
    expect(request.bodyFile.contentType).toBe('image/png');
    expect(Buffer.from(request.bodyFile.base64, 'base64')).toEqual(bytes);
    expect(request.files).toBeUndefined();
    await expect(commands.resourceChunk({ id: job.id, index: 9 })).rejects.toThrow('chunk index');
    expect(invoke).toHaveBeenCalledTimes(1);
    const [chunk, secondChunk] = await Promise.all([
      commands.resourceChunk({ id: job.id, index: 0 }), commands.resourceChunk({ id: job.id, index: 0 }),
    ]);
    expect(invoke.mock.calls[1][1]).toMatchObject({ method: 'GET', withCookies: false });
    expect(Buffer.from(chunk.data, 'base64')).toEqual(output);
    expect(secondChunk).toEqual(chunk);
    await commands.compress({ id: job.id });
    await createCommands(invoke, { directory }).resourceChunk({ id: job.id, index: 0 });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(existsSync(join(directory, `${job.id}.output`))).toBe(false);
  });

  it('releases chunked results after consumption, explicit cancellation or idle expiry', async () => {
    vi.useFakeTimers();
    const bytes = png(CHUNK_BYTES + 29);
    const { commands, invoke, directory } = setup(async (_action, request) => request.method === 'POST' ? {
      status: 201, body: { input: { size: 200 }, output: { size: bytes.length, width: 96, height: 96, type: 'image/png', url: 'https://tinify.cn/backend/opt/output/test123' } },
    } : { status: 200, bodyType: 'base64', body: bytes.toString('base64') });
    const job = importImage(commands);
    await commands.compress({ id: job.id });
    const [first, parallel] = await Promise.all([
      commands.resourceChunk({ id: job.id, index: 0 }), commands.resourceChunk({ id: job.id, index: 0 }),
    ]);
    expect(first.readId).not.toBe(parallel.readId);
    const last = await createCommands(invoke, { directory }).resourceChunk({ id: job.id, index: 1, readId: first.readId });
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')])).toEqual(bytes);
    expect(commands.releaseResource({ readId: first.readId })).toEqual({ released: false });
    await expect(commands.resourceChunk({ id: job.id, index: 1, readId: first.readId })).rejects.toThrow('expired');
    const parallelLast = await commands.resourceChunk({ id: job.id, index: 1, readId: parallel.readId });
    expect(parallelLast.data).toBe(last.data);
    expect(commands.releaseResource({ readId: parallel.readId })).toEqual({ released: false });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(existsSync(join(directory, `${job.id}.output`))).toBe(false);

    const cancelled = await commands.resourceChunk({ id: job.id, index: 0 });
    expect(commands.releaseResource({ readId: cancelled.readId })).toEqual({ released: true });
    await expect(commands.resourceChunk({ id: job.id, index: 1, readId: cancelled.readId })).rejects.toThrow('expired');
    const abandoned = await commands.resourceChunk({ id: job.id, index: 0 });
    vi.advanceTimersByTime(60000);
    await expect(commands.resourceChunk({ id: job.id, index: 1, readId: abandoned.readId })).rejects.toThrow('expired');
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('persists successful uploads so download retries never upload again', async () => {
    const { commands, invoke, directory } = setup(); const original = invoke.getMockImplementation();
    let fail = true;
    invoke.mockImplementation(async (action, request) => {
      if (request.method === 'GET' && fail) throw new Error('Network unavailable');
      return original(action, request);
    });
    const job = importImage(commands);
    await commands.compress({ id: job.id });
    await expect(commands.resourceChunk({ id: job.id, index: 0 })).rejects.toThrow('Network unavailable');
    expect(commands.list().jobs[0]).toMatchObject({ state: 'done' });
    expect(commands.list().jobs[0].error).toBeUndefined();
    fail = false;
    await createCommands(invoke, { directory }).resourceChunk({ id: job.id, index: 0 });
    expect(invoke.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1);
    expect(commands.list().jobs[0].state).toBe('done');
  });

  it('does not retry an upload whose result is uncertain', async () => {
    const { commands, invoke } = setup(async () => { throw new Error('Upload timeout'); });
    const job = importImage(commands);
    await expect(commands.compress({ id: job.id })).rejects.toThrow('Upload timeout');
    await expect(commands.compress({ id: job.id })).rejects.toThrow('cannot be repeated safely');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps permission-blocked uploads queued, stops the batch and allows explicit resume', async () => {
    const { commands, invoke } = setup();
    const blocked = Object.assign(new Error('Domain permission was not granted'), {
      code: 'DOMAIN_PERMISSION_REQUIRED', requestDispatched: false,
    });
    invoke.mockRejectedValueOnce(blocked);
    const first = importImage(commands), second = importImage(commands);
    const result = await commands.compressBatch({ ids: [first.id, second.id] });
    expect(result).toMatchObject({ completed: 0, failed: 2 });
    expect(result.errors.map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(commands.list().jobs.every(job => job.state === 'queued')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('send_request');
    await expect(commands.compress({ id: first.id })).resolves.toMatchObject({ state: 'done' });
  });

  it('counts completed images in a batch even after another image is blocked by permission', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { commands, invoke } = setup();
    const first = importImage(commands), completed = importImage(commands), last = importImage(commands);
    await commands.compress({ id: completed.id });
    invoke.mockClear().mockRejectedValueOnce(Object.assign(new Error('Domain permission was not granted'), {
      code: 'DOMAIN_PERMISSION_REQUIRED', requestDispatched: false,
    }));
    await expect(commands.compressBatch({ ids: [first.id, completed.id, last.id] })).resolves.toMatchObject({
      completed: 1, failed: 2, errors: [{ id: first.id }, { id: last.id }],
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(Object.fromEntries(commands.list().jobs.map(job => [job.id, job.state]))).toEqual({
      [first.id]: 'queued', [completed.id]: 'done', [last.id]: 'queued',
    });
  });

  it.each([
    new Error('__send_request_files: Access to "tinify.cn" is not authorized.'),
    Object.assign(new Error('Permission denied after dispatch'), { code: 'DOMAIN_PERMISSION_REQUIRED', requestDispatched: true }),
    Object.assign(new Error('Request failed'), { code: 'OTHER_ERROR', requestDispatched: false }),
  ])('does not infer a safe retry from unstructured or dispatched errors: %s', async error => {
    const { commands, invoke } = setup(async () => { throw error; });
    const job = importImage(commands);
    await expect(commands.compress({ id: job.id })).rejects.toThrow(error.message);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(commands.list().jobs[0].state).toBe('error');
    await expect(commands.compress({ id: job.id })).rejects.toThrow('cannot be repeated safely');
  });

  it('leaves CLI authorization to the caller without requesting permission or writing output', async () => {
    const { commands, directory, invoke } = setup(async () => {
      throw new Error('__send_request_files: Access to "tinify.cn" is not authorized.');
    });
    const source = join(directory, 'original.png'), destination = join(directory, 'compressed.png');
    writeFileSync(source, png(200));
    await expect(commands.file({ filePath: source, outputPath: destination })).rejects.toThrow('not authorized');
    expect(existsSync(destination)).toBe(false);
    expect(commands.list().jobs).toEqual([]);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['send_request']);
  });

  it('processes a batch sequentially and continues after a failed upload', async () => {
    const { commands, invoke } = setup();
    const first = importImage(commands), second = importImage(commands);
    const original = invoke.getMockImplementation();
    invoke.mockRejectedValueOnce(new Error('First upload failed')).mockImplementation(original);
    const result = await commands.compressBatch({ ids: [first.id, second.id] });
    expect(result).toEqual({ completed: 1, failed: 1, errors: [{ id: first.id, error: 'First upload failed' }] });
    expect(invoke).toHaveBeenCalledTimes(2);
    await expect(commands.compressBatch({ ids: [first.id, first.id] })).rejects.toThrow('unique');
    await expect(commands.compressBatch({ ids: [second.id, '../other'] })).rejects.toThrow('Invalid image id');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid files, out-of-order chunks, oversize inputs and traversal before sending', () => {
    const { commands, invoke } = setup();
    expect(() => commands.begin({ name: 'x.png', size: MAX_BYTES + 1 })).toThrow('5 MiB');
    const job = commands.begin({ name: 'x.png', size: 4 });
    expect(() => commands.append({ id: job.id, index: 1, data: 'YWJjZA==' })).toThrow('Unexpected');
    expect(() => commands.append({ id: job.id, index: 0, data: 'not base64' })).toThrow('Invalid');
    expect(() => commands.append({ id: job.id, index: 0, data: 'YWJjZA==' })).toThrow('Expected PNG');
    expect(() => commands.remove({ id: '../secrets' })).toThrow('Invalid image id');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('handles the largest accepted image without overflowing Base64 validation', async () => {
    const { commands } = setup(); const job = importImage(commands, png(MAX_BYTES));
    await expect(commands.compress({ id: job.id })).resolves.toMatchObject({ state: 'done', size: MAX_BYTES });
  });

  it('persists bounded PNG thumbnails and rejects full-size images in thumbnail metadata', () => {
    const { commands } = setup();
    const image = png(32); image.write('IHDR', 12, 'ascii'); image.writeUInt32BE(32, 16); image.writeUInt32BE(32, 20);
    const thumbnail = 'data:image/png;base64,' + image.toString('base64');
    const job = commands.begin({ name: 'image.png', size: 200, thumbnail });
    expect(commands.list().jobs[0]).toMatchObject({ id: job.id, thumbnail });
    image.writeUInt32BE(2000, 16);
    expect(() => commands.begin({ name: 'image.png', size: 200, thumbnail: 'data:image/png;base64,' + image.toString('base64') })).toThrow('dimensions');
    expect(() => commands.begin({ name: 'image.png', size: 200, thumbnail: 'https://example.test/image.png' })).toThrow('thumbnail');
  });

  it.each(['https://evil.test/backend/opt/output/test', 'https://tinify.cn.evil.test/backend/opt/output/test', 'https://user@tinify.cn/backend/opt/output/test', 'https://tinify.cn/backend/opt/output/test?x=1', 'https://tinify.cn/other'])('rejects foreign output URL %s', url => {
    expect(() => outputMetadata({ status: 201, body: { input: { size: 200 }, output: { size: 32, width: 1, height: 1, type: 'image/png', url } } }, 200)).toThrow('output URL');
  });

  it('paginates a cache above 20 images and clears only its own copies', async () => {
    const { commands, directory } = setup();
    const original = join(directory, 'original.png'); writeFileSync(original, output);
    const jobs = Array.from({ length: 75 }, () => commands.begin({ name: 'x.png', size: 32 }));
    expect(commands.list()).toMatchObject({ total: 75, nextOffset: 50 });
    expect(commands.list().jobs).toHaveLength(50);
    expect(commands.list({ offset: 50 }).jobs).toHaveLength(25);
    commands.remove({ id: jobs[0].id });
    expect(commands.list().total).toBe(74);
    commands.remove({ all: true });
    expect(commands.list().jobs).toEqual([]);
    expect(readFileSync(original)).toEqual(output);
  });

  it('compresses batches larger than 20 and previews original bytes before completion', async () => {
    const { commands, invoke } = setup();
    const jobs = Array.from({ length: 25 }, () => importImage(commands));
    expect(Buffer.from((await commands.resourceChunk({ id: jobs[0].id, index: 0, source: 'input' })).data, 'base64')).toEqual(png(200));
    await expect(commands.resourceChunk({ id: jobs[0].id, index: 0, source: '../file' })).rejects.toThrow('Invalid image source');
    await expect(commands.compressBatch({ ids: jobs.map(job => job.id) })).resolves.toEqual({ completed: 25, failed: 0, errors: [] });
    expect(invoke).toHaveBeenCalledTimes(25);
    expect(commands.list().summary).toMatchObject({ done: 25, originalBytes: 5000, outputBytes: 800 });
  });

  it('exports CLI output without overwriting originals or existing destinations', async () => {
    const { commands, directory, invoke } = setup();
    const source = join(directory, 'original.png'), destination = join(directory, 'compressed.png');
    writeFileSync(source, png(200));
    const respond = invoke.getMockImplementation();
    invoke.mockImplementation(async (action, request) => {
      expect(readdirSync(directory)).toEqual(['original.png']);
      return respond(action, request);
    });
    await expect(commands.file({ filePath: source, outputPath: source })).rejects.toThrow('new file');
    expect(invoke).not.toHaveBeenCalled();
    await expect(commands.file({ filePath: source, outputPath: destination })).resolves.toEqual({ name: 'original.png', size: 200, type: 'image/png',
      output: { size: 32, type: 'image/png', width: 96, height: 96 }, outputPath: destination });
    expect(readFileSync(destination)).toEqual(output); expect(readFileSync(source).length).toBe(200);
    expect(readdirSync(directory).sort()).toEqual(['compressed.png', 'original.png']);
    expect(commands.list().jobs).toEqual([]);
    await expect(commands.file({ filePath: source, outputPath: destination })).rejects.toThrow('new file');
  });

  it('leaves no CLI task records or result copies when downloading fails', async () => {
    const { commands, directory, invoke } = setup();
    const source = join(directory, 'original.png'), destination = join(directory, 'compressed.png');
    writeFileSync(source, png(200));
    const respond = invoke.getMockImplementation();
    invoke.mockImplementation((action, request) => {
      if (request.method === 'GET') throw new Error('Download failed');
      return respond(action, request);
    });
    await expect(commands.file({ filePath: source, outputPath: destination })).rejects.toThrow('Download failed');
    expect(readdirSync(directory)).toEqual(['original.png']);
    expect(readFileSync(source)).toEqual(png(200));
  });
});
