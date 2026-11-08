/**
 * Navigation hooks for Agent collection mode.
 *
 * When the tab is in Agent collection mode (detected via Server-Timing header),
 * intercepts navigations that would open a new tab/window and converts them
 * into same-tab navigations (location.href = url). This ensures the existing
 * CDP debugger session captures all requests without timing issues.
 *
 * Covers two vectors:
 * 1. window.open(url) calls
 * 2. <a target="_blank"> link clicks
 */

const NON_NAVIGABLE_URL_PATTERN = /^(javascript:|data:|blob:)/i;

/**
 * Hook window.open and <a target="_blank"> to keep navigations in the current tab.
 */
export function hookWindowOpen(): void {
  // ─── window.open hook ───────────────────────────────────────────────────
  const originalWindowOpen = window.open;

  window.open = function (
    url?: string | URL,
    _target?: string,
    _features?: string,
  ): WindowProxy | null {
    if (window.__MEARL_AGENT_CHAT_ALLOW_NEW_TABS__) {
      return originalWindowOpen.call(this, url as string, _target, _features);
    }
    const targetUrl = url ? String(url) : '';

    // Only intercept navigable URLs; let javascript:, data:, blob: pass through
    if (targetUrl && !NON_NAVIGABLE_URL_PATTERN.test(targetUrl)) {
      let absoluteUrl = targetUrl;
      try {
        absoluteUrl = new URL(targetUrl, window.location.href).href;
      } catch {
        // If URL parsing fails, use as-is
      }

      window.location.href = absoluteUrl;
      return window;
    }

    return originalWindowOpen.call(this, url as string, _target, _features);
  };

  // ─── <a target="_blank"> click interceptor ──────────────────────────────
  // Capture-phase listener runs before page JS handlers, ensuring we catch
  // the click before it can be stopped or the default action fires.
  document.addEventListener(
    'click',
    (event: MouseEvent) => {
      if (window.__MEARL_AGENT_CHAT_ALLOW_NEW_TABS__) return;
      // Ignore modified clicks (Ctrl/Cmd+click = user intentionally opening new tab)
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;

      const target = anchor.getAttribute('target');
      if (target !== '_blank' && target !== '_new') return;

      const href = anchor.href;
      if (!href || NON_NAVIGABLE_URL_PATTERN.test(href)) return;

      event.preventDefault();
      event.stopPropagation();
      window.location.href = href;
    },
    true, // capture phase
  );
}
