import type {
  AppProfileBinding,
  AppProfilePolicies,
  AppProfileSetting,
} from '../appProfileDefinition.js';
import type { BrowserDevicePresetName } from '../browserActionProtocol.js';
import type { DeviceCutout } from '../deviceEmulation.js';

/** 桥调用风格，与页面适配器使用的端内调用约定一一对应。 */
export type AppBridgeStyle = string;

export interface AppBridgeSpec {
  global: string;
  style: AppBridgeStyle;
  /** 页面脚本重设全局对象时仍保留桥叶子，同时接纳页面对象上的其他 API。 */
  persistent?: boolean;
}

/** Provider-defined identifier, interpreted by its installed page runtime. */
export type AppBridgeBehavior = string;

/** 桥方法名到标准化动作的映射。命名空间桥使用 `Class.method`，其余使用 api 名。 */
export interface BridgeActionMap {
  open: string[];
  close: string[];
  title: string[];
  navigationBar?: string[];
  statusBar?: string[];
  systemInfo: string[];
  protocol: string[];
  kvGet?: string[];
  kvSet?: string[];
  kvDelete?: string[];
  pageContext?: string[];
  responses?: Record<string, unknown>;
  behaviors?: Record<string, AppBridgeBehavior>;
  noop: string[];
  silent?: string[];
}

export interface AppSchemeRule {
  match: string;
  /** 规则仅在目标或当前页面 host 命中这些根域时生效。 */
  hostSuffixes?: string[];
  param?: string;
  /** 将参数解出的 H5 地址保留 path/query/hash，并投影到当前页面 origin。 */
  useCurrentOrigin?: boolean;
  targetPath?: string;
  targetHostPrefix?: string;
  targetParams?: Record<string, string>;
}

export interface AppMiniProgramPaymentRoute {
  /** 小程序支付中转页 pathname。 */
  pathname: string;
  /** 限制业务根域，避免同名小程序路由被其他项目接管。 */
  hostSuffixes?: string[];
  /** JSON 字符串形式的支付桥入参。 */
  paymentParamsParam: string;
  /** 按顺序读取的支付成功回跳参数，前者为空时使用后者。 */
  successUrlParams: string[];
  /** 按顺序读取的支付失败或取消回跳参数。 */
  failureUrlParams: string[];
  /** 支付成功结果写入回跳 URL 的参数名。 */
  successResultParam?: string;
  /** 从支付页路由透传到回跳 URL 的默认参数。 */
  forwardParams?: string[];
  /** 将回跳 H5 的 path/query/hash 投影到当前页面 origin。 */
  useCurrentOrigin?: boolean;
}

export type AppMiniProgramMessageAction = 'stageBackData' | 'closeAll';

export interface AppMiniProgramMessageRule {
  /** H5 通过 wx.miniProgram.postMessage 发送的 type。 */
  type: string;
  /** 容器只提供有限的页面栈动作，业务消息名由档案映射。 */
  action: AppMiniProgramMessageAction;
  /** 限制发送消息的 H5 根域。 */
  hostSuffixes?: string[];
}

export type AppMiniProgramNativeAction = 'navigateMiniProgram' | 'subscribeMessage';

export interface AppMiniProgramNativeRoute {
  /** 承接原生能力的小程序页面 pathname。 */
  pathname: string;
  /** 该页面允许模拟的固定原生动作，动作名读取 URL 的 action 参数。 */
  actions: AppMiniProgramNativeAction[];
  /** 限制业务根域，避免其他小程序的同名页面被接管。 */
  hostSuffixes?: string[];
}

/** 小程序容器相关规则统一收口，避免为每种业务页增加顶层配置。 */
export interface AppMiniProgramConfig {
  paymentRoutes?: AppMiniProgramPaymentRoute[];
  nativeRoutes?: AppMiniProgramNativeRoute[];
  messageRules?: AppMiniProgramMessageRule[];
}

export interface AppImagePickerConfig {
  schemes: string[];
  api: string;
  version: string;
  fcId: string;
  fcGroup: string;
  uploadUrlFunction: string;
  prefix: string;
  region: string;
}

