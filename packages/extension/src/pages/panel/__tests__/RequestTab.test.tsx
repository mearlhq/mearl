import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestTab } from '../components/tabs/RequestTab';
import { formatBytes } from '../utils/helpers';
import { CapturedRequest } from '../types';

vi.mock('../components/CopyButton', () => ({
  CopyButton: () => <button type="button">copy</button>,
}));

vi.mock('../components/ResendButton', () => ({
  ResendButton: () => <button type="button">resend</button>,
}));

vi.mock('../components/detail/DetailSection', () => ({
  DetailSection: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <section>
      <div>{title}</div>
      <div>{children}</div>
    </section>
  ),
}));

vi.mock('../components/detail/JsonViewer', () => ({
  JsonViewer: () => <div>json-viewer</div>,
}));

vi.mock('../components/detail/PinnedFieldsDisplay', () => ({
  PinnedFieldsDisplay: () => <div>pinned-fields</div>,
}));

vi.mock('../utils/i18n', () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      requestBody: '请求体',
      queryParams: '查询参数',
      editRequest: '编辑请求',
      fullRequest: '完整请求',
      noRequestBody: '无请求体',
    };

    return translations[key] || key;
  },
}));

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
}));

const noop = () => {};

const baseRequest: CapturedRequest = {
  id: 1,
  timestamp: '2026/03/19 12:00:00',
  timestampMs: 1,
  method: 'GET',
  url: 'https://example.com/mtop.test?data=%7B%22foo%22%3A%22bar%22%7D',
  apiName: 'mtop.test',
  status: 200,
  statusText: 'OK',
  headers: [],
  responseHeaders: [],
  queryString: [{ name: 'data', value: '{"foo":"bar"}' }],
  postData: null,
  responseBody: null,
  isProxy: false,
  proxyRequestUrl: null,
  proxyData: null,
};

describe('RequestTab', () => {
  it('GET 请求应按展示的查询参数内容计算大小', () => {
    const parsedRequestData = { data: { foo: 'bar' } };
    const expectedSize = formatBytes(new Blob([JSON.stringify(parsedRequestData)]).size);

    render(
      <RequestTab
        request={{
          ...baseRequest,
          requestBodySize: 0,
        }}
        parsedRequestData={parsedRequestData}
        collapsedSections={{}}
        toggleSection={noop}
        pinnedFields={[]}
        onUnpinField={noop}
        onPinField={noop}
        expandedPaths={{}}
        onToggleExpand={noop}
        onOpenModal={noop}
      />,
    );

    expect(screen.getByText('查询参数')).toBeInTheDocument();
    expect(screen.getByText(expectedSize)).toBeInTheDocument();
    expect(screen.queryByText('0 B')).not.toBeInTheDocument();
  });

  it('GET 代理请求即使有 proxyData 也应显示为查询参数', () => {
    const parsedRequestData = { foo: 'bar' };

    render(
      <RequestTab
        request={{
          ...baseRequest,
          queryString: [],
          proxyData: parsedRequestData,
          isProxy: true,
          proxyRequestUrl: 'https://h5api.m.shop.com/h5/mtop.test/1.0/',
        }}
        parsedRequestData={parsedRequestData}
        collapsedSections={{}}
        toggleSection={noop}
        pinnedFields={[]}
        onUnpinField={noop}
        onPinField={noop}
        expandedPaths={{}}
        onToggleExpand={noop}
        onOpenModal={noop}
      />,
    );

    expect(screen.getByText('查询参数')).toBeInTheDocument();
    expect(screen.queryByText('请求体')).not.toBeInTheDocument();
  });

  it('POST 请求应继续优先显示网络请求体大小', () => {
    const requestBodySize = 128;
    const parsedRequestData = { foo: 'bar' };

    render(
      <RequestTab
        request={{
          ...baseRequest,
          method: 'POST',
          queryString: [],
          postData: parsedRequestData,
          requestBodySize,
        }}
        parsedRequestData={parsedRequestData}
        collapsedSections={{}}
        toggleSection={noop}
        pinnedFields={[]}
        onUnpinField={noop}
        onPinField={noop}
        expandedPaths={{}}
        onToggleExpand={noop}
        onOpenModal={noop}
      />,
    );

    expect(screen.getByText('请求体')).toBeInTheDocument();
    expect(screen.getByText(formatBytes(requestBodySize))).toBeInTheDocument();
  });
});
