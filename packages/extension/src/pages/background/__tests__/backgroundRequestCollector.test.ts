vi.mock('../requestInspection', async () => { const { requestMetadataFixture } = await import('../../../test/fixtures/requestMetadata'); return { inspectBrowserRequest: vi.fn(async input => requestMetadataFixture(input)) }; });
import { trackingEvent } from '../../../test/fixtures/tracking';
const decoder = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock('../browserTracking', () => ({ captureBrowserTrackingDecoder: () => decoder.decode }));
vi.mock('../../panel/utils/i18n', () => ({ getCurrentLanguage: () => 'en' }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupCollector,
  flushRequestCollection,
  getCaptureCheckpoint,
  getCollectedEvents,
  getCollectedLogs,
  getCollectedRequests,
  getCollectorSnapshot,
  isCollecting,
  recordBackgroundCapturedRequest,
  recordBackgroundProtocolStreamChunk,
  recordBackgroundProtocolStreamEnd,
  recordBackgroundProtocolStreamResponse,
  recordBackgroundProtocolStreamStart,
  registerRequestCollectionWebView,
  setCollectorUpdateListener,
  startRequestCollection,
  stopRequestCollection,
} from '../backgroundRequestCollector';
import {
  acquireDebuggerLease,
  cleanupDebuggerSession,
  handleDebuggerSessionDetach,
} from '../debuggerSessionManager';

let debuggerEventListener:
  | ((source: chrome.debugger.Debuggee & { sessionId?: string }, method: string, params: any) => void)
  | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  decoder.decode.mockReset().mockResolvedValue({ available: true, tracking: false, events: [] });
  chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
  chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});
  chrome.debugger.onEvent = {
    addListener: vi.fn(listener => {
      debuggerEventListener = listener as typeof debuggerEventListener;
    }),
    removeListener: vi.fn(),
  } as any;
});

afterEach(() => {
  setCollectorUpdateListener(null);
});


