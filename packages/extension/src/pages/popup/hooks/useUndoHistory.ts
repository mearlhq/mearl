import { useCallback, useRef } from 'react';

/**
 * 通用撤销/重做历史栈。
 *
 * 使用方式：
 * - `pushSnapshot(current)`：在用户动作发生**前**记录当前快照；会清空 redo 栈。
 * - `undo(current)`：传入当前状态，弹出 undo 栈顶并通过 `onRestore` 应用；
 *   当前状态会被推入 redo 栈，便于后续 redo。
 * - `redo(current)`：传入当前状态，弹出 redo 栈顶并通过 `onRestore` 应用；
 *   当前状态会被推回 undo 栈。
 *
 * 仅由用户主动操作（例如粘贴、编辑 JSON 字段）触发 `pushSnapshot`，
 * 内部自动流程（初始化加载、撤销/重做恢复本身）不应压栈。
 */
interface UseUndoHistoryOptions<T> {
  maxSize?: number;
  onRestore: (snapshot: T) => void;
}

export const useUndoHistory = <T>({ maxSize = 50, onRestore }: UseUndoHistoryOptions<T>) => {
  const undoStackRef = useRef<T[]>([]);
  const redoStackRef = useRef<T[]>([]);

  const pushWithCap = (stack: T[], snapshot: T) => {
    stack.push(snapshot);
    if (stack.length > maxSize) {
      stack.shift();
    }
  };

  const pushSnapshot = useCallback(
    (snapshot: T) => {
      pushWithCap(undoStackRef.current, snapshot);
      // 新的用户动作会让原先的 redo 历史失效
      redoStackRef.current = [];
    },
    [maxSize],
  );

  const undo = useCallback(
    (current: T): boolean => {
      const snapshot = undoStackRef.current.pop();
      if (snapshot === undefined) return false;
      pushWithCap(redoStackRef.current, current);
      onRestore(snapshot);
      return true;
    },
    [onRestore, maxSize],
  );

  const redo = useCallback(
    (current: T): boolean => {
      const snapshot = redoStackRef.current.pop();
      if (snapshot === undefined) return false;
      pushWithCap(undoStackRef.current, current);
      onRestore(snapshot);
      return true;
    },
    [onRestore, maxSize],
  );

  const canUndo = useCallback(() => undoStackRef.current.length > 0, []);
  const canRedo = useCallback(() => redoStackRef.current.length > 0, []);

  const clear = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, []);

  return { pushSnapshot, undo, redo, canUndo, canRedo, clear };
};
