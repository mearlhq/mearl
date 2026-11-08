import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeQuickSimulationContextMenu } from '../quickSimulationContextMenu';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  presetChange: vi.fn(),
  restoreDevice: vi.fn(),
  device: vi.fn(),
  app: vi.fn(),
  remembered: vi.fn(),
  enable: vi.fn(),
  permission: vi.fn(),
}));
vi.mock('../appProfileCatalog', () => ({ getAppProfileCatalog: mocks.catalog }));
vi.mock('../browserCapabilityRegistry', () => ({ onBrowserPresetChange: mocks.presetChange }));
vi.mock('../quickDeviceEmulation', () => ({
  getQuickDeviceEmulationState: mocks.device,
  restoreQuickDeviceEmulationForTab: mocks.restoreDevice,
}));
vi.mock('../utils/appProfileRules', () => ({ getAppProfileForTab: mocks.app }));
vi.mock('../quickDeviceSimulationState', () => ({ getRememberedQuickAppProfileForTab: mocks.remembered }));
vi.mock('../quickSimulationAutoRules', () => ({ setQuickAppSimulationWithAutoRuleSync: mocks.enable }));
vi.mock('../agentHandlers/permissionHandlers', () => ({ handleRequestPermission: mocks.permission }));

const url = 'https://example.com/page';
let click: Parameters<typeof chrome.contextMenus.onClicked.addListener>[0];
let registered: boolean;

beforeEach(() => {
  vi.resetAllMocks();
  registered = false;
  mocks.catalog.mockResolvedValue({ profiles: [] });
  mocks.device.mockReturnValue({ active: false });
  chrome.runtime.onInstalled = { addListener: vi.fn() } as unknown as typeof chrome.runtime.onInstalled;
  chrome.i18n = { getMessage: vi.fn(key => key) } as unknown as typeof chrome.i18n;
  chrome.contextMenus = {
    create: vi.fn(() => {
      registered = true;
      return 'enableQuickSimulation';
    }),
    remove: vi.fn(() => { registered = false; }),
    update: vi.fn((_id, _properties, callback) => {
      if (!registered) chrome.runtime.lastError = { message: 'Missing menu' };
      callback?.();
      chrome.runtime.lastError = undefined;
    }),
    onClicked: { addListener: vi.fn(listener => { click = listener; }) },
  } as unknown as typeof chrome.contextMenus;
  chrome.tabs = { get: vi.fn().mockResolvedValue({ url }) } as unknown as typeof chrome.tabs;
  chrome.permissions = { contains: vi.fn().mockResolvedValue(true) } as unknown as typeof chrome.permissions;
});

describe('app simulation context menu', () => {
  it('registers only when an installed profile is available and removes the menu with the capability', async () => {
    mocks.catalog.mockResolvedValue({ profiles: [{ id: 'client', available: false }] });
    initializeQuickSimulationContextMenu();
    await vi.waitFor(() => expect(chrome.contextMenus.remove).toHaveBeenCalled());
    expect(chrome.contextMenus.create).not.toHaveBeenCalled();

    mocks.catalog.mockResolvedValue({ profiles: [{ id: 'client' }] });
    const refresh = mocks.presetChange.mock.calls[0][0];
    refresh();
    await vi.waitFor(() => expect(registered).toBe(true));
    expect(chrome.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }), expect.any(Function));

    mocks.catalog.mockResolvedValue({ profiles: [] });
    refresh();
    await vi.waitFor(() => expect(registered).toBe(false));
  });

  it('enables the remembered installed profile in the clicked tab', async () => {
    mocks.catalog.mockResolvedValue({ profiles: [{ id: 'first' }, { id: 'remembered' }] });
    mocks.remembered.mockResolvedValue('remembered');
    initializeQuickSimulationContextMenu();
    click({ menuItemId: 'enableQuickSimulation', pageUrl: url, editable: false }, { id: 42 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(mocks.enable).toHaveBeenCalledWith({ tabId: 42, profile: 'remembered' }));
  });
});
