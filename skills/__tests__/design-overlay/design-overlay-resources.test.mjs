import { describe, expect, it, vi } from 'vitest';
import { createAssetStore, MAX_ASSET_BYTES, RESOURCE_CHUNK_BYTES } from '../../design-overlay/scripts/assets.mjs';
import { memoryState } from './memory-state.mjs';

describe('bounded session resource reads', () => {
  it('releases upload chunks once before allocating the completed resource', async () => {
    const state = vi.fn(memoryState()), store = createAssetStore(state, () => 'test-tab');
    const { uploadId } = await store.begin({ chunks: 1 });
    state.mockClear();
    const result = await store.append({ uploadId, index: 0, data: '<svg/>' });
    expect(state.mock.calls.filter(([, operation]) => operation === 'get-many')).toHaveLength(1);
    expect(await store.read(result.resource.id)).toBe('<svg/>');
  });
  it('reads only the requested chunk and preserves split UTF-8 characters', async () => {
    const state = vi.fn(memoryState()), store = createAssetStore(state, () => 'test-tab');
    const content = '<svg>' + ' '.repeat(RESOURCE_CHUNK_BYTES - 6) + '😀设计' + ' '.repeat(1024 * 1024) + '</svg>';
    const reference = await store.save(content);
    state.mockClear();
    const parts = [];
    for (let index = 0; index < reference.chunks; index++) {
      const chunk = await createAssetStore(state, () => 'test-tab').chunk({ id: reference.id, index });
      expect(chunk.encoding).toBe('base64');
      expect(chunk.bytes).toBe(Buffer.byteLength(content));
      expect(Buffer.from(chunk.data, 'base64').length).toBeLessThanOrEqual(RESOURCE_CHUNK_BYTES);
      parts.push(Buffer.from(chunk.data, 'base64'));
    }
    expect(Buffer.concat(parts).toString('utf8')).toBe(content);
    expect(state).toHaveBeenCalledTimes(reference.chunks * 2);
    expect(state.mock.calls.every(([, operation]) => operation === 'get')).toBe(true);
  });

  it('rejects invalid ranges and oversized content', async () => {
    const store = createAssetStore(memoryState(), () => 'test-tab'), reference = await store.save('<svg/>');
    await expect(store.chunk({ id: reference.id, index: reference.chunks })).rejects.toThrow('chunk index');
    await expect(store.save('a'.repeat(17 * 1024 * 1024))).rejects.toThrow('16 MiB');
  });
});

it('retains the full 16 MiB resource boundary in session memory', async () => {
  const store = createAssetStore(memoryState(), () => 'test-tab');
  const content = '<svg>' + 'a'.repeat(MAX_ASSET_BYTES - 11) + '</svg>';
  const resource = await store.save(content);
  await store.pin(resource.id);
  const last = await store.chunk({ id: resource.id, index: resource.chunks - 1 });
  expect(last.bytes).toBe(MAX_ASSET_BYTES);
  expect(Buffer.from(last.data, 'base64').toString('utf8').endsWith('</svg>')).toBe(true);
});
