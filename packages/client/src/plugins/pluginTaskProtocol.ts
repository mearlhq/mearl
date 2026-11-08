import type {
  PluginExecutionError,
  PluginInvocationSource,
} from '@mearl/browser-core';
import type { PluginOptions } from './sdk/plugin.js';

export interface PluginTaskScope {
  access: 'public' | 'toolbox' | 'runtime';
  plugin?: string;
  source: PluginInvocationSource;
  bridge: 'service' | 'caller';
  scopeId?: string;
}

export interface PluginTaskStartRequest {
  plugin: string;
  command: string;
  kind?: 'command' | 'model';
  input: Record<string, unknown>;
  cwd: string;
  environment: Record<string, string>;
  options: PluginOptions;
  executionTimeoutMs?: number;
  idempotencyKey?: string;
}

export interface PluginTaskResumeRequest {
  taskId: string;
  environment: Record<string, string>;
  revision?: 'original' | 'current';
}

export type PluginTaskWireMessage =
  | { type: 'request'; id: number; method: string; input: Record<string, unknown> }
  | { type: 'response'; id: number; result?: unknown; error?: PluginExecutionError }
  | {
      type: 'invoke';
      id: number;
      action: string;
      payload: Record<string, unknown>;
      options: PluginOptions;
    }
  | { type: 'invoke-result'; id: number; result?: unknown; error?: PluginExecutionError };
