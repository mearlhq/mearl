import { describe, expect, it } from 'vitest';

import {
  createControlledFaviconDataUrl,
  isControlledFaviconDataUrl,
  normalizeControlSource,
  toControlSourceWireValue,
} from '../controlledFavicon';

function decodeSvg(source: 'local' | 'remote'): string {
  const dataUrl = createControlledFaviconDataUrl(source);
  return decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));
}

describe('createControlledFaviconDataUrl', () => {
  it('keeps the Mearl icon and adds a green local badge', () => {
    const svg = decodeSvg('local');

    expect(svg).toContain('data-control-source="local"');
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).not.toContain('transform=');
    expect(svg).toContain('fill="#3273E8"');
    expect(svg).toContain('M36 90V40L64 68L92 40V90');
    expect(svg).toContain('fill="#16A34A"');
    expect(svg).not.toContain('fill="#7C3AED"');
  });

  it('keeps the Mearl icon and adds an orange remote control badge', () => {
    const svg = decodeSvg('remote');

    expect(svg).toContain('data-control-source="remote"');
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).not.toContain('transform=');
    expect(svg).toContain('fill="#3273E8"');
    expect(svg).toContain(
      '<circle cx="104" cy="104" r="21" fill="#FF7A00" stroke="#FFFFFF" stroke-width="6"/>',
    );
    expect(svg).not.toContain('fill="#16A34A"');
  });
});

describe('isControlledFaviconDataUrl', () => {
  it('recognizes only Mearl-generated local and remote icons', () => {
    expect(isControlledFaviconDataUrl(createControlledFaviconDataUrl('local'))).toBe(true);
    expect(isControlledFaviconDataUrl(createControlledFaviconDataUrl('remote'))).toBe(true);
    expect(
      isControlledFaviconDataUrl('data:image/svg+xml,<svg data-control-source="local"/>'),
    ).toBe(false);
    expect(isControlledFaviconDataUrl('chrome-extension://example/icon.png')).toBe(false);
  });
});

describe('control source compatibility', () => {
  it('normalizes the stable cloud wire value to remote control', () => {
    expect(normalizeControlSource('local')).toBe('local');
    expect(normalizeControlSource('remote')).toBe('remote');
    expect(normalizeControlSource('cloud')).toBe('remote');
    expect(normalizeControlSource(undefined)).toBe('local');
  });

  it('preserves the stable wire value for mixed package versions', () => {
    expect(toControlSourceWireValue('local')).toBe('local');
    expect(toControlSourceWireValue('remote')).toBe('cloud');
  });
});
