/**
 * Machine-local transport for infrastructure components such as cloud-connector.
 * User-facing integrations should import from `@mearl/client` so browser routing
 * remains consistent across local and remote sources.
 */
export {
  CLIENT_VERSION,
  SOCKET_PATH,
  decorateBrowserListResult,
  getDefaultBrowser,
  invoke,
  invokeLocalHost,
  setDefaultBrowser,
} from './socket.js';
export type { InvokeOptions } from './socket.js';
export { listLiveBrowsers } from './browserRegistry.js';
export type { LiveBrowser } from './browserRegistry.js';
