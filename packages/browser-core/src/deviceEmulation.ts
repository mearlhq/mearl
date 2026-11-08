/**
 * 移动端模拟（device emulation）共享逻辑
 *
 * 同时被以下两条路径复用：
 * - extension：通过 chrome.debugger.sendCommand 下发 CDP 指令
 * - native-host CDP backend：通过 cdp-session client 下发同样的指令
 *
 * 两条路径共享 preset 表 / 默认值推导 / 入参校验，确保对外行为完全一致。
 */

import type { BrowserDevicePresetName, BrowserEmulationOptions } from './browserActionProtocol.js';
import type { DeviceChromeViewConfig } from './deviceChromeView.js';

export interface DevicePreset {
  width: number;
  height: number;
  /** 设备自然展开形态的方向；尺寸仍按竖屏宽高存储。 */
  defaultOrientation?: 'portrait' | 'landscape';
  deviceScaleFactor: number;
  mobile: boolean;
  /** 是否启用触摸事件；未配置时跟随 mobile */
  touch?: boolean;
  userAgent: string;
  platform: string;
  // CDP UserAgentMetadata 强制要求的字段
  platformVersion: string;
  architecture: string;
  model: string;
  /** CSS env(safe-area-inset-*) 对应的竖屏安全区，单位为 CSS px */
  safeAreaInsets: SafeAreaInsets;
  /** 横屏安全区；未配置时按竖屏四边旋转 */
  landscapeSafeAreaInsets?: SafeAreaInsets;
  /** App 容器对外暴露的设备型号，与 CDP Client Hints 的 model 独立。 */
  appProfileModel: string;
  /** 与设备配套的 App 容器系统。 */
  appProfileOs: 'ios' | 'android';
  /** 竖屏时设备屏幕顶部的物理外观。 */
  appearance: DeviceAppearance;
}

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type DeviceCutout = 'none' | 'dynamic-island' | 'notch' | 'side-camera';

export interface DeviceAppearance {
  cutout: DeviceCutout;
}

export interface ResolvedDeviceChromeConfig extends DeviceChromeViewConfig {
  safeAreaInsets: SafeAreaInsets;
}

/** Shared system-bar geometry for H5 containers and local mini-programs. */
export function getDeviceChromeViewConfig(emulation: ResolvedEmulationConfig): ResolvedDeviceChromeConfig {
  const platform = emulation.platform === 'Android' || emulation.platform === 'OpenHarmony' ? 'android' : 'ios';
  const sideBarWidth = getDeviceSideBarWidth(emulation.presetName, emulation.orientation);
  return {
    platform,
    statusBarHeight: sideBarWidth ? 0 : emulation.orientation === 'landscape' ? 24 : emulation.safeAreaInsets.top,
    bottomBarHeight: emulation.safeAreaInsets.bottom,
    ...(sideBarWidth ? { sideBarWidth } : {}),
    safeAreaInsets: { ...emulation.safeAreaInsets },
    cutout: platform === 'ios' ? emulation.appearance.cutout : 'none',
  };
}

const IPHONE_DUO_SIDE_BAR_WIDTH = 84;

/** Duo 除内屏竖屏外使用纵向系统栏，业务 WebView 避让屏幕右边缘。 */
export function getDeviceSideBarWidth(
  preset: BrowserDevicePresetName | undefined,
  orientation: 'portrait' | 'landscape',
): number {
  if (
    preset === 'iphone-duo-folded' ||
    (preset === 'iphone-duo-unfolded' && orientation === 'landscape')
  ) {
    return IPHONE_DUO_SIDE_BAR_WIDTH;
  }
  return 0;
}

// Safari 26 将 iPhone UA 的系统版本固定为 18_6，实际系统版本通过平台元数据表达。
const IPHONE_SAFARI_26_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
// Safari 27 沿用 WebKit 冻结的 iPhone OS 版本段；Duo 在两块屏上保持 iPhone 身份。
const IPHONE_SAFARI_27_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';

// Chrome 的精简 UA 隐藏 Android 版本与机型，完整信息由 User-Agent Client Hints 提供。
const ANDROID_CHROME_152_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';

