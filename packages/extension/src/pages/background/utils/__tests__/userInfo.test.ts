import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../browserCapabilities', () => ({ invokeBrowserCapability: vi.fn() }));
import { invokeBrowserCapability } from '../../browserCapabilities';
import { getPanelIdentity } from '../userInfo';

beforeEach(() => { vi.mocked(invokeBrowserCapability).mockReset(); });
it('delegates the existing UI identity entry to the installed provider without changing its value', async () => {
  vi.mocked(invokeBrowserCapability).mockResolvedValue({ available: true, value: ' 123456 ' });
  expect(await getPanelIdentity()).toBe(' 123456 ');
  expect(invokeBrowserCapability).toHaveBeenCalledExactlyOnceWith('identity.panel', {});
});
it('reports missing and failed providers without falling back to a built-in network request', async () => {
  vi.mocked(invokeBrowserCapability).mockResolvedValue({ available: false });
  await expect(getPanelIdentity()).rejects.toThrow('CAPABILITY_NOT_INSTALLED');
  vi.mocked(invokeBrowserCapability).mockRejectedValue(new Error('provider failed'));
  await expect(getPanelIdentity()).rejects.toThrow('provider failed');
});
it.each([null, undefined, '', 123456, { subject: '123456' }])('rejects an invalid provider result %#', async value => {
  vi.mocked(invokeBrowserCapability).mockResolvedValue({ available: true, value });
  await expect(getPanelIdentity()).rejects.toThrow('Invalid panel identity');
});
