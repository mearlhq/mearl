import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('toolbox UI runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    chrome.runtime.getURL = vi.fn(path => `chrome-extension://mearl/${path}`);
  });

  it('injects the extension-owned Preact runtime immediately before the page bridge', async () => {
    const fetchRuntime = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'globalThis.runtimeLoaded = true; /* </script> */',
    });
    vi.stubGlobal('fetch', fetchRuntime);
    const { prepareToolboxPageHtml } = await import('../toolboxUiRuntime');
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><script data-mearl-bridge>bridge()</script></head></html>';

    const prepared = await prepareToolboxPageHtml(html, 'preact');

    expect(fetchRuntime).toHaveBeenCalledWith(
      'chrome-extension://mearl/plugin/toolbox-preact-runtime.js',
    );
    expect(prepared).toContain('<script data-mearl-runtime="preact">');
    expect(prepared).toContain('<\\/script>');
    expect(prepared.indexOf('data-mearl-runtime')).toBeLessThan(
      prepared.indexOf('data-mearl-bridge'),
    );
  });

  it('preserves plain pages and rejects unsupported runtimes', async () => {
    const fetchRuntime = vi.fn();
    vi.stubGlobal('fetch', fetchRuntime);
    const { prepareToolboxPageHtml } = await import('../toolboxUiRuntime');
    const html = '<!doctype html><html><head></head></html>';

    await expect(prepareToolboxPageHtml(html, undefined)).resolves.toBe(html);
    await expect(prepareToolboxPageHtml(html, 'vue')).rejects.toThrow(
      'Unsupported toolbox page runtime: vue',
    );
    expect(fetchRuntime).not.toHaveBeenCalled();
  });

  it('starts runtime loading early and reuses the in-flight fetch during preparation', async () => {
    let resolveRuntime!: (value: { ok: boolean; text: () => Promise<string> }) => void;
    const fetchRuntime = vi.fn(
      () =>
        new Promise(resolve => {
          resolveRuntime = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchRuntime);
    const { preloadToolboxUiRuntime, prepareToolboxPageHtml } = await import('../toolboxUiRuntime');
    preloadToolboxUiRuntime();
    expect(fetchRuntime).toHaveBeenCalledOnce();
    const prepared = prepareToolboxPageHtml(
      '<head><script data-mearl-bridge></script></head>',
      'preact',
    );
    resolveRuntime({ ok: true, text: async () => 'runtime()' });
    await expect(prepared).resolves.toContain('runtime()');
    expect(fetchRuntime).toHaveBeenCalledOnce();
  });
});
