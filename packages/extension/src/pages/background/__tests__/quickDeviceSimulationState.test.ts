import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteQuickDeviceSimulationState,
  disableQuickDeviceSimulationState,
  getRememberedQuickAppProfileForTab,
  getRememberedQuickDeviceSelectionForTab,
  getQuickDeviceSimulationState,
  hydrateQuickDeviceSimulationState,
  listActiveQuickDeviceSimulationTabIds,
  rememberQuickAppProfileForTab,
  setQuickDeviceSimulationState,
} from '../quickDeviceSimulationState';

describe('quickDeviceSimulationState', () => {
  const tabId = 17;
  let localStored: Record<string, unknown>;

  beforeEach(async () => {
    localStored = {};
    chrome.storage.local.get = vi.fn(async () => ({ ...localStored }));
    chrome.storage.local.set = vi.fn(async values => {
      Object.assign(localStored, values);
    });
    await deleteQuickDeviceSimulationState(tabId);
  });

  it('does not create a default selection', async () => {
    expect(getQuickDeviceSimulationState(tabId)).toBeUndefined();
    await expect(disableQuickDeviceSimulationState(tabId)).resolves.toBeUndefined();
    expect(getQuickDeviceSimulationState(tabId)).toBeUndefined();
  });

  it('stores an enabled fixed-device selection', async () => {
    const state = await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-17-pro',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
    });

    expect(state).toEqual({
      enabled: true,
      preset: 'iphone-17-pro',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(getQuickDeviceSimulationState(tabId)).toEqual(state);
  });

  it('stores an enabled adaptive selection', async () => {
    await setQuickDeviceSimulationState(tabId, {
      preset: 'android-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
    });

    expect(getQuickDeviceSimulationState(tabId)).toEqual({
      enabled: true,
      preset: 'android-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      fixedFitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('disables simulation while remembering the selection', async () => {
    await setQuickDeviceSimulationState(tabId, {
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
    });

    const state = await disableQuickDeviceSimulationState(tabId);

    expect(state).toEqual({
      enabled: false,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      fixedFitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(getQuickDeviceSimulationState(tabId)).toEqual(state);
    await expect(listActiveQuickDeviceSimulationTabIds()).resolves.not.toContain(tabId);
  });

  it('persists a disabled split-screen preference with the tab selection', async () => {
    await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-17-pro',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });

    await disableQuickDeviceSimulationState(tabId);

    expect(getQuickDeviceSimulationState(tabId)).toMatchObject({
      enabled: false,
      orientation: 'landscape',
      splitScreen: false,
    });
  });

  it('preserves the fixed-device fit preference while an adaptive preset is active', async () => {
    await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
    });

    await setQuickDeviceSimulationState(tabId, {
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
    });

    expect(getQuickDeviceSimulationState(tabId)).toMatchObject({
      preset: 'ios-adaptive',
      fitToWindow: false,
      fixedFitToWindow: false,
    });
  });

  it('keeps the last App profile when simulation is disabled', async () => {
    await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
    });
    await rememberQuickAppProfileForTab(tabId, 'chat');

    const state = await disableQuickDeviceSimulationState(tabId);

    expect(state).toMatchObject({
      enabled: false,
      lastAppProfile: 'chat',
      preset: 'iphone-17-pro',
    });
  });

  it('uses the global last App profile as the default for a new tab', async () => {
    const newTabId = tabId + 100;
    await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
    });
    await rememberQuickAppProfileForTab(tabId, 'chat');

    await expect(getRememberedQuickAppProfileForTab(newTabId)).resolves.toBe('chat');

    await deleteQuickDeviceSimulationState(newTabId);
  });

  it('uses global App and device defaults without sharing tab state', async () => {
    const otherTabId = tabId + 200;
    await setQuickDeviceSimulationState(otherTabId, {
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
    });
    await rememberQuickAppProfileForTab(otherTabId, 'shop');
    await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-duo-unfolded',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: true,
    });
    await rememberQuickAppProfileForTab(tabId, 'chat');

    await expect(getRememberedQuickAppProfileForTab(otherTabId)).resolves.toBe('chat');
    await expect(getRememberedQuickDeviceSelectionForTab(otherTabId)).resolves.toEqual({
      preset: 'iphone-duo-unfolded',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(getQuickDeviceSimulationState(otherTabId)).toMatchObject({
      enabled: true,
      preset: 'iphone-17-pro',
    });
    expect(localStored.quickLastDeviceSelection).toEqual({
      preset: 'iphone-duo-unfolded',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });

    expect(getQuickDeviceSimulationState(tabId)?.splitScreen).toBe(true);
    localStored.quickLastDeviceSelection = {
      ...(localStored.quickLastDeviceSelection as object),
      splitScreen: true,
    };
    await expect(getRememberedQuickDeviceSelectionForTab(otherTabId)).resolves.toMatchObject({
      splitScreen: false,
    });
    await expect(disableQuickDeviceSimulationState(tabId)).resolves.toMatchObject({
      splitScreen: false,
    });

    await deleteQuickDeviceSimulationState(otherTabId);
  });

  it('initializes the global device default from an existing tab selection', async () => {
    const legacyTabId = tabId + 300;
    const persistLocal = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn().mockResolvedValue(undefined);
    await setQuickDeviceSimulationState(legacyTabId, {
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
      splitScreen: true,
    });
    chrome.storage.local.set = persistLocal;

    await expect(getRememberedQuickDeviceSelectionForTab(legacyTabId)).resolves.toEqual({
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
      splitScreen: false,
    });
    expect(localStored.quickLastDeviceSelection).toEqual({
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
      splitScreen: false,
    });

    await deleteQuickDeviceSimulationState(legacyTabId);
  });

  it('updates tab state without replacing the global defaults', async () => {
    const otherTabId = tabId + 400;
    await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-duo-unfolded',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: true,
    });
    await rememberQuickAppProfileForTab(tabId, 'chat');

    await setQuickDeviceSimulationState(
      otherTabId,
      {
        preset: 'pixel-11',
        orientation: 'portrait',
        fitToWindow: false,
        deviceShell: false,
        splitScreen: false,
      },
      { updateGlobalDefault: false },
    );
    await rememberQuickAppProfileForTab(otherTabId, 'shop', {
      updateGlobalDefault: false,
    });

    expect(getQuickDeviceSimulationState(otherTabId)).toMatchObject({
      enabled: true,
      lastAppProfile: 'shop',
      preset: 'pixel-11',
    });
    await expect(getRememberedQuickAppProfileForTab(otherTabId)).resolves.toBe('chat');
    await expect(getRememberedQuickDeviceSelectionForTab(otherTabId)).resolves.toMatchObject({
      preset: 'iphone-duo-unfolded',
    });

    await deleteQuickDeviceSimulationState(otherTabId);
  });

  it('re-enables and overwrites a remembered selection', async () => {
    await setQuickDeviceSimulationState(tabId, {
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
    });
    await disableQuickDeviceSimulationState(tabId);

    const state = await setQuickDeviceSimulationState(tabId, {
      preset: 'pixel-11',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
    });

    expect(state).toEqual({
      enabled: true,
      preset: 'pixel-11',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(getQuickDeviceSimulationState(tabId)).toEqual(state);
  });

  it('deletes all state for a tab without affecting other tabs', async () => {
    await setQuickDeviceSimulationState(tabId, {
      preset: 'iphone-17e',
      orientation: 'portrait',
      fitToWindow: true,
    });
    await setQuickDeviceSimulationState(tabId + 1, {
      preset: 'android-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      deviceShell: true,
    });

    await deleteQuickDeviceSimulationState(tabId);

    expect(getQuickDeviceSimulationState(tabId)).toBeUndefined();
    expect(getQuickDeviceSimulationState(tabId + 1)).toEqual({
      enabled: true,
      preset: 'android-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      fixedFitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    await expect(listActiveQuickDeviceSimulationTabIds()).resolves.toContain(tabId + 1);

    await deleteQuickDeviceSimulationState(tabId + 1);
  });

  it('restores a validated selection from session storage after worker startup', async () => {
    const restoredTabId = 917;
    const key = `quickDeviceSimulationState:${restoredTabId}`;
    const originalSession = chrome.storage.session;
    chrome.storage.session = {
      get: vi.fn().mockResolvedValue({
        [key]: {
          enabled: true,
          lastAppProfile: 'chat',
          preset: 'galaxy-s26',
          orientation: 'landscape',
          fitToWindow: true,
        },
      }),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.storage.session;

    try {
      await hydrateQuickDeviceSimulationState(restoredTabId);

      expect(getQuickDeviceSimulationState(restoredTabId)).toEqual({
        enabled: true,
        lastAppProfile: 'chat',
        preset: 'galaxy-s26',
        orientation: 'landscape',
        fitToWindow: true,
        deviceShell: true,
        splitScreen: false,
      });
    } finally {
      await deleteQuickDeviceSimulationState(restoredTabId);
      chrome.storage.session = originalSession;
    }
  });
});
