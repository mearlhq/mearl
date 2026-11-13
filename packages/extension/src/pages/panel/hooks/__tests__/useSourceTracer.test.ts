import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedRequest } from '../../types';
import { useSourceTracer } from '../useSourceTracer';
import { usePanelDerivedData } from '../usePanelDerivedData';
import { useRequestFilters } from '../useRequestFilters';
import { sendMessageSafely } from '../../utils/safeChrome';

vi.mock('../../utils/safeChrome', () => ({
  sendMessageSafely: vi.fn().mockResolvedValue({ success: true }),
  storageGetSafely: vi.fn().mockResolvedValue({}),
  storageSetSafely: vi.fn().mockResolvedValue(undefined),
}));

const text = '直飞且便宜点';
function request(id: number, overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    source: 'protocol',
    namespace: (overrides.apiName ?? 'example.api.example.search').split('.')[2],
    id,
    timestampMs: id,
    timestamp: '',
    apiName: 'mtop.api.example.search',
    url: 'https://example.com/search',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    headers: [],
    responseHeaders: [],
    queryString: [],
    postData: null,
    responseBody: { data: { tags: [{ title: text }] } },
    isProxy: false,
    proxyRequestUrl: null,
    proxyData: null,
    ...overrides,
  };
}
function useHarness(
  requests: CapturedRequest[],
  filterText: string,
  onResult: Parameters<typeof useSourceTracer>[0]['onResult'],
  pageStartedAt = 0,
) {
  const { filteredRequests } = usePanelDerivedData({
    requests: requests.filter(r => r.source !== 'requests'),
    nonCapturedRequests: requests.filter(r => r.source === 'requests'),
    rumEvents: [],
    pinnedFields: [],
    pinnedEventFields: [],
    selectedRequestId: null,
    selectedRumEventId: null,
    hiddenApisSet: new Set(['mtop.api.hidden.search']),
    hiddenNonProtocolApisSet: new Set(),
    filterText,
    rumFilterText: '',
    rumSelectedTypes: [],
    apiOverrides: new Map(),
  });
  const filters = useRequestFilters(filteredRequests, true);
  const tracer = useSourceTracer({
    tabId: 1,
    getRequests: () =>
      filters.displayedRequests.filter(request => request.timestampMs >= pageStartedAt),
    scopeKey: JSON.stringify([
      filterText,
      filters.selectedTypes,
      filters.selectedNamespaces,
      pageStartedAt,
    ]),
    onResult,
  });
  return { ...tracer, filters };
}
function dispatchTrace() {
  window.dispatchEvent(
    new CustomEvent('mearl-element-traced', {
      detail: {
        frameId: 7,
        payload: {
          ok: true,
          reason: 'rax_no_source',
          componentName: 'ScrollView',
          candidates: [{ value: text, from: 'text', propPath: ['textContent'], depth: 0 }],
          elementInfo: { tag: 'span', text, selector: 'span', attrs: [] },
          pageInfo: { url: 'https://example.com', pathname: '/' },
        },
      },
    }),
  );
}
async function pick(start: () => void) {
  await act(async () => start());
  await act(async () => dispatchTrace());
}

it('starts and cancels tracing on the embedded tab without DevTools', async () => {
  vi.stubGlobal('chrome', { ...chrome, devtools: undefined });
  try {
    const onResult = vi.fn();
    const { result } = renderHook(() =>
      useSourceTracer({ tabId: 42, getRequests: () => [request(1)], scopeKey: '', onResult }),
    );
    await pick(result.current.start);
    expect(sendMessageSafely).toHaveBeenCalledWith({
      action: 'startElementPicker',
      tabId: 42,
      traceMode: true,
    });
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: 7,
        matches: [expect.objectContaining({ path: ['data', 'tags', '0', 'title'] })],
      }),
    );
    await act(async () => result.current.start());
    act(() => result.current.cancel());
    expect(sendMessageSafely).toHaveBeenLastCalledWith({
      action: 'cancelElementPicker',
      tabId: 42,
      traceMode: true,
    });
    expect(result.current.isPicking).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
