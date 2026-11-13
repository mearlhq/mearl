import type { BrowserCapabilityCatalog } from './browserCapabilities.js';
import type { PageCallToolParams } from './pageWebMcp.js';

export interface GetCapabilitiesParams {
  /** Include method and setting details for this installed App ID. */
  app?: string;
}

export interface GetRequestsParams {
  tabId: number;
  count?: number;
  filter?: string;
  /** Relative time window in seconds. */
  since?: number;
  /** Opaque cursor returned by tab_checkpoint or a previous query. */
  after?: string;
  /** Defaults to false when fields are selected, otherwise true. */
  includeBody?: boolean;
  includeHeaders?: boolean;
  maxBodySize?: number;
  fields?: string[];
  keysOnly?: boolean;
  applyHiddenFilter?: boolean;
  source?: 'protocol' | 'requests' | 'all';
}

export interface GetLogsParams {
  tabId: number;
  level?: 'log' | 'warn' | 'error' | 'info' | 'all';
  /** Relative time window in seconds. */
  since?: number;
  /** Opaque cursor returned by tab_checkpoint or a previous query. */
  after?: string;
  limit?: number;
  filter?: string;
}

export interface CaptureCheckpointParams {
  tabId: number;
}

export interface CaptureCheckpointResult {
  tabId: number;
  cursor: string;
  timestampMs: number;
  captureStatus: 'armed' | 'active';
}

export interface GetEventsParams {
  tabId: number;
  source?: 'rum' | 'aplus' | 'arms' | 'all';
  event_type?: string;
  filter?: string;
  since?: number;
  /** Opaque cursor returned by tab_checkpoint or a previous event query. */
  after?: string;
  limit?: number;
  includeRaw?: boolean;
}

export interface SetMockParams {
  tabId: number;
  apiName: string;
  mockData?: unknown;
  fields?: Array<{ path: string; value: unknown }>;
  enabled?: boolean;
  duration?: number;
  conditions?: Record<string, unknown>;
}

export interface GetMocksParams {
  tabId: number;
  apiName?: string;
}

export const SEND_REQUEST_MAX_FILES = 20;
// Bounds multipart buffering in native-host and the extension service worker.
export const SEND_REQUEST_MAX_TOTAL_FILE_BYTES = 40 * 1024 * 1024;
// Base64 expands by 4/3; 7 MiB leaves roughly 680 KiB for JSON framing under
// the 10 MiB cloud message limit.
export const SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES = 7 * 1024 * 1024;

export type SendRequestFormValue = string | number | boolean;

interface SendRequestFileMetadata {
  /** multipart/form-data field name. */
  fieldName: string;
  /** Defaults to a MIME type inferred from filename, then application/octet-stream. */
  contentType?: string;
}

export type SendRequestFile = SendRequestFileMetadata &
  (
    | {
        /** Absolute path on the machine running Mearl native-host. */
        filePath: string;
        base64?: never;
        /** Defaults to the basename of filePath. */
        filename?: string;
      }
    | {
        filePath?: never;
        /** Base64 payload; decoded Base64-backed files are limited to 7 MiB total. */
        base64: string;
        /** Multipart filename for the Base64 payload. */
        filename: string;
      }
  );

export type SendRequestBinaryBody = { contentType?: string } & (
  { filePath: string; base64?: never } | { filePath?: never; base64: string }
);

export interface SendRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  /** Raw bytes, mutually exclusive with body, formData and files. */
  bodyFile?: SendRequestBinaryBody;
  formData?: Record<string, SendRequestFormValue>;
  files?: SendRequestFile[];
  withCookies?: boolean;
  responseType?: 'json' | 'text' | 'auto';
  timeout?: number;
}

export interface NetworkControlSelection {
  id: string;
  value: string;
}

export type BrowserStatus = 'connected' | 'pairing' | 'running_disconnected' | 'stopped';

export type BrowserTransport = 'extension' | 'cdp' | 'provider';

/** Localized overrides for Provider UI text, keyed by locale or language. */
export interface BrowserProviderLocales<Field extends string> {
  locales?: Record<string, Partial<Record<Field, string>>>;
}

export interface BrowserPairingInfo extends BrowserProviderLocales<'label'> {
  kind: 'qr';
  url: string;
  /** Optional human-readable or provider-specific pairing code. */
  code?: string;
  label?: string;
}

export interface BrowserSource {
  kind: 'local' | 'remote';
  connectorId?: string;
  connectorName?: string;
}

export type BrowserJsonPrimitive = string | number | boolean | null;
export type BrowserJsonValue =
  BrowserJsonPrimitive | BrowserJsonValue[] | { [key: string]: BrowserJsonValue };

export type BrowserProviderOperation =
  | 'start'
  | 'close'
  | 'detach'
  | 'deleteData'
  | 'access'
  | 'syncCookies'
  | 'handoff'
  | 'resume'
  | 'finish';

export interface BrowserProviderIdentity {
  id: string;
  name: string;
  builtin: boolean;
  version?: string;
  protocolVersion?: number;
}

