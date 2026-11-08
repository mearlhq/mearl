/**
 * page_click 命中 <option> 时的选择行为（clickElementViaJS / clickElementBySelector）。
 *
 * <option> 无法通过 click 选中（原生下拉渲染在浏览器 UI 层），点击应转为
 * 设置父 <select> 的值并派发 input/change 事件，兼容 React 受控组件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clickElementBySelector,
  clickElementViaJS,
  getClickCoordsFromNode,
} from '@mearl/browser-core';

function buildSelect(): { select: HTMLSelectElement; events: string[] } {
  document.body.innerHTML = `
    <select id="track">
      <option value="ToC">ToC 服务旅行用户</option>
      <option value="ToB">ToB 服务旅行商家</option>
      <option value="ToE">通用效率工具</option>
    </select>
    <button id="btn">提交</button>
  `;
  const select = document.querySelector('select')!;
  const events: string[] = [];
  select.addEventListener('input', () => events.push('input'));
  select.addEventListener('change', () => events.push('change'));
  return { select, events };
}

describe('clickElementViaJS on <option>', () => {
  let select: HTMLSelectElement;
  let events: string[];

  beforeEach(() => {
    ({ select, events } = buildSelect());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets the parent select value and fires input/change', () => {
    const option = select.querySelectorAll('option')[2];
    const result = clickElementViaJS.call(option);

    expect(select.value).toBe('ToE');
    expect(events).toEqual(['input', 'change']);
    expect(result).toMatchObject({ tag: 'option', text: '通用效率工具' });
  });

  it('still clicks regular elements', () => {
    const btn = document.getElementById('btn')!;
    let clicked = false;
    btn.addEventListener('click', () => {
      clicked = true;
    });

    const result = clickElementViaJS.call(btn);

    expect(clicked).toBe(true);
    expect(result?.tag).toBe('button');
  });

  it('reports the resulting checkbox state without overriding a cancelled click', () => {
    document.body.innerHTML = '<input id="agreement" type="checkbox">';
    const checkbox = document.getElementById('agreement') as HTMLInputElement;
    checkbox.addEventListener('click', event => event.preventDefault());

    const result = clickElementViaJS.call(checkbox);

    expect(checkbox.checked).toBe(false);
    expect(result?.controlState).toEqual({
      type: 'checkbox',
      checkedBefore: false,
      checkedAfter: false,
    });
  });

  it('resolves a text node wrapper to its actionable ancestor', () => {
    document.body.innerHTML = '<button id="book"><span id="fare">搜索机票</span></button>';
    const button = document.getElementById('book')!;
    const span = document.getElementById('fare')!;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    const result = clickElementViaJS.call(span);

    expect(clicked).toBe(true);
    expect(result).toMatchObject({
      tag: 'button',
      strategy: 'actionable-ancestor',
      distance: 1,
    });
  });

  it('keeps an exact text target separate from a sibling link', () => {
    document.body.innerHTML = `
      <div id="agreement">
        <span id="label">我已阅读并理解</span>
        <a id="terms" href="#terms">服务协议</a>
      </div>
    `;
    const agreement = document.getElementById('agreement')!;
    const label = document.getElementById('label')!;
    const terms = document.getElementById('terms')!;
    let clickedTarget = '';
    agreement.addEventListener('click', event => {
      clickedTarget = (event.target as Element).id;
    });
    terms.addEventListener('click', event => event.preventDefault());
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(label);

    const result = clickElementViaJS.call(agreement, '我已阅读并理解');

    expect(clickedTarget).toBe('label');
    expect(result).toMatchObject({
      tag: 'span',
      text: '我已阅读并理解',
      strategy: 'exact-text-descendant',
    });
  });

  it('keeps direct text separate from the only clickable child', () => {
    document.body.innerHTML = `
      <div id="agreement">
        我已阅读并理解
        <a id="terms" href="#terms">《服务协议》</a>
        协议内容
      </div>
    `;
    const agreement = document.getElementById('agreement')!;
    const terms = document.getElementById('terms')!;
    let clickedTarget = '';
    agreement.addEventListener('click', event => {
      clickedTarget = (event.target as Element).id;
    });
    terms.addEventListener('click', event => event.preventDefault());
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(agreement);

    const result = clickElementViaJS.call(agreement, '我已阅读并理解');

    expect(clickedTarget).toBe('agreement');
    expect(result).toMatchObject({
      tag: 'div',
      strategy: 'exact-text-descendant',
      distance: 0,
    });
  });

  it('does not dispatch a DOM click through an overlay', () => {
    document.body.innerHTML = '<button id="target">继续</button><div id="overlay">弹层</div>';
    const target = document.getElementById('target')!;
    const overlay = document.getElementById('overlay')!;
    let clicked = false;
    target.addEventListener('click', () => {
      clicked = true;
    });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(overlay);

    const result = clickElementViaJS.call(target);

    expect(clicked).toBe(false);
    expect(result?.error).toContain('covered by another element');
  });

  it('uses the same exact text and occlusion checks for trusted-input coordinates', () => {
    document.body.innerHTML = `
      <div id="agreement">
        <span id="label">我已阅读并理解</span>
        <a id="terms" href="#terms">服务协议</a>
      </div>
      <div id="overlay">弹层</div>
    `;
    const agreement = document.getElementById('agreement')!;
    const label = document.getElementById('label')!;
    const overlay = document.getElementById('overlay')!;
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(label);

    expect(getClickCoordsFromNode.call(agreement, '我已阅读并理解')).toMatchObject({
      tag: 'span',
      text: '我已阅读并理解',
      strategy: 'exact-text-descendant',
    });

    vi.mocked(document.elementFromPoint).mockReturnValue(overlay);
    expect(getClickCoordsFromNode.call(agreement, '我已阅读并理解')).toMatchObject({
      error: expect.stringContaining('covered by another element'),
    });
  });

  it('accepts a hit target that is an ancestor of the requested text node', () => {
    document.body.innerHTML = '<div id="option"><span id="label">学生</span></div>';
    const option = document.getElementById('option')!;
    const label = document.getElementById('label')!;
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(option);

    expect(getClickCoordsFromNode.call(label)).toMatchObject({
      tag: 'span',
      text: '学生',
      strategy: 'self',
    });
  });

  it('scrolls a target that is clipped by a nested scroll container before hit testing', () => {
    document.body.innerHTML = `
      <div id="list" style="overflow-y: auto">
        <div id="option"><span id="label">学生</span></div>
      </div>
    `;
    const list = document.getElementById('list')!;
    const label = document.getElementById('label')!;
    let scrolled = false;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      left: 0,
      right: 300,
      bottom: 300,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    });
    vi.spyOn(label, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 10,
          y: scrolled ? 180 : 310,
          top: scrolled ? 180 : 310,
          left: 10,
          right: 110,
          bottom: scrolled ? 200 : 330,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    label.scrollIntoView = vi.fn(() => {
      scrolled = true;
    });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(label);

    expect(getClickCoordsFromNode.call(label)).toMatchObject({ x: 60, y: 190, text: '学生' });
    expect(label.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center',
      behavior: 'instant',
    });
  });

  it('keeps a partially clipped target when its click point remains visible', () => {
    document.body.innerHTML = `
      <div id="list" style="overflow-y: hidden">
        <span id="label">学生</span>
      </div>
    `;
    const list = document.getElementById('list')!;
    const label = document.getElementById('label')!;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      left: 0,
      right: 300,
      bottom: 300,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    });
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 90,
      top: 90,
      left: 10,
      right: 110,
      bottom: 130,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    });
    label.scrollIntoView = vi.fn();
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(label);

    expect(getClickCoordsFromNode.call(label)).toMatchObject({ x: 60, y: 110, text: '学生' });
  });

  it('reports persistent ancestor clipping separately from an unrelated overlay', () => {
    document.body.innerHTML = `
      <div id="list" style="overflow-y: hidden">
        <span id="label">学生</span>
      </div>
    `;
    const list = document.getElementById('list')!;
    const label = document.getElementById('label')!;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      left: 0,
      right: 300,
      bottom: 300,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    });
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 310,
      top: 310,
      left: 10,
      right: 110,
      bottom: 330,
      width: 100,
      height: 20,
      toJSON: () => ({}),
    });
    label.scrollIntoView = vi.fn();
    const hitTest = vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);

    expect(getClickCoordsFromNode.call(label)).toMatchObject({
      error: expect.stringContaining('remains clipped by a scroll container'),
    });
    expect(hitTest).not.toHaveBeenCalled();
  });

  it('uses the direct text range for trusted-input coordinates', () => {
    document.body.innerHTML = `
      <div id="agreement">
        我已阅读并理解
        <a id="terms" href="#terms">《服务协议》</a>
        协议内容
      </div>
    `;
    const agreement = document.getElementById('agreement')!;
    vi.spyOn(document, 'createRange').mockReturnValue({
      selectNodeContents: vi.fn(),
      getBoundingClientRect: () => ({
        x: 12,
        y: 20,
        width: 80,
        height: 16,
        top: 20,
        right: 92,
        bottom: 36,
        left: 12,
      }),
    } as any);
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(agreement);

    expect(getClickCoordsFromNode.call(agreement, '我已阅读并理解')).toMatchObject({
      x: 52,
      y: 28,
      tag: 'div',
      strategy: 'exact-text-descendant',
      distance: 0,
    });
  });

  it('rejects a snapshot node that has been detached', () => {
    const btn = document.getElementById('btn')!;
    btn.remove();

    expect(clickElementViaJS.call(btn)).toBeNull();
  });
});

describe('clickElementBySelector on <option>', () => {
  let select: HTMLSelectElement;
  let events: string[];

  beforeEach(() => {
    ({ select, events } = buildSelect());
  });

  it('sets the parent select value and fires input/change', () => {
    const result = clickElementBySelector('#track option[value="ToB"]', '');

    expect(select.value).toBe('ToB');
    expect(events).toEqual(['input', 'change']);
    expect(result).toMatchObject({ clicked: true, tag: 'option' });
  });

  it('reports missing elements as errors', () => {
    const result = clickElementBySelector('#nope option', '');
    expect(result.clicked).toBe(false);
    expect(result.error).toContain('Element not found');
  });

  it('uses an actionable ancestor for selector matches on nested labels', () => {
    document.body.innerHTML = '<button id="book"><span id="fare">搜索机票</span></button>';

    const result = clickElementBySelector('#fare', '');

    expect(result).toMatchObject({
      clicked: true,
      tag: 'button',
      strategy: 'actionable-ancestor',
      distance: 1,
    });
  });

  it('preserves a cancelled checkbox state when clicking by selector', () => {
    document.body.innerHTML = '<input id="agreement" type="checkbox">';
    const checkbox = document.getElementById('agreement') as HTMLInputElement;
    checkbox.addEventListener('click', event => event.preventDefault());

    const result = clickElementBySelector('#agreement', '');

    expect(checkbox.checked).toBe(false);
    expect(result.controlState).toEqual({
      type: 'checkbox',
      checkedBefore: false,
      checkedAfter: false,
    });
  });
});
