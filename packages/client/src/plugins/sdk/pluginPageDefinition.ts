import { Script } from 'node:vm';
import { isPluginPageMatchPattern } from '@mearl/browser-core';
import type { PluginPageRuntime } from '@mearl/browser-core';

export function normalizePluginPageRuntime(value: unknown): PluginPageRuntime | undefined {
  if (value === undefined) return undefined;
  const runtime = value as PluginPageRuntime;
  if (
    !runtime ||
    runtime.version !== 1 ||
    !Array.isArray(runtime.matches) ||
    !runtime.matches.length ||
    runtime.matches.length > 64 ||
    !runtime.matches.every(isPluginPageMatchPattern) ||
    typeof runtime.code !== 'string' ||
    Buffer.byteLength(runtime.code) > 384 * 1024 ||
    Buffer.byteLength(JSON.stringify(runtime)) > 448 * 1024
  )
    throw new Error('Invalid plugin pageRuntime declaration');
  new Script(`(${runtime.code}\n)`, { filename: 'plugin-page-runtime.js' });
  if (
    runtime.events !== undefined &&
    (!runtime.events ||
      typeof runtime.events !== 'object' ||
      Array.isArray(runtime.events) ||
      Object.keys(runtime.events).length > 32)
  )
    throw new Error('Invalid page runtime events');
  for (const [name, event] of Object.entries(runtime.events ?? {})) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      !event ||
      !/^[a-z][a-z0-9-]*$/.test(event.command) ||
      !event.schema ||
      typeof event.schema !== 'object' ||
      Array.isArray(event.schema) ||
      (event.policy !== undefined && !['serial', 'latest', 'parallel'].includes(event.policy)) ||
      (event.concurrency !== undefined &&
        (!Number.isSafeInteger(event.concurrency) ||
          event.concurrency < 1 ||
          event.concurrency > 8)) ||
      (event.maxPending !== undefined &&
        (!Number.isSafeInteger(event.maxPending) ||
          event.maxPending < 1 ||
          event.maxPending > 64)) ||
      (event.executionTimeoutMs !== undefined &&
        (!Number.isSafeInteger(event.executionTimeoutMs) || event.executionTimeoutMs < 1 || event.executionTimeoutMs > 300000)) ||
      event.schema.$async
    )
      throw new Error(`Invalid page event binding: ${name}`);
  }
  if (runtime.initialize !== undefined && !/^[a-z][a-z0-9-]*$/.test(runtime.initialize))
    throw new Error('Invalid page runtime initialize command');
  return JSON.parse(JSON.stringify(runtime));
}
