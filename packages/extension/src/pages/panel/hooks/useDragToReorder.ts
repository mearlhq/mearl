import { useState, useCallback, DragEvent } from 'react';

interface UseDragToReorderReturn {
  draggedIndex: number | null;
  dragOverIndex: number | null;
  getDragHandlers: (index: number) => {
    onDragStart: (e: DragEvent) => void;
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  isDragging: (index: number) => boolean;
  isDragOver: (index: number) => boolean;
}

/**
 * 用于列表项拖拽排序的自定义 Hook
 * @param onReorder - 拖拽完成后的回调函数，接收源索引和目标索引
 * @returns 拖拽相关的状态和处理函数
 */
export const useDragToReorder = (
  onReorder?: (fromIndex: number, toIndex: number) => void,
): UseDragToReorderReturn => {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const getDragHandlers = useCallback(
    (index: number) => ({
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        setDraggedIndex(index);
      },
      onDragEnter: (e: DragEvent) => {
        e.preventDefault();
        if (draggedIndex === null || draggedIndex === index) return;
        setDragOverIndex(index);
      },
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDragEnd: () => {
        if (draggedIndex !== null && dragOverIndex !== null && draggedIndex !== dragOverIndex) {
          onReorder?.(draggedIndex, dragOverIndex);
        }
        setDraggedIndex(null);
        setDragOverIndex(null);
      },
    }),
    [draggedIndex, dragOverIndex, onReorder],
  );

  const isDragging = useCallback((index: number) => draggedIndex === index, [draggedIndex]);

  const isDragOver = useCallback((index: number) => dragOverIndex === index, [dragOverIndex]);

  return {
    draggedIndex,
    dragOverIndex,
    getDragHandlers,
    isDragging,
    isDragOver,
  };
};
