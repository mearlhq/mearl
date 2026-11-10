import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEARL_PROVIDER_PROTOCOL_VERSION,
  createProviderRuntime,
  createProviderServer,
  validateProviderBrowser,
  validateProviderInput,
  type BrowserProviderDefinition,
  type ProviderServer,
} from '../index.js';
import {
  listInstalledProviders,
  registerProviderPackage,
  uninstallProvider,
  validateInstalledProviderManifest,
} from '../host.js';
import { listProviderBrowserRecords, providerBrowserKey } from '../registry.js';

const installedIds: string[] = [];
const temporaryDirectories: string[] = [];
const activeServers: ProviderServer[] = [];

afterEach(async () => {
  await Promise.allSettled(activeServers.splice(0).map(server => server.stop()));
  for (const providerId of installedIds.splice(0)) uninstallProvider(providerId);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function uniqueId(label: string): string {
  return `test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function request(socketPath: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify(body && typeof body === 'object' && !Array.isArray(body) ? { protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION, ...body } : body)}\n`,
      ),
    );
    socket.on('data', chunk => {
      response += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response.trim()));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

function fixtureDefinition(
  providerId: string,
  overrides: Partial<BrowserProviderDefinition> = {},
): BrowserProviderDefinition {
  return {
    descriptor: {
      providerId,
      name: 'Fixture provider',
      version: '1.0.0',
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
    },
    browserType: {
      name: 'Fixture browser',
      inputSchema: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', minLength: 1 } },
      },
    },
    launch: async options => ({
      browserId: String(options.code),
      name: 'Fixture device',
      status: 'pairing',
      control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
      persistence: 'persistent',
      operations: ['close'],
      pairing: {
        kind: 'qr',
        url: `https://example.test/pair?id=${String(options.code)}`,
        code: String(options.code),
      },
    }),
    close: async ({ browserId }) => ({ deleted: browserId }),
    ...overrides,
  };
}

