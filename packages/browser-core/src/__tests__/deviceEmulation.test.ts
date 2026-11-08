import { describe, it, expect } from 'vitest';
import {
  resolveEmulationConfig,
  buildEnableDeviceEnvironmentCommands,
  buildEnableEmulationCommands,
  buildDisableEmulationCommands,
  DEVICE_PRESETS,
  getDeviceChromeViewConfig,
} from '../deviceEmulation';

it('shares cutouts, landscape status bars and Duo side bars across clients', () => {
  const chrome = (preset: Parameters<typeof resolveEmulationConfig>[0]['preset'], orientation: 'portrait' | 'landscape') => getDeviceChromeViewConfig(resolveEmulationConfig({ enabled: true, preset, orientation }));
  expect(chrome('iphone-17-pro', 'portrait')).toMatchObject({ statusBarHeight: 62, cutout: 'dynamic-island' });
  expect(chrome('iphone-17e', 'portrait')).toMatchObject({ statusBarHeight: 47, cutout: 'notch' });
  expect(chrome('iphone-17-pro', 'landscape')).toMatchObject({ statusBarHeight: 24, cutout: 'none' });
  expect(chrome('iphone-duo-folded', 'portrait')).toMatchObject({ statusBarHeight: 0, sideBarWidth: 84, cutout: 'side-camera' });
  expect(chrome('iphone-duo-folded', 'landscape')).toMatchObject({ statusBarHeight: 0, sideBarWidth: 84, cutout: 'none' });
  expect(chrome('iphone-duo-unfolded', 'landscape')).toMatchObject({ statusBarHeight: 0, sideBarWidth: 84, cutout: 'none' });
  expect(chrome('iphone-duo-unfolded', 'portrait')).toMatchObject({ statusBarHeight: 80, cutout: 'none' });
});

