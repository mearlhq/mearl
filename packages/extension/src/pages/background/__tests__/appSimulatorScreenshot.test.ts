import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAppProfileForTab: vi.fn(),
  getDeviceShellForTab: vi.fn(),
  handlePageScreenshot: vi.fn(),
}));

vi.mock('../utils/appProfileRules', () => ({
  getAppProfileForTab: mocks.getAppProfileForTab,
}));

vi.mock('../deviceShellRules', () => ({
  getDeviceShellForTab: mocks.getDeviceShellForTab,
}));

vi.mock('../agentHandlers/browserHandlers', () => ({
  handlePageScreenshot: mocks.handlePageScreenshot,
}));

import { captureAppSimulatorScreenshot } from '../appSimulatorScreenshot';

describe('App 模拟截图', () => {
  beforeEach(() => {
    mocks.getAppProfileForTab.mockReset();
    mocks.getDeviceShellForTab.mockReset().mockResolvedValue(null);
    mocks.handlePageScreenshot.mockReset();
  });

  it('复用页面截图链路捕获当前 iOS 模拟页', async () => {
    mocks.getAppProfileForTab.mockResolvedValue({ platform: 'iOS' });
    mocks.handlePageScreenshot.mockResolvedValue({
      meta: { format: 'png', width: 1179, height: 2556 },
      data: 'AQID',
    });

    await expect(captureAppSimulatorScreenshot(7)).resolves.toMatchObject({ data: 'AQID' });
    expect(mocks.handlePageScreenshot).toHaveBeenCalledWith(
      { tabId: 7, format: 'png' },
      expect.any(Function),
    );
  });

  it('纯 iOS 设备外壳也可复用截图链路', async () => {
    mocks.getAppProfileForTab.mockResolvedValue(undefined);
    mocks.getDeviceShellForTab.mockResolvedValue({ config: { platform: 'ios' } });
    mocks.handlePageScreenshot.mockResolvedValue({ data: 'AQID' });

    await expect(captureAppSimulatorScreenshot(7)).resolves.toMatchObject({ data: 'AQID' });
  });

  it('拒绝非 iOS 设备模拟页的页内请求', async () => {
    mocks.getAppProfileForTab.mockResolvedValue({ platform: 'Android' });

    await expect(captureAppSimulatorScreenshot(7)).rejects.toThrow(
      'iOS device shell is not active for this tab',
    );
    expect(mocks.handlePageScreenshot).not.toHaveBeenCalled();
  });
});