describe('@mearl/provider', () => {
  it.each([undefined, MEARL_PROVIDER_PROTOCOL_VERSION - 1])(
    'rejects caller protocol %s before launching a browser',
    async protocolVersion => {
      const launch = vi.fn();
      const server = createProviderServer({
        definition: fixtureDefinition(uniqueId('caller-version'), { launch }),
      });
      activeServers.push(server);
      await server.start();
      await expect(
        request(server.socketPath, {
          id: 'wrong-protocol',
          action: 'browser_launch',
          data: { code: 'test' },
          protocolVersion,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('PROVIDER_PROTOCOL_MISMATCH'),
      });
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('rejects old management aliases and unknown operations without entering adapters', async () => {
    const start = vi.fn(),
      configure = vi.fn(),
      getLaunchForm = vi.fn();
    const server = createProviderServer({
      definition: fixtureDefinition(uniqueId('management'), { start, configure, getLaunchForm }),
    });
    activeServers.push(server);
    await server.start();
    for (const [action, data] of [
      ['browser_manager_start', {}],
      ['browser_provider_configure', {}],
      ['browser_provider_launch_form', {}],
      ['browser_instances', { operation: 'unknown' }],
      ['browser_providers', { operation: 'unknown' }],
    ] as const) {
      await expect(
        request(server.socketPath, { id: 'invalid-operation', action, data }),
      ).resolves.toMatchObject({ success: false });
    }
    expect(start).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(getLaunchForm).not.toHaveBeenCalled();
  });
  it.each([
    [
      'cdp-devtools',
      'devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9222/devtools/page/tab',
      true,
    ],
    [
      'fixture',
      'devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9222/devtools/page/tab',
      false,
    ],
    ['cdp-devtools', 'devtools://other/bundled/inspector.html', false],
    ['cdp-devtools', 'devtools://devtools/other.html', false],
    ['cdp-devtools', 'file:///tmp/inspector.html', false],
    ['fixture', 'https://example.test/access', true],
  ])('validates browser access kind %s and URL %s', async (kind, url, valid) => {
    const runtime = createProviderRuntime(
      fixtureDefinition(uniqueId('access'), {
        getAccess: async () => ({ kind, url, sensitive: true }),
      }),
    );
    runtime.updateBrowsers([
      {
        browserId: 'browser',
        name: 'Browser',
        status: 'connected',
        control: { kind: 'host', transport: 'cdp', browserId: 'browser' },
        persistence: 'ephemeral',
        operations: ['access'],
      },
    ]);
    const access = runtime.getAccess({ browserId: 'browser' });
    if (valid) await expect(access).resolves.toEqual({ kind, url, sensitive: true });
    else await expect(access).rejects.toThrow('invalid browser access result');
  });

  it('serves read-only dynamic launch forms without requiring a browser instance', async () => {
    const getLaunchForm = vi.fn(async () => ({
      inputSchema: {
        type: 'object' as const,
        properties: {
          code: {
            type: 'string' as const,
            options: [
              { value: 'a', label: 'Available' },
              { value: 'b', label: 'Busy', disabled: true },
            ],
          },
        },
        required: ['code'],
      },
      variants: [{ id: 'new', title: 'Create' }],
      variant: 'new',
      refreshOn: ['code'],
      message: 'Choose an available resource',
    }));
    const definition = fixtureDefinition(uniqueId('form'), { getLaunchForm });
    definition.browserType.dynamicLaunchForm = true;
    const server = createProviderServer({ definition });
    activeServers.push(server);
    await server.start();
    await expect(
      request(server.socketPath, {
        id: 'form',
        action: 'browser_providers',
        data: { operation: 'launch_form', variant: 'new', values: {} },
      }),
    ).resolves.toMatchObject({
      success: true,
      data: { variant: 'new', message: 'Choose an available resource' },
    });
    expect(getLaunchForm).toHaveBeenCalledWith({ variant: 'new', values: {} }, {});
    await expect(server.runtime.getLaunchForm({ values: [] as any })).rejects.toThrow(
      'Invalid launch form request',
    );
  });

  it('validates static mode templates and the fields that load independently', () => {
    const definition = fixtureDefinition('static-form');
    definition.browserType.launchForm = {
      variant: 'new',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', options: [] } },
        required: ['code'],
      },
      dynamicFields: ['code'],
      variants: [
        { id: 'new', title: 'Create' },
        {
          id: 'attach',
          title: 'Use existing',
          inputSchema: { type: 'object', properties: {} },
          dynamicFields: [],
        },
      ],
    };
    expect(() => createProviderRuntime(definition)).not.toThrow();
    definition.browserType.launchForm.dynamicFields = ['missing'];
    expect(() => createProviderRuntime(definition)).toThrow('invalid launch form');
    definition.browserType.launchForm.dynamicFields = ['code'];
    definition.browserType.launchForm.variants = [
      { id: 'new', title: 'Create' },
      { id: 'attach', title: 'Use existing', inputSchema: { type: 'object', properties: {} } },
    ];
    expect(() => createProviderRuntime(definition)).toThrow('invalid launch form');
  });

  it('rejects malformed dynamic schemas, fixed parameters and undeclared capabilities', async () => {
    const definition = fixtureDefinition('form-validation');
    await expect(createProviderRuntime(definition).getLaunchForm({ values: {} })).rejects.toThrow(
      'does not support',
    );
    definition.browserType.dynamicLaunchForm = true;
    expect(() => createProviderRuntime(definition)).toThrow('does not implement');
    definition.getLaunchForm = async () => ({
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            options: [
              { value: 'x', label: 'First' },
              { value: 'x', label: 'Duplicate' },
            ],
          },
        },
      },
    });
    await expect(createProviderRuntime(definition).getLaunchForm({ values: {} })).rejects.toThrow(
      'invalid launch form',
    );
    definition.getLaunchForm = async () => ({
      inputSchema: { type: 'object', properties: {} },
      values: { credential: 'secret' },
    });
    await expect(createProviderRuntime(definition).getLaunchForm({ values: {} })).rejects.toThrow(
      'unknown parameter',
    );
    definition.getLaunchForm = async () => ({
      inputSchema: { type: 'object', properties: {} },
      variants: [{ id: 'new', title: 'Create' }],
      variant: 'missing',
    });
    await expect(createProviderRuntime(definition).getLaunchForm({ values: {} })).rejects.toThrow(
      'invalid launch form',
    );
  });

  it('rejects null static forms and null variant overrides', () => {
    const definition = fixtureDefinition('null-form');
    definition.browserType.launchForm = null as any;
    expect(() => createProviderRuntime(definition)).toThrow('invalid launch form');
    for (const field of ['inputSchema', 'values', 'refreshOn', 'dynamicFields']) {
      definition.browserType.launchForm = {
        inputSchema: { type: 'object', properties: {} },
        variants: [{ id: 'new', title: 'Create', [field]: null }],
        variant: 'new',
      } as any;
      expect(() => createProviderRuntime(definition)).toThrow('invalid launch form');
    }
  });

  it('dispatches downloads declared by the Provider', async () => {
    const handleAction = vi.fn(async () => ({
      filename: 'report.txt',
      filePath: '/tmp/report.txt',
      action: {},
    }));
    const runtime = createProviderRuntime(fixtureDefinition('download-fixture', { handleAction }));
    runtime.updateBrowsers([
      {
        browserId: 'download',
        name: 'Download browser',
        status: 'connected',
        control: {
          kind: 'provider',
          capabilities: { actions: ['page_download'], screenshot: 'none' },
        },
        persistence: 'ephemeral',
        operations: ['close'],
      },
    ]);
    const context = {
      browserId: 'download',
      action: 'page_download' as const,
      data: { tabId: 7, trigger: { text: 'Download' } },
    };
    await expect(runtime.invokeAction(context)).resolves.toMatchObject({
      filePath: '/tmp/report.txt',
    });
    expect(handleAction).toHaveBeenCalledWith(context);
  });
  it('validates mutually exclusive launch forms before calling a Provider', () => {
    const schema = {
      type: 'object',
      properties: {},
      additionalProperties: true,
      oneOf: [
        {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
          additionalProperties: true,
          not: {
            type: 'object',
            properties: { sessionId: { type: 'string' } },
            required: ['sessionId'],
            additionalProperties: true,
          },
        },
        {
          type: 'object',
          required: ['sessionId'],
          properties: { name: { type: 'string' }, sessionId: { type: 'string' } },
        },
      ],
    } as const;
    expect(() => validateProviderInput(schema, { name: 'new' })).not.toThrow();
    expect(() =>
      validateProviderInput(schema, { name: 'alias', sessionId: 'existing' }),
    ).not.toThrow();
    expect(() => validateProviderInput(schema, {})).toThrow('exactly one');
    expect(() =>
      validateProviderInput(schema, { sessionId: 'existing', persistent: true }),
    ).toThrow('exactly one');
    expect(() =>
      validateProviderInput(
        { ...schema, oneOf: [schema.oneOf[1], schema.oneOf[1]] },
        { sessionId: 'existing' },
      ),
    ).toThrow('exactly one');
  });

  it('accepts supported form presentation metadata on compatible schema values', () => {
    const cookieSchema = {
      type: 'object' as const,
      component: 'cookie-sync' as const,
      properties: {
        presets: { type: 'array' as const, items: { type: 'string' as const } },
        domains: { type: 'array' as const, items: { type: 'string' as const } },
      },
    };
    expect(() =>
      createProviderRuntime({
        ...fixtureDefinition(uniqueId('component')),
        browserType: {
          name: 'Fixture',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', formWidth: 'half', formHideOptional: true },
              copyCookieDomains: cookieSchema,
              persistent: {
                type: 'boolean',
                component: 'switch',
                default: false,
                formDefault: true,
                formVisibleWhen: { field: 'sessionId', empty: true },
              },
              advanced: { type: 'string', formHidden: true },
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      createProviderRuntime({
        ...fixtureDefinition(uniqueId('invalid-component')),
        browserType: {
          name: 'Fixture',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string', component: 'cookie-sync' } },
          } as any,
        },
      }),
    ).toThrow('Provider input schema is invalid');
    expect(() =>
      createProviderRuntime({
        ...fixtureDefinition(uniqueId('invalid-switch')),
        browserType: {
          name: 'Fixture',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string', component: 'switch' } },
          } as any,
        },
      }),
    ).toThrow('Provider input schema is invalid');
    expect(() =>
      createProviderRuntime({
        ...fixtureDefinition(uniqueId('invalid-visibility')),
        browserType: {
          name: 'Fixture',
          inputSchema: {
            type: 'object',
            properties: {
              persistent: {
                type: 'boolean',
                formVisibleWhen: { field: 'missing', empty: true },
              },
            },
          } as any,
        },
      }),
    ).toThrow('Provider input schema is invalid');
  });

  it('keeps Provider browser id separators readable without losing escaping', () => {
    expect(providerBrowserKey('example-cloud', 'managed:example-cloud:cloud main')).toBe(
      'provider:example-cloud:cloud%20main',
    );
    expect(providerBrowserKey('example-cloud', 'session:s-123')).toBe(
      'provider:example-cloud:session:s-123',
    );
  });

  it('configures a Provider over its socket without selecting a browser', async () => {
    const configure = vi.fn(async () => ({ configured: true }));
    const server = createProviderServer({
      definition: fixtureDefinition(uniqueId('config'), {
        browserType: {
          name: 'Fixture',
          inputSchema: { type: 'object', properties: {} },
          configuration: {
            inputSchema: {
              type: 'object',
              required: ['token'],
              properties: { token: { type: 'string', secret: true, minLength: 1 } },
            },
          },
        },
        configure,
      }),
    });
    activeServers.push(server);
    await server.start();
    const result = await request(server.socketPath, {
      id: 'config',
      action: 'browser_providers',
      data: { operation: 'configure', options: { token: 'test-secret' } },
    });
    expect(result.success).toBe(true);
    expect(configure).toHaveBeenCalledWith({ token: 'test-secret' }, expect.anything());
    expect(JSON.stringify(result)).not.toContain('test-secret');
    const invalid = await request(server.socketPath, {
      id: 'invalid',
      action: 'browser_providers',
      data: { operation: 'configure', options: { token: 1 } },
    });
    expect(invalid.success).toBe(false);
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('exposes serialized host launch data through ProviderContext', async () => {
    const providerId = uniqueId('host-context');
    const launch = vi.fn(async (options: Record<string, any>, context: any) => {
      expect(await context.host.request('export_cookies')).toEqual([{ name: 'sid', value: 'x' }]);
      expect(await context.host.request('get_browser_user_agent')).toBe('Fixture/1.0');
      return fixtureDefinition(providerId).launch(options, context);
    });
    const server = createProviderServer({
      definition: fixtureDefinition(providerId, { launch }),
    });
    activeServers.push(server);
    await server.start();

    await expect(
      request(server.socketPath, {
        id: 'host-context',
        action: 'browser_launch',
        data: { code: 'device-a' },
        host: {
          cookies: [{ name: 'sid', value: 'x' }],
          userAgent: 'Fixture/1.0',
        },
      }),
    ).resolves.toMatchObject({ success: true, data: { browserId: 'device-a' } });
    expect(launch).toHaveBeenCalledOnce();

    await expect(
      request(server.socketPath, {
        id: 'invalid-host-context',
        action: 'browser_launch',
        data: { code: 'device-b' },
        host: { cookies: 'secret' },
      }),
    ).resolves.toEqual({
      id: 'invalid-host-context',
      success: false,
      error: 'Invalid request envelope',
    });
    expect(launch).toHaveBeenCalledOnce();
  });

  it('registers a provider from its package metadata', () => {
    const providerId = uniqueId('manifest');
    const packageRoot = mkdtempSync(join(tmpdir(), 'mearl-provider-package-'));
    temporaryDirectories.push(packageRoot);
    writeFileSync(join(packageRoot, 'runtime.js'), 'export {};\n');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@example/mearl-provider-fixture',
        version: '1.0.0',
        mearl: {
          provider: {
            providerId,
            name: 'Fixture provider',
            protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
            entry: './runtime.js',
            extensionAgentDefault: { macBundleIds: ['com.example.fixture'] },
            browserType: {
              name: 'Fixture browser',
              inputSchema: {
                type: 'object',
                properties: {
                  code: {
                    type: 'string',
                    title: 'Pairing code',
                    placeholder: 'Generated by default',
                  },
                  copyCookieDomains: {
                    type: 'object',
                    component: 'cookie-sync',
                    properties: {
                      presets: { type: 'array', items: { type: 'string' } },
                      domains: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    installedIds.push(providerId);
    const manifest = registerProviderPackage(packageRoot);
    expect(
      validateInstalledProviderManifest({
        ...manifest,
        extensionAgentDefault: { macBundleIds: ['*'] },
      }),
    ).toBe('extensionAgentDefault is invalid');

    expect(listInstalledProviders()).toContainEqual(
      expect.objectContaining({
        providerId,
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        extensionAgentDefault: { macBundleIds: ['com.example.fixture'] },
        browserType: {
          name: 'Fixture browser',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                title: 'Pairing code',
                placeholder: 'Generated by default',
              },
              copyCookieDomains: {
                type: 'object',
                component: 'cookie-sync',
                properties: {
                  presets: { type: 'array', items: { type: 'string' } },
                  domains: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        packageName: '@example/mearl-provider-fixture',
        packageRoot,
        entryPath: join(packageRoot, 'runtime.js'),
      }),
    );
  });

  it('keeps built-in Provider ids out of the external registry', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'mearl-provider-package-'));
    temporaryDirectories.push(packageRoot);
    writeFileSync(join(packageRoot, 'runtime.js'), 'export {};\n');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@example/mearl-provider-local',
        version: '1.0.0',
        mearl: {
          provider: {
            providerId: 'local',
            name: 'Conflicting local Provider',
            protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
            entry: './runtime.js',
            browserType: {
              name: 'Local',
              inputSchema: { type: 'object', properties: {} },
            },
          },
        },
      }),
    );

    expect(() => registerProviderPackage(packageRoot)).toThrow(
      'providerId local is reserved for a built-in Provider',
    );
  });

  it('publishes browsers and dispatches actions through one provider socket', async () => {
    const providerId = uniqueId('server');
    const directory = mkdtempSync(join(tmpdir(), 'mearl-provider-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'provider.sock');
    const server = createProviderServer({
      socketPath,
      definition: fixtureDefinition(providerId, {
        handleAction: async context => context,
        syncCookies: async ({ browserId, scope }) => ({ browserId, scope }),
        launch: async options => {
          if (options.code === 'missing-pairing') {
            return {
              browserId: options.code,
              name: 'Fixture device',
              status: 'pairing',
              control: {
                kind: 'provider',
                capabilities: { actions: [], screenshot: 'none' },
              },
              persistence: 'persistent',
              operations: ['close'],
            } as any;
          }
          return fixtureDefinition(providerId).launch(options, {});
        },
      }),
    });
    activeServers.push(server);

    await server.start();
    server.updateBrowsers([
      {
        browserId: 'device-1',
        name: 'Fixture device',
        status: 'connected',
        control: {
          kind: 'provider',
          capabilities: { actions: ['page_eval'], screenshot: 'none' },
        },
        persistence: 'ephemeral',
        operations: ['close', 'syncCookies'],
      },
      {
        browserId: 'device-pairing',
        name: 'Pair a device',
        status: 'pairing',
        control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
        persistence: 'persistent',
        operations: ['close'],
        pairing: { kind: 'qr', url: 'https://example.test/pair', code: 'pair-code' },
      },
    ]);

    const response = await request(socketPath, {
      id: 'request-1',
      action: 'page_eval',
      browserId: 'device-1',
      data: { expression: '1 + 1' },
    });
    expect(response).toEqual({
      id: 'request-1',
      success: true,
      data: {
        browserId: 'device-1',
        action: 'page_eval',
        data: { expression: '1 + 1' },
      },
    });

    server.updateBrowsers([
      {
        browserId: 'device-1',
        name: 'Fixture device',
        status: 'connected',
        control: {
          kind: 'provider',
          capabilities: { actions: ['page_eval'], screenshot: 'none' },
        },
        persistence: 'ephemeral',
        operations: ['close', 'syncCookies'],
        lastFocusedAt: 1,
      },
      {
        browserId: 'device-pairing',
        name: 'Pair a device',
        status: 'pairing',
        control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
        persistence: 'persistent',
        operations: ['close'],
        pairing: { kind: 'qr', url: 'https://example.test/pair', code: 'pair-code' },
      },
    ]);
    expect(
      listProviderBrowserRecords().find(
        record => record.browserId === `provider:${providerId}:device-1`,
      )?.lastFocusedAt,
    ).toBeGreaterThan(1);

    await expect(request(socketPath, { id: 'request-2', action: 'browser_list' })).resolves.toEqual(
      {
        id: 'request-2',
        success: false,
        error: 'Unsupported provider action: browser_list',
      },
    );

    await expect(request(socketPath, null)).resolves.toEqual({
      id: '',
      success: false,
      error: 'Invalid request envelope',
    });

    await expect(
      request(socketPath, {
        id: 'request-launch',
        action: 'browser_launch',
        data: { code: 'pair-code' },
      }),
    ).resolves.toEqual({
      id: 'request-launch',
      success: true,
      data: {
        browserId: 'pair-code',
        name: 'Fixture device',
        status: 'pairing',
        control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
        persistence: 'persistent',
        operations: ['close'],
        pairing: {
          kind: 'qr',
          url: 'https://example.test/pair?id=pair-code',
          code: 'pair-code',
        },
      },
    });

    await expect(
      request(socketPath, {
        id: 'request-invalid-launch',
        action: 'browser_launch',
      }),
    ).resolves.toEqual({
      id: 'request-invalid-launch',
      success: false,
      error: 'options.code is required',
    });

    await expect(
      request(socketPath, {
        id: 'request-launch-without-pairing',
        action: 'browser_launch',
        data: { code: 'missing-pairing' },
      }),
    ).resolves.toEqual({
      id: 'request-launch-without-pairing',
      success: false,
      error: 'Pairing browser missing-pairing needs a pairing URL',
    });

    await expect(
      request(socketPath, {
        id: 'request-sync',
        action: 'browser_sync_cookies',
        browserId: 'device-1',
        data: { scope: { domains: ['example.com'] } },
      }),
    ).resolves.toEqual({
      id: 'request-sync',
      success: false,
      error: 'Unsupported provider action: browser_sync_cookies',
    });

    await expect(
      request(socketPath, {
        id: 'request-close',
        action: 'browser_close',
        browserId: 'device-pairing',
      }),
    ).resolves.toEqual({
      id: 'request-close',
      success: true,
      data: { deleted: 'device-pairing' },
    });

    await expect(
      request(socketPath, {
        id: 'request-versions',
        action: 'get_versions',
        browserId: 'device-1',
      }),
    ).resolves.toEqual({
      id: 'request-versions',
      success: true,
      data: {
        provider: {
          id: providerId,
          name: 'Fixture provider',
          builtin: false,
          version: '1.0.0',
          protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        },
        capabilities: { actions: ['page_eval'], screenshot: 'none' },
      },
    });

    await expect(
      request(socketPath, {
        id: 'request-3',
        action: 'page_click',
        browserId: 'device-1',
      }),
    ).resolves.toEqual({
      id: 'request-3',
      success: false,
      error: 'Provider browser device-1 does not support page_click',
    });

    await expect(
      request(socketPath, {
        id: 'request-4',
        action: 'page_eval',
        browserId: 'device-pairing',
      }),
    ).resolves.toEqual({
      id: 'request-4',
      success: false,
      error: 'Provider browser device-pairing is not connected',
    });

    await server.stop();
    activeServers.splice(activeServers.indexOf(server), 1);
  });

  it('enforces provider lifecycle and protocol invariants', async () => {
    const providerId = uniqueId('lifecycle');
    const directory = mkdtempSync(join(tmpdir(), 'mearl-provider-'));
    temporaryDirectories.push(directory);
    const server = createProviderServer({
      definition: fixtureDefinition(providerId, { handleAction: async () => ({}) }),
      socketPath: join(directory, 'provider.sock'),
    });
    activeServers.push(server);

    expect(() => server.updateBrowsers([])).toThrow('Provider server is not running');
    await server.start();
    await expect(server.start()).rejects.toThrow('already running');
    expect(() =>
      server.updateBrowsers([
        {
          browserId: 'invalid-capabilities',
          name: 'Invalid capabilities',
          status: 'connected',
          control: {
            kind: 'provider',
            capabilities: { actions: ['page_screenshot'], screenshot: 'none' },
          },
          persistence: 'ephemeral',
          operations: ['close'],
        },
      ]),
    ).toThrow('inconsistent screenshot capabilities');
    expect(() =>
      server.updateBrowsers([
        {
          browserId: 'missing-operation-handler',
          name: 'Missing operation handler',
          status: 'connected',
          control: {
            kind: 'provider',
            capabilities: { actions: [], screenshot: 'none' },
          },
          persistence: 'ephemeral',
          operations: ['close', 'syncCookies'],
        },
      ]),
    ).toThrow('advertises syncCookies without implementing it');
    await server.stop();
    expect(() => server.updateBrowsers([])).toThrow('Provider server is not running');
  });

  it('validates structured options and dispatches lifecycle operations in process', async () => {
    const stopped = {
      browserId: 'managed-1',
      name: 'Managed browser',
      status: 'stopped' as const,
      control: { kind: 'none' as const },
      persistence: 'persistent' as const,
      operations: ['start', 'deleteData'] as const,
    };
    const active = {
      ...stopped,
      status: 'connected' as const,
      control: {
        kind: 'provider' as const,
        capabilities: { actions: ['page_eval' as const], screenshot: 'none' as const },
      },
      operations: ['close', 'deleteData', 'syncCookies'] as const,
    };
    const runtime = createProviderRuntime({
      descriptor: {
        providerId: uniqueId('runtime'),
        name: 'Managed fixture',
        version: '1.0.0',
      },
      browserType: {
        name: 'Managed fixture',
        inputSchema: {
          type: 'object',
          required: ['persistent', 'cookieScope'],
          properties: {
            persistent: { type: 'boolean' },
            cookieScope: {
              type: 'object',
              required: ['domains'],
              properties: {
                domains: { type: 'array', items: { type: 'string' }, minItems: 1 },
              },
            },
          },
        },
      },
      launch: async () => active,
      start: async () => active,
      close: async ({ deleteData }) => ({ deleteData }),
      syncCookies: async ({ browserId, scope }) => ({ browserId, scope }),
      handleAction: async ({ action }) => ({ action }),
    });
    runtime.updateBrowsers([stopped]);

    await expect(
      runtime.launch({ persistent: true, cookieScope: { domains: ['example.com'] } }),
    ).resolves.toEqual(active);
    await expect(
      runtime.launch({ persistent: 'yes', cookieScope: { domains: [] } }),
    ).rejects.toThrow('persistent must be a boolean');
    await expect(runtime.start({ browserId: 'managed-1' })).resolves.toEqual(active);
    runtime.updateBrowsers([active]);
    await expect(
      runtime.syncCookies({ browserId: 'managed-1', scope: { domains: ['example.com'] } }),
    ).resolves.toEqual({ browserId: 'managed-1', scope: { domains: ['example.com'] } });
    runtime.updateBrowsers([stopped]);
    await expect(runtime.close({ browserId: 'managed-1' })).rejects.toThrow(
      'does not support close',
    );
    await expect(runtime.close({ browserId: 'managed-1', deleteData: true })).resolves.toEqual({
      deleteData: true,
    });
  });

  it('rejects an incompatible provider protocol before binding a socket', () => {
    const providerId = uniqueId('protocol');
    const directory = mkdtempSync(join(tmpdir(), 'mearl-provider-'));
    temporaryDirectories.push(directory);
    expect(() =>
      createProviderServer({
        definition: fixtureDefinition(providerId, {
          descriptor: {
            providerId,
            name: 'Fixture provider',
            version: '1.0.0',
            protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION + 1,
          },
        }),
        socketPath: join(directory, 'provider.sock'),
      }),
    ).toThrow('Unsupported provider protocol');
  });
  it('dispatches instance management over the socket and wraps access results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-provider-'));
    temporaryDirectories.push(directory);
    const browser = {
      browserId: 'existing-device',
      name: 'Device',
      status: 'stopped' as const,
      control: { kind: 'none' as const },
      persistence: 'persistent' as const,
      operations: ['start' as const],
    };
    const active = {
      ...browser,
      status: 'connected' as const,
      control: {
        kind: 'provider' as const,
        capabilities: { actions: [], screenshot: 'none' as const },
      },
      operations: ['close' as const, 'syncCookies' as const, 'access' as const, 'detach' as const],
    };
    const access = {
      kind: 'fixture',
      url: 'https://example.test/access',
      sensitive: true as const,
    };
    const launch = vi.fn();
    const start = vi.fn(async () => active);
    const syncCookies = vi.fn(async () => ({ synced: true }));
    const detach = vi.fn(async () => ({ detached: true }));
    const server = createProviderServer({
      socketPath: join(directory, 'provider.sock'),
      definition: fixtureDefinition(uniqueId('lifecycle'), {
        launch,
        start,
        syncCookies,
        detach,
        getAccess: async () => access,
      }),
    });
    activeServers.push(server);
    await server.start();
    server.updateBrowsers([browser]);
    const invoke = (action: string, data = {}) =>
      request(server.socketPath, {
        id: 'lifecycle',
        browserId: browser.browserId,
        action,
        data,
        controlSource: 'local',
      });
    await expect(invoke('browser_instances', { operation: 'start' })).resolves.toMatchObject({
      success: true,
      data: active,
    });
    expect(start).toHaveBeenCalledWith(
      { browserId: browser.browserId },
      { controlSource: 'local' },
    );
    expect(launch).not.toHaveBeenCalled();
    await expect(
      invoke('browser_instances', { operation: 'sync_cookies', scope: {} }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('does not support syncCookies'),
    });
    server.updateBrowsers([active]);
    await expect(
      invoke('browser_instances', {
        operation: 'sync_cookies',
        scope: { domains: ['example.test'] },
      }),
    ).resolves.toMatchObject({ success: true, data: { synced: true } });
    expect(syncCookies).toHaveBeenCalledWith(
      {
        browserId: browser.browserId,
        scope: { domains: ['example.test'] },
      },
      { controlSource: 'local' },
    );
    await expect(
      invoke('browser_instances', { operation: 'sync_cookies', scope: [] }),
    ).resolves.toMatchObject({
      success: false,
      error: 'Cookie sync scope must be a JSON object',
    });
    await expect(invoke('get_browser_access_url')).resolves.toMatchObject({
      success: true,
      data: { browserAccess: access },
    });
    await expect(invoke('browser_instances', { operation: 'detach' })).resolves.toMatchObject({
      success: true,
      data: { detached: true },
    });
    expect(detach).toHaveBeenCalledWith(
      { browserId: browser.browserId },
      { controlSource: 'local' },
    );
  });

  it.each([
    ['missing control', { control: undefined }],
    ['unknown control', { control: { kind: 'invalid' } }],
    [
      'invalid host transport',
      { control: { kind: 'host', browserId: 'host', transport: 'provider' } },
    ],
    ['invalid host id', { control: { kind: 'host', browserId: 123, transport: 'cdp' } }],
    [
      'invalid screenshot',
      {
        control: {
          kind: 'provider',
          capabilities: { actions: ['page_screenshot'], screenshot: 'invalid' },
        },
      },
    ],
    [
      'invalid pairing code',
      { status: 'pairing', pairing: { kind: 'qr', url: 'https://example.test', code: {} } },
    ],
    [
      'invalid pairing label',
      { status: 'pairing', pairing: { kind: 'qr', url: 'https://example.test', label: {} } },
    ],
    ['invalid ownership', { ownership: 'invalid' }],
    ['negative focus time', { lastFocusedAt: -1 }],
    ['invalid references', { references: [{ kind: 'session', id: 123 }] }],
    ['invalid details', { details: { value: NaN } }],
    ['invalid headless', { details: { headless: 'yes' } }],
    ['invalid creation date', { details: { createdAt: 'yesterday' } }],
    ['invalid port', { details: { cdpPort: 70000 } }],
    ['invalid cookie count', { details: { copiedCookies: { count: -1, domains: [] } } }],
  ])('rejects %s before publishing a browser', (_name, overrides) => {
    expect(() =>
      validateProviderBrowser({
        browserId: 'fixture',
        name: 'Fixture',
        status: 'connected',
        control: { kind: 'provider', capabilities: { actions: [], screenshot: 'none' } },
        persistence: 'persistent',
        operations: ['close'],
        ...overrides,
      } as any),
    ).toThrow();
  });
});
