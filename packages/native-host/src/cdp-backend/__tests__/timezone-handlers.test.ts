import { describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../cdp-session.js';
import { cdpSetTimezone } from '../timezone-handlers.js';

function createSession(sendCommand = vi.fn().mockResolvedValue(undefined)): PageSession {
  return { client: { sendCommand } } as unknown as PageSession;
}

describe('cdpSetTimezone', () => {
  it('applies a trimmed IANA timezone', async () => {
    const sendCommand = vi.fn().mockResolvedValue(undefined);

    await expect(
      cdpSetTimezone(createSession(sendCommand), { timezone: ' Asia/Shanghai ' }),
    ).resolves.toEqual({ enabled: true, timezone: 'Asia/Shanghai' });
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setTimezoneOverride', {
      timezoneId: 'Asia/Shanghai',
    });
  });

  it('clears the override with an empty timezone', async () => {
    const sendCommand = vi.fn().mockResolvedValue(undefined);

    await expect(cdpSetTimezone(createSession(sendCommand), { timezone: '' })).resolves.toEqual({
      enabled: false,
      timezone: null,
    });
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setTimezoneOverride', { timezoneId: '' });
  });

  it('rejects a missing timezone', async () => {
    await expect(cdpSetTimezone(createSession(), {})).rejects.toThrow(
      'set_timezone: "timezone" is required',
    );
  });
});