/** Common safe metadata; additional Provider-specific keys must also be non-secret JSON. */
export type BrowserDetails = Record<string, BrowserJsonValue> & {
  headless?: boolean;
  createdAt?: string;
  cdpPort?: number;
  copiedCookies?: { domains: string[]; count: number };
};

export interface BrowserReference extends BrowserProviderLocales<'label'> {
  kind: string;
  id: string;
  label?: string;
  /** Show this identifier in the collapsed browser row. */
  summary?: boolean;
}

export interface BrowserInfoBase {
  browserId: string;
  name: string;
  status: BrowserStatus;
  /** Source-local values retained when the unified client returns a global browser id and label. */
  originalBrowserId?: string;
  originalName?: string;
  source?: BrowserSource;
  extensionVersion?: string;
  nativeHostVersion?: string;
  transport?: BrowserTransport;
  /** Provider identity, independent from the browser control transport. */
  provider?: BrowserProviderIdentity;
  ownership?: 'owned' | 'attached';
  persistence?: 'ephemeral' | 'persistent';
  operations?: BrowserProviderOperation[];
  references?: BrowserReference[];
  /** Safe, non-secret metadata suitable for display and remote connectors. */
  details?: BrowserDetails;
  /** Setup information exposed by a provider while it waits for an external device. */
  pairing?: BrowserPairingInfo;
}

export type BrowserScreenshotKind = 'native' | 'reconstructed' | 'none';
export type BrowserControlSessionMode = 'mearl' | 'external';

/** Browser-targeted actions that an external provider may implement. */
export type BrowserCapabilityAction = ExtensionBrowserAction | 'page_download' | 'browser_release';

/** Capabilities advertised by an external browser-control provider. */
export interface BrowserCapabilities {
  actions: BrowserCapabilityAction[];
  /** Pixel fidelity of page_screenshot, or none when that action is unavailable. */
  screenshot: BrowserScreenshotKind;
  /** Fixed per instance. Omitted means Mearl sessions; external delegates task control. */
  controlSessionMode?: BrowserControlSessionMode;
  /** Provider returns dialog receipts from page_snapshot and accepts page_press dialogId. */
  nativeDialogs?: true;
}

export interface RegularBrowserInfo extends BrowserInfoBase {
  type: 'regular';
  status: 'connected' | 'pairing';
}

export interface ManagedBrowserInfo extends BrowserInfoBase {
  type: 'managed';
  status: 'connected' | 'pairing' | 'running_disconnected' | 'stopped';
  provider: BrowserProviderIdentity;
  persistence: 'ephemeral' | 'persistent';
  operations: BrowserProviderOperation[];
}

export type BrowserInfo = RegularBrowserInfo | ManagedBrowserInfo;

export interface BrowserListParams {
  provider: string;
  launchForm: { variant?: string; values: Record<string, BrowserJsonValue> };
}

export interface BrowserListResult {
  count: number;
  connectedCount: number;
  defaultBrowserId: string | null;
  browsers: BrowserInfo[];
  /** Partial discovery failures; successfully inspected browser sources remain in the result. */
  warnings?: string[];
  /** Present only for an explicit, source-local Provider launch-form query. */
  discovery?: { provider: string; launchForm: BrowserProviderLaunchForm };
}

export interface SelectBrowserParams {
  browser?: string;
}

export interface SelectBrowserResult {
  selected: { browserId: string; name: string } | null;
  note?: string;
}

export interface BrowserReleaseFailure {
  tabId: number;
  stage: string;
  error: string;
}

export interface BrowserReleaseResult {
  released: boolean;
  hadActiveControl: boolean;
  transports: BrowserTransport[];
  affectedTabIds: number[];
  failures?: BrowserReleaseFailure[];
}

export interface ControlSessionInfo {
  sessionId: string;
  browserId: string;
  transport: BrowserTransport;
  status: 'active' | 'user' | 'releasing' | 'released';
  generation: number;
  tabs: Array<{ tabId: number; source: 'created' | 'attached'; title?: string; url?: string }>;
  reason?: string;
}

export interface BrowserReleaseParams {
  /** Close only session-created pages; attached user pages are protected. */
  closeCreatedTabs?: boolean;
  keepTabIds?: number[];
  /** Preserve the browser environment by default for a scoped release. */
  preserveEnvironment?: boolean;
  keepArtifactIds?: string[];
}

export interface BrowserControlParams {
  operation: 'handoff' | 'resume' | 'finish';
  tabId?: number;
  reason?: string;
  /** External Provider finish only; retain these result pages. */
  keepTabIds?: number[];
}

export interface ExternalBrowserControlResult {
  controlSessionMode: 'external';
  operation: BrowserControlParams['operation'];
  control: 'agent' | 'user' | 'finished';
}

export interface BrowserArtifact {
  artifactId: string;
  filename: string;
  bytes: number;
  location: 'browser';
  /** Global browser route is attached by the unified client. */
  browserId?: string;
}

export interface PageRecordingOptions {
  maxWidth?: number;
  maxHeight?: number;
  frameRate?: number;
  audio?: boolean;
}

export type PageRecordParams =
  | ({ operation: 'start'; tabId: number } & PageRecordingOptions)
  | { operation: 'stop' | 'status'; recordingId: string };

