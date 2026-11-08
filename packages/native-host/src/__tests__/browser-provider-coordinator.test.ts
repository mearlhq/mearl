import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  externalProviders: [] as Array<Record<string, any>>,
  externalBrowser: null as Record<string, any> | null,
  launchExternal: vi.fn(),
  startExternal: vi.fn(),
  syncExternal: vi.fn(),
  closeExternal: vi.fn(),
  detachExternal: vi.fn(),
  accessExternal: vi.fn(),
  configureExternal: vi.fn(),
}));

vi.mock('../browser-provider.js', () => ({
  listExternalBrowserProviders: () => mocks.externalProviders,
  findProviderBrowser: () => mocks.externalBrowser,
  launchProviderBrowser: mocks.launchExternal,
  startProviderBrowser: mocks.startExternal,
  syncProviderBrowserCookies: mocks.syncExternal,
  closeProviderBrowser: mocks.closeExternal,
  detachProviderBrowser: mocks.detachExternal,
  accessProviderBrowser: mocks.accessExternal,
  configureProvider: mocks.configureExternal,
}));

import { BrowserProviderCoordinator } from '../browser-provider-coordinator.js';

const launchedBrowser = {
  browserId: 'fixture',
  name: 'Fixture',
  status: 'connected',
  control: { kind: 'provider' },
  persistence: 'ephemeral',
  operations: [],
};

function runtime(providerId: string, browsers: Array<Record<string, any>> = []) {
  return {
    definition: {
      descriptor: {
        providerId,
        name: providerId,
        version: '2.13.0',
        protocolVersion: 2,
        builtin: true,
      },
      browserType: {
        name: providerId,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      },
    },
    listBrowsers: vi.fn(async () => browsers),
    launch: vi.fn().mockResolvedValue(launchedBrowser),
    start: vi.fn().mockResolvedValue(launchedBrowser),
    syncCookies: vi.fn(),
    close: vi.fn(),
    detach: vi.fn(),
    getAccess: vi.fn(),
    configure: vi.fn(),
  };
}

beforeEach(() => {
  mocks.externalProviders = [];
  mocks.externalBrowser = null;
  vi.clearAllMocks();
  mocks.launchExternal.mockResolvedValue(launchedBrowser);
  mocks.startExternal.mockResolvedValue(launchedBrowser);
});

