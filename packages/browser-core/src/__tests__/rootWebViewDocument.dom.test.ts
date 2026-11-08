// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRootWebViewDocumentTransport } from '../rootWebViewDocument.js';

afterEach(() => {
  window.name = '';
  vi.restoreAllMocks();
});

describe('root WebView document transport', () => {
  it('restores the business URL before scripts and relative resources use it', () => {
    const original = location.origin + '/business/path?callback=once#section';
    window.name = '__mearl_root__';
    history.replaceState(null, '', '/.mearl-document/fixture#' + encodeURIComponent(original));
    window.eval(`(${installRootWebViewDocumentTransport.toString()})()`);
    expect(location.href).toBe(original);
    expect(new URL('./asset.js', document.baseURI).href).toBe(
      location.origin + '/business/asset.js',
    );
  });

  it('does not restore a foreign origin or an unrelated frame', () => {
    window.name = '__mearl_root__';
    const alias =
      '/.mearl-document/fixture#' + encodeURIComponent('https://foreign.example/callback');
    history.replaceState(null, '', alias);
    installRootWebViewDocumentTransport();
    expect(location.pathname).toBe('/.mearl-document/fixture');
    window.name = 'advertisement';
    history.replaceState(
      null,
      '',
      '/.mearl-document/fixture#' + encodeURIComponent('http://localhost/business'),
    );
    installRootWebViewDocumentTransport();
    expect(location.pathname).toBe('/.mearl-document/fixture');
  });

  it('uses only the current navigation token and preserves the full business URL', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { serverTiming: [{ name: 'mearl-document', description: 'fixture-token' }] },
    ] as unknown as PerformanceEntryList);
    installRootWebViewDocumentTransport();
    const resolve = (window as Window & { __mearlRootDocumentUrl__: (url: string) => string })
      .__mearlRootDocumentUrl__;
    const url = 'https://business.example/callback?ticket=once#section';
    const alias = new URL(resolve(url));
    expect(alias.origin).toBe('https://business.example');
    expect(alias.pathname).toBe('/.mearl-document/fixture-token');
    expect(decodeURIComponent(alias.hash.slice(1))).toBe(url);
  });

  it.each([false, true])('mirrors the root navigation and respects reduced motion (%s)', reduced => {
    const destination = new URL('/next?value=1#section', location.origin);
    const replaceState = vi.fn();
    const shell = { location: new URL('/first', location.origin), history: { state: {}, replaceState } };
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ id: '' }));
    const frame = {
      hasAttribute: (name: string) => name === 'data-mearl-root-webview',
      getAnimations: () => [{ id: 'mearl-root-webview-enter', cancel }],
      animate,
    };
    const child = {
      name: 'assigned-by-business-page',
      frameElement: frame,
      parent: shell,
      top: shell,
      matchMedia: () => ({ matches: reduced }),
      addEventListener: vi.fn(),
    };
    const install = new Function('window', 'location', `(${installRootWebViewDocumentTransport})()`);
    install(child, destination);
    install(child, destination);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(shell.history.state, '', destination.href);
    expect(cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 1);
    expect(child.addEventListener).toHaveBeenCalledOnce();
  });
});