export interface AppOverlayConfig {
  /** 半弹层最大 CSS 像素宽度，仍受所在视口和 maxWidth 比例参数约束。 */
  maxWidthPx?: number;
  /** 最大宽度限制开始生效的客户端版本，未设置时适用于所有版本。 */
  maxWidthMinAppVersion?: string;
  enabledParam: string;
  topRatioParam: string;
  /** 弹层高度占屏比例参数，与 topRatioParam 二选一即可。 */
  heightRatioParam?: string;
  radiusParam: string;
  maskAlphaParam: string;
  tapCloseParam: string;
  /** 蒙层关闭时优先触发当前 WebView 内的关闭控件，以复用页面定义的回传逻辑。 */
  tapCloseSelectors?: string[];
  /** 蒙层点击只退出当前 WebView，不调用页面关闭控件或打开回调。 */
  silentTapClose?: boolean;
  defaultTopRatio: number;
  defaultRadius: number;
  defaultMaskAlpha: number;
  defaultTapClose: boolean;
}

export interface AppNativeBackConfig {
  /** 原生返回键触发的 document 事件。 */
  event?: string;
  /** 返回 true 时由页面接管返回，再分发 event。 */
  controlFunction?: string;
  /** 原生返回键直接调用的 window 函数。 */
  handler?: string;
}

export interface AppLayerUrlProxyConfig {
  sourceHostPrefix: string;
  pathPrefix: string;
  targetHostSuffixes: string[];
  defaultTargetHost?: string;
}

export interface AppTitleBarConfig {
  navigationBarHeight: number;
  backgroundColor: string;
  textColor: string;
  hiddenPathnames?: string[];
  statusBarBackgroundColors?: Record<string, string>;
  hostStyles?: AppTitleBarHostStyle[];
}

export interface AppTitleBarHostStyle {
  /** 同时匹配该 host 与其全部子域，配置值不含前导点。 */
  hostSuffix: string;
  titleBarBackgroundColor?: string;
  statusBarBackgroundColor?: string;
}

export interface AppSafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** App 运行时使用的设备外观快照，避免通过机型字符串反推物理特征。 */
export interface AppDeviceAppearance {
  preset: BrowserDevicePresetName;
  orientation: 'portrait' | 'landscape';
  cutout: DeviceCutout;
}

export interface AppRootContainerCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface AppRootContainerConfig {
  enabled: boolean;
  initialCookies?: AppRootContainerCookie[];
  /** 横屏设备外壳中保留根页面，并将后续业务 WebView 呈现在右半屏。 */
  splitScreen?: boolean;
}

/** Accepted host modules are referenced by digest; their code stays in the browser resource store. */
export interface AppProfileHostCapabilities {
  modules: Record<string, { sha256: string; revision: string; handlers: string[]; config?: Record<string, unknown> }>;
  bindings: Record<string, { module: string; handler: string }>;
}

/** 注入页内的运行时配置，可经 Server-Timing 或 CDP new-document 脚本传输。 */
export interface InjectedAppProfileConfig {
  hostCapabilities?: AppProfileHostCapabilities;
  pageRuntime?: { id: string; sha256: string };
  binding?: AppProfileBinding;
  policies?: AppProfilePolicies;
  settings?: AppProfileSetting[];
  settingsUi?: 'runtime';
  settingsGroup?: string;
  profile: string;
  label: string;
  globals: Record<string, string>;
  bridges: AppBridgeSpec[];
  activeEvents: string[];
  maxTouchPoints: number;
  statusBarHeight: number;
  safeAreaInsets?: AppSafeAreaInsets;
  /** 可选，以兼容未携带设备外观快照的持久化配置。 */
  deviceAppearance?: AppDeviceAppearance;
  userAgent: string;
  navigatorPlatform: string;
  platform: string;
  systemVersion: string;
  clientType: string;
  language: string;
  actions: BridgeActionMap;
  schemes: AppSchemeRule[];
  miniProgram?: AppMiniProgramConfig;
  imagePicker?: AppImagePickerConfig;
  overlay?: AppOverlayConfig;
  /** URL 参数为真时以新 WebView 替换当前业务层。 */
  popBeforeOpenParam?: string;
  /** 跨 WebView 消息抵达 opener 时分发的 document 事件。 */
  messageEvent?: string;
  nativeBack?: AppNativeBackConfig;
  layerUrlProxy?: AppLayerUrlProxyConfig;
  urlSyncHostSuffixes?: string[];
  animationMs?: number;
  runtimeOptions?: Record<string, unknown>;
  titleBar?: AppTitleBarConfig;
  rootContainer?: AppRootContainerConfig;
  simulateSystemBars?: boolean;
  /** 物理状态栏与底部操作区由独立设备运行时渲染；本运行时只保留客户端导航栏。 */
  externalDeviceChrome?: boolean;
}
