import type { PluginDiagnosticOptions, PluginDiagnosticReport } from './pluginDiagnostics.js';
import type {
  PluginTask,
  PluginTaskEvents,
  PluginTaskListResult,
  PluginTaskResultChunk,
  PluginTaskStartResult,
} from './pluginTasks.js';

export type ToolboxDisplayMode = 'popup' | 'tab' | 'both';

export interface ToolboxPluginTool {
  id: string;
  plugin: string;
  title: string;
  description?: string;
  /** Icon name, SVG markup, image data URL, or HTTP(S) image URL. */
  icon?: string;
  locales?: Record<string, ToolboxPluginToolLocale>;
  order: number;
  displayMode?: ToolboxDisplayMode;
  skillUpdate?: ToolboxSkillUpdate;
  /** Whether the associated Skill is discoverable by Agents. Tool execution is independent. */
  skillEnabled?: boolean;
}

export interface ToolboxPluginToolLocale {
  title?: string;
  description?: string;
}

export interface ToolboxToolsListResult {
  tools: ToolboxPluginTool[];
}

export interface ToolboxToolOpenOptions {
  id: string;
}

export interface ToolboxPluginActionResult {
  plugin: string;
  removed?: boolean;
}

export interface ToolboxSandboxPage {
  type: 'sandbox';
  runtime?: 'preact';
  hash: string;
  size: number;
  chunks: number;
}

export interface ToolboxAgentConfig {
  enabled: true;
  layout?: 'drawer' | 'workspace';
  pageElementActions?: boolean;
}

export interface ToolboxSkillUpdate {
  name: string;
  scope: 'global';
}

export interface ToolboxToolOpenResult {
  title: string;
  displayMode?: ToolboxDisplayMode;
  icon?: string;
  locales?: Record<string, ToolboxPluginToolLocale>;
  agent?: ToolboxAgentConfig;
  skillUpdate?: ToolboxSkillUpdate;
  page: ToolboxSandboxPage;
}

export interface ToolboxToolInvokeOptions {
  id: string;
  command: string;
  input?: Record<string, unknown>;
}

export interface ToolboxToolInvokeResult {
  result: unknown;
}

export interface ToolboxTaskOptions {
  id: string;
  taskId: string;
}

export interface ToolboxTaskOperations {
  start: {
    request: ToolboxToolInvokeOptions & { executionTimeoutMs?: number; idempotencyKey?: string };
    response: PluginTaskStartResult;
  };
  get: { request: ToolboxTaskOptions; response: PluginTask };
  cancel: { request: ToolboxTaskOptions; response: PluginTask };
  list: {
    request: { id: string; activeOnly?: boolean; cursor?: string; limit?: number };
    response: PluginTaskListResult;
  };
  events: {
    request: ToolboxTaskOptions & { cursor?: number; waitMs?: number };
    response: PluginTaskEvents;
  };
  result: { request: ToolboxTaskOptions & { index: number }; response: PluginTaskResultChunk };
  diagnose: {
    request: { id: string } & Omit<PluginDiagnosticOptions, 'plugin'>;
    response: PluginDiagnosticReport;
  };
}
export type ToolboxTaskRequest = {
  [O in keyof ToolboxTaskOperations]: { operation: O } & ToolboxTaskOperations[O]['request'];
}[keyof ToolboxTaskOperations];
export type ToolboxTaskResponse<R extends ToolboxTaskRequest> =
  ToolboxTaskOperations[R['operation']]['response'];

export interface ToolboxPageChunkOptions {
  id: string;
  hash: string;
  index: number;
}

export interface ToolboxPageChunkResult {
  data: string;
  hash: string;
  index: number;
  total: number;
}

export interface ToolboxServiceActionMap {
  toolbox_state: {
    request: { id: string; operation: string; input?: Record<string, unknown> };
    response: unknown;
  };
  toolbox_model: {
    request: { id: string; operation: string; input?: Record<string, unknown> };
    response: unknown;
  };
  toolbox_page: {
    request: { id: string; operation: string; input?: Record<string, unknown> };
    response: unknown;
  };
  toolbox_tools_list: {
    request: undefined;
    response: ToolboxToolsListResult;
  };
  toolbox_tool_open: {
    request: ToolboxToolOpenOptions;
    response: ToolboxToolOpenResult;
  };
  toolbox_plugin_uninstall: {
    request: ToolboxToolOpenOptions;
    response: ToolboxPluginActionResult;
  };
  toolbox_skill_set_enabled: {
    request: { id: string; enabled: boolean };
    response: { enabled: boolean };
  };
  toolbox_tool_page_chunk: {
    request: ToolboxPageChunkOptions;
    response: ToolboxPageChunkResult;
  };
  toolbox_tool_invoke: {
    request: ToolboxToolInvokeOptions;
    response: ToolboxToolInvokeResult;
  };
  toolbox_task: {
    request: ToolboxTaskRequest;
    response: ToolboxTaskOperations[keyof ToolboxTaskOperations]['response'];
  };
}

export type ToolboxServiceAction = keyof ToolboxServiceActionMap;

export type ToolboxServiceRequest<A extends ToolboxServiceAction> =
  ToolboxServiceActionMap[A]['request'];

export type ToolboxServiceResponse<A extends ToolboxServiceAction> =
  ToolboxServiceActionMap[A]['response'];

export const TOOLBOX_SERVICE_ACTIONS = {
  toolbox_page: true,
  toolbox_state: true,
  toolbox_model: true,
  toolbox_tools_list: true,
  toolbox_tool_open: true,
  toolbox_plugin_uninstall: true,
  toolbox_skill_set_enabled: true,
  toolbox_tool_page_chunk: true,
  toolbox_tool_invoke: true,
  toolbox_task: true,
} as const satisfies Record<ToolboxServiceAction, true>;

export function isToolboxServiceAction(value: unknown): value is ToolboxServiceAction {
  return typeof value === 'string' && Object.hasOwn(TOOLBOX_SERVICE_ACTIONS, value);
}
