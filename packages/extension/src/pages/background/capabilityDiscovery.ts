import { describeBrowserCapabilities, EXTENSION_BROWSER_ACTIONS, type GetCapabilitiesParams } from '@mearl/browser-core';
import { getAppProfileCatalog } from './appProfileCatalog';

export async function handleGetCapabilities(params: GetCapabilitiesParams = {}) {
  return describeBrowserCapabilities(Object.keys(EXTENSION_BROWSER_ACTIONS), await getAppProfileCatalog({ refresh: false }), params);
}
