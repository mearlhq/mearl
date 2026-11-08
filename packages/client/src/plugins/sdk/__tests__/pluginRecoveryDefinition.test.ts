import { describe, expect, it } from 'vitest';
import { normalizePluginTaskRecovery } from '../pluginRecoveryDefinition.js';

describe('checkpoint recovery declarations', () => {
  const declaration = (migrateFrom: unknown) => ({
    version: 1,
    commands: {
      work: {
        checkpointVersion: 2,
        schema: { type: 'string' },
        migrateFrom,
      },
    },
  });

  it('checks migration declaration shapes and requires distinct older format versions', () => {
    const valid = declaration([{ version: 1, schema: { type: 'integer' } }]);
    expect(normalizePluginTaskRecovery(valid)).toEqual(valid);
    for (const sources of [
      [],
      {},
      [{ version: 2, schema: {} }],
      [{ version: 3, schema: {} }],
      [
        { version: 1, schema: {} },
        { version: 1, schema: {} },
      ],
      [{ version: 1, schema: { $async: true } }],
      [{ version: 1, schema: [] }],
      [{ version: 1, schema: null }],
    ])
      expect(() => normalizePluginTaskRecovery(declaration(sources))).toThrow();
  });
});
