import { readdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginStateStore } from '../pluginStateStore.js';
import { normalizePluginState, pluginStateSignature } from '../../sdk/pluginStateDefinition.js';
import type { PluginStateCollection } from '@mearl/browser-core';

let directory: string, store: PluginStateStore, now: number;
const namespace = {
  installationId: '00000000-0000-4000-8000-000000000001',
  collection: 'settings',
  scope: 'installation',
};
const definition: PluginStateCollection = {
  scope: 'installation',
  storage: 'persistent',
  schemaVersion: 1,
  schema: { $id: 'https://schema.test/state', type: 'integer' },
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-state-'));
  now = 100;
  store = new PluginStateStore(directory, () => now);
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));
const put = (
  key: string,
  value: unknown,
  expectedVersion = store.get(namespace, definition, key).version,
) => ({ type: 'put' as const, key, value, expectedVersion });

describe('atomic plugin state collections', () => {
  it.each(['cache', 'memory'] as const)(
    'prevents %s state from forking into another storage backend',
    storage => {
      const scoped = { ...namespace, scope: 'browser-session:test' };
      const original = { ...definition, scope: 'browser-session' as const, storage };
      const next = {
        ...original,
        storage: storage === 'memory' ? ('cache' as const) : ('memory' as const),
      };
      store.transact(scoped, original, {
        operations: [{ type: 'put', key: 'one', value: 1, expectedVersion: 'a:0' }],
      });
      expect(() => store.get(scoped, next, 'one')).toThrow('new collection or namespace');
      expect(() =>
        store.transact(
          scoped,
          { ...next, schemaVersion: 2 },
          {
            expectedRevision: 1,
            migrateFromVersion: 1,
            operations: [{ type: 'put', key: 'one', value: 2, expectedVersion: 'v:1' }],
          },
        ),
      ).toThrow('new collection or namespace');
      expect(store.get(scoped, original, 'one')).toMatchObject({
        exists: true,
        value: 1,
        version: 'v:1',
      });
    },
  );

  it('reads multiple keys once with consistent missing and expired CAS versions', () => {
    const cache = { ...definition, storage: 'cache' as const, ttlMs: 50 };
    store.transact(namespace, cache, { operations: [put('one', 1), put('two', 2)] });
    now += 51;
    const read = vi.spyOn(store as any, 'read');
    const result = store.getMany(namespace, cache, ['one', 'two', 'absent']);
    expect(read).toHaveBeenCalledOnce();
    expect(
      result.entries.map(entry => ({
        key: entry.key,
        exists: entry.exists,
        version: entry.version,
      })),
    ).toEqual([
      { key: 'one', exists: false, version: 'a:2' },
      { key: 'two', exists: false, version: 'a:2' },
      { key: 'absent', exists: false, version: 'a:2' },
    ]);
    expect(result.revision).toBe(2);
    for (const keys of [
      [],
      ['same', 'same'],
      Array.from({ length: 129 }, (_, i) => String(i)),
      ['__proto__'],
    ])
      expect(() => store.getMany(namespace, cache, keys)).toThrow();
  });

  it('keeps schema hashes independent of process locale', () => {
    const unicode = {
      ...definition,
      schema: { type: 'object', properties: { ä: { type: 'string' }, z: { type: 'string' } } },
    };
    const signature = pluginStateSignature(unicode);
    store.transact(namespace, unicode, {
      operations: [{ type: 'put', key: 'value', value: { ä: 'text' }, expectedVersion: 'a:0' }],
    });
    const compare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Locale-sensitive comparison');
    });
    try {
      expect(pluginStateSignature(unicode)).toBe(signature);
      expect(store.transact(namespace, unicode, { operations: [] })).toMatchObject({ revision: 2 });
    } finally {
      compare.mockRestore();
    }
  });

  it('preserves corrupt records while maintaining other cache namespaces', () => {
    const cache = { ...definition, storage: 'cache' as const, ttlMs: 1 };
    store.transact(namespace, cache, { operations: [put('one', 1)] });
    const corrupt = join(directory, namespace.installationId, 'broken.json');
    writeFileSync(corrupt, '{broken');
    now += 2;
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => store.prune()).not.toThrow();
      expect(report).toHaveBeenCalledOnce();
      expect(readFileSync(corrupt, 'utf8')).toBe('{broken');
      expect(store.get(namespace, cache, 'one')).toMatchObject({ exists: false, revision: 2 });
    } finally {
      report.mockRestore();
    }
  });

  it('commits multiple keys and receipts together, persists across reopen and scopes installations', () => {
    const transaction = { operations: [put('one', 1), put('two', 2)], idempotencyKey: 'initial' };
    expect(store.transact(namespace, definition, transaction)).toEqual({
      revision: 1,
      schemaVersion: 1,
    });
    store = new PluginStateStore(directory, () => now);
    expect(store.get(namespace, definition, 'one')).toMatchObject({
      exists: true,
      value: 1,
      version: 'v:1',
    });
    expect(store.transact(namespace, definition, transaction)).toMatchObject({
      revision: 1,
      reused: true,
    });
    expect(store.get({ ...namespace, scope: 'host:another' }, definition, 'one').exists).toBe(
      false,
    );
    expect(() =>
      store.transact(namespace, definition, { ...transaction, operations: [put('one', 9)] }),
    ).toThrow('different data');
  });

  it('rejects the entire transaction on a conflict or invalid JSON value', () => {
    store.transact(namespace, definition, { operations: [put('one', 1)] });
    const stale = 'a:0';
    expect(() =>
      store.transact(namespace, definition, { operations: [put('two', 2), put('one', 9, stale)] }),
    ).toThrow('version changed');
    expect(store.get(namespace, definition, 'two').exists).toBe(false);
    expect(() =>
      store.transact(namespace, definition, {
        operations: [put('one', 7, 'v:1'), put('two', undefined)],
      }),
    ).toThrow('State value must be JSON');
    expect(store.get(namespace, definition, 'one').value).toBe(1);
  });

  it('retains schemas as format metadata and accepts plugin-validated values', () => {
    store.transact(namespace, definition, { operations: [put('one', 'plugin-owned')] });
    expect(store.get(namespace, definition, 'one').value).toBe('plugin-owned');
    const next = { ...definition, schemaVersion: 2, schema: { type: 'object' } };
    store.transact(namespace, next, {
      expectedRevision: 1,
      migrateFromVersion: 1,
      operations: [],
    });
    expect(store.get(namespace, next, 'one').value).toBe('plugin-owned');
  });

  it('prevents ABA without retaining unbounded tombstones', () => {
    const absence = store.get(namespace, definition, 'one').version;
    store.transact(namespace, definition, { operations: [put('one', 1)] });
    store.transact(namespace, definition, {
      operations: [{ type: 'delete', key: 'one', expectedVersion: 'v:1' }],
    });
    expect(store.get(namespace, definition, 'one')).toMatchObject({
      exists: false,
      version: 'a:2',
    });
    expect(() =>
      store.transact(namespace, definition, { operations: [put('one', 3, absence)] }),
    ).toThrow('version changed');
  });

  it('expires cache entries durably and invalidates a pre-expiry CAS token', () => {
    const cache = { ...definition, storage: 'cache' as const, ttlMs: 50 };
    store.transact(namespace, cache, { operations: [put('one', 1)] });
    const original = store.get(namespace, cache, 'one');
    now = 151;
    const expired = store.get(namespace, cache, 'one');
    expect(expired).toMatchObject({ exists: false, version: 'a:2' });
    store = new PluginStateStore(directory, () => now);
    expect(store.get(namespace, cache, 'one')).toEqual(expired);
    expect(() =>
      store.transact(namespace, cache, { operations: [put('one', 2, original.version)] }),
    ).toThrow('version changed');
  });

  it('requires explicit schema migration and fences old revisions after commit', () => {
    store.transact(namespace, definition, { operations: [put('one', 1), put('two', 2)] });
    const next = { ...definition, schemaVersion: 2, schema: { type: 'string' } };
    expect(() => store.transact(namespace, next, { operations: [] })).toThrow('Schema migration');
    const migration = {
      expectedRevision: 1,
      migrateFromVersion: 1,
      operations: ['one', 'two'].map(key => ({
        type: 'put' as const,
        key,
        expectedVersion: 'v:1',
        value: key,
      })),
    };
    expect(store.transact(namespace, next, migration)).toEqual({ revision: 2, schemaVersion: 2 });
    expect(() => store.transact(namespace, definition, { operations: [] })).toThrow(
      'older plugin revision',
    );
    expect(() =>
      store.transact(namespace, { ...next, schema: { type: 'boolean' } }, { operations: [] }),
    ).toThrow('new schemaVersion');
  });

  it('enforces quotas and stable pagination without partial writes', () => {
    const small = { ...definition, maxEntries: 1 };
    expect(() =>
      store.transact(namespace, small, { operations: [put('one', 1), put('two', 2)] }),
    ).toThrow('quota');
    expect(store.get(namespace, small, 'one').exists).toBe(false);
    store.transact(namespace, definition, { operations: [put('one', 1), put('two', 2)] });
    expect(store.list(namespace, definition, { limit: 1 })).toMatchObject({
      entries: [expect.objectContaining({ key: 'one' })],
      nextCursor: 'one',
      revision: 1,
    });
    store.transact(namespace, definition, { operations: [put('three', 3)] });
    expect(() => store.list(namespace, definition, { cursor: 'one', expectedRevision: 1 })).toThrow(
      'restart pagination',
    );
  });

  it('validates declarations and permits independent schemas with the same $id', () => {
    const state = { version: 1, collections: { settings: definition } };
    expect(normalizePluginState(state)?.collections.settings).toEqual(definition);
    expect(normalizePluginState(state)?.collections.settings).toEqual(definition);
    expect(() =>
      normalizePluginState({
        version: 1,
        collections: { transient: { ...definition, scope: 'instance' } },
      }),
    ).toThrow('cache or memory storage');
  });
});

