import { useCallback, useEffect, useRef, useState } from 'react';

interface UseDelayedHoverOptions {
  openDelay?: number;
  closeDelay?: number;
}

/** 延迟展开防止短暂经过误触；延迟收起允许指针跨过触发器与浮层的间距。 */
export const useDelayedHover = ({
  openDelay = 200,
  closeDelay = 200,
}: UseDelayedHoverOptions = {}) => {
  const [open, updateOpen] = useState(false);
  const openRef = useRef(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const setOpen = useCallback(
    (value: boolean) => {
      cancelOpen();
      cancelClose();
      openRef.current = value;
      updateOpen(value);
    },
    [cancelOpen, cancelClose],
  );

  const scheduleOpen = useCallback(() => {
    cancelClose();
    if (openRef.current || openTimerRef.current !== null) return;
    openTimerRef.current = setTimeout(() => setOpen(true), openDelay);
  }, [cancelClose, setOpen, openDelay]);

  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    if (!openRef.current) return;
    closeTimerRef.current = setTimeout(() => setOpen(false), closeDelay);
  }, [cancelOpen, cancelClose, setOpen, closeDelay]);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelOpen, cancelClose],
  );

  return { open, setOpen, scheduleOpen, scheduleClose, cancelOpen, cancelClose };
};