export type PageRecordingStopReason = 'requested' | 'duration_limit';

export type PageRecordingStatus =
  | { state: 'recording' }
  | { state: 'finalizing'; stopReason: PageRecordingStopReason }
  | { state: 'ready'; stopReason: PageRecordingStopReason; recording: BrowserArtifact }
  | { state: 'interrupted'; error: string };

export type PageRecordResult =
  | {
      operation: 'start';
      tabId: number;
      browserId: string;
      recordingId: string;
      maxDurationMs: number;
    }
  | { operation: 'stop'; tabId: number; recordingId: string; recording: BrowserArtifact }
  | ({
      operation: 'status';
      tabId: number;
      browserId: string;
      recordingId: string;
      startedAt: number;
      autoStopAt: number;
    } & PageRecordingStatus);

export interface PageDownloadParams {
  tabId: number;
  trigger: Omit<PageClickParams, 'tabId'>;
  /** Restrict the expected download URL; useful when the browser cannot identify its source. */
  url?: string;
  timeout?: number;
}

export interface PageDownloadResult {
  download: BrowserArtifact;
  action: unknown;
}

export interface CookieCopyScope {
  /** Named scopes supplied by installed capabilities. */
  presets?: string[];
  /** Additional domains or URLs to copy alongside the selected presets. */
  domains?: string[];
}

export interface BrowserLaunchParams {
  /** Required by the built-in local Provider. */
  name?: string;
  /** Built-in runtime or the id of a registered external Provider. */
  provider?: string;
  /** Structured launch parameters declared by the selected Provider. Cannot be mixed with flat options. */
  providerOptions?: Record<string, BrowserJsonValue>;
  /** Whether the built-in local Chrome uses headless mode. Defaults to true. */
  headless?: boolean;
  /** Desktop mode uses a user agent matching the local Chrome version. */
  userAgentMode?: 'default' | 'desktop';
  persistent?: boolean;
  executablePath?: string;
  url?: string;
  /** Copy explicit domains, a capability-provided scope, or a combination of both. */
  copyCookieDomains?: string[] | string | CookieCopyScope;
}

export interface BrowserCloseParams {
  browser: string;
  deleteProfile?: boolean;
}

export type BrowserManageParams =
  | ({ operation: 'launch' } & BrowserLaunchParams)
  | { operation: 'attach'; provider: string; providerOptions?: Record<string, BrowserJsonValue> }
  | { operation: 'close'; deleteProfile?: boolean }
  | { operation: 'detach' }
  | { operation: 'release' };

export type SessionManageParams =
  | { operation: 'new' }
  | { operation: 'handoff'; sessionId?: string; reason?: string }
  | { operation: 'resume'; sessionId?: string }
  | ({ operation: 'end'; sessionId?: string } & BrowserReleaseParams);

interface BrowserProviderSchemaBase extends BrowserProviderLocales<
  'title' | 'description' | 'placeholder'
> {
  title?: string;
  description?: string;
  default?: BrowserJsonValue;
  /** Optional Mearl form component used to edit this schema value. */
  component?: 'cookie-sync' | 'switch';
  /** Presentation-only default used by Mearl forms without changing runtime semantics. */
  formDefault?: BrowserJsonValue;
  /** Excludes an advanced runtime option from generated Mearl forms. */
  formHidden?: boolean;
  /** Places compact fields side by side in generated Mearl forms. */
  formWidth?: 'half' | 'full';
  /** Hides the optional badge without changing schema validation. */
  formHideOptional?: boolean;
  /** Conditionally displays and submits this field based on another form value. */
  formVisibleWhen?: { field: string; empty: boolean };
}

export type BrowserProviderInputSchema =
  | (BrowserProviderSchemaBase & {
      type: 'string';
      secret?: boolean;
      enum?: readonly string[];
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      placeholder?: string;
      options?: readonly BrowserProviderInputOption[];
    })
  | (BrowserProviderSchemaBase & {
      type: 'number';
      integer?: boolean;
      minimum?: number;
      maximum?: number;
      placeholder?: string;
    })
  | (BrowserProviderSchemaBase & { type: 'boolean' })
  | (BrowserProviderSchemaBase & {
      type: 'array';
      items: BrowserProviderInputSchema;
      minItems?: number;
      maxItems?: number;
    })
  | BrowserProviderObjectSchema;

export interface BrowserProviderObjectSchema extends BrowserProviderSchemaBase {
  type: 'object';
  properties: Record<string, BrowserProviderInputSchema>;
  required?: readonly string[];
  oneOf?: readonly BrowserProviderObjectSchema[];
  not?: BrowserProviderObjectSchema;
  additionalProperties?: boolean;
}

export interface BrowserProviderInputOption extends BrowserProviderLocales<
  'label' | 'description'