describe('source trace request scope', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());
  it('matches an older displayed response despite more than 30 newer requests', async () => {
    const onResult = vi.fn();
    const requests = [
      request(1),
      ...Array.from({ length: 40 }, (_, i) =>
        request(i + 2, { responseBody: { message: 'other result' } }),
      ),
    ];
    const { result } = renderHook(() => useHarness(requests, '', onResult));
    await pick(result.current.start);
    expect(onResult.mock.calls[0][0]).toMatchObject({
      reason: 'rax_no_source',
      matches: [
        expect.objectContaining({
          request: expect.objectContaining({ id: 1 }),
          path: ['data', 'tags', '0', 'title'],
        }),
      ],
    });
  });
  it('excludes hidden, text-filtered and unselected resource types', async () => {
    const onResult = vi.fn();
    const requests = [
      request(1, { apiName: 'mtop.api.hidden.search' }),
      request(2, { apiName: 'mtop.api.example.excluded', url: 'https://example.com/excluded' }),
      request(3, { source: 'requests', resourceType: 'fetch' }),
      request(4, { responseBody: { message: 'other result' } }),
    ];
    const { result } = renderHook(() => useHarness(requests, 'search', onResult));
    await pick(result.current.start);
    expect(onResult.mock.calls[0][0].matches).toEqual([]);
  });
  it('excludes retained requests from earlier pages even when still displayed', async () => {
    const onResult = vi.fn();
    const requests = [request(1), request(20, { responseBody: { message: 'current page' } })];
    const { result, rerender } = renderHook(
      ({ pageStartedAt }) => useHarness(requests, '', onResult, pageStartedAt),
      { initialProps: { pageStartedAt: 10 } },
    );
    await pick(result.current.start);
    expect(onResult.mock.calls[0][0].matches).toEqual([]);
    requests.push(request(21));
    rerender({ pageStartedAt: 10 });
    await pick(result.current.start);
    expect(onResult.mock.calls[1][0].matches[0].request.id).toBe(21);
  });
  it.each(['escape', 'navigation'])(
    'yields while scanning and discards stale results after %s',
    async reason => {
      const onResult = vi.fn();
      const requests = Array.from({ length: 300 }, (_, i) =>
        request(i + 1, {
          responseBody: {
            rows: Array.from({ length: 200 }, (_, row) => ({
              title: `item ${row}`,
              description: 'sample response content',
              extra: { value: row },
            })),
          },
        }),
      );
      const { result } = renderHook(() => useHarness(requests, '', onResult));
      let responsive = false;
      await act(async () => result.current.start());
      const timer = setTimeout(() => {
        responsive = true;
        window.dispatchEvent(
          reason === 'escape'
            ? new KeyboardEvent('keydown', { key: 'Escape' })
            : new CustomEvent('mearl-main-frame-committed'),
        );
      }, 0);
      await act(async () => dispatchTrace());
      await waitFor(() => expect(responsive).toBe(true));
      expect(onResult).not.toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(onResult).not.toHaveBeenCalled();
      clearTimeout(timer);
    },
  );
  it('recomputes ranking when filters change during a yielded scan', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 4));
    const onResult = vi.fn();
    const requests = Array.from({ length: 10 }, (_, index) =>
      request(index + 1, { apiName: `mtop.api.search${index}.search` }),
    );
    const { result, rerender } = renderHook(
      ({ filterText }) => useHarness(requests, filterText, onResult),
      { initialProps: { filterText: '' } },
    );
    await act(async () => result.current.start());
    const timer = setTimeout(() => rerender({ filterText: 'search9' }), 0);
    await act(async () => dispatchTrace());
    await waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(
      onResult.mock.calls[0][0].matches.map(
        (match: { request: CapturedRequest }) => match.request.id,
      ),
    ).toEqual([10]);
    clearTimeout(timer);
  });
  it('finishes its accepted snapshot while newer requests keep arriving', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 4));
    const onResult = vi.fn();
    const requests = Array.from({ length: 10 }, (_, index) => request(index + 1));
    const { result, rerender } = renderHook(({ requests }) => useHarness(requests, '', onResult), {
      initialProps: { requests },
    });
    await act(async () => result.current.start());
    let revision = 0;
    const interval = setInterval(() => {
      revision++;
      rerender({
        requests: [...requests.map(request => ({ ...request })), request(100 + revision)],
      });
    }, 1);
    try {
      await act(async () => dispatchTrace());
      await waitFor(() => expect(onResult).toHaveBeenCalledOnce());
      expect(revision).toBeGreaterThan(0);
      expect(onResult.mock.calls[0][0].matches[0].request.id).toBe(10);
    } finally {
      clearInterval(interval);
    }
  });
  it('uses the current namespace selection and updated filters when picking', async () => {
    const onResult = vi.fn();
    const requests = [
      request(1),
      request(2, { apiName: 'mtop.api.other.search', responseBody: { message: 'other result' } }),
    ];
    const { result, rerender } = renderHook(
      ({ filterText }) => useHarness(requests, filterText, onResult),
      { initialProps: { filterText: '' } },
    );
    act(() => result.current.filters.setSelectedNamespaces(['other']));
    await pick(result.current.start);
    expect(onResult.mock.calls[0][0].matches).toEqual([]);
    act(() => result.current.filters.setSelectedNamespaces([]));
    rerender({ filterText: 'example' });
    await pick(result.current.start);
    expect(onResult.mock.calls[1][0].matches[0].request.id).toBe(1);
  });
});
