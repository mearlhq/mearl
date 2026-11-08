export const ELEMENT_PICKER_SESSION_STARTED_EVENT = 'mearl-element-picker-session-started';

export function createElementPickerOwnerId(): string {
  return `picker-owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function announceElementPickerSession(ownerId: string): void {
  window.dispatchEvent(
    new CustomEvent(ELEMENT_PICKER_SESSION_STARTED_EVENT, {
      detail: { ownerId },
    }),
  );
}

export function getElementPickerSessionOwner(event: Event): string | null {
  const ownerId = (event as CustomEvent<{ ownerId?: unknown }>).detail?.ownerId;
  return typeof ownerId === 'string' ? ownerId : null;
}