> {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface BrowserProviderDefinition {
  provider: BrowserProviderIdentity;
  browserType: BrowserProviderLocales<'name'> & {
    name: string;
    /** Operation exposed for the Provider's instance entry point. Defaults to launch. */
    openOperation?: 'launch' | 'attach';
    controlSessionModes?: readonly BrowserControlSessionMode[];
    documentationUrl?: string;
    inputSchema: BrowserProviderObjectSchema;
    configuration?: { inputSchema: BrowserProviderObjectSchema };
    dynamicLaunchForm?: boolean;
    launchForm?: BrowserProviderLaunchForm;
  };
}

export interface BrowserProviderLaunchFormVariant extends BrowserProviderLocales<
  'title' | 'description'
> {
  id: string;
  title: string;
  description?: string;
  inputSchema?: BrowserProviderObjectSchema;
  values?: Record<string, BrowserJsonValue>;
  refreshOn?: readonly string[];
  dynamicFields?: readonly string[];
}

export interface BrowserProviderLaunchForm extends BrowserProviderLocales<'message'> {
  inputSchema: BrowserProviderObjectSchema;
  variants?: readonly BrowserProviderLaunchFormVariant[];
  variant?: string;
  values?: Record<string, BrowserJsonValue>;
  refreshOn?: readonly string[];
  dynamicFields?: readonly string[];
  message?: string;
  blocked?: boolean;
}

export interface BrowserProviderListResult {
  providers: BrowserProviderDefinition[];
}

export interface BrowserAccessResult {
  browserAccess: {
    kind: string;
    url: string;
    sensitive: true;
  };
}

export interface AddRuleParams {
  enabled?: true;
  actionType: 'redirect' | 'block' | 'allow' | 'upgradeScheme' | 'modifyHeaders';
  filter: string;
  redirectUrl?: string;
  requestHeaders?: Array<{
    header: string;
    operation: 'set' | 'append' | 'remove';
    value?: string;
  }>;
  responseHeaders?: Array<{
    header: string;
    operation: 'set' | 'append' | 'remove';
    value?: string;
  }>;
  initiatorDomains?: string;
  resourceTypes?: string[];
  priority?: number;
  description?: string;
}

export interface DeleteRuleParams {
  enabled: false;
  ruleId: number;
}

export type SetRuleParams = AddRuleParams | DeleteRuleParams;

export interface RulesResult {
  enabled: boolean;
  rules: Array<Record<string, unknown>>;
}

export interface PageScreenshotParams {
  tabId: number;
  selector?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  captureMode?: 'cdp' | 'visible';
}

export const BROWSER_DEVICE_PRESET_NAMES = [
  'iphone-duo-folded',
  'iphone-duo-unfolded',
  'iphone-17-pro',
  'iphone-17e',
  'pixel-11',
  'ipad-mini-a17-pro',
  'galaxy-s26',
  'pura-x-max',
  // 旧名称保留具体机型语义，供已有调用与历史回归基线继续使用。
  'iphone-15-pro',
  'iphone-se',
  'pixel-8',
  'ipad-mini',
  'galaxy-s23',
] as const;

export type BrowserDevicePresetName = (typeof BROWSER_DEVICE_PRESET_NAMES)[number];

export interface BrowserEmulationOptions {
  preset?: BrowserDevicePresetName;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  scale?: number;
  mobile?: boolean;
  userAgent?: string;
  orientation?: 'portrait' | 'landscape';
  touch?: boolean;
  /** 在 iframe WebView 外渲染顶部状态栏和底部操作区；默认 false。 */
  deviceShell?: boolean;
  /** App 容器横屏时将根页面与业务页面分置左右 WebView，需要同时开启 deviceShell 和端模拟。 */
  splitScreen?: boolean;
}

/** Provider-defined behavior ID; core does not execute or enumerate business behaviors. */
export type AppBridgeConfigBehavior = string;

/** 单个桥方法的声明式覆盖；行为、固定回包、成功空实现三选一。 */
export interface AppBridgeMethodConfig {
  behavior?: AppBridgeConfigBehavior;
  response?: unknown;
  noop?: boolean;
  silent?: boolean;
}

/** 追加或覆盖端模拟配置中的桥方法。配置保持 JSON 可序列化。 */
export interface AppBridgeConfig {
  methods: Record<string, AppBridgeMethodConfig>;
}

export interface TabOpenParams {
  url: string;
  active?: boolean;
  /** Source tab whose Agent conversation should own the opened or reused tab. */
  openerTabId?: number;
  closeExisting?: boolean;
  reuse?: 'never' | 'prefer' | 'require';
  match?: {
    urlPattern?: string;
    ignoreSearch?: boolean;
    ignoreHash?: boolean;
    onMultiple?: 'error' | 'first';
  };
  restoreFocusOnClose?: boolean;
  emulation?: BrowserEmulationOptions;
  group?: string;
  /**
   * 端模拟配置 ID，通过 get_capabilities 查询。该配置提供容器 UA、环境变量、JSBridge 和桥协议。
   * 设备视口由 emulation 配置，系统栏由 emulation.deviceShell 控制。
   */
  appProfile?: AppProfileName;
  /** 与 appProfile 配合使用；容器系统，默认 ios */
  os?: 'ios' | 'android';
  /** 与 appProfile 配合使用，按方法覆盖端模拟的内置桥配置。 */
  bridgeConfig?: AppBridgeConfig;
}

export type TabGroupParams =
  | { tabIds: number[]; title: string; ungroup?: false }
  | { tabIds: number[]; ungroup: true; title?: never };

/** App identities are supplied by installed capability catalogs. */
export const APP_PROFILE_NAMES: readonly string[] = [];
export type BuiltinAppProfileName = string;
/** Hosts validate dynamic profile IDs against the active capability catalog. */
export type AppProfileName = string;

export interface SetAppProfileParams {
  tabId: number;
  /** false 时清除该 tab 的容器模拟并刷新 */
  enabled: boolean;
  /** 端模拟配置 ID（enabled=true 时必填）。 */
  profile?: AppProfileName;
  /** Immediately use the latest installed definition while preserving explicit options. */
  refreshDefinition?: boolean;
  /** 固定当前端模拟配置。默认在下次文档导航时自动采用可用更新。 */
  lockDefinition?: boolean;
  os?: 'ios' | 'android';
  appVersion?: string;
  /** 端定义支持的语言选项。 */
  language?: string;
  deviceModel?: string;
  /** 按方法覆盖端模拟的内置桥配置，仅支持受控行为、固定 JSON 回包和成功空实现。 */
  bridgeConfig?: AppBridgeConfig;
  /**
   * 可选已安装的网络控件选择；null 清除，省略时保持当前设置。
   * 仅作用于目标 tab，扩展模式与该 tab 的快捷设置共享。
   */
  networkControl?: NetworkControlSelection | null;
  /**
   * 可选设备联动参数。传入时显式字段覆盖端模拟的推荐设备，空对象使用推荐设备且默认开启
   * deviceShell；省略时不设置或清除该 tab 的设备状态。
   */
  emulation?: BrowserEmulationOptions;
  /** 默认 true：应用/清除后刷新页面使注入生效 */
  reload?: boolean;
}

export interface TabCloseParams {
  tabId: number;
}

export interface PageObservationWaitOptions {
  quietMs?: number;
  firstChangeTimeoutMs?: number;
  timeoutMs?: number;
  navigationGraceMs?: number;
  navigationTimeoutMs?: number;
  networkIdleMs?: number;
  contentReadyAfterMs?: number;
}

export interface PageDiagnosticsOptions {
  logs?: boolean | Pick<GetLogsParams, 'level' | 'limit' | 'filter'>;
  requests?:
    | boolean
    | Pick<
        GetRequestsParams,
        | 'count'
        | 'filter'
        | 'includeBody'
        | 'includeHeaders'
        | 'maxBodySize'
        | 'fields'
        | 'keysOnly'
        | 'source'
      >;
  events?:
    boolean | Pick<GetEventsParams, 'source' | 'event_type' | 'filter' | 'limit' | 'includeRaw'>;
}

export type PageDiagnosticsSetting = PageDiagnosticsOptions | boolean;

export interface PageClickParams {
  tabId: number;
  selector?: string;
  text?: string;
  point?: { x: number; y: number };
  /** CSS/text 查询的目标 frame；省略时容器模式自动使用当前业务 frame。 */
  frameId?: string;
  /** point 的坐标空间；手机壳预览默认 active-frame，其他页面默认 outer-viewport。 */
  coordinateSpace?: 'outer-viewport' | 'active-frame';
  role?: string;
  exact?: boolean;
  scope?: string;
  clickMode?: 'auto' | 'dom' | 'mouse' | 'touch';
  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
}

export interface PageDragPoint {
  x: number;
  y: number;
}

export type PageDragEndpoint = string | PageDragPoint;

export interface PageDragParams {
  tabId: number;
  from: PageDragEndpoint;
  to: PageDragEndpoint;
  dragMode?: 'auto' | 'dom' | 'mouse' | 'touch';
  durationMs?: number;
  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
}

export interface PageTypeParams {
  tabId: number;
  selector: string;
  text: string;
  clearFirst?: boolean;
  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
}

export interface PageScrollParams {
  tabId: number;
  direction: 'up' | 'down' | 'top' | 'bottom';
  distance?: number;
  selector?: string;
  containerPolicy?: 'self' | 'nearest';
  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
}

export interface PageHoverParams {
  tabId: number;
  selector: string;
  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
}

export interface PageEvalParams {
  tabId: number;
  expression: string;
  /** When provided, expression must evaluate to a function called with these JSON arguments. */
  args?: unknown[];
  frameId?: string;
  awaitPromise?: boolean;
  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
  executionWorld?: 'main' | 'isolated';
  worldId?: string;
}

export function resolvePageEvalExpression(
  params: Pick<PageEvalParams, 'expression' | 'args'>,
): string {
  if (typeof params.expression !== 'string' || !params.expression.trim())
    throw new Error('Invalid expression');
  if (params.args === undefined) return params.expression;
  if (!Array.isArray(params.args)) throw new Error('page_eval args must be an array');
  return `(${params.expression})(...JSON.parse(${JSON.stringify(JSON.stringify(params.args))}))`;
}

export interface PageUserScriptParams {
  tabId: number;
  worldId: string;
  code: string;
}

export function validatePageUserScriptParams(params: PageUserScriptParams): void {
  if (!Number.isSafeInteger(params?.tabId) || params.tabId < 0) {
    throw new Error('Invalid target tab');
  }
  if (typeof params.worldId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(params.worldId)) {
    throw new Error('Invalid user script worldId');
  }
  if (typeof params.code !== 'string' || !params.code.trim() || params.code.length > 256 * 1024) {
    throw new Error('User script code must be non-empty and within 256 KiB characters');
  }
}

export interface PageSnapshotQuery {
  text?: string;
  role?: string;
  exact?: boolean;
}

export interface PageSnapshotParams {
  tabId: number;
  includeWebMcp?: 'full';
  depth?: number;
  maxChars?: number;
  maxNodes?: number;
  rootSelector?: string;
  rootRef?: string;
  ancestorDepth?: number;
  query?: PageSnapshotQuery;
  mode?: 'full' | 'interactive' | 'viewport' | 'dom';
}

export type PageInspectFilter =
  'all' | 'overflowing' | 'horizontal-overflow' | 'vertical-overflow' | 'scrollable';

export interface PageInspectParams {
  tabId: number;
  /** Native CSS selector, a page_snapshot @ref, or DevTools' current selection ($0). */
  selector?: string;
  /** Limit results after filtering. Defaults to 20, maximum 100. */
  maxResults?: number;
  /** Computed-style properties to return. Defaults to common layout properties. */
  styles?: string[];
  /** Page-wide or selector-scoped layout filter. Defaults to all. */
  filter?: PageInspectFilter;
  /** Include a trimmed outerHTML string for returned matches. Defaults to true for $0. */
  includeOuterHTML?: boolean;
}

export interface PagePressParams {
  tabId: number;
  key: string;
  /** Explicit native JavaScript dialog target obtained from a receipt or page_snapshot. */
  dialogId?: string;
  /** Only for accepting a native prompt with dialogId + Enter. */
  promptText?: string;
  modifiers?: string[];
  /** Dispatch strategy. Auto uses DOM events when the page is hidden. */
  pressMode?: 'auto' | 'dom' | 'keyboard';
  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
}

export interface PageWaitParams {
  tabId: number;
  time?: number;
  selector?: string;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  text?: string;
  exact?: boolean;
  condition?: string;
  timeout?: number;
  interval?: number;
}

export interface PageNavigateParams {
  tabId: number;
  url?: string;
  refresh?: boolean;
  history?: 'back' | 'forward';
}

export interface PageUploadParams {
  tabId: number;
  selector: string;
  /** Absolute paths available to the browser host. */
  filePaths?: string[];
  /** SDK/CLI stages caller-local files before dispatch. Mutually exclusive with filePaths. */
  files?: Array<{ filePath: string } | { artifactId: string }>;

  observe?: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsSetting;
}

export interface PageFramesParams {
  tabId: number;
}

export interface SetDeviceEmulationParams extends BrowserEmulationOptions {
  tabId: number;
  enabled: boolean;
  reload?: boolean;
}

export interface SetTimezoneParams {
  tabId: number;
  timezone: string;
}

export interface SetTimezoneResult {
  enabled: boolean;
  timezone: string | null;
}

export interface GetCookieParams {
  /** Select the tab's cookie store; omitted for the browser's default store. */
  tabId?: number;
  name: string;
  /** Cookie lookup URL; required without tabId, otherwise defaults to the tab URL. */
  url?: string;
  domain?: string;
  path?: string;
}

export interface GetCookieResult {
  tabId?: number;
  url: string;
  name: string;
  found: boolean;
  value?: string;
  domain?: string;
  path?: string;
}

export interface SetCookieParams {
  /** Select the tab's cookie store; required when reload is true. */
  tabId?: number;
  name: string;
  value: string;
  /** Cookie target URL; required when tabId is omitted. */
  url?: string;
  domain?: string;
  path?: string;
  reload?: boolean;
}

export interface SetCookieResult {
  tabId?: number;
  url: string;
  name: string;
  domain: string;
  path: string;
  reloaded: boolean;
}

export interface RequestPermissionParams {
  domain: string;
}

export type RunActionName = Exclude<ExtensionBrowserAction, 'run_actions' | 'get_capabilities'>;

export interface ActionStep {
  action: RunActionName;
  data?: Record<string, unknown>;
}

export interface RunActionsParams {
  actions: ActionStep[];
  tabId: number;
}

export interface BrowserActionMap {
  get_capabilities: { request: GetCapabilitiesParams; response: BrowserCapabilityCatalog };
  tab_checkpoint: { request: CaptureCheckpointParams; response: CaptureCheckpointResult };
  /** Compatibility alias for tab_checkpoint. */
  capture_checkpoint: { request: CaptureCheckpointParams; response: CaptureCheckpointResult };
  get_requests: { request: GetRequestsParams; response: unknown };
  get_logs: { request: GetLogsParams; response: unknown };
  get_events: { request: GetEventsParams; response: unknown };
  set_mock: { request: SetMockParams; response: unknown };
  get_mocks: { request: GetMocksParams; response: unknown };
  set_rule: { request: SetRuleParams; response: unknown };
  get_rules: { request: undefined; response: RulesResult };
  send_request: { request: SendRequestParams; response: unknown };
  browser_list: { request: BrowserListParams | undefined; response: BrowserListResult };
  browser_select_browser: { request: SelectBrowserParams; response: SelectBrowserResult };
  browser_manage: {
    request: BrowserManageParams;
    response:
      ManagedBrowserInfo | BrowserReleaseResult | { closed: boolean } | { detached: boolean };
  };
  session_list: {
    request: undefined;
    response: { sessions: ControlSessionInfo[]; warnings?: string[] };
  };
  session_manage: {
    request: SessionManageParams;
    response:
      | { session: ControlSessionInfo }
      | (Omit<ExternalBrowserControlResult, 'operation'> & {
          operation: 'handoff' | 'resume' | 'end';
        });
  };
  page_download: { request: PageDownloadParams; response: PageDownloadResult };
  page_record: { request: PageRecordParams; response: PageRecordResult };
  page_screenshot: { request: PageScreenshotParams; response: unknown };
  tab_open: { request: TabOpenParams; response: unknown };
  tab_close: { request: TabCloseParams; response: unknown };
  tab_list: { request: undefined; response: unknown };
  tab_group: { request: TabGroupParams; response: unknown };
  page_click: { request: PageClickParams; response: unknown };
  page_drag: { request: PageDragParams; response: unknown };
  page_type: { request: PageTypeParams; response: unknown };
  page_scroll: { request: PageScrollParams; response: unknown };
  page_hover: { request: PageHoverParams; response: unknown };
  page_eval: { request: PageEvalParams; response: unknown };
  page_call_tool: { request: PageCallToolParams; response: { result: unknown } };
  page_runtime: { request: Record<string, unknown>; response: unknown };
  page_inspect: { request: PageInspectParams; response: unknown };
  page_snapshot: { request: PageSnapshotParams; response: unknown };
  page_press: { request: PagePressParams; response: unknown };
  page_wait: { request: PageWaitParams; response: unknown };
  page_navigate: { request: PageNavigateParams; response: unknown };
  page_upload: { request: PageUploadParams; response: unknown };
  page_frames: { request: PageFramesParams; response: unknown };
  set_device_emulation: { request: SetDeviceEmulationParams; response: unknown };
  set_app_profile: { request: SetAppProfileParams; response: unknown };
  set_timezone: { request: SetTimezoneParams; response: SetTimezoneResult };
  get_cookie: { request: GetCookieParams; response: GetCookieResult };
  set_cookie: { request: SetCookieParams; response: SetCookieResult };
  request_permission: { request: RequestPermissionParams; response: unknown };
  run_actions: { request: RunActionsParams; response: unknown };
}

export type BrowserAction = keyof BrowserActionMap;
export type BrowserActionRequest<A extends BrowserAction> = BrowserActionMap[A]['request'];
export type BrowserActionResponse<A extends BrowserAction> = BrowserActionMap[A]['response'] & {
  /** Routing and execution state; session_manage returns the full tab inventory. */
  session?: Omit<ControlSessionInfo, 'tabs'>;
};
export type BrowserCommandAction = Exclude<BrowserAction, 'browser_select_browser'>;
export type ExtensionBrowserAction = Exclude<
  BrowserCommandAction,
  | 'browser_list'
  | 'browser_manage'
  | 'session_list'
  | 'session_manage'
  | 'page_download'
  | 'page_record'
>;

export const TAB_ID_REQUIRED_ACTIONS = [
  'tab_checkpoint',
  'capture_checkpoint',
  'get_requests',
  'get_logs',
  'get_events',
  'set_mock',
  'get_mocks',
  'page_screenshot',
  'tab_close',
  'page_click',
  'page_drag',
  'page_type',
  'page_scroll',
  'page_hover',
  'page_eval',
  'page_call_tool',
  'page_inspect',
  'page_snapshot',
  'page_press',
  'page_wait',
  'page_navigate',
  'page_upload',
  'page_download',
  'page_frames',
  'set_device_emulation',
  'set_app_profile',
  'set_timezone',
  'run_actions',
] as const satisfies readonly BrowserAction[];

export type TabIdRequiredAction = (typeof TAB_ID_REQUIRED_ACTIONS)[number];

const TAB_ID_REQUIRED_ACTION_SET: ReadonlySet<string> = new Set(TAB_ID_REQUIRED_ACTIONS);

export function actionRequiresTabId(action: unknown): action is TabIdRequiredAction {
  return typeof action === 'string' && TAB_ID_REQUIRED_ACTION_SET.has(action);
}

export function validateRequiredActionTabId(action: string, data: unknown): void {
  if (
    action === 'get_capabilities' &&
    data &&
    typeof data === 'object' &&
    ['tabId', 'tabIds', 'openerTabId'].some(key => Object.hasOwn(data, key))
  ) {
    throw new Error('get_capabilities does not accept page targets');
  }
  const cookieAction = action === 'get_cookie' || action === 'set_cookie';
  if (!actionRequiresTabId(action) && !cookieAction) return;
  const input =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as { tabId?: unknown; url?: unknown; reload?: unknown })
      : undefined;
  const tabId = input?.tabId;
  if (cookieAction && tabId === undefined) {
    if (action === 'set_cookie' && input?.reload === true) {
      throw new Error('set_cookie: reload requires tabId');
    }
    if (typeof input?.url !== 'string' || !input.url.trim()) {
      throw new Error(`${action}: specify url or tabId`);
    }
    return;
  }
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) {
    throw new Error(
      `${action} requires a numeric tabId. Call tab_open or tab_list to obtain a tabId.`,
    );
  }
}

