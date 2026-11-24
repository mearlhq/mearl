import { createHash, randomUUID } from 'node:crypto';
import {
  TOOLBOX_RESULT_CHUNK_BYTES,
  TOOLBOX_RESULT_MAX_BYTES,
  type ToolboxJsonReply,
  type ToolboxResultChunk,
  type ToolboxResultReference,
} from '@mearl/browser-core';

/** Bounds native-messaging replies independently of the local service transport. */
export class PluginPageResults {
  private readonly values = new Map<
    string,
    { scope: string; bytes: Buffer; sha256: string; expiry: NodeJS.Timeout }
  >();

  wrap(scope: string, value: unknown): ToolboxJsonReply {
    const bytes = Buffer.from(JSON.stringify(value ?? null));
    if (bytes.length <= TOOLBOX_RESULT_CHUNK_BYTES) return { kind: 'value', value: value ?? null };
    return this.store(scope, bytes);
  }

  store(scope: string, bytes: Buffer): ToolboxResultReference {
    if (
      bytes.length > TOOLBOX_RESULT_MAX_BYTES ||
      this.values.size >= 8 ||
      [...this.values.values()].reduce((sum, value) => sum + value.bytes.length, bytes.length) >
        32 * 1024 * 1024
    )
      throw new Error('Toolbox reply exceeds resource limits');
    const resultId = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const expiry = setTimeout(() => this.values.delete(resultId), 30_000).unref();
    this.values.set(resultId, { scope, bytes, sha256, expiry });
    return {
      kind: 'resource',
      resultId,
      bytes: bytes.length,
      chunks: Math.ceil(bytes.length / TOOLBOX_RESULT_CHUNK_BYTES),
      sha256,
    };
  }
  read(
    scope: string,
    operation: string,
    input: Record<string, unknown>,
  ): ToolboxResultChunk | { released: true } {
    const { resultId, index } = input;
    const value = typeof resultId === 'string' ? this.values.get(resultId) : undefined;
    if (!value || value.scope !== scope || typeof resultId !== 'string')
      throw new Error('Toolbox reply was not found');
    if (operation === 'result_release') {
      clearTimeout(value.expiry);
      this.values.delete(resultId);
      return { released: true };
    }
    const chunks = Math.ceil(value.bytes.length / TOOLBOX_RESULT_CHUNK_BYTES);
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= chunks)
      throw new Error('Invalid toolbox reply chunk');
    value.expiry.refresh();
    return {
      resultId,
      bytes: value.bytes.length,
      chunks,
      sha256: value.sha256,
      index,
      data: value.bytes
        .subarray(index * TOOLBOX_RESULT_CHUNK_BYTES, (index + 1) * TOOLBOX_RESULT_CHUNK_BYTES)
        .toString('base64'),
    };
  }
}

export const pluginPageResults = new PluginPageResults();
