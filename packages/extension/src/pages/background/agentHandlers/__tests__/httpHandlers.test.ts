import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_REQUEST_MAX_TOTAL_FILE_BYTES } from '@mearl/browser-core';

const protocolMocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../../requestProtocol', () => ({ prepareProtocolRequest: protocolMocks.prepare }));

const dnrMocks = vi.hoisted(() => ({
  collectCookies: vi.fn(),
  buildDnrHeaders: vi.fn(),
  fetchWithDnr: vi.fn(),
}));

vi.mock('../../utils/dnr', () => ({
  collectCookies: dnrMocks.collectCookies,
  buildDnrHeaders: dnrMocks.buildDnrHeaders,
  fetchWithDnr: dnrMocks.fetchWithDnr,
}));

import { handleSendProtocolRequest, handleSendProtocolStreamRequest, handleSendRequest } from '../httpHandlers';
import {
  handleSendRequestFileAbort,
  handleSendRequestFileChunk,
  handleSendRequestFileStart,
} from '../sendRequestFileTransfer';

describe('send_request multipart extension execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dnrMocks.collectCookies.mockResolvedValue([{ name: 'session', value: 'browser-secret' }]);
    dnrMocks.buildDnrHeaders.mockReturnValue([]);
    dnrMocks.fetchWithDnr.mockImplementation(
      async (_targetUrl: URL, _headers: unknown, request: () => Promise<unknown>) => request(),
    );
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://img.example/logo.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it.each([true, false])(
    'uses browser-managed response cookies only when withCookies=%s',
    async withCookies => {
      await handleSendRequest({ url: 'https://example.test/refresh', withCookies });
      expect(vi.mocked(global.fetch).mock.calls[0]![1]?.credentials).toBe(
        withCookies ? 'include' : 'omit',
      );
      expect(dnrMocks.collectCookies).toHaveBeenCalledTimes(withCookies ? 1 : 0);
    },
  );

  it('sends binary bytes without multipart wrapping and keeps an explicit Content-Type', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    await handleSendRequest({
      url: 'https://example.test/upload',
      method: 'POST',
      bodyFile: { base64: btoa(String.fromCharCode(...bytes)) },
      headers: { 'content-type': 'application/custom' },
      withCookies: false,
    });
    const options = vi.mocked(global.fetch).mock.calls[0]![1]!;
    expect(options.body).toBeInstanceOf(File);
    expect(new Uint8Array(await (options.body as File).arrayBuffer())).toEqual(bytes);
    expect(options.headers).toMatchObject({ 'content-type': 'application/custom' });
    expect(options.headers).not.toHaveProperty('Content-Type');
  });

  it('consumes a transferred raw body as one file instead of FormData', async () => {
    handleSendRequestFileStart({
      transferId: 'raw-test',
      files: [{ fieldName: 'body', filename: 'body.bin', contentType: 'image/png', byteLength: 2 }],
    });
    handleSendRequestFileChunk({
      transferId: 'raw-test',
      fileIndex: 0,
      chunkIndex: 0,
      base64: 'AP8=',
    });
    await handleSendRequest({
      transferId: 'raw-test',
      binaryBody: true,
      url: 'https://example.test/upload',
      method: 'POST',
    });
    const options = vi.mocked(global.fetch).mock.calls[0]![1]!;
    expect(new Uint8Array(await (options.body as File).arrayBuffer())).toEqual(
      new Uint8Array([0, 255]),
    );
    expect(options.headers).toMatchObject({ 'Content-Type': 'image/png' });
    await expect(
      handleSendRequest({
        url: 'https://example.test/upload',
        method: 'POST',
        transferId: 'raw-test',
        binaryBody: true,
      }),
    ).rejects.toThrow('Unknown or expired file transfer');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('assembles transferred file bytes and performs the authenticated fetch in the extension', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 65, 66, 67]);
    handleSendRequestFileStart({
      transferId: 'transfer-1',
      files: [
        {
          fieldName: 'file',
          filename: 'logo.png',
          contentType: 'image/png',
          byteLength: bytes.byteLength,
        },
      ],
    });
    handleSendRequestFileChunk({
      transferId: 'transfer-1',
      fileIndex: 0,
      chunkIndex: 0,
      base64: btoa(String.fromCharCode(...bytes)),
    });

    const result = await handleSendRequest({
      transferId: 'transfer-1',
      url: 'https://content.example/upload',
      method: 'POST',
      formData: { folder: 'logos', isPrivate: false },
      withCookies: true,
    });

    expect(result.status).toBe(200);
    expect(result.attachedCookieCount).toBe(1);
    expect(dnrMocks.collectCookies).toHaveBeenCalledWith(new URL('https://content.example/upload'));
    expect(dnrMocks.buildDnrHeaders).toHaveBeenCalledWith(
      new URL('https://content.example/upload'),
      [{ name: 'session', value: 'browser-secret' }],
      false,
      {},
    );

    const fetchOptions = vi.mocked(global.fetch).mock.calls[0]![1]!;
    expect(fetchOptions.body).toBeInstanceOf(FormData);
    const multipart = fetchOptions.body as FormData;
    expect(multipart.get('folder')).toBe('logos');
    expect(multipart.get('isPrivate')).toBe('false');
    const uploadedFile = multipart.get('file') as File;
    expect(uploadedFile.name).toBe('logo.png');
    expect(uploadedFile.type).toBe('image/png');
    expect(new Uint8Array(await uploadedFile.arrayBuffer())).toEqual(bytes);
  });

  it('rejects caller-supplied multipart Content-Type so the browser can set the boundary', async () => {
    await expect(
      handleSendRequest({
        url: 'https://content.example/upload',
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data' },
        formData: { folder: 'logos' },
      }),
    ).rejects.toThrow('the browser sets the boundary');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects transferred files above the extension memory limit', () => {
    expect(() =>
      handleSendRequestFileStart({
        transferId: 'oversized-transfer',
        files: [
          {
            fieldName: 'file',
            filename: 'large.bin',
            contentType: 'application/octet-stream',
            byteLength: SEND_REQUEST_MAX_TOTAL_FILE_BYTES + 1,
          },
        ],
      }),
    ).toThrow('files total size exceeds');
  });

  it('releases idle transfer state after the TTL', () => {
    vi.useFakeTimers();
    try {
      handleSendRequestFileStart({
        transferId: 'idle-transfer',
        files: [
          {
            fieldName: 'file',
            filename: 'empty.txt',
            contentType: 'text/plain',
            byteLength: 0,
          },
        ],
      });
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(handleSendRequestFileAbort({ transferId: 'idle-transfer' })).toEqual({
        aborted: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('app bridge PROTOCOL stream execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    protocolMocks.prepare.mockImplementation(async input => ({
      api: input.api, requestData: input.data, customHeaders: {},
      metadata: { apiName: input.api, namespace: 'sample', environment: 'qa', isProxy: false, proxyRequestUrl: null },
      normalizedMethod: input.method ?? 'GET', timeout: input.timeout ?? 30_000,
      gatewayUrl: new URL('https://protocol.example.test/'),
      targetUrl: new URL('https://protocol.example.test/prepared?fixture=accepted'),
      requestHeaders: { Accept: 'text/event-stream', 'Content-Type': 'application/x-www-form-urlencoded' },
      cookies: new Map([['session', 'browser-secret']]), body: 'fixture-body',
      streamError: async (text: string) => new Error('Installed decoder: ' + text),
    }));
    dnrMocks.collectCookies.mockResolvedValue([
      { name: '_m_h5_tk', value: 'stream-token_123456' },
      { name: 'session', value: 'browser-secret' },
    ]);
    dnrMocks.buildDnrHeaders.mockReturnValue([]);
    dnrMocks.fetchWithDnr.mockImplementation(
      async (_targetUrl: URL, _headers: unknown, request: () => Promise<unknown>) => request(),
    );
  });
  it('passes regular bridge annotations to capture without enlarging the action response', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    const onRequestPrepared = vi.fn();
    const result = await handleSendProtocolRequest({ api: 'sample.query', data: { id: 1 } }, undefined, onRequestPrepared);
    expect(onRequestPrepared).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ namespace: 'sample', environment: 'qa' }) }));
    expect(result).toEqual({ success: true, response: { ok: true }, requestData: { id: 1 } });
  });

  it.each([undefined, 0])('returns the App bridge override with duration %s', async duration => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"ok":false}'));
    const selectOverride = vi.fn().mockReturnValue({ duration, responseData: '{"ok":true}' });
    const result = await handleSendProtocolRequest(
      { api: 'sample.query', data: { id: 1 } }, undefined, undefined, selectOverride,
    );
    expect(selectOverride).toHaveBeenCalledWith({
      url: 'https://protocol.example.test/prepared?fixture=accepted',
      postData: 'fixture-body',
    });
    expect(global.fetch).toHaveBeenCalledTimes(duration === undefined ? 1 : 0);
    expect(result).toEqual({ success: true, response: { ok: true }, requestData: { id: 1 } });
  });

  it('沿用已接受的协议结果并逐条解析 SSE data 行', async () => {
    dnrMocks.buildDnrHeaders.mockReturnValue([
      { header: 'Origin', operation: 'set', value: 'https://protocol.example.test' },
      { header: 'Cookie', operation: 'set', value: 'session=browser-secret' },
    ] as never);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        ': heartbeat\n\ndata: {"data":{"text":"杭"}}\n\ndata: {"data":{"text":"杭州"}}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'X-Request-Id': 'stream-123',
          },
        },
      ),
    );
    const received: unknown[] = [];
    const onRequestPrepared = vi.fn();
    const onResponse = vi.fn();
    const accepted = { modules: {}, bindings: {} };

    const result = await handleSendProtocolStreamRequest(
      {
        api: 'sample.api.ai.plan.chat',
        version: '1.0',
        data: { query: '杭州怎么玩' },
        method: 'POST',
        env: 'pre',
        timeout: 30_000,
        ttid: '201300@travel_h5_10.0.0',
      },
      data => received.push(data),
      onRequestPrepared,
      onResponse,
      accepted,
    );

    expect(received).toEqual([{ data: { text: '杭' } }, { data: { text: '杭州' } }]);
    expect(result.response).toEqual({ data: { text: '杭州' } });
    expect(onRequestPrepared).toHaveBeenCalledWith({
      metadata: { apiName: 'sample.api.ai.plan.chat', namespace: 'sample', environment: 'qa', isProxy: false, proxyRequestUrl: null },
      method: 'POST',
      url: 'https://protocol.example.test/prepared?fixture=accepted',
      requestHeaders: expect.arrayContaining([
        { name: 'Accept', value: 'text/event-stream' },
        { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
        { name: 'Origin', value: 'https://protocol.example.test' },
        { name: 'Cookie', value: 'session=browser-secret' },
      ]),
    });
    expect(onResponse).toHaveBeenCalledWith({
      status: 200,
      statusText: '',
      responseHeaders: expect.arrayContaining([
        { name: 'Content-Type', value: 'text/event-stream; charset=utf-8' },
        { name: 'X-Request-Id', value: 'stream-123' },
      ]),
    });
    const [url, options] = vi.mocked(global.fetch).mock.calls[0]!;
    const targetUrl = new URL(String(url));
    expect(targetUrl.href).toBe('https://protocol.example.test/prepared?fixture=accepted');
    expect(protocolMocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ api: 'sample.api.ai.plan.chat', method: 'POST', data: { query: '杭州怎么玩' } }), true, accepted);
    expect(dnrMocks.collectCookies).not.toHaveBeenCalled();
    expect(options).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: 'fixture-body',
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );
  });

  it('把非 SSE 的 PROTOCOL 错误响应转成失败', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      handleSendProtocolStreamRequest({ api: 'sample.api.ai.plan.chat', data: {}, env: 'pre' }, vi.fn()),
    ).rejects.toThrow('Installed decoder:');
  });
});
