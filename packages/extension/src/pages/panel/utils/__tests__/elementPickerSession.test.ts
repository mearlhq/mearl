import { describe, expect, it, vi } from 'vitest';
import {
  ELEMENT_PICKER_SESSION_STARTED_EVENT,
  announceElementPickerSession,
  createElementPickerOwnerId,
  getActiveElementPickerSessionOwner,
  getElementPickerSessionOwner,
  releaseElementPickerSession,
} from '../elementPickerSession';

describe('elementPickerSession', () => {
  it('announces one picker owner to every panel entry', () => {
    const listener = vi.fn();
    window.addEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, listener);

    const ownerId = createElementPickerOwnerId();
    announceElementPickerSession(ownerId);

    expect(listener).toHaveBeenCalledOnce();
    expect(getElementPickerSessionOwner(listener.mock.calls[0]![0])).toBe(ownerId);
    expect(getActiveElementPickerSessionOwner()).toBe(ownerId);
    releaseElementPickerSession(ownerId);
    expect(getActiveElementPickerSessionOwner()).toBeNull();
    window.removeEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, listener);
  });
});
