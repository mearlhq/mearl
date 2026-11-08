import { RefObject, useEffect } from 'react';

interface UseSafeFocusOptions {
  enabled?: boolean;
  selectText?: boolean;
}

type FocusableElement = HTMLElement & { select?: () => void };

export const useSafeFocus = <T extends FocusableElement>(
  ref: RefObject<T | null>,
  options: UseSafeFocusOptions = {},
) => {
  const { enabled = true, selectText = false } = options;

  useEffect(() => {
    if (!enabled) return;

    const rafId = requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;

      try {
        element.focus({ preventScroll: true });
      } catch {
        element.focus();
      }

      if (selectText && typeof element.select === 'function') {
        element.select();
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [enabled, ref, selectText]);
};
