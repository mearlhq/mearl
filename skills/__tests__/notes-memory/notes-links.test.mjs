// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let links;
beforeEach(async () => {
  const source = await readFile(join(process.cwd(), 'skills/notes-memory/assets/toolbox/links.js'), 'utf8');
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
  links = globalThis.notesLinks;
});
afterEach(() => { document.body.innerHTML = ''; delete globalThis.notesLinks; vi.restoreAllMocks(); });

describe('note link detection', () => {
  it('recognizes HTTP(S) and www links in Chinese prose and strips surrounding punctuation', () => {
    const text = '参考：https://example.com/文档?q=你好&x=1，另见 http://localhost:3000/a#section。还有 www.example.org/docs!';
    const found = links.find(text);
    expect(found.map(link => link.url)).toEqual(['https://example.com/%E6%96%87%E6%A1%A3?q=%E4%BD%A0%E5%A5%BD&x=1', 'http://localhost:3000/a#section', 'https://www.example.org/docs']);
    expect(found.map(link => text.slice(link.start, link.end))).toEqual(['https://example.com/文档?q=你好&x=1', 'http://localhost:3000/a#section', 'www.example.org/docs']);
  });

  it('preserves balanced URL parentheses while excluding Markdown delimiters', () => {
    const text = '[说明](https://example.com/a_(b))，(https://example.org/path).';
    expect(links.find(text).map(link => text.slice(link.start, link.end))).toEqual(['https://example.com/a_(b)', 'https://example.org/path']);
  });

  it('leaves unsupported, incomplete and credential-bearing URLs as text', () => {
    expect(links.find('javascript:alert(1) data:text/plain,test file:///tmp/a https:// https://user:password@example.com www.')).toEqual([]);
    expect(links.find('https://example.com/' + 'a'.repeat(8192))).toEqual([]);
  });
});

describe('note link hit testing', () => {
  function textarea() {
    const element = document.createElement('textarea');
    element.value = 'https://first.test/\nhttps://second.test/long-link';
    element.style.cssText = 'font:12px/24px sans-serif;padding:4px 12px;overflow-wrap:break-word';
    Object.defineProperties(element, { clientWidth: { value: 300 }, clientHeight: { value: 120 }, clientLeft: { value: 1 }, clientTop: { value: 1 } });
    element.getBoundingClientRect = () => ({ left: 10, top: 20, width: 302, height: 122 });
    element.scrollTop = 48; element.scrollLeft = 5;
    document.body.appendChild(element);
    return element;
  }

  it('hits wrapped fragments using scrolled layout and ignores the caret and surrounding whitespace', () => {
    const element = textarea(), initialChildren = document.body.childElementCount;
    let start, node;
    vi.spyOn(document, 'createRange').mockReturnValue({
      setStart(text, offset) { node = text; start = offset; }, setEnd() {},
      getClientRects() {
        expect(node.parentElement.scrollTop).toBe(48); expect(node.parentElement.scrollLeft).toBe(5);
        expect(node.parentElement.style.width).toBe('300px');
        return start === 0 ? [{ left: 23, right: 210, top: -10, bottom: 14 }] : [
          { left: 23, right: 280, top: 24, bottom: 48 }, { left: 23, right: 90, top: 48, bottom: 72 },
        ];
      },
    });
    element.setSelectionRange(0, 0);
    expect(links.atPoint(element, 45, 60)).toBe('https://second.test/long-link');
    expect(links.atPoint(element, 180, 60)).toBeNull();
    expect(links.atPoint(element, 400, 60)).toBeNull();
    expect(document.body.childElementCount).toBe(initialChildren);
  });

  function feedback() {
    const element = textarea(), overlay = document.createElement('div'), frames = new Map();
    document.body.appendChild(overlay);
    overlay.getBoundingClientRect = () => ({ left: 10, top: 20 });
    let id = 0, offset = 0, start;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++id, callback); return id; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
    const measure = vi.spyOn(document, 'createRange').mockReturnValue({
      setStart(_, value) { start = value; }, setEnd() {},
      getClientRects: () => start === 0 ? [{ left: 23, right: 210, top: 40 - offset, bottom: 54 - offset }] : [
        { left: 23, right: 280, top: 80 - offset, bottom: 94 - offset }, { left: 23, right: 90, top: 104 - offset, bottom: 118 - offset },
      ],
    });
    const decoration = links.decorate(element, overlay);
    const paint = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
    return { element, overlay, decoration, paint, measure, frames, scroll: value => { offset = value; element.dispatchEvent(new Event('scroll')); } };
  }

  it('underlines links while Command or Ctrl is held, shows a hand only over links, and clears on release', () => {
    const { element, overlay, decoration, paint, measure } = feedback();
    try {
      expect(overlay.children).toHaveLength(0); expect(measure).not.toHaveBeenCalled();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true })); paint();
      expect(overlay.children).toHaveLength(3);
      expect(overlay.firstElementChild.style.left).toBe('13px');
      expect(overlay.firstElementChild.style.top).toBe('20px');
      element.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 45, metaKey: true }));
      expect(element.classList.contains('is-link-hover')).toBe(true);
      expect(overlay.querySelectorAll('.is-hovered')).toHaveLength(1);
      element.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 110, metaKey: true }));
      expect(overlay.querySelectorAll('.is-hovered')).toHaveLength(2);
      element.dispatchEvent(new PointerEvent('pointermove', { clientX: 250, clientY: 110, metaKey: true }));
      expect(element.classList.contains('is-link-hover')).toBe(false);
      expect(measure).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
      expect(overlay.children).toHaveLength(0);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true })); paint();
      expect(overlay.children).toHaveLength(3);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
      expect(overlay.children).toHaveLength(0);
    } finally { decoration.dispose(); }
  });

  it('refreshes decorations on scroll and edit, and clears pending work on blur or disposal', () => {
    const { element, overlay, decoration, paint, scroll, frames } = feedback();
    try {
      element.dispatchEvent(new PointerEvent('pointerenter', { clientX: 200, clientY: 45, metaKey: true })); paint();
      expect(element.classList.contains('is-link-hover')).toBe(true);
      scroll(60); paint();
      expect(overlay.children).toHaveLength(2);
      expect(element.classList.contains('is-link-hover')).toBe(false);
      element.value = 'no links'; element.dispatchEvent(new Event('input')); paint();
      expect(overlay.children).toHaveLength(0);
      element.value = 'https://first.test/'; decoration.refresh();
      expect(frames.size).toBe(1);
      window.dispatchEvent(new Event('blur'));
      expect(frames.size).toBe(0); expect(overlay.children).toHaveLength(0);
      expect(element.classList.contains('is-link-hover')).toBe(false);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
      decoration.dispose(); paint();
      expect(frames.size).toBe(0); expect(overlay.children).toHaveLength(0);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
      expect(frames.size).toBe(0);
    } finally { decoration.dispose(); }
  });

  it('removes measurement elements even if layout measurement fails', () => {
    const element = textarea();
    vi.spyOn(document, 'createRange').mockImplementation(() => { throw new Error('measurement failed'); });
    expect(() => links.atPoint(element, 45, 60)).toThrow('measurement failed');
    expect(document.body.children).toHaveLength(1);
  });
});
