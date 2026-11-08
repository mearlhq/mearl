import { describe, expect, it } from 'vitest';
import type { CapturedRequest } from '../types.js';
import {
  appendRequestToBuffer,
  createRequestBufferAccounting,
  estimateRequestBufferBytes,
  refreshRequestInBuffer,
} from '../boundedRequestBuffer.js';

function makeRequest(id: number, responseBody: any = null): CapturedRequest {
  return {
    id,
    timestamp: '',
    timestampMs: id,
    method: 'GET',
    url: `https://example.com/${id}`,
    apiName: `request.${id}`,
    status: 200,
    statusText: 'OK',
    headers: [],
    responseHeaders: [],
    queryString: [],
    postData: null,
    responseBody,
    isProxy: false,
    proxyRequestUrl: null,
    proxyData: null,
  };
}

describe('bounded request buffer', () => {
  it('keeps the newest entries when the count limit is reached', () => {
    const requests: CapturedRequest[] = [];
    const accounting = createRequestBufferAccounting();

    for (let id = 1; id <= 3; id++) {
      appendRequestToBuffer(requests, accounting, makeRequest(id), { maxEntries: 2 });
    }

    expect(requests.map(request => request.id)).toEqual([2, 3]);
  });

  it('evicts old entries when the byte budget is reached', () => {
    const requests: CapturedRequest[] = [];
    const accounting = createRequestBufferAccounting();
    const first = makeRequest(1, 'a'.repeat(600));
    const second = makeRequest(2, 'b'.repeat(600));
    const maxBytes = estimateRequestBufferBytes(first) + 100;

    appendRequestToBuffer(requests, accounting, first, { maxBytes });
    appendRequestToBuffer(requests, accounting, second, { maxBytes });

    expect(requests.map(request => request.id)).toEqual([2]);
    expect(accounting.totalBytes).toBeLessThanOrEqual(maxBytes);
  });

  it('caps a response body added after the request completes', () => {
    const requests: CapturedRequest[] = [];
    const accounting = createRequestBufferAccounting();
    const request = makeRequest(1);
    appendRequestToBuffer(requests, accounting, request, { maxFieldBytes: 100 });

    request.responseBody = { payload: '多'.repeat(200) };
    refreshRequestInBuffer(requests, accounting, request, { maxFieldBytes: 100 });

    expect(request.responseBody).toMatch(/^<truncated: \d+ bytes, buffered preview>/);
    expect(new TextEncoder().encode(request.responseBody).byteLength).toBeLessThanOrEqual(100);
  });
});
