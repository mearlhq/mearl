import { describe, expect, it, vi } from 'vitest';
import { runUnifiedCheck, type UnifiedCheckDependencies } from '../check.js';

function createDependencies(
  invoke: (action: string, data?: Record<string, any>, options?: Record<string, any>) => any,
) {
  const writeLine = vi.fn();
  const client = { invoke: vi.fn(invoke), disconnect: vi.fn() };
  const dependencies: UnifiedCheckDependencies = {
    createClient: vi.fn(() => client),
    inspectNativeHostInstallation: vi.fn(() => []),
    writeLine,
  };
  return { client, dependencies, writeLine };
}

const BROWSERS = [
  {
    browserId: 'mearl:local:extension-a',
    name: '[this machine] Chrome',
    originalName: 'Chrome',
    status: 'connected',
    type: 'regular',
    transport: 'extension',
  },
  {
    browserId: 'mearl:remote:node-a:example-cloud:session-a',
    name: '[work-mac] cloud-browser',
    originalName: 'cloud-browser',
    status: 'connected',
    type: 'managed',
    provider: { id: 'example-cloud', name: 'Example Cloud', builtin: false },
    ownership: 'owned',
    persistence: 'ephemeral',
    operations: ['close'],
    transport: 'cdp',
  },
];

describe('runUnifiedCheck', () => {
  it.each([
    { source: undefined, payload: { version: '3.1.0' } },
    { source: 'https://releases.example.com/config.json', payload: { latestVersion: '3.1.0' } },
  ])(
    'reads public package metadata or a configured extension release source ($source)',
    async ({ source, payload }) => {
      if (source) vi.stubEnv('MEARL_EXTENSION_CONFIG_URL', source);
      else vi.stubEnv('MEARL_EXTENSION_CONFIG_URL', '');
      const fetcher = vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (url.includes('registry.npmjs.org') ? { version: '3.1.0' } : payload),
      }));
      vi.stubGlobal('fetch', fetcher);
      try {
        const { dependencies } = createDependencies(async action => {
          if (action === 'browser_list') return { connectedCount: 1, browsers: [BROWSERS[0]] };
          if (action === 'get_versions') return { nativeHost: '3.0.0', extension: '3.0.0' };
          throw new Error(`unexpected ${action}`);
        });
        const result = await runUnifiedCheck(
          { clientVersion: '3.0.0', checkUpdates: true, json: true },
          { ...dependencies, writeJson: () => {} },
        );
        expect(result.ok).toBe(true);
        expect(result.updates?.find(item => item.component === 'extension')).toMatchObject({
          installed: '3.0.0',
          latest: '3.1.0',
          status: 'available',
        });
        expect(
          fetcher.mock.calls.some(
            ([url]) => url === (source ?? 'https://mearlhq.github.io/mearl/config.json'),
          ),
        ).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([{ local: true }, {}, { local: true, serverUrl: 'wss://example.com' }])(
    'includes offline launcher diagnostics for local discovery: %j',
    async scope => {
      const { dependencies } = createDependencies(async () => ({ browsers: [] }));
      const inspect = vi.fn(() => [
        { label: 'Broken launcher', details: ['Missing Node.js: /old/bin/node'] },
      ]);
      const result = await runUnifiedCheck(
        { clientVersion: '2.20.0', json: true, ...scope },
        { ...dependencies, inspectNativeHostInstallation: inspect, writeJson: () => {} },
      );

      expect(inspect).toHaveBeenCalledOnce();
      expect(result.environment).toContainEqual({
        status: 'warning',
        label: 'Broken launcher',
        details: ['Missing Node.js: /old/bin/node'],
      });
    },
  );

  it('does not inspect local launchers for remote scope', async () => {
    const { dependencies } = createDependencies(async () => ({ browsers: [], connectors: [] }));
    await runUnifiedCheck(
      { clientVersion: '2.20.0', json: true, serverUrl: 'wss://example.com' },
      { ...dependencies, writeJson: () => {} },
    );
    expect(dependencies.inspectNativeHostInstallation).not.toHaveBeenCalled();
  });

  it('can diagnose registrations even when browser inventory cannot reach the host', async () => {
    const { dependencies } = createDependencies(async () => {
      throw new Error('Host unavailable');
    });
    const diagnostic = { label: 'Broken launcher', details: ['Node.js is missing'] };
    const result = await runUnifiedCheck(
      { clientVersion: '2.20.0', local: true, json: true },
      { ...dependencies, inspectNativeHostInstallation: () => [diagnostic], writeJson: () => {} },
    );
    expect(result.ok).toBe(false);
    expect(result.environment).toContainEqual({ status: 'warning', ...diagnostic });
  });

  it('does not inspect launchers when the local extension is connected', async () => {
    const { dependencies } = createDependencies(async action =>
      action === 'browser_list'
        ? { browsers: [BROWSERS[0]] }
        : { nativeHost: '2.20.0', extension: '2.20.0' },
    );
    await runUnifiedCheck(
      { clientVersion: '2.20.0', local: true, json: true },
      { ...dependencies, writeJson: () => {} },
    );
    expect(dependencies.inspectNativeHostInstallation).not.toHaveBeenCalled();
  });

  it('points to the Agent server when discovery fails', async () => {
    const { dependencies } = createDependencies(async action => {
      if (action === 'connector_list') throw new Error('Connection timeout after 5s');
      if (action === 'browser_list') return { browsers: [] };
      throw new Error(`unexpected ${action}`);
    });
    const result = await runUnifiedCheck(
      { clientVersion: '2.19.0', serverUrl: 'wss://example.com/ws?token=secret', json: true },
      { ...dependencies, writeJson: () => {} },
    );

    expect(result.ok).toBe(false);
    const item = result.environment.find(item =>
      item.label.startsWith('Cloud server or connector'),
    );
    expect(item?.details?.join('\n')).toContain('On the Agent machine');
    expect(item?.details?.join('\n')).toContain('mearl-cloud-server status');
    expect(item?.details?.join('\n')).not.toContain('token=secret');
  });

  it('points to the browser machine only when connected connectors expose no ready browser', async () => {
    const { dependencies } = createDependencies(async action => {
      if (action === 'connector_list')
        return { connectors: [{ connectorId: 'node-a', name: 'work-mac' }] };
      if (action === 'browser_list') return { browsers: [] };
      throw new Error(`unexpected ${action}`);
    });
    const result = await runUnifiedCheck(
      { clientVersion: '2.19.0', serverUrl: 'wss://example.com', json: true },
      { ...dependencies, writeJson: () => {} },
    );
    const item = result.environment.find(item => item.label === 'No connected browser');
    expect(item?.details?.join('\n')).toContain('On the browser machine');
    expect(item?.details?.join('\n')).toContain('mearl connector_list');

    const localResult = await runUnifiedCheck(
      { clientVersion: '2.19.0', local: true, json: true },
      { ...dependencies, writeJson: () => {} },
    );
    expect(JSON.stringify(localResult.environment)).not.toContain('mearl connector_list');
  });

  it('reports newer releases without failing a ready browser and tolerates an unavailable source', async () => {
    const writeJson = vi.fn();
    const fetchLatestVersion = vi.fn(async (component: string) => {
      if (component === 'native-host') throw new Error('network unavailable');
      return component === 'client' ? '2.19.0' : '2.18.0';
    });
    const { dependencies } = createDependencies(async action => {
      if (action === 'browser_list') {
        expect(fetchLatestVersion).toHaveBeenCalledTimes(4);
        return { connectedCount: 1, browsers: [BROWSERS[0]] };
      }
      if (action === 'get_versions') {
        return { nativeHost: '2.17.0', extension: '2.18.0' };
      }
      throw new Error(`unexpected ${action}`);
    });
    const result = await runUnifiedCheck(
      { clientVersion: '2.18.0', checkUpdates: true, json: true },
      { ...dependencies, fetchLatestVersion, writeJson },
    );

    expect(result.ok).toBe(true);
    expect(result.updates).toEqual([
      { component: 'client', installed: '2.18.0', latest: '2.19.0', status: 'available' },
      { component: 'native-host', installed: '2.17.0', status: 'unavailable' },
      { component: 'extension', installed: '2.18.0', latest: '2.18.0', status: 'current' },
    ]);
    expect(result.environment).toContainEqual(
      expect.objectContaining({ status: 'warning', label: '1 Mearl update available' }),
    );
    expect(result.environment.at(-1)?.details).toContain(
      'Update on the affected machine: npx @mearl/setup update',
    );
    expect(fetchLatestVersion).toHaveBeenCalledTimes(4);
  });

  it('shows the extension command separately from package updates', async () => {
    const { dependencies } = createDependencies(async action => {
      if (action === 'connector_list') {
        return { connectors: [{ connectorId: 'node-a', name: 'work-mac', version: '2.18.0' }] };
      }
      if (action === 'browser_list') return { connectedCount: 1, browsers: [BROWSERS[0]] };
      if (action === 'get_versions') {
        return { nativeHost: '2.18.0', extension: '2.18.0' };
      }
      throw new Error(`unexpected ${action}`);
    });
    const result = await runUnifiedCheck(
      { clientVersion: '2.18.0', checkUpdates: true, json: true, serverUrl: 'wss://example.com' },
      {
        ...dependencies,
        fetchLatestVersion: async component =>
          component === 'extension' || component === 'cloud-connector' ? '2.19.0' : '2.18.0',
        writeJson: () => {},
      },
    );

    const details = result.environment.at(-1)?.details;
    expect(details).toContain('Update a setup-managed extension: npx @mearl/setup extension');
    expect(details).toContain(
      'Update cloud-connector with its package manager on the connector machine.',
    );
    expect(details).not.toContain('Update on the affected machine: npx @mearl/setup update');
  });

  it('shows capabilities only when checking a selected Provider browser', async () => {
    const providerBrowser = {
      browserId: 'mearl:local:provider:example-device:device-a',
      name: '[this machine] Example device',
      status: 'connected',
      type: 'managed',
      transport: 'provider',
      provider: {
        id: 'example-device',
        name: 'Example Device Provider',
        builtin: false,
        version: '0.2.0',
        protocolVersion: 2,
      },
      ownership: 'owned',
      persistence: 'persistent',
      operations: ['close'],
    };
    const writeJson = vi.fn();
    const { dependencies, writeLine } = createDependencies(async action => {
      if (action === 'browser_list') {
        return { connectedCount: 1, browsers: [providerBrowser] };
      }
      if (action === 'get_versions') {
        return {
          provider: {
            id: 'example-device',
            name: 'Example Device Provider',
            builtin: false,
            version: '0.2.0',
            protocolVersion: 2,
          },
          capabilities: {
            actions: ['page_snapshot', 'page_click'],
            screenshot: 'none',
          },
        };
      }
      throw new Error(`unexpected ${action}`);
    });

    const result = await runUnifiedCheck(
      {
        browser: providerBrowser.browserId,
        clientVersion: '2.12.0',
        json: true,
        local: true,
      },
      { ...dependencies, writeJson },
    );

    expect(result.browsers[0]).toMatchObject({
      capabilities: {
        actions: ['page_snapshot', 'page_click'],
        screenshot: 'none',
      },
      versions: {
        provider: {
          id: 'example-device',
          builtin: false,
          version: '0.2.0',
          protocolVersion: 2,
        },
      },
    });
    expect(writeJson).toHaveBeenCalledWith(expect.stringContaining('"capabilities"'));
    expect(writeLine).not.toHaveBeenCalled();
  });

  it('returns machine-readable extension installation details in JSON mode', async () => {
    const writeJson = vi.fn();
    const { dependencies, writeLine } = createDependencies(async action => {
      if (action === 'browser_list') {
        return {
          connectedCount: 1,
          defaultBrowserId: BROWSERS[0]!.browserId,
          browsers: [BROWSERS[0]],
        };
      }
      if (action === 'get_versions') {
        return {
          nativeHost: '2.8.0',
          extension: '2.8.0',
          extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
          setupManagedPath: '/home/test/.mearl/chrome-extension',
          browser: '151.0.0',
        };
      }
      throw new Error(`unexpected ${action}`);
    });

    const result = await runUnifiedCheck(
      { clientVersion: '2.8.0', json: true, local: true },
      { ...dependencies, writeJson },
    );

    expect(result).toMatchObject({
      ok: true,
      browsers: [
        {
          extensionInstallation: {
            extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
            setupManagedPath: '/home/test/.mearl/chrome-extension',
          },
        },
      ],
    });
    expect(result.browsers[0]?.check).toEqual({
      label: 'Browser command path',
      status: 'ok',
    });
    expect(result.browsers[0]?.versions).toEqual({
      browser: '151.0.0',
      extension: '2.8.0',
      nativeHost: '2.8.0',
    });
    expect(writeJson).toHaveBeenCalledWith(expect.stringContaining('"setupManagedPath"'));
    expect(writeLine).not.toHaveBeenCalled();
  });

  it('omits local extension paths outside an explicitly local check', async () => {
    const { dependencies } = createDependencies(async action => {
      if (action === 'browser_list') {
        return { connectedCount: 1, browsers: [BROWSERS[0]] };
      }
      if (action === 'get_versions') {
        return {
          nativeHost: '2.8.0',
          extension: '2.8.0',
          extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
          setupManagedPath: '/home/test/.mearl/chrome-extension',
        };
      }
      throw new Error(`unexpected ${action}`);
    });

    const result = await runUnifiedCheck(
      { clientVersion: '2.8.0', json: true },
      { ...dependencies, writeJson: () => {} },
    );

    expect(result.browsers[0]?.extensionInstallation).toBeUndefined();
  });

  it('checks every connected browser by its global id', async () => {
    const { client, dependencies, writeLine } = createDependencies(async action => {
      if (action === 'connector_list') return { count: 0, connectors: [] };
      if (action === 'browser_list') {
        return { connectedCount: 2, defaultBrowserId: BROWSERS[0]!.browserId, browsers: BROWSERS };
      }
      if (action === 'get_versions') {
        return { nativeHost: '2.6.0', extension: '2.6.0', browser: '151.0.0' };
      }
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck({ clientVersion: '2.6.0', local: true }, dependencies),
    ).resolves.toBe(true);

    const versionCalls = client.invoke.mock.calls.filter(call => call[0] === 'get_versions');
    expect(versionCalls.map(call => call[2]?.browser)).toEqual(
      BROWSERS.map(item => item.browserId),
    );
    expect(client.invoke.mock.calls.some(call => call[0] === 'get_browser_access_url')).toBe(false);
    expect(writeLine).toHaveBeenCalledWith('🎉 All 2 connected browsers are ready!');
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('accepts a legacy encoded global id as the selected browser', async () => {
    const browser = {
      browserId: 'mearl:local:managed:account-a',
      originalBrowserId: 'managed:account-a',
      name: '[this machine] account-a',
      originalName: 'account-a',
      status: 'connected',
      type: 'managed',
      provider: 'local' as const,
      transport: 'cdp' as const,
    };
    const { client, dependencies } = createDependencies(async action => {
      if (action === 'browser_list') {
        return { connectedCount: 1, defaultBrowserId: browser.browserId, browsers: [browser] };
      }
      if (action === 'get_versions') {
        return { nativeHost: '2.9.0', browser: '151.0.0' };
      }
      if (action === 'tab_list') return { tabs: [] };
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck(
        {
          clientVersion: '2.9.0',
          local: true,
          browser: 'mearl:local:managed%3Aaccount-a',
        },
        dependencies,
      ),
    ).resolves.toBe(true);
    expect(client.invoke).toHaveBeenCalledWith(
      'get_versions',
      {},
      expect.objectContaining({ browser: browser.browserId }),
    );
    expect(client.invoke.mock.calls.some(call => call[0] === 'get_browser_access_url')).toBe(false);
  });

  it('checks only the selected browser and reports a broken command path', async () => {
    const { client, dependencies, writeLine } = createDependencies(
      async (action, _data, options) => {
        if (action === 'browser_list') {
          return {
            connectedCount: 2,
            defaultBrowserId: BROWSERS[0]!.browserId,
            browsers: BROWSERS,
          };
        }
        if (action === 'get_versions' && options?.browser === BROWSERS[1]!.browserId) {
          throw new Error('CDP session is unavailable');
        }
        throw new Error(`unexpected ${action}`);
      },
    );

    await expect(
      runUnifiedCheck(
        { clientVersion: '2.6.0', local: true, browser: 'cloud-browser' },
        dependencies,
      ),
    ).resolves.toBe(false);

    expect(client.invoke.mock.calls.filter(call => call[0] === 'get_versions')).toHaveLength(1);
    expect(writeLine).toHaveBeenCalledWith(
      '⚠️  Mearl checks failed. See the browser or source details above.',
    );
  });

  it('surfaces partial browser discovery warnings without failing healthy browsers', async () => {
    const { dependencies, writeLine } = createDependencies(async action => {
      if (action === 'browser_list') {
        return {
          connectedCount: 1,
          defaultBrowserId: BROWSERS[0]!.browserId,
          browsers: [BROWSERS[0]],
          warnings: ['broken-node: request timeout'],
        };
      }
      if (action === 'get_versions') return { nativeHost: '2.6.0', extension: '2.6.0' };
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck({ clientVersion: '2.6.0', local: true }, dependencies),
    ).resolves.toBe(true);
    expect(writeLine).toHaveBeenCalledWith('  ⚠️  Some browser sources could not be inspected');
  });

  it('checks the selected CDP browser through its browser ID', async () => {
    const cdpBrowser = {
      browserId: 'mearl:local:cdp',
      name: '[this machine] CDP',
      status: 'connected',
      type: 'regular',
      transport: 'cdp',
    };
    const { client, dependencies } = createDependencies(async action => {
      if (action === 'browser_list') {
        return {
          connectedCount: 1,
          defaultBrowserId: cdpBrowser.browserId,
          browsers: [cdpBrowser],
        };
      }
      if (action === 'tab_list') return { tabs: [], count: 0 };
      if (action === 'get_versions') return { nativeHost: '2.6.0' };
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck(
        { clientVersion: '2.6.0', local: true, browser: cdpBrowser.browserId },
        dependencies,
      ),
    ).resolves.toBe(true);

    expect(client.invoke).toHaveBeenCalledWith(
      'tab_list',
      {},
      expect.objectContaining({ browser: cdpBrowser.browserId }),
    );
    expect(client.invoke).toHaveBeenCalledWith(
      'get_versions',
      {},
      expect.objectContaining({ browser: cdpBrowser.browserId }),
    );
  });

  it('reports a missing CDP browser when only the extension is connected', async () => {
    const { client, dependencies, writeLine } = createDependencies(async action => {
      if (action === 'browser_list') {
        return {
          connectedCount: 1,
          defaultBrowserId: BROWSERS[0]!.browserId,
          browsers: [BROWSERS[0]],
        };
      }
      if (action === 'tab_list') {
        throw new Error('Chrome DevTools remote debugging is not available on port 9222');
      }
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck(
        { clientVersion: '2.6.0', local: true, browser: 'mearl:local:cdp' },
        dependencies,
      ),
    ).resolves.toBe(false);
    expect(writeLine).toHaveBeenCalledWith(
      '⚠️  Mearl checks failed. See the browser or source details above.',
    );
    expect(client.invoke).not.toHaveBeenCalledWith('tab_list', {}, expect.anything());
  });

  it('reports an unavailable browser access URL as a warning', async () => {
    const { dependencies, writeLine } = createDependencies(async action => {
      if (action === 'browser_list') {
        return {
          connectedCount: 1,
          defaultBrowserId: BROWSERS[1]!.browserId,
          browsers: [BROWSERS[1]],
        };
      }
      if (action === 'get_versions') {
        return {
          nativeHost: '2.6.0',
          browser: '151.0.0',
          browserAccess: { kind: 'example-cloud' },
        };
      }
      if (action === 'get_browser_access_url') throw new Error('session info unavailable');
      if (action === 'tab_list') return { tabs: [] };
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck(
        { clientVersion: '2.6.0', local: true, browser: 'cloud-browser' },
        dependencies,
      ),
    ).resolves.toBe(true);
    expect(writeLine).toHaveBeenCalledWith(
      '      ⚠️  Browser command path ready; browser access URL unavailable',
    );
    expect(writeLine).toHaveBeenCalledWith(
      '         Browser access URL unavailable: session info unavailable',
    );
  });

  it('fetches a fresh Example Cloud access URL through the unified action', async () => {
    const { client, dependencies, writeLine } = createDependencies(async action => {
      if (action === 'browser_list') {
        return {
          connectedCount: 1,
          defaultBrowserId: BROWSERS[1]!.browserId,
          browsers: [BROWSERS[1]],
        };
      }
      if (action === 'get_versions') {
        return {
          nativeHost: '2.6.0',
          browser: '151.0.0',
          browserAccess: { kind: 'example-cloud' },
        };
      }
      if (action === 'get_browser_access_url') {
        return {
          browserAccess: {
            kind: 'example-cloud',
            url: 'https://cloud.example/access?ticket=fresh',
          },
        };
      }
      if (action === 'tab_list') return { tabs: [] };
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck(
        { clientVersion: '2.6.0', local: true, browser: 'cloud-browser' },
        dependencies,
      ),
    ).resolves.toBe(true);
    expect(client.invoke).toHaveBeenCalledWith(
      'get_browser_access_url',
      {},
      expect.objectContaining({ browser: BROWSERS[1]!.browserId }),
    );
    expect(writeLine).toHaveBeenCalledWith(
      '         Browser access URL (example-cloud; sensitive): https://cloud.example/access?ticket=fresh',
    );
  });

  it('returns a selected sandbox noVNC URL in the unified JSON field', async () => {
    const writeJson = vi.fn();
    const sandboxBrowser = {
      ...BROWSERS[0],
      browserId: 'mearl:local:cdp',
      transport: 'cdp' as const,
    };
    const { client, dependencies } = createDependencies(async action => {
      if (action === 'browser_list') {
        return { connectedCount: 1, browsers: [sandboxBrowser] };
      }
      if (action === 'tab_list') return { tabs: [] };
      if (action === 'get_versions') {
        return {
          nativeHost: '2.9.0',
          browserAccess: {
            kind: 'sandbox-novnc',
            environment: 'opensandbox',
            port: 6080,
          },
        };
      }
      if (action === 'get_browser_access_url') {
        return {
          browserAccess: {
            kind: 'sandbox-novnc',
            environment: 'opensandbox',
            port: 6080,
            url: 'https://sandbox-6080.example/',
          },
        };
      }
      throw new Error(`unexpected ${action}`);
    });

    const result = await runUnifiedCheck(
      { clientVersion: '2.9.0', browser: sandboxBrowser.browserId, json: true, local: true },
      { ...dependencies, writeJson },
    );

    expect(result.browsers[0]?.browserAccess).toEqual({
      kind: 'sandbox-novnc',
      environment: 'opensandbox',
      port: 6080,
      url: 'https://sandbox-6080.example/',
    });
    expect(
      client.invoke.mock.calls.filter(call => call[0] === 'get_browser_access_url'),
    ).toHaveLength(1);
  });

  it('does not request access URLs without an explicit browser selection', async () => {
    const { client, dependencies } = createDependencies(async action => {
      if (action === 'browser_list') {
        return { connectedCount: 1, browsers: [BROWSERS[1]] };
      }
      if (action === 'get_versions') {
        return { nativeHost: '2.9.0', browserAccess: { kind: 'example-cloud' } };
      }
      throw new Error(`unexpected ${action}`);
    });

    await expect(
      runUnifiedCheck({ clientVersion: '2.9.0', local: true }, dependencies),
    ).resolves.toBe(true);
    expect(client.invoke.mock.calls.some(call => call[0] === 'get_browser_access_url')).toBe(false);
  });
});
