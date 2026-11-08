import { beforeEach, expect, it, vi } from 'vitest';
import { getPresetSimulationDefaults } from '../quickAppProfilePreference';
import {
  deleteQuickDeviceSimulationState,
  getRememberedQuickAppProfileForTab,
  getRememberedQuickDeviceSelectionForTab,
  setQuickDeviceSimulationState,
  rememberQuickAppProfileForTab,
} from '../quickDeviceSimulationState';
const mocks = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock('../browserCapabilityRegistry', () => ({
  browserCapabilityRegistry: () => ({ settings: mocks.settings }),
}));
let stored: Record<string, unknown>;
const device = {
  preset: 'iphone-17-pro' as const,
  orientation: 'portrait' as const,
  fitToWindow: true,
  deviceShell: true,
  splitScreen: false,
};
beforeEach(async () => {
  vi.clearAllMocks();
  stored = {};
  chrome.storage.local.get = vi.fn(async () => ({ ...stored }));
  chrome.storage.local.set = vi.fn(async values => {
    Object.assign(stored, values);
  });
  await deleteQuickDeviceSimulationState(1337);
  mocks.settings.mockResolvedValue({
    simulation: { app: 'reader', deviceSelection: device },
    pending: [],
  });
});
it('uses preset defaults for new choices without creating an active tab state or persisting them as user preferences', async () => {
  expect(await getRememberedQuickAppProfileForTab(1337)).toBe('reader');
  expect(await getRememberedQuickDeviceSelectionForTab(1337)).toEqual(device);
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  mocks.settings.mockResolvedValue({ simulation: { app: 'shop' }, pending: [] });
  expect(await getRememberedQuickAppProfileForTab(1337)).toBe('shop');
});
it('preserves existing global and per-tab user choices ahead of updated preset defaults', async () => {
  await setQuickDeviceSimulationState(1337, {
    ...device,
    preset: 'pixel-11',
    orientation: 'landscape',
  });
  await rememberQuickAppProfileForTab(1337, 'chat', { updateGlobalDefault: false });
  expect(await getRememberedQuickAppProfileForTab(1337)).toBe('chat');
  expect(await getRememberedQuickDeviceSelectionForTab(1337)).toMatchObject({
    preset: 'pixel-11',
    orientation: 'landscape',
    splitScreen: false,
  });
  stored.quickLastAppProfile = 'shop';
  expect(await getRememberedQuickAppProfileForTab(1337)).toBe('shop');
  expect(mocks.settings).not.toHaveBeenCalled();
});
it('retains the existing no-preset behavior and rejects corrupt selected settings', async () => {
  mocks.settings.mockResolvedValue({ simulation: {}, pending: [] });
  expect(await getRememberedQuickAppProfileForTab(1337)).toBeUndefined();
  expect(await getRememberedQuickDeviceSelectionForTab(1337)).toBeUndefined();
  mocks.settings.mockRejectedValue(new Error('BUNDLE_INTEGRITY'));
  await expect(getPresetSimulationDefaults()).rejects.toThrow('BUNDLE_INTEGRITY');
  mocks.settings.mockRejectedValue(new ReferenceError('indexedDB is not defined'));
  expect(await getPresetSimulationDefaults()).toEqual({});
});
