import type { PluginModelDiagnostic, PluginModelRequest } from '@mearl/browser-core';
import type {
  PluginInvocationIdentity,
  PluginExecutionError,
} from '@mearl/browser-core';
import type { PluginInvocation, PluginOptions, PluginProgress } from '../sdk/plugin.js';
import type { PluginRegistration } from '../pluginRegistry.js';

export type PluginWorkerRequest =
  | {
      type: 'start';
      plugin: string;
      invocation: PluginInvocation;
      options: PluginOptions;
      identity: PluginInvocationIdentity;
      entry: string;
      entryVersion: string;
      access: 'public' | 'toolbox' | 'runtime';
      registration?: PluginRegistration;
      describe?: boolean;
      help?: { namespace: string; command?: string };
      model?: PluginModelRequest;
      recovery?: boolean;
      migration?: boolean;
      expectedRecovery?: string;
    }
  | { type: 'cancel'; error: PluginExecutionError }
  | { type: 'invoke-progress'; id: number; progress: PluginProgress }
  | { type: 'response'; id: number; result?: unknown; error?: PluginExecutionError };

export type PluginWorkerEvent =
  | {
      type: 'invoke';
      id: number;
      action: string;
      payload: Record<string, unknown>;
      options: PluginOptions;
      stream?: boolean;
    }
  | { type: 'diagnostic'; metadata: PluginModelDiagnostic }
  | { type: 'progress'; progress: PluginProgress }
  | { type: 'result'; json: string }
  | { type: 'error'; error: PluginExecutionError };

export const MAX_PLUGIN_RESULT_BYTES = 64 * 1024 * 1024;

export function serializePluginExecutionError(error: unknown): PluginExecutionError {
  const value = error as { message?: unknown; code?: unknown; details?: unknown } | null;
  const metadata = Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {}).filter(
      ([key, field]) =>
        !['__proto__', 'prototype', 'constructor', 'message', 'stack', 'code', 'details'].includes(
          key,
        ) &&
        (field === null || ['string', 'number', 'boolean'].includes(typeof field)),
    ),
  ) as Record<string, string | number | boolean | null>;
  const serialized: PluginExecutionError = {
    message: typeof value?.message === 'string' ? value.message : String(error),
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
    ...(value?.details && typeof value.details === 'object' && !Array.isArray(value.details)
      ? { details: value.details as Record<string, unknown> }
      : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
  try {
    if (Buffer.byteLength(JSON.stringify(serialized)) <= 64 * 1024) return serialized;
  } catch {
    /* Non-JSON diagnostic data cannot cross the executor boundary. */
  }
  return {
    message: Buffer.from(serialized.message).subarray(0, 8192).toString('utf8'),
    ...(serialized.code ? { code: serialized.code.slice(0, 256) } : {}),
    details: { diagnosticTruncated: true },
    metadata: Object.fromEntries(
      Object.entries(metadata)
        .slice(0, 32)
        .map(([key, field]) => [
          key.slice(0, 128),
          typeof field === 'string' ? field.slice(0, 512) : field,
        ]),
    ),
  };
}

export function pluginExecutionError(value: PluginExecutionError): Error {
  return Object.assign(new Error(value.message), {
    ...Object.fromEntries(
      Object.entries(value.metadata ?? {}).filter(
        ([key]) =>
          ![
            '__proto__',
            'prototype',
            'constructor',
            'message',
            'stack',
            'code',
            'details',
          ].includes(key),
      ),
    ),
    ...(value.code ? { code: value.code } : {}),
    ...(value.details ? { details: value.details } : {}),
  });
}
