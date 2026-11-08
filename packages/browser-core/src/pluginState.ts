export type PluginStateScope = 'installation' | 'host' | 'browser-session' | 'instance';
export interface PluginStateCollection {
  scope: PluginStateScope;
  storage: 'persistent' | 'cache' | 'memory';
  schemaVersion: number;
  schema: Record<string, unknown>;
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
}
export interface PluginStateDeclaration {
  version: 1;
  collections: Record<string, PluginStateCollection>;
}
export interface PluginStateEntry {
  key: string;
  exists: boolean;
  /** Live entry revision, or the collection revision for absence; opaque to callers. */
  version: string;
  value?: unknown;
  expiresAt?: number;
}
export interface PluginStateSnapshot extends PluginStateEntry {
  revision: number;
  schemaVersion: number;
}
export interface PluginStateList {
  entries: PluginStateEntry[];
  revision: number;
  schemaVersion: number;
  nextCursor?: string;
}
export type PluginStateMutation =
  | { type: 'put'; key: string; expectedVersion: string; value: unknown; ttlMs?: number }
  | { type: 'delete'; key: string; expectedVersion: string };
export interface PluginStateTransaction {
  operations: PluginStateMutation[];
  expectedRevision?: number;
  migrateFromVersion?: number;
  idempotencyKey?: string;
}
export type PluginStateOperation = 'get' | 'get-many' | 'list' | 'transact';
