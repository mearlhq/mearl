import type {
  BrowserAccessResult,
  BrowserActionMap,
  BrowserJsonValue,
  BrowserProviderListResult,
  BrowserProviderLaunchForm,
  ControlSessionInfo,
  CookieCopyScope,
  ManagedBrowserInfo,
  BrowserReleaseParams,
  BrowserReleaseResult,
  PageDownloadParams,
} from './browserActionProtocol.js';
import { isAgentServiceAction, type AgentServiceActionMap } from './agentServiceProtocol.js';
import type {
  BrowserEnhancementRequest,
  BrowserEnhancementResponse,
} from './browserEnhancement.js';
import {
  isToolboxServiceAction,
  type ToolboxServiceActionMap,
  type ToolboxTaskRequest,
  type ToolboxTaskResponse,
} from './toolbox.js';

export const EXTENSION_RPC_VERSION = 1;

export type OperationRequest<M> = {
  [O in keyof M]: M[O] extends { request: infer R } ? { operation: O } & R : never;
}[keyof M];
export type OperationResponse<M, R> = R extends { operation: infer O extends keyof M }
  ? M[O] extends { response: infer V }
    ? V
    : never
  : never;

export interface BrowserSessionOperations {
  list: { request: Record<never, never>; response: { sessions: ControlSessionInfo[] } };
  handoff: { request: { sessionId: string }; response: { session: ControlSessionInfo } };
  resume: { request: { sessionId: string }; response: { session: ControlSessionInfo } };
  release: { request: { sessionId: string }; response: { session: ControlSessionInfo } };
}
export interface BrowserInstanceOperations {
  start: { request: { browser: string }; response: ManagedBrowserInfo };
  detach: { request: { browser: string }; response: unknown };
  sync_cookies: { request: { browser: string; scope: CookieCopyScope }; response: unknown };
}
export interface BrowserProviderOperations {
  list: { request: Record<never, never>; response: BrowserProviderListResult };
  configure: {
    request: { provider: string; options: Record<string, BrowserJsonValue> };
    response: unknown;
  };
  launch_form: {
    request: { provider: string; variant?: string; values: Record<string, BrowserJsonValue> };
    response: BrowserProviderLaunchForm;
  };
}
export interface BrowserManagementActionMap {
  browser_sessions: {
    request: OperationRequest<BrowserSessionOperations>;
    response: BrowserSessionOperations[keyof BrowserSessionOperations]['response'];
  };
  browser_instances: {
    request: OperationRequest<BrowserInstanceOperations>;
    response: BrowserInstanceOperations[keyof BrowserInstanceOperations]['response'];
  };
  browser_providers: {
    request: OperationRequest<BrowserProviderOperations>;
    response: BrowserProviderOperations[keyof BrowserProviderOperations]['response'];
  };
  browser_list: {
    request: Record<string, never>;
    response: BrowserActionMap['browser_list']['response'];
  };
  browser_launch: BrowserActionMap['browser_launch'];
  browser_close: BrowserActionMap['browser_close'];
  get_browser_access_url: { request: { browser: string }; response: BrowserAccessResult };
}
export const BROWSER_MANAGEMENT_ACTIONS = {
  browser_sessions: true,
  browser_instances: true,
  browser_providers: true,
  browser_list: true,
  browser_launch: true,
  browser_close: true,
  get_browser_access_url: true,
} as const satisfies Record<keyof BrowserManagementActionMap, true>;
export type BrowserManagementAction = keyof BrowserManagementActionMap;
export type BrowserManagementResponse<
  A extends BrowserManagementAction,
  R,
> = A extends 'browser_sessions'
  ? OperationResponse<BrowserSessionOperations, R>
  : A extends 'browser_instances'
    ? OperationResponse<BrowserInstanceOperations, R>
    : A extends 'browser_providers'
      ? OperationResponse<BrowserProviderOperations, R>
      : BrowserManagementActionMap[A]['response'];

export function isBrowserManagementAction(value: unknown): value is BrowserManagementAction {
  return typeof value === 'string' && Object.hasOwn(BROWSER_MANAGEMENT_ACTIONS, value);
}
export const CLOUD_CONNECTOR_ACTIONS = {
  start_cloud_connector: true,
  stop_cloud_connector: true,
  list_cloud_connectors: true,
} as const;
export function isCloudConnectorAction(
  value: unknown,
): value is keyof typeof CLOUD_CONNECTOR_ACTIONS {
  return typeof value === 'string' && Object.hasOwn(CLOUD_CONNECTOR_ACTIONS, value);
}
export interface CloudConnectorInfo {
  serverUrl: string;
  name?: string;
  pid: number;
}
export interface CloudConnectorActionMap {
  start_cloud_connector: {
    request: { serverUrl: string };
    response: { success: boolean; error?: string; name?: string; pid?: number };
  };
  stop_cloud_connector: {
    request: { serverUrl: string };
    response: { success: boolean; error?: string };
  };
  list_cloud_connectors: {
    request: Record<never, never>;
    response: { connectors: CloudConnectorInfo[] };
  };
}
export type ExtensionUiServiceActionMap = AgentServiceActionMap &
  ToolboxServiceActionMap &
  BrowserManagementActionMap &
  CloudConnectorActionMap;
export type ExtensionUiServiceAction = keyof ExtensionUiServiceActionMap;
export type ExtensionUiServiceRequest<A extends ExtensionUiServiceAction> =
  ExtensionUiServiceActionMap[A]['request'];
export type ExtensionUiServiceResponse<
  A extends ExtensionUiServiceAction,
  R,
