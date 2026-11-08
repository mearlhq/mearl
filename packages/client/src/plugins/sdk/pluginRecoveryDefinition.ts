import { createHash } from 'node:crypto';
import type { PluginTaskRecoveryDeclaration } from '@mearl/browser-core';

export function normalizePluginTaskRecovery(
  value: unknown,
): PluginTaskRecoveryDeclaration | undefined {
  if (value === undefined) return;
  const declaration = JSON.parse(JSON.stringify(value)) as PluginTaskRecoveryDeclaration;
  if (
    !declaration ||
    declaration.version !== 1 ||
    !declaration.commands ||
    typeof declaration.commands !== 'object' ||
    Array.isArray(declaration.commands) ||
    Object.keys(declaration.commands).length > 32 ||
    Buffer.byteLength(JSON.stringify(declaration)) > 128 * 1024
  )
    throw new Error('Invalid taskRecovery declaration');
  for (const [command, definition] of Object.entries(declaration.commands)) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(command) ||
      !definition ||
      !Number.isSafeInteger(definition.checkpointVersion) ||
      definition.checkpointVersion < 1 ||
      !definition.schema ||
      typeof definition.schema !== 'object' ||
      Array.isArray(definition.schema) ||
      definition.schema.$async
    )
      throw new Error('Invalid task checkpoint definition');
    if (definition.migrateFrom !== undefined) {
      if (
        !Array.isArray(definition.migrateFrom) ||
        definition.migrateFrom.length < 1 ||
        definition.migrateFrom.length > 16
      )
        throw new Error('Invalid checkpoint migration sources');
      const versions = new Set<number>();
      for (const source of definition.migrateFrom) {
        if (
          !source ||
          !Number.isSafeInteger(source.version) ||
          source.version < 1 ||
          source.version >= definition.checkpointVersion ||
          versions.has(source.version) ||
          !source.schema ||
          typeof source.schema !== 'object' ||
          Array.isArray(source.schema) ||
          source.schema.$async
        )
          throw new Error('Checkpoint migrations require distinct older versions and schemas');
        versions.add(source.version);
      }
    }
  }
  return declaration;
}

export function pluginRecoverySignature(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : item,
      ),
    )
    .digest('hex');
}
