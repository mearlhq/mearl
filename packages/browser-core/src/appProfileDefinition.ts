import type { BrowserDevicePresetName, AppBridgeConfig } from './browserActionProtocol.js';
import type {
  AppBridgeSpec,
  AppImagePickerConfig,
  AppLayerUrlProxyConfig,
  AppMiniProgramConfig,
  AppNativeBackConfig,
  AppOverlayConfig,
  AppSchemeRule,
  AppTitleBarHostStyle,
  BridgeActionMap,
} from './app-profile-runtime/types.js';

export interface AppProfilePolicies {
  titleBar?: string;
  navigatorLanguage?: boolean;
  networkResult?: string;
  languages?: string[];
  defaultLanguage?: string;
}

export interface AppProfileSetting {
  id: string;
  label: string;
  type: 'select' | 'boolean' | 'number' | 'text' | 'json';
  target: { option: 'language' } | { method: string; field?: string };
  choices?: Array<{ label: string; value: string }>;
  minimum?: number;
  maximum?: number;
}

export interface AppProfileOptions {
  /** Keep this definition across document navigations until explicitly refreshed. */
  lockDefinition?: boolean;
  os?: 'ios' | 'android';
  appVersion?: string;
  language?: string;
  deviceModel?: string;
  devicePreset?: BrowserDevicePresetName;
  orientation?: 'portrait' | 'landscape';
  bridgeConfig?: AppBridgeConfig;
}

export interface AppProfileBinding {
  version: 1;
  revision: string;
  definition: AppProfileDefinition;
  options: AppProfileOptions;
  /** Explicit scalar choices; method overrides are always explicit and live in options.bridgeConfig. */
  explicitOptions?: Omit<AppProfileOptions, 'bridgeConfig'>;
}

export interface AppProfileContribution {
  version: 1;
  profiles: AppProfileDefinition[];
}

export interface AppProfileCatalogEntry {
  id: string;
  label: string;
  source: 'builtin' | 'plugin';
  available?: boolean;
  plugin?: string;
  revision: string;
  definition: AppProfileDefinition;
}

/** Short, author-supplied guidance; discovery does not load Skills or follow links. */
export interface AppProfileUsage {
  description?: string;
  limitations?: string[];
  skills?: string[];
  documentation?: Array<{ title: string; url: string }>;
}

/** 单个 App 容器的声明式端模拟配置。 */
export interface AppProfileDefinition {
  name: string;
  /** Preferred App ID when the capability is installed outside a Preset. */
  defaultAppId?: string;
  usage?: AppProfileUsage;
  /** Content-addressed installer supplied by the selected browser capability package. */
  pageRuntime?: { id: string; sha256: string };
  label: string;
  actionIcon?: string;
  labels?: { en: string; zh_CN?: string };
  /** 容器的应用标识，由能力包定义 */
  appName: string;
  defaultAppVersion: string;
  /** UA 主体格式；未提供时使用标准浏览器 UA */
  uaFamily?: string;
  uaTemplate?: { ios: string; android: string };
  policies?: AppProfilePolicies;
  settings?: AppProfileSetting[];
  authorization?: { hook: string; method: string };
  settingsUi?: 'runtime';
  settingsGroup?: string;
  /** UA 主体之后追加的 token，{v} 占位会被替换为 appVersion */
  uaTokens: string[];
  /** 额外注入到 window 的变量（公共变量由 resolve 统一生成） */
  globals: Record<string, string>;
  bridges: AppBridgeSpec[];
  /** 页面回到前台时分发到 document 的事件名（如 WV.Event.APP.Active） */
  activeEvents: string[];
  actions: BridgeActionMap;
  schemes: AppSchemeRule[];
  /** 小程序原生页面与 WebView 通信规则。 */
  miniProgram?: AppMiniProgramConfig;
  /** 原生图片页 scheme 的浏览器选图与上传配置 */
  imagePicker?: AppImagePickerConfig;
  /**
   * 地址栏借位同步的可选 host 白名单：容器栈顶 URL 的 host 命中时，地址栏借 top
   * 域名同步其 path+query+hash（pushState 同源约束下保持域名不变只改 path）；
   * 不配置则同步所有 HTTP(S) 业务层 URL。
   */
  urlSyncHostSuffixes?: string[];
  /** URL / pageParams 浮层协议 */
  overlay?: AppOverlayConfig;
  /** URL 参数为真时以新 WebView 替换当前业务层。 */
  popBeforeOpenParam?: string;
  /** 跨 WebView 消息抵达 opener 时分发的 document 事件。 */
  messageEvent?: string;
  /** 原生返回键的页面接管协议。 */
  nativeBack?: AppNativeBackConfig;
  /** 开发代理 origin 下的业务层 URL 映射 */
  layerUrlProxy?: AppLayerUrlProxyConfig;
  /** App 框架的根 WebView 与自绘标题栏协议。 */
  rootContainer?: {
    statusBarHeightCookie?: { name: string; domain?: string; path?: string };
  };
  /** 页面自行绘制导航区域时，不渲染模拟标题栏。 */
  titleBarHiddenPathnames?: string[];
  /** 页面级状态栏背景色，key 为业务 pathname。 */
  statusBarBackgroundColors?: Record<string, string>;
  /** 按业务根域配置标题栏与状态栏样式。 */
  titleBarHostStyles?: AppTitleBarHostStyle[];
  /** Opaque configuration owned by the installed page runtime. */
  runtimeOptions?: Record<string, unknown>;
}

