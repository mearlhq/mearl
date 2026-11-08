import type {
  PluginExecutionError,
  PluginExecutionHost,
  PluginInvocationSource,
} from './pluginExecution.js';
import type { PluginTaskCheckpointReference } from './pluginRecovery.js';

export const PLUGIN_TASK_PROTOCOL_VERSION = 5;
export type PluginTaskState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'interrupted';

export interface PluginTaskResultReference {
  bytes: number;
  sha256: string;
  chunks: number;
}

export interface PluginTask {
  taskId: string;
  host: PluginExecutionHost;
  plugin: string;
  installationId: string;
  revision: string;
  command: string;
  kind?: 'command' | 'model';
  parentTaskId?: string;
  resumedFrom?: {
    taskId: string;
    revision: string;
    checkpointSequence: number;
    checkpointVersion: number;
  };
  checkpoint?: PluginTaskCheckpointReference;
  input: Record<string, unknown>;
  source: PluginInvocationSource;
  cwd: string;
  state: PluginTaskState;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  progress?: string | { message: string; data?: Record<string, unknown> };
  result?: PluginTaskResultReference;
  error?: PluginExecutionError;
}

export interface PluginTaskEvent {
  sequence: number;
  time: number;
  type: 'state' | 'progress' | 'checkpoint' | 'diagnostic';
  checkpoint?: PluginTaskCheckpointReference;
  state: PluginTaskState;
  progress?: PluginTask['progress'];
}

export interface PluginTaskEvents {
  task: PluginTask;
  events: PluginTaskEvent[];
  firstAvailableSequence: number;
  nextCursor: number;
  gap: boolean;
}

export interface PluginTaskStartResult {
  taskId: string;
  state: PluginTaskState;
  host: PluginExecutionHost;
  reused?: true;
}

export interface PluginTaskListResult {
  tasks: PluginTask[];
  nextCursor?: string;
}

export interface PluginTaskResultChunk {
  taskId: string;
  index: number;
  data: string;
  bytes: number;
  sha256: string;
  chunks: number;
}

export function isPluginTaskActive(state: PluginTaskState): boolean {
  return state === 'queued' || state === 'running' || state === 'cancelling';
}

export function isPluginTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^pt_[0-9a-f-]{36}_[0-9a-f-]{36}$/i.test(value);
}
