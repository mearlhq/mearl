/**
 * CDP backend action handlers — re-export hub.
 *
 * All handler implementations live in dedicated sub-modules.
 * Importing this file triggers side-effect registrations in the action registry.
 */

// Import sub-modules to trigger their registerActions() calls.
// Each module self-registers its actions as a side effect at module load time.
import './request-handlers.js';
import './mock-handlers.js';
import './http-handlers.js';
import './browser-handlers.js';
import './capability-handlers.js';
import './rule-handlers.js';
import './tab-handlers.js';
import './interaction-handlers.js';
import './app-profile-handlers.js';
import './timezone-handlers.js';
import './cookie-handlers.js';
import './snapshot-handlers.js';
import './composite-handlers.js';

// Re-export the registry dispatcher for use by handleViaCdp
export { dispatchCdpAction, getRegisteredActionNames } from './action-registry.js';

// Re-export individual handlers for any direct-import call sites
export { cdpGetRequests, cdpGetLogs, cdpGetEvents } from './request-handlers.js';
export { cdpSetMock, cdpGetMocks } from './mock-handlers.js';
export { cdpSendRequest, cdpSendProtocolRequest } from './http-handlers.js';
export { cdpPageScreenshot } from './browser-handlers.js';
export { cdpTabOpen, cdpTabClose, cdpTabList } from './tab-handlers.js';
export {
  cdpPageClick,
  cdpPageType,
  cdpPageScroll,
  cdpPageInspect,
  cdpPageEval,
  cdpPagePress,
  cdpPageWait,
  cdpPageNavigate,
  cdpPageUpload,
  cdpSetDeviceEmulation,
} from './interaction-handlers.js';
export { cdpSetAppProfile } from './app-profile-handlers.js';
export { cdpPageSnapshot, cdpPageFrames } from './snapshot-handlers.js';
export { cdpRunActions, cdpObservedPageAction } from './composite-handlers.js';
export { cdpSetTimezone } from './timezone-handlers.js';
export { cdpGetCookie, cdpSetCookie } from './cookie-handlers.js';