export const PAGE_ACT_ACTIONS = [
  'page_click',
  'page_drag',
  'page_type',
  'page_hover',
  'page_scroll',
  'page_press',
  'page_upload',
  'page_eval',
] as const satisfies readonly BrowserAction[];

export type PageActAction = (typeof PAGE_ACT_ACTIONS)[number];

export const BROWSER_ACTIONS = {
  tab_checkpoint: true,
  capture_checkpoint: true,
  get_requests: true,
  get_logs: true,
  get_events: true,
  set_mock: true,
  get_mocks: true,
  set_rule: true,
  get_rules: true,
  get_capabilities: true,
  send_request: true,
  browser_list: true,
  browser_select_browser: true,
  browser_manage: true,
  session_list: true,
  session_manage: true,
  page_download: true,
  page_record: true,
  page_screenshot: true,
  tab_open: true,
  tab_close: true,
  tab_list: true,
  tab_group: true,
  page_click: true,
  page_drag: true,
  page_type: true,
  page_scroll: true,
  page_hover: true,
  page_eval: true,
  page_call_tool: true,
  page_runtime: true,
  page_inspect: true,
  page_snapshot: true,
  page_press: true,
  page_wait: true,
  page_navigate: true,
  page_upload: true,
  page_frames: true,
  set_device_emulation: true,
  set_app_profile: true,
  set_timezone: true,
  get_cookie: true,
  set_cookie: true,
  request_permission: true,
  run_actions: true,
} as const satisfies Record<BrowserAction, true>;