describe('resolveEmulationConfig', () => {
  it('resolves a preset to its full config', () => {
    const cfg = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const preset = DEVICE_PRESETS['iphone-17-pro'];
    expect(cfg).toMatchObject({
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      scale: 1,
      mobile: true,
      userAgent: preset.userAgent,
      platform: 'iPhone',
      touch: true,
      orientation: 'portrait',
      presetName: 'iphone-17-pro',
      safeAreaInsets: { top: 62, right: 0, bottom: 34, left: 0 },
      appearance: { cutout: 'dynamic-island' },
    });
  });

  it('swaps width/height for landscape orientation', () => {
    const portrait = DEVICE_PRESETS['iphone-17-pro'];
    const cfg = resolveEmulationConfig({
      enabled: true,
      preset: 'iphone-17-pro',
      orientation: 'landscape',
    });
    expect(cfg.width).toBe(portrait.height);
    expect(cfg.height).toBe(portrait.width);
    expect(cfg.orientation).toBe('landscape');
    expect(cfg.safeAreaInsets).toEqual({ top: 0, right: 62, bottom: 21, left: 62 });
    expect(cfg.appearance).toEqual({ cutout: 'none' });
  });

  it('uses each iPhone Duo display in its natural orientation', () => {
    const folded = resolveEmulationConfig({ enabled: true, preset: 'iphone-duo-folded' });
    const unfolded = resolveEmulationConfig({ enabled: true, preset: 'iphone-duo-unfolded' });

    expect(folded).toMatchObject({
      width: 466,
      height: 678,
      deviceScaleFactor: 3,
      orientation: 'portrait',
      platformVersion: '27.0',
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
    });
    expect(unfolded).toMatchObject({
      width: 951,
      height: 669,
      deviceScaleFactor: 3,
      orientation: 'landscape',
      platformVersion: '27.0',
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
    });
    expect(
      resolveEmulationConfig({
        enabled: true,
        preset: 'iphone-duo-unfolded',
        orientation: 'portrait',
      }),
    ).toMatchObject({
      width: 669,
      height: 951,
      safeAreaInsets: { top: 80, right: 0, bottom: 34, left: 0 },
    });
    expect(
      resolveEmulationConfig({
        enabled: true,
        preset: 'iphone-duo-folded',
        orientation: 'landscape',
      }),
    ).toMatchObject({
      width: 678,
      height: 466,
      safeAreaInsets: { top: 0, right: 84, bottom: 21, left: 0 },
    });
  });

  it('lets explicit width/height override the preset (in portrait terms)', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      preset: 'iphone-17-pro',
      width: 400,
      height: 800,
    });
    expect(cfg.width).toBe(400);
    expect(cfg.height).toBe(800);
  });

  it('derives sensible defaults for a preset-less mobile config', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      width: 320,
      height: 640,
      userAgent: 'Custom UA',
    });
    expect(cfg).toMatchObject({
      width: 320,
      height: 640,
      mobile: true, // default when neither preset nor mobile flag given
      deviceScaleFactor: 2, // mobile default
      platform: 'iPhone',
      touch: true,
    });
  });

  it('derives desktop defaults when mobile is explicitly false', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      width: 1280,
      height: 800,
      userAgent: 'Desktop UA',
      mobile: false,
    });
    expect(cfg).toMatchObject({
      mobile: false,
      deviceScaleFactor: 1, // desktop default
      platform: 'macOS',
      touch: false,
    });
  });

  it('keeps touch enabled for the desktop-class iPad preset', () => {
    const cfg = resolveEmulationConfig({ enabled: true, preset: 'ipad-mini-a17-pro' });

    expect(cfg).toMatchObject({
      mobile: false,
      touch: true,
    });
  });

  it('keeps visual scale separate from the device pixel ratio', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      preset: 'pixel-11',
      scale: 0.75,
    });

    expect(cfg.scale).toBe(0.75);
    expect(cfg.deviceScaleFactor).toBe(DEVICE_PRESETS['pixel-11'].deviceScaleFactor);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid visual scale %s',
    scale => {
      expect(() => resolveEmulationConfig({ enabled: true, preset: 'pixel-11', scale })).toThrow(
        /"scale" must be a finite positive number/,
      );
    },
  );

  it.each([
    ['iphone-17-pro', 402, 874, 3, '26.0', 'iPhone', 'iPhone 17 Pro', 'ios', 'dynamic-island'],
    ['iphone-17e', 390, 844, 3, '26.0', 'iPhone', 'iPhone 17e', 'ios', 'notch'],
    ['pixel-11', 412, 923, 2.625, '17', 'Pixel 11', 'Pixel 11', 'android', 'none'],
    ['ipad-mini-a17-pro', 744, 1133, 2, '10.15.7', '', 'iPad mini (A17 Pro)', 'ios', 'none'],
    ['galaxy-s26', 360, 780, 3, '16', 'SM-S942B', 'SM-S942B', 'android', 'none'],
    [
      'pura-x-max',
      664,
      939,
      2.75,
      '6.0',
      'HUAWEI Pura X Max',
      'HUAWEI Pura X Max',
      'android',
      'none',
    ],
  ] as const)(
    'provides current parameters for %s',
    (
      preset,
      width,
      height,
      deviceScaleFactor,
      platformVersion,
      model,
      appProfileModel,
      appProfileOs,
      cutout,
    ) => {
      expect(DEVICE_PRESETS[preset]).toMatchObject({
        width,
        height,
        deviceScaleFactor,
        platformVersion,
        model,
        appProfileModel,
        appProfileOs,
        appearance: { cutout },
      });
    },
  );

  it('keeps concrete legacy presets available with their original dimensions', () => {
    expect(DEVICE_PRESETS['iphone-15-pro']).toMatchObject({ width: 393, height: 852 });
    expect(DEVICE_PRESETS['iphone-se']).toMatchObject({ width: 375, height: 667 });
    expect(DEVICE_PRESETS['pixel-8']).toMatchObject({ width: 412, height: 915 });
    expect(DEVICE_PRESETS['ipad-mini']).toMatchObject({ width: 768, height: 1024 });
    expect(DEVICE_PRESETS['galaxy-s23']).toMatchObject({ width: 360, height: 780 });
    expect(DEVICE_PRESETS['iphone-15-pro'].appearance.cutout).toBe('dynamic-island');
    expect(DEVICE_PRESETS['iphone-se'].appearance.cutout).toBe('none');
  });

  it('rotates the Pura X Max expanded inner display to its native wide viewport', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      preset: 'pura-x-max',
      orientation: 'landscape',
    });

    expect(cfg).toMatchObject({ width: 939, height: 664, deviceScaleFactor: 2.75 });
  });

  it('throws on an unknown preset and lists the valid names', () => {
    expect(() => resolveEmulationConfig({ enabled: true, preset: 'nokia-3310' as never })).toThrow(
      /unknown preset "nokia-3310"/,
    );
  });

  it('throws when neither preset nor width/height is provided', () => {
    expect(() => resolveEmulationConfig({ enabled: true })).toThrow(/either "preset" or both/);
  });

  it('throws when a preset-less config omits userAgent', () => {
    expect(() => resolveEmulationConfig({ enabled: true, width: 320, height: 640 })).toThrow(
      /"userAgent" is required/,
    );
  });
});

