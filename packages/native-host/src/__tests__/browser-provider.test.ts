import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installed: [
    {
      providerId: 'fixture',
      name: 'Fixture Provider',
      version: '0.1.0',
      protocolVersion: 3,
      browserType: {
        name: 'Fixture Browser',
        inputSchema: {
          type: 'object',
          required: ['endpoint'],
          properties: {
            code: { type: 'string', title: 'Pairing code' },
            endpoint: { type: 'string', title: 'Endpoint' },
          },
        },
      },
    },
  ] as Array<Record<string, any>>,
  live: {
    providerId: 'fixture',
    providerProtocolVersion: 3,
    socketPath: '/tmp/fixture.sock',
  } as Record<string, any> | null,
  browsers: [] as Array<Record<string, any>>,
  ensureRunning: vi.fn(async () => [] as string[]),
  request: vi.fn(async () => ({
    browserId: 'device-a',
    name: 'Fixture Browser',
    status: 'pairing',
    control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
    persistence: 'persistent',
    operations: ['close'],
    pairing: {
      kind: 'qr',
      url: 'https://example.test/pair?id=device-a',
      code: 'device-a',
    },
  })),
}));

vi.mock('@mearl/provider/host', async importOriginal => ({
  ...(await importOriginal<typeof import('@mearl/provider/host')>()),
  listInstalledProviders: () => mocks.installed,
  ensureProviderControlHost: vi.fn(async () => ({ socketPath: '/tmp/provider-control.sock' })),
  readProviderControlHost: vi.fn(() => ({ socketPath: '/tmp/provider-control.sock' })),
}));

vi.mock('@mearl/provider/runtime', () => ({
  ensureInstalledProvidersRunning: mocks.ensureRunning,
  providerBrowserKey: (providerId: string, browserId: string) =>
    `provider:${providerId}:${browserId}`,
  readLiveProvider: () => mocks.live,
}));

vi.mock('../browser-registry.js', () => ({
  listRegisteredBrowsers: () => mocks.browsers,
}));

vi.mock('../browser-socket-request.js', () => ({
  requestBrowserSocket: mocks.request,
}));

vi.mock('../version.js', () => ({ NATIVE_HOST_VERSION: '1.0.0' }));

import {
  closeProviderBrowser,
  accessProviderBrowser,
  startProviderBrowser,
  syncProviderBrowserCookies,
  findProviderBrowser,
  launchProviderBrowser,
  listExternalBrowserProviders,
  getProviderLaunchForm,
} from '../browser-provider.js';

beforeEach(() => {
  mocks.live = {
    providerId: 'fixture',
    providerProtocolVersion: 3,
    socketPath: '/tmp/fixture.sock',
  };
  mocks.browsers = [];
  vi.clearAllMocks();
});

