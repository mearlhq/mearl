import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_PAGE_URL, openInstallPage } from '../installPage';

describe('installation welcome page', () => {
  const createTab = vi.fn();
  const fetchPage = vi.fn();
  beforeEach(() => {
    createTab.mockReset().mockResolvedValue({ id: 1 });
    vi.stubGlobal('fetch', fetchPage.mockReset());
    chrome.tabs = { create: createTab } as unknown as typeof chrome.tabs;
  });
  afterEach(() => vi.unstubAllGlobals());
  it('opens the public welcome page without depending on network reachability', async () => {
    await openInstallPage('install');
    expect(createTab).toHaveBeenCalledExactlyOnceWith({ url: INSTALL_PAGE_URL });
    expect(INSTALL_PAGE_URL).toBe('https://mearlhq.github.io/mearl/installed.html');
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it.each(['update', 'chrome_update', 'shared_module_update'] as const)(
    'does not reopen on %s',
    async reason => {
      await openInstallPage(reason);
      expect(createTab).not.toHaveBeenCalled();
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );
  it('handles browser shutdown', async () => {
    createTab.mockRejectedValue(new Error('Browser closed'));
    await expect(openInstallPage('install')).resolves.toBeUndefined();
  });

  it.each(['opaque', 'network-error', 'timeout'])(
    'selects the welcome page after a %s probe',
    async result => {
      vi.resetModules();
      vi.stubGlobal('__MEARL_WEBSITE_URL__', 'https://team.example.test/mearl/');
      const { openInstallPage: openCustomPage } = await import('../installPage');
      const reachable = result === 'opaque';
      if (reachable) fetchPage.mockResolvedValue({ type: 'opaque', status: 0, ok: false });
      else
        fetchPage.mockRejectedValue(
          result === 'timeout'
            ? new DOMException('Timed out', 'TimeoutError')
            : new TypeError('Failed to fetch'),
        );

      await openCustomPage('install');

      const welcome = 'https://team.example.test/mearl/installed.html';
      expect(fetchPage).toHaveBeenCalledExactlyOnceWith(
        welcome,
        expect.objectContaining({
          method: 'HEAD',
          mode: 'no-cors',
          redirect: 'follow',
          credentials: 'omit',
          signal: expect.any(AbortSignal),
        }),
      );
      expect(createTab).toHaveBeenCalledExactlyOnceWith({
        url: reachable ? welcome : INSTALL_PAGE_URL,
      });
    },
  );
});
