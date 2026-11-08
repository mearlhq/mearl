import type { BrowserRequestUi } from '@mearl/preset/bundles';
import { BundleError } from '@mearl/preset/bundles';
import { EXTERNAL_SERVICE_KEYS } from './externalServices';

/** This host maps request metadata into its existing service setting slot. */
export function validateRequestUiSetting(definition: BrowserRequestUi): BrowserRequestUi {
  if (
    EXTERNAL_SERVICE_KEYS.some(key => key !== 'requestMetadataEnabled' && key === definition.setting.key)
  ) {
    throw new BundleError('BUNDLE_INVALID', 'The request UI setting belongs to another service');
  }
  return definition;
}
