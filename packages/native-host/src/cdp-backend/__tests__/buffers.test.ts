const parser = vi.hoisted(() => ({
  matches: (url: string) => url.includes('events.example.com/report'),
  parse: (_url: string, data: string | undefined, options: { now: number; sequence: number }) => data ? JSON.parse(data).events.map((event: Record<string, unknown>, index: number) => ({ source: 'rum', id: `${options.sequence}-${index}`, timestamp: options.now, _raw: event, _context: { requestUrl: _url }, ...event })) : [],
}));
vi.mock('../../capability-contracts.js', async original => ({ ...await original<typeof import('../../capability-contracts.js')>(), getTrackingCapability: () => parser }));
import { describe, expect, it, vi } from 'vitest';
import {
  createBuffers,
  recordCdpProtocolStreamStart,
  setupBufferListeners,
} from '../buffers.js';
import {
  cdpCaptureCheckpoint,
  cdpGetEvents,
  cdpGetLogs,
  cdpGetRequests,
} from '../request-handlers.js';

describe('CDP capture buffers and installed event parsers', () => {
  it('retains delegated stream annotations in the shared request buffer', () => {
    const buffers = createBuffers(77);
    recordCdpProtocolStreamStart(buffers, { api: 'opaque.query', method: 'POST', namespace: 'sample', environment: 'qa' });
    expect(buffers.requests[0]).toMatchObject({ namespace: 'sample', environment: 'qa', source: 'protocol' });
  });
  it.each([undefined, true, false])(
    'honors the body override with field selection: %s',
    async includeBody => {
      const buffers = createBuffers(77);
      buffers.requests = [
        {
          timestampMs: 1,
          captureSequence: 1,
          source: 'protocol',
          responseBody: { ok: true },
        },
      ] as any;
      buffers.capture.currentSequence = 1;
      const result = await cdpGetRequests({ buffers } as any, {
        tabId: 77,
        fields: ['ok'],
        includeBody,
      });
      expect(result.requests[0].extractedFields).toEqual({ ok: true });
      if (includeBody === true) {
        expect(result.requests[0].responseBody).toEqual({ ok: true });
      } else {
        expect(result.requests[0]).not.toHaveProperty('responseBody');
        expect(result.requests[0]).not.toHaveProperty('postData');
      }
    },
  );
  it('uses epoch milliseconds and exposes atomic console/network deltas', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const client = {
      sendCommand: vi.fn().mockResolvedValue({}),
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => {};
      }),
    } as any;
    const buffers = createBuffers(77);
    await setupBufferListeners(client, buffers);
    expect(client.sendCommand).toHaveBeenCalledWith(
      'Network.enable',
      expect.objectContaining({ maxTotalBufferSize: expect.any(Number) }),
    );
    expect(client.sendCommand).toHaveBeenCalledWith('Runtime.enable', {});
    expect(client.sendCommand).toHaveBeenCalledWith('Log.enable', {});
    const session = { tabId: 77, buffers } as any;
    const checkpoint = await cdpCaptureCheckpoint(session, { tabId: 77 });

    listeners.get('Runtime.consoleAPICalled')?.({
      type: 'error',
      args: [{ type: 'string', value: 'failed' }],
      timestamp: 1_700_000_000_123,
    });
    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'pending',
      request: { url: 'https://example.com/api/submit', method: 'POST' },
      type: 'Fetch',
      timestamp: 10,
      wallTime: 1_700_000_000,
    });
    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'rum',
      request: {
        url: 'https://events.example.com/report',
        method: 'POST',
        postData: JSON.stringify({ events: [{ event_type: 'action', name: 'submit' }] }),
      },
      type: 'Fetch',
      timestamp: 11,
      wallTime: 1_700_000_001,
    });

    const logs = await cdpGetLogs(session, { tabId: 77, after: checkpoint.cursor, level: 'error' });
    expect(logs.logs).toEqual([
      expect.objectContaining({ message: 'failed', timestampMs: 1_700_000_000_123 }),
    ]);
    const requests = await cdpGetRequests(session, {
      tabId: 77,
      after: checkpoint.cursor,
      source: 'all',
    });
    expect(requests.requests).toEqual([
      expect.objectContaining({
        timestampMs: 1_700_000_000_000,
        isPending: true,
        source: 'requests',
      }),
    ]);
    const events = await cdpGetEvents(session, { tabId: 77, after: checkpoint.cursor });
    expect(events.events).toEqual([
      expect.objectContaining({ source: 'rum', event_type: 'action', name: 'submit' }),
    ]);
    expect(events.meta).toMatchObject({ after: checkpoint.cursor, hasMore: false, gap: false });
  });

  it('captures capability event request bodies and exposes the normalized events', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const client = {
      sendCommand: vi.fn().mockResolvedValue({}),
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => {};
      }),
    } as any;
    const buffers = createBuffers();
    await setupBufferListeners(client, buffers);

    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'rum-1',
      request: {
        url: 'https://events.example.com/report',
        method: 'POST',
        postData: JSON.stringify({
          events: [{ event_type: 'view', name: 'checkout' }],
        }),
      },
      timestamp: 1,
    });

    expect(buffers.events).toHaveLength(1);
    expect(buffers.events[0]).toMatchObject({
      source: 'rum',
      event_type: 'view',
      name: 'checkout',
    });

    const result = await cdpGetEvents({ buffers } as any, {
      tabId: 0,
      source: 'rum',
      event_type: 'view',
      filter: 'checkout',
    });
    expect(result.meta).toMatchObject({
      count: 1,
      totalMatched: 1,
      totalInBuffer: 1,
      source: 'rum',
      captureStatus: 'active',
      captureSource: 'cdp',
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).not.toHaveProperty('_raw');
    expect(result.events[0]).not.toHaveProperty('_context');
    expect(result.meta.includeRaw).toBe(false);
  });

  it('streams fetch-based SSE response data into the live request buffer', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const bufferedData = Buffer.from('data: {"part":1}\n\n').toString('base64');
    const client = {
      sendCommand: vi.fn(async (method: string) =>
        method === 'Network.streamResourceContent' ? { bufferedData } : {},
      ),
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => {};
      }),
    } as any;
    const buffers = createBuffers(81);
    await setupBufferListeners(client, buffers);
    const session = { tabId: 81, buffers } as any;

    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'fetch-sse',
      request: { url: 'https://example.test/stream', method: 'POST', postData: '{"q":1}' },
      type: 'Fetch',
      timestamp: 10,
      wallTime: 1_700_000_000,
    });
    listeners.get('Network.responseReceived')?.({
      requestId: 'fetch-sse',
      timestamp: 10.1,
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      },
    });
    await vi.waitFor(() => expect(buffers.requests[0]?.responseBody).toHaveLength(1));

    listeners.get('Network.dataReceived')?.({
      requestId: 'fetch-sse',
      timestamp: 10.2,
      data: Buffer.from('data: {"part":2}\n\n').toString('base64'),
    });
    const pending = await cdpGetRequests(session, {
      tabId: session.tabId,
      source: 'all',
      includeHeaders: true,
    });
    expect(pending.requests[0]).toMatchObject({
      isSSE: true,
      isPending: true,
      status: 200,
      responseBody: [
        { event: 'message', data: { part: 1 }, duration: 0 },
        { event: 'message', data: { part: 2 }, duration: 100 },
      ],
    });

    listeners.get('Network.loadingFinished')?.({ requestId: 'fetch-sse', timestamp: 10.3 });
    const completed = await cdpGetRequests(session, { tabId: session.tabId, source: 'all' });
    expect(completed.requests[0]).toMatchObject({
      isSSE: true,
      isPending: false,
      duration: 300,
      responseBody: [{ data: { part: 1 } }, { data: { part: 2 } }],
    });
    expect(client.sendCommand).not.toHaveBeenCalledWith(
      'Network.getResponseBody',
      expect.anything(),
      expect.anything(),
    );
  });

  it('captures native EventSource messages without duplicating raw stream data', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const client = {
      sendCommand: vi.fn().mockResolvedValue({}),
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => {};
      }),
    } as any;
    const buffers = createBuffers(82);
    await setupBufferListeners(client, buffers);

    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'event-source',
      request: { url: 'https://example.test/events', method: 'GET' },
      type: 'EventSource',
      timestamp: 20,
      wallTime: 1_700_000_100,
    });
    listeners.get('Network.responseReceived')?.({
      requestId: 'event-source',
      timestamp: 20.1,
      response: { status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' } },
    });
    listeners.get('Network.eventSourceMessageReceived')?.({
      requestId: 'event-source',
      timestamp: 20.2,
      eventName: 'update',
      eventId: 'event-1',
      data: '{"ready":true}',
    });

    expect(buffers.requests[0]).toMatchObject({
      isSSE: true,
      isPending: true,
      resourceType: 'eventsource',
      responseBody: [
        {
          event: 'update',
          eventId: 'event-1',
          data: { ready: true },
          duration: 0,
        },
      ],
    });
    expect(client.sendCommand).not.toHaveBeenCalledWith(
      'Network.streamResourceContent',
      expect.anything(),
      expect.anything(),
    );
  });

  it('falls back to the completed response body when live resource streaming is unavailable', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const client = {
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Network.streamResourceContent') throw new Error('Method not found');
        if (method === 'Network.getResponseBody') {
          return { body: 'data: {"fallback":true}\n\n', base64Encoded: false };
        }
        return {};
      }),
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => {};
      }),
    } as any;
    const buffers = createBuffers(84);
    await setupBufferListeners(client, buffers);

    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'fallback-sse',
      request: { url: 'https://example.test/fallback', method: 'GET' },
      type: 'Fetch',
      timestamp: 30,
      wallTime: 1_700_000_300,
    });
    listeners.get('Network.responseReceived')?.({
      requestId: 'fallback-sse',
      timestamp: 30.1,
      response: { status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' } },
    });
    await vi.waitFor(() =>
      expect(client.sendCommand).toHaveBeenCalledWith(
        'Network.streamResourceContent',
        { requestId: 'fallback-sse' },
        10000,
      ),
    );
    listeners.get('Network.loadingFinished')?.({ requestId: 'fallback-sse', timestamp: 30.2 });
    await vi.waitFor(() => expect(buffers.requests[0]?.responseBody).toHaveLength(1));

    expect(buffers.requests[0]).toMatchObject({
      isSSE: true,
      isPending: false,
      responseBody: [{ event: 'message', data: { fallback: true } }],
    });
  });

  it('returns full tracking detail only when requested', async () => {
    const buffers = createBuffers();
    buffers.events.push({
      id: 'aplus-1',
      source: 'aplus',
      batchId: 1,
      batchTimestampMs: 1,
      batchTimestamp: '',
      event_type: 'CLK',
      name: 'button.search',
      timestamp: 1,
      _raw: { gmkey: 'CLK' },
      _context: {
        requestUrl: 'https://gm.mmstat.com/aplus.clk?gmkey=CLK',
        app: {},
        user: {},
        session: {},
        view: {},
        properties: {},
        os: {},
        net: {},
      },
    });

    const result = await cdpGetEvents({ buffers } as any, { tabId: 0, includeRaw: true });
    expect(result.meta.includeRaw).toBe(true);
    expect(result.events[0]).toHaveProperty('_raw.gmkey', 'CLK');
    expect(result.events[0]).toHaveProperty('_context.requestUrl');
  });

  it('filters requests with regex semantics before applying count', async () => {
    const buffers = createBuffers();
    buffers.requests = [
      {
        timestampMs: 1,
        captureSequence: 1,
        source: 'protocol',
        apiName: 'sample.api.train.listsearch',
        url: 'https://h5api.m.shop.com/h5/sample.api.train.listsearch/1.0/',
      },
      {
        timestampMs: 2,
        captureSequence: 2,
        source: 'protocol',
        apiName: 'sample.api.traffic.saveSearchRecord',
        url: 'https://h5api.m.shop.com/h5/sample.api.traffic.saveSearchRecord/1.0/',
      },
      {
        timestampMs: 3,
        captureSequence: 3,
        source: 'protocol',
        apiName: 'sample.api.hotel.search',
        url: 'https://h5api.m.shop.com/h5/sample.api.hotel.search/1.0/',
      },
    ] as any;
    buffers.capture.currentSequence = 3;

    const result = await cdpGetRequests({ buffers } as any, {
      tabId: 0,
      source: 'protocol',
      filter: 'train|traffic',
      count: 1,
    });
    expect(result.meta).toMatchObject({ count: 1, totalMatched: 2 });
    expect(result.requests[0].apiName).toBe('sample.api.traffic.saveSearchRecord');
  });

  it('retrieves omitted capability event post data through CDP before parsing it', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const postData = JSON.stringify({
      events: [{ event_type: 'action', name: 'deferred' }],
    });
    const client = {
      sendCommand: vi
        .fn()
        .mockImplementation((method: string) =>
          Promise.resolve(method === 'Network.getRequestPostData' ? { postData } : {}),
        ),
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => {};
      }),
    } as any;
    const buffers = createBuffers();
    await setupBufferListeners(client, buffers);

    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'rum-deferred',
      request: {
        url: 'https://events.example.com/report',
        method: 'POST',
        hasPostData: true,
      },
      timestamp: 1,
    });

    await vi.waitFor(() => {
      expect(buffers.events).toHaveLength(1);
    });
    expect(client.sendCommand).toHaveBeenCalledWith(
      'Network.getRequestPostData',
      { requestId: 'rum-deferred' },
      10000,
    );
    expect(buffers.events[0]).toMatchObject({
      source: 'rum',
      event_type: 'action',
      name: 'deferred',
    });
  });

  it('anchors deferred tracking bodies to request arrival for checkpoints', async () => {
    const listeners = new Map<string, (params: any) => void>();
    let resolvePostData!: (value: { postData: string }) => void;
    const postDataPromise = new Promise<{ postData: string }>(resolve => {
      resolvePostData = resolve;
    });
    const client = {
      sendCommand: vi
        .fn()
        .mockImplementation((method: string) =>
          method === 'Network.getRequestPostData' ? postDataPromise : Promise.resolve({}),
        ),
      on: vi.fn((method: string, listener: (params: any) => void) => {
        listeners.set(method, listener);
        return () => {};
      }),
    } as any;
    const buffers = createBuffers(78);
    await setupBufferListeners(client, buffers);
    const session = { tabId: 78, buffers } as any;

    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'rum-before-checkpoint',
      request: {
        url: 'https://events.example.com/report',
        method: 'POST',
        hasPostData: true,
      },
      timestamp: 1,
    });
    const checkpoint = await cdpCaptureCheckpoint(session, { tabId: session.tabId });
    listeners.get('Network.requestWillBeSent')?.({
      requestId: 'rum-after-checkpoint',
      request: {
        url: 'https://events.example.com/report',
        method: 'POST',
        postData: JSON.stringify({
          events: [{ event_type: 'action', name: 'after-checkpoint' }],
        }),
      },
      timestamp: 2,
    });
    resolvePostData({
      postData: JSON.stringify({
        events: [{ event_type: 'action', name: 'before-checkpoint' }],
      }),
    });

    await vi.waitFor(() => expect(buffers.events).toHaveLength(2));
    expect(
      (await cdpGetEvents(session, { tabId: session.tabId, after: checkpoint.cursor })).events,
    ).toEqual([expect.objectContaining({ name: 'after-checkpoint' })]);
    expect(
      (await cdpGetEvents(session, { tabId: session.tabId })).events.map(event => event.name),
    ).toEqual(['after-checkpoint', 'before-checkpoint']);
  });

  it('reports an armed capture with guidance before the first event arrives', async () => {
    const result = await cdpGetEvents({ buffers: createBuffers() } as any, { tabId: 0 });

    expect(result.meta).toMatchObject({
      count: 0,
      totalMatched: 0,
      totalInBuffer: 0,
      captureStatus: 'armed',
      captureSource: 'cdp',
    });
    expect(result.meta.hint).toContain('Reload the current tab');
  });
});
