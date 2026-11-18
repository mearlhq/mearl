import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ hooks: undefined as any }));
vi.mock('../spmOverlayLifecycle', () => ({
  createSpmOverlayLifecycle: (hooks: any) => {
    mocks.hooks = hooks;
    return {
      start() {
        hooks.onTick(new Set(document.querySelectorAll('[data-spm-abcd]')));
      },
      stop: vi.fn(),
    };
  },
}));
import { createHeatmapRenderer } from '../heatmapOverlay';
afterEach(() => {
  document.body.innerHTML = '';
});
it('renders the supplied number or percentage format and clears owned overlays', () => {
  const element = document.createElement('div');
  element.setAttribute('data-spm-abcd', 'a.b.c.d');
  element.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 110,
    bottom: 60,
    width: 100,
    height: 40,
    toJSON() {},
  });
  document.body.append(element);
  const renderer = createHeatmapRenderer();
  renderer.start(
    [{ id: 'ratio', format: 'percent' }],
    [{ spm: 'a.b.c.d', spmName: 'Card', measures: { ratio: 0.125 } }],
  );
  expect(document.querySelector('[data-mtop-heatmap-overlay]')?.textContent).toBe('12.50%');
  renderer.start(
    [{ id: 'arbitrary-count', format: 'number' }],
    [{ spm: 'a.b.c.d', spmName: 'Card', measures: { 'arbitrary-count': 10000 } }],
  );
  expect(document.querySelector('[data-mtop-heatmap-overlay]')?.textContent).toBe('1.00w');
  expect(document.querySelectorAll('[data-mtop-heatmap-overlay]')).toHaveLength(1);
  renderer.stop();
  expect(document.querySelector('[data-mtop-heatmap-overlay]')).toBeNull();
});

it('renders all selected values in selection order and retains slots for missing data', () => {
  const element = document.createElement('div');
  element.setAttribute('data-spm-abcd', 'a.b.c.d');
  element.getBoundingClientRect = () => new DOMRect(10, 20, 100, 40);
  document.body.append(element);
  const renderer = createHeatmapRenderer();
  const point = {
    spm: 'a.b.c.d',
    spmName: 'Card',
    measures: { views: 10000, ratio: 0.125, clicks: 0 },
  };
  renderer.start(
    [
      { id: 'ratio', format: 'percent' },
      { id: 'revenue', format: 'number' },
      { id: 'clicks', format: 'number' },
      { id: 'views', format: 'number' },
    ],
    [point],
  );
  expect(document.querySelector('[data-mtop-heatmap-overlay]')?.textContent).toBe(
    '12.50% / — / 0 / 1.00w',
  );

  renderer.start([{ id: 'views', format: 'number' }], [point]);
  expect(document.querySelector('[data-mtop-heatmap-overlay]')?.textContent).toBe('1.00w');
  expect(document.querySelectorAll('[data-mtop-heatmap-overlay]')).toHaveLength(1);
  renderer.stop();
});
