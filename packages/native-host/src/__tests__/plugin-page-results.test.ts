import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PluginPageResults } from '../plugin-page-results';

describe('native page reply resources', () => {
  it('bounds replies, preserves Unicode, isolates plugins and releases resources', () => {
    const store = new PluginPageResults();
    expect(store.wrap('one', { kind: 'resource', value: 1 })).toEqual({
      kind: 'value',
      value: { kind: 'resource', value: 1 },
    });
    const value = { text: '设计😀'.repeat(60000) };
    const reference = store.wrap('one', value) as any;
    expect(reference.kind).toBe('resource');
    expect(() =>
      store.read('other', 'result_chunk', { resultId: reference.resultId, index: 0 }),
    ).toThrow('not found');
    const parts = [];
    for (let index = 0; index < reference.chunks; index++) {
      const chunk = store.read('one', 'result_chunk', {
        resultId: reference.resultId,
        index,
      }) as any;
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(300000);
      parts.push(Buffer.from(chunk.data, 'base64'));
    }
    const bytes = Buffer.concat(parts);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sha256);
    expect(JSON.parse(bytes.toString())).toEqual(value);
    store.read('one', 'result_release', { resultId: reference.resultId });
    expect(() =>
      store.read('one', 'result_chunk', { resultId: reference.resultId, index: 0 }),
    ).toThrow('not found');
    expect(() => store.wrap('one', 'x'.repeat(24 * 1024 * 1024))).toThrow('resource limits');
  });
});
