import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountAutoLoginAvailability, clearAccountAutoLoginTab, getAccountIdentity, initializeAccountTracking, startAccountAutoLogin } from '../accountAutoLogin';
import { invokeConfiguredBrowserOperation, prepareConfiguredBrowserOperation } from '../browserUiService';
import { onBrowserPresetChange } from '../browserCapabilityRegistry';
import { authorizeBrowserCapabilityUrl } from '../browserCapabilities';
import { consumeAccountSsoInOffscreenDocument } from '../accountSsoOffscreen';
vi.mock('../browserUiService', () => ({ invokeConfiguredBrowserOperation: vi.fn(), prepareConfiguredBrowserOperation: vi.fn() }));
vi.mock('../browserCapabilities', () => ({ authorizeBrowserCapabilityUrl: vi.fn() }));
const fixture = vi.hoisted(() => ({ settings: {} as Record<string, any> }));
vi.mock('../browserCapabilityRegistry', () => ({ onBrowserPresetChange: vi.fn(), browserCapabilityRegistry: () => ({ settings: async () => fixture.settings }) }));
vi.mock('../accountSsoOffscreen', () => ({ consumeAccountSsoInOffscreenDocument: vi.fn() }));
const provider = { bundleId: 'accounts', revision: 'one' };
const account = { id: 7, principalId: 123, loginId: 'test', site: 'test' };
let stored: Record<string, any>;
let context: { supported: boolean; selector?: string; redirectUrl?: string };
let identity: string;
let ticket: { success: boolean; data?: string; error?: string };
beforeEach(() => {
  vi.clearAllMocks(); clearAccountAutoLoginTab(12); fixture.settings = {};
  stored = { 'browser-accounts-cache': [account] };
  identity = '123'; context = { supported: true, selector: '.login', redirectUrl: 'https://example.test/next' };
  ticket = { success: true, data: 'https://example.test/one-time-ticket' };
  chrome.storage.local.get = vi.fn(async () => ({ ...stored })) as any;
  chrome.storage.local.set = vi.fn(async value => Object.assign(stored, value)) as any;
  chrome.cookies = { onChanged: { addListener: vi.fn() } } as any;
  chrome.tabs = {} as any;
  chrome.tabs.get = vi.fn(async id => ({ id, url: 'https://example.test/login' })) as any;
  chrome.tabs.update = vi.fn(async () => ({})) as any; chrome.tabs.reload = vi.fn() as any;
  vi.mocked(authorizeBrowserCapabilityUrl).mockImplementation(async value => new URL(String(value)));
  vi.mocked(consumeAccountSsoInOffscreenDocument).mockResolvedValue(true);
  vi.mocked(prepareConfiguredBrowserOperation).mockResolvedValue({ ...provider, invoke: vi.fn() });
  vi.mocked(invokeConfiguredBrowserOperation).mockImplementation(async (_name, input: any) => ({ provider, data:
    input.command === 'loginContext' ? { success: true, data: context } : input.command === 'identity' ? { success: true, data: { value: identity, watch: [] } } : input.command === 'normalize' ? { success: true, data: [], identity: undefined } : input.command === 'current' ? { success: true, data: { value: identity, watch: [], account, accounts: [account] } } : ticket,
  }));
});
describe('configured account automatic login', () => {
  it('reads a display-only label from the selected storage without executing identity or normalizing accounts', async () => {
    fixture.settings = { extension: { accountState: { cacheKey: 'team-accounts-cache', identityKey: 'team-last-user-id' } } };
    stored = { 'team-accounts-cache': [{ ...account, provider }], 'team-last-user-id': { value: '123', provider } };
    expect(await getAccountIdentity({ cachedOnly: true })).toEqual({ value: '', watch: [], loginId: 'test' });
    expect(prepareConfiguredBrowserOperation).toHaveBeenCalledWith('accountIdentity');
    expect(chrome.storage.local.get).toHaveBeenCalledExactlyOnceWith(['team-accounts-cache', 'team-last-user-id']);
    expect(invokeConfiguredBrowserOperation).not.toHaveBeenCalled();
    expect((await vi.mocked(prepareConfiguredBrowserOperation).mock.results[0].value).invoke).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it.each([
    ['legacy', '123', provider],
    ['other identity provider', { value: '123', provider: { bundleId: 'other', revision: 'one' } }, provider],
    ['old identity revision', { value: '123', provider: { ...provider, revision: 'old' } }, provider],
    ['other account provider', { value: '123', provider }, { bundleId: 'other', revision: 'one' }],
    ['old account revision', { value: '123', provider }, { ...provider, revision: 'old' }],
  ])('does not label an unverified cache: %s', async (_name, saved, accountProvider) => {
    stored = { 'browser-accounts-cache': [{ ...account, provider: accountProvider }], 'browser-last-account-id': saved };
    expect(await getAccountIdentity({ cachedOnly: true })).toEqual({ value: '', watch: [] });
  });
  it('does not expose the cache when the selected identity operation is disabled or unavailable', async () => {
    vi.mocked(prepareConfiguredBrowserOperation).mockRejectedValueOnce(new Error('SERVICE_DISABLED'));
    await expect(getAccountIdentity({ cachedOnly: true })).rejects.toThrow('SERVICE_DISABLED');
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });
  it.each([
    [{ success: false, error: 'TEMPORARILY_UNAVAILABLE' }, 'TEMPORARILY_UNAVAILABLE'],
    [{ success: true }, 'Account identity unavailable'],
    [{ success: true, data: {} }, 'Account identity unavailable'],
    [{ success: true, data: { value: '', watch: null } }, 'Account identity unavailable'],
  ])('keeps an unconfirmed identity response distinct from logout: %j', async (response, error) => {
    stored = { 'browser-accounts-cache': [{ ...account, provider }], 'browser-last-account-id': { value: '123', provider } };
    const original = vi.mocked(invokeConfiguredBrowserOperation).getMockImplementation()!;
    vi.mocked(invokeConfiguredBrowserOperation).mockImplementation(async (name, input: any, options) => input.command === 'identity'
      ? { provider, data: response }
      : original(name, input, options));
    await expect(getAccountIdentity()).rejects.toThrow(error);
    expect(await getAccountIdentity({ cachedOnly: true })).toEqual({ value: '', watch: [], loginId: 'test' });
    expect(stored['browser-last-account-id']).toEqual({ value: '123', provider });
    expect(await accountAutoLoginAvailability(12, 'https://example.test/')).toEqual({ available: true, selector: '.login' });
    expect(invokeConfiguredBrowserOperation).toHaveBeenLastCalledWith('accounts', expect.objectContaining({ command: 'current', fallbackIdentity: '123' }), { provider });
  });
  it('labels a fresh identity from an exact-provider cache without normalizing the list', async () => {
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    await expect(getAccountIdentity()).resolves.toMatchObject({ value: '123', loginId: 'test' });
    expect(vi.mocked(invokeConfiguredBrowserOperation).mock.calls.every(([, input]: any) => input.command === 'identity')).toBe(true);
    stored['browser-accounts-cache'] = [{ ...account, provider: { ...provider, revision: 'old' } }];
    expect(await getAccountIdentity()).not.toHaveProperty('loginId');
    stored['browser-accounts-cache'] = [{ ...account, provider: { bundleId: 'other', revision: 'one' } }];
    expect(await getAccountIdentity()).not.toHaveProperty('loginId');
    identity = '';
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    expect(await getAccountIdentity()).not.toHaveProperty('loginId');
  });
  it('never consumes a ticket when the selected service rejects the page', async () => {
    context = { supported: false };
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toEqual({ success: false, reason: 'unsupported-page' });
    expect(consumeAccountSsoInOffscreenDocument).not.toHaveBeenCalled();
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledTimes(1);
  });
  it('keeps the accepted provider fixed across lookup, ticket issuance and page recheck', async () => {
    expect(await startAccountAutoLogin(12, 'https://example.test/login')).toEqual({ success: true });
    for (const call of vi.mocked(invokeConfiguredBrowserOperation).mock.calls.slice(1)) expect(call[2]).toEqual({ provider });
    expect(consumeAccountSsoInOffscreenDocument).toHaveBeenCalledWith(ticket.data);
    expect(chrome.tabs.update).toHaveBeenCalledWith(12, { url: context.redirectUrl });
  });
  it('reloads the supported page when no redirect is configured', async () => {
    delete context.redirectUrl;
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toEqual({ success: true });
    expect(chrome.tabs.reload).toHaveBeenCalledWith(12);
  });
  it('does not navigate a tab that has already left the login page', async () => {
    let count = 0;
    vi.mocked(invokeConfiguredBrowserOperation).mockImplementation(async (_name, input: any) => ({ provider, data: input.command === 'loginContext' ? { success: true, data: { supported: ++count === 1, selector: '.login' } } : input.command === 'identity' ? { success: true, data: { value: '123', watch: [] } } : input.command === 'normalize' ? { success: true, data: [], identity: undefined } : input.command === 'current' ? { success: true, data: { value: '123', watch: [], account, accounts: [account] } } : ticket }));
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toEqual({ success: true, reason: 'page-left' });
    expect(chrome.tabs.reload).not.toHaveBeenCalled(); expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
  it.each(['http://example.test/ticket', 'javascript:alert(1)'])('rejects unsafe ticket destinations: %s', async url => {
    ticket.data = url;
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toEqual({ success: false, reason: 'invalid-ticket' });
    expect(consumeAccountSsoInOffscreenDocument).not.toHaveBeenCalled();
  });
  it('reports permission rejection without consuming the ticket', async () => {
    vi.mocked(authorizeBrowserCapabilityUrl).mockRejectedValue(new Error('PERMISSION_DENIED'));
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toMatchObject({ success: false, reason: 'invalid-ticket' });
    expect(consumeAccountSsoInOffscreenDocument).not.toHaveBeenCalled();
  });
  it('does not navigate when ticket loading fails', async () => {
    vi.mocked(consumeAccountSsoInOffscreenDocument).mockResolvedValue(false);
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toMatchObject({ success: false, reason: 'navigation-failed' });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
  it('coalesces an in-flight request and cools down completed attempts', async () => {
    const first = startAccountAutoLogin(12, 'https://example.test/');
    expect(startAccountAutoLogin(12, 'https://example.test/')).toBe(first);
    await first;
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toMatchObject({ success: false, reason: 'cooldown' });
    expect(await accountAutoLoginAvailability(12, 'https://example.test/')).toEqual({ available: false });
  });
  it('does not send another provider’s cached records into the selected implementation', async () => {
    stored['browser-accounts-cache'] = [{ ...account, provider: { bundleId: 'other', revision: 'old' } }];
    await accountAutoLoginAvailability(12, 'https://example.test/');
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledWith('accounts', { command: 'current', accounts: [], fallbackIdentity: '123' }, { provider });
  });
  it('recovers a same-bundle cached identity after an update while issuing tickets only with the accepted revision', async () => {
    identity = '';
    const oldProvider = { ...provider, revision: 'old' };
    stored['browser-accounts-cache'] = [{ ...account, provider: oldProvider }];
    stored['browser-last-account-id'] = { value: '123', provider: oldProvider };
    expect(await startAccountAutoLogin(12, 'https://example.test/')).toEqual({ success: true });
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledWith('accounts', { command: 'current', accounts: [{ ...account, provider: oldProvider }], fallbackIdentity: '123' }, { provider });
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledWith('accounts', { command: 'sso', principalId: 123, site: 'test' }, { provider });
    expect(stored['browser-accounts-cache']).toEqual([{ ...account, provider }]);
  });
  it('uses the selected account storage keys without reading or writing the default scope', async () => {
    fixture.settings = { extension: { accountState: { cacheKey: 'team-accounts-cache', identityKey: 'team-last-user-id' } } };
    stored = { 'team-accounts-cache': [account] };
    await accountAutoLoginAvailability(12, 'https://example.test/');
    expect(chrome.storage.local.get).toHaveBeenCalledWith(['team-accounts-cache', 'team-last-user-id']);
    expect(stored['team-last-user-id']).toEqual({ value: '123', provider });
    expect(stored).not.toHaveProperty('browser-accounts-cache');
    expect(stored).not.toHaveProperty('browser-last-account-id');
  });
  it('preserves the last non-empty identity after cookie expiry', async () => {
    expect(await getAccountIdentity()).toEqual({ value: '123', watch: [] });
    identity = '';
    expect(await getAccountIdentity()).toEqual({ value: '', watch: [] });
    expect(stored['browser-last-account-id']).toMatchObject({ value: '123', provider });
    expect(await getAccountIdentity({ cachedOnly: true })).toEqual({ value: '', watch: [] });
    await accountAutoLoginAvailability(12, 'https://example.test/');
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledWith('accounts', expect.objectContaining({ command: 'current', fallbackIdentity: '123' }), { provider });
  });

  it('restores display caching only after a fresh identity becomes valid again', async () => {
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    await getAccountIdentity();
    identity = '';
    await getAccountIdentity();
    expect(await getAccountIdentity({ cachedOnly: true })).not.toHaveProperty('loginId');
    identity = '123';
    await getAccountIdentity();
    expect(await getAccountIdentity({ cachedOnly: true })).toMatchObject({ loginId: 'test' });
  });

  it.each([['123', ''], ['', '123']])('ignores an older %j identity after a newer %j result', async (oldValue, nextValue) => {
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    stored['browser-last-account-id'] = { value: '123', provider };
    let finish!: (value: any) => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(invokeConfiguredBrowserOperation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; started(); }));
    const older = getAccountIdentity();
    const rejected = expect(older).rejects.toThrow('Account identity changed');
    await ready;
    identity = nextValue;
    await getAccountIdentity();
    finish({ provider, data: { success: true, data: { value: oldValue, watch: [] } } });
    await rejected;
    const cached = await getAccountIdentity({ cachedOnly: true });
    expect(cached.loginId).toBe(nextValue ? 'test' : undefined);
  });

  it('does not restore an old current-account result after logout has invalidated its display', async () => {
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    let finish!: (value: any) => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const original = vi.mocked(invokeConfiguredBrowserOperation).getMockImplementation()!;
    vi.mocked(invokeConfiguredBrowserOperation).mockImplementation((name, input: any, options) => input.command === 'current' ? new Promise(resolve => { finish = resolve; started(); }) : original(name, input, options));
    const current = accountAutoLoginAvailability(12, 'https://example.test/');
    await ready;
    identity = '';
    await getAccountIdentity();
    finish({ provider, data: { success: true, data: { value: '123', watch: [], account, accounts: [account] } } });
    expect(await current).toEqual({ available: false, selector: '.login' });
    expect(await getAccountIdentity({ cachedOnly: true })).not.toHaveProperty('loginId');
  });

  it('does not return an old account if logout completes while its account cache write is pending', async () => {
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    chrome.storage.local.set = vi.fn((values: Record<string, unknown>) => Object.hasOwn(values, 'browser-accounts-cache') ? new Promise<void>(resolve => { finish = () => { Object.assign(stored, values); resolve(); }; started(); }) : Promise.resolve(Object.assign(stored, values))) as any;
    const current = accountAutoLoginAvailability(12, 'https://example.test/');
    await ready;
    identity = '';
    await getAccountIdentity();
    finish();
    expect(await current).toEqual({ available: false, selector: '.login' });
    expect(await getAccountIdentity({ cachedOnly: true })).not.toHaveProperty('loginId');
  });

  it('invalidates only the display cache on an explicit login-required response', async () => {
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    await getAccountIdentity();
    vi.mocked(invokeConfiguredBrowserOperation).mockResolvedValueOnce({ provider, data: { success: false, error: 'ACCOUNT_LOGIN_REQUIRED' } });
    await expect(getAccountIdentity()).rejects.toThrow('ACCOUNT_LOGIN_REQUIRED');
    expect(await getAccountIdentity({ cachedOnly: true })).not.toHaveProperty('loginId');
    expect(stored['browser-last-account-id']).toMatchObject({ value: '123', provider });
  });
  it('does not send another provider’s last identity to the selected implementation', async () => {
    stored['browser-last-account-id'] = { value: 'other-identity', provider: { bundleId: 'other', revision: 'one' } };
    identity = '';
    await accountAutoLoginAvailability(12, 'https://example.test/');
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledWith('accounts', expect.objectContaining({ command: 'current', fallbackIdentity: undefined }), { provider });
  });
  it('accepts a legacy identity only when its cached account has the selected provider owner', async () => {
    identity = '';
    stored['browser-last-account-id'] = '123';
    await accountAutoLoginAvailability(12, 'https://example.test/');
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledWith('accounts', expect.objectContaining({ command: 'current', fallbackIdentity: undefined }), { provider });
    stored['browser-accounts-cache'] = [{ ...account, provider }];
    await accountAutoLoginAvailability(12, 'https://example.test/');
    expect(invokeConfiguredBrowserOperation).toHaveBeenLastCalledWith('accounts', expect.objectContaining({ command: 'current', fallbackIdentity: '123' }), { provider });
  });
  it('recovers an accepted legacy identity on the first request after cookie expiry', async () => {
    identity = '';
    stored['browser-last-account-id'] = '123';
    stored['browser-accounts-cache'] = [{ id: 7, legacyPrincipal: 123 }];
    const original = vi.mocked(invokeConfiguredBrowserOperation).getMockImplementation()!;
    vi.mocked(invokeConfiguredBrowserOperation).mockImplementation(async (name, input: any, options) => input.command === 'normalize' ? { provider, data: { success: true, data: [account], identity: '123' } } : original(name, input, options));
    expect(await accountAutoLoginAvailability(12, 'https://example.test/')).toEqual({ available: true, selector: '.login' });
    expect(invokeConfiguredBrowserOperation).toHaveBeenCalledWith('accounts', { command: 'normalize', accounts: [{ id: 7, legacyPrincipal: 123 }], legacyIdentity: '123' }, { provider });
    expect(invokeConfiguredBrowserOperation).toHaveBeenLastCalledWith('accounts', expect.objectContaining({ command: 'current', fallbackIdentity: '123' }), { provider });
    expect(stored['browser-last-account-id']).toMatchObject({ value: '123', provider });
    expect(await getAccountIdentity({ cachedOnly: true })).not.toHaveProperty('loginId');
  });
  it('ignores an identity read that finishes after the preset changes', async () => {
    initializeAccountTracking();
    await getAccountIdentity();
    let resolveOld!: (value: any) => void;
    vi.mocked(invokeConfiguredBrowserOperation).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const pending = getAccountIdentity();
    const nextProvider = { bundleId: 'other', revision: 'two' };
    vi.mocked(invokeConfiguredBrowserOperation).mockResolvedValue({ provider: nextProvider, data: { success: true, data: { value: 'new', watch: [] } } });
    vi.mocked(onBrowserPresetChange).mock.calls.at(-1)![0]();
    await getAccountIdentity();
    resolveOld({ provider, data: { success: true, data: { value: 'old', watch: [{ name: 'old-cookie', domain: 'old.test' }] } } });
    expect(await pending).toEqual({ value: '', watch: [] });
    expect(stored['browser-last-account-id']).toEqual({ value: 'new', provider: nextProvider });
  });

});