// 当前机型参考厂商规格、系统设计尺寸与浏览器 UA；历史机型保持原参数用于兼容。
// Duo 采用 Xcode 设备 profile 的渲染尺寸；纵向系统栏为业务 WebView 保留 84 CSS px。
export const DEVICE_PRESETS: Record<BrowserDevicePresetName, DevicePreset> = {
  'iphone-duo-folded': {
    width: 466,
    height: 678,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: IPHONE_SAFARI_27_USER_AGENT,
    platform: 'iPhone',
    platformVersion: '27.0',
    architecture: '',
    model: 'iPhone',
    safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 84, bottom: 21, left: 0 },
    appProfileModel: 'iPhone Duo',
    appProfileOs: 'ios',
    appearance: { cutout: 'side-camera' },
  },
  'iphone-duo-unfolded': {
    width: 669,
    height: 951,
    defaultOrientation: 'landscape',
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: IPHONE_SAFARI_27_USER_AGENT,
    platform: 'iPhone',
    platformVersion: '27.0',
    architecture: '',
    model: 'iPhone',
    safeAreaInsets: { top: 80, right: 0, bottom: 34, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
    appProfileModel: 'iPhone Duo',
    appProfileOs: 'ios',
    appearance: { cutout: 'none' },
  },
  'iphone-17-pro': {
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: IPHONE_SAFARI_26_USER_AGENT,
    platform: 'iPhone',
    platformVersion: '26.0',
    architecture: '',
    model: 'iPhone',
    safeAreaInsets: { top: 62, right: 0, bottom: 34, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 62, bottom: 21, left: 62 },
    appProfileModel: 'iPhone 17 Pro',
    appProfileOs: 'ios',
    appearance: { cutout: 'dynamic-island' },
  },
  'iphone-17e': {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: IPHONE_SAFARI_26_USER_AGENT,
    platform: 'iPhone',
    platformVersion: '26.0',
    architecture: '',
    model: 'iPhone',
    safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 47, bottom: 21, left: 47 },
    appProfileModel: 'iPhone 17e',
    appProfileOs: 'ios',
    appearance: { cutout: 'notch' },
  },
  'pixel-11': {
    width: 412,
    height: 923,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: ANDROID_CHROME_152_USER_AGENT,
    platform: 'Android',
    platformVersion: '17',
    architecture: 'arm',
    model: 'Pixel 11',
    safeAreaInsets: { top: 30, right: 0, bottom: 24, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 24, bottom: 0, left: 24 },
    appProfileModel: 'Pixel 11',
    appProfileOs: 'android',
    appearance: { cutout: 'none' },
  },
  'ipad-mini-a17-pro': {
    width: 744,
    height: 1133,
    deviceScaleFactor: 2,
    // iPad Safari 默认使用 desktop-class UA，但仍保留真实触摸能力。
    mobile: false,
    touch: true,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    platform: 'macOS',
    platformVersion: '10.15.7',
    architecture: 'x86',
    model: '',
    safeAreaInsets: { top: 24, right: 0, bottom: 20, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 24, bottom: 20, left: 24 },
    appProfileModel: 'iPad mini (A17 Pro)',
    appProfileOs: 'ios',
    appearance: { cutout: 'none' },
  },
  'galaxy-s26': {
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: ANDROID_CHROME_152_USER_AGENT,
    platform: 'Android',
    platformVersion: '16',
    architecture: 'arm',
    model: 'SM-S942B',
    safeAreaInsets: { top: 30, right: 0, bottom: 24, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 24, bottom: 0, left: 24 },
    appProfileModel: 'SM-S942B',
    appProfileOs: 'android',
    appearance: { cutout: 'none' },
  },
  'pura-x-max': {
    // 单一视口覆盖展开内屏；横屏时即为设备常用的 939 × 664 vp 形态。
    width: 664,
    height: 939,
    deviceScaleFactor: 2.75,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Phone;OpenHarmony 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.0.0.42 Mobile',
    platform: 'OpenHarmony',
    platformVersion: '6.0',
    architecture: '',
    model: 'HUAWEI Pura X Max',
    safeAreaInsets: { top: 30, right: 0, bottom: 24, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 24, bottom: 0, left: 24 },
    appProfileModel: 'HUAWEI Pura X Max',
    appProfileOs: 'android',
    appearance: { cutout: 'none' },
  },
  'iphone-15-pro': {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    platformVersion: '17.0',
    architecture: '',
    model: 'iPhone',
    safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 59, bottom: 21, left: 59 },
    appProfileModel: 'iPhone 15 Pro',
    appProfileOs: 'ios',
    appearance: { cutout: 'dynamic-island' },
  },
  'iphone-se': {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    platformVersion: '16.0',
    architecture: '',
    model: 'iPhone',
    safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    appProfileModel: 'iPhone SE',
    appProfileOs: 'ios',
    appearance: { cutout: 'none' },
  },
  'pixel-8': {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    platform: 'Android',
    platformVersion: '14',
    architecture: '',
    model: 'Pixel 8',
    safeAreaInsets: { top: 30, right: 0, bottom: 24, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 24, bottom: 0, left: 24 },
    appProfileModel: 'Pixel 8',
    appProfileOs: 'android',
    appearance: { cutout: 'none' },
  },
  'ipad-mini': {
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    // iPad 现行 Safari UA 默认 desktop class，mobile flag 设 false 以匹配真机表现
    mobile: false,
    touch: true,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    platform: 'macOS',
    platformVersion: '10.15.7',
    architecture: 'x86',
    model: '',
    safeAreaInsets: { top: 24, right: 0, bottom: 20, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 24, bottom: 20, left: 24 },
    appProfileModel: 'iPad mini',
    appProfileOs: 'ios',
    appearance: { cutout: 'none' },
  },
  'galaxy-s23': {
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    platform: 'Android',
    platformVersion: '14',
    architecture: '',
    model: 'SM-S911B',
    safeAreaInsets: { top: 30, right: 0, bottom: 24, left: 0 },
    landscapeSafeAreaInsets: { top: 0, right: 24, bottom: 0, left: 24 },
    appProfileModel: 'SM-S911B',
    appProfileOs: 'android',
    appearance: { cutout: 'none' },
  },
};