describe('background request collector debugger lifecycle', () => {
  it('reads independent response bodies from WebView sessions sharing a CDP request ID', async () => {
    const tabId = 2208;
    const left = { tabId, sessionId: 'left' };
    const right = { tabId, sessionId: 'right' };
    chrome.debugger.sendCommand = vi.fn(async (target, method) => method === 'Network.getResponseBody'
      ? { body: JSON.stringify({ session: target.sessionId }), base64Encoded: false }
      : {});
    try {
      await registerRequestCollectionWebView(tabId, left.sessionId);
      await startRequestCollection(tabId, 'device-preview-panel');
      await registerRequestCollectionWebView(tabId, right.sessionId);
      await startRequestCollection(tabId, 'agent');
      for (const target of [left, right]) {
        expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(target, 'Network.enable', expect.any(Object));
        debuggerEventListener?.(target, 'Network.requestWillBeSent', {
          requestId: '42',
          request: { url: `https://example.test/${target.sessionId}`, method: 'GET' },
          type: 'Fetch',
          timestamp: 1,
        });
      }
      for (const target of [right, left]) {
        debuggerEventListener?.(target, 'Network.loadingFinished', { requestId: '42', timestamp: 1.1 });
      }
      await vi.waitFor(() => expect(getCollectorSnapshot(tabId).requests.map(request => request.responseBody))
        .toEqual([{ session: 'left' }, { session: 'right' }]));
      await stopRequestCollection(tabId, 'device-preview-panel');
      expect(isCollecting(tabId)).toBe(true);
      await stopRequestCollection(tabId, 'agent');
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(right, 'Network.disable', undefined);
    } finally {
      cleanupCollector(tabId);
      cleanupDebuggerSession(tabId);
    }
  });

  it('streams one canonical request through updates and captures background Protocol requests', async () => {
    chrome.debugger.sendCommand = vi
      .fn()
      .mockImplementation((_target, method) =>
        Promise.resolve(
          method === 'Network.getResponseBody'
            ? { body: JSON.stringify({ data: { mocked: true } }), base64Encoded: false }
            : {},
        ),
      );
    await startRequestCollection(2209);
    const updates: any[] = [];
    setCollectorUpdateListener((tabId, update) => {
      updates.push({ tabId, update: structuredClone(update) });
    });

    debuggerEventListener?.({ tabId: 2209 }, 'Network.requestWillBeSent', {
      requestId: 'mocked-request',
      request: {
        url: 'https://h5api.m.shop.com/h5/sample.api.refund.apply/1.0/',
        method: 'POST',
        postData: JSON.stringify({ orderId: '1' }),
        headers: { accept: 'application/json' },
      },
      type: 'Fetch',
      timestamp: 10,
      wallTime: 1_700_000_000,
    });
    debuggerEventListener?.({ tabId: 2209 }, 'Network.responseReceived', {
      requestId: 'mocked-request',
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      },
    });
    debuggerEventListener?.({ tabId: 2209 }, 'Network.loadingFinished', {
      requestId: 'mocked-request',
      timestamp: 10.2,
      encodedDataLength: 42,
    });

    await vi.waitFor(() => {
      expect(getCollectorSnapshot(2209).requests[0]?.responseBody).toEqual({
        data: { mocked: true },
      });
    });
    const requestUpdates = updates.filter(item => item.update.type === 'request');
    expect(requestUpdates.length).toBeGreaterThanOrEqual(3);
    expect(new Set(requestUpdates.map(item => item.update.request.id)).size).toBe(1);
    expect(requestUpdates.at(-1)).toMatchObject({
      tabId: 2209,
      update: {
        request: {
          apiName: 'sample.api.refund.apply',
          status: 200,
          isPending: false,
          responseBody: { data: { mocked: true } },
        },
      },
    });

    expect(
      recordBackgroundCapturedRequest(2209, {
        api: 'sample.api.bridge.request',
        namespace: 'trip',
        environment: 'pre',
        requestData: { id: 1 },
        response: { data: { ok: true } },
        success: true,
        duration: 12,
        timestampMs: 1_700_000_001_000,
      }),
    ).toBe(true);
    expect(getCollectorSnapshot(2209).requests).toContainEqual(
      expect.objectContaining({
        apiName: 'sample.api.bridge.request',
        namespace: 'trip',
        environment: 'pre',
        responseBody: { data: { ok: true } },
      }),
    );

    debuggerEventListener?.({ tabId: 2209 }, 'Network.requestWillBeSent', {
      requestId: 'image-resource',
      request: { url: 'https://example.com/assets/icon.png', method: 'GET' },
      type: 'Image',
      timestamp: 11,
      wallTime: 1_700_000_002,
    });
    await flushRequestCollection(2209);
    expect(getCollectorSnapshot(2209).requests).toHaveLength(3);
    expect(getCollectedRequests(2209, { source: 'all' }).requests).toEqual([
      expect.objectContaining({ apiName: 'sample.api.refund.apply' }),
      expect.objectContaining({ apiName: 'sample.api.bridge.request' }),
    ]);

    await stopRequestCollection(2209);
    cleanupCollector(2209);
    cleanupDebuggerSession(2209);
  });

  it('forwards background Protocol requests without attaching the debugger collector', () => {
    const updates: any[] = [];
    setCollectorUpdateListener((tabId, update) => updates.push({ tabId, update }));

    expect(
      recordBackgroundCapturedRequest(2211, {
        api: 'sample.api.bridge.request',
        requestData: { id: 1 },
        response: { data: { ok: true } },
        success: true,
        duration: 12,
        timestampMs: 1_700_000_001_000,
      }),
    ).toBe(true);

    expect(isCollecting(2211)).toBe(false);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(updates).toEqual([
      expect.objectContaining({
        tabId: 2211,
        update: expect.objectContaining({
          type: 'request',
          request: expect.objectContaining({
            apiName: 'sample.api.bridge.request',
            captureTransport: 'background',
          }),
        }),
      }),
    ]);
  });

  it('keeps collecting when a concurrent page action releases its lease', async () => {
    const navigationLease = await acquireDebuggerLease(2201, {
      consumer: 'page-act-navigation',
      domains: ['Network'],
    });
    await startRequestCollection(2201);

    await navigationLease.release();

    expect(isCollecting(2201)).toBe(true);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();

    await stopRequestCollection(2201);
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2201 });
    cleanupCollector(2201);
    cleanupDebuggerSession(2201);
  });

  it('releases the shared collector only after every consumer stops', async () => {
    await startRequestCollection(2210, 'agent');
    await startRequestCollection(2210, 'response-modification');

    await stopRequestCollection(2210, 'response-modification');
    expect(isCollecting(2210)).toBe(true);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();

    await stopRequestCollection(2210, 'agent');
    expect(isCollecting(2210)).toBe(false);
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2210 });
    cleanupCollector(2210);
    cleanupDebuggerSession(2210);
  });

  it('marks collection inactive when Chrome detaches the shared session', async () => {
    await startRequestCollection(2202);
    expect(isCollecting(2202)).toBe(true);

    handleDebuggerSessionDetach(2202, 'canceled_by_user');

    expect(isCollecting(2202)).toBe(false);
    await stopRequestCollection(2202);
    cleanupCollector(2202);
    cleanupDebuggerSession(2202);
  });

  it('captures and filters RUM, aplus, and ARMS events without a panel', async () => {
    decoder.decode.mockResolvedValueOnce({ available: true, tracking: true, events: [trackingEvent({ id: 'rum-1', source: 'rum', event_type: 'view', name: 'home' })] })
      .mockResolvedValueOnce({ available: true, tracking: true, events: [trackingEvent({ id: 'aplus-1', source: 'aplus', event_type: 'CLK', name: '1.2.button.submit' })] })
      .mockResolvedValueOnce({ available: true, tracking: true, events: [trackingEvent({ id: 'arms-1', source: 'arms', event_type: 'error', name: 'checkout' })] });
    await startRequestCollection(2203);
    expect(debuggerEventListener).toBeTypeOf('function');

    debuggerEventListener?.({ tabId: 2203 }, 'Network.requestWillBeSent', {
      requestId: 'rum-1',
      request: {
        url: 'https://example.test/tracking/events',
        postData: JSON.stringify({
          events: [{ event_type: 'view', name: 'home' }],
        }),
      },
      type: 'Fetch',
    });
    debuggerEventListener?.({ tabId: 2203 }, 'Network.requestWillBeSent', {
      requestId: 'aplus-1',
      request: {
        url:
          'https://example.test/tracking/click?data=' +
          encodeURIComponent('spm=1.2.button.submit'),
      },
      type: 'Image',
    });
    debuggerEventListener?.({ tabId: 2203 }, 'Network.requestWillBeSent', {
      requestId: 'arms-1',
      request: {
        url: 'https://example.test/tracking/errors',
      },
      type: 'Image',
    });

    await flushRequestCollection(2203);
    const all = getCollectedEvents(2203, { source: 'all' });
    expect(all.events).toHaveLength(3);
    expect(all.totalInBuffer).toBe(3);

    const clicks = getCollectedEvents(2203, {
      source: 'aplus',
      event_type: 'CLK',
      filter: 'button',
    });
    expect(clicks.events).toHaveLength(1);
    expect(clicks.events[0]).toMatchObject({
      source: 'aplus',
      event_type: 'CLK',
      name: '1.2.button.submit',
    });

    await stopRequestCollection(2203);
    cleanupCollector(2203);
    cleanupDebuggerSession(2203);
  });

  it('captures console, exceptions, and pending requests after one atomic checkpoint', async () => {
    decoder.decode.mockResolvedValueOnce({ available: true, tracking: false, events: [] })
      .mockResolvedValueOnce({ available: true, tracking: true, events: [trackingEvent({ id: 'rum-submit', source: 'rum', event_type: 'action', name: 'submit' })] });
    await startRequestCollection(2206);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 2206 },
      'Network.enable',
      expect.objectContaining({ maxTotalBufferSize: expect.any(Number) }),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 2206 }, 'Runtime.enable', {});
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 2206 }, 'Log.enable', {});
    const checkpoint = getCaptureCheckpoint(2206);

    debuggerEventListener?.({ tabId: 2206 }, 'Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'submit failed' }],
      timestamp: 1_700_000_000_123,
    });
    debuggerEventListener?.({ tabId: 2206 }, 'Runtime.exceptionThrown', {
      timestamp: 1_700_000_000_124,
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: broken' } },
    });
    debuggerEventListener?.({ tabId: 2206 }, 'Network.requestWillBeSent', {
      requestId: 'pending',
      request: { url: 'https://example.com/api/submit', method: 'POST' },
      type: 'Fetch',
      timestamp: 10,
      wallTime: 1_700_000_000,
    });
    debuggerEventListener?.({ tabId: 2206 }, 'Network.requestWillBeSent', {
      requestId: 'rum',
      request: {
        url: 'https://example.test/tracking/events',
        method: 'POST',
        postData: JSON.stringify({ events: [{ event_type: 'action', name: 'submit' }] }),
      },
      type: 'Fetch',
      timestamp: 11,
      wallTime: 1_700_000_001,
    });

    await flushRequestCollection(2206);
    const logs = getCollectedLogs(2206, { after: checkpoint.cursor, level: 'error' });
    expect(logs.entries).toEqual([
      expect.objectContaining({ message: 'submit failed', timestampMs: 1_700_000_000_123 }),
      expect.objectContaining({ message: 'Error: broken', origin: 'exception' }),
    ]);
    const requests = getCollectedRequests(2206, {
      after: checkpoint.cursor,
      source: 'all',
    });
    expect(requests.requests).toEqual([
      expect.objectContaining({
        url: 'https://example.com/api/submit',
        timestampMs: 1_700_000_000_000,
        isPending: true,
        source: 'requests',
      }),
    ]);
    const events = getCollectedEvents(2206, { after: checkpoint.cursor });
    expect(events.events).toEqual([
      expect.objectContaining({ source: 'rum', event_type: 'action', name: 'submit' }),
    ]);
    expect(events.nextCursor).toContain(':events:');

    await stopRequestCollection(2206);
    cleanupCollector(2206);
    cleanupDebuggerSession(2206);
  });

  it('captures background-delegated Protocol SSE requests with chunks and cursor semantics', async () => {
    await startRequestCollection(2207);
    const checkpoint = getCaptureCheckpoint(2207);

    expect(
      recordBackgroundProtocolStreamStart(2207, {
        streamId: 'stream-1',
        api: 'sample.api.ai.plan.chat',
        namespace: 'trip',
        environment: 'pre',
        url: 'https://h5api.wapa.shop.com/h5/sample.api.ai.plan.chat/1.0/?xAcceptStream=true',
        method: 'POST',
        requestHeaders: [
          { name: 'Accept', value: 'text/event-stream' },
          { name: 'Cookie', value: 'session=secret' },
        ],
        requestData: '{"query":"杭州怎么玩"}',
        timestampMs: 1_700_000_000_000,
      }),
    ).toBe(true);

    let captured = getCollectedRequests(2207, {
      after: checkpoint.cursor,
      source: 'protocol',
    });
    expect(captured.requests).toEqual([
      expect.objectContaining({
        apiName: 'sample.api.ai.plan.chat',
        namespace: 'trip',
        environment: 'pre',
        isSSE: true,
        isPending: true,
        postData: { query: '杭州怎么玩' },
        queryString: [{ name: 'xAcceptStream', value: 'true' }],
        headers: [
          { name: 'Accept', value: 'text/event-stream' },
          { name: 'Cookie', value: '<redacted>' },
        ],
      }),
    ]);

    expect(
      recordBackgroundProtocolStreamResponse(2207, 'stream-1', {
        status: 200,
        statusText: 'OK',
        responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }],
      }),
    ).toBe(true);
    expect(
      recordBackgroundProtocolStreamChunk(
        2207,
        'stream-1',
        { data: { text: '杭' } },
        1_700_000_000_100,
      ),
    ).toBe(true);
    expect(
      recordBackgroundProtocolStreamChunk(
        2207,
        'stream-1',
        { data: { text: '杭州' } },
        1_700_000_000_180,
      ),
    ).toBe(true);
    expect(
      recordBackgroundProtocolStreamEnd(2207, 'stream-1', {
        timestampMs: 1_700_000_000_200,
      }),
    ).toBe(true);

    captured = getCollectedRequests(2207, {
      after: checkpoint.cursor,
      source: 'protocol',
    });
    expect(captured.requests).toEqual([
      expect.objectContaining({
        status: 200,
        statusText: 'OK',
        isPending: false,
        duration: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }],
        responseBody: [
          {
            event: 'message',
            data: { data: { text: '杭' } },
            timestamp: 1_700_000_000_100,
            duration: 0,
          },
          {
            event: 'message',
            data: { data: { text: '杭州' } },
            timestamp: 1_700_000_000_180,
            duration: 80,
          },
        ],
      }),
    ]);

    await stopRequestCollection(2207);
    cleanupCollector(2207);
    cleanupDebuggerSession(2207);
  });

  it('retains a background Protocol SSE failure when no data chunk arrives', async () => {
    await startRequestCollection(2208);

    recordBackgroundProtocolStreamStart(2208, {
      streamId: 'stream-error',
      api: 'sample.api.ai.plan.chat',
      method: 'POST',
      timestampMs: 1_700_000_000_000,
    });
    expect(
      recordBackgroundProtocolStreamEnd(2208, 'stream-error', {
        timestampMs: 1_700_000_000_050,
        error: 'stream disconnected',
      }),
    ).toBe(true);

    expect(getCollectedRequests(2208, { source: 'protocol' }).requests).toEqual([
      expect.objectContaining({
        url: 'protocol://sample.api.ai.plan.chat/',
        status: 0,
        statusText: 'stream disconnected',
        isPending: false,
        duration: 50,
        responseBody: { error: 'stream disconnected' },
      }),
    ]);

    await stopRequestCollection(2208);
    cleanupCollector(2208);
    cleanupDebuggerSession(2208);
  });

  it('filters captured requests with regex semantics', async () => {
    await startRequestCollection(2205);

    for (const [requestId, apiName] of [
      ['train', 'sample.api.train.listsearch'],
      ['traffic', 'sample.api.traffic.saveSearchRecord'],
      ['hotel', 'sample.api.hotel.search'],
    ]) {
      debuggerEventListener?.({ tabId: 2205 }, 'Network.requestWillBeSent', {
        requestId,
        request: {
          url: `https://h5api.m.shop.com/h5/${apiName}/1.0/`,
          method: 'GET',
        },
        type: 'Fetch',
        timestamp: 1,
      });
      debuggerEventListener?.({ tabId: 2205 }, 'Network.responseReceived', {
        requestId,
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      debuggerEventListener?.({ tabId: 2205 }, 'Network.loadingFinished', {
        requestId,
        timestamp: 2,
      });
    }

    await vi.waitFor(() => {
      expect(getCollectedRequests(2205, { source: 'protocol' }).totalMatched).toBe(3);
    });
    const result = getCollectedRequests(2205, {
      source: 'protocol',
      filter: 'train|traffic',
    });
    expect(result.totalMatched).toBe(2);
    expect(result.requests.map(request => request.apiName)).toEqual([
      'sample.api.train.listsearch',
      'sample.api.traffic.saveSearchRecord',
    ]);

    await stopRequestCollection(2205);
    cleanupCollector(2205);
    cleanupDebuggerSession(2205);
  });

  it('retrieves omitted RUM post data before parsing the event', async () => {
    const postData = JSON.stringify({
      events: [{ event_type: 'action', name: 'deferred' }],
    });
    chrome.debugger.sendCommand = vi.fn().mockImplementation((_target, method) => {
      return Promise.resolve(method === 'Network.getRequestPostData' ? { postData } : {});
    });

    decoder.decode.mockResolvedValueOnce({ available: true, tracking: true, events: [] })
      .mockResolvedValueOnce({ available: true, tracking: true, events: [trackingEvent({ id: 'deferred', event_type: 'action', name: 'deferred' })] });
    await startRequestCollection(2204);
    debuggerEventListener?.({ tabId: 2204 }, 'Network.requestWillBeSent', {
      requestId: 'rum-deferred',
      request: {
        url: 'https://example.test/tracking/events',
        hasPostData: true,
      },
      type: 'Fetch',
    });

    await vi.waitFor(() => {
      expect(getCollectedEvents(2204).events).toHaveLength(1);
    });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 2204 },
      'Network.getRequestPostData',
      { requestId: 'rum-deferred' },
    );
    expect(getCollectedEvents(2204).events[0]).toMatchObject({
      source: 'rum',
      event_type: 'action',
      name: 'deferred',
    });

    await stopRequestCollection(2204);
    cleanupCollector(2204);
    cleanupDebuggerSession(2204);
  });
});

