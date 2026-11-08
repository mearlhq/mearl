// @vitest-environment happy-dom
import { inspectElementsInPage } from '../domInspection';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clickElementBySelector,
  clickElementViaJS,
  getClickCoordsFromNode,
  getClickCoordsFromSelector,
  createPageClickResult,
  isStateAwareClickTarget,
} from '../domClicking';

function bounds(element: Element, x: number, y: number, width: number, height: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('native option selection', () => {
  const click = (mode: 'ref' | 'selector') =>
    mode === 'ref'
      ? clickElementViaJS.call(document.querySelector('#target'))
      : clickElementBySelector('#target', '');

  it.each(['ref', 'selector'] as const)('selects the exact option and reports state via %s', mode => {
    document.body.innerHTML = '<select><option value="old">Old</option><option value="same">First</option><option id="target" value="same">Second</option></select>';
    const select = document.querySelector('select')!;
    const events: string[] = [];
    select.addEventListener('input', () => events.push('input'));
    select.addEventListener('change', () => events.push('change'));
    const result = click(mode)!;
    expect(select.selectedIndex).toBe(2);
    expect(events).toEqual(['input', 'change']);
    expect(
      createPageClickResult({ kind: 'selector', selector: '#target' }, result).selectionState,
    ).toEqual({ valueBefore: 'old', valueAfter: 'same', selectedAfter: true });
  });

  it.each(['ref', 'selector'] as const)('reports a selection reverted by the page via %s', mode => {
    document.body.innerHTML = '<select><option value="old">Old</option><option id="target" value="new">New</option></select>';
    const select = document.querySelector('select')!;
    select.addEventListener('change', () => {
      select.value = 'old';
    });
    expect(click(mode)?.selectionState).toEqual({
      valueBefore: 'old',
      valueAfter: 'old',
      selectedAfter: false,
    });
  });

  it.each(['select', 'option', 'optgroup'] as const)('rejects a disabled %s without events', tag => {
    for (const mode of ['ref', 'selector'] as const) {
      document.body.innerHTML = '<fieldset><select><option value="old">Old</option><optgroup label="Group"><option id="target" value="new">New</option></optgroup></select></fieldset>';
      document.querySelector(tag === 'option' ? '#target' : tag)!.setAttribute('disabled', '');
      const change = vi.fn();
      document.querySelector('select')!.addEventListener('change', change);
      expect(click(mode)?.error).toMatch(/disabled/);
      expect(document.querySelector('select')!.value).toBe('old');
      expect(change).not.toHaveBeenCalled();
    }
  });

  it('distinguishes native options from custom ARIA options', () => {
    expect(isStateAwareClickTarget({
      tag: 'select', text: '', sourceTarget: { tag: 'option', text: 'New' },
    })).toBe(true);
    expect(isStateAwareClickTarget({ tag: 'div', text: 'New' })).toBe(false);
  });
});

describe('custom select DOM clicks', () => {
  it.each(['ref', 'selector'] as const)(
    'opens a mousedown select via %s without double clicks',
    mode => {
      document.body.innerHTML = '<div id="select"><span id="label">日志id</span></div>';
      const select = document.getElementById('select')!;
      const label = document.getElementById('label')!;
      const events: string[] = [];
      let open = false;
      select.addEventListener('mousedown', event => {
        open = true;
        event.preventDefault();
      });
      for (const name of ['mousedown', 'mouseup', 'click']) {
        select.addEventListener(name, () => events.push(name));
      }
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(label);
      if (mode === 'ref') clickElementViaJS.call(label);
      else clickElementBySelector('#label', '');
      expect(open).toBe(true);
      expect(events).toEqual(['mousedown', 'mouseup', 'click']);
    },
  );

  it('retains cancellation of native checkbox clicks', () => {
    document.body.innerHTML = '<input id="checkbox" type="checkbox">';
    const checkbox = document.getElementById('checkbox') as HTMLInputElement;
    checkbox.addEventListener('click', event => event.preventDefault());
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(checkbox);
    expect(clickElementViaJS.call(checkbox)?.controlState).toEqual({
      type: 'checkbox',
      checkedBefore: false,
      checkedAfter: false,
    });
    expect(checkbox.checked).toBe(false);
  });

  it('respects pointerdown cancellation without emitting compatibility mouse events', () => {
    document.body.innerHTML = '<button id="button">打开</button>';
    const button = document.getElementById('button')!;
    const events: string[] = [];
    button.addEventListener('pointerdown', event => event.preventDefault());
    for (const name of ['mousedown', 'mouseup', 'click']) {
      button.addEventListener(name, () => events.push(name));
    }
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(button);
    clickElementViaJS.call(button);
    expect(events).toEqual(['click']);
  });

  it('does not steal focus when a mousedown handler prevents its default action', () => {
    document.body.innerHTML = '<input id="search"><button id="button">打开</button>';
    const input = document.getElementById('search')!;
    const button = document.getElementById('button')!;
    input.focus();
    button.addEventListener('mousedown', event => event.preventDefault());
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(button);
    clickElementViaJS.call(button);
    expect(document.activeElement).toBe(input);
  });

  it.each(['ref', 'selector'] as const)(
    'does not dispatch input events on disabled buttons via %s',
    mode => {
      document.body.innerHTML = '<button id="button" disabled>打开</button>';
      const button = document.getElementById('button')!;
      const events: string[] = [];
      for (const name of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        button.addEventListener(name, () => events.push(name));
      }
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(button);
      const result =
        mode === 'ref' ? clickElementViaJS.call(button) : clickElementBySelector('#button', '');
      expect(result?.error).toContain('disabled');
      expect(events).toEqual([]);
    },
  );
});

function virtualOption() {
  document.body.innerHTML = `
    <div id="popup">
      <div role="listbox" style="width:0;height:0;overflow:hidden">
        <div id="proxy" role="option" aria-label="日志id" aria-selected="false">objId</div>
      </div>
      <div><div id="visual" aria-selected="false" title="日志id"><span>日志id</span></div></div>
    </div>`;
  const proxy = document.getElementById('proxy')!;
  const visual = document.getElementById('visual')!;
  bounds(proxy, 20, 20, 0, 0);
  bounds(proxy.parentElement!, 20, 20, 0, 0);
  bounds(visual, 20, 50, 120, 32);
  bounds(document.getElementById('popup')!, 20, 20, 120, 100);
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(visual);
  return { proxy, visual };
}

describe('virtual accessible options', () => {
  it('clicks the visible option represented by an AX ref, using its accessible name', () => {
    const { proxy, visual } = virtualOption();
    const onClick = vi.fn();
    visual.addEventListener('click', onClick);
    const result = clickElementViaJS.call(proxy, '日志id');
    expect(result?.error).toBeUndefined();
    expect(result).toMatchObject({ text: '日志id', strategy: 'accessible-option' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('resolves trusted-input coordinates to the visible option', () => {
    const { proxy } = virtualOption();
    expect(getClickCoordsFromNode.call(proxy, '日志id')).toMatchObject({
      x: 80,
      y: 66,
      text: '日志id',
      strategy: 'accessible-option',
    });
  });

  it.each(['dom', 'coordinates'] as const)('also resolves CSS option targets for %s', mode => {
    const { visual } = virtualOption();
    const onClick = vi.fn();
    visual.addEventListener('click', onClick);
    const result =
      mode === 'dom'
        ? clickElementBySelector('#proxy', '')
        : getClickCoordsFromSelector('#proxy', '');
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ text: '日志id', strategy: 'accessible-option' });
    expect(onClick).toHaveBeenCalledTimes(mode === 'dom' ? 1 : 0);
  });

  it('does not substitute a same-name option outside the associated popup', () => {
    const { proxy, visual } = virtualOption();
    document.body.appendChild(visual);
    const onClick = vi.fn();
    visual.addEventListener('click', onClick);
    expect(clickElementViaJS.call(proxy)?.error).toBeDefined();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not choose between multiple visible matches', () => {
    const { proxy, visual } = virtualOption();
    const duplicate = visual.cloneNode(true) as Element;
    visual.parentElement!.appendChild(duplicate);
    bounds(duplicate, 20, 90, 120, 32);
    expect(clickElementViaJS.call(proxy)?.error).toBeDefined();
  });

  it('does not redirect to a disabled option', () => {
    const { proxy, visual } = virtualOption();
    visual.setAttribute('aria-disabled', 'true');
    const onClick = vi.fn();
    visual.addEventListener('click', onClick);
    expect(clickElementViaJS.call(proxy)?.error).toBeDefined();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('retains real occlusion checks after resolving a proxy', () => {
    const { proxy, visual } = virtualOption();
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    vi.mocked(document.elementFromPoint).mockReturnValue(overlay);
    const onClick = vi.fn();
    visual.addEventListener('click', onClick);
    expect(clickElementViaJS.call(proxy)?.error).toContain('covered by another element');
    expect(getClickCoordsFromNode.call(proxy)?.error).toContain('covered by another element');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps a visible semantic option as the target', () => {
    const { proxy, visual } = virtualOption();
    bounds(proxy, 20, 20, 120, 32);
    bounds(proxy.parentElement!, 20, 20, 120, 32);
    vi.mocked(document.elementFromPoint).mockReturnValue(proxy);
    const onClick = vi.fn();
    visual.addEventListener('click', onClick);
    expect(getClickCoordsFromNode.call(proxy)?.strategy).toBe('self');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('can execute serialized click and coordinate functions without module state', () => {
    const { proxy, visual } = virtualOption();
    const onClick = vi.fn();
    visual.addEventListener('click', onClick);
    const click = new Function(`return (${clickElementViaJS.toString()});`)();
    const coords = new Function(`return (${getClickCoordsFromNode.toString()});`)();
    expect(coords.call(proxy, '日志id')).toMatchObject({ x: 80, y: 66 });
    expect(click.call(proxy, '日志id')?.error).toBeUndefined();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('shadow DOM hit testing', () => {
  function shadowButton() {
    document.body.innerHTML = '<div id="manager"></div>';
    const host = document.getElementById('manager')!;
    const outer = host.attachShadow({ mode: 'open' });
    outer.innerHTML = '<div id="item"></div>';
    const item = outer.getElementById('item')!;
    const inner = item.attachShadow({ mode: 'open' });
    inner.innerHTML = '<button id="reload">Reload</button><span id="mask">Mask</span>';
    const button = inner.getElementById('reload')!;
    (button as HTMLElement).style.opacity = '1';
    const mask = inner.getElementById('mask')!;
    bounds(button, 20, 20, 32, 32);
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(host);
    Object.defineProperty(outer, 'elementFromPoint', { configurable: true, value: () => item });
    Object.defineProperty(inner, 'elementFromPoint', { configurable: true, value: () => button });
    return { host, inner, button, mask };
  }
  it.each([false, true])('resolves nested shadow buttons with serialized=%s', serialized => {
    const { button } = shadowButton();
    const click = serialized
      ? new Function(`return (${clickElementViaJS.toString()})`)()
      : clickElementViaJS;
    const coords = serialized
      ? new Function(`return (${getClickCoordsFromNode.toString()})`)()
      : getClickCoordsFromNode;
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    expect(coords.call(button)).toMatchObject({ x: 36, y: 36 });
    expect(click.call(button)?.error).toBeUndefined();
    expect(onClick).toHaveBeenCalledOnce();
  });
  it('reports the same composed hit in page_inspect and retains inner overlay diagnostics', () => {
    const { inner, button, mask } = shadowButton();
    const inspect = new Function(`return (${inspectElementsInPage.toString()})`)();
    expect(inspect.call(button, undefined, 'all', [], 1, 'hint')).toMatchObject({
      matches: [{ hitTest: { topmost: true, receivesPointerEvents: true } }],
    });
    Object.defineProperty(inner, 'elementFromPoint', { value: () => mask });
    expect(inspect.call(button, undefined, 'all', [], 1, 'hint')).toMatchObject({
      matches: [
        { hitTest: { topmost: false, receivesPointerEvents: false, occludedBy: { tag: 'span' } } },
      ],
    });
  });
  it('rejects an overlay inside the same shadow root', () => {
    const { inner, button, mask } = shadowButton();
    Object.defineProperty(inner, 'elementFromPoint', { value: () => mask });
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    expect(getClickCoordsFromNode.call(button)?.error).toContain('covered');
    expect(clickElementViaJS.call(button)?.error).toContain('covered');
    expect(onClick).not.toHaveBeenCalled();
  });
  it('rejects an overlay outside the shadow host', () => {
    const { button } = shadowButton();
    const mask = document.createElement('div');
    document.body.append(mask);
    vi.mocked(document.elementFromPoint).mockReturnValue(mask);
    expect(getClickCoordsFromNode.call(button)?.error).toContain('covered');
  });
  it.each(['dom', 'coordinates'] as const)(
    'accepts a host whose hit is a composed descendant for %s',
    mode => {
      const { host } = shadowButton();
      bounds(host, 20, 20, 32, 32);
      const result =
        mode === 'dom'
          ? clickElementBySelector('#manager', '')
          : getClickCoordsFromSelector('#manager', '');
      expect(result.error).toBeUndefined();
    },
  );
});
