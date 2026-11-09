import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  refreshBrowserUiSettings,
  getBrowserUiSettings,
  useBrowserControl,
} from '../../panel/utils/browserUiSettings';
import { networkControlFixture } from '../../../test/fixtures/networkControl';
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  grant: vi.fn(),
  capture: vi.fn(),
  settings: vi.fn(),
  prepare: vi.fn(),
  enabled: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('../browserCapabilityRegistry', () => ({
  browserCapabilityRegistry: () => ({
    settings: mocks.settings,
    installationStatus: mocks.status,
    captureSelection: mocks.capture,
  }),
}));
vi.mock('../browserCapabilities', () => ({ prepareBrowserCapability: mocks.prepare }));
vi.mock('../externalServices', () => ({ isExternalServiceEnabled: mocks.enabled }));
vi.mock('../browserRequestLogin', () => ({
  openBrowserRequestLogin: mocks.open,
  closeBrowserRequestLogin: mocks.close,
}));
vi.mock('../../../shared/presetPermissions', () => ({ grantPresetOrigins: mocks.grant }));
import { handleBrowserUiService } from '../browserUiService';
const sender = { id: 'owned', url: 'chrome-extension://owned/popup.html' };
beforeEach(() => {
  vi.clearAllMocks();
  chrome.runtime.id = 'owned';
  mocks.capture.mockResolvedValue({ bundles: [], errors: [], revisions: {}, activeRevision: null });
  mocks.settings.mockResolvedValue({
    extension: {
      logins: { account: { url: 'https://login.example.test/', title: { en: 'Account' } } },
      operations: { 'capture.identity': { hook: 'identity.capture', setting: 'captureEnabled' } },
    },
  });
  mocks.enabled.mockResolvedValue(true);
  mocks.invoke.mockResolvedValue({ success: true, data: { subject: 'fixture', complete: false } });
  mocks.prepare.mockResolvedValue({
    bundleId: 'fixture',
    revision: 'accepted',
    invoke: mocks.invoke,
  });
});
it('requires an extension UI before reading settings or calling a handler', async () => {
  expect(
    await handleBrowserUiService(
      { operation: 'settings' },
      { ...sender, url: 'https://example.test/' },
    ),
  ).toMatchObject({ success: false });
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('includes the installed selection scope with settings without executing a capability', async () => {
  mocks.settings.mockResolvedValueOnce({ extension: {}, cacheScope: 'installed-selection' });
  expect(await handleBrowserUiService({ operation: 'settings' }, sender)).toEqual({
    success: true,
    data: {},
    contributions: { schemaVersion: 1 },
    cacheScope: 'installed-selection',
    appProfiles: [],
  });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('includes only installed App presentation data in the startup settings', async () => {
  mocks.settings.mockResolvedValueOnce({
    extension: {},
    appProfiles: [
      {
        id: 'example/app',
        label: 'Example',
        definition: { labels: { en: 'Example', zh_CN: '示例' }, actions: { privatePayload: true } },
      },
    ],
  });
  const response = await handleBrowserUiService({ operation: 'settings' }, sender);
  expect(response.appProfiles).toEqual([
    {
      id: 'example/app',
      label: 'Example',
      definition: { labels: { en: 'Example', zh_CN: '示例' } },
    },
  ]);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('delivers declared operations and logins to UI without losing the installed network control', async () => {
  const extension = {
    ...(await mocks.settings()).extension,
    links: { manual: 'https://guide.example.test/' },
  };
  const control = networkControlFixture({
    mtopGateways: { example: { prod: 'api.example.test', pre: 'staging.example.test' } },
  });
  mocks.settings.mockResolvedValue({ extension, browserControl: control });
  chrome.runtime.sendMessage = vi.fn(input => handleBrowserUiService(input.data, sender)) as any;
  await refreshBrowserUiSettings();
  expect(getBrowserUiSettings()).toEqual(extension);
  const hook = renderHook(() => useBrowserControl(key => key));
  expect(hook.result.current).toEqual(control);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it.each([
  {},
  { operations: { account: { hook: 'account.identity' } } },
  { logins: { account: { url: 'https://login.example.test/', title: { en: 'Account' } } } },
])(
  'delivers optional functional declarations without relying on message serialization: %j',
  async extension => {
    mocks.settings.mockResolvedValue({ extension });
    chrome.runtime.sendMessage = vi.fn(input => handleBrowserUiService(input.data, sender)) as any;
    await refreshBrowserUiSettings();
    expect(getBrowserUiSettings()).toEqual(extension);
    expect(mocks.prepare).not.toHaveBeenCalled();
  },
);
it('chooses the declared hook and gate rather than caller supplied fields', async () => {
  const provider = { bundleId: 'fixture', revision: 'accepted' };
  const result = await handleBrowserUiService(
    {
      operation: 'invoke',
      name: 'capture.identity',
      input: { source: 'cookie-first' },
      provider,
      hook: 'other',
      setting: 'otherEnabled',
    },
    sender,
  );
  const captured = await mocks.capture.mock.results[0]?.value;
  expect(mocks.capture).toHaveBeenCalledOnce();
  expect(mocks.settings).toHaveBeenCalledExactlyOnceWith(captured);
  expect(mocks.prepare).toHaveBeenCalledWith('identity.capture', provider, captured);
  expect(mocks.enabled).toHaveBeenCalledWith(
    'captureEnabled',
    await mocks.settings.mock.results[0].value,
  );
  expect(mocks.invoke).toHaveBeenCalledWith({ source: 'cookie-first' }, undefined);
  expect(result).toEqual({
    success: true,
    data: { success: true, data: { subject: 'fixture', complete: false } },
    provider,
  });
});
it('rejects missing, inherited and disabled operations without executing any code', async () => {
  for (const name of ['missing', '__proto__', 'toString'])
    expect(await handleBrowserUiService({ operation: 'invoke', name }, sender)).toMatchObject({
      success: false,
    });
  mocks.enabled.mockResolvedValue(false);
  expect(
    await handleBrowserUiService({ operation: 'invoke', name: 'capture.identity' }, sender),
  ).toMatchObject({ success: false, error: 'SERVICE_DISABLED' });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('accepts only a configured login URL and can release after uninstall or graph damage', async () => {
  mocks.open.mockResolvedValue('lease');
  expect(
    await handleBrowserUiService(
      { operation: 'loginOpen', name: 'account', id: 'lease', url: 'https://other.example.test/' },
      sender,
    ),
  ).toMatchObject({ success: true, data: { definition: { url: 'https://login.example.test/' } } });
  expect(mocks.open).toHaveBeenCalledWith('https://login.example.test/', sender, 'lease');
  mocks.settings.mockClear().mockRejectedValue(new Error('uninstalled'));
  expect(await handleBrowserUiService({ operation: 'loginClose', id: 'lease' }, sender)).toEqual({
    success: true,
  });
  expect(mocks.close).toHaveBeenCalledWith('lease', sender);
  expect(mocks.settings).not.toHaveBeenCalled();
});
it('does not turn a broken declared hook into an absent optional capability', async () => {
  mocks.prepare.mockResolvedValue(null);
  expect(
    await handleBrowserUiService({ operation: 'invoke', name: 'capture.identity' }, sender),
  ).toMatchObject({ success: false, error: 'CAPABILITY_UNAVAILABLE' });
});
it('rejects cancellation after asynchronous preparation before invoking the accepted handler', async () => {
  const controller = new AbortController();
  mocks.prepare.mockImplementation(async () => {
    controller.abort();
    return { bundleId: 'fixture', revision: 'accepted', invoke: mocks.invoke };
  });
  expect(
    await handleBrowserUiService(
      { operation: 'invoke', name: 'capture.identity' },
      sender,
      controller.signal,
    ),
  ).toMatchObject({ success: false });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('authorizes only the current preset selection through the background grant queue', async () => {
  mocks.status.mockResolvedValue({
    presetId: 'team',
    installationRevision: 'current',
    requiredOrigins: ['https://accounts.example.test/*'],
    permissionPending: [],
  });
  expect(
    await handleBrowserUiService(
      { operation: 'authorizePreset', presetId: 'team', revision: 'stale' },
      sender,
    ),
  ).toMatchObject({ success: false, error: 'INSTALLATION_SELECTION_CHANGED' });
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(
    await handleBrowserUiService(
      {
        operation: 'authorizePreset',
        presetId: 'team',
        revision: 'current',
        origins: ['<all_urls>'],
      },
      sender,
    ),
  ).toMatchObject({ success: true });
  expect(mocks.grant).toHaveBeenCalledWith(['https://accounts.example.test/*']);
});

it('requests the account origin immediately and registers only the approved, current origin', async () => {
  const origin = 'https://accounts.example.test';
  mocks.settings.mockResolvedValue({
    extension: { logins: { accounts: { url: `${origin}/login` } } },
  });
  const request = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  vi.stubGlobal('chrome', { ...chrome, permissions: { request } });
  const input = { operation: 'authorizeAccounts', origin };
  expect(await handleBrowserUiService(input, { ...sender, url: `${origin}/` })).toMatchObject({
    success: false,
  });
  expect(request).not.toHaveBeenCalled();
  const denied = handleBrowserUiService(input, sender);
  expect(request).toHaveBeenCalledExactlyOnceWith({ origins: [`${origin}/*`] });
  expect(await denied).toEqual({ success: false });
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(await handleBrowserUiService(input, sender)).toEqual({ success: true });
  expect(mocks.grant).toHaveBeenCalledExactlyOnceWith([`${origin}/*`]);
  vi.unstubAllGlobals();
});
