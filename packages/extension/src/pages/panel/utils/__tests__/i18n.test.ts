import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({ messages: {} as Record<string, { en: string; zh_CN?: string }> }));
const ensureSettings = vi.hoisted(() => vi.fn());
vi.mock('../browserUiSettings', () => ({ ensureBrowserUiSettings: ensureSettings, getBrowserUiSettings: () => settings }));
import { initI18n, setLanguage, t } from '../i18n';
beforeEach(async () => {
  settings.messages = {};
  ensureSettings.mockReset().mockResolvedValue(settings);
  setLanguage('en');
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({
    guide: { message: 'Read $1 to complete setup' },
    pair: { message: '$1 then $2 and $1' },
  }) })));
  await initI18n('en');
});
afterEach(() => { setLanguage(''); vi.unstubAllGlobals(); });
it('treats configured guide URLs as literal substitution data', () => {
  const url = 'https://docs.example.test/setup?literal=$&-$`-$\'-$$';
  expect(t('guide', url)).toBe(`Read ${url} to complete setup`);
});
it('replaces source placeholders once without interpreting placeholders introduced by data', () => {
  expect(t('pair', ['https://docs.example.test/$2', 'complete'])).toBe('https://docs.example.test/$2 then complete and https://docs.example.test/$2');
});
it('retains placeholders that have no supplied value', () => {
  expect(t('pair', ['first'])).toBe('first then $2 and first');
});

it('loads local translations for a preview while browser UI settings are pending', async () => {
  ensureSettings.mockClear().mockImplementation(() => new Promise(() => {}));
  setLanguage('');
  await initI18n('en', { localOnly: true });
  expect(t('pair', ['one', 'two'])).toBe('one then two and one');
  expect(ensureSettings).not.toHaveBeenCalled();
});

it('uses the selected preset messages and safely substitutes data in either language', async () => {
  settings.messages = { pair: { en: 'Team $1 then $2', zh_CN: '团队 $1 然后 $2' } };
  expect(t('pair', ['$2', 'done'])).toBe('Team $2 then done');
  setLanguage('zh_CN');
  expect(t('pair', ['one', 'two'])).toBe('团队 one 然后 two');
  settings.messages = {};
  await initI18n('en');
  expect(t('pair', ['one', 'two'])).toBe('one then two and one');
});
