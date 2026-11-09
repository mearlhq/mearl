export {
  PluginHostConnection,
  type PluginHostConnectionOptions,
  type PluginHostClientOptions,
} from './plugins/clients/pluginHostConnection.js';
/**
 * @mearl/client — unified Mearl browser client
 *
 * Discovers browser targets on this machine and every configured cloud connector,
 * then routes actions using the global browser ids returned by browser_list.
 */

export {
  PluginTaskClient,
  type PluginTaskStartOptions,
  type PluginTaskWaitOptions,
  type PluginTaskClientOptions,
  type PluginTask,
  type PluginTaskEvents,
  type PluginTaskListResult,
  type PluginTaskStartResult,
} from './plugins/clients/pluginTasks.js';
export { PluginPageClient } from './plugins/clients/pluginPages.js';
export type {
  PluginPageInstance,
  PluginPageEvents,
  PluginPageRuntime,
  PluginPageActivation,
  PluginPageTarget,
  PluginPageOperation,
} from './plugins/clients/pluginPages.js';

export {
  executeRegisteredPlugin,
  type PluginExecutorOptions,
  type PluginExecutorDependencies,
  type PluginCommandContext,
  type PluginExecutionHost,
  type PluginInvocationIdentity,
  type PluginInvocationSource,
} from './plugins/sdk/plugin.js';

export {
  UnifiedClient,
  UnifiedClient as MearlClient,
  decodeBrowserTarget,
  invoke,
  invokePlugin,
  listCloudConnectors,
} from './unified.js';
export type {
  UnifiedClientOptions,
  UnifiedInvokeOptions,
  UnifiedInvokeOptions as InvokeOptions,
} from './unified.js';
export type {
  PluginInvocation,
  PluginInvokeOptions,
  PluginProgress,
  StructuredPluginProgress,
} from './plugins/sdk/plugin.js';
export {
  APP_PROFILE_NAMES,
  BROWSER_DEVICE_PRESET_NAMES,
  BROWSER_ACTIONS,
  BROWSER_CAPABILITY_ACTIONS,
  BROWSER_COMMAND_ACTIONS,
  EXTENSION_BROWSER_ACTIONS,
  PAGE_ACT_ACTIONS,
  SEND_REQUEST_MAX_FILES,
  SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES,
  SEND_REQUEST_MAX_TOTAL_FILE_BYTES,
  isBrowserAction,
  isBrowserCapabilityAction,
  isBrowserCommandAction,
  isExtensionBrowserAction,
} from '@mearl/browser-core';
export type {
  ActionStep,
  AppProfileName,
  BrowserAction,
  BrowserActionMap,
  BrowserActionRequest,
  BrowserActionResponse,
  BrowserCapabilities,
  BrowserCapabilityAction,
  BrowserCloseParams,
  BrowserCommandAction,
  BrowserInfo,
  BrowserInfoBase,
  BrowserJsonValue,
  BrowserLaunchParams,
  BrowserProviderOperation,
  BrowserListResult,
  BrowserListParams,
  BrowserPairingInfo,
  BrowserReleaseFailure,
  BrowserReleaseResult,
  BrowserProviderDefinition,
  BrowserProviderIdentity,
  BrowserProviderInputSchema,
  BrowserProviderListResult,
  BrowserReference,
  BrowserDetails,
  BrowserSource,
  BrowserStatus,
  BrowserScreenshotKind,
  BrowserTransport,
  CaptureCheckpointParams,
  CaptureCheckpointResult,
  BrowserDevicePresetName,
  BrowserEmulationOptions,
  ExtensionBrowserAction,
  GetCookieParams,
  GetCookieResult,
  GetEventsParams,
  GetLogsParams,
  GetMocksParams,
  GetRequestsParams,
  ManagedBrowserInfo,
  PageClickParams,
  PageDragEndpoint,
  PageDragParams,
  PageDragPoint,
  PageActAction,
  PageDiagnosticsOptions,
  PageDiagnosticsSetting,
  PageEvalParams,
  PageFramesParams,
  PageHoverParams,
  PageInspectFilter,
  PageInspectParams,
  PageNavigateParams,
  PageObservationWaitOptions,
  PagePressParams,
  PageScreenshotParams,
  PageScrollParams,
  PageSnapshotParams,
  PageSnapshotQuery,
  PageTypeParams,
  PageUploadParams,
  PageWaitParams,
  RegularBrowserInfo,
  RequestPermissionParams,
  RulesResult,
  RunActionName,
  RunActionsParams,
  SelectBrowserParams,
  SelectBrowserResult,
  SendRequestFile,
  SendRequestBinaryBody,
  SendRequestFormValue,
  SendRequestParams,
  SetAppProfileParams,
  SetCookieParams,
  SetCookieResult,
  SetDeviceEmulationParams,
  SetMockParams,
  SetRuleParams,
  SetTimezoneParams,
  SetTimezoneResult,
  TabCloseParams,
  TabOpenParams,
} from '@mearl/browser-core';

