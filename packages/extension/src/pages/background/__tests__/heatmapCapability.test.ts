import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), prepare: vi.fn(), invoke: vi.fn() }));
vi.mock('../externalServices', () => ({ isExternalServiceEnabled: mocks.enabled }));
vi.mock('../browserCapabilities', () => ({ prepareBrowserCapability: mocks.prepare }));
import { fetchHeatmapData } from '../api/heatmap';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockResolvedValue(true);
  mocks.prepare.mockResolvedValue({ bundleId: 'fixture', revision: 'first', invoke: mocks.invoke });
  mocks.invoke.mockResolvedValue({ success: true, points: [{ spm: 'a.b.c.d', spmName: 'Card', measures: { clicks: 12, ratio: 0.25 } }], cached: false });
});
it('caches by accepted provider and keeps the installed measure values intact', async () => {
  const result = await fetchHeatmapData('cached.page', '20261024');
  expect(result).toMatchObject({ success: true, cached: false, points: [{ measures: { clicks: 12, ratio: 0.25 } }] });
  expect(mocks.invoke).toHaveBeenCalledWith({ spmAB: 'cached.page', ds: '20261024' });
  expect(await fetchHeatmapData('cached.page', '20261024')).toMatchObject({ success: true, cached: true });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  mocks.prepare.mockResolvedValue({ bundleId: 'fixture', revision: 'replacement', invoke: mocks.invoke });
  expect(await fetchHeatmapData('cached.page', '20261024')).toMatchObject({ cached: false });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
it('does not use cached private data when its service or provider is unavailable', async () => {
  await fetchHeatmapData('removed.page', '20261024');
  mocks.prepare.mockResolvedValue(null);
  expect(await fetchHeatmapData('removed.page', '20261024')).toEqual({ success: false, errorCode: 'unknown', error: 'CAPABILITY_NOT_INSTALLED' });
  mocks.enabled.mockResolvedValue(false);
  expect(await fetchHeatmapData('removed.page', '20261024')).toEqual({ success: false, errorCode: 'unknown', error: 'TRACKING_METADATA_DISABLED' });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it('preserves installed login and metric errors and reports execution failures', async () => {
  mocks.invoke.mockResolvedValue({ success: false, errorCode: 'login', error: 'Sign in' });
  expect(await fetchHeatmapData('login.page', '20261024')).toEqual({ success: false, errorCode: 'login', error: 'Sign in' });
  mocks.invoke.mockRejectedValue(new Error('offline'));
  expect(await fetchHeatmapData('error.page', '20261024')).toEqual({ success: false, errorCode: 'network', error: 'offline' });
});
