import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  isCollecting: vi.fn(),
  getCaptureCheckpoint: vi.fn(),
  getCollectedLogs: vi.fn(),
  getCollectedRequests: vi.fn(),
  getCollectedEvents: vi.fn(),
}));

vi.mock('../../backgroundRequestCollector', () => ({
  flushRequestCollection: mocks.flush,
  isCollecting: mocks.isCollecting,
  getCaptureCheckpoint: mocks.getCaptureCheckpoint,
  getCollectedLogs: mocks.getCollectedLogs,
  getCollectedRequests: mocks.getCollectedRequests,
  getCollectedEvents: mocks.getCollectedEvents,
}));

import {
  handleCaptureCheckpoint,
  handleGetEvents,
  handleGetLogs,
  handleGetRequests,
} from '../requestHandlers';

beforeEach(() => { mocks.flush.mockReset().mockResolvedValue(undefined); });

describe('get_requests data source selection', () => {
  const request = {
    id: 1,
    timestamp: '2026/07/14 17:00:00',
    timestampMs: 100,
    method: 'GET',
    url: 'https://example.com/api/data',
    apiName: 'api/data',
    status: 200,
    statusText: 'OK',
    queryString: [],
    postData: null,
    responseBody: { ok: true },
  } as any;

  beforeEach(() => {
    mocks.isCollecting.mockReset();
    mocks.getCollectedRequests.mockReset();
  });

  it.each([undefined, true, false])(
    'honors the body override with field selection: %s',
    async includeBody => {
      mocks.isCollecting.mockReturnValue(true);
      mocks.getCollectedRequests.mockReturnValue({
        requests: [request],
        totalMatched: 1,
        totalInBuffer: 1,
      });
      const result = await handleGetRequests(
        { tabId: 7, fields: ['ok'], includeBody },
        { queryPanel: vi.fn(), getActiveTabId: () => null },
      );
      expect(result.meta.includeBody).toBe(includeBody === true);
      expect(result.requests[0].extractedFields).toEqual({ ok: true });
      if (includeBody === true) {
        expect(result.requests[0].responseBody).toEqual({ ok: true });
      } else {
        expect(result.requests[0]).not.toHaveProperty('responseBody');
        expect(result.requests[0]).not.toHaveProperty('postData');
      }
    },
  );

  it('uses captured requests when collection is active even if a panel is connected', async () => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedRequests.mockReturnValue({
      requests: [request],
      totalMatched: 1,
      totalInBuffer: 1,
    });
    const queryPanel = vi.fn();

    const result = await handleGetRequests(
      { tabId: 7, source: 'requests' },
      { queryPanel, getActiveTabId: () => null },
    );

    expect(queryPanel).not.toHaveBeenCalled();
    expect(result.meta.source).toBe('background_collector');
    expect(result.requests).toHaveLength(1);
  });

  it('keeps the background collector authoritative while it is armed', async () => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedRequests.mockReturnValue({
      requests: [],
      totalMatched: 0,
      totalInBuffer: 0,
    });
    const queryPanel = vi.fn();

    const result = await handleGetRequests(
      { tabId: 7, source: 'requests' },
      { queryPanel, getActiveTabId: () => null },
    );

    expect(queryPanel).not.toHaveBeenCalled();
    expect(result.meta.source).toBe('background_collector');
    expect(result.requests).toHaveLength(0);
  });

  it('prompts for current-tab activity when capture is armed without history', async () => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedRequests.mockReturnValue({
      requests: [],
      totalMatched: 0,
      totalInBuffer: 0,
    });
    const queryPanel = vi.fn().mockResolvedValue({
      requests: [],
      totalMatched: 0,
      totalInBuffer: 0,
    });

    const result = await handleGetRequests(
      { tabId: 7, source: 'requests' },
      { queryPanel, getActiveTabId: () => null },
    );

    expect(result.meta.captureStatus).toBe('armed');
    expect(result.meta.hint).toContain('Reload the current tab');
    expect(result.meta.hint).not.toContain('tab_open');
  });

  it('fails explicitly when capture cannot attach', async () => {
    mocks.isCollecting.mockReturnValue(false);
    const queryPanel = vi.fn().mockResolvedValue({
      requests: [],
      totalMatched: 0,
      totalInBuffer: 0,
    });

    await expect(
      handleGetRequests(
        { tabId: 7, source: 'requests' },
        { queryPanel, getActiveTabId: () => null },
      ),
    ).rejects.toThrow('Diagnostics capture is unavailable');
  });
});

