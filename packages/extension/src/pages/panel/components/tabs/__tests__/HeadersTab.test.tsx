import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HeadersTab } from '../HeadersTab';
import type { CapturedRequest } from '../../../types';

vi.mock('../../../utils/i18n', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
vi.mock('../../detail/TtidQueryParam', () => ({
  TtidQueryParam: ({ ttidValue }: { ttidValue: string }) => <button>Query {ttidValue}</button>,
}));

const request: CapturedRequest = {
  id: 1,
  timestamp: '2026/10/12',
  timestampMs: 1,
  method: 'GET',
  url: 'https://example.com/?ttid=client-ttid',
  apiName: 'mtop.test',
  status: 200,
  statusText: 'OK',
  headers: [],
  responseHeaders: [],
  queryString: [{ name: 'ttid', value: 'client-ttid' }],
  postData: null,
  responseBody: null,
  isProxy: false,
  proxyRequestUrl: null,
  proxyData: null,
};

const props = {
  request,
  collapsedSections: {},
  toggleSection: vi.fn(),
  expandedPaths: {},
  onToggleExpand: vi.fn(),
  onTabChange: vi.fn(),
  onOpenModal: vi.fn(),
};

describe('Tracking metadata query in request headers', () => {
  it('keeps the raw TTID and hides its query action when disabled', () => {
    render(<HeadersTab {...props} trackingMetadataEnabled={false} />);
    expect(screen.getByText('client-ttid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Query client-ttid' })).toBeNull();
  });

  it('shows the query action while enabled and hides it immediately on disable', () => {
    const view = render(<HeadersTab {...props} trackingMetadataEnabled />);
    expect(screen.getByRole('button', { name: 'Query client-ttid' })).toBeInTheDocument();
    view.rerender(<HeadersTab {...props} trackingMetadataEnabled={false} />);
    expect(screen.queryByRole('button', { name: 'Query client-ttid' })).toBeNull();
  });
});

describe('Request timestamp', () => {
  it.each(['qa-east.2', 'constructor', 'toString'])('renders a plugin environment ID as text: %s', environment => {
    render(<HeadersTab {...props} request={{ ...request, environment }} />);
    expect(screen.getByText(environment)).toBeInTheDocument();
  });

  it('formats a background SSE timestamp as local time', () => {
    const date = new Date(2026, 9, 15, 15, 32, 27, 730);
    render(
      <HeadersTab
        {...props}
        request={{
          ...request,
          timestamp: date.toISOString(),
          timestampMs: date.getTime(),
          isSSE: true,
          isProxy: true,
        }}
      />,
    );

    expect(screen.getByText('2026/10/15 15:32:27')).toBeInTheDocument();
    expect(screen.queryByText(date.toISOString())).not.toBeInTheDocument();
  });
});