it('normalizes retained TTL metadata when migrating storage policy in either direction', () => {
  const cache = { ...definition, storage: 'cache' as const, ttlMs: 50 };
  store.transact(namespace, cache, { operations: [put('one', 1)] });
  const persistent = { ...definition, schemaVersion: 2 };
  store.transact(namespace, persistent, {
    expectedRevision: 1,
    migrateFromVersion: 1,
    operations: [],
  });
  now = 1000;
  expect(store.get(namespace, persistent, 'one')).toMatchObject({ exists: true, value: 1 });
  expect(store.get(namespace, persistent, 'one')).not.toHaveProperty('expiresAt');
  const expiring = { ...cache, schemaVersion: 3 };
  store.transact(namespace, expiring, {
    expectedRevision: 2,
    migrateFromVersion: 2,
    operations: [],
  });
  expect(store.get(namespace, expiring, 'one').expiresAt).toBe(1050);
  now = 1051;
  store.prune();
  expect(store.get(namespace, expiring, 'one').exists).toBe(false);
});

it('reclaims expired unreachable cache values while retaining CAS identity, and deletes ended instance scopes', () => {
  const cache = { ...definition, storage: 'cache' as const, ttlMs: 50 };
  const scoped = { ...namespace, scope: 'instance:pi_00000000-0000-4000-8000-000000000001' };
  store.transact(scoped, cache, {
    operations: [{ type: 'put', key: 'one', value: 1, expectedVersion: 'a:0' }],
  });
  now = 151;
  store.prune();
  expect(store.get(scoped, cache, 'one')).toMatchObject({ exists: false, version: 'a:2' });
  expect(() =>
    store.transact(scoped, cache, {
      operations: [{ type: 'put', key: 'one', value: 1, expectedVersion: 'a:0' }],
    }),
  ).toThrow('version changed');
  store.discardScope(scoped.installationId, scoped.scope);
  expect(store.get(scoped, cache, 'one').version).toBe('a:0');
});

