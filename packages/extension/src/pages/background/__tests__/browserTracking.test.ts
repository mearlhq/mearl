import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), run: vi.fn() }));
vi.mock('../browserCapabilities', () => ({ prepareBrowserCapabilities: mocks.prepare }));
vi.mock('../browserPureCapabilities', () => ({ runAcceptedBrowserPureCapability: mocks.run }));
const accepted = (handler: string) => ({ 'tracking.decode': { bundleId: 'fixture', revision: handler, invocation: { handler } } });
let service: typeof import('../browserTracking');
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  mocks.prepare.mockResolvedValue(accepted('first'));
  mocks.run.mockImplementation(async ({ input }) => input.map((value: any) => ({ tracking: true, events: [{ id: value.body.id, source: 'rum' }] })));
  service = await import('../browserTracking');
});
it('batches a burst without creating a sandbox invocation per request and preserves result order', async () => {
  const output = await Promise.all(Array.from({ length: 70 }, (_, id) => service.decodeBrowserTrackingRequest({ url: 'https://example.test/', body: { id } })));
  expect(output.map(value => value.events[0].id)).toEqual(Array.from({ length: 70 }, (_, id) => id));
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.run.mock.calls.map(([value]) => value.input.length)).toEqual([32, 32, 6]);
});
it('copies call data immediately and retains the accepted implementation for a body retry', async () => {
  const decode = service.captureBrowserTrackingDecoder();
  const input = { url: 'https://example.test/', body: { id: 'original' } };
  const first = decode(input); input.body.id = 'mutated';
  expect((await first).events[0].id).toBe('original');
  service.invalidateBrowserTracking(); mocks.prepare.mockResolvedValue(accepted('replacement'));
  await service.decodeBrowserTrackingRequest({ url: input.url, body: { id: 'new' } });
  await decode({ url: input.url, body: { id: 'retry' } });
  expect(mocks.run.mock.calls.map(([value]) => value.handler)).toEqual(['first', 'replacement', 'first']);
});
it('finishes accepted calls across an update and selects the replacement for new requests', async () => {
  let finish!: (value: unknown) => void;
  mocks.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = service.decodeBrowserTrackingRequest({ url: 'https://example.test/', body: { id: 'old' } });
  await vi.waitFor(() => expect(finish).toBeDefined());
  service.invalidateBrowserTracking(); mocks.prepare.mockResolvedValue(accepted('replacement'));
  const next = service.decodeBrowserTrackingRequest({ url: 'https://example.test/', body: { id: 'new' } });
  finish([{ tracking: true, events: [{ id: 'old' }] }]);
  expect((await first).events[0].id).toBe('old'); expect((await next).events[0].id).toBe('new');
});
it('distinguishes an absent capability from an installed decoder failure and retries failed selection', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('graph unavailable'));
  await expect(service.decodeBrowserTrackingRequest({ url: 'https://example.test/' })).rejects.toThrow('graph unavailable');
  mocks.prepare.mockResolvedValue({});
  expect(await service.decodeBrowserTrackingRequest({ url: 'https://example.test/' })).toEqual({ available: true, tracking: false, events: [] });
  expect(mocks.run).not.toHaveBeenCalled();
  service.invalidateBrowserTracking(); mocks.prepare.mockResolvedValue(accepted('installed')); mocks.run.mockRejectedValue(new Error('decoder failed'));
  await expect(service.decodeBrowserTrackingRequest({ url: 'https://example.test/' })).rejects.toThrow('decoder failed');
});
it('rejects partial or invalid batch results for every waiting request', async () => {
  mocks.run.mockResolvedValue([]);
  const results = await Promise.allSettled([service.decodeBrowserTrackingRequest({ url: 'https://example.test/' }), service.decodeBrowserTrackingRequest({ url: 'https://example.test/' })]);
  expect(results.every(value => value.status === 'rejected' && value.reason.message === 'Invalid tracking decoder result')).toBe(true);
});

it('rejects only the malformed request while committing other rows in its batch', async () => {
  mocks.run.mockResolvedValue([{ tracking: true, events: [], error: 'malformed event' }, { tracking: false, events: [] }]);
  const output = await Promise.allSettled([service.decodeBrowserTrackingRequest({ url: 'https://example.test/bad' }), service.decodeBrowserTrackingRequest({ url: 'https://example.test/ordinary' })]);
  expect(output[0]).toMatchObject({ status: 'rejected', reason: { name: 'TrackingRequestError', message: 'malformed event' } });
  expect(output[1]).toEqual({ status: 'fulfilled', value: { available: true, tracking: false, events: [] } });
});

it('decodes basic protocols and point identifiers with no preset or sandbox', async () => {
  mocks.prepare.mockResolvedValue({});
  const click = await service.decodeBrowserTrackingRequest({ url: 'https://gm.mmstat.com/aplus.clk?gmkey=CLK&gokey=spm%3D1.2.button.submit', options: { sequence: 8, now: 1000 } });
  expect(click).toMatchObject({ available: true, tracking: true, events: [{ source: 'aplus', name: '1.2.button.submit', event_type: 'CLK', id: 'aplus-8-1000' }] });
  expect(click.events[0]).not.toHaveProperty('validation');
  const rum = await service.decodeBrowserTrackingRequest({ url: 'https://demo.rum.aliyuncs.com/report', body: { events: [{ event_type: 'action', name: 'submit' }] } });
  expect(rum.events).toMatchObject([{ source: 'rum', name: 'submit' }]);
  const arms = await service.decodeBrowserTrackingRequest({ url: 'https://arms-retcode.aliyuncs.com/r.png?t=api&page=Home' });
  expect(arms.events).toMatchObject([{ source: 'arms', event_type: 'api' }]);
  expect(await service.resolveBrowserTrackingSpm({ eventType: 'CLK', raw: { gokey: 'spm=1.2.button.submit' } })).toEqual({ mainSpm: '1.2.button.submit', highlightSpm: '1.2.button.submit' });
  expect(mocks.run).not.toHaveBeenCalled();
});
it('uses an installed point resolver together with its decoder', async () => {
  const handler = { bundleId: 'fixture', revision: 'same', invocation: { handler: 'custom' } };
  mocks.prepare.mockResolvedValue({ 'tracking.decode': handler, 'tracking.spm': handler });
  mocks.run.mockResolvedValue({ mainSpm: 'custom', highlightSpm: 'custom' });
  expect(await service.resolveBrowserTrackingSpm({ raw: {} })).toEqual({ mainSpm: 'custom', highlightSpm: 'custom' });
});
