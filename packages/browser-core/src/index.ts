export * from './appProfileDefinition.js';
export * from './types.js';
export * from './browserEnhancement.js';
export * from './browserDiscovery.js';
export * from './providerAppResources.js';
export * from './eventFilters.js';
export * from './requestSerializer.js';
export * from './boundedRequestBuffer.js';
export * from './proxyPermissions.js';
export * from './domTyping.js';
export * from './domSelectors.js';
export * from './domScrolling.js';
export * from './domInspection.js';
export * from './domSnapshot.js';
export * from './deviceEmulation.js';
export * from './deviceEnvironmentObservation.js';
export * from './debuggerTarget.js';
export * from './rootWebViewNavigation.js';
// appProfileRuntime 的值导出只经子路径 '@mearl/browser-core/appProfileRuntime' 暴露：
// early-inject（classic content script）必须自包含单文件，若主入口再 re-export 运行时函数，
// 多入口打包会把它抽成共享 chunk。主入口仅保留类型导出（编译后擦除，不进运行时模块图）。
export type {
  AppBridgeStyle,
  AppBridgeSpec,
  AppBridgeBehavior,
  BridgeActionMap,
  AppSchemeRule,
  AppMiniProgramConfig,
  AppMiniProgramPaymentRoute,
  AppMiniProgramMessageAction,
  AppMiniProgramMessageRule,
  AppMiniProgramNativeAction,
  AppMiniProgramNativeRoute,
  AppImagePickerConfig,
  AppOverlayConfig,
  AppNativeBackConfig,
  AppLayerUrlProxyConfig,
  AppTitleBarConfig,
  AppTitleBarHostStyle,
  AppSafeAreaInsets,
  AppRootContainerCookie,
  AppRootContainerConfig,
  InjectedAppProfileConfig,
  AppProfileHostCapabilities,
} from './app-profile-runtime/types.js';
export * from './axTextMatch.js';
export * from './domClicking.js';
export * from './pageDragging.js';
export * from './pagePressing.js';
export * from './axSnapshot.js';
export * from './pageObserver.js';
export * from './navigationTracker.js';
export * from './pageAct.js';
export * from './pageDialog.js';
export * from './backendNodeRefs.js';
export * from './pageEffectRefs.js';
export * from './pageWait.js';
export * from './pageNavigation.js';
export * from './pageWebMcp.js';
export * from './tabMatching.js';
export * from './agentChat.js';
export * from './agentSkills.js';
export * from './agentServiceProtocol.js';
export * from './toolbox.js';
export * from './toolboxIcon.js';
export * from './pluginExecution.js';
export * from './pluginTasks.js';
export * from './pluginPages.js';
export * from './pluginPageRuntime.js';
export * from './pluginPageHost.js';
export * from './browserActionProtocol.js';
export * from './browserCapabilities.js';
export * from './runActions.js';
export * from './sendRequestFiles.js';
export * from './sendRequestHeaders.js';
export * from './cookie.js';
export * from './controlledFavicon.js';
export * from './capture.js';
export * from './sseParser.js';
export * from './mockResponse.js';
export * from './pluginState.js';
export * from './pluginModels.js';
export * from './pluginRecovery.js';

export * from './pluginDiagnostics.js';

export * from './rootWebViewDocument.js';
export * from './extensionServiceProtocol.js';
export * from './requestStreamCapture.js';
export * from './responseText.js';
export * from './consumeSseResponse.js';

export { parseQueryString } from './queryString.js';

export * from './extensionVersion.js';

export { MEARL_NATIVE_HOST_NAMES, type NativeHostIntegrationMode } from './nativeHostNames.js';

export * from './dataStructure.js';

export * from './requestMetadata.js';
export * from './extensionAgentAccess.js';
