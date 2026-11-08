import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStreamTab } from '../components/tabs/EventStreamTab';
import { CapturedRequest } from '../types';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { createRef } from 'react';

vi.mock('../hooks/useAutoScroll', () => ({
  useAutoScroll: vi.fn(),
}));

vi.mock('../hooks/useLocalStorage', () => ({
  useLocalStorage: () => ['list', vi.fn(), true],
}));

vi.mock('../components/detail/SSEMessageItem', () => ({
  SSEMessageItem: ({ message, index }: { message: { data: unknown }; index: number }) => (
    <div data-testid={`message-${index}`}>{JSON.stringify(message.data)}</div>
  ),
}));

const request = {
  id: 1,
  apiName: 'mtop.test.sse',
  url: 'https://example.com/sse',
  isSSE: true,
  isPending: true,
  sseMessages: [{ event: 'message', data: { text: 'hello' } }],
} as CapturedRequest;

describe('EventStreamTab', () => {
  beforeEach(() => {
    vi.mocked(useAutoScroll).mockClear();
    (chrome.storage as any).sync = {
      get: vi.fn((_keys, callback) => callback({ sseMonitoringEnabled: true })),
      set: vi.fn(),
    };
  });

  it('应仅让全局搜索栏吸顶并提供页面取词入口', () => {
    render(
      <EventStreamTab
        request={request}
        collapsedSections={{}}
        toggleSection={vi.fn()}
        expandedPaths={{}}
        onToggleExpand={vi.fn()}
      />,
    );

    const input = screen.getByPlaceholderText('searchSseMessages');
    const searchSurface = input.closest('[data-sse-search-floating]');
    expect(input.closest('.sticky')).toHaveClass('top-2', 'z-30', 'items-center');
    expect(searchSurface).toHaveAttribute('data-sse-search-floating', 'false');
    expect(searchSurface).toHaveClass('bg-transparent');
    expect(searchSurface).not.toHaveClass('shadow-md', 'ring-1');
    expect(input.closest('.overflow-x-clip')).toBeInTheDocument();
    expect(screen.getByText('sseMessages').closest('.sticky')).toBeNull();
    expect(screen.getByTitle('pickElementForSearch')).toBeInTheDocument();
  });

  it('进入吸顶状态后应增加整体背景并保留顶部间距', () => {
    const containerRef = createRef<HTMLDivElement>();
    const scrollContainer = document.createElement('div');
    containerRef.current = scrollContainer;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      top: 40,
    } as DOMRect);

    const { container } = render(
      <EventStreamTab
        request={request}
        collapsedSections={{}}
        toggleSection={vi.fn()}
        expandedPaths={{}}
        onToggleExpand={vi.fn()}
        containerRef={containerRef}
      />,
    );
    const sentinel = container.querySelector('[data-sse-search-sentinel]') as HTMLDivElement;
    vi.spyOn(sentinel, 'getBoundingClientRect').mockReturnValue({
      top: 30,
    } as DOMRect);

    act(() => {
      scrollContainer.dispatchEvent(new Event('scroll'));
    });

    const input = screen.getByPlaceholderText('searchSseMessages');
    const searchSurface = input.closest('[data-sse-search-floating]');
    expect(searchSurface).toHaveAttribute('data-sse-search-floating', 'true');
    expect(searchSurface).toHaveClass(
      'bg-bg-primary/95',
      'backdrop-blur-sm',
      'shadow-md',
      'ring-1',
    );
    expect(input.closest('.sticky')).toHaveClass('top-2');
  });

  it('输入搜索词时应暂停流式自动滚动', () => {
    render(
      <EventStreamTab
        request={request}
        collapsedSections={{}}
        toggleSection={vi.fn()}
        expandedPaths={{}}
        onToggleExpand={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('searchSseMessages'), {
      target: { value: 'hello' },
    });

    expect(vi.mocked(useAutoScroll).mock.lastCall?.[1]).toMatchObject({ enabled: false });
  });

  it('刷新请求重置后应正常展示多层编码的原始消息', () => {
    const encodedData = JSON.stringify(JSON.stringify({ value: 'original' }));
    const modifiedRequest = {
      ...request,
      isPending: false,
      sseMessages: [{ event: 'resp', data: encodedData }],
      responseOverride: {
        id: 'override-1',
        apiName: request.apiName,
        modifiedData: [{ value: 'edited' }],
      },
    };
    const props = {
      collapsedSections: {},
      toggleSection: vi.fn(),
      expandedPaths: {},
      onToggleExpand: vi.fn(),
    };
    const { rerender } = render(<EventStreamTab request={modifiedRequest} {...props} />);

    expect(screen.getByTestId('message-0')).toHaveTextContent('{"value":"edited"}');

    rerender(
      <EventStreamTab request={{ ...modifiedRequest, responseOverride: undefined }} {...props} />,
    );

    expect(screen.getByTestId('message-0')).toHaveTextContent('{"value":"original"}');
    expect(screen.getByTestId('message-0')).not.toHaveTextContent('\\"value\\"');
  });
});
