import { describe, expect, it } from 'vitest';
import { parseToolboxIcon } from '../toolboxIcon';

describe('toolbox icon sources', () => {
  it('preserves icon names and bounds their length', () => {
    expect(parseToolboxIcon(' git-branch ')).toEqual({ kind: 'name', name: 'git-branch' });
    expect(parseToolboxIcon('unknown-icon')).toEqual({ kind: 'name', name: 'unknown-icon' });
    expect(parseToolboxIcon('x'.repeat(41))).toBeUndefined();
  });
  it('encodes SVG markup as an isolated image, including self-closing roots', () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#2563eb" d="M0 0h4v4"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ]) {
      expect(parseToolboxIcon(svg)).toEqual({
        kind: 'image',
        src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      });
    }
  });
  it('supplies the SVG namespace for markup copied from HTML', () => {
    expect(parseToolboxIcon('<svg viewBox="0 0 24 24"/>')).toEqual({
      kind: 'image',
      src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>')}`,
    });
  });
  it('marks currentColor SVG markup for theme-aware monochrome rendering', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><path d="M1 1h5"/></svg>';
    expect(parseToolboxIcon(svg)).toEqual({
      kind: 'image',
      src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      monochrome: true,
    });
  });
  it.each([
    'https://example.com/icon.svg?q=1',
    'http://example.com/icon.png',
    'data:image/svg+xml,%3Csvg%2F%3E',
    'data:image/svg+xml;utf8,%3Csvg%2F%3E',
    'data:image/png;base64,aGVsbG8=',
  ])('accepts an image source: %s', src => {
    expect(parseToolboxIcon(src)).toEqual({ kind: 'image', src });
  });
  it.each([
    undefined,
    null,
    5,
    '',
    'javascript:alert(1)',
    '//example.com/image.png',
    'file:///tmp/icon.svg',
    'https://user:secret@example.com/icon.png',
    'data:text/html,<svg/>',
    'data:image/svg+xml,',
    '<div>icon</div>',
    `<svg>${' '.repeat(32 * 1024)}</svg>`,
    '<svg>\uD800</svg>',
  ])('rejects invalid or unsupported sources', value => {
    expect(parseToolboxIcon(value)).toBeUndefined();
  });
});
