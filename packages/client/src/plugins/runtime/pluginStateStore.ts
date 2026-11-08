import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pluginHostPaths } from './pluginHostPaths.js';
import { writePluginHostFile } from './pluginHostFiles.js';
import type {
  PluginStateCollection,
  PluginStateEntry,
  PluginStateTransaction,
} from '@mearl/browser-core';

interface Document {
  revision: number;
  schemaVersion: number;
  schemaHash: string;
  storage: PluginStateCollection['storage'];
  scope: string;
  entries: Record<string, { revision: number; value: unknown; expiresAt?: number }>;
  commits: Array<{ id: string; hash: string; revision: number }>;
}
export interface PluginStateNamespace {
  installationId: string;
  collection: string;
  scope: string;
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function schemaHash(definition: PluginStateCollection): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ schema: definition.schema, storage: definition.storage }, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : value,
      ),
    )
    .digest('hex');
}
function key(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Buffer.byteLength(value) > 512 ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    fail('PLUGIN_STATE_INVALID', 'Invalid state key');
}
/** A collection namespace is one atomic record, including CAS and commit receipts. */
export class PluginStateStore {
  private readonly memory = new Map<string, { document: Document; bytes: number }>();
  private memoryBytes = 0;
  private memoryRevisionFloor = 0;
  clearMemory(): void {
    this.memory.clear();
    this.memoryBytes = 0;
    this.memoryRevisionFloor = 0;
  }
  private readonly valueBytes = new WeakMap<object, number>();
  private memorySize(document: Document): number {
    let bytes = Buffer.byteLength(JSON.stringify({ ...document, entries: {} }));
    let count = 0;
    for (const [name, entry] of Object.entries(document.entries)) {
      let valueBytes =
        typeof entry.value === 'object' && entry.value !== null
          ? this.valueBytes.get(entry.value)
          : undefined;
      if (valueBytes === undefined) {
        valueBytes = Buffer.byteLength(JSON.stringify(entry.value));
        if (typeof entry.value === 'object' && entry.value !== null)
          this.valueBytes.set(entry.value, valueBytes);
      }
      bytes +=
        Buffer.byteLength(JSON.stringify(name)) +
        1 +
        Buffer.byteLength(JSON.stringify({ ...entry, value: null })) -
        4 +
        valueBytes +
        (count++ ? 1 : 0);
    }
    return bytes;
  }
  private saveMemory(path: string, document: Document, bytes = this.memorySize(document)): void {
    const total = this.memoryBytes - (this.memory.get(path)?.bytes ?? 0) + bytes;
    if (total > 128 * 1024 * 1024 || (!this.memory.has(path) && this.memory.size >= 512))
      fail('PLUGIN_STATE_QUOTA', 'Memory state exceeds its host limits');
    this.memory.set(path, { document, bytes });
    this.memoryBytes = total;
  }
  constructor(
    readonly directory = pluginHostPaths().state,
    private readonly now = Date.now,
  ) {}
  private path(namespace: PluginStateNamespace): string {
    if (
      !/^[a-f0-9-]{36}$/i.test(namespace.installationId) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(namespace.collection)
    )
      fail('PLUGIN_STATE_INVALID', 'Invalid state namespace');
    const id = createHash('sha256').update(namespace.scope).digest('hex');
    return join(this.directory, namespace.installationId, `${namespace.collection}-${id}.json`);
  }
  private read(namespace: PluginStateNamespace, definition: PluginStateCollection): Document {
    try {
      const file = this.path(namespace);
      const saved = this.memory.get(file);
      if (
        (definition.storage !== 'memory' && saved) ||
        (definition.storage === 'memory' && !saved && existsSync(file))
      )
        fail(
          'PLUGIN_STATE_STORAGE_CHANGED',
          'Switching between memory and disk state requires a new collection or namespace',
        );
      if (definition.storage === 'memory' && !saved) {
        if (this.memory.size >= 512) {
          // Retiring empty collections advances absence versions so stale CAS cannot be reused.
          this.memoryRevisionFloor =
            Math.max(
              this.memoryRevisionFloor,
              ...[...this.memory.values()].map(entry => entry.document.revision),
            ) + 1;
          for (const [path, entry] of this.memory)
            if (!Object.keys(entry.document.entries).length) {
              this.memory.delete(path);
              this.memoryBytes -= entry.bytes;
            }
        }
        throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      }
      const document = saved
        ? { ...saved.document, entries: { ...saved.document.entries } }
        : (JSON.parse(readFileSync(file, 'utf8')) as Document);
      if (
        !Number.isSafeInteger(document.revision) ||
        !Number.isSafeInteger(document.schemaVersion) ||
        !document.entries ||
        !Array.isArray(document.commits)
      )
        throw new Error('Invalid state document');
      if (definition.storage !== 'persistent') {
        const entries = Object.fromEntries(
          Object.entries(document.entries).filter(
            ([, entry]) => entry.expiresAt === undefined || entry.expiresAt > this.now(),
          ),
        );
        if (Object.keys(entries).length !== Object.keys(document.entries).length) {
          document.entries = entries;
          document.revision++;
          if (definition.storage === 'memory') this.saveMemory(file, document);
          else writePluginHostFile(file, JSON.stringify(document));
        }
      }
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        revision: definition.storage === 'memory' ? this.memoryRevisionFloor : 0,
        schemaVersion: definition.schemaVersion,
        schemaHash: schemaHash(definition),
        storage: definition.storage,
        scope: namespace.scope,
        entries: {},
        commits: [],
      };
    }
  }
  private entry(document: Document, name: string, now: number): PluginStateEntry {
    const entry = Object.hasOwn(document.entries, name) ? document.entries[name] : undefined;
    return entry && (entry.expiresAt === undefined || entry.expiresAt > now)
      ? {
          key: name,
          exists: true,
          version: `v:${entry.revision}`,
          value: document.storage === 'memory' ? structuredClone(entry.value) : entry.value,
          ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
        }
      : { key: name, exists: false, version: `a:${document.revision}` };
  }
  discardScope(installationId: string, scope: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(installationId) || !scope.startsWith('instance:pi_'))
      throw new Error('Only ended instance scopes can be discarded');
    const directory = join(this.directory, installationId);
    const memorySuffix = `-${createHash('sha256').update(scope).digest('hex')}.json`;
    for (const [path, entry] of this.memory)
      if (path.startsWith(directory + sep) && path.endsWith(memorySuffix)) {
        this.memory.delete(path);
        this.memoryBytes -= entry.bytes;
      }
    const suffix = `-${createHash('sha256').update(scope).digest('hex')}.json`;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names)
      if (name.endsWith(suffix)) rmSync(join(directory, name), { force: true });
  }
  prune(skipFile?: string): void {
    for (const [path, saved] of this.memory) {
      const document = { ...saved.document, entries: { ...saved.document.entries } };
      for (const [key, entry] of Object.entries(document.entries))
        if (entry.expiresAt !== undefined && entry.expiresAt <= this.now())
          delete document.entries[key];
      if (Object.keys(document.entries).length === Object.keys(saved.document.entries).length)
        continue;
      document.revision++;
      this.saveMemory(path, document);
    }
    let installations: string[];
    try {
      installations = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const installation of installations) {
      if (!/^[a-f0-9-]{36}$/i.test(installation)) continue;
      for (const name of readdirSync(join(this.directory, installation))) {
        if (!name.endsWith('.json')) continue;
        const file = join(this.directory, installation, name);
        if (file === skipFile) continue;
        try {
          const document = JSON.parse(readFileSync(file, 'utf8')) as Document;
          if (document.storage !== 'cache') continue;
          const entries = Object.fromEntries(
            Object.entries(document.entries).filter(
              ([, value]) => value.expiresAt === undefined || value.expiresAt > this.now(),
            ),
          );
          if (Object.keys(entries).length === Object.keys(document.entries).length) continue;
          writePluginHostFile(
            file,
            JSON.stringify({ ...document, revision: document.revision + 1, entries }),
          );
        } catch (error) {
          console.error(`Cannot maintain plugin cache ${file}:`, error);
        }
      }
    }
  }
  get(namespace: PluginStateNamespace, definition: PluginStateCollection, name: string) {
    key(name);
    const document = this.read(namespace, definition);
    return {
      ...this.entry(document, name, this.now()),
      revision: document.revision,
      schemaVersion: document.schemaVersion,
    };
  }
  getMany(namespace: PluginStateNamespace, definition: PluginStateCollection, names: unknown) {
    if (
      !Array.isArray(names) ||
      names.length < 1 ||
      names.length > 128 ||
      new Set(names).size !== names.length
    )
      fail('PLUGIN_STATE_INVALID', 'Expected 1 to 128 unique state keys');
    names.forEach(name => key(name));
    const document = this.read(namespace, definition),
      now = this.now();
    const entries = names.map(name => this.entry(document, name, now));
    if (Buffer.byteLength(JSON.stringify(entries)) > 1024 * 1024)
      fail('PLUGIN_STATE_RESPONSE_TOO_LARGE', 'State batch exceeds 1 MiB; read fewer keys');
    return { entries, revision: document.revision, schemaVersion: document.schemaVersion };
  }
  list(
    namespace: PluginStateNamespace,
    definition: PluginStateCollection,
    input: { cursor?: string; limit?: number; expectedRevision?: number } = {},
  ) {
    const document = this.read(namespace, definition);
    const limit = input.limit ?? 100;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (input.cursor !== undefined && typeof input.cursor !== 'string')
    )
      fail('PLUGIN_STATE_INVALID', 'Invalid state list cursor or limit');
    if (input.expectedRevision !== undefined && input.expectedRevision !== document.revision)
      fail('PLUGIN_STATE_CONFLICT', 'State list changed; restart pagination');
    const now = this.now();
    const candidates = Object.keys(document.entries)
      .sort()
      .filter(
        name =>
          (input.cursor === undefined || name > input.cursor) &&
          this.entry(document, name, now).exists,
      );
    const entries: PluginStateEntry[] = [];
    let bytes = 0;
    for (const name of candidates) {
      const entry = this.entry(document, name, now),
        size = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length && (entries.length >= limit || bytes + size > 256 * 1024)) break;
      entries.push(entry);
      bytes += size;
    }
    return {
      entries,
      revision: document.revision,
      schemaVersion: document.schemaVersion,
      ...(entries.length < candidates.length ? { nextCursor: entries.at(-1)!.key } : {}),
    };
  }
  transact(
    namespace: PluginStateNamespace,
    definition: PluginStateCollection,
    input: PluginStateTransaction,
  ) {
    if (
      !input ||
      !Array.isArray(input.operations) ||
      input.operations.length > 128 ||
      Buffer.byteLength(JSON.stringify(input)) > 512 * 1024
    )
      fail('PLUGIN_STATE_INVALID', 'State transaction exceeds its limits');
    const document = this.read(namespace, definition);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          input,
          schemaVersion: definition.schemaVersion,
          schema: definition.schema,
        }),
      )
      .digest('hex');
    if (input.idempotencyKey !== undefined) {
      if (
        typeof input.idempotencyKey !== 'string' ||
        !input.idempotencyKey.length ||
        input.idempotencyKey.length > 128
      )
        fail('PLUGIN_STATE_INVALID', 'Invalid transaction idempotency key');
      const existing = document.commits.find(item => item.id === input.idempotencyKey);
      if (existing) {
        if (existing.hash !== hash)
          fail(
            'PLUGIN_STATE_IDEMPOTENCY_CONFLICT',
            'Transaction key refers to different data or schema',
          );
        return { revision: existing.revision, schemaVersion: document.schemaVersion, reused: true };
      }
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== document.revision)
      fail('PLUGIN_STATE_CONFLICT', 'Collection revision changed');
    if (
      document.schemaVersion === definition.schemaVersion &&
      document.schemaHash !== schemaHash(definition)
    )
      fail(
        'PLUGIN_STATE_SCHEMA_VERSION_REQUIRED',
        'Changing the state schema or storage policy requires a new schemaVersion',
      );
    if (document.schemaVersion > definition.schemaVersion)
      fail(
        'PLUGIN_STATE_SCHEMA_DOWNGRADE',
        'An older plugin revision cannot write a newer state schema',
      );
    if (
      document.schemaVersion !== definition.schemaVersion &&
      (input.migrateFromVersion !== document.schemaVersion || input.expectedRevision === undefined)
    )
      fail(
        'PLUGIN_STATE_MIGRATION_REQUIRED',
        'Schema migration requires the previous schema version and collection revision',
      );
    if (
      input.migrateFromVersion !== undefined &&
      input.migrateFromVersion !== document.schemaVersion
    )
      fail('PLUGIN_STATE_CONFLICT', 'State schema changed');
    const now = this.now(),
      names = new Set<string>();
    const entries = Object.fromEntries(
      Object.entries(document.entries)
        .filter(([, value]) => value.expiresAt === undefined || value.expiresAt > now)
        .map(([name, value]) => [name, { ...value }]),
    );
    const revision = document.revision + 1;
    if (!Number.isSafeInteger(revision)) fail('PLUGIN_STATE_QUOTA', 'State revision limit reached');
    if (document.storage !== definition.storage)
      for (const entry of Object.values(entries)) {
        entry.revision = revision;
        if (definition.storage !== 'persistent')
          entry.expiresAt = now + (definition.ttlMs ?? 86400000);
        else delete entry.expiresAt;
      }
    for (const operation of input.operations) {
      key(operation.key);
      if (
        names.has(operation.key) ||
        !['put', 'delete'].includes(operation.type) ||
        operation.expectedVersion !== this.entry(document, operation.key, now).version
      )
        fail('PLUGIN_STATE_CONFLICT', 'State entry version changed or key repeated');
      names.add(operation.key);
      if (operation.type === 'delete') {
        delete entries[operation.key];
        continue;
      }
      const json = JSON.stringify(operation.value);
      if (json === undefined || Buffer.byteLength(json) > 256 * 1024)
        fail('PLUGIN_STATE_INVALID', 'State value must be JSON within 256 KiB');
      const ttl = operation.ttlMs ?? definition.ttlMs ?? 86400000;
      if (definition.storage === 'persistent' && operation.ttlMs !== undefined)
        fail('PLUGIN_STATE_INVALID', 'Persistent state does not accept TTL');
      if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 7 * 86400000)
        fail('PLUGIN_STATE_INVALID', 'Invalid cache TTL');
      entries[operation.key] = {
        revision,
        value: definition.storage === 'memory' ? structuredClone(operation.value) : operation.value,
        ...(definition.storage !== 'persistent' ? { expiresAt: now + ttl } : {}),
      };
    }
    const commit: Document = {
      revision,
      schemaVersion: definition.schemaVersion,
      schemaHash: schemaHash(definition),
      storage: definition.storage,
      scope: namespace.scope,
      entries,
      commits: [
        ...document.commits,
        ...(input.idempotencyKey ? [{ id: input.idempotencyKey, hash, revision }] : []),
      ].slice(-64),
    };
    const content = definition.storage === 'memory' ? '' : JSON.stringify(commit);
    const bytes =
      definition.storage === 'memory' ? this.memorySize(commit) : Buffer.byteLength(content);
    if (
      Object.keys(entries).length > (definition.maxEntries ?? 1024) ||
      bytes > (definition.maxBytes ?? 8 * 1024 * 1024)
    )
      fail('PLUGIN_STATE_QUOTA', 'State collection quota exceeded');
    const file = this.path(namespace);
    if (definition.storage === 'memory') {
      this.saveMemory(file, commit, bytes);
      return { revision, schemaVersion: definition.schemaVersion };
    }
    let total = Buffer.byteLength(content);
    try {
      for (const name of readdirSync(join(this.directory, namespace.installationId))) {
        const path = join(this.directory, namespace.installationId, name);
        if (path !== file && name.endsWith('.json')) total += statSync(path).size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (total > 64 * 1024 * 1024) {
      this.prune(file);
      total = Buffer.byteLength(content);
      for (const name of readdirSync(join(this.directory, namespace.installationId))) {
        const path = join(this.directory, namespace.installationId, name);
        if (path !== file && name.endsWith('.json')) total += statSync(path).size;
      }
    }
    if (total > 64 * 1024 * 1024) fail('PLUGIN_STATE_QUOTA', 'Plugin state exceeds 64 MiB');
    writePluginHostFile(file, content);
    return { revision, schemaVersion: definition.schemaVersion };
  }
}
