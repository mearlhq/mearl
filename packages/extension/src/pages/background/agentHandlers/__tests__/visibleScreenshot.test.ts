import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../deviceEmulationState', () => ({ getEmulationConfigForTab: vi.fn() }));
vi.mock('../../deviceShellRules', () => ({ getDeviceShellForTab: vi.fn() }));
vi.mock('../../utils/appProfileRules', () => ({ getAppProfileForTab: vi.fn() }));
vi.mock('../screenshotUtils', () => ({ captureScreenshotViaCDP: vi.fn() }));
import { getEmulationConfigForTab } from '../../deviceEmulationState';
import { getDeviceShellForTab } from '../../deviceShellRules';
import { getAppProfileForTab } from '../../utils/appProfileRules';
import { captureScreenshotViaCDP } from '../screenshotUtils';
import { captureVisibleScreenshot } from '../visibleScreenshot';

const tab = { id: 7, active: true, windowId: 3, url: 'https://example.test/' } as chrome.tabs.Tab;
let query: ReturnType<typeof vi.fn>,
  capture: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>,
  inject: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(getEmulationConfigForTab).mockReturnValue(undefined);
  vi.mocked(getDeviceShellForTab).mockResolvedValue(null);
  vi.mocked(getAppProfileForTab).mockResolvedValue(undefined);
  vi.mocked(captureScreenshotViaCDP).mockReset();
  query = vi.fn().mockResolvedValue([tab]);
  capture = vi.fn().mockResolvedValue('data:image/png;base64,AQID');
  close = vi.fn();
  inject = vi.fn().mockResolvedValue([{ result: null }]);
  vi.stubGlobal('chrome', {
    tabs: { query, captureVisibleTab: capture },
    scripting: { executeScript: inject },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => new Blob() }));
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 640, height: 480, close }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('captures the target window and reports actual image dimensions', async () => {
  expect(await captureVisibleScreenshot(tab, 'png', 80)).toMatchObject({ width: 640, height: 480 });
  expect(capture).toHaveBeenCalledWith(3, { format: 'png' });
  expect(close).toHaveBeenCalledOnce();
});
it('rejects inactive targets and tab switches before or during capture', async () => {
  await expect(captureVisibleScreenshot({ ...tab, active: false }, 'png', 80)).rejects.toThrow(
    'active target',
  );
  query.mockResolvedValueOnce([{ ...tab, id: 8 }]);
  await expect(captureVisibleScreenshot(tab, 'png', 80)).rejects.toThrow('target changed');
  expect(capture).not.toHaveBeenCalled();
  query
    .mockResolvedValueOnce([tab])
    .mockResolvedValueOnce([{ ...tab, url: 'https://other.test/' }]);
  await expect(captureVisibleScreenshot(tab, 'png', 80)).rejects.toThrow('target changed');
});

it('bounds paint waiting in the host when background-page animation frames are paused', async () => {
  vi.useFakeTimers();
  inject.mockReturnValue(new Promise(() => {}));
  const result = captureVisibleScreenshot(tab, 'png', 80);
  await vi.advanceTimersByTimeAsync(399);
  expect(capture).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toMatchObject({ width: 640, height: 480 });
});

it('uses the emulation compositor and business viewport when a device shell is active', async () => {
  vi.mocked(getDeviceShellForTab).mockResolvedValue({
    config: {},
    emulation: {},
    splitScreen: false,
  } as any);
  vi.mocked(captureScreenshotViaCDP).mockResolvedValue({
    dataUrl: 'data:image/png;base64,AQID',
    width: 1206,
    height: 2436,
  });
  await expect(captureVisibleScreenshot(tab, 'png', 80)).resolves.toMatchObject({
    width: 1206,
    height: 2436,
  });
  expect(captureScreenshotViaCDP).toHaveBeenCalledWith(7, 'png', 80, true);
  expect(capture).not.toHaveBeenCalled();
});
