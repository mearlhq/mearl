import { open, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserArtifact } from '@mearl/browser-core';
import type { UnifiedInvokeOptions } from './unified.js';

interface Invoker {
  invoke(action: string, data?: Record<string, any>, options?: UnifiedInvokeOptions): Promise<any>;
}
const CHUNK_BYTES = 256 * 1024;

export async function stageFile(client: Invoker, filePath: string, options: UnifiedInvokeOptions) {
  if (!path.isAbsolute(filePath)) throw new Error('Caller-local file paths must be absolute');
  const source = await open(filePath, 'r');
  let id: string | undefined;
  let pinned = options;
  try {
    const metadata = await source.stat();
    if (!metadata.isFile() || metadata.size > 256 * 1024 * 1024)
      throw new Error('Upload requires a regular file of at most 256 MiB');
    const created = await client.invoke(
      '__artifact_init',
      { filename: path.basename(filePath) },
      options,
    );
    pinned = { ...options, browser: created.browserId };
    id = created.artifact.artifactId;
    let offset = 0;
    for await (const chunk of source.createReadStream({
      highWaterMark: CHUNK_BYTES,
      autoClose: false,
    })) {
      await client.invoke(
        '__artifact_write',
        { artifactId: id, offset, base64: chunk.toString('base64') },
        pinned,
      );
      offset += chunk.length;
    }
    await client.invoke('__artifact_complete', { artifactId: id, bytes: offset }, pinned);
    return { artifactId: id!, options: pinned };
  } catch (error) {
    if (id) await client.invoke('__artifact_remove', { artifactId: id }, pinned).catch(() => {});
    throw error;
  } finally {
    await source.close();
  }
}

/** Atomically export browser-host data to the calling machine without large JSON responses. */
export async function exportArtifact(
  client: Invoker,
  artifact: BrowserArtifact & { browserId?: string },
  outputPath: string,
  options: UnifiedInvokeOptions = {},
) {
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)
    throw new Error('Invalid artifact size');
  if (!path.isAbsolute(outputPath)) throw new Error('Artifact output paths must be absolute');
  if (!options.session && !artifact.browserId && !options.browser)
    throw new Error('An artifact requires its originating browser');
  const pinned = { ...options, ...(artifact.browserId ? { browser: artifact.browserId } : {}) };
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.part`;
  const target = await open(temporary, 'wx', 0o600);
  try {
    let offset = 0;
    if (artifact.bytes === 0) {
      const empty = await client.invoke(
        '__artifact_read',
        { artifactId: artifact.artifactId, offset: 0 },
        pinned,
      );
      if (empty.totalBytes !== 0 || empty.bytes !== 0 || empty.base64 !== '')
        throw new Error('Artifact export size mismatch');
    }
    while (offset < artifact.bytes) {
      const chunk = await client.invoke(
        '__artifact_read',
        { artifactId: artifact.artifactId, offset },
        pinned,
      );
      const bytes = Buffer.from(chunk.base64, 'base64');
      if (
        !bytes.length ||
        bytes.length !== chunk.bytes ||
        chunk.totalBytes !== artifact.bytes ||
        offset + bytes.length > artifact.bytes
      )
        throw new Error('Invalid artifact chunk or truncated transfer');
      await target.write(bytes);
      offset += bytes.length;
    }
    await target.sync();
    await target.close();
    if ((await stat(temporary)).size !== artifact.bytes)
      throw new Error('Artifact export size mismatch');
    await rename(temporary, outputPath);
    return { outputPath, bytes: artifact.bytes };
  } catch (error) {
    await target.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}
