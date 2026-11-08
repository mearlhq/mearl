import { createHash } from 'node:crypto';
import type { PluginStateDeclaration } from '@mearl/browser-core';

export function normalizePluginState(value: unknown): PluginStateDeclaration | undefined {
  if (value === undefined) return;
  const declaration = JSON.parse(JSON.stringify(value)) as PluginStateDeclaration;
  if (
    !declaration ||
    declaration.version !== 1 ||
    !declaration.collections ||
    Array.isArray(declaration.collections) ||
    Object.keys(declaration.collections).length > 32 ||
    Buffer.byteLength(JSON.stringify(declaration)) > 128 * 1024
  )
    throw new Error('Invalid stateStorage declaration');
  for (const [name, collection] of Object.entries(declaration.collections)) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      !collection ||
      !['installation', 'host', 'browser-session', 'instance'].includes(collection.scope) ||
      !['persistent', 'cache', 'memory'].includes(collection.storage) ||
      !Number.isSafeInteger(collection.schemaVersion) ||
      collection.schemaVersion < 1 ||
      !collection.schema ||
      typeof collection.schema !== 'object' ||
      Array.isArray(collection.schema) ||
      collection.schema.$async
    )
      throw new Error(`Invalid state collection: ${name}`);
    if (
      ['browser-session', 'instance'].includes(collection.scope) &&
      !['cache', 'memory'].includes(collection.storage)
    )
      throw new Error('Document state requires cache or memory storage');
    if (
      collection.storage === 'memory' &&
      !['browser-session', 'instance'].includes(collection.scope)
    )
      throw new Error('Memory state requires a browser session or instance scope');
    if (
      collection.maxEntries !== undefined &&
      (!Number.isSafeInteger(collection.maxEntries) ||
        collection.maxEntries < 1 ||
        collection.maxEntries > 4096)
    )
      throw new Error('State maxEntries must be between 1 and 4096');
    if (
      collection.maxBytes !== undefined &&
      (!Number.isSafeInteger(collection.maxBytes) ||
        collection.maxBytes < 1 ||
        collection.maxBytes > (collection.storage === 'memory' ? 128 : 16) * 1024 * 1024)
    )
      throw new Error('State maxBytes exceeds its storage limit');
    if (
      collection.ttlMs !== undefined &&
      (!Number.isSafeInteger(collection.ttlMs) ||
        collection.ttlMs < 1 ||
        collection.ttlMs > 7 * 86400000)
    )
      throw new Error('State TTL must be between 1 ms and 7 days');
    if (collection.storage === 'persistent' && collection.ttlMs !== undefined)
      throw new Error('Persistent state does not accept TTL');
  }
  return declaration;
}

export function pluginStateSignature(
  collection: import('@mearl/browser-core').PluginStateCollection,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(collection, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : value,
      ),
    )
    .digest('hex');
}