> = A extends BrowserManagementAction
  ? BrowserManagementResponse<A, R>
  : A extends 'toolbox_task'
    ? R extends ToolboxTaskRequest
      ? ToolboxTaskResponse<R>
      : never
    : ExtensionUiServiceActionMap[A]['response'];
export function isExtensionUiServiceAction(value: unknown): value is ExtensionUiServiceAction {
  return (
    isAgentServiceAction(value) ||
    isToolboxServiceAction(value) ||
    isBrowserManagementAction(value) ||
    isCloudConnectorAction(value)
  );
}

export interface HostToExtensionActionMap {
  __browser_enhancement: {
    request: BrowserEnhancementRequest;
    response: BrowserEnhancementResponse;
  };
  __preset_installation: { request: Record<string, unknown>; response: unknown };
  __profile_install: { request: { source: string }; response: unknown };
  __preset_browser: {
    request:
      | { operation: 'sync'; installationRevision: string }
      | { operation: 'status' }
      | { operation: 'uninstall'; browserRevision: string; installationToken: string | null };
    response: {
      installationRevision: string | null;
      browserRevision: string | null;
      ready: boolean;
      settingsReady: boolean;
      installationToken?: string | null;
      accepted?: boolean;
      error?: string;
    };
  };
  __export_cookies: { request: { domains: string[] }; response: { cookies: unknown[] } };
  __capture_download: { request: PageDownloadParams; response: unknown };
  __control_cleanup: {
    request: BrowserReleaseParams & { tabIds: number[]; returningToAgent?: boolean };
    response: BrowserReleaseResult;
  };
  __control_deactivate: { request: { tabIds: number[] }; response: { updated: true } };
  __send_request_files: {
    request:
      | {
          operation: 'start';
          transferId: string;
          url: string;
          withCookies?: boolean;
          files: Array<{
            fieldName: string;
            filename: string;
            contentType: string;
            byteLength: number;
          }>;
        }
      | {
          operation: 'chunk';
          transferId: string;
          fileIndex: number;
          chunkIndex: number;
          base64: string;
        }
      | { operation: 'abort'; transferId: string };
    response: { accepted: true } | { receivedBytes: number } | { aborted: boolean };
  };
}
export const HOST_TO_EXTENSION_ACTIONS = {
  __browser_enhancement: true,
  __preset_installation: true,
  __profile_install: true,
  __preset_browser: true,
  __export_cookies: true,
  __capture_download: true,
  __control_cleanup: true,
  __control_deactivate: true,
  __send_request_files: true,
} as const satisfies Record<keyof HostToExtensionActionMap, true>;
export function isHostToExtensionAction(value: unknown): value is keyof HostToExtensionActionMap {
  return typeof value === 'string' && Object.hasOwn(HOST_TO_EXTENSION_ACTIONS, value);
}
/** These services originate in the extension background, not a runtime UI message. */
export const EXTENSION_BACKGROUND_ACTIONS = {
  preset_installation: true,
  preset_browser_transfer: true,
  app_profile_catalog: true,
  plugin_page_call: true,
  plugin_page_event: true,
} as const;
export function isPrivateExtensionServiceAction(value: unknown): boolean {
  return (
    isToolboxServiceAction(value) ||
    (isAgentServiceAction(value) && value !== 'agent_chat_run') ||
    (typeof value === 'string' &&
      ['browser_sessions', 'browser_instances', 'browser_providers'].includes(value)) ||
    (typeof value === 'string' && Object.hasOwn(EXTENSION_BACKGROUND_ACTIONS, value))
  );
}

export type ExtensionRpcErrorCode =
  'PROTOCOL_MISMATCH' | 'UNSUPPORTED_ACTION' | 'EXTENSION_UI_REQUIRED';
export class ExtensionRpcError extends Error {
  constructor(
    readonly code: ExtensionRpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionRpcError';
  }
}
export function extensionRpcErrorCode(error: unknown): ExtensionRpcErrorCode | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'PROTOCOL_MISMATCH' ||
    code === 'UNSUPPORTED_ACTION' ||
    code === 'EXTENSION_UI_REQUIRED'
    ? code
    : undefined;
}
export function getExtensionServiceTimeout(
  action: ExtensionUiServiceAction,
  data: { operation?: unknown } = {},
): number {
  if (action === 'browser_instances') return data.operation === 'detach' ? 60000 : 120000;
  if (action === 'browser_providers')
    return data.operation === 'launch_form' ? 120000 : data.operation === 'list' ? 15000 : 60000;
  if (action === 'browser_launch') return 120000;
  if (action === 'browser_close' || action === 'get_browser_access_url') return 60000;
  if (action === 'toolbox_plugin_uninstall' || action === 'toolbox_page') return 120000;
  if (action === 'toolbox_tool_invoke') return 180000;
  if (action === 'toolbox_tool_open') return 60000;
  if (action === 'toolbox_task' && data.operation === 'events') return 40000;
  if (action === 'agent_chat_pick_directory') return 300000;
  if (action === 'agent_chat_install_provider') return 420000;
  if (action === 'agent_chat_login_qoder') return 60000;
  // Installation can prepare a plugin's runtime after the Skill manager returns.
  if (action === 'agent_skills_install' || action === 'agent_skills_update') return 600000;
  if (action.startsWith('agent_skills_')) return 130000;
  if (
    [
      'agent_chat_start',
      'agent_chat_prepare',
      'agent_chat_send',
      'agent_chat_list_sessions',
      'agent_chat_refresh',
    ].includes(action)
  )
    return 70000;
  if (action === 'start_cloud_connector') return 65000;
  return 15000;
}
