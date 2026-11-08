import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_PAGE_URL, openInstallPage } from '../installPage';

describe('installation welcome page', () => {
  const createTab = vi.fn();
  const fetchPage = vi.fn();
  let stored: Record<string, unknown>;
  beforeEach(() => {
    stored = {};
    createTab.mockReset().mockResolvedValue({ id: 1 });
    vi.stubGlobal('fetch', fetchPage.mockReset());
    chrome.tabs = { create: createTab } as unknown as typeof chrome.tabs;
    chrome.storage = { local: {
      get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
      set: vi.fn(async value => { Object.assign(stored, value); }),
      remove: vi.fn(async (key: string) => { delete stored[key]; }),
    } } as unknown as typeof chrome.storage;
  });
  afterEach(() => vi.unstubAllGlobals());
  it('opens the public welcome page without depending on network reachability', async () => {
    await openInstallPage('install');
    expect(createTab).toHaveBeenCalledExactlyOnceWith({ url: INSTALL_PAGE_URL });
    expect(INSTALL_PAGE_URL).toBe('https://mearlhq.github.io/mearl/installed.html');
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it.each(['update', 'chrome_update', 'shared_module_update'] as const)('does not reopen on %s', async reason => {
    await openInstallPage(reason);
    expect(createTab).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it('handles browser shutdown', async () => {
    createTab.mockRejectedValue(new Error('Browser closed'));
    await expect(openInstallPage('install')).resolves.toBeUndefined();
  });
});