export interface ResolvedEmulationConfig {
  width: number;
  height: number;
  deviceScaleFactor: number;
  scale?: number;
  mobile: boolean;
  userAgent: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  touch: boolean;
  orientation: 'portrait' | 'landscape';
  safeAreaInsets: SafeAreaInsets;
  appearance: DeviceAppearance;
  presetName?: BrowserDevicePresetName;
}

export interface SetDeviceEmulationInput extends BrowserEmulationOptions {
  enabled: boolean;
}

/**
 * 把外部入参 + preset 表归一化为可直接下发 CDP 的配置。
 * 校验失败时抛出 Error，描述清楚缺什么 / 哪个 preset 不存在。
 *
 * `enabled: false` 不会走这里 —— 调用方应直接下发 clear 指令。
 */
export function resolveEmulationConfig(input: SetDeviceEmulationInput): ResolvedEmulationConfig {
  if (input.preset && !(input.preset in DEVICE_PRESETS)) {
    throw new Error(
      `set_device_emulation: unknown preset "${input.preset}". ` +
        `Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`,
    );
  }

  const preset = input.preset ? DEVICE_PRESETS[input.preset] : undefined;

  const width = input.width ?? preset?.width;
  const height = input.height ?? preset?.height;
  if (!width || !height) {
    throw new Error(
      'set_device_emulation: must provide either "preset" or both "width" and "height"',
    );
  }

  const mobile = input.mobile ?? preset?.mobile ?? true;
  const orientation: 'portrait' | 'landscape' =
    input.orientation ?? preset?.defaultOrientation ?? 'portrait';
  const scale = input.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('set_device_emulation: "scale" must be a finite positive number');
  }

  // landscape 时对调宽高（在覆盖之后再换，让用户传的 width/height 是 portrait 视角）
  const [finalWidth, finalHeight] = orientation === 'landscape' ? [height, width] : [width, height];

  const userAgent = input.userAgent ?? preset?.userAgent ?? '';
  if (!userAgent) {
    throw new Error(
      'set_device_emulation: "userAgent" is required when no preset is used (preset supplies a default)',
    );
  }

  const safeAreaInsets =
    orientation === 'landscape'
      ? (preset?.landscapeSafeAreaInsets ?? {
          top: preset?.safeAreaInsets.left ?? 0,
          right: preset?.safeAreaInsets.top ?? 0,
          bottom: preset?.safeAreaInsets.right ?? 0,
          left: preset?.safeAreaInsets.bottom ?? 0,
        })
      : (preset?.safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 });
  const appearance: DeviceAppearance = {
    cutout: orientation === 'landscape' ? 'none' : (preset?.appearance.cutout ?? 'none'),
  };

  return {
    width: finalWidth,
    height: finalHeight,
    deviceScaleFactor: input.deviceScaleFactor ?? preset?.deviceScaleFactor ?? (mobile ? 2 : 1),
    scale,
    mobile,
    userAgent,
    platform: preset?.platform ?? (mobile ? 'iPhone' : 'macOS'),
    platformVersion: preset?.platformVersion ?? '',
    architecture: preset?.architecture ?? '',
    model: preset?.model ?? '',
    touch: input.touch ?? preset?.touch ?? mobile,
    orientation,
    safeAreaInsets,
    appearance,
    presetName: input.preset,
  };
}

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
  /** 实验性 CDP 能力在旧版 Chrome 不存在时可安全跳过 */
  optional?: boolean;
}

