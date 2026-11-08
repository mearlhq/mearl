import { createRef } from 'react';
import { render, renderHook, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JsonTree } from '../components/json-tree/JsonTree';
import { useJsonTreeSearch } from '../components/json-tree/useJsonTreeSearch';

type UseJsonTreeSearchProps = Parameters<typeof useJsonTreeSearch>[0];

describe('useJsonTreeSearch', () => {
  const createProps = (
    overrides: Partial<UseJsonTreeSearchProps> = {},
  ): UseJsonTreeSearchProps => ({
    data: {
      nested: {
        tip: 'target text',
      },
    },
    name: 'data',
    depth: 1,
    searchQuery: 'target',
    currentMatchIndex: 0,
    matchNavigationVersion: 0,
    pathKey: 'response-body.data',
    expanded: false,
    matchStartIndex: 0,
    onToggleExpand: vi.fn(),
    setIsExpanded: vi.fn(),
    elementRef: createRef<HTMLDivElement>(),
    ...overrides,
  });

  it('搜索词变化时应自动展开命中分支', () => {
    const onToggleExpand = vi.fn();

    renderHook(() =>
      useJsonTreeSearch(
        createProps({
          searchQuery: 'target',
          onToggleExpand,
        }),
      ),
    );

    expect(onToggleExpand).toHaveBeenCalledWith({ 'response-body.data': true });
  });

  it('导航版本变化时应重新触发展开', () => {
    const onToggleExpand = vi.fn();

    const { rerender } = renderHook(
      ({ matchNavigationVersion }) =>
        useJsonTreeSearch(
          createProps({
            searchQuery: 'target',
            expanded: false,
            matchNavigationVersion,
            onToggleExpand,
          }),
        ),
      {
        initialProps: { matchNavigationVersion: 0 },
      },
    );

    onToggleExpand.mockClear();

    rerender({ matchNavigationVersion: 1 });

    expect(onToggleExpand).toHaveBeenCalledWith({ 'response-body.data': true });
  });

  it('折叠分支展开后仍按完整树顺序定位当前匹配', async () => {
    const scrolledPaths: string[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element) {
        scrolledPaths.push((this as HTMLElement).dataset.jsonPath ?? '');
      });

    render(
      <JsonTree
        data={{ hidden: { value: 'target' }, visible: 'target' }}
        searchQuery="target"
        currentMatchIndex={0}
        defaultExpandDepth={1}
      />,
    );

    const hiddenMatch = await waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-json-path="hidden.value"]');
      expect(row).not.toBeNull();
      return within(row!).getByText('target');
    });
    const visibleRow = document.querySelector<HTMLElement>('[data-json-path="visible"]')!;

    expect(hiddenMatch).toHaveClass('bg-orange-400');
    expect(within(visibleRow).getByText('target')).toHaveClass('bg-yellow-400');
    await waitFor(() => expect(scrolledPaths).toEqual(['hidden.value']), { timeout: 600 });
    scrollIntoView.mockRestore();
  });
});
