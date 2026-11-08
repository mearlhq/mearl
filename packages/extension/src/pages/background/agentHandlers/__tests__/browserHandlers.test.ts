import { beforeEach, describe, expect, it, vi } from 'vitest';

const screenshotMocks = vi.hoisted(() => ({
  captureScreenshotViaCDP: vi.fn(),
}));

vi.mock('../screenshotUtils', () => ({
  captureScreenshotViaCDP: screenshotMocks.captureScreenshotViaCDP,
  captureNodeScreenshotViaCDP: vi.fn(),
  dataUrlToBase64: (value: string) => value.replace(/^data:image\/[^;]+;base64,/, ''),
}));

import { handlePageScreenshot, handleSetRule } from '../browserHandlers';
import { DEV_RULES_STORAGE_KEY } from '../../../../shared/devRulesUtils';

describe('handleSetRule', () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    chrome.permissions = {
      contains: vi.fn(async () => true),
      request: vi.fn(),
    } as unknown as typeof chrome.permissions;
    chrome.storage.local = {
      get: vi.fn(async () => stored),
      set: vi.fn(async values => {
        Object.assign(stored, values);
      }),
    } as unknown as typeof chrome.storage.local;
    chrome.declarativeNetRequest = {
      updateDynamicRules: vi.fn(async () => undefined),
    } as unknown as typeof chrome.declarativeNetRequest;
  });

  it('reports success only after the dynamic rule is installed and stored', async () => {
    await expect(
      handleSetRule({
        actionType: 'modifyHeaders',
        filter: '^https://example\\.com/api(?:[/?]|$)',
        requestHeaders: [
          { header: 'Agent-Proof-Token-Audience', operation: 'set', value: 'service' },
        ],
      }),
    ).resolves.toMatchObject({ success: true, ruleId: 1 });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      addRules: [
        expect.objectContaining({
          id: 1,
          action: expect.objectContaining({
            requestHeaders: [
              { header: 'Agent-Proof-Token-Audience', operation: 'set', value: 'service' },
            ],
          }),
        }),
      ],
    });
    expect(stored[DEV_RULES_STORAGE_KEY]).toHaveLength(1);
  });

  it('does not store a rule when Chrome rejects it', async () => {
    vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mockRejectedValueOnce(
      new Error('invalid rule'),
    );
    await expect(handleSetRule({ actionType: 'block', filter: 'invalid(' })).rejects.toThrow(
      'invalid rule',
    );
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('saves rules with actionable missing-host warnings without opening a permission prompt', async () => {
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    const result = await handleSetRule({
      actionType: 'modifyHeaders',
      filter: '^https://example\\.com/',
      responseHeaders: [{ header: 'x-test', operation: 'set', value: '1' }],
    });
    expect(result).toMatchObject({ success: true, missingOrigins: ['https://example.com/*'] });
    expect(result.warnings?.[0]).toContain(
      `mearl request_permission --payload '{"domain":"example.com"}'`,
    );
    expect(stored[DEV_RULES_STORAGE_KEY]).toHaveLength(1);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('warns when a broad pattern prevents a complete host permission check', async () => {
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    const result = await handleSetRule({
      actionType: 'redirect',
      filter: '.*',
      redirectUrl: 'https://target.invalid/',
    });
    expect(result.warnings?.[0]).toContain('no finite domain scope');
    expect(result.missingOrigins).toBeUndefined();
  });

  it('removes the dynamic rule if saving it fails', async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      handleSetRule({ actionType: 'block', filter: '^https://example\\.com/' }),
    ).rejects.toThrow('storage unavailable');
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenLastCalledWith({
      removeRuleIds: [1],
    });
  });

  it('deletes a rule from dynamic rules and storage, including an idempotent retry', async () => {
    await handleSetRule({ actionType: 'block', filter: '^https://example\\.com/' });
    await expect(handleSetRule({ ruleId: 1, enabled: false })).resolves.toMatchObject({
      success: true,
      affectedCount: 1,
    });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenLastCalledWith({
      removeRuleIds: [1],
    });
    expect(stored[DEV_RULES_STORAGE_KEY]).toEqual([]);
    await expect(handleSetRule({ ruleId: 1, enabled: false })).resolves.toMatchObject({
      affectedCount: 0,
    });
  });

  it('deletes a disabled rule from storage and clears any stale dynamic rule', async () => {
    await handleSetRule({ actionType: 'block', filter: '^https://example\\.com/' });
    const rules = stored[DEV_RULES_STORAGE_KEY] as Array<{ enabled: boolean }>;
    rules[0].enabled = false;
    vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mockClear();

    await expect(handleSetRule({ ruleId: 1, enabled: false })).resolves.toMatchObject({
      affectedCount: 1,
    });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [1],
    });
    expect(stored[DEV_RULES_STORAGE_KEY]).toEqual([]);
  });

  it('restores a dynamic rule if storing its deletion fails', async () => {
    await handleSetRule({ actionType: 'block', filter: '^https://example\\.com/' });
    delete (stored[DEV_RULES_STORAGE_KEY] as Array<{ enabled?: boolean }>)[0].enabled;
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(handleSetRule({ ruleId: 1, enabled: false })).rejects.toThrow(
      'storage unavailable',
    );
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenLastCalledWith({
      addRules: [expect.objectContaining({ id: 1 })],
    });
    expect(stored[DEV_RULES_STORAGE_KEY]).toHaveLength(1);
  });
});

describe('handlePageScreenshot', () => {
  beforeEach(() => {
    chrome.tabs = {
      get: vi.fn(async () => ({
        id: 7,
        width: 1020,
        height: 763,
        url: 'https://example.com/mobile',
        title: 'Mobile page',
      })),
    } as any;
    screenshotMocks.captureScreenshotViaCDP.mockResolvedValue({
      dataUrl: 'data:image/png;base64,AQID',
      width: 1179,
      height: 2556,
    });
  });

  it('reports captured pixels instead of the desktop tab bounds', async () => {
    const result = await handlePageScreenshot({ tabId: 7 }, () => null);

    expect(result.meta).toMatchObject({
      width: 1179,
      height: 2556,
      url: 'https://example.com/mobile',
      title: 'Mobile page',
    });
    expect(screenshotMocks.captureScreenshotViaCDP).toHaveBeenCalledWith(7, 'png', 80);
  });

  it.each(['chrome://settings/', 'chrome-extension://test/options.html', 'devtools://devtools/'])(
    'attempts screenshots of %s',
    async url => {
      vi.mocked(chrome.tabs.get).mockResolvedValueOnce({ id: 7, url } as chrome.tabs.Tab);
      await expect(handlePageScreenshot({ tabId: 7 }, () => null)).resolves.toMatchObject({
        meta: { url },
      });
    },
  );

  it('reports the browser rejection after attempting capture', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 7,
      url: 'chrome://settings/',
    } as chrome.tabs.Tab);
    screenshotMocks.captureScreenshotViaCDP.mockRejectedValueOnce(
      new Error('Cannot access this target'),
    );
    await expect(handlePageScreenshot({ tabId: 7 }, () => null)).rejects.toThrow(
      'Failed to capture screenshot: Cannot access this target',
    );
  });
});
