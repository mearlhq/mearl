import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, onConfigChange, updateConfig } from '../config';
import {
  EXTERNAL_SERVICE_UPDATE_ACTION,
  SERVICE_DEFAULTS_CACHE_KEY,
  SERVICE_DEFAULTS_REFRESH_ACTION,
} from '../../../../shared/externalServices';

vi.mock('../browserRequestUiState', async () => {
  const { requestUiFixture } = await import('../../../../test/fixtures/requestUi');
  const state = { selected: { bundleId: 'metadata-fixture', revision: 'a'.repeat(64), definition: requestUiFixture }, definition: requestUiFixture };
  return { getBrowserRequestUiState: () => state, ensureBrowserRequestUiState: async () => state, subscribeBrowserRequestUi: () => () => {}, updateBrowserRequestUiPreference: vi.fn() };
});

let preferences: Record<string, unknown>;
let cache: unknown;
let listener: (
  changes: Record<string, chrome.storage.StorageChange>,
  area: 'sync' | 'local' | 'managed' | 'session',
) => void;

beforeEach(() => {
  preferences = {};
  cache = undefined;
  chrome.storage.sync = {
    get: vi.fn((defaults, callback) => callback({ ...defaults, ...preferences })),
    set: vi.fn((values, callback) => {
      Object.assign(preferences, values);
      callback();
    }),
  } as any;
  chrome.storage.session = {
    get: vi.fn(async () => ({ [SERVICE_DEFAULTS_CACHE_KEY]: cache })),
  } as any;
  vi.mocked(chrome.storage.onChanged.addListener).mockImplementation(callback => {
    listener = callback;
  });
  vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue({ success: true });
});

describe('resolved extension config', () => {
  it('returns safe defaults without waiting for the background defaults refresh', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(() => {}));
    const config = await getConfig();
    expect(config.requestCasesEnabled).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: SERVICE_DEFAULTS_REFRESH_ACTION });
    expect(chrome.storage.sync.get).toHaveBeenCalledWith(
      expect.objectContaining({
        accountsEnabled: null,
        requestCasesEnabled: null,
        requestMetadataEnabled: null,
      }),
      expect.any(Function),
    );
  });

  it('defaults foreground prevention on while preserving an explicit opt-out', async () => {
    expect((await getConfig()).agentPreventForeground).toBe(true);
    preferences = { agentPreventForeground: false };
    expect((await getConfig()).agentPreventForeground).toBe(false);
  });

  it('reads fresh defaults and existing user preferences', async () => {
    cache = {  services: { accountsEnabled: true, requestCasesEnabled: true, requestMetadataEnabled: true, requestImportEnabled: true, trackingMetadataEnabled: true }};
    preferences = { accountsEnabled: false, cloudServerUrl: 'wss://example.com' };
    expect(await getConfig()).toEqual(
      expect.objectContaining({
        accountsEnabled: false,
        requestCasesEnabled: true,
        requestMetadataEnabled: true,
        requestImportEnabled: true,
        trackingMetadataEnabled: true,
        cloudServerUrl: 'wss://example.com',
      }),
    );
  });

  it('keeps cached modules enabled during bootstrap and subscription until the defaults refresh completes', async () => {
    cache = {  services: { accountsEnabled: true, requestCasesEnabled: true, requestMetadataEnabled: true, requestImportEnabled: true, trackingMetadataEnabled: true }};
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(() => {}));
    expect((await getConfig()).accountsEnabled).toBe(true);
    const callback = vi.fn();
    const unsubscribe = onConfigChange(callback);
    try {
      await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
      expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ accountsEnabled: true }));
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
      expect(callback.mock.calls.every(([config]) => config.accountsEnabled)).toBe(true);

      cache = { };
      listener({ [SERVICE_DEFAULTS_CACHE_KEY]: { newValue: cache } }, 'session');
      await vi.waitFor(() =>
        expect(callback).toHaveBeenLastCalledWith(
          expect.objectContaining({ accountsEnabled: false }),
        ),
      );
    } finally {
      unsubscribe();
    }
  });

  it('routes only service fields to the background and writes other changed fields directly', async () => {
    await updateConfig({ requestCasesEnabled: true, language: 'en' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: EXTERNAL_SERVICE_UPDATE_ACTION,
      patch: { requestCasesEnabled: true },
    });
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ language: 'en' }, expect.any(Function));
  });

  it('resolves a removed preference using the network default and listens for cache changes', async () => {
    const callback = vi.fn();
    const unsubscribe = onConfigChange(callback);
    try {
      cache = {  services: { accountsEnabled: true, requestCasesEnabled: true, requestMetadataEnabled: true, requestImportEnabled: true, trackingMetadataEnabled: true }};
      listener({ requestCasesEnabled: { oldValue: false } }, 'sync');
      await vi.waitFor(() =>
        expect(callback).toHaveBeenLastCalledWith({
          accountsEnabled: true,
          requestCasesEnabled: true,
          requestMetadataEnabled: true,
          requestImportEnabled: true,
          trackingMetadataEnabled: true,
        }),
      );
      cache = { };
      preferences.requestMetadataEnabled = true;
      listener({ [SERVICE_DEFAULTS_CACHE_KEY]: { newValue: cache } }, 'session');
      await vi.waitFor(() =>
        expect(callback).toHaveBeenLastCalledWith({
          accountsEnabled: false,
          requestCasesEnabled: false,
          requestMetadataEnabled: true,
          requestImportEnabled: false,
          trackingMetadataEnabled: false,
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it('preserves ordinary config notifications and refreshes defaults on focus', async () => {
    const callback = vi.fn();
    const unsubscribe = onConfigChange(callback);
    try {
      listener(
        { cloudServerUrl: { newValue: 'wss://example.com' }, language: { newValue: 'en' } },
        'sync',
      );
      expect(callback).toHaveBeenCalledWith({
        cloudServerUrl: 'wss://example.com',
        language: 'en',
      });
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          action: SERVICE_DEFAULTS_REFRESH_ACTION,
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it('picks up defaults published before a page subscribed', async () => {
    cache = {  services: { accountsEnabled: true, requestCasesEnabled: true, requestMetadataEnabled: true, requestImportEnabled: true, trackingMetadataEnabled: true }};
    const callback = vi.fn();
    const unsubscribe = onConfigChange(callback);
    try {
      await vi.waitFor(() =>
        expect(callback).toHaveBeenCalledWith({
          accountsEnabled: true,
          requestCasesEnabled: true,
          requestMetadataEnabled: true,
          requestImportEnabled: true,
          trackingMetadataEnabled: true,
        }),
      );
    } finally {
      unsubscribe();
    }
  });
});
