import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDnrDisplayData, cleanupDnrTab, resetDnrTabOnNavigation, recordDnrMatch } from '../dnrTracker';
import { networkControlStorageKey } from '../../../shared/browserControl';
import { tabPageOverridesStorageKey } from '../../../shared/tabPageOverrides';

describe('DNR indicator data', () => {
  let sessionValues: Record<string, unknown>;

  beforeEach(() => {
    sessionValues = {};
    cleanupDnrTab(3001);
    cleanupDnrTab(3002);

    chrome.declarativeNetRequest = {
      getDynamicRules: vi.fn(async () => []),
      getSessionRules: vi.fn(async () => []),
    } as unknown as typeof chrome.declarativeNetRequest;
    chrome.storage.local = {
      get: vi.fn(async () => ({})),
    } as unknown as typeof chrome.storage.local;
    chrome.storage.session = {
      get: vi.fn(async () => sessionValues),
    } as unknown as typeof chrome.storage.session;
    chrome.i18n = {
      getMessage: vi.fn((key: string, substitution?: string | string[]) =>
        substitution ? `${key}:${String(substitution)}` : key,
      ),
    } as unknown as typeof chrome.i18n;
  });

  it('keeps the per-tab UA override visible when navigation clears DNR match counters', async () => {
    sessionValues = {
      [tabPageOverridesStorageKey(3001)]: {
        customUserAgentEnabled: true,
        customUserAgent: 'Custom UA',
      },
    };

    await expect(buildDnrDisplayData(3001)).resolves.toEqual([
      {
        label: 'dnrLabelUaOverride',
        canDisable: true,
        disableTarget: 'userAgent',
      },
    ]);

    resetDnrTabOnNavigation(3001);
    await expect(buildDnrDisplayData(3001)).resolves.toEqual([
      {
        label: 'dnrLabelUaOverride',
        canDisable: true,
        disableTarget: 'userAgent',
      },
    ]);
  });

  it('shows timezone and page-time overrides only on the tab that owns them', async () => {
    sessionValues = {
      [tabPageOverridesStorageKey(3001)]: {
        customTimezone: 'Asia/Singapore',
        customTime: 1_787_272_260_000,
      },
    };

    await expect(buildDnrDisplayData(3001)).resolves.toEqual([
      {
        label: 'dnrLabelTimezoneOverride:Asia/Singapore',
        canDisable: true,
        disableTarget: 'timezone',
      },
      {
        label: 'dnrLabelTimeOverride',
        canDisable: true,
        disableTarget: 'pageTime',
      },
    ]);
    await expect(buildDnrDisplayData(3002)).resolves.toEqual([]);
  });

  it('uses the accepted capability label for arbitrary network destinations', async () => {
    sessionValues[networkControlStorageKey(3001)] = { label: { en: 'Request target → QA' } };
    vi.mocked(chrome.declarativeNetRequest.getSessionRules).mockResolvedValue([{ id: 999901, action: { type: 'modifyHeaders' }, condition: { regexFilter: 'qa.example.test' } }] as chrome.declarativeNetRequest.Rule[]);
    recordDnrMatch(3001, 999901);
    await expect(buildDnrDisplayData(3001)).resolves.toEqual([{ label: 'Request target → QA', count: 1, ruleId: 999901, canDisable: false }]);
    vi.mocked(chrome.declarativeNetRequest.getSessionRules).mockResolvedValue([]);
    await expect(buildDnrDisplayData(3001)).resolves.toEqual([]);
  });
});
