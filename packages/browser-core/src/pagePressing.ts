import type { PagePressParams } from './browserActionProtocol.js';

export const PAGE_PRESS_INPUT_TIMEOUT_MS = 10_000;

export type PagePressMode = 'auto' | 'dom' | 'keyboard';
export type PagePressDispatchMode = 'trusted-input' | 'dom';
export type PagePressFallbackReason = 'page-hidden';
export type PagePressModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export type PagePressDefaultAction =
  | 'none'
  | 'click'
  | 'submit'
  | 'focus-next'
  | 'focus-previous'
  | 'not-simulated';

export interface PagePressKeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

export const PAGE_PRESS_KEY_DESCRIPTORS: Readonly<Record<string, PagePressKeyDescriptor>> =
  Object.freeze({
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  });

export interface ResolvedPagePressInput {
  key: string;
  descriptor: PagePressKeyDescriptor;
  modifiers: PagePressModifier[];
  modifierFlags: number;
  pressMode: PagePressMode;
}

export interface PagePressDispatchPolicy {
  dispatchMode: PagePressDispatchMode;
  fallbackReason?: PagePressFallbackReason;
}

export interface PagePressDomTarget {
  tag: string;
  type?: string;
  role?: string;
}

export interface PagePressResultData {
  pressed: true;
  key: string;
  dispatchMode: PagePressDispatchMode | 'native-dialog';
  fallbackReason?: PagePressFallbackReason;
  target?: PagePressDomTarget;
  keydownCanceled?: boolean;
  defaultAction?: PagePressDefaultAction;
}

export type PagePressDomExecutionResult =
  | {
      pressed: true;
      target: PagePressDomTarget;
      keydownCanceled: boolean;
      defaultAction: PagePressDefaultAction;
    }
  | { pressed: false; error: string };

const MODIFIER_ALIASES: Record<string, { name: PagePressModifier; flag: number }> = {
  alt: { name: 'Alt', flag: 1 },
  ctrl: { name: 'Control', flag: 2 },
  control: { name: 'Control', flag: 2 },
  meta: { name: 'Meta', flag: 4 },
  cmd: { name: 'Meta', flag: 4 },
  command: { name: 'Meta', flag: 4 },
  shift: { name: 'Shift', flag: 8 },
};

export function resolvePagePressInput(data: PagePressParams): ResolvedPagePressInput {
  if (!data || typeof data !== 'object') throw new Error('page_press: payload is required');
  if (!data.key || typeof data.key !== 'string') {
    throw new Error('page_press: "key" must be a non-empty string');
  }

  const descriptor = PAGE_PRESS_KEY_DESCRIPTORS[data.key];
  if (!descriptor) {
    throw new Error(
      `page_press: unsupported key "${data.key}". Supported keys: ${Object.keys(PAGE_PRESS_KEY_DESCRIPTORS).join(', ')}`,
    );
  }
  if (data.pressMode !== undefined && !['auto', 'dom', 'keyboard'].includes(data.pressMode)) {
    throw new Error('page_press: "pressMode" must be one of auto, dom, keyboard');
  }
  if (data.modifiers !== undefined && !Array.isArray(data.modifiers)) {
    throw new Error('page_press: "modifiers" must be an array');
  }

  const modifiers: PagePressModifier[] = [];
  let modifierFlags = 0;
  for (const rawModifier of data.modifiers ?? []) {
    if (typeof rawModifier !== 'string') {
      throw new Error('page_press: each modifier must be a string');
    }
    const modifier = MODIFIER_ALIASES[rawModifier.toLowerCase()];
    if (!modifier) {
      throw new Error(
        `page_press: unsupported modifier "${rawModifier}". Supported modifiers: Alt, Control, Meta, Shift`,
      );
    }
    if (!modifiers.includes(modifier.name)) modifiers.push(modifier.name);
    modifierFlags |= modifier.flag;
  }

  return {
    key: data.key,
    descriptor,
    modifiers,
    modifierFlags,
    pressMode: data.pressMode ?? 'auto',
  };
}

export function resolvePagePressDispatchPolicy(
  pressMode: PagePressMode | undefined,
  visibilityState: string | undefined,
): PagePressDispatchPolicy {
  const requestedMode = pressMode ?? 'auto';
  if (requestedMode === 'dom') return { dispatchMode: 'dom' };
  if (requestedMode === 'auto' && visibilityState === 'hidden') {
    return { dispatchMode: 'dom', fallbackReason: 'page-hidden' };
  }
  return { dispatchMode: 'trusted-input' };
}

/**
 * Dispatches an untrusted keyboard sequence to the deepest focused element.
 * Native activation, form submission, and focus traversal are reproduced when
 * their DOM semantics are deterministic. Editing, selection, and viewport
 * scrolling remain event-only because synthesizing those defaults can corrupt
 * framework-controlled state.
 *
 * This function is serialized with .toString() and injected into the target
 * page, so it must not reference module scope or imported runtime values.
 */
