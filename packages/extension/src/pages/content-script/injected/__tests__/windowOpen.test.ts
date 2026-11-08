import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookWindowOpen } from '../windowOpen';

describe('Agent collection window.open hook', () => {
  const browserWindowOpen = window.open;

  afterEach(() => {
    window.open = browserWindowOpen;
    delete window.__MEARL_AGENT_CHAT_ALLOW_NEW_TABS__;
  });

  it('preserves native new-tab behavior for related Agent Chat tabs', () => {
    const originalOpen = vi.fn(() => null);
    window.open = originalOpen;
    hookWindowOpen();
    window.__MEARL_AGENT_CHAT_ALLOW_NEW_TABS__ = true;

    window.open('https://example.test/child', '_blank');

    expect(originalOpen).toHaveBeenCalledWith('https://example.test/child', '_blank', undefined);
  });
});
