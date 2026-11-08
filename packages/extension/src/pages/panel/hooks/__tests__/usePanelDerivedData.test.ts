import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CapturedRequest, RumEvent } from '../../types';
import { usePanelDerivedData } from '../usePanelDerivedData';

const createEvent = (id: string, type: string): RumEvent => ({
  id,
  source: 'rum',
  batchId: 1,
  batchTimestampMs: 1,
  batchTimestamp: '2026/08/26 12:00:00',
  event_type: 'resource',
  type,
  name: id,
  timestamp: 1,
  _raw: {},
  _context: {
    requestUrl: '',
    app: {},
    user: {},
    session: {},
    view: {},
    properties: {},
    os: {},
    net: {},
  },
});

const renderDerivedData = (
  rumEvents: RumEvent[],
  rumSelectedTypes: string[],
  overrides: Partial<Parameters<typeof usePanelDerivedData>[0]> = {},
) =>
  renderHook(() =>
    usePanelDerivedData({
      requests: [],
      nonCapturedRequests: [],
      rumEvents,
      pinnedFields: [],
      pinnedEventFields: [],
      selectedRequestId: null,
      selectedRumEventId: null,
      hiddenApisSet: new Set(),
      hiddenNonProtocolApisSet: new Set(),
      filterText: '',
      rumFilterText: '',
      rumSelectedTypes,
      apiOverrides: new Map(),
      ...overrides,
    }),
  );

const request: CapturedRequest = {
  id: 1,
  timestamp: '',
  timestampMs: 20,
  method: 'GET',
  url: 'https://example.com/sample.api.flight.search',
  apiName: 'sample.api.flight.search',
  status: 200,
  statusText: 'OK',
  headers: [],
  responseHeaders: [],
  queryString: [],
  postData: null,
  responseBody: null,
  isProxy: false,
  proxyRequestUrl: null,
  proxyData: null,
  source: 'protocol',
};

describe('usePanelDerivedData unified requests', () => {
  it('merges chronologically, applies source-specific hidden APIs and selects HTTP details', () => {
    const regular: CapturedRequest = {
      ...request,
      id: 2,
      timestampMs: 10,
      source: 'requests',
      apiName: '/config.json',
    };
    const { result } = renderDerivedData([], [], {
      requests: [request, { ...request, id: 3, apiName: 'hidden.mtop' }],
      nonCapturedRequests: [regular, { ...regular, id: 4, apiName: '/hidden' }],
      hiddenApisSet: new Set(['hidden.mtop']),
      hiddenNonProtocolApisSet: new Set(['/hidden']),
      selectedRequestId: 2,
    });
    expect(result.current.filteredRequests.map(request => request.id)).toEqual([2, 1]);
    expect(result.current.selectedRequest).toBe(regular);
  });

  it('searches URLs across both request sources', () => {
    const regular: CapturedRequest = {
      ...request,
      id: 2,
      source: 'requests',
      apiName: '/config.json',
    };
    const { result } = renderDerivedData([], [], {
      requests: [request],
      nonCapturedRequests: [regular],
      filterText: 'example.com',
    });
    expect(result.current.filteredRequests).toHaveLength(2);
  });
});

describe('usePanelDerivedData RUM 类型筛选', () => {
  it('将静态和媒体资源聚合为 assets，同时保留请求类型筛选', () => {
    const events = [
      createEvent('js', 'js'),
      createEvent('css', 'css'),
      createEvent('image', 'image'),
      createEvent('font', 'font'),
      createEvent('video', 'video'),
      createEvent('audio', 'audio'),
      createEvent('xhr', 'xhr'),
    ];
    const { result } = renderDerivedData(events, ['rum/assets']);

    expect(result.current.rumAvailableTypes).toEqual([
      { type: 'rum/resource:xhr', count: 1 },
      { type: 'rum/assets', count: 6 },
    ]);
    expect(result.current.filteredRumEvents.map(event => event.id)).toEqual([
      'js',
      'css',
      'image',
      'font',
      'video',
      'audio',
    ]);
    expect(result.current.filteredRumEvents.map(event => event.type)).toEqual([
      'js',
      'css',
      'image',
      'font',
      'video',
      'audio',
    ]);
  });
});
