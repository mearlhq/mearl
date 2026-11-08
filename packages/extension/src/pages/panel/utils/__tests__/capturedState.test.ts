import { describe, expect, it } from 'vitest';
import type { CapturedRequest, ResponseOverride, RumEvent } from '../../types';
import {
  acceptsCollectorRequest,
  acceptsDebuggerCapture,
  mergeCapturedEvents,
  mergeCapturedRequests,
} from '../capturedState';

function makeRequest(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: 1,
    timestamp: '2026/09/11 12:00:00',
    timestampMs: 1_000,
    method: 'GET',
    url: 'https://example.com/h5/sample.api.test/1.0/',
    apiName: 'sample.api.test',
    status: 0,
    statusText: '',
    headers: [],
    responseHeaders: [],
    queryString: [],
    postData: null,
    responseBody: null,
    isProxy: false,
    proxyRequestUrl: null,
    proxyData: null,
    source: 'protocol',
    ...overrides,
  };
}

describe('captured panel state', () => {
  it('accepts debugger records only inside the active debugger capture window', () => {
    expect(acceptsDebuggerCapture({ source: 'debugger', debuggerSince: 1_000 }, 1_000)).toBe(true);
    expect(acceptsDebuggerCapture({ source: 'debugger', debuggerSince: 1_000 }, 999)).toBe(false);
    expect(acceptsDebuggerCapture({ source: 'devtools', debuggerSince: 0 }, 2_000)).toBe(false);
    expect(
      acceptsCollectorRequest(
        { source: 'devtools', debuggerSince: 0 },
        makeRequest({ captureTransport: 'background' }),
      ),
    ).toBe(true);
  });

  it('updates a request in place and retains panel-only annotations', () => {
    const responseOverride = {
      id: 'override-1',
      apiName: 'sample.api.test',
      modifiedData: { ok: true },
    } as ResponseOverride;
    const existing = makeRequest({ responseOverride, isAutoTranslated: true });
    const completed = makeRequest({
      status: 200,
      statusText: 'OK',
      responseBody: { data: 1 },
      isPending: false,
    });

    expect(mergeCapturedRequests([existing], [completed])).toEqual([
      expect.objectContaining({
        id: 1,
        status: 200,
        responseOverride,
        isAutoTranslated: true,
      }),
    ]);
  });

  it('reconciles an injected SSE request with its background capture', () => {
    const injected = makeRequest({
      id: 9,
      timestampMs: 1_100,
      isSSE: true,
      isPending: false,
      _createdByInjected: true,
      _internalRequestId: 'sse-1',
      sseMessages: [{ event: 'message', data: '{"ok":true}' }],
      responseBody: { event: 'message', data: { ok: true } },
    });
    const captured = makeRequest({
      id: 10,
      timestampMs: 1_000,
      captureSequence: 1,
      isPending: true,
    });

    expect(mergeCapturedRequests([injected], [captured])).toEqual([
      expect.objectContaining({
        id: 10,
        captureSequence: 1,
        _internalRequestId: 'sse-1',
        sseMessages: injected.sseMessages,
        responseBody: injected.responseBody,
      }),
    ]);
  });

  it('upserts events and removes evicted entries', () => {
    const first = { id: 'first', event_type: 'view' } as RumEvent;
    const second = { id: 'second', event_type: 'CLK' } as RumEvent;

    expect(mergeCapturedEvents([first], [second], ['first'])).toEqual([second]);
  });
});