import { invoke, type UnifiedInvokeOptions } from './unified.js';
import type * as Protocol from '@mearl/browser-core';

export function tabCheckpoint(
  params: Protocol.CaptureCheckpointParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'tab_checkpoint'>> {
  return invoke('tab_checkpoint', params, options);
}

/** Compatibility wrapper for tabCheckpoint. */
export function captureCheckpoint(
  params: Protocol.CaptureCheckpointParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'tab_checkpoint'>> {
  return tabCheckpoint(params, options);
}

export function getRequests(
  params: Protocol.GetRequestsParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'get_requests'>> {
  return invoke('get_requests', params, options);
}

export function getLogs(
  params: Protocol.GetLogsParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'get_logs'>> {
  return invoke('get_logs', params, options);
}

export function getEvents(
  params: Protocol.GetEventsParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'get_events'>> {
  return invoke('get_events', params, options);
}

export function setMock(
  params: Protocol.SetMockParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'set_mock'>> {
  return invoke('set_mock', params, options);
}

export function getMocks(
  params: Protocol.GetMocksParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'get_mocks'>> {
  return invoke('get_mocks', params, options);
}

export function sendRequest(
  params: Protocol.SendRequestParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'send_request'>> {
  return invoke('send_request', params, options);
}

export function browserList(
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_list'>>;
export function browserList(
  params: Protocol.BrowserListParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_list'>>;
export function browserList(
  paramsOrOptions: Protocol.BrowserListParams | UnifiedInvokeOptions = {},
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_list'>> {
  return 'provider' in paramsOrOptions || 'launchForm' in paramsOrOptions
    ? invoke('browser_list', paramsOrOptions, options)
    : invoke('browser_list', {}, paramsOrOptions);
}

export function selectBrowser(
  params: Protocol.SelectBrowserParams = {},
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_select_browser'>> {
  return invoke('browser_select_browser', params, options);
}

export function browserRelease(
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_release'>>;
export function browserRelease(
  params: Protocol.BrowserReleaseParams,
  options: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_release'>>;
export function browserRelease(
  paramsOrOptions: Protocol.BrowserReleaseParams | UnifiedInvokeOptions = {},
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_release'>> {
  return options
    ? invoke('browser_release', paramsOrOptions, options)
    : invoke('browser_release', {}, paramsOrOptions as UnifiedInvokeOptions);
}

export function browserLaunch(
  params: Protocol.BrowserLaunchParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_launch'>> {
  return invoke('browser_launch', params, options);
}

export function browserClose(
  params: Protocol.BrowserCloseParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'browser_close'>> {
  return invoke('browser_close', params, options);
}

export function setRule(
  params: Protocol.SetRuleParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'set_rule'>> {
  return invoke('set_rule', params, options);
}

export function getRules(
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'get_rules'>> {
  return invoke('get_rules', {}, options);
}

export function pageScreenshot(
  params: Protocol.PageScreenshotParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_screenshot'>> {
  return invoke('page_screenshot', params, options);
}

export function tabOpen(
  params: Protocol.TabOpenParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'tab_open'>> {
  return invoke('tab_open', params, options);
}

export function tabClose(
  params: Protocol.TabCloseParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'tab_close'>> {
  return invoke('tab_close', params, options);
}

export function getCapabilities(
  params: Protocol.GetCapabilitiesParams = {},
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'get_capabilities'>> {
  return invoke('get_capabilities', params, options);
}

export function tabList(
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'tab_list'>> {
  return invoke('tab_list', {}, options);
}

export function tabGroup(
  params: Protocol.TabGroupParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'tab_group'>> {
  return invoke('tab_group', params, options);
}

export function pageClick(
  params: Protocol.PageClickParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_click'>> {
  return invoke('page_click', params, options);
}

export function pageDrag(
  params: Protocol.PageDragParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_drag'>> {
  return invoke('page_drag', params, options);
}

export function pageType(
  params: Protocol.PageTypeParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_type'>> {
  return invoke('page_type', params, options);
}

export function pageScroll(
  params: Protocol.PageScrollParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_scroll'>> {
  return invoke('page_scroll', params, options);
}

export function pageHover(
  params: Protocol.PageHoverParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_hover'>> {
  return invoke('page_hover', params, options);
}

export function pageEval(
  params: Protocol.PageEvalParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_eval'>> {
  return invoke('page_eval', params, options);
}

export function pageCallTool(
  params: Protocol.BrowserActionRequest<'page_call_tool'>,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_call_tool'>> {
  return invoke('page_call_tool', params, options);
}

export function pageInspect(
  params: Protocol.PageInspectParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_inspect'>> {
  return invoke('page_inspect', params, options);
}

export function pageSnapshot(
  params: Protocol.PageSnapshotParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_snapshot'>> {
  return invoke('page_snapshot', params, options);
}

export function pagePress(
  params: Protocol.PagePressParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_press'>> {
  return invoke('page_press', params, options);
}

export function pageWait(
  params: Protocol.PageWaitParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_wait'>> {
  return invoke('page_wait', params, options);
}

export function pageNavigate(
  params: Protocol.PageNavigateParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_navigate'>> {
  return invoke('page_navigate', params, options);
}

export function pageUpload(
  params: Protocol.PageUploadParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_upload'>> {
  return invoke('page_upload', params, options);
}

export function pageFrames(
  params: Protocol.PageFramesParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'page_frames'>> {
  return invoke('page_frames', params, options);
}

export function setDeviceEmulation(
  params: Protocol.SetDeviceEmulationParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'set_device_emulation'>> {
  return invoke('set_device_emulation', params, options);
}

export function setAppProfile(
  params: Protocol.SetAppProfileParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'set_app_profile'>> {
  return invoke('set_app_profile', params, options);
}

export function setTimezone(
  params: Protocol.SetTimezoneParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'set_timezone'>> {
  return invoke('set_timezone', params, options);
}

export function getCookie(
  params: Protocol.GetCookieParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'get_cookie'>> {
  return invoke('get_cookie', params, options);
}

export function setCookie(
  params: Protocol.SetCookieParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'set_cookie'>> {
  return invoke('set_cookie', params, options);
}

export function runActions(
  params: Protocol.RunActionsParams,
  options?: UnifiedInvokeOptions,
): Promise<Protocol.BrowserActionResponse<'run_actions'>> {
  return invoke('run_actions', params, options);
}

export function browserControl(
  params: Protocol.BrowserControlParams,
  options?: UnifiedInvokeOptions,
) {
  return invoke('browser_control', params, options);
}

export function pageDownload(params: Protocol.PageDownloadParams, options?: UnifiedInvokeOptions) {
  return invoke('page_download', params, options);
}

export async function saveArtifact(
  artifact: Protocol.BrowserArtifact & { browserId?: string },
  outputPath: string,
  options: UnifiedInvokeOptions = {},
) {
  const { exportArtifact } = await import('./artifacts.js');
  return exportArtifact({ invoke }, artifact, outputPath, options);
}

export { PluginStateClient } from './plugins/clients/pluginState.js';
export { PluginModelClient } from './plugins/clients/pluginModels.js';
export type * from '@mearl/browser-core';

export { getStructure as structure, type StructureOptions } from '@mearl/browser-core';

export type {
  GetCapabilitiesParams,
  BrowserCapabilityCatalog,
  AppCapability,
  AppProfileUsage,
} from '@mearl/browser-core';
