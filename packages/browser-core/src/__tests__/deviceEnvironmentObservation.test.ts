import { describe, expect, it } from 'vitest';
import { deviceEnvironmentObservationsEqual, type DeviceEnvironmentObservation } from '../deviceEnvironmentObservation.js';
import { isProviderInitialEnvironment } from '../browserEnhancement.js';

const native: DeviceEnvironmentObservation = {
  userAgent: 'Native', platform: 'Host',
  userAgentMetadata: { brands: [{ brand: 'Browser', version: '1' }, { brand: 'Other', version: '2' }], fullVersionList: [{ brand: 'Browser', version: '1.2.3' }], platform: 'Host OS', platformVersion: '1', architecture: 'arm', model: '', mobile: false },
  screen: { width: 1920, height: 1080, deviceScaleFactor: 2, orientation: 'landscape-primary', angle: 0 },
  touchPoints: 0, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};

describe('device environment value equality across transports', () => {
  it('accepts only an explicit Creator host-platform policy beside the captured baseline', () => {
    expect(isProviderInitialEnvironment({ device: native })).toBe(true);
    expect(isProviderInitialEnvironment({ device: native, preserveHostPlatform: true })).toBe(true);
    expect(isProviderInitialEnvironment({ device: native, preserveHostPlatform: true, preserveHostInput: true })).toBe(true);
    expect(isProviderInitialEnvironment({ device: native, preserveHostInput: true })).toBe(true);
    for (const preserveHostPlatform of [false, 'native', {}, null])
      expect(isProviderInitialEnvironment({ device: native, preserveHostPlatform })).toBe(false);
    for (const preserveHostInput of [false, 'native', {}, null])
      expect(isProviderInitialEnvironment({ device: native, preserveHostInput })).toBe(false);
    expect(isProviderInitialEnvironment({ device: native, preserveHostPlatform: true, platform: 'untrusted' })).toBe(false);
  });
  it('accepts reordered nested JSON keys without changing values', () => {
    const received = JSON.parse(JSON.stringify(native, (_key, value) => value && !Array.isArray(value) && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(JSON.stringify(received)).not.toBe(JSON.stringify(native));
    expect(deviceEnvironmentObservationsEqual(native, received)).toBe(true);
  });
  it('still rejects actual metadata, metric, inset and platform changes', () => {
    for (const change of [
      (value: DeviceEnvironmentObservation) => { value.platform = 'Other'; },
      (value: DeviceEnvironmentObservation) => { value.userAgentMetadata!.platformVersion = '2'; },
      (value: DeviceEnvironmentObservation) => { value.screen.width++; },
      (value: DeviceEnvironmentObservation) => { value.safeAreaInsets.top++; },
    ]) {
      const received = structuredClone(native); change(received);
      expect(deviceEnvironmentObservationsEqual(native, received)).toBe(false);
    }
  });
  it('preserves ordered Client Hint lists and the distinction between hidden and present metadata', () => {
    const received = structuredClone(native); received.userAgentMetadata!.brands.reverse();
    expect(deviceEnvironmentObservationsEqual(native, received)).toBe(false);
    received.userAgentMetadata = null;
    expect(deviceEnvironmentObservationsEqual(native, received)).toBe(false);
  });
});
