import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDnrRule, setupTempHeaderInjection } from '../dnr';

describe('temporary DNR cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes a leftover rule before the next request after cleanup fails', async () => {
    const getDynamicRules = vi.fn().mockResolvedValue([]);
    const getSessionRules = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 900000 }]);
    const updateSessionRules = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DNR unavailable'))
      .mockResolvedValue(undefined);
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

    const firstId = await setupTempHeaderInjection(url, []);
    await cleanupTempDnrRule(firstId);
    await setupTempHeaderInjection(url, []);

    expect(getSessionRules).toHaveBeenCalledTimes(2);
    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [firstId] });
  });
});
