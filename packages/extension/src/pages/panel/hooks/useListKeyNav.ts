import { useCallback, useEffect, KeyboardEvent, RefObject } from 'react';

/**
 * 为列表组件提供上下方向键导航及选中项自动滚动能力。
 *
 * 使用方需要在每个列表项上设置 `data-list-id` 属性（值为该项的 id），
 * hook 在 selectedId 变化时通过该属性定位 DOM 元素执行 scrollIntoView，
 * 即使容器中混入分隔线等非数据子节点也不会出现索引错位。
 *
 * @param items        当前展示的列表项（已过滤）
 * @param selectedId   当前选中项的 id
 * @param onSelect     选中回调
 * @param listRef      列表容器 ref
 * @returns handleKeyDown 绑定到容器的 onKeyDown
 */
export function useListKeyNav<TId extends string | number>(
  items: { id: TId }[],
  selectedId: TId | null,
  onSelect: (id: TId) => void,
  listRef: RefObject<HTMLElement | null>,
): (e: KeyboardEvent<HTMLElement>) => void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const currentIndex = items.findIndex(item => item.id === selectedId);
      const nextIndex =
        e.key === 'ArrowUp'
          ? Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1)
          : Math.min(items.length - 1, currentIndex + 1);
      if (nextIndex !== currentIndex && items[nextIndex]) {
        onSelect(items[nextIndex].id);
      }
    },
    [items, selectedId, onSelect],
  );

  // 仅在 selectedId 变化时将选中项滚动到可视区域
  useEffect(() => {
    if (selectedId === null || !listRef.current) return;
    const target = listRef.current.querySelector<HTMLElement>(`[data-list-id="${selectedId}"]`);
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedId, listRef]);

  return handleKeyDown;
}
