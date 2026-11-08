import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDevRulePermissions } from '../devRulePermissions';
import type { StoredRuleForm } from '../devRulesUtils';

const form: StoredRuleForm = {
  id: 1,
  priority: 1,
  actionType: 'modifyHeaders',
  redirectType: 'url',
  redirectUrl: '',
  regexSubstitution: '',
  filterType: 'regexFilter',
  regexFilter: '^https://example\\.com/',
  urlFilter: '',
  initiatorDomains: '',
  resourceTypes: ['xmlhttprequest'],
};

describe('checkDevRulePermissions', () => {
  beforeEach(() => {
    chrome.permissions = {
      contains: vi.fn(async () => false),
    } as unknown as typeof chrome.permissions;
  });

  it('checks request hosts, ports and initiators without requesting access to redirect destinations', async () => {
    const result = await checkDevRulePermissions([
      {
        ...form,
        actionType: 'redirect',
        regexFilter: '^https?://30\\.165\\.10\\.69:1100/clam/',
        redirectUrl: 'http://destination.invalid/',
        initiatorDomains: 'edith.example.com/clam/([^/]+)/, other.example.com',
      },
    ]);
    expect(result).toEqual({
      missingOrigins: [
        '*://30.165.10.69/*',
        '*://*.edith.example.com/*',
        '*://*.other.example.com/*',
      ],
      hasUnscopedRules: false,
    });
  });

  it('expands finite host alternatives and deduplicates shared domains', async () => {
    expect(
      await checkDevRulePermissions([
        form,
        { ...form, regexFilter: '^https://(example\\.com|other\\.com)/' },
      ]),
    ).toEqual({
      missingOrigins: ['https://example.com/*', 'https://other.com/*'],
      hasUnscopedRules: false,
    });
  });

  it.each(['^https://example\\.com/api(?:[/?]|$)', '^https:\\/\\/example\\.com\\/api'])(
    'recognizes bounded regex %s',
    async regexFilter => {
      expect(await checkDevRulePermissions([{ ...form, regexFilter }])).toEqual({
        missingOrigins: ['https://example.com/*'],
        hasUnscopedRules: false,
      });
    },
  );

  it('checks URL-filter domain anchors and explicit URLs', async () => {
    expect(
      await checkDevRulePermissions([
        { ...form, filterType: 'urlFilter', urlFilter: '||example.com^' },
        { ...form, filterType: 'urlFilter', urlFilter: '|http://localhost:8080/*' },
        { ...form, filterType: 'urlFilter', urlFilter: '|https://*.example.net/*' },
      ]),
    ).toEqual({
      missingOrigins: ['*://*.example.com/*', 'http://localhost/*', 'https://*.example.net/*'],
      hasUnscopedRules: false,
    });
  });

  it('returns only missing scopes and skips disabled or permission-free actions', async () => {
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => true);
    expect(
      await checkDevRulePermissions([
        form,
        { ...form, enabled: false },
        ...(['block', 'allow', 'upgradeScheme'] as const).map(actionType => ({
          ...form,
          actionType,
        })),
      ]),
    ).toEqual({ missingOrigins: [], hasUnscopedRules: false });
    expect(chrome.permissions.contains).toHaveBeenCalledTimes(1);
  });

  it('does not demand initiator permissions for navigation-only rules', async () => {
    await checkDevRulePermissions([
      {
        ...form,
        resourceTypes: ['main_frame', 'sub_frame'],
        initiatorDomains: 'source.example.com',
      },
    ]);
    expect(chrome.permissions.contains).toHaveBeenCalledTimes(1);
  });

  it('checks IP initiators using their exact host permission', async () => {
    const result = await checkDevRulePermissions([
      { ...form, initiatorDomains: '30.165.10.69/clam/([^/]+)/' },
    ]);
    expect(result.missingOrigins).toEqual(['https://example.com/*', '*://30.165.10.69/*']);
  });

  it.each([
    '.*',
    '^https://.*example\\.com/',
    '^https://(foo\\.com)?/',
    '^https://example.com/',
    'example\\.com',
    '^https://example\\.com.attacker/',
    '^https://example\\.com/?',
    '^https://example\\.com/*',
    '^https://example\\.com/{0,1}',
    '^https://example\\.com(?:[abc])',
    '^https://example\\.com(?:[/?]|$)?',
  ])('reports unbounded patterns without guessing a scope: %s', async regexFilter => {
    expect(await checkDevRulePermissions([{ ...form, regexFilter }])).toEqual({
      missingOrigins: [],
      hasUnscopedRules: true,
    });
    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(chrome.permissions.contains).toHaveBeenCalledTimes(1);
  });

  it('accepts broad patterns when all host access is already granted', async () => {
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => true);
    expect(await checkDevRulePermissions([{ ...form, regexFilter: '.*' }])).toEqual({
      missingOrigins: [],
      hasUnscopedRules: false,
    });
  });

  it('reports an incomplete scope for top-level regex alternatives', async () => {
    expect(
      await checkDevRulePermissions([
        { ...form, regexFilter: '^https://example\\.com/foo|https://other\\.com/' },
      ]),
    ).toEqual({ missingOrigins: ['https://example.com/*'], hasUnscopedRules: true });
  });

  it('reports quoted RE2 patterns as incomplete rather than treating quoted parentheses as groups', async () => {
    expect(
      await checkDevRulePermissions([
        { ...form, regexFilter: '^https://example\\.com/\\Q(\\E|https://other\\.com/' },
      ]),
    ).toEqual({ missingOrigins: ['https://example.com/*'], hasUnscopedRules: true });
  });

  it('keeps escaped separators, character classes and path alternatives within a bounded host', async () => {
    expect(
      await checkDevRulePermissions([
        { ...form, regexFilter: '^https://example\\.com/(foo|bar)/[|]/\\|' },
      ]),
    ).toEqual({ missingOrigins: ['https://example.com/*'], hasUnscopedRules: false });
  });

  it('reports an incomplete scope for URL filters without a URL start anchor', async () => {
    expect(
      await checkDevRulePermissions([
        { ...form, filterType: 'urlFilter', urlFilter: 'https://example.com/*' },
      ]),
    ).toEqual({ missingOrigins: ['https://example.com/*'], hasUnscopedRules: true });
  });
});
