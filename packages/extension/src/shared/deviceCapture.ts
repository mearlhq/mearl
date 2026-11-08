import { getConfig } from '../pages/panel/utils/config';
import { openExtensionTab } from './extensionTab';

/** 在新标签页中打开真机抓包页面。 */
export async function openDeviceCaptureTab(): Promise<void> {
  if (!(await getConfig()).requestCasesEnabled) return;
  const deviceCaptureUrl = chrome.runtime.getURL('src/pages/device-capture/index.html');
  await openExtensionTab(deviceCaptureUrl);
}