it('uses the original CAS versions when a storage migration also rewrites a retained key', () => {
  store.transact(namespace, definition, { operations: [put('one', 1)] });
  const cached = { ...definition, storage: 'cache' as const, schemaVersion: 2, ttlMs: 50 };
  expect(
    store.transact(namespace, cached, {
      expectedRevision: 1,
      migrateFromVersion: 1,
      operations: [put('one', 2, 'v:1')],
    }),
  ).toEqual({ revision: 2, schemaVersion: 2 });
  expect(store.get(namespace, cached, 'one')).toMatchObject({
    value: 2,
    version: 'v:2',
    expiresAt: 150,
  });
});

it('keeps browser memory off disk, isolated, bounded and subject to CAS and expiry', () => {
  const memory = {
    ...definition,
    scope: 'browser-session' as const,
    storage: 'memory' as const,
    ttlMs: 50,
    maxBytes: 2000,
  };
  const scoped = { ...namespace, scope: 'browser-session:one' };
  expect(normalizePluginState({ version: 1, collections: { settings: memory } })).toBeDefined();
  const update = {
    operations: [{ type: 'put' as const, key: 'one', value: 1, expectedVersion: 'a:0' }],
  };
  store.transact(scoped, memory, update);
  expect(store.get(scoped, memory, 'one').value).toBe(1);
  expect(readdirSync(directory)).toEqual([]);
  expect(new PluginStateStore(directory).get(scoped, memory, 'one').exists).toBe(false);
  expect(store.get({ ...scoped, scope: 'browser-session:two' }, memory, 'one').exists).toBe(false);
  expect(() => store.transact(scoped, memory, update)).toThrow('version');
  expect(() => store.transact(scoped, { ...memory, maxBytes: 1 }, { operations: [] })).toThrow(
    'quota',
  );
  now += 51;
  store.prune();
  expect(store.get(scoped, memory, 'one')).toMatchObject({ exists: false, version: 'a:2' });
  store.clearMemory();
  expect(store.get(scoped, memory, 'one').version).toBe('a:0');
});