describe('buildEnableDeviceEnvironmentCommands', () => {
  it('leaves viewport metrics to DevTools while applying the device environment', () => {
    const cfg = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const cmds = buildEnableDeviceEnvironmentCommands(cfg);

    expect(cmds.map(c => c.method)).toEqual([
      'Emulation.setUserAgentOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setEmitTouchEventsForMouse',
      'Emulation.setSafeAreaInsetsOverride',
    ]);
    expect(cmds.map(c => c.method)).not.toContain('Emulation.setDeviceMetricsOverride');
    expect(cmds.map(c => c.method)).not.toContain('Emulation.setVisibleSize');
  });
});

describe('buildEnableEmulationCommands', () => {
  it('emits device and safe-area CDP overrides in order with derived params', () => {
    const cfg = resolveEmulationConfig({ enabled: true, preset: 'pixel-11' });
    const cmds = buildEnableEmulationCommands(cfg);

    expect(cmds.map(c => c.method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setUserAgentOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setEmitTouchEventsForMouse',
      'Emulation.setSafeAreaInsetsOverride',
    ]);

    expect(cmds[0].params).toMatchObject({
      width: cfg.width,
      height: cfg.height,
      screenWidth: cfg.width,
      screenHeight: cfg.height,
      deviceScaleFactor: cfg.deviceScaleFactor,
      scale: 1,
      mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    expect(cmds[1].params).toMatchObject({
      userAgent: expect.stringContaining('Chrome/152.0.0.0'),
      platform: 'Android',
      userAgentMetadata: {
        mobile: true,
        platform: 'Android',
        platformVersion: '17',
        architecture: 'arm',
        model: 'Pixel 11',
      },
    });
    expect(cmds[2].params).toEqual({ enabled: true, maxTouchPoints: 5 });
    expect(cmds[4]).toEqual({
      method: 'Emulation.setSafeAreaInsetsOverride',
      params: {
        insets: {
          top: 30,
          topMax: 30,
          right: 0,
          rightMax: 0,
          bottom: 24,
          bottomMax: 24,
          left: 0,
          leftMax: 0,
        },
      },
      optional: true,
    });
  });

  it('reports landscape orientation in the metrics override', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      preset: 'pixel-11',
      orientation: 'landscape',
    });
    const [metrics] = buildEnableEmulationCommands(cfg);
    expect(metrics.params.screenOrientation).toEqual({ type: 'landscapePrimary', angle: 90 });
  });

  it('emits the OpenHarmony ArkWeb identity for Pura X Max', () => {
    const cfg = resolveEmulationConfig({ enabled: true, preset: 'pura-x-max' });
    const [, userAgent] = buildEnableEmulationCommands(cfg);

    expect(userAgent.params).toMatchObject({
      userAgent: expect.stringContaining('OpenHarmony 6.0'),
      platform: 'OpenHarmony',
      userAgentMetadata: expect.objectContaining({
        platformVersion: '6.0',
        model: 'HUAWEI Pura X Max',
      }),
    });
  });

  it('passes an explicit visual scale to the metrics override', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      preset: 'pixel-11',
      scale: 0.8,
    });
    const [metrics, visibleSize] = buildEnableEmulationCommands(cfg);

    expect(metrics.params.scale).toBe(0.8);
    expect(metrics.params.dontSetVisibleSize).toBe(true);
    expect(visibleSize).toEqual({
      method: 'Emulation.setVisibleSize',
      params: { width: Math.round(cfg.width * 0.8), height: Math.round(cfg.height * 0.8) },
    });
  });

  it('omits maxTouchPoints when touch emulation is disabled', () => {
    const cfg = resolveEmulationConfig({
      enabled: true,
      preset: 'pixel-11',
      touch: false,
    });
    const cmds = buildEnableEmulationCommands(cfg);

    expect(cmds[2].params).toEqual({ enabled: false });
    expect(cmds[3].params).toEqual({ enabled: false, configuration: 'mobile' });
  });
});

describe('buildDisableEmulationCommands', () => {
  it('emits the matching clear commands', () => {
    const cmds = buildDisableEmulationCommands();
    expect(cmds.map(c => c.method)).toEqual([
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setUserAgentOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setEmitTouchEventsForMouse',
      'Emulation.setSafeAreaInsetsOverride',
    ]);
    expect(cmds[1].params).toEqual({ userAgent: '' });
    expect(cmds[4]).toEqual({
      method: 'Emulation.setSafeAreaInsetsOverride',
      params: { insets: {} },
      optional: true,
    });
  });
});
