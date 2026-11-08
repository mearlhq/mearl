import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CapturedRequest } from '../../types';
import { RequestList } from '../RequestList';
import { useRequestFilters } from '../../hooks/useRequestFilters';

vi.mock('../../hooks/useLocalStorage', () => ({
  useLocalStorage: <T,>(_key: string, initialValue: T) => {
    const [value, setValue] = useState(initialValue);
    return [value, setValue, true];
  },
}));

vi.mock('../../hooks/useFilterBarCollapsed', () => ({
  useFilterBarCollapsed: () => [false, vi.fn(), true],
}));

vi.mock('../../utils/i18n', () => ({
  t: (key: string) => key,
}));

const createRequest = (overrides: Partial<CapturedRequest>): CapturedRequest => ({
  id: 1,
  timestamp: '2026/09/14 14:50:28',
  timestampMs: 1,
  method: 'POST',
  url: 'https://h5api.m.shop.com/h5/sample.api.flight.search/1.0/',
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
  namespace: (overrides.apiName ?? 'example.trip.flight.search').split('.')[2],
  ...overrides,
});

const ListHarness = ({
  requests,
  filterTypes = true,
}: {
  requests: CapturedRequest[];
  filterTypes?: boolean;
}) => {
  const filters = useRequestFilters(
    requests,
    requests.some(request => request.source !== 'requests'),
    { filterTypes },
  );
  return (
    <RequestList
      filters={filters}
      requests={requests}
      onClear={vi.fn()}
      selectedRequestId={null}
      onSelectRequest={vi.fn()}
      onHideApi={vi.fn()}
      pinnedFieldsByRequestId={new Map()}
      onUnpinField={vi.fn()}
      filterText=""
      onFilterChange={vi.fn()}
    />
  );
};

const renderList = (requests: CapturedRequest[]) => render(<ListHarness requests={requests} />);

describe('RequestList', () => {
  it.each([false, true])('displays local time in both widths for isSSE=%s', isSSE => {
    const date = new Date(2026, 9, 15, 15, 32, 27, 730);
    renderList([
      createRequest({
        timestamp: isSSE ? date.toISOString() : '2026/10/15 15:32:27',
        timestampMs: date.getTime(),
        isSSE,
        isProxy: isSSE,
      }),
    ]);

    expect(screen.getByTitle('2026/10/15 15:32:27')).toBeInTheDocument();
    expect(screen.getByText('2026/10/15 15:32:27')).toBeInTheDocument();
    expect(screen.getByText('15:32:27')).toBeInTheDocument();
    expect(screen.queryByText(date.toISOString())).not.toBeInTheDocument();
  });

  it('keeps Protocol namespace filters when captured requests carry resource types', () => {
    renderList([
      createRequest({ id: 1, resourceType: 'fetch' }),
      createRequest({
        id: 2,
        method: 'GET',
        apiName: 'sample.api.hotel.search',
        url: 'https://h5api.m.shop.com/h5/sample.api.hotel.search/1.0/',
        resourceType: 'script',
      }),
    ]);

    expect(screen.queryByRole('button', { name: /Fetch/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /JS/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Protocol 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /flight/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hotel/ })).toBeInTheDocument();
    expect(screen.getByText('GET')).toBeInTheDocument();
  });

  it('shows only types with data and keeps HTTP defaults without Protocol data', () => {
    renderList([
      createRequest({ source: 'requests', resourceType: 'xhr' }),
      createRequest({ id: 2, source: 'requests', resourceType: 'fetch' }),
    ]);

    expect(screen.getByRole('button', { name: /XHR/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fetch/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Protocol/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CSS/ })).not.toBeInTheDocument();
  });

  const mixedRequests = [
    createRequest({ id: 1, resourceType: 'fetch' }),
    createRequest({ id: 2, apiName: 'sample.api.hotel.search', resourceType: 'script' }),
    createRequest({ id: 3, source: 'requests', resourceType: 'fetch', apiName: '/config.json' }),
    createRequest({ id: 4, source: 'requests', resourceType: 'image', apiName: '/logo.png' }),
  ];

  it('defaults to Protocol and shows namespaces only while displaying Protocol alone', () => {
    renderList(mixedRequests);
    const typeButtons = screen.getAllByRole('button');
    expect(typeButtons.indexOf(screen.getByRole('button', { name: 'Protocol 2' }))).toBeLessThan(
      typeButtons.indexOf(screen.getByRole('button', { name: 'Fetch 1' })),
    );
    expect(screen.queryByText('/config.json')).not.toBeInTheDocument();
    expect(screen.queryByText('/logo.png')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'flight 1' }));
    expect(screen.getByText('sample.api.flight.search')).toBeInTheDocument();
    expect(screen.queryByText('sample.api.hotel.search')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fetch 1' }));
    expect(screen.queryByRole('button', { name: 'flight 1' })).not.toBeInTheDocument();
    expect(screen.getByText('sample.api.hotel.search')).toBeInTheDocument();
    expect(screen.getByText('/config.json')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fetch 1' }));
    expect(screen.getByRole('button', { name: 'flight 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText('sample.api.hotel.search')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Protocol 2' }));
    expect(screen.getByText('noMatchingRequests')).toBeInTheDocument();
  });

  it('prefers Protocol when it arrives after regular requests', () => {
    const { rerender } = renderList([mixedRequests[2]]);
    expect(screen.getByText('/config.json')).toBeInTheDocument();
    rerender(<ListHarness requests={mixedRequests} />);
    expect(screen.queryByText('/config.json')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Protocol 2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves explicit type selections when Protocol arrives', () => {
    const { rerender } = renderList([mixedRequests[2], mixedRequests[3]]);
    fireEvent.click(screen.getByRole('button', { name: 'IMG 1' }));
    rerender(<ListHarness requests={mixedRequests} />);
    expect(screen.getByText('/config.json')).toBeInTheDocument();
    expect(screen.getByText('/logo.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Protocol 2' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('classifies a regular request without a resource type as Other', () => {
    renderList([
      createRequest({ source: 'requests', resourceType: undefined, apiName: '/unknown' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Other 1' }));
    expect(screen.getByText('/unknown')).toBeInTheDocument();
  });

  it('preserves the device-capture list without resource-type filtering', () => {
    render(<ListHarness requests={mixedRequests} filterTypes={false} />);
    expect(screen.queryByRole('button', { name: /Protocol|Fetch|IMG/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'flight 1' })).toBeInTheDocument();
    expect(screen.getByText('/config.json')).toBeInTheDocument();
    expect(screen.getByText('/logo.png')).toBeInTheDocument();
  });
});
