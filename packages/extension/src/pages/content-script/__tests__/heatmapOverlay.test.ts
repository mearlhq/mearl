import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ hooks: undefined as any }));
vi.mock('../spmOverlayLifecycle', () => ({ createSpmOverlayLifecycle: (hooks: any) => { mocks.hooks = hooks; return { start() { hooks.onTick(new Set(document.querySelectorAll('[data-spm-abcd]'))); }, stop: vi.fn() }; } }));
import { createHeatmapRenderer } from '../heatmapOverlay';
afterEach(() => { document.body.innerHTML = ''; });
it('renders the supplied number or percentage format and clears owned overlays', () => {
  const element = document.createElement('div'); element.setAttribute('data-spm-abcd', 'a.b.c.d');
  element.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, toJSON() {} });
  document.body.append(element);
  const renderer = createHeatmapRenderer();
  renderer.start('ratio', [{ spm: 'a.b.c.d', spmName: 'Card', measures: { ratio: 0.125 } }], 'percent');
  expect(document.querySelector('[data-mtop-heatmap-overlay]')?.textContent).toBe('12.50%');
  renderer.start('arbitrary-count', [{ spm: 'a.b.c.d', spmName: 'Card', measures: { 'arbitrary-count': 10000 } }]);
  expect(document.querySelector('[data-mtop-heatmap-overlay]')?.textContent).toBe('1.00w');
  expect(document.querySelectorAll('[data-mtop-heatmap-overlay]')).toHaveLength(1);
  renderer.stop(); expect(document.querySelector('[data-mtop-heatmap-overlay]')).toBeNull();
});
