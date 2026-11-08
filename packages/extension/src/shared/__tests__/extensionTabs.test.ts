import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDeviceCaptureTab } from '../deviceCapture';
import { openToolboxToolTab } from '../toolboxTab';
import { getConfig, DEFAULT_CONFIG } from '../../pages/panel/utils/config';

vi.mock('../../pages/panel/utils/config', () => ({
  getConfig: vi.fn(),
  DEFAULT_CONFIG: { requestCasesEnabled: false },
}));

describe('extension content tabs', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockResolvedValue({ ...DEFAULT_CONFIG, requestCasesEnabled: true });
    chrome.runtime.getURL = vi.fn(path => `chrome-extension://test/${path}`);
    chrome.tabs = {
      create: vi.fn().mockResolvedValue({ id: 42 }),
    } as unknown as typeof chrome.tabs;
  });

  it('does not open a device capture tab when the combined service is disabled', async () => {
    vi.mocked(getConfig).mockResolvedValue({ ...DEFAULT_CONFIG, requestCasesEnabled: false });
    await openDeviceCaptureTab();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('opens device capture in an active tab', async () => {
    await openDeviceCaptureTab();

    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
      url: 'chrome-extension://test/src/pages/device-capture/index.html',
      active: true,
    });
  });

  it('opens a bookmarkable tool host URL in an active tab', async () => {
    await openToolboxToolTab('plugin:notebook', {
      id: '00000000-0000-4000-8000-000000000001',
    });

    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({
      url: 'chrome-extension://test/plugin/index.html?id=00000000-0000-4000-8000-000000000001#notebook',
      active: true,
    });
  });
});
