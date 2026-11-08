import type { JsonObject } from '@mearl/preset';
import { expect, it } from 'vitest';
import { resolveBrowserPresetSettings } from '../browserPresetSettings';
const available = new Set(['reader', 'shop', 'simulation/custom']);
const device = {
  preset: 'iphone-17-pro',
  orientation: 'portrait',
  fitToWindow: true,
  deviceShell: true,
};
it('merges inherited defaults and explicit installer overrides without mutating either', () => {
  const defaults = { simulation: { app: 'reader', deviceSelection: device } };
  const overrides = {
    simulation: { app: 'shop', deviceSelection: { orientation: 'landscape' } },
  };
  expect(resolveBrowserPresetSettings(defaults, overrides, available)).toEqual({
    simulation: {
      app: 'shop',
      deviceSelection: { ...device, orientation: 'landscape', splitScreen: false },
    },
    pending: [],
  });
  expect(defaults.simulation.app).toBe('reader');
  expect(device.orientation).toBe('portrait');
  expect(overrides.simulation.deviceSelection).toEqual({ orientation: 'landscape' });
});
it('accepts installed dynamic apps and follows the existing adaptive-device normalization', () => {
  expect(
    resolveBrowserPresetSettings(
      {
        simulation: {
          app: 'simulation/custom',
          deviceSelection: { ...device, preset: 'android-adaptive' },
        },
      },
      {},
      available,
    ),
  ).toMatchObject({
    simulation: {
      app: 'simulation/custom',
      deviceSelection: { fitToWindow: false, splitScreen: false },
    },
    pending: [],
  });
});
it.each([
  { simulation: null },
  { simulation: [] },
  { simulation: { app: 'unknown' } },
  { simulation: { app: 'missing/app' } },
  { simulation: { app: true } },
  { simulation: { deviceSelection: { ...device, splitScreen: true } } },
  { simulation: { deviceSelection: { ...device, extra: true } } },
  { simulation: { deviceSelection: { ...device, orientation: 'diagonal' } } },
])('rejects invalid known defaults before activation %#', defaults => {
  expect(() =>
    resolveBrowserPresetSettings(defaults as unknown as JsonObject, {}, available),
  ).toThrow('BUNDLE_INVALID');
});
it('keeps unsupported settings pending instead of reporting them as applied', () => {
  expect(
    resolveBrowserPresetSettings(
      { extension: { unknown: true }, simulation: { app: 'reader', timezone: 'UTC' } },
      {},
      available,
    ),
  ).toEqual({ simulation: { app: 'reader' }, pending: ['extension.unknown', 'simulation.timezone'] });
});

it('merges service defaults and installer overrides without writing user preferences', () => {
  const defaults = { services: { reportsEnabled: true, accountsEnabled: true } };
  const overrides = { services: { reportsEnabled: false } };
  expect(resolveBrowserPresetSettings(defaults, overrides, available)).toMatchObject({
    services: { reportsEnabled: false, accountsEnabled: true }, pending: [],
  });
  expect(defaults.services.reportsEnabled).toBe(true);
});
it.each([null, [], { reportsEnabled: 'yes' }, { agentEnabled: 1 }, { invalid: true }, { 'invalid-settingEnabled': true }])('rejects malformed service defaults %#', services => {
  expect(() => resolveBrowserPresetSettings({ services } as unknown as JsonObject, {}, available)).toThrow('BUNDLE_INVALID');
});

it('accepts an installed short preset alias while rejecting uninstalled targets', () => {
  expect(resolveBrowserPresetSettings({ simulation: { app: 'maps' } }, {}, new Set(['maps']))).toMatchObject({ simulation: { app: 'maps' }, pending: [] });
  expect(() => resolveBrowserPresetSettings({ simulation: { app: 'maps' } }, {}, new Set())).toThrow('BUNDLE_INVALID');
});
