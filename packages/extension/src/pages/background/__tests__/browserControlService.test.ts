import { beforeEach, expect, it, vi } from 'vitest';
import type { SelectedBrowserControl } from '@mearl/preset/bundles';
import { decodeNetworkRoutePlan } from '@mearl/preset/bundles';
import { handleBrowserControl } from '../browserControlService';
import { addNetworkControlOrigin } from '../networkControlRules';
import { networkControlStorageKey } from '../../../shared/browserControl';
const fixture = vi.hoisted(() => ({ current: undefined as SelectedBrowserControl | undefined, authorize: vi.fn() }));
vi.mock('../envSwitchRules', () => ({ selectedNetworkControl: async () => fixture.current, migrateLegacyProtocolSelection: async () => {}, getProtocolEnvironmentForTab: async () => 'default' }));
vi.mock('../browserCapabilities', () => ({ authorizeBrowserCapabilityUrl: fixture.authorize }));
const sender = { id: 'owned', url: 'chrome-extension://owned/popup.html' };
let storage: Record<string, any>;
let rules: Map<number, chrome.declarativeNetRequest.Rule>;
const selected = (): SelectedBrowserControl => ({ bundleId: 'example', revision: 'one', definition: { schemaVersion: 1, id: 'target', kind: 'segmented', label: { en: 'Target' }, description: { en: 'Reload' }, defaultValue: 'off', messages: { changed: { en: 'Reload' }, failed: { en: 'Failed' } }, options: [{ value: 'off', label: { en: 'Default' }, networkRoutes: { routes: [] } }, { value: 'qa', label: { en: 'QA' }, networkRoutes: { routes: [{ fromHost: 'api.example.test', toHost: 'qa.example.test' }] } }] } });
const request = (action = 'browserControlSet', value = 'qa') => ({ action, tabId: 1, value, controlId: 'target', bundleId: 'example', revision: fixture.current?.revision });
beforeEach(() => {
  vi.clearAllMocks(); fixture.current = selected(); storage = {}; rules = new Map();
  chrome.runtime.id = 'owned';
  chrome.storage.session = {
    get: vi.fn(async key => ({ [key]: storage[key] })),
    set: vi.fn(async values => { Object.assign(storage, values); }),
    remove: vi.fn(async key => { delete storage[String(key)]; }),
  } as any;
  chrome.tabs = { get: vi.fn(async tabId => ({ id: tabId, url: 'https://page.example.test/' })), reload: vi.fn() } as any;
  chrome.declarativeNetRequest = {
    getSessionRules: vi.fn(async () => structuredClone([...rules.values()])),
    updateSessionRules: vi.fn(async ({ removeRuleIds = [], addRules = [] }) => { for (const id of removeRuleIds) rules.delete(id); for (const rule of addRules) rules.set(rule.id, rule); }),
  } as any;
  fixture.authorize.mockResolvedValue(new URL('https://qa.example.test/'));
});
it('accepts a package-defined QA choice, pins its owner and never reloads the tab', async () => {
  expect(await handleBrowserControl(request(), sender)).toEqual({ success: true, value: 'qa' });
  expect(storage[networkControlStorageKey(1)]).toMatchObject({ controlId: 'target', bundleId: 'example', revision: 'one', value: 'qa' });
  const header = [...rules.values()][0].action.responseHeaders![0].value!;
  expect(decodeNetworkRoutePlan(/desc="([^"]+)"/.exec(header)![1])).toEqual(fixture.current!.definition.options[1].networkRoutes);
  expect(fixture.authorize).toHaveBeenCalledWith('https://qa.example.test/');
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
});
it('rejects untrusted callers and a control that changed since rendering', async () => {
  expect(await handleBrowserControl(request(), { ...sender, url: 'https://page.example.test/' })).toMatchObject({ success: false });
  expect(await handleBrowserControl({ ...request(), revision: 'old' }, sender)).toMatchObject({ success: false, error: 'Browser control selection changed' });
  expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled();
  expect(fixture.authorize).not.toHaveBeenCalled();
});
it('checks target permission and rechecks the selected implementation after authorization', async () => {
  fixture.authorize.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
  expect(await handleBrowserControl(request(), sender)).toMatchObject({ success: false, error: 'PERMISSION_DENIED' });
  fixture.authorize.mockImplementationOnce(async () => { fixture.current = { ...selected(), revision: 'two' }; return new URL('https://qa.example.test/'); });
  expect(await handleBrowserControl(request(), sender)).toMatchObject({ success: false, error: 'Browser control selection changed' });
  expect(rules.size).toBe(0);
});
it('keeps the accepted destinations across updates and frame reports, then accepts a same-value reselection', async () => {
  await handleBrowserControl(request(), sender);
  fixture.current = selected(); fixture.current.revision = 'two'; fixture.current.definition.options[1].networkRoutes.routes[0].toHost = 'new.example.test';
  await addNetworkControlOrigin(1, 'https://frame.example.test/');
  expect([...rules.values()].filter(rule => rule.condition.regexFilter).every(rule => rule.condition.regexFilter!.includes('qa\\.example\\.test'))).toBe(true);
  await handleBrowserControl(request(), sender);
  expect([...rules.values()].filter(rule => rule.condition.regexFilter).every(rule => rule.condition.regexFilter!.includes('new\\.example\\.test'))).toBe(true);
  expect(storage[networkControlStorageKey(1)].revision).toBe('two');
});
it('restores the entire accepted rule set and selection after a failed storage write', async () => {
  await handleBrowserControl(request(), sender);
  const previous = structuredClone([...rules.values()]);
  const state = structuredClone(storage);
  fixture.current!.revision = 'two';
  vi.mocked(chrome.storage.session.set).mockImplementationOnce(async values => { Object.assign(storage, values); throw new Error('Storage failed'); });
  expect(await handleBrowserControl(request(), sender)).toMatchObject({ success: false, error: 'Storage failed' });
  expect([...rules.values()]).toEqual(previous); expect(storage).toEqual(state);
});
it('allows clearing accepted rules after the contributing package has been removed', async () => {
  await handleBrowserControl(request(), sender);
  fixture.current = undefined;
  expect(await handleBrowserControl({ action: 'browserControlClear', tabId: 1 }, sender)).toEqual({ success: true });
  expect(rules.size).toBe(0);
  expect(storage[networkControlStorageKey(1)]).toMatchObject({ value: 'off', plan: { routes: [] } });
});
