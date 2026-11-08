import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), run: vi.fn() }));
vi.mock('../browserCapabilities', () => ({ prepareBrowserCapabilities: mocks.prepare }));
vi.mock('../browserPureCapabilities', () => ({ runAcceptedBrowserPureCapability: mocks.run }));
let service: typeof import('../requestInspection');
const accepted = (revision: string) => ({ 'request.inspect': { invocation: { handler: revision } } });
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  mocks.prepare.mockResolvedValue(accepted('first'));
  mocks.run.mockImplementation(async ({ input }) => input.map((value: any) => ({ apiName: value.url, isProxy: false, proxyRequestUrl: null })));
  service = await import('../requestInspection');
});
it('does not infer a protocol from the URL when no inspector is installed', async () => {
  mocks.prepare.mockResolvedValue({});
  expect(await service.inspectBrowserRequest({ url: 'https://example.test/h5/vendor.operation/1/' })).toBeNull();
  expect(mocks.run).not.toHaveBeenCalled();
});
it('retains custom deployment IDs and rejects invalid annotations', async () => {
  mocks.run.mockResolvedValueOnce([{ apiName: 'example.query', isProxy: false, proxyRequestUrl: null, environment: 'qa-east.2' }]);
  expect(await service.inspectBrowserRequest({ url: 'https://example.test/query' })).toMatchObject({ environment: 'qa-east.2' });
  mocks.run.mockResolvedValueOnce([{ apiName: 'example.query', isProxy: false, proxyRequestUrl: null, environment: 'bad\nvalue' }]);
  await expect(service.inspectBrowserRequest({ url: 'https://example.test/query' })).rejects.toThrow('Invalid request metadata');
});
it('batches a burst and preserves accepted implementations across replacement', async () => {
  const results = await Promise.all(Array.from({ length: 70 }, (_, id) => service.inspectBrowserRequest({ url: String(id) })));
  expect(results.map(value => value?.apiName)).toEqual(Array.from({ length: 70 }, (_, id) => String(id)));
  expect(mocks.run.mock.calls.map(([value]) => value.input.length)).toEqual([32, 32, 6]);
  service.invalidateRequestInspection(); mocks.prepare.mockResolvedValue(accepted('next'));
  await service.inspectBrowserRequest({ url: 'new' });
  expect(mocks.run.mock.lastCall?.[0].handler).toBe('next');
});
it('isolates invalid annotations and retries a failed selection without hiding errors', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('selection failed'));
  await expect(service.inspectBrowserRequest({ url: 'first' })).rejects.toThrow('selection failed');
  mocks.run.mockResolvedValueOnce([{}, null]);
  const results = await Promise.allSettled([service.inspectBrowserRequest({ url: 'bad' }), service.inspectBrowserRequest({ url: 'ordinary' })]);
  expect(results[0]).toMatchObject({ status: 'rejected' });
  expect(results[1]).toEqual({ status: 'fulfilled', value: null });
});
