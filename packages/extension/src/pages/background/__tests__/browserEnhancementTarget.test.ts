import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnhancementTabUrl } from '../browserEnhancementTarget';
const getTargets = vi.fn<() => Promise<chrome.debugger.TargetInfo[]>>();

describe('enhancement target URL metadata', () => {
  beforeEach(() => { getTargets.mockReset(); vi.stubGlobal('chrome', { tabs: { get: vi.fn() }, debugger: { getTargets } }); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('uses the actual tab URL when available', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, url: 'https://example.test/' } as chrome.tabs.Tab);
    expect(await getEnhancementTabUrl(7)).toBe('https://example.test/');
    expect(chrome.debugger.getTargets).not.toHaveBeenCalled();
  });
  it('recovers a URL-less Ego tab from its unique physical page metadata', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7 } as chrome.tabs.Tab);
    getTargets.mockResolvedValue([
      { id: 'unrelated', type: 'page', tabId: 8, url: 'https://other.test/', title: '', attached: false },
      { id: 'physical', type: 'page', tabId: 7, url: 'chrome://newtab/', title: '', attached: false },
    ]);
    expect(await getEnhancementTabUrl(7)).toBe('chrome://newtab/');
  });
  it('does not use stale metadata after the tab lookup fails', async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error('tab closed'));
    await expect(getEnhancementTabUrl(7)).rejects.toThrow('tab closed');
    expect(chrome.debugger.getTargets).not.toHaveBeenCalled();
  });
  it.each([[], [{ id: 'other', type: 'page', tabId: 8, url: 'https://other.test/', title: '', attached: false }],
    [{ id: 'a', type: 'page', tabId: 7, url: 'chrome://newtab/', title: '', attached: false }, { id: 'b', type: 'page', tabId: 7, url: 'chrome://newtab/', title: '', attached: false }]].map(targets => ({ targets })))('refuses missing or ambiguous page metadata: %j', async ({ targets }) => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7 } as chrome.tabs.Tab);
    getTargets.mockResolvedValue(targets);
    await expect(getEnhancementTabUrl(7)).rejects.toThrow('URL is unavailable');
  });
});
