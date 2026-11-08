import { emptyDeviceUserAgentMetadata, type DeviceEnvironmentObservation, type ResolvedEmulationConfig } from '@mearl/browser-core';

/** App UA wins over device UA. Unspecified Client Hints retain the captured browser values. */
export function resolveAppDeviceUserAgent(
  baseline: Pick<DeviceEnvironmentObservation, 'userAgent' | 'userAgentMetadata'>,
  device?: ResolvedEmulationConfig | null,
  appUserAgent?: string,
) {
  const metadata = baseline.userAgentMetadata;
  return {
    userAgent: appUserAgent ?? device?.userAgent ?? baseline.userAgent,
    userAgentMetadata: appUserAgent ? emptyDeviceUserAgentMetadata() : device && metadata ? {
      ...structuredClone(metadata), mobile: device.mobile, platform: device.platform,
      platformVersion: device.platformVersion, architecture: device.architecture, model: device.model,
    } : structuredClone(metadata),
  };
}
