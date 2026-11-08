import { getEmulationConfigForTab } from '../deviceEmulationState';
import { getDeviceShellForTab } from '../deviceShellRules';
import { getAppProfileForTab } from '../utils/appProfileRules';
import { captureScreenshotViaCDP, type ScreenshotCapture } from './screenshotUtils';

export async function captureVisibleScreenshot(
  tab: chrome.tabs.Tab,
  format: 'png' | 'jpeg',
  quality: number,
): Promise<ScreenshotCapture> {
  if (!tab.active || tab.id === undefined)
    throw new Error('Visible capture requires an active target tab');
  const assertTarget = async () => {
    const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    if (active?.id !== tab.id || active.url !== tab.url) {
      throw new Error('Visible capture target changed; return to the target tab and retry');
    }
  };
  await assertTarget();
  // Emulation already holds a debugger session; its compositor viewport differs from the browser window.
  const [deviceShell, appProfile] = await Promise.all([
    getDeviceShellForTab(tab.id),
    getAppProfileForTab(tab.id),
  ]);
  if (getEmulationConfigForTab(tab.id) || deviceShell || appProfile) {
    const capture = await captureScreenshotViaCDP(tab.id, format, quality, true);
    await assertTarget();
    return capture;
  }
  let paintTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        injectImmediately: true,
        func: () =>
          new Promise<void>(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      }),
      new Promise<void>(resolve => {
        paintTimeout = setTimeout(resolve, 400);
      }),
    ]);
  } finally {
    if (paintTimeout !== undefined) clearTimeout(paintTimeout);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format,
    ...(format === 'jpeg' ? { quality: Math.max(0, Math.min(100, quality)) } : {}),
  });
  await assertTarget();
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    return { dataUrl, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
