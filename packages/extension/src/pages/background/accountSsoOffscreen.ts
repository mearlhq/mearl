import {
  ACCOUNT_CONSUME_SSO_ACTION,
  ACCOUNT_OFFSCREEN_TARGET,
  type AccountConsumeSsoResponse,
} from '../../shared/accountSsoMessages';
import { withOffscreenDocument } from './offscreenDocument';

let offscreenSsoQueue: Promise<void> = Promise.resolve();

async function consumeAccountSso(ssoUrl: string): Promise<boolean> {
  return withOffscreenDocument(async () => {
    const response = (await chrome.runtime.sendMessage({
      target: ACCOUNT_OFFSCREEN_TARGET,
      action: ACCOUNT_CONSUME_SSO_ACTION,
      ssoUrl,
    })) as AccountConsumeSsoResponse | undefined;
    return response?.success === true;
  });
}

export function consumeAccountSsoInOffscreenDocument(ssoUrl: string): Promise<boolean> {
  const task = offscreenSsoQueue.then(() => consumeAccountSso(ssoUrl));
  offscreenSsoQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