it('reclaims empty memory namespaces at admission without reusing absent CAS versions', () => {
  const memory = {
    ...definition,
    scope: 'browser-session' as const,
    storage: 'memory' as const,
    ttlMs: 1,
  };
  const first = { ...namespace, scope: 'browser-session:0' };
  for (let index = 0; index < 512; index++) {
    const scoped = { ...namespace, scope: `browser-session:${index}` };
    store.transact(scoped, memory, {
      operations: [{ type: 'put', key: 'one', value: 1, expectedVersion: 'a:0' }],
    });
  }
  now += 2;
  store.prune();
  const expired = store.get(first, memory, 'one');
  expect(expired.version).toBe('a:2');
  const next = { ...namespace, scope: 'browser-session:new' };
  const version = store.get(next, memory, 'one').version;
  store.transact(next, memory, {
    operations: [{ type: 'put', key: 'one', value: 2, expectedVersion: version }],
  });
  expect(store.get(next, memory, 'one').value).toBe(2);
  expect(() =>
    store.transact(first, memory, {
      operations: [{ type: 'put', key: 'one', value: 3, expectedVersion: expired.version }],
    }),
  ).toThrow('version');
  expect(store.get(first, memory, 'one').revision).toBeGreaterThan(expired.revision);
});

it('releases ended instance memory and prevents callers from mutating stored values', () => {
  const memory = {
    ...definition,
    scope: 'instance' as const,
    storage: 'memory' as const,
    schema: { type: 'object' },
  };
  const scoped = { ...namespace, scope: 'instance:pi_example' },
    value = { nested: { name: 'one' } };
  store.transact(scoped, memory, {
    operations: [{ type: 'put', key: 'one', value, expectedVersion: 'a:0' }],
  });
  value.nested.name = 'outside';
  (store.get(scoped, memory, 'one').value as any).nested.name = 'read';
  expect(store.get(scoped, memory, 'one').value).toEqual({ nested: { name: 'one' } });
  store.discardScope(scoped.installationId, scoped.scope);
  expect(store.get(scoped, memory, 'one').exists).toBe(false);
});
