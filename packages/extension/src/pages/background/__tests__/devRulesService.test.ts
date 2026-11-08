import { beforeEach, expect, it, vi } from 'vitest';
import { autoApplyDevRules, disableDevRule, saveDevRules, withDevRulesUpdate } from '../devRulesService';
import { DEV_RULES_STORAGE_KEY, storedFormToRule, type StoredRuleForm } from '../../../shared/devRulesUtils';

const form: StoredRuleForm = {
  id: 1, priority: 1, actionType: 'block', redirectType: 'url', redirectUrl: '',
  regexSubstitution: '', filterType: 'urlFilter', urlFilter: '||example.test/',
  regexFilter: '', initiatorDomains: '', resourceTypes: ['xmlhttprequest'],
};
const reserved: chrome.declarativeNetRequest.Rule = { ...storedFormToRule(form), id: 999999 };
let storage: Record<string, any>;
let rules: chrome.declarativeNetRequest.Rule[];
beforeEach(async () => {
  await withDevRulesUpdate(async () => {});
  storage = { [DEV_RULES_STORAGE_KEY]: [form], devRulesEnabled: true };
  rules = [storedFormToRule(form), reserved];
  chrome.storage.local.get = vi.fn(async () => ({ ...storage })) as any;
  chrome.storage.local.set = vi.fn(async patch => { Object.assign(storage, patch); }) as any;
  chrome.declarativeNetRequest = {
    getDynamicRules: vi.fn(async () => [...rules]),
    updateDynamicRules: vi.fn(async ({ removeRuleIds = [], addRules = [] }) => {
      rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...addRules];
    }),
  } as any;
});

it('saves a disabled snapshot and immediately removes only user rules', async () => {
  expect(await saveDevRules([form], false)).toEqual({ success: true, rulesCount: 0 });
  expect(storage.devRulesEnabled).toBe(false);
  expect(rules).toEqual([reserved]);
});

it('serializes a slow apply and a newer disable without overlapping Chrome updates', async () => {
  const original = vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mockImplementationOnce(async options => {
    await new Promise<void>(resolve => { finish = resolve; });
    return original(options);
  });
  const first = saveDevRules([form], true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const last = saveDevRules([{ ...form, enabled: false }], false);
  await Promise.resolve();
  expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, last]);
  expect(storage).toEqual({ [DEV_RULES_STORAGE_KEY]: [{ ...form, enabled: false }], devRulesEnabled: false });
  expect(rules).toEqual([reserved]);
});

it('keeps an invalid draft durable and reports the actual unchanged DNR count', async () => {
  vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mockRejectedValueOnce(new Error('Invalid regex'));
  const invalid = { ...form, filterType: 'regexFilter' as const, regexFilter: '[' };
  expect(await saveDevRules([invalid], true)).toEqual({ success: false, error: 'Invalid regex', rulesCount: 1 });
  expect(storage[DEV_RULES_STORAGE_KEY]).toEqual([invalid]);
  expect(rules).toEqual([storedFormToRule(form), reserved]);
  expect(await saveDevRules([], false)).toEqual({ success: true, rulesCount: 0 });
});

it('does not alter active rules if draft persistence fails', async () => {
  vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('Storage unavailable'));
  expect(await saveDevRules([], false)).toMatchObject({ success: false, error: 'Storage unavailable', rulesCount: 1 });
  expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
});

it.each([{ ids: [reserved.id] }, { ids: [0] }, { ids: [1, 1] }])('rejects reserved or duplicate user rule IDs: $ids', async ({ ids }) => {
  expect(await saveDevRules(ids.map(id => ({ ...form, id })), true)).toMatchObject({ success: false });
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
});

it('leaves unresolved alpha rules for navigation and retains their stored placeholders', async () => {
  const alpha = { ...form, actionType: 'redirect' as const, redirectType: 'regexSubstitution' as const, regexSubstitution: 'https://target.test/\\a', initiatorDomains: 'example.test/([^/]+)/' };
  expect(await saveDevRules([alpha], true)).toEqual({ success: true, rulesCount: 0 });
  await autoApplyDevRules('https://example.test/hello/page');
  expect(rules.find(rule => rule.id === 1)?.action.redirect?.regexSubstitution).toBe('https://target.test/hello');
  expect(storage[DEV_RULES_STORAGE_KEY]).toEqual([alpha]);
});

it('does not let navigation re-enable rules after a queued global disable', async () => {
  const alpha = { ...form, actionType: 'redirect' as const, redirectType: 'url' as const, redirectUrl: 'https://target.test/\\a', initiatorDomains: 'example.test/([^/]+)/' };
  await Promise.all([saveDevRules([alpha], false), autoApplyDevRules('https://example.test/hello/page')]);
  expect(rules).toEqual([reserved]);
  expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledOnce();
});

it('shares the queue with tooltip disabling and rejects reserved IDs there too', async () => {
  await Promise.all([saveDevRules([form], true), disableDevRule(form.id)]);
  expect(storage[DEV_RULES_STORAGE_KEY]).toEqual([{ ...form, enabled: false }]);
  expect(rules).toEqual([reserved]);
  await expect(disableDevRule(reserved.id)).rejects.toThrow('Invalid request rule ID');
});
