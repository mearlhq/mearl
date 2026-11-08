import { beforeEach, expect, it, vi } from 'vitest';
import { requestUiFixture as legacyBrowserRequestUi } from '../../../test/fixtures/requestUi';
import { handleBrowserRequestUi } from '../browserRequestUiService';
const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  invoke: vi.fn(),
  enabled: vi.fn(),
  preference: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  legacy: vi.fn(),
}));
vi.mock('../browserRequestUiState', () => ({ browserRequestUiState: mocks.state, browserRequestUiSelection: mocks.state }));
vi.mock('../browserCapabilities', () => ({ invokeBrowserCapability: mocks.invoke }));
vi.mock('../externalServices', () => ({
  isExternalServiceEnabled: mocks.enabled,
  updateBrowserServicePreferences: mocks.preference,
}));
vi.mock('../browserRequestLogin', () => ({
  openBrowserRequestLogin: mocks.open,
  closeBrowserRequestLogin: mocks.close,
}));
vi.mock('../api/requestMetadata', () => ({ fetchApiSchema: mocks.legacy }));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const sender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/popup.html`,
  documentId: 'doc-a',
};
const id = '12345678-1234-1234-1234-123456789abc';
const input = (operation: string, extra = {}) => ({ operation, revision: 'accepted', ...extra });
beforeEach(() => {
  vi.clearAllMocks();
  chrome.runtime.id = extensionId;
  chrome.storage.sync = { set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } as any;
  mocks.state.mockResolvedValue({
    selected: { bundleId: 'custom', revision: 'accepted' },
    definition: {
      ...legacyBrowserRequestUi,
      setting: { ...legacyBrowserRequestUi.setting, key: 'customEnabled' },
    },
  });
  mocks.enabled.mockResolvedValue(true);
  mocks.preference.mockImplementation(async (_patch, assertSelection) => { await assertSelection(); });
  mocks.open.mockResolvedValue(id);
  mocks.close.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue({
    available: true,
    value: {
      displayValue: 'A#b (1.0)',
      jumpUrl: 'https://example.com/details',
      maintainerDisplayValue: 'Owner',
    },
  });
});
it('accepts only extension UI messages and binds details to the exact selected bundle revision', async () => {
  expect(
    await handleBrowserRequestUi(input('details', { api: 'mtop.test' }), {
      ...sender,
      url: 'https://example.com/',
    }),
  ).toMatchObject({ success: false });
  expect(mocks.state).not.toHaveBeenCalled();
  expect(
    await handleBrowserRequestUi(input('details', { api: 'mtop.test' }), sender),
  ).toMatchObject({ success: true, data: { displayValue: 'A#b (1.0)' } });
  expect(mocks.enabled).toHaveBeenCalledWith('customEnabled');
  expect(mocks.invoke).toHaveBeenCalledWith(
    legacyBrowserRequestUi.details.hook,
    { api: 'mtop.test', version: '1.0' },
    { bundleId: 'custom', revision: 'accepted' },
  );
});
it('binds saving to the selected module and independently guards its declared service', async () => {
  const saveInput = { operation: 'list', appKey: '1', search: '' };
  mocks.invoke.mockResolvedValue({ available: true, value: { success: true, data: [] } });
  expect(await handleBrowserRequestUi(input('save', { input: saveInput }), sender)).toEqual({
    success: true,
    data: { success: true, data: [] },
  });
  expect(mocks.enabled).toHaveBeenCalledWith('requestCasesEnabled');
  expect(mocks.invoke).toHaveBeenCalledWith('request.example.save', saveInput, {
    bundleId: 'custom',
    revision: 'accepted',
  });
  mocks.invoke.mockClear();
  mocks.enabled.mockResolvedValue(false);
  expect(await handleBrowserRequestUi(input('save', { input: saveInput }), sender)).toMatchObject({
    success: false,
    error: 'REQUESTCASES_DISABLED',
  });
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('rejects absent, stale and broken save contributions without falling back to a legacy operation', async () => {
  expect(await handleBrowserRequestUi(input('save', { revision: 'old' }), sender)).toMatchObject({
    success: false,
  });
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.invoke.mockResolvedValue({ available: false });
  expect(await handleBrowserRequestUi(input('save'), sender)).toMatchObject({
    success: false,
    error: expect.stringContaining('unavailable'),
  });
  mocks.state.mockResolvedValue({ selected: null, definition: null });
  expect(await handleBrowserRequestUi(input('save', { revision: null }), sender)).toMatchObject({ success: false, error: 'CAPABILITY_NOT_INSTALLED' });
});
it('rejects stale selections, disabled services and unsafe returned links before rendering', async () => {
  expect(
    await handleBrowserRequestUi(input('details', { api: 'mtop.test', revision: 'old' }), sender),
  ).toMatchObject({ success: false, error: expect.stringContaining('provider changed') });
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.enabled.mockResolvedValueOnce(false);
  expect(
    await handleBrowserRequestUi(input('details', { api: 'mtop.test' }), sender),
  ).toMatchObject({ success: false, error: 'EXAMPLE_METADATA_DISABLED' });
  mocks.invoke.mockResolvedValue({
    available: true,
    value: { displayValue: 'x', jumpUrl: 'javascript:alert(1)' },
  });
  expect(
    await handleBrowserRequestUi(input('details', { api: 'mtop.test' }), sender),
  ).toMatchObject({ success: false });
});
it('writes only the selected setting and removes preferences equal to its installed default', async () => {
  expect(
    await handleBrowserRequestUi(
      input('preference', { enabled: false, key: 'agentEnabled' }),
      sender,
    ),
  ).toEqual({ success: true });
  expect(mocks.preference).toHaveBeenCalledWith({ customEnabled: false }, expect.any(Function));
  await handleBrowserRequestUi(input('preference', { enabled: true }), sender);
  expect(mocks.preference).toHaveBeenLastCalledWith({ customEnabled: true }, expect.any(Function));
  mocks.state.mockResolvedValue({ selected: { bundleId: 'replacement', revision: 'new' }, definition: { setting: { key: 'otherEnabled' } } });
  await expect(mocks.preference.mock.calls.at(-1)![1]()).rejects.toThrow('provider changed');
});
it('opens the accepted login URL and lifetime id, ignoring client-supplied URLs', async () => {
  expect(
    await handleBrowserRequestUi(
      input('loginOpen', { id, url: 'https://other.example.com' }),
      sender,
    ),
  ).toMatchObject({
    success: true,
    data: { id, definition: { login: legacyBrowserRequestUi.login } },
  });
  expect(mocks.open).toHaveBeenCalledWith(legacyBrowserRequestUi.login.url, sender, id);
});
it('can close an accepted login after the selected package is removed or unreadable', async () => {
  mocks.state.mockRejectedValue(new Error('Package unavailable'));
  expect(await handleBrowserRequestUi({ operation: 'loginClose', id }, sender)).toEqual({
    success: true,
  });
  expect(mocks.state).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledWith(id, sender);
});

it('represents an uninstalled request UI explicitly and rejects work without a provider', async () => {
  mocks.state.mockResolvedValue({ selected: null, definition: null, enabled: false });
  expect(await handleBrowserRequestUi({ operation: 'state' }, sender)).toEqual({ success: true, data: { selected: null, definition: null, enabled: false } });
  expect(await handleBrowserRequestUi({ operation: 'details', revision: null, api: 'example.api' }, sender)).toEqual({ success: false, error: 'CAPABILITY_NOT_INSTALLED' });
  expect(mocks.invoke).not.toHaveBeenCalled();
});
