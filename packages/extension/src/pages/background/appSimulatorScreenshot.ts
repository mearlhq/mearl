import { handlePageScreenshot } from './agentHandlers/browserHandlers';
import { getDeviceShellForTab } from './deviceShellRules';
import { getAppProfileForTab } from './utils/appProfileRules';

export async function captureAppSimulatorScreenshot(tabId: number) {
  const [config, deviceShell] = await Promise.all([
    getAppProfileForTab(tabId),
    getDeviceShellForTab(tabId),
  ]);
  if (config?.platform !== 'iOS' && deviceShell?.config.platform !== 'ios') {
    throw new Error('iOS device shell is not active for this tab');
  }
  return handlePageScreenshot({ tabId, format: 'png' }, () => null);
}