/** Behavior IDs belong to the installed page runtime, never to a host-side enum. */
export function isAppBridgeBehavior(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(path: string): never {
  throw new Error(`Invalid app profile: ${path}`);
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    Array.from(value).every(character => character.charCodeAt(0) > 8)
  );
}
function strings(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 200 && value.every(text);
}
function fields(
  value: unknown,
  required: string[],
  optional: string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
  )
    invalid(path);
}
function stringMap(value: unknown): boolean {
  return record(value) && Object.keys(value).length <= 200 && Object.values(value).every(text);
}
function json(value: unknown, depth = 0): boolean {
  if (depth > 25) return false;
  if (value === null || typeof value === 'boolean' || text(value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 1000 && value.every(item => json(item, depth + 1));
  return (
    record(value) &&
    Object.entries(value).every(
      ([key, item]) =>
        !['__proto__', 'prototype', 'constructor'].includes(key) && json(item, depth + 1),
    )
  );
}
function validateActions(value: unknown): void {
  const arrays = [
    'open',
    'close',
    'title',
    'navigationBar',
    'statusBar',
    'systemInfo',
    'protocol',
    'kvGet',
    'kvSet',
    'kvDelete',
    'pageContext',
    'noop',
    'silent',
  ];
  fields(
    value,
    ['open', 'close', 'title', 'systemInfo', 'protocol', 'noop'],
    [...arrays, 'responses', 'behaviors'],
    'actions',
  );
  for (const key of arrays)
    if (value[key] !== undefined && !strings(value[key])) invalid(`actions.${key}`);
  if (value.responses !== undefined && !record(value.responses)) invalid('actions.responses');
  if (
    value.behaviors !== undefined &&
    (!stringMap(value.behaviors) ||
      !Object.values(value.behaviors as Record<string, unknown>).every(item =>
        isAppBridgeBehavior(item),
      ))
  )
    invalid('actions.behaviors');
}

/** Validate plain data before registration or compiling a document-start configuration. */
export function validateAppProfileDefinition(value: unknown): AppProfileDefinition {
  if (!json(value)) invalid('JSON');
  if (JSON.stringify(value).length > 65_536) invalid('definition exceeds 64 KiB');
  const required = [
    'name',
    'label',
    'appName',
    'defaultAppVersion',
    'uaTokens',
    'globals',
    'bridges',
    'activeEvents',
    'actions',
    'schemes',
  ];
  const optional = [
    'defaultAppId',
    'usage',
    'actionIcon',
    'labels',
    'pageRuntime',
    'uaFamily',
    'uaTemplate',
    'policies',
    'settings',
    'settingsGroup',
    'settingsUi',
    'authorization',
    'miniProgram',
    'imagePicker',
    'urlSyncHostSuffixes',
    'overlay',
    'popBeforeOpenParam',
    'messageEvent',
    'nativeBack',
    'layerUrlProxy',
    'rootContainer',
    'titleBarHiddenPathnames',
    'statusBarBackgroundColors',
    'titleBarHostStyles',
    'runtimeOptions',
  ];
  fields(value, required, optional, 'definition');
  for (const key of ['name', 'label', 'appName', 'defaultAppVersion'])
    if (!text(value[key]) || !value[key]) invalid(key);
  if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(value.name as string)) invalid('name');
  if (value.defaultAppId !== undefined &&
      (typeof value.defaultAppId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(value.defaultAppId) ||
        ['constructor', 'prototype'].includes(value.defaultAppId))) invalid('defaultAppId');
  if (value.usage !== undefined) {
    const usage = value.usage;
    fields(usage, [], ['description', 'limitations', 'skills', 'documentation'], 'usage');
    if (new TextEncoder().encode(JSON.stringify(usage)).byteLength > 4096) invalid('usage exceeds 4 KiB');
    if (usage.description !== undefined && (!text(usage.description) || usage.description.length > 512)) invalid('usage.description');
    for (const key of ['limitations', 'skills'] as const) {
      const items = usage[key];
      if (items !== undefined && (!Array.isArray(items) || items.length > 8 || items.some(item => !text(item) || !item || item.length > 256))) invalid(`usage.${key}`);
    }
    if (usage.documentation !== undefined) {
      if (!Array.isArray(usage.documentation) || usage.documentation.length > 8) invalid('usage.documentation');
      for (const link of usage.documentation) {
        fields(link, ['title', 'url'], [], 'usage.documentation');
        if (!text(link.title) || !link.title || link.title.length > 128 || !text(link.url) || link.url.length > 1024) invalid('usage.documentation');
        let url: URL;
        try { url = new URL(link.url); } catch { invalid('usage.documentation.url'); }
        if (url.protocol !== 'https:' || url.username || url.password) invalid('usage.documentation.url');
      }
    }
  }
  if (value.pageRuntime !== undefined) {
    fields(value.pageRuntime, ['id', 'sha256'], [], 'pageRuntime');
    const runtime = value.pageRuntime as Record<string, unknown>;
    if (
      typeof runtime.id !== 'string' ||
      !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(runtime.id) ||
      typeof runtime.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(runtime.sha256)
    )
      invalid('pageRuntime');
  }
  for (const key of [
    'uaTokens',
    'activeEvents',
    'urlSyncHostSuffixes',
    'titleBarHiddenPathnames',
  ]) {
    if (value[key] !== undefined && !strings(value[key])) invalid(key);
  }
  if (!stringMap(value.globals)) invalid('globals');
  if (!Array.isArray(value.bridges) || value.bridges.length > 20) invalid('bridges');
  const globals = new Set<string>();
  for (const bridge of value.bridges) {
    fields(bridge, ['global', 'style'], ['persistent'], 'bridges');
    if (
      !text(bridge.global) ||
      !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(bridge.global) ||
      bridge.global
        .split('.')
        .some(part => ['__proto__', 'prototype', 'constructor'].includes(part)) ||
      globals.has(bridge.global) ||
      (typeof bridge.style !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(bridge.style)) ||
      (bridge.persistent !== undefined && typeof bridge.persistent !== 'boolean')
    )
      invalid('bridge');
    globals.add(bridge.global);
  }
  validateActions(value.actions);
  if (value.labels !== undefined) {
    fields(value.labels, ['en'], ['zh_CN'], 'labels');
    if (!text(value.labels.en) || !value.labels.en || value.labels.en.length > 120 || value.labels.zh_CN !== undefined && (!text(value.labels.zh_CN) || value.labels.zh_CN.length > 120)) invalid('labels');
  }
  if (value.actionIcon !== undefined && (typeof value.actionIcon !== 'string' || value.actionIcon.length > 32768 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value.actionIcon))) invalid('actionIcon');
  if (value.authorization !== undefined && (!record(value.authorization) || Object.keys(value.authorization).sort().join(',') !== 'hook,method' || typeof value.authorization.hook !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,95}$/.test(value.authorization.hook) || typeof value.authorization.method !== 'string' || !value.authorization.method || value.authorization.method.length > 200)) invalid('authorization');
  if (value.settingsUi !== undefined && value.settingsUi !== 'runtime') throw new Error('Invalid App settings UI');
  if (
    value.settingsGroup !== undefined &&
    (typeof value.settingsGroup !== 'string' || value.settingsGroup.length > 64)
  )
    invalid('settingsGroup');
  if (
    value.uaFamily !== undefined &&
    (typeof value.uaFamily !== 'string' || value.uaFamily.length > 64)
  )
    invalid('uaFamily');
  if (value.uaTemplate !== undefined) {
    fields(value.uaTemplate, ['ios', 'android'], [], 'uaTemplate');
    if (!text(value.uaTemplate.ios) || !text(value.uaTemplate.android)) invalid('uaTemplate');
  }
  if (value.policies !== undefined) {
    fields(
      value.policies,
      [],
      ['titleBar', 'navigatorLanguage', 'networkResult', 'languages', 'defaultLanguage'],
      'policies',
    );
    const p = value.policies;
    if (
      p.titleBar !== undefined &&
      (typeof p.titleBar !== 'string' || p.titleBar.length > 64)
    )
      invalid('policies.titleBar');
    if (p.networkResult !== undefined && (typeof p.networkResult !== 'string' || p.networkResult.length > 64))
      invalid('policies.networkResult');
    if (p.navigatorLanguage !== undefined && typeof p.navigatorLanguage !== 'boolean')
      invalid('policies.navigatorLanguage');
    if (p.languages !== undefined && (!strings(p.languages) || !(p.languages as string[]).length))
      invalid('policies.languages');
    if (
      p.defaultLanguage !== undefined &&
      (!text(p.defaultLanguage) ||
        (p.languages && !(p.languages as string[]).includes(p.defaultLanguage)))
    )
      invalid('policies.defaultLanguage');
  }
  if (!Array.isArray(value.schemes) || value.schemes.length > 100) invalid('schemes');
  for (const rule of value.schemes) {
    fields(
      rule,
      ['match'],
      [
        'hostSuffixes',
        'param',
        'useCurrentOrigin',
        'targetPath',
        'targetHostPrefix',
        'targetParams',
      ],
      'scheme',
    );
    for (const key of ['match', 'param', 'targetPath', 'targetHostPrefix'])
      if (rule[key] !== undefined && !text(rule[key])) invalid(`scheme.${key}`);
    if (rule.hostSuffixes !== undefined && !strings(rule.hostSuffixes))
      invalid('scheme.hostSuffixes');
    if (rule.useCurrentOrigin !== undefined && typeof rule.useCurrentOrigin !== 'boolean')
      invalid('scheme.useCurrentOrigin');
    if (rule.targetParams !== undefined && !stringMap(rule.targetParams))
      invalid('scheme.targetParams');
  }
  if (value.settings !== undefined) {
    if (!Array.isArray(value.settings) || value.settings.length > 30) invalid('settings');
    const ids = new Set<string>();
    for (const setting of value.settings) {
      fields(
        setting,
        ['id', 'label', 'type', 'target'],
        ['choices', 'minimum', 'maximum'],
        'setting',
      );
      if (
        !text(setting.id) ||
        !/^[a-z][a-zA-Z0-9-]*$/.test(setting.id) ||
        ids.has(setting.id) ||
        !text(setting.label) ||
        !['select', 'boolean', 'number', 'text', 'json'].includes(setting.type as string)
      )
        invalid('setting');
      ids.add(setting.id);
      if (record(setting.target) && setting.target.option !== undefined) {
        fields(setting.target, ['option'], [], 'setting.target');
        if (setting.target.option !== 'language') invalid('setting.target.option');
      } else {
        fields(setting.target, ['method'], ['field'], 'setting.target');
        if (
          !text(setting.target.method) ||
          !setting.target.method ||
          ['__proto__', 'prototype', 'constructor'].includes(setting.target.method) ||
          (setting.target.field !== undefined &&
            (!text(setting.target.field) ||
              ['__proto__', 'prototype', 'constructor'].includes(setting.target.field)))
        )
          invalid('setting.target.method');
        const method = setting.target.method;
        if (
          [
            'open',
            'close',
            'title',
            'navigationBar',
            'statusBar',
            'systemInfo',
            'protocol',
            'kvGet',
            'kvSet',
            'kvDelete',
            'pageContext',
          ].some(key =>
            ((value.actions as Record<string, unknown>)[key] as string[] | undefined)?.includes(
              method,
            ),
          )
        )
          invalid('setting targets a structural method');
      }
      if (
        setting.choices !== undefined &&
        (!Array.isArray(setting.choices) ||
          !setting.choices.length ||
          setting.choices.some(
            choice => !record(choice) || !text(choice.label) || !text(choice.value),
          ))
      )
        invalid('setting.choices');
      for (const key of ['minimum', 'maximum'])
        if (setting[key] !== undefined && typeof setting[key] !== 'number')
          invalid(`setting.${key}`);
      if (setting.type === 'select' && !Array.isArray(setting.choices))
        invalid('setting.choices required');
      if (
        setting.minimum !== undefined &&
        setting.maximum !== undefined &&
        (setting.minimum as number) > (setting.maximum as number)
      )
        invalid('setting range');
      if ('option' in setting.target && !['select', 'text'].includes(setting.type as string))
        invalid('setting.option type');
    }
  }
  if (value.runtimeOptions !== undefined && (!record(value.runtimeOptions) || !json(value.runtimeOptions))) invalid('runtimeOptions');
  for (const key of ['popBeforeOpenParam', 'messageEvent'])
    if (value[key] !== undefined && !text(value[key])) invalid(key);
  if (value.statusBarBackgroundColors !== undefined && !stringMap(value.statusBarBackgroundColors))
    invalid('statusBarBackgroundColors');
  validateStructuredOptions(value);
  return JSON.parse(JSON.stringify(value)) as AppProfileDefinition;
}

