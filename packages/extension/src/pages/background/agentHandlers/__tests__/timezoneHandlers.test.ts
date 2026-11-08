import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enableTimezoneForTab, disableTimezoneForTab } = vi.hoisted(() => ({
  enableTimezoneForTab: vi.fn(),
  disableTimezoneForTab: vi.fn(),
}));

vi.mock('../../debuggerManager', () => ({
  enableTimezoneForTab,
  disableTimezoneForTab,
}));

describe('handleSetTimezone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies a trimmed IANA timezone to the requested tab', async () => {
    const { handleSetTimezone } = await import('../timezoneHandlers');

    await expect(
      handleSetTimezone({ tabId: 42, timezone: ' America/New_York ' }, () => null),
    ).resolves.toEqual({ enabled: true, timezone: 'America/New_York' });
    expect(enableTimezoneForTab).toHaveBeenCalledWith(42, 'America/New_York');
  });

  it('clears an empty timezone on the requested tab', async () => {
    const { handleSetTimezone } = await import('../timezoneHandlers');

    await expect(handleSetTimezone({ tabId: 43, timezone: ' ' }, () => null)).resolves.toEqual({
      enabled: false,
      timezone: null,
    });
    expect(disableTimezoneForTab).toHaveBeenCalledWith(43);
  });

  it('rejects a missing timezone', async () => {
    const { handleSetTimezone } = await import('../timezoneHandlers');

    await expect(
      handleSetTimezone({ tabId: 42, timezone: undefined as unknown as string }, () => null),
    ).rejects.toThrow('set_timezone: "timezone" is required');
  });
});
