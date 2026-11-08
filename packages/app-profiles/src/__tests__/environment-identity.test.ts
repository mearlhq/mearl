import { describe, expect, it } from 'vitest';
import { emptyDeviceUserAgentMetadata, resolveEmulationConfig } from '@mearl/browser-core';
import { resolveAppDeviceUserAgent } from '../environment/identity.js';

describe('App/device user-agent composition', () => {
  const baseline = { userAgent: 'Native', userAgentMetadata: { brands: [{ brand: 'Chromium', version: '156' }], fullVersionList: [{ brand: 'Chromium', version: '156.0.0.0' }],
    fullVersion: '156.0.0.0', platform: 'macOS', platformVersion: '1', architecture: 'arm', model: '', mobile: false } };
  it('keeps the native identity when neither component supplies a UA', () => {
    expect(resolveAppDeviceUserAgent(baseline)).toEqual(baseline);
  });
  it('uses device hints with browser-version fields preserved and App UA taking precedence', () => {
    const device = resolveEmulationConfig({ enabled: true, preset: 'pixel-11' });
    const identity = resolveAppDeviceUserAgent(baseline, device);
    expect(identity.userAgent).toBe(device.userAgent);
    expect(identity.userAgentMetadata).toEqual({ ...baseline.userAgentMetadata, platform: device.platform,
      platformVersion: device.platformVersion, architecture: device.architecture, model: device.model, mobile: device.mobile });
    expect(resolveAppDeviceUserAgent(baseline, device, 'App/1')).toEqual({ userAgent: 'App/1', userAgentMetadata: emptyDeviceUserAgentMetadata() });
    expect(baseline.userAgentMetadata.platform).toBe('macOS');
    identity.userAgentMetadata!.brands[0]!.version = 'changed';
    expect(baseline.userAgentMetadata.brands[0]!.version).toBe('156');
  });
});