export function pressActiveElementInPage(
  descriptor: PagePressKeyDescriptor,
  modifiers: PagePressModifier[],
): PagePressDomExecutionResult {
  let target = document.activeElement;
  while (target instanceof HTMLElement && target.shadowRoot?.activeElement) {
    target = target.shadowRoot.activeElement;
  }
  target = target ?? document.body ?? document.documentElement;
  if (!target) return { pressed: false, error: 'The page has no keyboard event target' };

  const view = target.ownerDocument?.defaultView ?? window;
  const altKey = modifiers.includes('Alt');
  const ctrlKey = modifiers.includes('Control');
  const metaKey = modifiers.includes('Meta');
  const shiftKey = modifiers.includes('Shift');
  const eventInit = {
    key: descriptor.key,
    code: descriptor.code,
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
  };
  const createKeyboardEvent = (type: string): KeyboardEvent => {
    const event = new view.KeyboardEvent(type, eventInit);
    for (const property of ['keyCode', 'which'] as const) {
      try {
        Object.defineProperty(event, property, { configurable: true, value: descriptor.keyCode });
      } catch {
        // Modern listeners use key/code; legacy numeric fields are best-effort.
      }
    }
    return event;
  };

  const keydown = createKeyboardEvent('keydown');
  target.dispatchEvent(keydown);
  const keydownCanceled = keydown.defaultPrevented;
  let defaultPrevented = keydownCanceled;
  if (!keydownCanceled && (descriptor.key === 'Enter' || descriptor.key === ' ')) {
    const keypress = createKeyboardEvent('keypress');
    target.dispatchEvent(keypress);
    defaultPrevented = keypress.defaultPrevented;
  }

  const element = target instanceof HTMLElement ? target : null;
  const tag = element?.tagName.toLowerCase() ?? target.nodeName.toLowerCase();
  const type = element?.getAttribute('type')?.toLowerCase() || undefined;
  const role = element?.getAttribute('role') || undefined;
  const hasNonShiftModifier = altKey || ctrlKey || metaKey;
  let defaultAction: PagePressDefaultAction = 'none';

  if (!defaultPrevented && element && !hasNonShiftModifier) {
    if (descriptor.key === 'Tab') {
      const candidates = Array.from(
        target.ownerDocument.querySelectorAll<HTMLElement>(
          'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]',
        ),
      )
        .filter(candidate => {
          if (
            candidate.hasAttribute('disabled') ||
            candidate.getAttribute('aria-hidden') === 'true'
          ) {
            return false;
          }
          const tabIndex = candidate.tabIndex;
          if (tabIndex < 0) return false;
          const style = view.getComputedStyle(candidate);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            candidate.getClientRects().length > 0
          );
        })
        .map((candidate, order) => ({ candidate, order, tabIndex: candidate.tabIndex }))
        .sort((left, right) => {
          const leftRank = left.tabIndex === 0 ? Number.MAX_SAFE_INTEGER : left.tabIndex;
          const rightRank = right.tabIndex === 0 ? Number.MAX_SAFE_INTEGER : right.tabIndex;
          return leftRank - rightRank || left.order - right.order;
        })
        .map(item => item.candidate);
      if (candidates.length > 0) {
        const currentIndex = candidates.indexOf(element);
        const offset = shiftKey ? -1 : 1;
        const baseIndex = currentIndex < 0 ? (shiftKey ? 0 : -1) : currentIndex;
        const nextIndex = (baseIndex + offset + candidates.length) % candidates.length;
        candidates[nextIndex].focus();
        defaultAction = shiftKey ? 'focus-previous' : 'focus-next';
      }
    } else if (descriptor.key === 'Enter') {
      const inputType = type ?? (tag === 'input' ? 'text' : undefined);
      const enterActivates =
        tag === 'button' ||
        tag === 'summary' ||
        (tag === 'a' && element.hasAttribute('href')) ||
        (tag === 'input' &&
          ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(inputType ?? ''));
      if (enterActivates) {
        element.click();
        defaultAction = 'click';
      } else if (tag === 'input') {
        const form = (element as HTMLInputElement).form;
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          defaultAction = 'submit';
        }
      }
    }
  }

  const keyupTarget =
    descriptor.key === 'Tab' ? (target.ownerDocument.activeElement ?? target) : target;
  keyupTarget.dispatchEvent(createKeyboardEvent('keyup'));

  if (
    defaultAction === 'none' &&
    !defaultPrevented &&
    !hasNonShiftModifier &&
    descriptor.key === ' ' &&
    element
  ) {
    const inputType = type ?? (tag === 'input' ? 'text' : undefined);
    const spaceActivates =
      tag === 'button' ||
      tag === 'summary' ||
      (tag === 'input' &&
        ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(inputType ?? ''));
    if (spaceActivates) {
      element.click();
      defaultAction = 'click';
    }
  }

  if (
    defaultAction === 'none' &&
    !defaultPrevented &&
    (descriptor.key === 'Tab' ||
      [
        'Backspace',
        'Delete',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        ' ',
      ].includes(descriptor.key))
  ) {
    defaultAction = 'not-simulated';
  }

  return {
    pressed: true,
    target: { tag, ...(type ? { type } : {}), ...(role ? { role } : {}) },
    keydownCanceled,
    defaultAction,
  };
}

export function buildPagePressDomExpression(input: ResolvedPagePressInput): string {
  return `(${pressActiveElementInPage.toString()})(${JSON.stringify(input.descriptor)}, ${JSON.stringify(input.modifiers)})`;
}

export function unwrapPagePressDomResult(
  value: PagePressDomExecutionResult | undefined,
): Extract<PagePressDomExecutionResult, { pressed: true }> {
  if (!value) throw new Error('page_press DOM simulation returned no value');
  if (!value.pressed) throw new Error(value.error || 'page_press DOM simulation failed');
  return value;
}
