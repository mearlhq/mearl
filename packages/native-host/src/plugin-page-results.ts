import { createHash, randomUUID } from 'node:crypto';

/** Bounds native-messaging replies independently of the local service transport. */
export class PluginPageResults {
  private readonly values = new Map<
    string,
    { plugin: string; bytes: Buffer; sha256: string; updatedAt: number }
  >();
  private prune(): void {
    for (const [id, value] of this.values)
      if (Date.now() - value.updatedAt > 30000) this.values.delete(id);
  }
  wrap(plugin: string, value: unknown): unknown {
    this.prune();
    const bytes = Buffer.from(JSON.stringify(value ?? null));
    if (bytes.length <= 192 * 1024) return { kind: 'value', value: value ?? null };
    if (
      bytes.length > 24 * 1024 * 1024 ||
      this.values.size >= 8 ||
      [...this.values.values()].reduce((sum, value) => sum + value.bytes.length, bytes.length) >
        32 * 1024 * 1024
    )
      throw new Error('Plugin page reply exceeds resource limits');
    const resultId = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.values.set(resultId, { plugin, bytes, sha256, updatedAt: Date.now() });
    return {
      kind: 'resource',
      resultId,
      bytes: bytes.length,
      chunks: Math.ceil(bytes.length / (192 * 1024)),
      sha256,
    };
  }
  read(plugin: string, operation: string, input: Record<string, any>): unknown {
    this.prune();
    const value = this.values.get(input.resultId);
    if (!value || value.plugin !== plugin) throw new Error('Plugin page reply was not found');
    if (operation === 'result_release') {
      this.values.delete(input.resultId);
      return { released: true };
    }
    const chunks = Math.ceil(value.bytes.length / (192 * 1024));
    if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= chunks)
      throw new Error('Invalid page reply chunk');
    value.updatedAt = Date.now();
    return {
      resultId: input.resultId,
      bytes: value.bytes.length,
      chunks,
      sha256: value.sha256,
      index: input.index,
      data: value.bytes
        .subarray(input.index * 192 * 1024, (input.index + 1) * 192 * 1024)
        .toString('base64'),
    };
  }
}
