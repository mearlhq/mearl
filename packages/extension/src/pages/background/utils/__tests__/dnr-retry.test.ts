import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupTempHeaderInjection } from '../dnr';

describe('temporary DNR initialization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries the stale-rule scan if it initially fails', async () => {
    const getDynamicRules = vi
      .fn()
      .mockRejectedValueOnce(new Error('DNR unavailable'))
      .mockResolvedValue([]);
    const getSessionRules = vi.fn().mockResolvedValue([]);
    const updateSessionRules = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension-id' },
      declarativeNetRequest: {
        getDynamicRules,
        getSessionRules,
        updateSessionRules,
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
      },
    });
    const url = new URL('https://api.example.test/system/userinfo');

    await expect(setupTempHeaderInjection(url, [])).rejects.toThrow('DNR unavailable');
    await expect(setupTempHeaderInjection(url, [])).resolves.toBe(900000);
    expect(getDynamicRules).toHaveBeenCalledTimes(2);
  });
});
