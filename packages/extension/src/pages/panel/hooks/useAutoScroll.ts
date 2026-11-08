import { useEffect, useLayoutEffect, useRef, useCallback, RefObject } from 'react';

const THRESHOLD = 50; // px from bottom to be considered "at the bottom"

interface UseAutoScrollOptions {
  enabled?: boolean;
  externalContainerRef?: RefObject<HTMLDivElement | null>;
  contextKey?: string | number | null;
  contentElement?: HTMLElement | null;
}

interface ScrollPosition {
  scrollTop: number;
  isNearBottom: boolean;
}

/**
 * 自动滚动 Hook
 *
 * 默认用法：将返回的 callback ref 赋给滚动容器元素。React 在元素挂载/卸载时自动
 * 调用该回调，确保即使容器延迟出现（列表从空变为非空）也能正确绑定 scroll 监听。
 *
 * 外部容器用法：传入 externalContainerRef（容器由父级管理），hook 通过 useEffect
 * 绑定监听，返回的 callback ref 此时无需使用。
 *
 * @param contentVersion - 内容版本，变化时触发滚动检查；可传长度或内容集合引用
 * @param options - 自动滚动开关、外部容器，以及用于独立保存滚动位置的上下文标识
 */
export function useAutoScroll(
  contentVersion: unknown,
  options: UseAutoScrollOptions = {},
): (node: HTMLDivElement | null) => void {
  const { enabled = true, externalContainerRef, contextKey, contentElement } = options;
  const isNearBottomRef = useRef(true);
  const internalNodeRef = useRef<HTMLDivElement | null>(null);
  const activeContextKeyRef = useRef(contextKey);
  const scrollPositionsRef = useRef(new Map<string | number, ScrollPosition>());

  const getEl = useCallback(
    () => (externalContainerRef ? externalContainerRef.current : internalNodeRef.current),
    [externalContainerRef],
  );

  const handleScroll = useCallback(() => {
    const el = getEl();
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const isNearBottom = scrollHeight - scrollTop - clientHeight <= THRESHOLD;
    isNearBottomRef.current = isNearBottom;
    const activeContextKey = activeContextKeyRef.current;
    if (activeContextKey !== null && activeContextKey !== undefined) {
      scrollPositionsRef.current.set(activeContextKey, { scrollTop, isNearBottom });
    }
  }, [getEl]);

  // 内部容器：callback ref，在容器挂载/卸载时绑定/解绑 scroll 监听
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (internalNodeRef.current)
        internalNodeRef.current.removeEventListener('scroll', handleScroll);
      internalNodeRef.current = node;
      if (node && !externalContainerRef) {
        node.addEventListener('scroll', handleScroll, { passive: true });
        // 新挂载的列表默认跟随最新内容，用户产生滚动后再按实际位置更新状态。
        isNearBottomRef.current = true;
      }
    },
    [handleScroll, externalContainerRef],
  );

  // 外部容器：effect 绑定 scroll 监听
  useEffect(() => {
    if (!externalContainerRef?.current) return;
    const el = externalContainerRef.current;
    el.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener('scroll', handleScroll);
  }, [externalContainerRef, handleScroll]);

  // 上下文切换时在浏览器绘制前恢复位置，避免先展示旧位置再跳转。
  useLayoutEffect(() => {
    activeContextKeyRef.current = contextKey;
    if (contextKey === null || contextKey === undefined) return;
    const el = getEl();
    if (!el) return;
    const position = scrollPositionsRef.current.get(contextKey);
    isNearBottomRef.current = position?.isNearBottom ?? true;
    el.scrollTop = position && !position.isNearBottom ? position.scrollTop : el.scrollHeight;
  }, [contextKey, getEl]);

  // 内容变化时，若在底部则自动滚动到最新位置
  useLayoutEffect(() => {
    if (!enabled || contentVersion === 0 || contentVersion == null) return;
    if (!isNearBottomRef.current) return;
    const el = getEl();
    if (el) el.scrollTop = el.scrollHeight;
  }, [contentVersion, enabled, getEl]);

  useLayoutEffect(() => {
    if (!enabled || !contentElement || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      const el = getEl();
      if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [contentElement, enabled, getEl]);

  return setRef;
}
