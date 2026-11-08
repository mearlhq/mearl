import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
  ALL_URLS_ORIGIN,
  isAgentDomainAuthorized,
  requestAgentAllDomainsPermission,
  grantAgentOriginPermission,
  PROXY_PERMISSION_STORAGE_KEY,
} from '../proxyPermissions';

describe('agent proxy permissions', () => {
  const storage: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];

    chrome.storage.sync = {
      get: vi.fn((keys: string[], callback: (items: Record<string, unknown>) => void) => {
        callback(Object.fromEntries(keys.map(key => [key, storage[key]])));
      }),
      set: vi.fn((_items, callback) => callback()),
    } as unknown as typeof chrome.storage.sync;
    chrome.permissions = {
      request: vi.fn((_permissions, callback) => callback(true)),
    } as unknown as typeof chrome.permissions;
  });

  it('authorizes any domain when all-domain access is enabled', async () => {
    storage[AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY] = true;

    await expect(isAgentDomainAuthorized('example.net')).resolves.toBe(true);
  });

  it('keeps the configured domain allowlist when all-domain access is disabled', async () => {
    storage[AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY] = false;

    storage[PROXY_PERMISSION_STORAGE_KEY] = ['*://*.allowed.example/*'];
    await expect(isAgentDomainAuthorized('item.allowed.example')).resolves.toBe(true);
    await expect(isAgentDomainAuthorized('example.net')).resolves.toBe(false);
  });

  it('requests the optional all-URLs browser permission', async () => {
    await expect(requestAgentAllDomainsPermission()).resolves.toBe(true);

    expect(chrome.permissions.request).toHaveBeenCalledWith(
      { origins: [ALL_URLS_ORIGIN] },
      expect.any(Function),
    );
  });

  it('stores a granted domain only after browser approval', async () => {
    storage[PROXY_PERMISSION_STORAGE_KEY] = ['*://*.existing.test/*'];
    let finish!: (granted: boolean) => void;
    vi.mocked(chrome.permissions.request).mockImplementation((_permissions, callback) => {
      finish = callback!;
    });
    const result = grantAgentOriginPermission('*://*.example.com/*');
    expect(chrome.permissions.request).toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    finish(true);
    await expect(result).resolves.toBe(true);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(
      {
        [PROXY_PERMISSION_STORAGE_KEY]: ['*://*.existing.test/*', '*://*.example.com/*'],
      },
      expect.any(Function),
    );
  });

  it('does not store browser-denied permissions or duplicate existing origins', async () => {
    vi.mocked(chrome.permissions.request).mockImplementationOnce((_permissions, callback) =>
      callback!(false),
    );
    await expect(grantAgentOriginPermission('*://*.example.com/*')).resolves.toBe(false);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    storage[PROXY_PERMISSION_STORAGE_KEY] = ['*://*.example.com/*'];
    await expect(grantAgentOriginPermission('*://*.example.com/*')).resolves.toBe(true);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
