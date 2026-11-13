import { expect, it } from 'vitest';
import { accountStateStorageKeys, parseBrowserUiSettings } from '../browserUiSettings';
import { resolveBrowserPresetSettings } from '../browserPresetSettings';
it('keeps configuration overrides separate from package-owned operations and logins', () => {
  const defaults = { extension: { links: { docs: 'https://docs.example.test/' } } };
  expect(
    resolveBrowserPresetSettings(
      defaults,
      { extension: { links: { docs: 'https://team.example.test/' } } },
      new Set(),
    ).extension?.links?.docs,
  ).toBe('https://team.example.test/');
  for (const extension of [{ operations: {} }, { logins: {} }, { preferenceAliases: {} }])
    expect(() => resolveBrowserPresetSettings({ extension } as never, {}, new Set())).toThrow(
      'Settings cannot declare operations, logins, or preference aliases',
    );
});
it.each([
  { logins: { account: { url: 'javascript:alert(1)', title: { en: 'Account' } } } },
  { logins: { account: { url: 'https://u:p@example.test/', title: { en: 'Account' } } } },
  { logins: { account: { url: 'http://example.test/', title: { en: 'Account' } } } },
  {
    logins: {
      account: { url: 'https://example.test/', title: { en: 'Account' }, arbitrary: true },
    },
  },
  { operations: { lookup: { hook: 'identity.account', setting: 'language' } } },
  { operations: { lookup: { hook: 'identity.account', arbitrary: true } } },
  { links: { docs: 'file:///etc/hosts' } },
])('rejects unsafe or unsupported known settings %#', value =>
  expect(() => parseBrowserUiSettings(value)).toThrow(),
);
it('allows only the original iOS manifest installer shape and preserves its exact link', () => {
  const url =
    'itms-services://?action=download-manifest&url=https%3A%2F%2Fdownloads.example.test%2Fapp.plist';
  expect(parseBrowserUiSettings({ installers: { ios: url } }).settings.installers?.ios).toBe(url);
  for (const value of [
    'javascript:alert(1)',
    'itms-services://host?url=https://example.test/&action=download-manifest',
    'itms-services://?action=other&url=https://example.test/',
    'itms-services://?action=download-manifest&url=file:///app.plist',
  ])
    expect(() => parseBrowserUiSettings({ installers: { ios: value } })).toThrow();
});
it('reports unknown extension fields as pending without claiming they are applied', () => {
  expect(parseBrowserUiSettings({ unknown: true })).toEqual({
    settings: {},
    pending: ['extension.unknown'],
  });
});

it('inherits heatmap display rules and validates the selected default and formats', () => {
  const heatmap = {
    measures: [
      { id: 'clicks', label: { en: 'Clicks', zh_CN: '点击' }, format: 'number' },
      { id: 'ratio', label: { en: 'Rate', zh_CN: '比例' }, format: 'percent' },
    ],
    defaultMeasure: 'clicks',
    pathPrefix: '/reports',
    bodySpmPrefix: 'site',
  };
  expect(
    resolveBrowserPresetSettings(
      { extension: { heatmap } },
      { extension: { heatmap: { defaultMeasure: 'ratio' } } },
      new Set(),
    ).extension?.heatmap,
  ).toEqual({ ...heatmap, defaultMeasure: 'ratio' });
  for (const change of [
    { defaultMeasure: 'missing' },
    { measures: [] },
    { measures: [heatmap.measures[0], heatmap.measures[0]] },
    { measures: [{ ...heatmap.measures[0], format: 'arbitrary' }] },
    { bodySpmPrefix: '";alert(1)' },
    { pathPrefix: 'https://example.test' },
  ])
    expect(() => parseBrowserUiSettings({ heatmap: { ...heatmap, ...change } })).toThrow();
});

it('inherits fixed-destination link templates and encodes only supplied data', async () => {
  const { browserUiLink } = await import('../browserUiSettings');
  const template =
    'https://trace.example.test/#/query?id={traceId}&start={startTime}&end={endTime}';
  const result = resolveBrowserPresetSettings(
    { extension: { linkTemplates: { trace: { template, title: { en: 'View trace' } } } } },
    {},
    new Set(),
  );
  expect(result.extension?.linkTemplates?.trace).toEqual({ template, title: { en: 'View trace' } });
  expect(result.pending).toEqual([]);
  expect(browserUiLink(template, { traceId: 'a&b/中文', startTime: 1, endTime: 2 })).toBe(
    'https://trace.example.test/#/query?id=a%26b%2F%E4%B8%AD%E6%96%87&start=1&end=2',
  );
  expect(() => browserUiLink(template, { traceId: 'id' })).toThrow('Missing link value');
  for (const value of [
    'https://{host}/?id={traceId}',
    'https://example.test/{traceId}',
    'https://example.test/#id={bad-token}',
    'javascript:alert(1)',
    'https://example.test/#id={unknown}',
  ])
    expect(() =>
      parseBrowserUiSettings({
        linkTemplates: { trace: { template: value, title: { en: 'Trace' } } },
      }),
    ).toThrow();
});

