import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestBrowserManager, requestBrowserSessions } from '../browserManager';

vi.mock('../../pages/panel/utils/i18n', () => ({ t: (key: string) => key }));

describe('browser management requests', () => {
  beforeEach(() => {
    vi.mocked(chrome.runtime.sendMessage).mockReset();
  });

  it('keeps instance detach, session release and browser close distinct', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true, data: {} });
    await requestBrowserManager('detach', { browser: 'example-device:instance-one' });
    await requestBrowserSessions({ operation: 'release', sessionId: 'session-one' });
    await requestBrowserManager('close', { browser: 'example-device:instance-one' });
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.map(([message]) => message)).toEqual([
      { action: 'browser_instances', data: { operation: 'detach', browser: 'example-device:instance-one' } },
      { action: 'browser_sessions', data: { operation: 'release', sessionId: 'session-one' } },
      { action: 'browser_close', data: { browser: 'example-device:instance-one' } },
    ]);
  });

  it('sends provider configuration through its resource and preserves business errors', async () => {
    const result = { error: 'Provider requires configuration', fields: [] };
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true, data: result });
    await expect(
      requestBrowserManager('launchForm', {
        provider: 'example-device',
        variant: 'desktop',
        values: { region: 'cn' },
      }),
    ).resolves.toEqual(result);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
      action: 'browser_providers',
      data: {
        operation: 'launch_form',
        provider: 'example-device',
        variant: 'desktop',
        values: { region: 'cn' },
      },
    });
  });

  it('returns a session list with the operation-specific response type', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: true,
      data: { sessions: [] },
    });
    const result = await requestBrowserSessions({ operation: 'list' });
    expect(result.sessions).toEqual([]);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
      action: 'browser_sessions',
      data: { operation: 'list' },
    });
  });

  it('does not retry a failed mutation', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      success: false,
      error: 'Browser is busy',
    });
    await expect(requestBrowserManager('start', { browser: 'example-device:instance-one' })).rejects.toThrow(
      'Browser is busy',
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});
