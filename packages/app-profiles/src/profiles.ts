import {
  DEVICE_PRESETS,
  isAppBridgeBehavior,
  appProfileRevision,
  validateAppProfileDefinition,
  type AppProfileCatalogEntry,
  type AppProfileDefinition,
  type AppProfileOptions,
  type BuiltinAppProfileName,
  resolveEmulationConfig,
  type AppBridgeBehavior,
  type AppBridgeConfig,
  type AppProfileName,
  type BridgeActionMap,
  type BrowserDevicePresetName,
  type InjectedAppProfileConfig,
} from '@mearl/browser-core';

export type { AppProfileName };

export type AppProfileOs = 'ios' | 'android';
export type AppProfile = AppProfileDefinition;

function emptyActions(): BridgeActionMap {
  return {
    open: [],
    close: [],
    title: [],
    navigationBar: [],
    statusBar: [],
    systemInfo: [],
    protocol: [],
    kvGet: [],
    kvSet: [],
    kvDelete: [],
    pageContext: [],
    responses: {},
    behaviors: {},
    noop: [],
    silent: [],
  };
}

function mergeActions(...maps: BridgeActionMap[]): BridgeActionMap {
  const out = emptyActions();
  for (const m of maps) {
    out.open.push(...m.open);
    out.close.push(...m.close);
    out.title.push(...m.title);
    out.navigationBar!.push(...(m.navigationBar ?? []));
    out.statusBar!.push(...(m.statusBar ?? []));
    out.systemInfo.push(...m.systemInfo);
    out.protocol.push(...m.protocol);
    out.kvGet!.push(...(m.kvGet ?? []));
    out.kvSet!.push(...(m.kvSet ?? []));
    out.kvDelete!.push(...(m.kvDelete ?? []));
    out.pageContext!.push(...(m.pageContext ?? []));
    Object.assign(out.responses!, m.responses ?? {});
    Object.assign(out.behaviors!, m.behaviors ?? {});
    out.noop.push(...m.noop);
    out.silent!.push(...(m.silent ?? []));
  }
  return out;
}

const BRIDGE_ACTION_ARRAY_KEYS = [
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
] as const;

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.values(value as Record<string, unknown>).every(item => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

/** 校验并复制用户提供的声明式桥配置。 */
export function validateAppBridgeConfig(value: unknown): AppBridgeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('bridgeConfig must be an object');
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some(key => key !== 'methods')) {
    throw new Error('bridgeConfig only supports the "methods" field');
  }
  if (!root.methods || typeof root.methods !== 'object' || Array.isArray(root.methods)) {
    throw new Error('bridgeConfig.methods must be an object');
  }
  const entries = Object.entries(root.methods as Record<string, unknown>);
  if (entries.length > 200) throw new Error('bridgeConfig supports at most 200 methods');

  const methods: AppBridgeConfig['methods'] = {};
  for (const [method, rawConfig] of entries) {
    if (!method.trim() || method.length > 200) {
      throw new Error('bridgeConfig method names must contain 1-200 characters');
    }
    if (method === '__proto__' || method === 'prototype' || method === 'constructor') {
      throw new Error(`bridgeConfig method name "${method}" is reserved`);
    }
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new Error(`bridgeConfig.methods.${method} must be an object`);
    }
    const methodConfig = rawConfig as Record<string, unknown>;
    const supportedKeys = new Set(['behavior', 'response', 'noop', 'silent']);
    if (Object.keys(methodConfig).some(key => !supportedKeys.has(key))) {
      throw new Error(`bridgeConfig.methods.${method} contains an unsupported field`);
    }
    if ('behavior' in methodConfig && typeof methodConfig.behavior !== 'string') {
      throw new Error(`bridgeConfig.methods.${method}.behavior must be a string`);
    }
    const hasBehavior = typeof methodConfig.behavior === 'string';
    const hasResponse = Object.prototype.hasOwnProperty.call(methodConfig, 'response');
    const hasNoop = methodConfig.noop === true;
    if (Number(hasBehavior) + Number(hasResponse) + Number(hasNoop) !== 1) {
      throw new Error(
        `bridgeConfig.methods.${method} must define exactly one of behavior, response, or noop=true`,
      );
    }
    if (hasBehavior && !isAppBridgeBehavior(methodConfig.behavior)) {
      throw new Error(`bridgeConfig.methods.${method} has an unsupported behavior`);
    }
    if (hasResponse && !isJsonValue(methodConfig.response)) {
      throw new Error(`bridgeConfig.methods.${method}.response must be valid JSON data`);
    }
    if ('noop' in methodConfig && methodConfig.noop !== true) {
      throw new Error(`bridgeConfig.methods.${method}.noop must be true when provided`);
    }
    if ('silent' in methodConfig && typeof methodConfig.silent !== 'boolean') {
      throw new Error(`bridgeConfig.methods.${method}.silent must be a boolean`);
    }
    methods[method] = {
      ...(hasBehavior && { behavior: methodConfig.behavior as AppBridgeBehavior }),
      ...(hasResponse && { response: JSON.parse(JSON.stringify(methodConfig.response)) }),
      ...(hasNoop && { noop: true }),
      ...(methodConfig.silent === true && { silent: true }),
    };
  }

  const normalized = { methods };
  if (JSON.stringify(normalized).length > 65_536) {
    throw new Error('bridgeConfig must not exceed 64 KiB');
  }
  return normalized;
}