describe('BrowserProviderCoordinator', () => {
  it('keeps flat launch payloads for the built-in local Provider', async () => {
    const local = runtime('local');
    const coordinator = new BrowserProviderCoordinator([local] as any);

    await coordinator.launch({
      name: 'account-a',
      url: 'https://example.com',
      copyCookieDomains: ['example.com'],
    });
    expect(local.launch).toHaveBeenCalledWith({
      name: 'account-a',
      url: 'https://example.com',
      copyCookieDomains: { domains: ['example.com'] },
    });
  });

  it('accepts structured built-in options and returns public browser metadata', async () => {
    const local = runtime('local');
    const coordinator = new BrowserProviderCoordinator([local] as any);
    const result = await coordinator.launch({
      provider: 'local',
      providerOptions: { name: 'test' },
    });
    expect(local.launch).toHaveBeenCalledWith({ name: 'test' });
    expect(result).toMatchObject({
      type: 'managed',
      provider: { id: 'local', builtin: true },
      persistence: 'ephemeral',
    });
    expect(result).not.toHaveProperty('control');
    await expect(
      coordinator.launch({ name: 'flat', providerOptions: { name: 'nested' } }),
    ).rejects.toThrow('not both');
  });

  it('passes only structured providerOptions to an external Provider', async () => {
    mocks.externalProviders = [
      {
        provider: { id: 'fixture', name: 'Fixture', builtin: false },
        browserType: { name: 'Fixture', inputSchema: { type: 'object', properties: {} } },
      },
    ];
    const coordinator = new BrowserProviderCoordinator([]);
    const providerOptions = {
      enabled: true,
      retries: 3,
      tags: ['one', 'two'],
      settings: { region: 'cn' },
    };

    await coordinator.launch({ provider: 'fixture', providerOptions });

    expect(mocks.launchExternal).toHaveBeenCalledWith({
      provider: 'fixture',
      providerOptions,
    });
  });

  it('passes selected cookies and user agent to an external Provider as host context', async () => {
    mocks.externalProviders = [
      {
        provider: { id: 'fixture', name: 'Fixture', builtin: false },
        browserType: { name: 'Fixture', inputSchema: { type: 'object', properties: {} } },
      },
    ];
    const exportCookies = vi.fn(async (domains: string[]) =>
      [
        { name: 'sid', value: 'secret', domain: '.example.test', path: '/' },
        { name: 'other', value: 'ignored', domain: '.other.test', path: '/' },
      ].filter(cookie => domains.some(domain => cookie.domain.endsWith(domain))),
    );
    const getBrowserUserAgent = vi.fn(async () => 'Fixture/1.0');
    const coordinator = new BrowserProviderCoordinator([], {
      exportCookies,
      getBrowserUserAgent,
    });

    await coordinator.launch({
      provider: 'fixture',
      providerOptions: {
        copyCookieDomains: { domains: ['example.test'] },
        userAgentMode: 'desktop',
      },
    });

    expect(exportCookies).toHaveBeenCalledWith(['example.test']);
    expect(mocks.launchExternal).toHaveBeenCalledWith({
      provider: 'fixture',
      providerOptions: {
        copyCookieDomains: { domains: ['example.test'] },
        userAgentMode: 'desktop',
      },
      host: {
        cookies: [{ name: 'sid', value: 'secret', domain: '.example.test', path: '/' }],
        userAgent: 'Fixture/1.0',
      },
    });
  });

  it('maps lifecycle operations through a built-in runtime', async () => {
    const browser = {
      browserId: 'managed:fixture:browser-a',
      name: 'browser-a',
      operations: ['detach', 'access'],
    };
    const fixture = runtime('fixture', [browser]);
    fixture.getAccess.mockResolvedValue({
      kind: 'fixture',
      url: 'https://example.test/access',
      sensitive: true,
    });
    const coordinator = new BrowserProviderCoordinator([fixture] as any);

    await coordinator.start(browser.browserId);
    expect(fixture.start).toHaveBeenCalledWith({ browserId: browser.browserId });
    await coordinator.syncCookies(browser.browserId, { domains: ['example.test'] });
    expect(fixture.syncCookies).toHaveBeenCalledWith({
      browserId: browser.browserId,
      scope: { domains: ['example.test'] },
    });
    expect(fixture.launch).not.toHaveBeenCalled();

    await coordinator.close(browser.browserId, true);
    expect(fixture.close).toHaveBeenCalledWith({
      browserId: browser.browserId,
      deleteData: true,
    });

    await coordinator.detach(browser.browserId);
    expect(fixture.detach).toHaveBeenCalledWith({ browserId: browser.browserId });

    await expect(coordinator.access(browser.browserId)).resolves.toEqual({
      browserAccess: {
        kind: 'fixture',
        url: 'https://example.test/access',
        sensitive: true,
      },
    });

    await coordinator.configure('fixture', { apiKey: 'secret' });
    expect(fixture.configure).toHaveBeenCalledWith({ apiKey: 'secret' });
  });
  it('routes lifecycle operations to the selected external instance', async () => {
    const external = {
      browserId: 'provider:fixture:device-a',
      providerBrowserId: 'device-a',
      provider: { id: 'fixture', name: 'Fixture', builtin: false },
    };
    mocks.externalBrowser = external;
    const coordinator = new BrowserProviderCoordinator([]);
    await coordinator.start(external.browserId);
    await coordinator.syncCookies(external.browserId, { domains: ['example.test'] });
    expect(mocks.startExternal).toHaveBeenCalledWith(external);
    expect(mocks.syncExternal).toHaveBeenCalledWith(external, { domains: ['example.test'] });
    expect(mocks.launchExternal).not.toHaveBeenCalled();
  });
});