export type DeviceEnvironmentConfig = Omit<
  ResolvedEmulationConfig,
  'width' | 'height' | 'deviceScaleFactor' | 'scale' | 'presetName'
>;

/** 构造不接管 viewport 的设备环境指令，供自适应模式与 DevTools 设备栏组合使用。 */
export function buildEnableDeviceEnvironmentCommands(
  config: DeviceEnvironmentConfig,
): CdpCommand[] {
  const safeAreaInsets = config.safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return [
    {
      method: 'Emulation.setUserAgentOverride',
      params: {
        userAgent: config.userAgent,
        platform: config.platform,
        userAgentMetadata: {
          mobile: config.mobile,
          platform: config.platform,
          platformVersion: config.platformVersion,
          architecture: config.architecture,
          model: config.model,
        },
      },
    },
    {
      method: 'Emulation.setTouchEmulationEnabled',
      params: config.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    },
    // 让 Input.dispatchMouseEvent 自动产出 touch 事件，swiper/fastclick 才能识别
    {
      method: 'Emulation.setEmitTouchEventsForMouse',
      params: { enabled: config.touch, configuration: 'mobile' },
    },
    {
      method: 'Emulation.setSafeAreaInsetsOverride',
      params: {
        insets: {
          top: safeAreaInsets.top,
          topMax: safeAreaInsets.top,
          right: safeAreaInsets.right,
          rightMax: safeAreaInsets.right,
          bottom: safeAreaInsets.bottom,
          bottomMax: safeAreaInsets.bottom,
          left: safeAreaInsets.left,
          leftMax: safeAreaInsets.left,
        },
      },
      optional: true,
    },
  ];
}

/** 构造启用模拟所需的 CDP 指令序列，两端按顺序下发即可 */
export function buildEnableEmulationCommands(config: ResolvedEmulationConfig): CdpCommand[] {
  return [
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: config.width,
        height: config.height,
        screenWidth: config.width,
        screenHeight: config.height,
        deviceScaleFactor: config.deviceScaleFactor,
        scale: config.scale ?? 1,
        ...((config.scale ?? 1) !== 1 ? { dontSetVisibleSize: true } : {}),
        mobile: config.mobile,
        screenOrientation: {
          type: config.orientation === 'landscape' ? 'landscapePrimary' : 'portraitPrimary',
          angle: config.orientation === 'landscape' ? 90 : 0,
        },
      },
    },
    // 合成缩放不改变 Chrome 的显示区域，区域尺寸需与缩放后的设备画面一致。
    ...((config.scale ?? 1) !== 1
      ? [
          {
            method: 'Emulation.setVisibleSize',
            params: {
              width: Math.max(1, Math.round(config.width * (config.scale ?? 1))),
              height: Math.max(1, Math.round(config.height * (config.scale ?? 1))),
            },
          },
        ]
      : []),
    ...buildEnableDeviceEnvironmentCommands(config),
  ];
}

/** 构造清除模拟所需的 CDP 指令序列 */
export function buildDisableEmulationCommands(): CdpCommand[] {
  return [
    { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
    { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
    { method: 'Emulation.setEmitTouchEventsForMouse', params: { enabled: false } },
    {
      method: 'Emulation.setSafeAreaInsetsOverride',
      params: { insets: {} },
      optional: true,
    },
  ];
}