function validateStructuredOptions(value: Record<string, unknown>): void {
  const shapes: Record<string, [string[], string[]]> = {
    nativeBack: [[], ['event', 'controlFunction', 'handler']],
    layerUrlProxy: [
      ['sourceHostPrefix', 'pathPrefix', 'targetHostSuffixes'],
      ['defaultTargetHost'],
    ],
    imagePicker: [
      ['schemes', 'api', 'version', 'fcId', 'fcGroup', 'uploadUrlFunction', 'prefix', 'region'],
      [],
    ],
    overlay: [
      [
        'enabledParam',
        'topRatioParam',
        'radiusParam',
        'maskAlphaParam',
        'tapCloseParam',
        'defaultTopRatio',
        'defaultRadius',
        'defaultMaskAlpha',
        'defaultTapClose',
      ],
      [
        'heightRatioParam',
        'tapCloseSelectors',
        'silentTapClose',
        'maxWidthPx',
        'maxWidthMinAppVersion',
      ],
    ],
  };
  for (const [key, [required, optional]] of Object.entries(shapes)) {
    if (value[key] === undefined) continue;
    fields(value[key], required, optional, key);
    for (const [field, item] of Object.entries(value[key])) {
      const valid =
        field === 'maxWidthPx'
          ? typeof item === 'number' && Number.isFinite(item) && item > 0
          : field === 'maxWidthMinAppVersion'
            ? typeof item === 'string' && /^\d+(?:\.\d+)*$/.test(item)
            : field.startsWith('default') && field !== 'defaultTargetHost'
              ? field === 'defaultTapClose'
                ? typeof item === 'boolean'
                : typeof item === 'number'
              : field === 'silentTapClose'
                ? typeof item === 'boolean'
                : ['schemes', 'targetHostSuffixes', 'tapCloseSelectors'].includes(field)
                  ? strings(item)
                  : text(item);
      if (!valid) invalid(`${key}.${field}`);
    }
  }
  if (value.rootContainer !== undefined) {
    fields(value.rootContainer, [], ['statusBarHeightCookie'], 'rootContainer');
    if (value.rootContainer.statusBarHeightCookie !== undefined) {
      fields(
        value.rootContainer.statusBarHeightCookie,
        ['name'],
        ['domain', 'path'],
        'rootContainer.statusBarHeightCookie',
      );
      if (!Object.values(value.rootContainer.statusBarHeightCookie).every(text))
        invalid('rootContainer.statusBarHeightCookie');
    }
  }
  if (
    value.titleBarHostStyles !== undefined &&
    (!Array.isArray(value.titleBarHostStyles) ||
      value.titleBarHostStyles.some(rule => {
        fields(
          rule,
          ['hostSuffix'],
          ['titleBarBackgroundColor', 'statusBarBackgroundColor'],
          'titleBarHostStyle',
        );
        return !Object.values(rule).every(text);
      }))
  )
    invalid('titleBarHostStyles');
  if (value.miniProgram !== undefined) {
    fields(value.miniProgram, [], ['paymentRoutes', 'nativeRoutes', 'messageRules'], 'miniProgram');
    const shapes: Record<string, [string[], string[]]> = {
      paymentRoutes: [
        ['pathname', 'paymentParamsParam', 'successUrlParams', 'failureUrlParams'],
        ['hostSuffixes', 'successResultParam', 'forwardParams', 'useCurrentOrigin'],
      ],
      nativeRoutes: [['pathname', 'actions'], ['hostSuffixes']],
      messageRules: [['type', 'action'], ['hostSuffixes']],
    };
    for (const [key, list] of Object.entries(value.miniProgram)) {
      if (!Array.isArray(list) || list.length > 100) invalid(`miniProgram.${key}`);
      for (const rule of list) {
        fields(rule, ...shapes[key], `miniProgram.${key}`);
        for (const [field, item] of Object.entries(rule)) {
          if (
            [
              'hostSuffixes',
              'successUrlParams',
              'failureUrlParams',
              'forwardParams',
              'actions',
            ].includes(field)
              ? !strings(item)
              : field === 'useCurrentOrigin'
                ? typeof item !== 'boolean'
                : !text(item)
          )
            invalid(`miniProgram.${key}.${field}`);
        }
        if (
          key === 'messageRules' &&
          !['stageBackData', 'closeAll'].includes(rule.action as string)
        )
          invalid('miniProgram.messageRules.action');
        if (
          key === 'nativeRoutes' &&
          !(rule.actions as string[]).every(action =>
            ['navigateMiniProgram', 'subscribeMessage'].includes(action),
          )
        )
          invalid('miniProgram.nativeRoutes.actions');
      }
    }
  }
}

