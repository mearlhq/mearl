// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAGE_PRESS_KEY_DESCRIPTORS,
  pressActiveElementInPage,
  resolvePagePressDispatchPolicy,
  resolvePagePressInput,
} from '../pagePressing.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('page press input and dispatch policy', () => {
  it('normalizes aliases and builds the CDP modifier mask', () => {
    expect(
      resolvePagePressInput({
        tabId: 1,
        key: 'Enter',
        modifiers: ['ctrl', 'Shift', 'command', 'Control'],
      }),
    ).toMatchObject({
      key: 'Enter',
      pressMode: 'auto',
      modifiers: ['Control', 'Shift', 'Meta'],
      modifierFlags: 14,
    });
  });

  it('rejects unsupported keys, modifiers, and modes before dispatch', () => {
    expect(() => resolvePagePressInput({ tabId: 1, key: 'F13' })).toThrow('unsupported key');
    expect(() => resolvePagePressInput({ tabId: 1, key: 'Enter', modifiers: ['Hyper'] })).toThrow(
      'unsupported modifier',
    );
    expect(() =>
      resolvePagePressInput({ tabId: 1, key: 'Enter', pressMode: 'pointer' as any }),
    ).toThrow('pressMode');
  });

  it('uses DOM events automatically only for hidden pages', () => {
    expect(resolvePagePressDispatchPolicy('auto', 'hidden')).toEqual({
      dispatchMode: 'dom',
      fallbackReason: 'page-hidden',
    });
    expect(resolvePagePressDispatchPolicy('auto', 'visible')).toEqual({
      dispatchMode: 'trusted-input',
    });
    expect(resolvePagePressDispatchPolicy('keyboard', 'hidden')).toEqual({
      dispatchMode: 'trusted-input',
    });
  });
});

describe('DOM keyboard simulation', () => {
  it('dispatches the keyboard sequence and activates a focused native button', () => {
    const button = document.createElement('button');
    const events: string[] = [];
    const click = vi.fn();
    for (const name of ['keydown', 'keypress', 'keyup']) {
      button.addEventListener(name, () => events.push(name));
    }
    button.addEventListener('click', click);
    document.body.appendChild(button);
    button.focus();

    expect(pressActiveElementInPage(PAGE_PRESS_KEY_DESCRIPTORS.Enter, [])).toEqual({
      pressed: true,
      target: { tag: 'button' },
      keydownCanceled: false,
      defaultAction: 'click',
    });
    expect(events).toEqual(['keydown', 'keypress', 'keyup']);
    expect(click).toHaveBeenCalledOnce();
  });

  it('does not run a native default action when keydown is canceled', () => {
    const button = document.createElement('button');
    const click = vi.fn();
    button.addEventListener('keydown', event => event.preventDefault());
    button.addEventListener('click', click);
    document.body.appendChild(button);
    button.focus();

    expect(pressActiveElementInPage(PAGE_PRESS_KEY_DESCRIPTORS.Enter, [])).toMatchObject({
      pressed: true,
      keydownCanceled: true,
      defaultAction: 'none',
    });
    expect(click).not.toHaveBeenCalled();
  });

  it('moves focus for Tab and reports event-only browser defaults', () => {
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.getClientRects = () => [{ width: 20, height: 20 }] as any;
    second.getClientRects = () => [{ width: 20, height: 20 }] as any;
    document.body.append(first, second);
    first.focus();

    expect(pressActiveElementInPage(PAGE_PRESS_KEY_DESCRIPTORS.Tab, [])).toMatchObject({
      defaultAction: 'focus-next',
    });
    expect(document.activeElement).toBe(second);

    expect(pressActiveElementInPage(PAGE_PRESS_KEY_DESCRIPTORS.ArrowDown, [])).toMatchObject({
      defaultAction: 'not-simulated',
      target: { tag: 'button' },
    });
  });
});
