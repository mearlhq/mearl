import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), authorize: vi.fn(), cookies: vi.fn(), resolve: vi.fn(), sign: vi.fn(), error: vi.fn(), run: vi.fn() }));
vi.mock('../browserCapabilities', () => ({ prepareBrowserCapabilities: mocks.prepare, authorizeBrowserCapabilityUrl: mocks.authorize }));
vi.mock('../browserPureCapabilities', () => ({ runAcceptedBrowserPureCapability: mocks.run }));
vi.mock('../utils/dnr', () => ({ collectCookies: mocks.cookies }));
import { prepareProtocolRequest } from '../requestProtocol';
let handlers: Record<string, any>;
const resolved = { api: 'fixture.api', requestData: { text: '中文' }, normalizedMethod: 'POST', gatewayUrl: 'https://api.example.test/', customHeaders: { 'X-Fixture': 'value' }, timeout: 1000 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue(resolved);
  mocks.sign.mockResolvedValue({ ...resolved, targetUrl: 'https://api.example.test/signed', requestHeaders: { Accept: 'application/json' }, cookieHeader: 'session=secret', body: 'data=fixture' });
  mocks.error.mockResolvedValue('Original protocol error');
  const entry = (invoke: any, handler: string) => ({ bundleId: 'fixture', revision: 'accepted', invoke, invocation: { handler } });
  mocks.run.mockImplementation(input => ({ resolve: mocks.resolve, prepare: mocks.sign, error: mocks.error }[input.handler as 'resolve' | 'prepare' | 'error'])(input.input));
  handlers = { 'request.protocol.resolve': entry(mocks.resolve, 'resolve'), 'request.protocol.prepare': entry(mocks.sign, 'prepare'), 'request.protocol.streamError': entry(mocks.error, 'error') };
  mocks.prepare.mockResolvedValue(handlers);
  mocks.authorize.mockImplementation(async input => new URL(input));
  mocks.cookies.mockResolvedValue([{ name: 'session', value: 'secret' }]);
});
it('captures one implementation, authorizes Cookie lookup and signed destination and hydrates URLs', async () => {
  const input = { api: 'fixture.api', data: { text: '中文' } };
  const result = await prepareProtocolRequest(input, true);
  expect(mocks.resolve).toHaveBeenCalledWith(input);
  expect(mocks.cookies).toHaveBeenCalledWith(new URL(resolved.gatewayUrl));
  expect(mocks.sign).toHaveBeenCalledWith({ resolved, cookies: [{ name: 'session', value: 'secret' }], stream: true });
  expect(mocks.authorize.mock.calls.map(([url]) => url)).toEqual(['https://api.example.test/', 'https://api.example.test/signed']);
  expect(result.targetUrl).toEqual(new URL('https://api.example.test/signed'));
  expect(result.requestData).toEqual({ text: '中文' });
  mocks.prepare.mockResolvedValue({});
  expect((await result.streamError('expired')).message).toBe('Original protocol error');
  expect(mocks.error).toHaveBeenCalledWith({ text: 'expired' });
});
it('preserves validated annotations from the accepted protocol', async () => {
  const metadata = { apiName: 'fixture.api', namespace: 'sample', environment: 'qa', isProxy: false, proxyRequestUrl: null };
  mocks.resolve.mockResolvedValue({ ...resolved, metadata });
  expect((await prepareProtocolRequest({ api: 'fixture.api' }, true)).metadata).toEqual(metadata);
  mocks.sign.mockResolvedValue({ ...resolved, targetUrl: 'https://api.example.test/', metadata: { ...metadata, environment: 'bad\nvalue' } });
  await expect(prepareProtocolRequest({ api: 'fixture.api' }, true)).rejects.toThrow('Invalid request metadata');
});
it('does not expose Cookies or execute partial/mixed protocol implementations', async () => {
  mocks.prepare.mockResolvedValue({});
  await expect(prepareProtocolRequest({ api: 'fixture.api' }, false)).rejects.toThrow('NOT_INSTALLED');
  mocks.prepare.mockResolvedValue({ ...handlers, 'request.protocol.prepare': { ...handlers['request.protocol.prepare'], revision: 'replacement' } });
  await expect(prepareProtocolRequest({ api: 'fixture.api' }, false)).rejects.toThrow('one implementation');
  expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.cookies).not.toHaveBeenCalled();
});
it('rejects an unauthorized gateway before reading any Cookie', async () => {
  mocks.authorize.mockRejectedValue(new Error('domain denied'));
  await expect(prepareProtocolRequest({ api: 'fixture.api' }, false)).rejects.toThrow('domain denied');
  expect(mocks.cookies).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
});
it('rejects an unauthorized signed destination before the caller can send it', async () => {
  mocks.authorize.mockResolvedValueOnce(new URL(resolved.gatewayUrl)).mockRejectedValueOnce(new Error('signed domain denied'));
  await expect(prepareProtocolRequest({ api: 'fixture.api' }, false)).rejects.toThrow('signed domain denied');
});

it('passes ordered duplicate Cookies unchanged to the accepted protocol implementation', async () => {
  mocks.cookies.mockResolvedValue([{ name: 'session', value: 'scoped' }, { name: 'session', value: 'root' }]);
  const result = await prepareProtocolRequest({ api: 'fixture.api' }, false);
  expect(mocks.sign.mock.calls[0][0].cookies).toEqual([{ name: 'session', value: 'scoped' }, { name: 'session', value: 'root' }]);
  expect(result.cookies).toEqual([{ name: 'session', value: 'scoped' }, { name: 'session', value: 'root' }]);
});