describe('get_events data source selection', () => {
  const event = {
    id: 'aplus-1-100',
    source: 'aplus',
    batchId: 0,
    batchTimestampMs: 100,
    batchTimestamp: '2026/07/14 17:00:00',
    event_type: 'CLK',
    name: '1.2.button.submit',
    timestamp: 100,
    _raw: {},
    _context: {
      requestUrl: 'https://gm.mmstat.com/aplus.clk',
      app: {},
      user: {},
      session: {},
      view: {},
      properties: {},
      os: {},
      net: {},
    },
  } as any;

  beforeEach(() => {
    mocks.isCollecting.mockReset();
    mocks.getCollectedEvents.mockReset();
  });

  it('returns background events without querying the panel', async () => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedEvents.mockReturnValue({
      events: [event],
      totalMatched: 1,
      totalInBuffer: 1,
    });
    const queryPanel = vi.fn();

    const result = await handleGetEvents(
      { tabId: 7, source: 'aplus' },
      { queryPanel, getActiveTabId: () => null },
    );

    expect(queryPanel).not.toHaveBeenCalled();
    expect(result.meta.captureSource).toBe('background_collector');
    expect(result.meta.captureStatus).toBe('active');
    expect(result.meta.includeRaw).toBe(false);
    expect(result.events).toEqual([
      expect.objectContaining({
        id: event.id,
        source: 'aplus',
        event_type: 'CLK',
        name: event.name,
        url: 'https://gm.mmstat.com/aplus.clk',
      }),
    ]);
    expect(result.events[0]).not.toHaveProperty('_raw');
    expect(result.events[0]).not.toHaveProperty('_context');
  });

  it('falls back to panel history while the background collector is empty', async () => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedEvents.mockReturnValue({
      events: [],
      totalMatched: 0,
      totalInBuffer: 0,
    });
    const queryPanel = vi.fn().mockResolvedValue({
      events: [event],
      totalMatched: 1,
      totalInBuffer: 1,
    });

    const result = await handleGetEvents(
      { tabId: 7, includeRaw: true },
      { queryPanel, getActiveTabId: () => null },
    );

    expect(result.meta.captureSource).toBe('panel');
    expect(result.meta.includeRaw).toBe(true);
    expect(result.events).toEqual([event]);
  });

  it('uses the collector cursor for event deltas without falling back to panel history', async () => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedEvents.mockReturnValue({
      events: [event],
      totalMatched: 1,
      totalInBuffer: 1,
      nextCursor: 'events-next',
      hasMore: false,
      gap: false,
    });
    const queryPanel = vi.fn();

    const result = await handleGetEvents(
      { tabId: 7, after: 'checkpoint' },
      { queryPanel, getActiveTabId: () => null },
    );

    expect(queryPanel).not.toHaveBeenCalled();
    expect(mocks.getCollectedEvents).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ after: 'checkpoint' }),
    );
    expect(result.meta).toMatchObject({
      captureSource: 'background_collector',
      after: 'checkpoint',
      nextCursor: 'events-next',
      hasMore: false,
      gap: false,
    });
  });

  it('reports armed capture instead of requiring a panel', async () => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedEvents.mockReturnValue({
      events: [],
      totalMatched: 0,
      totalInBuffer: 0,
    });
    const queryPanel = vi.fn().mockRejectedValue(new Error('Panel not connected'));

    const result = await handleGetEvents({ tabId: 7 }, { queryPanel, getActiveTabId: () => null });

    expect(result.meta.captureStatus).toBe('armed');
    expect(result.meta.captureSource).toBe('none');
    expect(result.meta.hint).toContain('Reload the current tab');
    expect(result.events).toEqual([]);
  });
});

describe('get_logs diagnostics collector', () => {
  beforeEach(() => {
    mocks.isCollecting.mockReturnValue(true);
    mocks.getCollectedLogs.mockReset().mockReturnValue({
      entries: [
        {
          level: 'error',
          message: 'new error',
          timestampMs: 100,
          args: ['new error'],
          captureSequence: 1,
          origin: 'console',
        },
      ],
      totalMatched: 1,
      totalInBuffer: 1,
      nextCursor: 'next',
      hasMore: false,
      gap: false,
    });
    mocks.getCaptureCheckpoint.mockReset().mockReturnValue({
      tabId: 7,
      cursor: 'checkpoint',
      timestampMs: 100,
      captureStatus: 'active',
    });
  });

  it('returns cursor metadata with filtered collector logs', async () => {
    const result = await handleGetLogs({ tabId: 7, after: 'checkpoint', level: 'error' }, {
      getActiveTabId: () => null,
    } as any);

    expect(result.logs).toEqual([expect.objectContaining({ message: 'new error' })]);
    expect(result.meta).toMatchObject({ nextCursor: 'next', hasMore: false, gap: false });
    expect(mocks.getCollectedLogs).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ after: 'checkpoint', level: 'error' }),
    );
  });

  it('exposes the collector checkpoint for the selected tab', async () => {
    await expect(
      handleCaptureCheckpoint({ tabId: 7 }, { getActiveTabId: () => null } as any),
    ).resolves.toMatchObject({ cursor: 'checkpoint', tabId: 7 });
  });
});

it('waits for accepted decoding before querying the request history', async () => {
  let finish!: () => void;
  mocks.isCollecting.mockReturnValue(true);
  mocks.flush.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  mocks.getCollectedRequests.mockClear().mockReturnValue({ requests: [], totalMatched: 0, totalInBuffer: 0 });
  const waiting = handleGetRequests({ tabId: 7 }, { queryPanel: vi.fn(), getActiveTabId: () => null });
  expect(mocks.getCollectedRequests).not.toHaveBeenCalled();
  finish(); await waiting;
  expect(mocks.getCollectedRequests).toHaveBeenCalledOnce();
});
it('keeps empty event capture armed without requiring a preset', async () => {
  mocks.isCollecting.mockReturnValue(true);
  mocks.getCollectedEvents.mockReturnValue({ events: [], totalMatched: 0, totalInBuffer: 0 });
  const result = await handleGetEvents({ tabId: 7 }, { queryPanel: vi.fn().mockRejectedValue(new Error('no panel')), getActiveTabId: () => null });
  expect(result.meta.captureStatus).toBe('armed');
  expect(result.meta.hint).not.toContain('preset');
});
