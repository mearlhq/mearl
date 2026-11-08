import popupHtml from '../index.html?raw';
import popupEntry from '../index.tsx?raw';
import { describe, expect, it } from 'vitest';

describe('popup bootstrap document', () => {
  it('reserves the popup viewport before React mounts', () => {
    const document = new DOMParser().parseFromString(popupHtml, 'text/html');
    const viewportStyle = document.querySelector<HTMLStyleElement>('style[data-popup-viewport]');

    expect(viewportStyle?.textContent).toContain('min-width: 680px');
    expect(viewportStyle?.textContent).toContain('min-height: 560px');
    expect(document.querySelector('[data-popup-bootstrap]')).not.toBeNull();
  });

  it('starts the application with the initial document instead of a second load phase', () => {
    expect(popupEntry).toContain("import { mountPopup } from './bootstrap'");
    expect(popupEntry).not.toContain("window.addEventListener('load'");
    expect(popupEntry).not.toContain("import('./bootstrap')");
  });
});
