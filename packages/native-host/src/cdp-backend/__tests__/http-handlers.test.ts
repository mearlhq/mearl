import { afterEach, describe, expect, it, vi } from 'vitest';
const capability = vi.hoisted(() => ({ resolveRequest: vi.fn(), prepareRequest: vi.fn(), consumeResponse: vi.fn() }));
vi.mock('../../capability-contracts.js', () => ({ getRequestProtocolCapability: () => capability }));
import { cdpSendProtocolStreamRequest } from '../http-handlers.js';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('capability-backed request transport', () => {
  it('delegates ordered duplicate Cookies to the protocol and synchronizes response Cookies', async () => {
    const response = new Response('fixture stream', { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'session=renewed; Secure; Path=/' } });
    const fetcher = vi.fn(async () => response); vi.stubGlobal('fetch', fetcher);
    const metadata = { apiName: 'fixture', namespace: 'sample', environment: 'qa', isProxy: false, proxyRequestUrl: null };
    const resolved = { gatewayUrl: new URL('https://api.example.com/stream'), api: 'fixture', timeout: 1000, metadata };
    capability.resolveRequest.mockReturnValue(resolved);
    capability.prepareRequest.mockReturnValue({ ...resolved, targetUrl: new URL('https://api.example.com/stream'), normalizedMethod: 'POST', requestHeaders: { Accept: 'text/event-stream' }, cookieHeader: 'session=scoped; session=fixture', body: 'payload' });
    capability.consumeResponse.mockImplementation(async (_response, emit) => { await emit({ data: { text: '中文' } }); return { complete: true }; });
    const session = { client: { sendCommand: vi.fn(async () => ({ cookies: [{ name: 'session', value: 'scoped', domain: 'api.example.com', path: '/stream' }, { name: 'session', value: 'fixture', domain: 'api.example.com', path: '/' }] })) } } as any;
    const onRequestPrepared = vi.fn(), onResponse = vi.fn(), onReceive = vi.fn();
    const input = { api: 'fixture' };
    const result = await cdpSendProtocolStreamRequest(session, input, { onRequestPrepared, onResponse, onReceive });
    expect(capability.resolveRequest).toHaveBeenCalledWith(input);
    expect(capability.prepareRequest).toHaveBeenCalledWith(resolved, [{ name: 'session', value: 'scoped', domain: 'api.example.com', path: '/stream' }, { name: 'session', value: 'fixture', domain: 'api.example.com', path: '/' }], true);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.example.com/stream');
    expect(fetcher.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', body: 'payload', headers: { Cookie: 'session=scoped; session=fixture', Accept: 'text/event-stream' } }));
    expect(result.cookieSync).toEqual({ updatedCount: 1, rejectedCount: 0, failedCount: 0 });
    expect(session.client.sendCommand).toHaveBeenCalledWith('Network.setCookie', expect.objectContaining({ name: 'session', value: 'renewed' }));
    expect(onRequestPrepared).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', url: 'https://api.example.com/stream', metadata }));
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
    expect(onReceive).toHaveBeenCalledWith({ text: '中文' }); expect(result.response).toEqual({ complete: true });
  });
});
