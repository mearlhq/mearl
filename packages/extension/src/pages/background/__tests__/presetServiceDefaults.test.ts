import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ services: {} as Record<string, boolean>, preferences: {} as Record<string, unknown>, session: {} as Record<string, any>, error: undefined as Error | undefined }));
vi.mock('../browserCapabilityRegistry', () => ({ browserCapabilityRegistry: () => ({ settings: async () => { if (fixture.error) throw fixture.error; return { services: fixture.services }; } }) }));
import { refreshExternalServiceDefaults, isExternalServiceEnabled, updateBrowserServicePreferences, updateExternalServicePreferences } from '../externalServices';
import { SERVICE_DEFAULTS_CACHE_KEY, resolveExternalServices } from '../../../shared/externalServices';
beforeEach(() => {
  fixture.services = {}; fixture.preferences = {}; fixture.session = {}; fixture.error = undefined;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Service defaults must not probe a network'); }));
  vi.stubGlobal('chrome', { storage: {
    sync: { get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(fixture.preferences, key)).map(key => [key, fixture.preferences[key]]))), set: vi.fn(async (values: any) => { Object.assign(fixture.preferences, values); }), remove: vi.fn(async (keys: string | string[]) => { for (const key of [keys].flat()) delete fixture.preferences[key]; }) },
    session: { get: vi.fn(async () => fixture.session), set: vi.fn(async (value: any) => { Object.assign(fixture.session, value); }) },
  } });
});
it('uses inherited installed defaults without network probing or creating user preferences', async () => {
  fixture.services = { accountsEnabled: true, customEnabled: false };
  const cache = await refreshExternalServiceDefaults();
  expect(cache.services).toEqual(fixture.services);
  expect(resolveExternalServices({}, cache).accountsEnabled).toBe(true);
  expect(await isExternalServiceEnabled('accountsEnabled')).toBe(true);
  expect(await isExternalServiceEnabled('customEnabled')).toBe(false);
  expect(fixture.preferences).toEqual({});
  expect(fetch).not.toHaveBeenCalled();
  expect(fixture.session[SERVICE_DEFAULTS_CACHE_KEY].services).toEqual(fixture.services);
});
it('preserves explicit choices when the installed defaults change', async () => {
  fixture.services = { accountsEnabled: true }; fixture.preferences = { accountsEnabled: false };
  expect(await isExternalServiceEnabled('accountsEnabled')).toBe(false);
  fixture.services = { accountsEnabled: false }; fixture.preferences.accountsEnabled = true;
  expect(await isExternalServiceEnabled('accountsEnabled')).toBe(true);
});
it('removes a redundant override only when that preference is explicitly changed', async () => {
  fixture.services = { accountsEnabled: true }; fixture.preferences = { accountsEnabled: false, requestCasesEnabled: true };
  await updateExternalServicePreferences({ accountsEnabled: true });
  expect(fixture.preferences).toEqual({ requestCasesEnabled: true });
  fixture.services.accountsEnabled = false;
  await updateExternalServicePreferences({ accountsEnabled: true });
  expect(fixture.preferences).toEqual({ requestCasesEnabled: true, accountsEnabled: true });
});
it('retains explicit choices while an unavailable defaults graph is reported as an error', async () => {
  fixture.preferences = { customEnabled: true }; fixture.error = new Error('Installed defaults are unavailable');
  expect(await isExternalServiceEnabled('customEnabled')).toBe(true);
  await expect(isExternalServiceEnabled('unknownEnabled')).rejects.toThrow('Installed defaults are unavailable');
  expect(fixture.preferences).toEqual({ customEnabled: true });
  expect(fixture.session).toEqual({});
});

it('reads canonical service choices without importing obsolete preference keys', async () => {
  fixture.services = { accountsEnabled: true };
  fixture.preferences = { oldAccountsEnabled: false };
  expect(await isExternalServiceEnabled('accountsEnabled')).toBe(true);
  expect(fixture.preferences).toEqual({ oldAccountsEnabled: false });
  await updateBrowserServicePreferences({ accountsEnabled: false });
  expect(fixture.preferences.accountsEnabled).toBe(false);
});

it.each(['custom_metadataEnabled', 'custom-metadataEnabled'])('keeps the existing custom request setting contract: %s', async key => {
  fixture.services = { [key]: true };
  await updateBrowserServicePreferences({ [key]: false });
  expect(fixture.preferences[key]).toBe(false);
  await updateBrowserServicePreferences({ [key]: true });
  expect(fixture.preferences[key]).toBeUndefined();
});
