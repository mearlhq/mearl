import { useCallback, useSyncExternalStore } from 'react';
import { fontSize } from '../fontSize';

/**
 * React hook，用于在组件中读取和操作字体大小。
 *
 * 底层状态由 `@/shared/fontSize` 模块管理，
 * 本 hook 通过 `useSyncExternalStore` 订阅变更，保证 UI 同步。
 */
export function useFontSize() {
  const currentIndex = useSyncExternalStore(fontSize.subscribe, () => fontSize.currentIndex);

  return {
    currentSize: fontSize.levels[currentIndex],
    currentLevel: currentIndex,
    totalLevels: fontSize.levels.length,
    isMaxSize: currentIndex >= fontSize.levels.length - 1,
    isMinSize: currentIndex <= 0,
    zoomIn: useCallback(() => fontSize.zoomIn(), []),
    zoomOut: useCallback(() => fontSize.zoomOut(), []),
    resetSize: useCallback(() => fontSize.reset(), []),
    setScale: useCallback((ratio: number) => fontSize.setScale(ratio), []),
    setLevel: useCallback((index: number) => fontSize.setLevel(index), []),
  };
}