export function validateAppProfileContribution(value: unknown): AppProfileContribution | undefined {
  if (value === undefined) return undefined;
  fields(value, ['version', 'profiles'], [], 'contribution');
  if (
    value.version !== 1 ||
    !Array.isArray(value.profiles) ||
    !value.profiles.length ||
    value.profiles.length > 20
  )
    invalid('contribution');
  const profiles = value.profiles.map(validateAppProfileDefinition);
  if (JSON.stringify(profiles).length > 256_000) invalid('contribution exceeds 256 KiB');
  if (profiles.some(profile => profile.name.includes('/')))
    invalid('contribution names must be local identifiers');
  if (new Set(profiles.map(profile => profile.name)).size !== profiles.length)
    invalid('duplicate profile name');
  return { version: 1, profiles };
}

/** Deterministic identity for immutable definitions; this identifier grants no host permissions. */
export function appProfileRevision(definition: AppProfileDefinition): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (record(value))
      return `{${Object.keys(value)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(',')}}`;
    return JSON.stringify(value);
  };
  const source = canonical(definition);
  let left = 2166136261;
  let right = 5381;
  for (let i = 0; i < source.length; i++) {
    left = Math.imul(left ^ source.charCodeAt(i), 16777619);
    right = Math.imul(right, 33) ^ source.charCodeAt(i);
  }
  return `v1-${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}
