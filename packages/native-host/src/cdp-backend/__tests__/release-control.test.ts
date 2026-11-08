import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../controlled-indicator.js', () => ({
  releaseControlledIndicator: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../mock-handlers.js', () => ({
  clearCdpMockState: vi.fn(),
}));
vi.mock('../fetch-interceptor.js', () => ({
  clearCdpFetchInterceptionState: vi.fn(),
}));
vi.mock('../network-control.js', () => ({
  clearCdpNetworkControlState: vi.fn(),
}));
vi.mock('../app-profile-handlers.js', () => ({
  clearCdpAppProfile: vi.fn().mockResolvedValue({ enabled: false, reloaded: false }),
}));
vi.mock('../device-shell.js', () => ({
  clearCdpDeviceShell: vi.fn().mockResolvedValue(false),
}));

import { releaseControlledIndicator } from '../controlled-indicator.js';
import { clearCdpMockState } from '../mock-handlers.js';
import { clearCdpFetchInterceptionState } from '../fetch-interceptor.js';
import { clearCdpNetworkControlState } from '../network-control.js';
import { clearCdpAppProfile } from '../app-profile-handlers.js';
import { clearCdpDeviceShell } from '../device-shell.js';
import { releaseCdpControl } from '../release-control.js';
import type { CdpSession, PageSession } from '../cdp-session.js';

describe('CDP browser control release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tears down page state and closes only the CDP session', async () => {
    const pages = [
      {
        targetId: 'target-a',
        client: { sendCommand: vi.fn().mockResolvedValue({}) },
        buffers: {},
        url: 'https://a.test',
      },
      {
        targetId: 'target-b',
        client: { sendCommand: vi.fn().mockResolvedValue({}) },
        buffers: {},
        url: 'https://b.test',
      },
    ] as PageSession[];
    vi.mocked(clearCdpDeviceShell).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const close = vi.fn();
    const session = {
      listOpenPageSessions: vi.fn(() => pages),
      listRegisteredTabIds: vi.fn(() => [1002, 1001]),
      hasActiveConnections: vi.fn(() => true),
      close,
    } as unknown as CdpSession;

    await expect(releaseCdpControl(session)).resolves.toEqual({
      released: true,
      hadActiveControl: true,
      affectedTabIds: [1001, 1002],
    });

    expect(clearCdpAppProfile).toHaveBeenCalledTimes(2);
    expect(clearCdpDeviceShell).toHaveBeenCalledTimes(2);
    expect(releaseControlledIndicator).toHaveBeenCalledTimes(2);
    expect(pages[0].client.sendCommand).toHaveBeenCalledWith('Page.reload', {});
    expect(pages[1].client.sendCommand).not.toHaveBeenCalledWith('Page.reload', {});
    expect(clearCdpMockState).toHaveBeenCalledOnce();
    expect(clearCdpNetworkControlState).toHaveBeenCalledWith(pages);
    expect(clearCdpFetchInterceptionState).toHaveBeenCalledWith(pages);
    expect(close).toHaveBeenCalledOnce();
  });
});
