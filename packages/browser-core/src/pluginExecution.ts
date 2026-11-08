import type { PluginPageBinding } from './pluginPages.js';
import type { PluginTaskRecoveryContext } from './pluginRecovery.js';
/** Identifies an execution environment separately from a process incarnation. */
export interface PluginExecutionHost {
  hostId: string;
  epoch: string;
}

export type PluginInvocationSource = 'cli' | 'sdk' | 'mcp' | 'toolbox' | 'runtime';

/** Created by the entry point; business input cannot replace this identity. */
export interface PluginInvocationIdentity {
  invocationId: string;
  host: PluginExecutionHost;
  source: PluginInvocationSource;
  plugin: string;
  parentInvocationId?: string;
  taskId?: string;
  installationId?: string;
  revision?: string;
  page?: PluginPageBinding;
  recovery?: PluginTaskRecoveryContext;
}

export interface PluginExecutionError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  metadata?: Record<string, string | number | boolean | null>;
}
