/** 文档交付协议在 document_start 执行；函数体可独立序列化到浏览器。 */
export function installRootWebViewDocumentTransport(): void {
  const browser = window as Window & {
    __mearlRootDocumentUrl__?: (url: string) => string;
  };
  const prefix = '/.mearl-document/';
  if (browser.name === '__mearl_root__' && location.pathname.startsWith(prefix)) {
    try {
      const original = new URL(decodeURIComponent(location.hash.slice(1)));
      if (original.origin === location.origin && /^https?:$/.test(original.protocol)) {
        history.replaceState(history.state, '', original.href);
      }
    } catch {
      // 无效交付地址保留原路径，不导航到未经校验的地址。
    }
  }
  if (
    !browser.__mearlRootDocumentUrl__ &&
    browser.parent === browser.top &&
    browser.parent !== browser
  ) {
    const frame = browser.frameElement;
    const syncShellUrl = (): boolean => {
      if (location.pathname.startsWith(prefix)) return false;
      try {
        const shell = browser.parent;
        if (shell.location.origin !== location.origin || shell.location.href === location.href)
          return false;
        // The iframe navigation already owns the history entry. Mirror its URL without adding another.
        shell.history.replaceState(shell.history.state, '', location.href);
        return true;
      } catch {
        // The shell may be navigating or have an inaccessible origin.
        return false;
      }
    };
    if (frame?.hasAttribute('data-mearl-root-webview')) {
      const animationId = 'mearl-root-webview-enter';
      frame.getAnimations().find(animation => animation.id === animationId)?.cancel();
      if (syncShellUrl() && !browser.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        frame.animate([{ opacity: 0.75 }, { opacity: 1 }], {
          duration: 160,
          easing: 'ease-out',
        }).id = animationId;
      }
      browser.addEventListener('pageshow', event => {
        if (event.persisted) syncShellUrl();
      });
    }
  }
  browser.__mearlRootDocumentUrl__ = (url: string): string => {
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const token = navigation?.serverTiming?.find(
      entry => entry.name === 'mearl-document',
    )?.description;
    if (!token || !/^[a-zA-Z0-9-]+$/.test(token)) return url;
    const original = new URL(url);
    return `${original.origin}${prefix}${token}#${encodeURIComponent(original.href)}`;
  };
}
