import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CapturedRequest } from '../../types';
import type { PanelRequestCaptureState } from '../../utils/capturedState';
import { usePanelPortBridge } from '../usePanelPortBridge';
const inspection = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('../../utils/apiNameExtractor', () => ({ inspectRequest: inspection.inspect }));
const ports: Array<{ receive: (message: any) => void }> = [];
function usePanelPortBridgeHarness(tabId: number, previewToken?: string) {
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [other, setOther] = useState<CapturedRequest[]>([]);
  const capture = useRef<PanelRequestCaptureState>({ source: 'devtools', debuggerSince: 0 });
  usePanelPortBridge({
    tabId,
    previewToken,
    modificationEnabled: false,
    apiOverrides: new Map(),
    setRequests,
    setNonCapturedRequests: setOther,
    setRumEvents: vi.fn(),
    setApiOverrides: vi.fn(),
    requestsRef: useRef(requests),
    nonCapturedRequestsRef: useRef(other),
    rumEventsRef: useRef([]),
    hiddenApisRef: useRef([]),
    hiddenNonProtocolApisRef: useRef([]),
    recentlyAutoTranslatedRef: useRef(new Set()),
    requestCaptureStateRef: capture,
  });
  return { requests, other, capture };
}
const connection = (url: string) => ({
  source: 'mearl-content-script',
  type: 'SSE_CREATED',
  requestId: 'same-id',
  url,
  method: 'GET',
  timestamp: 100,
});
beforeEach(() => {
  ports.length = 0;
  inspection.inspect.mockReset().mockResolvedValue(null);
  chrome.runtime.connect = vi.fn(() => {
    const port = {
      receive: (_message: any) => {},
      postMessage() {},
      disconnect() {},
      onMessage: {
        addListener(callback: (message: any) => void) {
          port.receive = callback;
        },
      },
      onDisconnect: { addListener() {} },
    };
    ports.push(port);
    return port as unknown as chrome.runtime.Port;
  });
});
it.each(['tab', 'source'] as const)(
  'discards a queued connection and its chunks after a %s change',
  async change => {
    let finish!: (value: null) => void;
    inspection.inspect.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ tabId }) => usePanelPortBridgeHarness(tabId), {
      initialProps: { tabId: 1 },
    });
    await act(async () => {
      ports[0].receive(connection('https://old.example/stream'));
    });
    expect(finish).toBeTypeOf('function');
    ports[0].receive({
      source: 'mearl-content-script',
      type: 'SSE_CHUNK',
      requestId: 'same-id',
      data: { text: 'old' },
    });
    if (change === 'tab') rerender({ tabId: 2 });
    else
      act(() =>
        ports[0].receive({ action: 'requestCaptureSourceChanged', source: 'debugger', since: 200 }),
      );
    await act(async () => {
      ports.at(-1)!.receive(connection('https://new.example/stream'));
    });
    await act(async () => {
      finish(null);
    });
    expect(result.current.other.map(request => request.url)).toEqual([
      'https://new.example/stream',
    ]);
    expect(result.current.other[0].sseMessages).toEqual([]);
  },
);
it('keeps connection, chunk and completion order while inspection is pending', async () => {
  let finish!: (value: null) => void;
  inspection.inspect.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => usePanelPortBridgeHarness(1));
  await act(async () => {
    ports[0].receive(connection('https://example.test/stream'));
  });
  await act(async () => {
    ports[0].receive({
      source: 'mearl-content-script',
      type: 'SSE_CHUNK',
      requestId: 'same-id',
      data: { text: 'accepted' },
      timestamp: 101,
    });
    ports[0].receive({
      source: 'mearl-content-script',
      type: 'SSE_COMPLETE',
      requestId: 'same-id',
      timestamp: 102,
    });
    finish(null);
  });
  expect(result.current.other[0]).toMatchObject({
    isPending: false,
    sseMessages: [{ data: { text: 'accepted' } }],
  });
});

it('merges preview SSE chunks into the request already captured by the debugger', async () => {
  const { result } = renderHook(() => usePanelPortBridgeHarness(1, 'preview-token'));
  const url = 'https://example.test/stream';
  const request = { id: 1, captureSequence: 1, source: 'requests', url, timestampMs: 100 };
  const receive = (message: object) => ports[0].receive({ type: 'notification', message });

  await act(async () => {
    ports[0].receive({ type: 'request', request, removed: [] });
    receive(connection(url));
    receive({
      source: 'mearl-content-script',
      type: 'SSE_CHUNK',
      requestId: 'same-id',
      data: 'first chunk',
      timestamp: 101,
    });
  });

  expect(result.current.other).toEqual([
    expect.objectContaining({
      id: 1,
      sseMessages: [expect.objectContaining({ data: 'first chunk' })],
    }),
  ]);
});
