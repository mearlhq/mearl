import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpmHighlighter, type SpmHighlighter } from '../spmHighlight';

class FakeIntersectionObserver implements IntersectionObserver {
  static current: FakeIntersectionObserver | null = null;

  readonly root = null;
  readonly rootMargin = '200px';
  readonly thresholds = [0];

  private readonly callback: IntersectionObserverCallback;
  private readonly observed = new Set<Element>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.current = this;
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  show(target: Element) {
    expect(this.observed.has(target)).toBe(true);
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
        } as IntersectionObserverEntry,
      ],
      this,
    );
  }
}

let highlighter: SpmHighlighter | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  document.body.innerHTML = '';
});

afterEach(() => {
  highlighter?.clearSpmHighlight();
  highlighter?.clearAllSpmOverlay();
  highlighter = null;
  FakeIntersectionObserver.current = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function flushSpmMutation() {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(121);
}

describe('SPM full-page overlay', () => {
  it('refreshes the label when a tracked element reuses the same DOM node', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-spm-abcd', '0.0.cross-merge-traffic.book-flight');
    document.body.appendChild(target);

    highlighter = createSpmHighlighter();
    highlighter.toggleAllSpmOverlay(true);
    FakeIntersectionObserver.current?.show(target);

    const getOverlay = () => document.querySelector<HTMLElement>('[data-mtop-spm-all-overlay]');
    expect(getOverlay()?.textContent).toBe('book-flight');

    target.setAttribute('data-spm-abcd', '0.0.cross-merge-traffic.book-airpickup');
    await flushSpmMutation();
    expect(getOverlay()?.textContent).toBe('book-airpickup');

    target.setAttribute('data-spm-abcd', '');
    await flushSpmMutation();
    expect(getOverlay()?.textContent).toBe('');

    target.setAttribute('data-spm-abcd', '0.0.cross-merge-traffic.book-train');
    await flushSpmMutation();
    expect(getOverlay()?.textContent).toBe('book-train');
  });
});

describe('SPM locate highlight', () => {
  it('tracks animated geometry without requiring a separate scroll event and stops on clear', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-spm-abcd', 'a.b.card.button');
    document.body.appendChild(target);
    let top = 500;
    target.getBoundingClientRect = vi.fn(() => ({ top, left: 30, right: 230, bottom: top + 80, width: 200, height: 80 } as DOMRect));
    target.scrollIntoView = vi.fn();
    highlighter = createSpmHighlighter();
    expect(highlighter.highlightSpmOnPage('a.b.card.button')).toBe(1);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    const overlay = document.querySelector<HTMLElement>('[data-mtop-spm-hotzone]')!;
    expect(overlay.style.top).toBe('500px');
    top = 250;
    await vi.advanceTimersByTimeAsync(20);
    expect(overlay.style.top).toBe('250px');
    expect(overlay.style.getPropertyValue('transition')).toBe('none');
    expect(overlay.style.getPropertyPriority('transition')).toBe('important');
    highlighter.clearSpmHighlight();
    const reads = vi.mocked(target.getBoundingClientRect).mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(target.getBoundingClientRect).toHaveBeenCalledTimes(reads);
    expect(document.querySelector('[data-mtop-spm-hotzone]')).toBeNull();
  });

  it('replaces a previous locate loop and releases animation work after the original timeout', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-spm-abcd', 'a.b.card.button');
    target.scrollIntoView = vi.fn(); document.body.appendChild(target);
    const read = vi.spyOn(target, 'getBoundingClientRect');
    highlighter = createSpmHighlighter();
    highlighter.highlightSpmOnPage('a.b.card.button');
    highlighter.highlightSpmOnPage('a.b.card.button');
    expect(document.querySelectorAll('[data-mtop-spm-hotzone]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    const reads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(reads);
    expect(document.querySelector('[data-mtop-spm-hotzone]')).toBeNull();
  });
});
