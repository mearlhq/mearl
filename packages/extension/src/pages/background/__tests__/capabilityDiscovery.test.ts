import { beforeEach, describe, expect, it, vi } from 'vitest';
const catalog = vi.hoisted(() => ({ getAppProfileCatalog: vi.fn(), protocols: vi.fn() }));
vi.mock('../browserCapabilities', () => ({ prepareBrowserCapabilities: catalog.protocols }));
vi.mock('../appProfileCatalog', () => catalog);
import { handleGetCapabilities } from '../capabilityDiscovery';

beforeEach(() => {
  vi.clearAllMocks();
  catalog.protocols.mockResolvedValue({});
  chrome.tabs = { query: vi.fn(), reload: vi.fn() } as unknown as typeof chrome.tabs;
});
describe('extension capability discovery', () => {
  it('reads the current installed catalog for every query without refreshing plugins or touching a tab', async () => {
    catalog.getAppProfileCatalog.mockResolvedValueOnce({ profiles: [], errors: [] }).mockResolvedValueOnce({ profiles: [], errors: [{ plugin: 'removed', error: 'Unavailable' }] });
    expect((await handleGetCapabilities()).apps.status).toBe('available');
    expect((await handleGetCapabilities()).apps.status).toBe('partial');
    expect(catalog.getAppProfileCatalog).toHaveBeenCalledWith({ refresh: false });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
});

it('keeps browser actions independent of installed App protocol factories', async () => {
  catalog.getAppProfileCatalog.mockResolvedValue({ profiles: [], errors: [] });
  const result = await handleGetCapabilities();
  expect(result.actions).toContain('send_request');
  expect(result.actions).not.toContain('send_protocol_request');
  expect(catalog.protocols).not.toHaveBeenCalled();
});
