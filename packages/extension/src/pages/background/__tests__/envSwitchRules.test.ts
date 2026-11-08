import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectedBrowserControl } from '@mearl/preset/bundles';
import { networkControlFixture } from '../../../test/fixtures/networkControl';
vi.mock('../browserCapabilities', () => ({
  authorizeBrowserCapabilityUrl: async (value: string) => new URL(value),
}));

const selected = vi.hoisted(() => ({
  gateways: {} as Record<string, { prod: string; pre: string }>,
  control: undefined as SelectedBrowserControl | undefined,
}));
vi.mock('../browserCapabilityRegistry', () => ({
  browserCapabilityRegistry: () => ({
    settings: async () => ({
      extension: { mtopGateways: selected.gateways },
      browserControl: selected.control,
    }),
  }),
}));

describe('installed per-tab network control', () => {
  let stored: Record<string, unknown>;
  let sessionRules: Map<number, chrome.declarativeNetRequest.Rule>;
  let env: typeof import('../envSwitchRules');

  beforeEach(async () => {
    vi.resetModules();
    stored = {};
    selected.gateways = { sample: { prod: 'h5api.m.shop.com', pre: 'h5api.wapa.shop.com' } };
    selected.control = undefined;
    sessionRules = new Map();
    chrome.i18n = {
      getMessage: vi.fn(key => String(key)),
      getUILanguage: () => 'en',
    } as unknown as typeof chrome.i18n;
    chrome.storage.session = {
      get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(stored, values);
      }),
      remove: vi.fn(async (key: string) => {
        delete stored[key];
      }),
    } as unknown as typeof chrome.storage.session;
    chrome.storage.sync = {
      get: vi.fn(async () => ({ envSwitchEnabled: true, envSwitchTarget: 'prod' })),
      remove: vi.fn(async () => {}),
    } as unknown as typeof chrome.storage.sync;
    chrome.tabs = {
      get: vi.fn(async (id: number) => ({ id, url: 'https://page.example.com/path' })),
    } as unknown as typeof chrome.tabs;
    chrome.declarativeNetRequest = {
      getDynamicRules: vi.fn(async () => [{ id: 999900 }, { id: 123 }]),
      updateDynamicRules: vi.fn(async () => {}),
      getSessionRules: vi.fn(async () => [...sessionRules.values()]),
      updateSessionRules: vi.fn(
        async (update: {
          removeRuleIds?: number[];
          addRules?: chrome.declarativeNetRequest.Rule[];
        }) => {
          for (const id of update.removeRuleIds ?? []) sessionRules.delete(id);
          for (const rule of update.addRules ?? []) sessionRules.set(rule.id, rule);
        },
      ),
    } as unknown as typeof chrome.declarativeNetRequest;
    env = await import('../envSwitchRules');
  });

  const rulesFor = (rules: Map<number, chrome.declarativeNetRequest.Rule>, tabId: number) =>
    [...rules.values()].filter(rule => rule.condition.tabIds?.includes(tabId));

  it('applies only an installed control and isolates its per-tab routes', async () => {
    selected.control = networkControlFixture({ mtopGateways: selected.gateways });
    await env.setInstalledNetworkControl(1, { id: 'environment', value: 'pre' });
    expect(rulesFor(sessionRules, 1).length).toBeGreaterThan(0);
    expect(rulesFor(sessionRules, 2)).toHaveLength(0);
    await expect(env.setInstalledNetworkControl(1, { id: 'other', value: 'pre' })).rejects.toThrow(
      'Unknown installed',
    );
  });
  it('retains accepted routes across an uninstall and can explicitly clear them', async () => {
    selected.control = networkControlFixture({ mtopGateways: selected.gateways });
    await env.setInstalledNetworkControl(1, { id: 'environment', value: 'pre' });
    const previous = structuredClone([...sessionRules.values()]);
    selected.control = undefined;
    await expect(
      env.setInstalledNetworkControl(1, { id: 'environment', value: 'prod' }),
    ).rejects.toThrow('Unknown installed');
    expect([...sessionRules.values()]).toEqual(previous);
    await env.setInstalledNetworkControl(1, null);
    expect(rulesFor(sessionRules, 1)).toHaveLength(0);
  });
});
