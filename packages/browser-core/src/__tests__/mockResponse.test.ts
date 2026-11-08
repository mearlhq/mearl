import { describe, expect, it } from 'vitest';
import { prepareMockResponseHeaders, serializeMockResponse } from '../mockResponse.js';

describe('mock response', () => {
  it('serializes plain JSON responses without a transport wrapper', () => {
    expect(serializeMockResponse('https://api.example/data', { ok: true })).toEqual({
      body: '{"ok":true}',
      isJsonp: false,
    });
  });

  it('wraps the response with a validated JSONP callback', () => {
    expect(
      serializeMockResponse('https://api.example/data?callback=window.mtopjsonp42', { ok: true }),
    ).toEqual({
      body: 'window.mtopjsonp42({"ok":true});',
      isJsonp: true,
    });
  });

  it('serializes non-JSON strings as JSONP string values', () => {
    expect(serializeMockResponse('https://api.example/data?jsonp=callback_7', 'hello')).toEqual({
      body: 'callback_7("hello");',
      isJsonp: true,
    });
  });

  it('does not execute an invalid callback expression', () => {
    expect(
      serializeMockResponse('https://api.example/data?callback=alert(1)', { ok: true }),
    ).toEqual({
      body: '{"ok":true}',
      isJsonp: false,
    });
  });

  it('prepares executable JSONP headers and removes stale body encodings', () => {
    expect(
      prepareMockResponseHeaders(
        [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Content-Encoding', value: 'gzip' },
          { name: 'Content-Length', value: '123' },
          { name: 'X-Test', value: 'kept' },
        ],
        true,
      ),
    ).toEqual([
      { name: 'Content-Type', value: 'application/javascript; charset=utf-8' },
      { name: 'X-Test', value: 'kept' },
    ]);
  });
});
