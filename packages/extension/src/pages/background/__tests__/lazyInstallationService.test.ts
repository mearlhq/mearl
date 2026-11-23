import { beforeEach, expect, it, vi } from 'vitest';

const createInstallationService = vi.hoisted(() => vi.fn());
const createNativeInstallationClient = vi.hoisted(() => vi.fn(() => ({ capture: vi.fn() })));

vi.mock('../installationService', () => ({ createInstallationService }));
vi.mock('../nativeInstallationClient', () => ({ createNativeInstallationClient }));

import { createLazyInstallationService } from '../lazyInstallationService';

beforeEach(() => {
  createInstallationService.mockReset();
  createNativeInstallationClient.mockClear();
});

it('loads the installation implementation once on first use', async () => {
  const installedPresets = vi.fn().mockResolvedValue([{ id: 'default' }]);
  const autoUpdate = vi.fn().mockResolvedValue({ status: 'current' });
  createInstallationService.mockReturnValue({ installedPresets, autoUpdate });
  const bridge = vi.fn();
  const service = createLazyInstallationService(bridge);

  expect(createInstallationService).not.toHaveBeenCalled();
  await expect(service.installedPresets()).resolves.toEqual([{ id: 'default' }]);
  await expect(service.autoUpdate()).resolves.toEqual({ status: 'current' });

  expect(createInstallationService).toHaveBeenCalledTimes(1);
  expect(createNativeInstallationClient).toHaveBeenCalledExactlyOnceWith(bridge);
  expect(installedPresets).toHaveBeenCalledTimes(1);
  expect(autoUpdate).toHaveBeenCalledTimes(1);
});
