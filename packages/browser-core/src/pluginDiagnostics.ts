import type { PluginExecutionHost, PluginInvocationSource } from './pluginExecution.js';
import type { PluginTaskState, PluginTaskResultReference } from './pluginTasks.js';
import type { PluginTaskCheckpointReference } from './pluginRecovery.js';
import type { PluginModelDiagnostic } from './pluginModels.js';

export interface PluginDiagnosticOptions {
  taskId?: string;
  plugin?: string;
  instanceId?: string;
  includeErrorMessages?: boolean;
  includeLocalPaths?: boolean;
}
export interface PluginDiagnosticPageBinding {
  instanceId: string;
  browserSessionId: string;
  tabId: number;
  frameId: string | number;
  documentId: string;
}
export interface PluginTaskDiagnosticMetadata {
  invocationId?: string;
  page?: PluginDiagnosticPageBinding;
  executorAttempted?: boolean;
  executorStoppedAt?: number;
  model?: PluginModelDiagnostic;
  updatesDropped?: boolean;
}
export interface PluginDiagnosticFailure {
  code: string;
  message?: string;
  messageTruncated?: boolean;
}
export interface PluginDiagnosticTask {
  taskId: string;
  plugin: string;
  kind: 'command' | 'model';
  command: string;
  state: PluginTaskState;
  source: PluginInvocationSource;
  host: PluginExecutionHost;
  installationId: string;
  revision: string;
  invocationId?: string;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  page?: PluginDiagnosticPageBinding;
  routing?: {
    browser?: string;
    session?: string;
    connector?: string;
    local?: boolean;
    transport?: 'extension' | 'cdp';
  };
  executionTimeoutMs?: number;
  executor: {
    state: 'never-started' | 'observed-alive' | 'stop-confirmed' | 'unknown';
    observedAt: number;
    pid?: number;
    stoppedAt?: number;
  };
  failure?: PluginDiagnosticFailure;
  checkpoint?: PluginTaskCheckpointReference;
  result?: PluginTaskResultReference;
  model?: PluginModelDiagnostic;
  metadataIncomplete: boolean;
  history: {
    firstRetainedSequence: number;
    gap: boolean;
    omitted: number;
    events: Array<{ sequence: number; time: number; state: PluginTaskState; type: string }>;
  };
}
export interface PluginDiagnosticPage {
  plugin: string;
  installationId: string;
  revision: string;
  host: PluginExecutionHost;
  binding: PluginDiagnosticPageBinding;
  observation: 'service-snapshot' | 'historical-binding';
  state?: 'active' | 'detached' | 'invalidated';
  lastReceived?: number;
  queued?: number;
  running?: number;
  failure?: PluginDiagnosticFailure;
}
export interface PluginDiagnosticReport {
  version: 1;
  generatedAt: number;
  host: PluginExecutionHost;
  protocolVersion: number;
  selection: Pick<PluginDiagnosticOptions, 'taskId' | 'plugin' | 'instanceId'>;
  coverage: {
    scanLimited: boolean;
    tasksOmitted: number;
    pagesOmitted: number;
    byteLimited: boolean;
  };
  tasks: PluginDiagnosticTask[];
  pages: PluginDiagnosticPage[];
  links: Array<{ from: string; to: string; kind: 'parent' | 'resume' }>;
}