it('inherits template and message dictionaries while allowing focused preset overrides', () => {
  const rule = {
    id: 1,
    priority: 1,
    actionType: 'redirect',
    redirectType: 'url',
    regexSubstitution: '',
    redirectUrl: 'https://dev.example.test/',
    filterType: 'urlFilter',
    regexFilter: '',
    urlFilter: 'https://example.test/*',
    initiatorDomains: '',
    resourceTypes: ['main_frame'],
  };
  const defaults = {
    extension: {
      messages: { accountTitle: { en: 'Accounts', zh_CN: '账号' } },
      rulePresets: {
        redirect: {
          name: 'Development',
          description: { en: 'Use development assets' },
          rules: [rule],
        },
      },
    },
  };
  const settings = resolveBrowserPresetSettings(
    defaults,
    { extension: { messages: { accountTitle: { en: 'Team accounts' } } } },
    new Set(),
  );
  expect(settings.pending).toEqual([]);
  expect(settings.extension?.messages?.accountTitle).toEqual({
    en: 'Team accounts',
    zh_CN: '账号',
  });
  expect(settings.extension?.rulePresets?.redirect.rules).toEqual([rule]);
  expect(defaults.extension.messages.accountTitle.en).toBe('Accounts');
  for (const patch of [
    { actionType: 'arbitrary' },
    { requestHeaders: [{ header: 'x-test', operation: 'arbitrary', value: '' }] },
    { resourceTypes: ['unknown'] },
    { priority: 0 },
    { injected: 'code' },
  ])
    expect(() =>
      parseBrowserUiSettings({
        rulePresets: {
          redirect: { ...defaults.extension.rulePresets.redirect, rules: [{ ...rule, ...patch }] },
        },
      }),
    ).toThrow();
  for (const messages of [
    { accountTitle: { zh_CN: '缺少英文' } },
    { accountTitle: { en: 'Title', html: '<script>' } },
    { ['bad-key']: { en: 'Title' } },
  ])
    expect(() => parseBrowserUiSettings({ messages })).toThrow();
});

it('limits account storage to matching role-specific keys while allowing preset inheritance', () => {
  const accountState = { cacheKey: 'team-accounts-cache', identityKey: 'team-last-user-id' };
  const settings = resolveBrowserPresetSettings(
    { extension: { accountState } },
    { extension: { accountState: { identityKey: 'team-last-principal-id' } } },
    new Set(),
  );
  expect(accountStateStorageKeys(settings.extension)).toEqual({
    cacheKey: 'team-accounts-cache',
    identityKey: 'team-last-principal-id',
  });
  expect(settings.pending).toEqual([]);
  expect(accountStateStorageKeys()).toEqual({
    cacheKey: 'browser-accounts-cache',
    identityKey: 'browser-last-account-id',
  });
  for (const value of [
    { ...accountState, cacheKey: 'agent-api-key' },
    { ...accountState, identityKey: 'other-last-user-id' },
    { ...accountState, identityKey: 'team-api-key' },
    { ...accountState, identityKey: 'team-last-secret' },
    { ...accountState, arbitrary: true },
  ])
    expect(() => parseBrowserUiSettings({ accountState: value })).toThrow();
});

it('confines capture storage aliases to the declared role suffixes', () => {
  const { settings, pending } = parseBrowserUiSettings({ captureState: { namespace: 'team' } });
  expect(pending).toEqual([]);
  expect(settings.captureState).toEqual({ namespace: 'team' });
  for (const captureState of [
    { namespace: 'team', key: 'apiToken' },
    { namespace: '../team' },
    { namespace: '' },
    { namespace: 'A'.repeat(65) },
  ])
    expect(() => parseBrowserUiSettings({ captureState })).toThrow();
});

it('projects inherited tool directories as browser-only settings without pending fields', () => {
  const result = resolveBrowserPresetSettings(
    {
      extension: {
        toolCatalogs: { team: { url: 'https://example.com/tools.json', label: 'Team' } },
      },
    },
    { extension: { toolCatalogs: { team: { label: 'Local team' } } } },
    new Set(),
  );
  expect(result.extension?.toolCatalogs).toEqual({
    team: { url: 'https://example.com/tools.json', label: 'Local team' },
  });
  expect(result.pending).toEqual([]);
});
