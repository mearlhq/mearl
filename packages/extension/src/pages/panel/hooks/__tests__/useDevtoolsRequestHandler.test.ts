vi.mock('../../utils/apiNameExtractor', async () => { const { requestMetadataFixture } = await import('../../../../test/fixtures/requestMetadata'); return { inspectRequest: vi.fn(async (url: string) => requestMetadataFixture({ url })) }; });
const decoder = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock('../../utils/browserTracking', () => ({ decodeTrackingRequest: decoder.decode }));
vi.mock('../../utils/i18n', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));
import { act, renderHook } from '@testing-library/react';
import { MutableRefObject, useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedRequest, ResponseOverride, RumEvent } from '../../types';
import type { PanelRequestCaptureState } from '../../utils/capturedState';
import { useDevtoolsRequestHandler } from '../useDevtoolsRequestHandler';

function makeRequest(getContent: (callback: (content: string) => void) => void) {
  return {
    startedDateTime: '2026-09-11T08:00:00.000Z',
    time: 42,
    request: {
      url: 'https://h5api.m.shop.com/h5/sample.api.test/1.0/',
      method: 'POST',
      headers: [],
      queryString: [],
      postData: { text: '{"id":1}' },
      bodySize: 8,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'content-type', value: 'application/json' }],
      bodySize: 20,
    },
    getContent,
    _resourceType: 'fetch',
  } as unknown as chrome.devtools.network.Request;
}

function useHarness(captureStateRef: MutableRefObject<PanelRequestCaptureState>) {
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [nonCapturedRequests, setNonCapturedRequests] = useState<CapturedRequest[]>([]);
  const [events, setEvents] = useState<RumEvent[]>([]);
  const recentlyAutoTranslatedRef = useRef(new Set<string>());
  const handler = useDevtoolsRequestHandler({
    captureStateRef,
    modificationEnabled: false,
    apiOverrides: new Map<string, ResponseOverride[]>(),
    setRequests,
    setNonCapturedRequests,
    setRumEvents: setEvents,
    recentlyAutoTranslatedRef,
  });
  return { ...handler, requests, nonCapturedRequests, events };
}

describe('useDevtoolsRequestHandler', () => {
  beforeEach(() => decoder.decode.mockReset().mockResolvedValue({ available: true, tracking: false, events: [] }));
  it('shows a finished request even when DevTools cannot return its body', async () => {
    const captureStateRef = {
      current: { source: 'devtools', debuggerSince: 0 },
    } as MutableRefObject<PanelRequestCaptureState>;
    const getContent = vi.fn();
    const { result } = renderHook(() => useHarness(captureStateRef));

    await act(async () => { await result.current.handleRequest(makeRequest(getContent)); });

    expect(result.current.requests).toEqual([
      expect.objectContaining({
        apiName: 'sample.api.test',
        status: 200,
        responseBody: null,
      }),
    ]);
    expect(getContent).toHaveBeenCalledOnce();
  });

  it('keeps repeated calls to the same API as separate requests', async () => {
    const captureStateRef = {
      current: { source: 'devtools', debuggerSince: 0 },
    } as MutableRefObject<PanelRequestCaptureState>;
    const { result } = renderHook(() => useHarness(captureStateRef));

    await act(async () => {
      await Promise.all([result.current.handleRequest(makeRequest(vi.fn())), result.current.handleRequest(makeRequest(vi.fn()))]);
    });

    expect(result.current.requests).toHaveLength(2);
    expect(new Set(result.current.requests.map(request => request.id)).size).toBe(2);
  });

  it('ignores DevTools events while debugger capture owns the request stream', () => {
    const captureStateRef = {
      current: { source: 'debugger', debuggerSince: Date.now() },
    } as MutableRefObject<PanelRequestCaptureState>;
    const getContent = vi.fn();
    const { result } = renderHook(() => useHarness(captureStateRef));

    act(() => result.current.handleRequest(makeRequest(getContent)));

    expect(result.current.requests).toEqual([]);
    expect(getContent).not.toHaveBeenCalled();
  });
});

it('commits events in request order even when a later decode finishes first', async () => {
  const { trackingEvent } = await import('../../../../test/fixtures/tracking');
  let finish!: (value: unknown) => void;
  decoder.decode.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ available: true, tracking: true, events: [trackingEvent({ id: 'second' })] });
  const state = { current: { source: 'devtools', debuggerSince: 0 } } as MutableRefObject<PanelRequestCaptureState>;
  const { result } = renderHook(() => useHarness(state));
  let first: unknown, second: unknown;
  act(() => { first = result.current.handleRequest(makeRequest(vi.fn())); second = result.current.handleRequest(makeRequest(vi.fn())); });
  expect(result.current.events).toEqual([]);
  await act(async () => { finish({ available: true, tracking: true, events: [trackingEvent({ id: 'first' })] }); await Promise.all([first, second]); });
  expect(result.current.events.map(event => event.id)).toEqual(['first', 'second']);
});
it('ignores a late decode after its source or cleared document state changes', async () => {
  let finish!: (value: unknown) => void;
  decoder.decode.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const state = { current: { source: 'devtools', debuggerSince: 0 } } as MutableRefObject<PanelRequestCaptureState>;
  const { result } = renderHook(() => useHarness(state));
  let call: unknown;
  act(() => { call = result.current.handleRequest(makeRequest(vi.fn())); });
  state.current = { source: 'devtools', debuggerSince: 0 };
  await act(async () => { finish({ available: true, tracking: false, events: [] }); await call; });
  expect(result.current.requests).toEqual([]);
});
it('ignores a late response body after the capture source changes', async () => {
  decoder.decode.mockReset().mockResolvedValue({ available: true, tracking: false, events: [] });
  let body!: (value: string) => void;
  const state = { current: { source: 'devtools', debuggerSince: 0 } } as MutableRefObject<PanelRequestCaptureState>;
  const { result } = renderHook(() => useHarness(state));
  await act(async () => { await result.current.handleRequest(makeRequest(callback => { body = callback; })); });
  state.current = { source: 'debugger', debuggerSince: Date.now() };
  act(() => body('{"stale":true}'));
  expect(result.current.requests[0].responseBody).toBeNull();
});