/** 后传配置按方法覆盖前传配置，供扩展本地配置与单次 Agent 参数组合。 */
export function mergeAppBridgeConfigs(
  ...configs: Array<AppBridgeConfig | undefined>
): AppBridgeConfig | undefined {
  const present = configs.filter((config): config is AppBridgeConfig => config !== undefined);
  if (present.length === 0) return undefined;
  const methods: AppBridgeConfig['methods'] = {};
  for (const config of present) Object.assign(methods, validateAppBridgeConfig(config).methods);
  return validateAppBridgeConfig({ methods });
}

/** 将声明式方法覆盖编译进运行时动作表，不修改档案的静态数据。 */
export function applyAppBridgeConfig(
  actions: BridgeActionMap,
  config?: AppBridgeConfig,
): BridgeActionMap {
  const out = mergeActions(actions);
  if (!config) return out;
  const { methods } = validateAppBridgeConfig(config);
  for (const [method, methodConfig] of Object.entries(methods)) {
    for (const key of BRIDGE_ACTION_ARRAY_KEYS) {
      const values = out[key];
      if (values) out[key] = values.filter(value => value !== method);
    }
    out.silent = (out.silent ?? []).filter(value => value !== method);
    delete out.responses?.[method];
    delete out.behaviors?.[method];

    if (methodConfig.behavior) out.behaviors![method] = methodConfig.behavior;
    else if (Object.prototype.hasOwnProperty.call(methodConfig, 'response')) {
      out.responses![method] = methodConfig.response;
    } else if (methodConfig.noop) out.noop.push(method);
    if (methodConfig.silent) out.silent!.push(method);
  }
  return out;
}



/** Built-ins provide UA/version identity; full environments come from capability packages. */
/** Profiles are supplied by installed capabilities; the core has no App defaults. */
export const APP_PROFILES: Readonly<Partial<Record<BuiltinAppProfileName, AppProfile>>> = Object.freeze({});

export interface ResolveAppProfileOptions extends AppProfileOptions {
  os?: AppProfileOs;
  appVersion?: string;
  language?: string;
  /** App 读取到的机型名；不影响所选设备的物理外观。 */
  deviceModel?: string;
  /** App 系统栏与安全区使用的设备 preset，默认跟随 os 的推荐设备。 */
  devicePreset?: BrowserDevicePresetName;
  orientation?: 'portrait' | 'landscape';
  /** 按方法覆盖档案内置桥配置 */
  bridgeConfig?: AppBridgeConfig;
}

/** resolve 结果：UA + 注入配置 + 推荐设备模拟 preset */
export interface ResolvedAppProfile {
  profile: AppProfileName;
  label: string;
  ua: string;
  injected: InjectedAppProfileConfig;
  /** 推荐配合的视口 preset（browser-core DEVICE_PRESETS 键名） */
  recommendedPreset: BrowserDevicePresetName;
}

