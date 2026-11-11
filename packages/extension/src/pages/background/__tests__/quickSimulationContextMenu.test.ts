import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeQuickSimulationContextMenu } from '../quickSimulationContextMenu';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  presetChange: vi.fn(),
  appChange: vi.fn(),
  app: vi.fn(),
  remembered: vi.fn(),
  setSimulation: vi.fn(),
  permission: vi.fn(),
}));
vi.mock('../appProfileCatalog', () => ({ getAppProfileCatalog: mocks.catalog }));
vi.mock('../browserCapabilityRegistry', () => ({ onBrowserPresetChange: mocks.presetChange }));
vi.mock('../utils/appProfileRules', () => ({
  getAppProfileForTab: mocks.app,
  onAppProfileStateChange: mocks.appChange,
}));
vi.mock('../quickDeviceSimulationState', () => ({
  getRememberedQuickAppProfileForTab: mocks.remembered,
}));
vi.mock('../quickSimulationAutoRules', () => ({
  setQuickAppSimulationWithAutoRuleSync: mocks.setSimulation,
}));
vi.mock('../agentHandlers/permissionHandlers', () => ({
  handleRequestPermission: mocks.permission,
}));

const url = 'https://example.com/page';
let click: Parameters<typeof chrome.contextMenus.onClicked.addListener>[0];
let registered: Set<string | number>;

beforeEach(() => {
  vi.resetAllMocks();
  registered = new Set();
  mocks.catalog.mockResolvedValue({ profiles: [] });
  chrome.runtime.onInstalled = {
    addListener: vi.fn(),
  } as unknown as typeof chrome.runtime.onInstalled;
  chrome.i18n = { getMessage: vi.fn(key => key) } as unknown as typeof chrome.i18n;
  chrome.contextMenus = {
    create: vi.fn(({ id }) => {
      registered.add(id);
      return id;
    }),
    remove: vi.fn(id => {
      registered.delete(id);
    }),
    update: vi.fn((id, _properties, callback) => {
      if (!registered.has(id)) chrome.runtime.lastError = { message: 'Missing menu' };
      callback?.();
      chrome.runtime.lastError = undefined;
    }),
    onClicked: {
      addListener: vi.fn(listener => {
        click = listener;
      }),
    },
  } as unknown as typeof chrome.contextMenus;
  chrome.tabs = {
    get: vi.fn().mockResolvedValue({ url }),
    query: vi.fn().mockResolvedValue([{ id: 42 }]),
    onActivated: { addListener: vi.fn() },
  } as unknown as typeof chrome.tabs;
  chrome.windows = { onFocusChanged: { addListener: vi.fn() } } as unknown as typeof chrome.windows;
  chrome.permissions = {
    contains: vi.fn().mockResolvedValue(true),
  } as unknown as typeof chrome.permissions;
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
    await vi.waitFor(() => expect(registered.has('enableQuickSimulation')).toBe(true));
    expect(chrome.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      }),
      expect.any(Function),
    );

    mocks.catalog.mockResolvedValue({ profiles: [] });
    refresh();
    await vi.waitFor(() => expect(registered.size).toBe(0));
  });

  it('enables the remembered installed profile in the clicked tab', async () => {
    mocks.catalog.mockResolvedValue({ profiles: [{ id: 'first' }, { id: 'remembered' }] });
    mocks.remembered.mockResolvedValue('remembered');
    initializeQuickSimulationContextMenu();
    click({ menuItemId: 'enableQuickSimulation', pageUrl: url, editable: false }, {
      id: 42,
    } as chrome.tabs.Tab);
    await vi.waitFor(() =>
      expect(mocks.setSimulation).toHaveBeenCalledWith({ tabId: 42, profile: 'remembered' }),
    );
  });

  it('updates the action when app simulation changes or another tab becomes active', async () => {
    mocks.catalog.mockResolvedValue({ profiles: [{ id: 'client' }] });
    initializeQuickSimulationContextMenu();
    await vi.waitFor(() => expect(registered.has('enableQuickSimulation')).toBe(true));

    mocks.app.mockImplementation(async tabId => (tabId === 42 ? { profile: 'client' } : undefined));
    const appChanged = mocks.appChange.mock.calls[0][0];
    appChanged();
    await vi.waitFor(() =>
      expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(
        'disableQuickSimulation',
        { title: 'deviceSimulationDisableFromPage', visible: true },
        expect.any(Function),
      ),
    );
    expect(registered).toEqual(new Set(['disableQuickSimulation']));

    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 43 }] as chrome.tabs.Tab[]);
    vi.mocked(chrome.tabs.onActivated.addListener).mock.calls[0][0]({ tabId: 43, windowId: 1 });
    await vi.waitFor(() =>
      expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(
        'enableQuickSimulation',
        { title: 'deviceSimulationEnableFromPage', visible: true },
        expect.any(Function),
      ),
    );
    expect(registered).toEqual(new Set(['enableQuickSimulation']));
  });

  it('can turn off an active app simulation when no profile is available to enable', async () => {
    mocks.app.mockResolvedValue({ profile: 'client' });
    initializeQuickSimulationContextMenu();
    await vi.waitFor(() =>
      expect(chrome.contextMenus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'deviceSimulationDisableFromPage',
        }),
        expect.any(Function),
      ),
    );

    click({ menuItemId: 'disableQuickSimulation', pageUrl: url, editable: false }, {
      id: 42,
    } as chrome.tabs.Tab);
    await vi.waitFor(() =>
      expect(mocks.setSimulation).toHaveBeenCalledWith({ tabId: 42, profile: null }),
    );
    expect(chrome.permissions.contains).not.toHaveBeenCalled();
  });

  it('ignores a stale enable menu instead of disabling an active simulation', async () => {
    mocks.catalog.mockResolvedValue({ profiles: [{ id: 'client' }] });
    initializeQuickSimulationContextMenu();
    await vi.waitFor(() => expect(registered.has('enableQuickSimulation')).toBe(true));

    mocks.app.mockResolvedValue({ profile: 'client' });
    click({ menuItemId: 'enableQuickSimulation', pageUrl: url, editable: false }, {
      id: 42,
    } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(registered.has('disableQuickSimulation')).toBe(true));
    expect(mocks.setSimulation).not.toHaveBeenCalled();
  });
});