export const BROWSER_COMMAND_ACTIONS = {
  tab_checkpoint: true,
  capture_checkpoint: true,
  get_requests: true,
  get_logs: true,
  get_events: true,
  set_mock: true,
  get_mocks: true,
  set_rule: true,
  get_rules: true,
  get_capabilities: true,
  send_request: true,
  browser_list: true,
  browser_manage: true,
  session_list: true,
  session_manage: true,
  page_download: true,
  page_record: true,
  page_screenshot: true,
  tab_open: true,
  tab_close: true,
  tab_list: true,
  tab_group: true,
  page_click: true,
  page_drag: true,
  page_type: true,
  page_scroll: true,
  page_hover: true,
  page_eval: true,
  page_call_tool: true,
  page_runtime: true,
  page_inspect: true,
  page_snapshot: true,
  page_press: true,
  page_wait: true,
  page_navigate: true,
  page_upload: true,
  page_frames: true,
  set_device_emulation: true,
  set_app_profile: true,
  set_timezone: true,
  get_cookie: true,
  set_cookie: true,
  request_permission: true,
  run_actions: true,
} as const satisfies Record<BrowserCommandAction, true>;

export const EXTENSION_BROWSER_ACTIONS = {
  tab_checkpoint: true,
  capture_checkpoint: true,
  get_requests: true,
  get_logs: true,
  get_events: true,
  set_mock: true,
  get_mocks: true,
  set_rule: true,
  get_rules: true,
  get_capabilities: true,
  send_request: true,
  page_screenshot: true,
  tab_open: true,
  tab_close: true,
  tab_list: true,
  tab_group: true,
  page_click: true,
  page_drag: true,
  page_type: true,
  page_scroll: true,
  page_hover: true,
  page_eval: true,
  page_call_tool: true,
  page_runtime: true,
  page_inspect: true,
  page_snapshot: true,
  page_press: true,
  page_wait: true,
  page_navigate: true,
  page_upload: true,
  page_frames: true,
  set_device_emulation: true,
  set_app_profile: true,
  set_timezone: true,
  get_cookie: true,
  set_cookie: true,
  request_permission: true,
  run_actions: true,
} as const satisfies Record<ExtensionBrowserAction, true>;

export const BROWSER_CAPABILITY_ACTIONS = {
  ...EXTENSION_BROWSER_ACTIONS,
  page_download: true,
  // Provider wire operation for releasing control while preserving its instance.
  browser_release: true,
} as const satisfies Record<BrowserCapabilityAction, true>;

export function isBrowserAction(value: unknown): value is BrowserAction {
  return typeof value === 'string' && Object.hasOwn(BROWSER_ACTIONS, value);
}

export function isBrowserCommandAction(value: unknown): value is BrowserCommandAction {
  return typeof value === 'string' && Object.hasOwn(BROWSER_COMMAND_ACTIONS, value);
}

export function isBrowserCapabilityAction(value: unknown): value is BrowserCapabilityAction {
  return typeof value === 'string' && Object.hasOwn(BROWSER_CAPABILITY_ACTIONS, value);
}

export function isExtensionBrowserAction(value: unknown): value is ExtensionBrowserAction {
  return typeof value === 'string' && Object.hasOwn(EXTENSION_BROWSER_ACTIONS, value);
}