/** 构造容器 UA。os 默认 ios；uaTokens 中的 {v} 替换为 appVersion */
export function buildAppProfileUa(
  profile: AppProfile,
  options: ResolveAppProfileOptions = {},
): string {
  const os =
    options.os ??
    (options.devicePreset ? DEVICE_PRESETS[options.devicePreset]?.appProfileOs : undefined) ??
    'ios';
  const version = options.appVersion ?? profile.defaultAppVersion;
  const deviceModel =
    options.deviceModel ??
    (options.devicePreset ? DEVICE_PRESETS[options.devicePreset]?.appProfileModel : undefined) ??
    'Pixel 11';
  if (profile.uaTemplate) {
    return profile.uaTemplate[os]
      .replaceAll('{v}', version)
      .replaceAll('{deviceModel}', deviceModel)
      .replaceAll('{language}', options.language ?? profile.policies?.defaultLanguage ?? 'zh-Hans');
  }
  return os === 'android'
    ? `Mozilla/5.0 (Linux; Android 17; ${deviceModel}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`
    : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
}

/**
 * 解析容器档案为可下发配置。
 * @throws profile 名不存在时抛错，错误信息列出全部可用档案
 */
export function listBuiltinAppProfiles(): AppProfileCatalogEntry[] {
  return [];
}

export function resolveAppProfile(
  name: string,
  options: ResolveAppProfileOptions = {},
  pinnedDefinition?: AppProfileDefinition,
): ResolvedAppProfile {
  const definition = pinnedDefinition ?? APP_PROFILES[name as BuiltinAppProfileName];
  if (!definition || definition.name !== name) {
    throw new Error(
      `Unknown app profile "${name}". Install an App simulation capability first.`,
    );
  }
  return resolveAppProfileDefinition(definition, options);
}

