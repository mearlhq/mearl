export const ELEMENT_PICKER_SESSION_STARTED_EVENT = 'mearl-element-picker-session-started';

let activeElementPickerOwner: string | null = null;

export function createElementPickerOwnerId(): string {
  return `picker-owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function announceElementPickerSession(ownerId: string): void {
  activeElementPickerOwner = ownerId;
  window.dispatchEvent(
    new CustomEvent(ELEMENT_PICKER_SESSION_STARTED_EVENT, {
      detail: { ownerId },
    }),
  );
}

export function getActiveElementPickerSessionOwner(): string | null {
  return activeElementPickerOwner;
}

export function releaseElementPickerSession(ownerId: string): void {
  if (activeElementPickerOwner === ownerId) activeElementPickerOwner = null;
}

export function getElementPickerSessionOwner(event: Event): string | null {
  const ownerId = (event as CustomEvent<{ ownerId?: unknown }>).detail?.ownerId;
  return typeof ownerId === 'string' ? ownerId : null;
}