function deferredDecode() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
}
const ordinary = { available: true, tracking: false, events: [] };
function emitRequest(tabId: number, requestId: string) {
  debuggerEventListener?.({ tabId }, 'Network.requestWillBeSent', {
    requestId, request: { url: `https://example.test/${requestId}`, method: 'GET' }, type: 'Fetch', wallTime: 1700000000,
  });
}

it('holds the cursor behind slow decoding and commits concurrent requests in arrival order', async () => {
  const first = deferredDecode();
  decoder.decode.mockReset().mockReturnValueOnce(first.promise).mockResolvedValue(ordinary);
  await startRequestCollection(2301);
  const before = getCaptureCheckpoint(2301).cursor;
  emitRequest(2301, 'first'); emitRequest(2301, 'second');
  debuggerEventListener?.({ tabId: 2301 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'later log' }], timestamp: 1700000000001 });
  expect(getCaptureCheckpoint(2301).cursor).toBe(before);
  expect(getCollectedLogs(2301, { after: before }).entries).toEqual([]);
  const flushed = flushRequestCollection(2301);
  first.resolve(ordinary); await flushed;
  expect(getCollectedRequests(2301, { source: 'all', after: before }).requests.map(request => request.url)).toEqual(['https://example.test/first', 'https://example.test/second']);
  expect(getCollectedLogs(2301, { after: before }).entries[0].message).toBe('later log');
  await stopRequestCollection(2301); cleanupCollector(2301); cleanupDebuggerSession(2301);
});
it('does not advance a query cursor over a new request received while an earlier flush waits', async () => {
  const first = deferredDecode(), second = deferredDecode();
  decoder.decode.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await startRequestCollection(2302);
  emitRequest(2302, 'before-query');
  const flushing = flushRequestCollection(2302);
  emitRequest(2302, 'after-query');
  first.resolve(ordinary); await flushing;
  const query = getCollectedRequests(2302, { source: 'all' });
  expect(query.requests.map(request => request.url)).toEqual(['https://example.test/before-query']);
  second.resolve(ordinary); await flushRequestCollection(2302);
  expect(getCollectedRequests(2302, { source: 'all', after: query.nextCursor }).requests.map(request => request.url)).toEqual(['https://example.test/after-query']);
  await stopRequestCollection(2302); cleanupCollector(2302); cleanupDebuggerSession(2302);
});
it('discards an old generation after stop/restart without clearing the replacement queue', async () => {
  const old = deferredDecode();
  decoder.decode.mockReset().mockReturnValueOnce(old.promise).mockResolvedValue(ordinary);
  await startRequestCollection(2303); emitRequest(2303, 'old');
  await stopRequestCollection(2303); await startRequestCollection(2303); emitRequest(2303, 'new');
  old.resolve(ordinary); await flushRequestCollection(2303);
  expect(getCollectorSnapshot(2303).requests.map(request => request.url)).toEqual(['https://example.test/new']);
  await stopRequestCollection(2303); cleanupCollector(2303); cleanupDebuggerSession(2303);
});
it('reports installed decoder failures at the query boundary instead of returning an empty history', async () => {
  decoder.decode.mockReset().mockRejectedValue(new Error('installed decoder failed'));
  await startRequestCollection(2304);
  const checkpoint = getCaptureCheckpoint(2304); emitRequest(2304, 'failed');
  await expect(flushRequestCollection(2304)).rejects.toThrow('installed decoder failed');
  await expect(flushRequestCollection(2304, { allowDecodeFailure: true })).resolves.toBeUndefined();
  expect(getCollectedRequests(2304, { source: 'all', after: checkpoint.cursor }).gap).toBe(true);
  expect(getCollectedLogs(2304, {}).entries).toEqual([expect.objectContaining({ message: 'Tracking decoding failed: installed decoder failed' })]);
  decoder.decode.mockResolvedValue(ordinary);
  emitRequest(2304, 'recovered'); await flushRequestCollection(2304);
  expect(getCollectorSnapshot(2304).requests).toHaveLength(1);
  await stopRequestCollection(2304); cleanupCollector(2304); cleanupDebuggerSession(2304);
});
it('does not publish an old response body into a restarted capture with matching request IDs', async () => {
  let finish!: (value: unknown) => void;
  const body = new Promise(resolve => { finish = resolve; });
  chrome.debugger.sendCommand = vi.fn().mockImplementation((_target, method) => method === 'Network.getResponseBody' ? body : Promise.resolve({}));
  decoder.decode.mockReset().mockResolvedValue(ordinary);
  await startRequestCollection(2305); emitRequest(2305, 'same');
  debuggerEventListener?.({ tabId: 2305 }, 'Network.loadingFinished', { requestId: 'same' });
  await flushRequestCollection(2305);
  await stopRequestCollection(2305); await startRequestCollection(2305); emitRequest(2305, 'same');
  await flushRequestCollection(2305);
  finish({ body: '{"stale":true}', base64Encoded: false }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(getCollectorSnapshot(2305).requests).toHaveLength(1);
  expect(getCollectorSnapshot(2305).requests[0].responseBody).toBeNull();
  await stopRequestCollection(2305); cleanupCollector(2305); cleanupDebuggerSession(2305);
});

it('keeps requests and logs available after a malformed tracking row and reports the event gap', async () => {
  const error = new Error('malformed event'); error.name = 'TrackingRequestError';
  decoder.decode.mockReset().mockRejectedValueOnce(error).mockResolvedValue(ordinary);
  await startRequestCollection(2306);
  const checkpoint = getCaptureCheckpoint(2306);
  emitRequest(2306, 'bad'); emitRequest(2306, 'ordinary');
  await flushRequestCollection(2306);
  expect(getCollectedRequests(2306, { source: 'all' }).requests.map(request => request.url)).toEqual(['https://example.test/ordinary']);
  expect(getCollectedLogs(2306, {}).entries[0].message).toBe('Tracking decoding failed: malformed event');
  expect(getCollectedEvents(2306, { after: checkpoint.cursor }).gap).toBe(true);
  emitRequest(2306, 'later'); await flushRequestCollection(2306);
  expect(getCollectedRequests(2306, { source: 'all' }).requests).toHaveLength(2);
  await stopRequestCollection(2306); cleanupCollector(2306); cleanupDebuggerSession(2306);
});
