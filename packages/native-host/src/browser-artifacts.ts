import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { BrowserArtifact } from '@mearl/browser-core';

const MAX_BYTES = 256 * 1024 * 1024;
export const ARTIFACT_CHUNK_BYTES = 256 * 1024;
interface Artifact extends BrowserArtifact {
  path: string;
  sessionId?: string;
  ready: boolean;
  writing?: boolean;
  accessedAt: number;
}

/** Opaque ids keep browser-host paths out of remote file requests. */
export class BrowserArtifactStore {
  private files = new Map<string, Artifact>();
  private directory?: string;
  private sweeper?: ReturnType<typeof setInterval>;
  constructor(
    private root = path.join(os.tmpdir(), `mearl-artifacts-${process.pid}-${randomUUID()}`),
  ) {}

  async create(filename: string, sessionId?: string): Promise<BrowserArtifact> {
    if (
      typeof filename !== 'string' ||
      !filename ||
      ['.', '..'].includes(filename) ||
      /[\\/]/.test(filename) ||
      filename.length > 255
    )
      throw new Error('Invalid artifact filename');
    if (!this.sweeper) {
      this.sweeper = setInterval(() => {
        for (const [id, file] of this.files)
          if (!file.sessionId && !file.writing && Date.now() - file.accessedAt > 60 * 60 * 1000)
            void this.remove(id).catch(() => {});
      }, 60000);
      this.sweeper.unref();
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.directory = this.root;
    const artifactId = randomUUID();
    const directory = path.join(this.root, artifactId);
    await mkdir(directory, { mode: 0o700 });
    const file: Artifact = {
      artifactId,
      filename,
      bytes: 0,
      location: 'browser',
      path: path.join(directory, filename),
      sessionId,
      ready: false,
      accessedAt: Date.now(),
    };
    await writeFile(file.path, '', { mode: 0o600 });
    this.files.set(artifactId, file);
    return this.info(file);
  }

  async importFile(
    filename: string,
    sourcePath: string,
    sessionId?: string,
  ): Promise<BrowserArtifact> {
    const source = await open(sourcePath, 'r');
    let id: string | undefined;
    try {
      const metadata = await source.stat();
      if (!metadata.isFile() || metadata.size > MAX_BYTES)
        throw new Error('Download is unavailable or exceeds 256 MiB');
      const artifact = await this.create(filename, sessionId);
      id = artifact.artifactId;
      const file = this.require(id, sessionId);
      const target = await open(file.path, 'w');
      let copied = 0;
      try {
        for await (const chunk of source.createReadStream({ autoClose: false })) {
          copied += chunk.length;
          if (copied > MAX_BYTES) throw new Error('Download exceeds 256 MiB');
          let written = 0;
          while (written < chunk.length) {
            const result = await target.write(chunk, written, chunk.length - written);
            if (!result.bytesWritten) throw new Error('Download import made no progress');
            written += result.bytesWritten;
          }
        }
      } finally {
        await target.close();
      }
      if (copied !== metadata.size) throw new Error('Download changed during import');
      file.bytes = (await stat(file.path)).size;
      file.ready = true;
      return this.info(file);
    } catch (error) {
      if (id) await this.remove(id, sessionId);
      throw error;
    } finally {
      await source.close();
    }
  }

  private require(id: string, sessionId?: string): Artifact {
    const file = this.files.get(id);
    if (!file || (file.sessionId !== undefined && file.sessionId !== sessionId))
      throw new Error('ARTIFACT_NOT_FOUND');
    file.accessedAt = Date.now();
    return file;
  }

  private info(file: Artifact): BrowserArtifact {
    return {
      artifactId: file.artifactId,
      filename: file.filename,
      bytes: file.bytes,
      location: 'browser',
    };
  }

  async write(
    id: string,
    offset: number,
    base64: string,
    sessionId?: string,
  ): Promise<BrowserArtifact> {
    const file = this.require(id, sessionId);
    if (file.ready || file.writing || offset !== file.bytes)
      throw new Error('Invalid artifact write offset or completed transfer');
    if (
      typeof base64 !== 'string' ||
      base64.length > Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    )
      throw new Error('Invalid artifact chunk');
    const chunk = Buffer.from(base64, 'base64');
    if (chunk.toString('base64') !== base64) throw new Error('Invalid artifact chunk');
    if (file.bytes + chunk.length > MAX_BYTES) throw new Error('Artifact exceeds 256 MiB');
    file.writing = true;
    try {
      const handle = await open(file.path, 'r+');
      try {
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(
            chunk,
            written,
            chunk.length - written,
            offset + written,
          );
          if (!result.bytesWritten) throw new Error('Artifact write made no progress');
          written += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }
      file.bytes += chunk.length;
      return this.info(file);
    } finally {
      file.writing = false;
    }
  }

  complete(id: string, bytes: number, sessionId?: string): BrowserArtifact {
    const file = this.require(id, sessionId);
    if (file.writing || bytes !== file.bytes) throw new Error('Artifact size mismatch');
    file.ready = true;
    return this.info(file);
  }

  resolve(id: string, sessionId?: string): string {
    const file = this.require(id, sessionId);
    if (!file.ready) throw new Error('Artifact is not ready');
    return file.path;
  }

  async read(
    id: string,
    offset: number,
    sessionId?: string,
  ): Promise<{ base64: string; bytes: number; totalBytes: number }> {
    const file = this.require(id, sessionId);
    if (!file.ready || !Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes)
      throw new Error('Invalid artifact read');
    const handle = await open(file.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(ARTIFACT_CHUNK_BYTES, file.bytes - offset));
      const result = await handle.read(buffer, 0, buffer.length, offset);
      return {
        base64: buffer.subarray(0, result.bytesRead).toString('base64'),
        bytes: result.bytesRead,
        totalBytes: file.bytes,
      };
    } finally {
      await handle.close();
    }
  }

  async remove(id: string, sessionId?: string): Promise<void> {
    const file = this.require(id, sessionId);
    await rm(path.dirname(file.path), { recursive: true, force: true });
    this.files.delete(id);
  }

  async release(sessionId: string, keep: string[] = []): Promise<void> {
    const retain = new Set(keep);
    for (const [id, file] of this.files) {
      if (file.sessionId !== sessionId) continue;
      if (retain.has(id)) {
        file.sessionId = undefined;
        file.accessedAt = Date.now();
      } else await this.remove(id, sessionId);
    }
  }

  disposeSync(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.files.clear();
  }

  async dispose(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.files.clear();
  }
}
