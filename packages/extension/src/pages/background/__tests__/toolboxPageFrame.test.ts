import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../deviceShellRules', () => ({ getDeviceShellForTab: vi.fn() }));
vi.mock('../utils/appProfileRules', () => ({ getAppProfileForTab: vi.fn() }));
import { getDeviceShellForTab } from '../deviceShellRules';
import { getAppProfileForTab } from '../utils/appProfileRules';
import { beforeEach } from 'vitest';
import { resolveToolboxPageFrame } from '../toolboxPageFrame';

beforeEach(() => {
  vi.mocked(getDeviceShellForTab).mockResolvedValue({ config: {} } as any);
  vi.mocked(getAppProfileForTab).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
it('uses immediate injection on stopped device-shell documents', async () => {
  const inject = vi.fn().mockResolvedValue([{ frameId: 0, result: null }]);
  vi.stubGlobal('chrome', { scripting: { executeScript: inject } });
  await expect(resolveToolboxPageFrame(7)).resolves.toBe(0);
  expect(inject).toHaveBeenCalledOnce();
  expect(inject).toHaveBeenCalledWith(expect.objectContaining({ injectImmediately: true }));
});
it('matches the interactive WebView by its window position rather than URL or frame name', async () => {
  const inject = vi
    .fn()
    .mockResolvedValueOnce([{ frameId: 0, result: 1 }])
    .mockResolvedValueOnce([
      { frameId: 0, result: null },
      { frameId: 12, result: 0 },
      { frameId: 23, result: 1 },
    ]);
  vi.stubGlobal('chrome', { scripting: { executeScript: inject } });
  await expect(resolveToolboxPageFrame(7)).resolves.toBe(23);
  expect(inject).toHaveBeenLastCalledWith(
    expect.objectContaining({ target: { tabId: 7, allFrames: true }, injectImmediately: true }),
  );
});
it('reports a missing business frame instead of injecting into the device shell', async () => {
  const inject = vi
    .fn()
    .mockResolvedValueOnce([{ frameId: 0, result: 1 }])
    .mockResolvedValueOnce([{ frameId: 0, result: null }]);
  vi.stubGlobal('chrome', { scripting: { executeScript: inject } });
  await expect(resolveToolboxPageFrame(7)).rejects.toThrow('WebView is not ready');
});

it('waits for a business WebView before executing scripts in phone preview', async () => {
  vi.mocked(getDeviceShellForTab).mockResolvedValue({ config: { phoneFrame: { width: 400, height: 800 } } } as any);
  const inject = vi.fn().mockResolvedValue([{ frameId: 0, result: null }]);
  vi.stubGlobal('chrome', { scripting: { executeScript: inject } });
  await expect(resolveToolboxPageFrame(7)).rejects.toThrow('WebView is not ready');
  expect(inject).toHaveBeenCalledOnce();
});

it('uses the top frame on ordinary pages without interpreting page-owned iframe names', async () => {
  vi.mocked(getDeviceShellForTab).mockResolvedValue(null);
  const inject = vi.fn();
  vi.stubGlobal('chrome', { scripting: { executeScript: inject } });
  await expect(resolveToolboxPageFrame(7)).resolves.toBe(0);
  expect(inject).not.toHaveBeenCalled();
});
