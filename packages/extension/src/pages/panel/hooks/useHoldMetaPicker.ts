import { useCallback, useEffect, useRef } from 'react';
import {
  ELEMENT_PICKER_SESSION_STARTED_EVENT,
  getActiveElementPickerSessionOwner,
} from '../utils/elementPickerSession';

interface UseHoldMetaPickerOptions {
  enabled: boolean;
  isPicking: boolean;
  onStart: () => void;
  onCancel: () => void;
}

/**
 * Temporarily owns a picker while the Meta (Command) key is held.
 * Existing button-started picker sessions are left untouched.
 */
export function useHoldMetaPicker({
  enabled,
  isPicking,
  onStart,
  onCancel,
}: UseHoldMetaPickerOptions) {
  const ownsPickerRef = useRef(false);
  const isPickingRef = useRef(isPicking);
  const onStartRef = useRef(onStart);
  const onCancelRef = useRef(onCancel);
  const startingPickerRef = useRef(false);

  isPickingRef.current = isPicking;
  onStartRef.current = onStart;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!isPicking) ownsPickerRef.current = false;
  }, [isPicking]);

  const relinquish = useCallback(() => {
    ownsPickerRef.current = false;
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const cancelOwnedPicker = () => {
      if (!ownsPickerRef.current) return;
      ownsPickerRef.current = false;
      onCancelRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Meta' ||
        event.repeat ||
        ownsPickerRef.current ||
        isPickingRef.current ||
        getActiveElementPickerSessionOwner() !== null
      ) {
        return;
      }
      ownsPickerRef.current = true;
      startingPickerRef.current = true;
      try {
        onStartRef.current();
      } finally {
        startingPickerRef.current = false;
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') cancelOwnedPicker();
    };
    const handleSessionStarted = () => {
      if (ownsPickerRef.current && !startingPickerRef.current) relinquish();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', cancelOwnedPicker);
    window.addEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, handleSessionStarted);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', cancelOwnedPicker);
      window.removeEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, handleSessionStarted);
      cancelOwnedPicker();
    };
  }, [enabled, relinquish]);

  return relinquish;
}
