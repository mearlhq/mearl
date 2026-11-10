import { expect, it, vi } from 'vitest';
import { grantPresetOrigins, missingPresetPermissions } from '../presetPermissions';

it('retains host authorization without browser grants and stays pending until Chrome grants access', async () => {
  const storage: Record<string, unknown> = {
    proxyCookieAllowedOrigins: [],
    disabledBuiltinProxyCookieOrigins: ['*://accounts.example/*'],
  };
  chrome.storage.sync = {
    get: vi.fn((keys: string[], callback: (items: Record<string, unknown>) => void) => {
      callback(Object.fromEntries(keys.map(key => [key, storage[key]])));
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(storage, items);
      callback?.();
    }),
  } as unknown as typeof chrome.storage.sync;
  const contains = vi.fn(async () => false);
  chrome.permissions = { contains } as unknown as typeof chrome.permissions;
  const origins = ['https://accounts.example/*'];
  await grantPresetOrigins(origins);
  expect(storage.proxyCookieAllowedOrigins).toEqual(['*://accounts.example/*']);
  expect(storage.disabledBuiltinProxyCookieOrigins).toEqual([]);
  expect(await missingPresetPermissions(origins)).toEqual({
    missingOrigins: origins,
    missingAuthorization: [],
  });
  contains.mockResolvedValue(true);
  expect(await missingPresetPermissions(origins)).toEqual({
    missingOrigins: [],
    missingAuthorization: [],
  });
});
