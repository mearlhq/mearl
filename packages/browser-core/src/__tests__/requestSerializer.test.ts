import { describe, it, expect } from 'vitest';
import { setValueByPath, serializeRequest } from '../requestSerializer';
import type { CapturedRequest } from '../types';

function makeRequest(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: 1,
    timestamp: '2026-07-08T00:00:00.000Z',
    timestampMs: 1_000,
    method: 'POST',
    url: 'https://h5api.m.shop.com/h5/mtop.example.get/1.0/',
    apiName: 'mtop.example.get',
    status: 200,
    statusText: 'OK',
    headers: [{ name: 'x-req', value: '1' }],
    responseHeaders: [{ name: 'x-res', value: '2' }],
    queryString: [{ name: 'data', value: '{}' }],
    postData: { foo: 'bar' },
    responseBody: { data: { list: [{ id: 7 }] }, ret: ['SUCCESS::调用成功'] },
    isProxy: false,
    proxyRequestUrl: null,
    proxyData: null,
    duration: 42,
    ...overrides,
  };
}

describe('setValueByPath', () => {
  it('sets a nested object value', () => {
    const obj: Record<string, unknown> = {};
    setValueByPath(obj, 'a.b.c', 5);
    expect(obj).toEqual({ a: { b: { c: 5 } } });
  });

  it('creates arrays for numeric path segments', () => {
    const obj: Record<string, unknown> = {};
    setValueByPath(obj, 'list[0].name', 'x');
    expect(obj).toEqual({ list: [{ name: 'x' }] });
  });

  it('overwrites an existing leaf', () => {
    const obj = { a: { b: 1 } };
    setValueByPath(obj, 'a.b', 2);
    expect(obj.a.b).toBe(2);
  });
});

describe('serializeRequest', () => {
  it('includes body but omits headers by default', () => {
    const out = serializeRequest(makeRequest({ isSSE: true }));
    expect(out.apiName).toBe('mtop.example.get');
    expect(out.isSSE).toBe(true);
    expect(out.postData).toEqual({ foo: 'bar' });
    expect(out.responseBody).toMatchObject({ ret: ['SUCCESS::调用成功'] });
    expect(out.headers).toBeUndefined();
    expect(out.responseHeaders).toBeUndefined();
  });

  it('includes headers when asked', () => {
    const out = serializeRequest(makeRequest(), { includeHeaders: true });
    expect(out.headers).toEqual([{ name: 'x-req', value: '1' }]);
    expect(out.responseHeaders).toEqual([{ name: 'x-res', value: '2' }]);
  });

  it('omits bodies when includeBody is false', () => {
    const out = serializeRequest(makeRequest(), { includeBody: false });
    expect(out).not.toHaveProperty('postData');
    expect(out).not.toHaveProperty('responseBody');
  });

  it('returns only structure in keysOnly mode', () => {
    const out = serializeRequest(makeRequest(), { keysOnly: true });
    expect(out.postData).toBeUndefined();
    expect(out.postDataStructure).toEqual({ foo: 'string' });
    expect(out.responseBodyStructure).toMatchObject({
      data: { list: { _type: 'array[1]', _sample: { id: 'number' } } },
    });
  });

  it('truncates a body over maxBodySize', () => {
    const big = { blob: 'x'.repeat(500) };
    const out = serializeRequest(makeRequest({ responseBody: big }), { maxBodySize: 50 });
    expect(typeof out.responseBody).toBe('string');
    expect(out.responseBody).toMatch(/^<truncated: \d+ bytes, showing first 50 chars>/);
  });

  it('extracts requested fields from the response body', () => {
    const out = serializeRequest(makeRequest(), { fields: ['data.list[0].id', 'ret[0]'] });
    expect(out.extractedFields).toEqual({
      'data.list[0].id': 7,
      'ret[0]': 'SUCCESS::调用成功',
    });
    expect(out).not.toHaveProperty('postData');
    expect(out).not.toHaveProperty('responseBody');
  });

  it('can explicitly include complete bodies alongside extracted fields', () => {
    const request = makeRequest();
    const out = serializeRequest(request, { fields: ['data.list[0].id'], includeBody: true });
    expect(out.responseBody).toBe(request.responseBody);
    expect(out.postData).toBe(request.postData);
    expect(out.extractedFields).toEqual({ 'data.list[0].id': 7 });
  });

  it('keeps bodies by default when the field selection is empty', () => {
    const request = makeRequest();
    expect(serializeRequest(request, { fields: [] }).responseBody).toBe(request.responseBody);
  });
});
