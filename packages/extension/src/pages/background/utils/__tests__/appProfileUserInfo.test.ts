import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), authorize: vi.fn(), run: vi.fn() }));
vi.mock('../../browserCapabilities', () => ({ prepareBrowserCapabilities: mocks.prepare, authorizeBrowserCapabilityUrl: mocks.authorize }));
vi.mock('../../browserPureCapabilities', () => ({ runAcceptedBrowserPureCapability: mocks.run }));
import { getAppProfileUserInfo } from '../appProfileUserInfo';
const entry = (handler: string, revision = 'accepted') => ({ bundleId: 'fixture', revision, invocation: { handler } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({ 'app.userInfo.scope': entry('scope'), 'app.userInfo.resolve': entry('resolve') });
  mocks.authorize.mockImplementation(async url => new URL(url));
  mocks.run.mockImplementation(async ({ handler, input }) => handler === 'scope' ? { cookieNames: ['id', 'name'] } : { userId: input.cookies[0].value, userName: input.cookies[1].value });
  vi.stubGlobal('chrome', { ...chrome, cookies: { getAll: vi.fn().mockImplementation(async ({ name }) => [{ name, value: name === 'id' ? '123' : '测试' }]) } });
});
afterEach(() => vi.unstubAllGlobals());
it('keeps the original named Cookie queries and captures both phases from one provider', async () => {
  expect(await getAppProfileUserInfo('https://app.example.test/page')).toEqual({ userId: '123', userName: '测试' });
  expect(chrome.cookies.getAll).toHaveBeenCalledWith({ url: 'https://app.example.test/page', name: 'id' });
  expect(chrome.cookies.getAll).toHaveBeenCalledWith({ url: 'https://app.example.test/page', name: 'name' });
  expect(mocks.run.mock.calls[1][0]).toEqual({ handler: 'resolve', input: { url: 'https://app.example.test/page', cookies: [{ name: 'id', value: '123' }, { name: 'name', value: '测试' }] } });
});
it('does not read Cookies when the installed decoder does not support the URL', async () => {
  mocks.run.mockResolvedValue({ cookieNames: [] });
  expect(await getAppProfileUserInfo('https://other.example.test/')).toEqual({});
  expect(mocks.authorize).not.toHaveBeenCalled(); expect(chrome.cookies.getAll).not.toHaveBeenCalled();
});
it('requires complete matching handlers and current host authorization', async () => {
  mocks.prepare.mockResolvedValue({});
  await expect(getAppProfileUserInfo('https://app.example.test/')).rejects.toThrow('NOT_INSTALLED');
  mocks.prepare.mockResolvedValue({ 'app.userInfo.scope': entry('scope'), 'app.userInfo.resolve': entry('resolve', 'replacement') });
  await expect(getAppProfileUserInfo('https://app.example.test/')).rejects.toThrow('one implementation');
  mocks.prepare.mockResolvedValue({ 'app.userInfo.scope': entry('scope'), 'app.userInfo.resolve': entry('resolve') });
  mocks.authorize.mockRejectedValue(new Error('permission denied'));
  await expect(getAppProfileUserInfo('https://app.example.test/')).rejects.toThrow('permission denied');
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
});
it('rejects invalid query declarations and preserves Cookie lookup failures', async () => {
  mocks.run.mockResolvedValueOnce({ cookieNames: [false] });
  await expect(getAppProfileUserInfo('https://app.example.test/')).rejects.toThrow('selection');
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
  vi.mocked(chrome.cookies.getAll).mockRejectedValue(new Error('cookie service failed'));
  await expect(getAppProfileUserInfo('https://app.example.test/')).rejects.toThrow('cookie service failed');
});
