import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SERVICE_DEFAULTS_CACHE_KEY } from '../../../shared/externalServices';
const registry = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock('../browserCapabilityRegistry', () => ({ browserCapabilityRegistry: () => registry }));
let services: typeof import('../externalServices');
let storedSession: Record<string, any>;
let preferences: Record<string, boolean>;
beforeEach(async () => {
  vi.resetModules(); registry.settings.mockReset().mockResolvedValue({ services: { requestCasesEnabled: true, accountsEnabled: true } });
  storedSession = {}; preferences = {};
  chrome.storage.session = { get: vi.fn(async () => ({ ...storedSession })), set: vi.fn(async patch => { Object.assign(storedSession, patch); }) } as any;
  chrome.storage.sync = { get: vi.fn(async () => ({ ...preferences })), set: vi.fn(async patch => { Object.assign(preferences, patch); }), remove: vi.fn(async keys => { for (const key of [keys].flat()) delete preferences[key]; }) } as any;
  vi.stubGlobal('fetch', vi.fn());
  services = await import('../externalServices');
});
afterEach(() => vi.unstubAllGlobals());
it('shares one accepted preset read and publishes its service defaults without a network probe', async () => {
  const [first, second, enabled] = await Promise.all([services.refreshExternalServiceDefaults(), services.refreshExternalServiceDefaults(), services.isExternalServiceEnabled('requestCasesEnabled')]);
  expect(first).toEqual(second); expect(enabled).toBe(true);
  expect(registry.settings).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  expect(storedSession[SERVICE_DEFAULTS_CACHE_KEY].services).toEqual({ requestCasesEnabled: true, accountsEnabled: true });
});
it('keeps optional modules disabled when no preset provides defaults', async () => {
  registry.settings.mockResolvedValue({});
  expect(await services.isExternalServiceEnabled('requestCasesEnabled')).toBe(false);
});
it('uses captured defaults without rereading or publishing stale defaults', async () => {
  const settings = { services: { requestCasesEnabled: true } };
  expect(await services.isExternalServiceEnabled('requestCasesEnabled', settings)).toBe(true);
  preferences.requestCasesEnabled = false;
  expect(await services.isExternalServiceEnabled('requestCasesEnabled', settings)).toBe(false);
  expect(await services.isExternalServiceEnabled('accountsEnabled', settings)).toBe(false);
  expect(registry.settings).not.toHaveBeenCalled();
  expect(chrome.storage.session.set).not.toHaveBeenCalled();
});
it.each([true, false])('preserves an explicit %s preference without loading defaults', async enabled => {
  preferences.requestCasesEnabled = enabled;
  expect(await services.isExternalServiceEnabled('requestCasesEnabled')).toBe(enabled);
  expect(registry.settings).not.toHaveBeenCalled();
});
it('applies replacement defaults rather than stale session or worker state', async () => {
  await services.refreshExternalServiceDefaults();
  registry.settings.mockResolvedValue({ services: { requestCasesEnabled: false } });
  vi.resetModules(); services = await import('../externalServices');
  expect(await services.isExternalServiceEnabled('requestCasesEnabled')).toBe(false);
});
it('rechecks a user preference changed while preset defaults were loading', async () => {
  let finish!: (value: unknown) => void;
  registry.settings.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const reading = services.isExternalServiceEnabled('requestCasesEnabled');
  await vi.waitFor(() => expect(finish).toBeDefined());
  preferences.requestCasesEnabled = false; finish({ services: { requestCasesEnabled: true } });
  expect(await reading).toBe(false);
});
it('stores only differences from preset defaults and serializes preference writes', async () => {
  preferences.accountsEnabled = false;
  await Promise.all([services.updateExternalServicePreferences({ accountsEnabled: true, trackingMetadataEnabled: true }), services.updateExternalServicePreferences({ requestCasesEnabled: false })]);
  expect(chrome.storage.sync.remove).toHaveBeenCalledWith(['accountsEnabled']);
  expect(preferences).toEqual({ trackingMetadataEnabled: true, requestCasesEnabled: false });
});
it('retries a failed preset read and does not poison later preference writes', async () => {
  registry.settings.mockRejectedValueOnce(new Error('preset unavailable'));
  await expect(services.updateExternalServicePreferences({ requestCasesEnabled: false })).rejects.toThrow('preset unavailable');
  await services.updateExternalServicePreferences({ requestCasesEnabled: false });
  expect(preferences.requestCasesEnabled).toBe(false);
});
