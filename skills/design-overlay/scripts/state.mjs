export const stateStorage = {
  version: 1,
  collections: {
    resources: { scope: 'browser-session', storage: 'memory', schemaVersion: 1, maxEntries: 4096, maxBytes: 96 * 1024 * 1024, schema: { type: 'object' } },
    settings: { scope: 'browser-session', storage: 'memory', schemaVersion: 1, ttlMs: 7 * 86400_000, maxEntries: 1024, maxBytes: 8 * 1024 * 1024,
      schema: { type: 'object', additionalProperties: false, required: ['url', 'settings', 'pageInstanceId', 'settingsRevision'], properties: {
        url: { type: 'string', maxLength: 8192 }, settings: { type: 'object' },
        pageInstanceId: { type: 'string', maxLength: 80 }, settingsRevision: { type: 'integer', minimum: 0 },
      } } },
  },
};
