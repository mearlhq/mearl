import { initializeBrowserFollowFetch } from './browserFollowFetch';
import { initializeBrowserPureOffscreen } from './browserPureCapabilities';
import {
  ACCOUNT_CONSUME_SSO_ACTION,
  ACCOUNT_OFFSCREEN_TARGET,
  type AccountConsumeSsoRequest,
} from '../../shared/accountSsoMessages';
import { consumeAccountSsoTicket } from './accountSsoFrame';
import { initializeBrowserControllersOffscreen } from './browserControllers';
import { holdOffscreenDocument } from './offscreenLeases';
import { initializeBrowserCapabilityOffscreen } from './browserCapabilities';

initializeBrowserCapabilityOffscreen();
initializeBrowserControllersOffscreen();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<AccountConsumeSsoRequest>;
  if (
    request.target !== ACCOUNT_OFFSCREEN_TARGET ||
    request.action !== ACCOUNT_CONSUME_SSO_ACTION ||
    typeof request.ssoUrl !== 'string'
  ) {
    return undefined;
  }

  const release = holdOffscreenDocument();
  void consumeAccountSsoTicket(request.ssoUrl)
    .then(success => sendResponse({ success }))
    .catch(() => sendResponse({ success: false }))
    .finally(release);
  return true;
});

initializeBrowserPureOffscreen();

initializeBrowserFollowFetch();