export function resolveAppProfileDefinition(
  definition: AppProfileDefinition,
  options: ResolveAppProfileOptions = {},
): ResolvedAppProfile {
  const profile = validateAppProfileDefinition(definition);
  if (options.lockDefinition !== undefined && typeof options.lockDefinition !== 'boolean')
    throw new Error('lockDefinition must be a boolean');
  if (options.os !== undefined && options.os !== 'ios' && options.os !== 'android')
    throw new Error('Invalid app profile OS');
  if (
    options.orientation !== undefined &&
    options.orientation !== 'portrait' &&
    options.orientation !== 'landscape'
  )
    throw new Error('Invalid app profile orientation');
  if (options.devicePreset !== undefined && !Object.hasOwn(DEVICE_PRESETS, options.devicePreset))
    throw new Error('Invalid app profile device preset');
  for (const [key, maximum] of [
    ['appVersion', 100],
    ['deviceModel', 200],
    ['language', 100],
  ] as const) {
    const value = options[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' || !value || value.length > maximum || /[\r\n]/.test(value))
    )
      throw new Error(`Invalid app profile ${key}`);
  }

  if (
    options.language !== undefined &&
    profile.policies?.languages &&
    !profile.policies.languages.includes(options.language)
  ) {
    throw new Error(
      `Unsupported ${profile.label} language. Use ${profile.policies.languages.join(', ')}.`,
    );
  }
  const os =
    options.os ??
    (options.devicePreset ? DEVICE_PRESETS[options.devicePreset]?.appProfileOs : undefined) ??
    'ios';
  const version = options.appVersion ?? profile.defaultAppVersion;
  const recommendedPreset: BrowserDevicePresetName =
    os === 'android' ? 'pixel-11' : 'iphone-17-pro';
  const devicePreset = options.devicePreset ?? recommendedPreset;
  const emulation = resolveEmulationConfig({
    enabled: true,
    preset: devicePreset,
    orientation: options.orientation,
  });
  const deviceModel = options.deviceModel ?? DEVICE_PRESETS[devicePreset].appProfileModel;

  const globals: Record<string, string> = profile.pageRuntime || profile.bridges.length > 0 || Object.keys(profile.globals).length > 0 ? {
    ...Object.fromEntries(Object.entries(profile.globals).map(([key, value]) => [key, value.replaceAll('{deviceModel}', deviceModel).replaceAll('{v}', version)])),
    __APP_NAME__: profile.appName,
    __APP_VERSION__: version,
    __DEVICE_MODEL__: deviceModel,
  } : {};

  const ua = buildAppProfileUa(profile, { ...options, os, deviceModel });

  return {
    profile: profile.name as AppProfileName,
    label: profile.label,
    ua,
    injected: {
      ...(profile.pageRuntime && { pageRuntime: profile.pageRuntime }),
      binding: {
        version: 1,
        revision: appProfileRevision(profile),
        definition: profile,
        options: JSON.parse(
          JSON.stringify({ ...options, os, appVersion: version, deviceModel, devicePreset }),
        ),
        explicitOptions: JSON.parse(
          JSON.stringify(
            Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'bridgeConfig')),
          ),
        ),
      },
      policies: profile.policies ?? {},
      settings: profile.settings ?? [],
      settingsUi: profile.settingsUi,
      settingsGroup: profile.settingsGroup,
      profile: profile.name,
      label: profile.label,
      globals,
      bridges: profile.bridges,
      activeEvents: profile.activeEvents,
      maxTouchPoints: 5,
      statusBarHeight: emulation.safeAreaInsets.top,
      safeAreaInsets: emulation.safeAreaInsets,
      deviceAppearance: {
        preset: devicePreset,
        orientation: emulation.orientation,
        cutout: emulation.appearance.cutout,
      },
      language: options.language ?? profile.policies?.defaultLanguage ?? 'zh-Hans',
      // UA 随注入配置一起下发，供 DNR、页内运行时和动态 WebView 导航前刷新使用
      userAgent: ua,
      navigatorPlatform: os === 'android' ? 'Linux armv8l' : 'iPhone',
      // systemInfo 使用产品系统版本；Safari UA 中的系统 token 可能是兼容性固定值。
      platform: os === 'android' ? 'Android' : 'iOS',
      systemVersion: os === 'android' ? '17' : '26.0',
      clientType: os === 'android' ? 'android' : 'iphone',
      actions: applyAppBridgeConfig(profile.actions, options.bridgeConfig),
      schemes: profile.schemes,
      ...(profile.miniProgram && { miniProgram: profile.miniProgram }),
      ...(profile.imagePicker && { imagePicker: profile.imagePicker }),
      ...(profile.overlay && { overlay: profile.overlay }),
      ...(profile.popBeforeOpenParam && { popBeforeOpenParam: profile.popBeforeOpenParam }),
      ...(profile.messageEvent && { messageEvent: profile.messageEvent }),
      ...(profile.nativeBack && { nativeBack: profile.nativeBack }),
      ...(profile.layerUrlProxy && { layerUrlProxy: profile.layerUrlProxy }),
      ...(profile.urlSyncHostSuffixes && { urlSyncHostSuffixes: profile.urlSyncHostSuffixes }),
      ...(profile.runtimeOptions && { runtimeOptions: JSON.parse(JSON.stringify(profile.runtimeOptions)) }),
      simulateSystemBars: false,
      externalDeviceChrome: false,
      rootContainer: {
        enabled: false,
        ...(profile.rootContainer?.statusBarHeightCookie && {
          initialCookies: [
            {
              ...profile.rootContainer.statusBarHeightCookie,
              value: String(emulation.safeAreaInsets.top),
            },
          ],
        }),
      },
      titleBar: {
        navigationBarHeight: os === 'android' ? 48 : 44,
        backgroundColor: '#ffffff',
        textColor: '#0f131a',
        ...(profile.titleBarHiddenPathnames && {
          hiddenPathnames: profile.titleBarHiddenPathnames,
        }),
        ...(profile.statusBarBackgroundColors && {
          statusBarBackgroundColors: profile.statusBarBackgroundColors,
        }),
        ...(profile.titleBarHostStyles && { hostStyles: profile.titleBarHostStyles }),
      },
    },
    recommendedPreset,
  };
}
