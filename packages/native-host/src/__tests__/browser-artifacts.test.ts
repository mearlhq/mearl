import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserArtifactStore, ARTIFACT_CHUNK_BYTES } from '../browser-artifacts.js';

const stores: BrowserArtifactStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
});
describe('browser artifacts', () => {
  it('round trips a binary file larger than the cloud message limit in bounded chunks', async () => {
    const store = new BrowserArtifactStore();
    stores.push(store);
    const input = Buffer.alloc(11 * 1024 * 1024 + 3);
    for (let i = 0; i < input.length; i++) input[i] = i % 251;
    const artifact = await store.create('report.bin', 'session');
    for (let offset = 0; offset < input.length; offset += ARTIFACT_CHUNK_BYTES) {
      await store.write(
        artifact.artifactId,
        offset,
        input.subarray(offset, offset + ARTIFACT_CHUNK_BYTES).toString('base64'),
        'session',
      );
    }
    store.complete(artifact.artifactId, input.length, 'session');
    expect(path.basename(store.resolve(artifact.artifactId, 'session'))).toBe('report.bin');
    expect((await readFile(store.resolve(artifact.artifactId, 'session'))).equals(input)).toBe(
      true,
    );
    const chunks = [];
    for (let offset = 0; offset < input.length; offset += ARTIFACT_CHUNK_BYTES) {
      const chunk = await store.read(artifact.artifactId, offset, 'session');
      expect(chunk.bytes).toBeLessThanOrEqual(ARTIFACT_CHUNK_BYTES);
      chunks.push(Buffer.from(chunk.base64, 'base64'));
    }
    expect(Buffer.concat(chunks).equals(input)).toBe(true);
    await expect(store.read(artifact.artifactId, 0, 'other')).rejects.toThrow('ARTIFACT_NOT_FOUND');
    await store.release('session');
    expect(() => store.resolve(artifact.artifactId, 'session')).toThrow('ARTIFACT_NOT_FOUND');
  });

  it('rejects path traversal, out-of-order writes, premature reads and mismatched completion', async () => {
    const store = new BrowserArtifactStore();
    stores.push(store);
    await expect(store.create('../bad')).rejects.toThrow('filename');
    const file = await store.create('input.txt');
    await expect(store.write(file.artifactId, 1, 'YQ==')).rejects.toThrow('offset');
    await expect(store.read(file.artifactId, 0)).rejects.toThrow('read');
    await store.write(file.artifactId, 0, 'YQ==');
    expect(() => store.complete(file.artifactId, 2)).toThrow('size mismatch');
    store.complete(file.artifactId, 1);
    await expect(store.write(file.artifactId, 1, 'YQ==')).rejects.toThrow('completed');
  });

  it('copies a completed download without deleting the original browser file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mearl-download-test-'));
    const store = new BrowserArtifactStore();
    stores.push(store);
    try {
      const source = path.join(directory, 'result.csv');
      await writeFile(source, 'name,value\na,1');
      const artifact = await store.importFile('result.csv', source, 'session');
      await store.release('session', [artifact.artifactId]);
      expect(await readFile(store.resolve(artifact.artifactId, 'session'), 'utf8')).toBe(
        'name,value\na,1',
      );
      expect(await readFile(source, 'utf8')).toBe('name,value\na,1');
      expect(await readFile(store.resolve(artifact.artifactId, 'next-session'), 'utf8')).toBe(
        'name,value\na,1',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
