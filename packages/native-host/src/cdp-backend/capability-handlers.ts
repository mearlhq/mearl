import { describeBrowserCapabilities } from '@mearl/browser-core';
import { listInstalledAppProfiles } from '../app-profile-catalog.js';
import { registerActions, getRegisteredActionNames } from './action-registry.js';

registerActions([{
  name: 'get_capabilities',
  session: 'browser',
  handler: async (_session, data) => describeBrowserCapabilities(getRegisteredActionNames(), await listInstalledAppProfiles({ refresh: false }), data),
}]);