describe('external browser providers', () => {
  it('rejects lifecycle mutations for external control on an older host', async () => {
    const browser = {
      browserId: 'provider:fixture:space',
      providerBrowserId: 'space',
      transport: 'provider',
      provider: { id: 'fixture', protocolVersion: 3 },
      capabilities: { actions: [], screenshot: 'none', controlSessionMode: 'external' },
    };
    await expect(closeProviderBrowser(browser as any)).rejects.toThrow(
      'CONTROL_SESSION_MODE_UNSUPPORTED',
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('routes dynamic form discovery directly to the selected Provider without a browser', async () => {
    mocks.installed[0]!.browserType.dynamicLaunchForm = true;
    mocks.request.mockResolvedValueOnce({
      inputSchema: { type: 'object', properties: {} },
      blocked: true,
      message: 'No resources available',
    } as any);
    await expect(
      getProviderLaunchForm('fixture', { variant: 'attach', values: {} }),
    ).resolves.toMatchObject({ blocked: true });
    expect(mocks.request).toHaveBeenCalledWith(
      '/tmp/fixture.sock',
      'browser_providers',
      { operation: 'launch_form', variant: 'attach', values: {} },
      '1.0.0',
      120_000,
    );
    delete mocks.installed[0]!.browserType.dynamicLaunchForm;
    await expect(getProviderLaunchForm('fixture', { values: {} })).rejects.toThrow(
      'does not support',
    );
  });

  it('lists the registered browser type and its form parameters', () => {
    expect(listExternalBrowserProviders()).toEqual([
      {
        provider: {
          id: 'fixture',
          name: 'Fixture Provider',
          builtin: false,
          version: '0.1.0',
          protocolVersion: 3,
        },
        browserType: mocks.installed[0]!.browserType,
      },
    ]);
  });

  it('validates registered parameters and asks the Provider to create a browser', async () => {
    await expect(
      launchProviderBrowser({
        provider: 'fixture',
        providerOptions: { code: 'custom', endpoint: 'relay.example.test' },
      }),
    ).resolves.toEqual({
      browserId: 'provider:fixture:device-a',
      name: 'Fixture Browser',
      status: 'pairing',
      control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
      persistence: 'persistent',
      operations: ['close'],
      pairing: {
        kind: 'qr',
        url: 'https://example.test/pair?id=device-a',
        code: 'device-a',
      },
    });

    expect(mocks.ensureRunning).toHaveBeenCalledOnce();
    expect(mocks.ensureRunning).toHaveBeenCalledWith(['fixture']);
    expect(mocks.request).toHaveBeenCalledWith(
      '/tmp/fixture.sock',
      'browser_launch',
      { code: 'custom', endpoint: 'relay.example.test' },
      '1.0.0',
      120_000,
    );
  });

  it('rejects an invalid browser creation result from a Provider', async () => {
    mocks.request.mockResolvedValueOnce({ browserId: 'device-a' });

    await expect(
      launchProviderBrowser({
        provider: 'fixture',
        providerOptions: { endpoint: 'relay.example.test' },
      }),
    ).rejects.toThrow('Provider browser device-a needs a name');

    mocks.request.mockResolvedValueOnce({
      browserId: 'device-a',
      name: 'Fixture Browser',
      status: 'pairing',
      control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
      persistence: 'persistent',
      operations: ['close'],
    });
    await expect(
      launchProviderBrowser({
        provider: 'fixture',
        providerOptions: { endpoint: 'relay.example.test' },
      }),
    ).rejects.toThrow('Pairing browser device-a needs a pairing URL');
  });

  it('resolves and deletes a Provider browser by its stable id', async () => {
    const browser = {
      browserId: 'provider:fixture:device-a',
      providerBrowserId: 'device-a',
      browserName: 'Fixture Browser',
      transport: 'provider',
      provider: { id: 'fixture', protocolVersion: 3 },
      socketPath: '/tmp/fixture.sock',
    };
    mocks.browsers = [browser];

    expect(findProviderBrowser(browser.browserId)).toBe(browser);
    await closeProviderBrowser(browser as any);

    expect(mocks.request).toHaveBeenCalledWith(
      '/tmp/provider-control.sock',
      'browser_manage',
      { operation: 'close', deleteProfile: false },
      '1.0.0',
      1_080_000,
      undefined,
      undefined,
      { providerTarget: browser.browserId },
    );
  });

  it('gates lifecycle mutations through Mearl while preserving read-only access', async () => {
    const browser = {
      browserId: 'provider:fixture:device-a',
      providerBrowserId: 'device-a',
      socketPath: '/tmp/provider.sock',
      transport: 'provider' as const,
      provider: {
        id: 'fixture',
        name: 'Fixture',
        builtin: false,
        version: '0.1.0',
        protocolVersion: 3,
      },
      pid: 1,
      browserName: 'Device',
    };
    await startProviderBrowser(browser);
    expect(mocks.request).toHaveBeenLastCalledWith(
      '/tmp/provider-control.sock',
      'browser_instances',
      { operation: 'start' },
      '1.0.0',
      120_000,
      undefined,
      undefined,
      { providerTarget: browser.browserId },
    );
    await syncProviderBrowserCookies(browser, { domains: ['example.test'] });
    expect(mocks.request).toHaveBeenLastCalledWith(
      '/tmp/provider-control.sock',
      'browser_instances',
      { operation: 'sync_cookies', scope: { domains: ['example.test'] } },
      '1.0.0',
      120_000,
      undefined,
      undefined,
      { providerTarget: browser.browserId },
    );
    const access = { kind: 'fixture', url: 'https://example.test/access', sensitive: true };
    mocks.request.mockResolvedValueOnce({ browserAccess: access });
    await expect(accessProviderBrowser(browser)).resolves.toEqual(access);
  });
});
