import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeLocal, loadLocalConnectorId, resolveLocalActionTarget } = vi.hoisted(() => ({
  invokeLocal: vi.fn(),
  resolveLocalActionTarget: vi.fn(),
  loadLocalConnectorId: vi.fn<() => string | null>(() => null),
}));

vi.mock('../socket.js', () => ({
  invoke: invokeLocal,
  resolveLocalActionTarget,
}));

vi.mock('../unifiedConfig.js', () => ({
  loadCloudServerConfig: vi.fn(() => null),
  loadLocalConnectorId,
}));

import { UnifiedClient, decodeBrowserTarget } from '../unified.js';

const CONNECTOR = {
  connectorId: 'node-a',
  name: 'work-mac',
  connectedAt: '2026-01-01T00:00:00.000Z',
  lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
  pendingRequests: 0,
};

function createConnectedClient() {
  const client = new UnifiedClient({ serverUrl: 'ws://127.0.0.1:8081/ws' });
  const send = vi.fn();
  (client as any).ws = { readyState: 1, send, close: vi.fn() };
  return { client, send };
}

function messageAt(send: ReturnType<typeof vi.fn>, index: number): Record<string, any> {
  return JSON.parse(send.mock.calls[index]![0]);
}

function respond(
  client: UnifiedClient,
  send: ReturnType<typeof vi.fn>,
  index: number,
  data: any,
  success = true,
): void {
  const message = messageAt(send, index);
  (client as any).handleResponse({
    id: message.id,
    success,
    ...(success ? { data } : { error: String(data) }),
  });
}

beforeEach(() => {
  vi.stubEnv('MEARL_BROWSER', '');
  invokeLocal.mockReset();
  resolveLocalActionTarget.mockReset().mockReturnValue(undefined);
  loadLocalConnectorId.mockReset();
  loadLocalConnectorId.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('preserves explicit local Provider discovery and rejects ambiguous sources before dispatch', async () => {
  const client = new UnifiedClient();
  const params = { provider: 'ego', launchForm: { variant: 'attach', values: { name: 'kept' } } };
  for (const options of [{}, { connector: 'remote' }, { local: true, session: 'existing' }]) {
    await expect(client.invoke('browser_list', params, options)).rejects.toThrow(
      'explicit --local',
    );
  }
  expect(invokeLocal).not.toHaveBeenCalled();
  const discovery = {
    provider: 'ego',
    launchForm: { inputSchema: { type: 'object', properties: {} } },
  };
  invokeLocal.mockResolvedValueOnce({ browsers: [], discovery });
  expect(await client.invoke('browser_list', params, { local: true })).toMatchObject({ discovery });
  expect(invokeLocal).toHaveBeenCalledWith(
    'browser_list',
    params,
    expect.objectContaining({ controlSource: 'local' }),
  );
  invokeLocal.mockResolvedValueOnce({ browsers: [] });
  await expect(client.invoke('browser_list', params, { local: true })).rejects.toThrow(
    'not supported',
  );
});

describe('global browser ids', () => {
  it('decodes readable browser id separators and legacy encoded separators', () => {
    expect(decodeBrowserTarget('mearl:local:managed:account-a')).toEqual({
      browser: 'managed:account-a',
    });
    expect(decodeBrowserTarget('mearl:local:managed%3Aaccount-a')).toEqual({
      browser: 'managed:account-a',
    });
    expect(decodeBrowserTarget('mearl:remote:node%3Aa:managed:example-cloud:cloud-a')).toEqual({
      connector: 'node:a',
      browser: 'managed:example-cloud:cloud-a',
    });
    expect(decodeBrowserTarget('mearl:remote:node%3Aa:managed%3Aexample-cloud%3Acloud-a')).toEqual({
      connector: 'node:a',
      browser: 'managed:example-cloud:cloud-a',
    });
  });
});

describe('UnifiedClient browser routing', () => {
  it('rejects required page targets before browser routing', async () => {
    const client = new UnifiedClient();

    await expect(client.invoke('page_click', { selector: '#submit' })).rejects.toThrow(
      'page_click requires a numeric tabId. Call tab_open or tab_list to obtain a tabId.',
    );
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('keeps Provider pairing metadata on the global browser_launch response', async () => {
    invokeLocal.mockResolvedValue({
      browserId: 'provider:example-device:pairing_fixture',
      name: '真机',
      status: 'pairing',
      pairing: {
        kind: 'qr',
        url: 'https://example.test/pair?id=pairing_fixture',
        code: 'pairing_fixture',
      },
    });
    const client = new UnifiedClient();

    await expect(
      client.invoke('browser_launch', { provider: 'example-device', providerOptions: {} }),
    ).resolves.toEqual({
      browserId: 'mearl:local:provider:example-device:pairing_fixture',
      originalBrowserId: 'provider:example-device:pairing_fixture',
      originalName: '真机',
      name: '[this machine] 真机',
      status: 'pairing',
      pairing: {
        kind: 'qr',
        url: 'https://example.test/pair?id=pairing_fixture',
        code: 'pairing_fixture',
      },
      source: { kind: 'local' },
    });
  });

  it('uses global ids even when only browsers on this machine are available', async () => {
    invokeLocal.mockResolvedValue({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'managed:account-a',
      warnings: ['provider fixture: did not become ready'],
      browsers: [
        {
          browserId: 'managed:account-a',
          name: 'account-a',
          status: 'connected',
          type: 'managed',
          transport: 'cdp',
        },
      ],
    });
    const client = new UnifiedClient();

    await expect(client.invoke('browser_list')).resolves.toMatchObject({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'mearl:local:managed:account-a',
      warnings: ['provider fixture: did not become ready'],
      browsers: [
        {
          browserId: 'mearl:local:managed:account-a',
          originalBrowserId: 'managed:account-a',
          name: '[this machine] account-a',
          source: { kind: 'local' },
        },
      ],
    });
  });

  it('selects a browser with a legacy encoded global id', async () => {
    invokeLocal.mockResolvedValue({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'managed:account-a',
      browsers: [
        {
          browserId: 'managed:account-a',
          name: 'account-a',
          status: 'connected',
          type: 'managed',
        },
      ],
    });
    const client = new UnifiedClient();

    await expect(
      client.invoke('browser_select_browser', {
        browser: 'mearl:local:managed%3Aaccount-a',
      }),
    ).resolves.toEqual({
      selected: {
        browserId: 'mearl:local:managed:account-a',
        name: '[this machine] account-a',
      },
    });
  });

  it('lists this machine and every connector, then routes the returned ids', async () => {
    invokeLocal.mockImplementation(async action => {
      if (action === 'browser_list') {
        return {
          count: 1,
          connectedCount: 1,
          defaultBrowserId: 'local-chrome',
          browsers: [
            {
              browserId: 'local-chrome',
              name: 'Chrome',
              status: 'connected',
              type: 'regular',
            },
          ],
        };
      }
      return [{ source: 'local' }];
    });
    const { client, send } = createConnectedClient();
    const listPromise = client.invoke('browser_list');

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(messageAt(send, 0).action).toBe('connector_list');
    respond(client, send, 0, { count: 1, connectors: [CONNECTOR] });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(messageAt(send, 1)).toMatchObject({
      action: 'browser_list',
      connector: 'node-a',
    });
    respond(client, send, 1, {
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'example-cloud:session-a',
      browsers: [
        {
          browserId: 'example-cloud:session-a',
          name: 'cloud-browser',
          status: 'connected',
          type: 'managed',
          provider: { id: 'example-cloud', name: 'Example Cloud', builtin: false },
          ownership: 'owned',
          persistence: 'ephemeral',
          operations: ['close'],
          providerAccessUrl: 'https://provider.example/access?ticket=stale',
        },
      ],
    });

    const listing = await listPromise;
    expect(listing).toMatchObject({ count: 2, connectedCount: 2, defaultBrowserId: null });
    expect(listing.browsers.map((browser: any) => browser.browserId)).toEqual([
      'mearl:local:local-chrome',
      'mearl:remote:node-a:example-cloud:session-a',
    ]);
    expect(listing.browsers[1]).toMatchObject({
      name: '[work-mac] cloud-browser',
      provider: { id: 'example-cloud', name: 'Example Cloud', builtin: false },
      source: { kind: 'remote', connectorId: 'node-a', connectorName: 'work-mac' },
    });
    expect(listing.browsers[1]).not.toHaveProperty('providerAccessUrl');

    await expect(
      client.invoke('get_logs', { tabId: 7 }, { browser: listing.browsers[0].browserId }),
    ).resolves.toEqual([{ source: 'local' }]);
    expect(invokeLocal).toHaveBeenLastCalledWith(
      'get_logs',
      { tabId: 7 },
      expect.objectContaining({ browser: 'local-chrome', controlSource: 'local' }),
    );

    const remotePromise = client.invoke(
      'get_logs',
      { tabId: 7 },
      { browser: listing.browsers[1].browserId },
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(messageAt(send, 2)).toMatchObject({
      action: 'get_logs',
      data: { tabId: 7 },
      browser: 'example-cloud:session-a',
      connector: 'node-a',
    });
    respond(client, send, 2, [{ source: 'remote' }]);
    await expect(remotePromise).resolves.toEqual([{ source: 'remote' }]);
  });

  it('keeps external Provider launch and close on the selected browser host', async () => {
    invokeLocal.mockResolvedValue({ count: 0, connectedCount: 0, browsers: [] });
    const { client, send } = createConnectedClient();
    const launchPromise = client.invoke(
      'browser_launch',
      {
        provider: 'example-cloud',
        providerOptions: { name: 'cloud-browser' },
      },
      { connector: 'work-mac' },
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    respond(client, send, 0, { count: 1, connectors: [CONNECTOR] });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(messageAt(send, 1)).toMatchObject({
      action: 'browser_launch',
      connector: 'node-a',
      data: {
        provider: 'example-cloud',
        providerOptions: { name: 'cloud-browser' },
      },
    });
    respond(client, send, 1, {
      browserId: 'example-cloud:session-a',
      name: 'cloud-browser',
      provider: { id: 'example-cloud', name: 'Example Cloud', builtin: false },
      ownership: 'owned',
      persistence: 'ephemeral',
      operations: ['close'],
    });

    const launched = await launchPromise;
    expect(launched).toMatchObject({
      browserId: 'mearl:remote:node-a:example-cloud:session-a',
      originalBrowserId: 'example-cloud:session-a',
      provider: { id: 'example-cloud', name: 'Example Cloud', builtin: false },
      source: { kind: 'remote', connectorId: 'node-a', connectorName: 'work-mac' },
    });

    const closePromise = client.invoke('browser_close', { browser: launched.browserId });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(messageAt(send, 2)).toMatchObject({
      action: 'browser_close',
      connector: 'node-a',
      data: { browser: 'example-cloud:session-a' },
    });
    respond(client, send, 2, { closed: true });
    await expect(closePromise).resolves.toEqual({ closed: true });
  });

  it('uses MEARL_BROWSER while resolving targets across local and remote sources', async () => {
    vi.stubEnv('MEARL_BROWSER', 'cloud-browser');
    invokeLocal.mockResolvedValue({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'local-chrome',
      browsers: [{ browserId: 'local-chrome', name: 'Chrome', status: 'connected' }],
    });
    const { client, send } = createConnectedClient();
    const logsPromise = client.invoke('get_logs', { tabId: 7 });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    respond(client, send, 0, { count: 1, connectors: [CONNECTOR] });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    respond(client, send, 1, {
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'remote-chrome',
      browsers: [{ browserId: 'remote-chrome', name: 'cloud-browser', status: 'connected' }],
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(messageAt(send, 2)).toMatchObject({
      action: 'get_logs',
      data: { tabId: 7 },
      browser: 'remote-chrome',
      connector: 'node-a',
    });
    respond(client, send, 2, [{ source: 'remote' }]);

    await expect(logsPromise).resolves.toEqual([{ source: 'remote' }]);
  });

  it('selects an attached local CDP browser with the ordinary browser selector', async () => {
    invokeLocal.mockResolvedValue({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'local-chrome',
      browsers: [
        { browserId: 'local-chrome', name: 'Chrome', status: 'connected', transport: 'cdp' },
      ],
    });
    const { client, send } = createConnectedClient();

    await expect(
      client.invoke('browser_select_browser', { browser: 'Chrome' }, { local: true }),
    ).resolves.toMatchObject({
      selected: { browserId: 'mearl:local:local-chrome' },
    });
    expect(invokeLocal).toHaveBeenCalledWith(
      'browser_list',
      {},
      expect.objectContaining({ timeoutSec: expect.any(Number), controlSource: 'local' }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('does not list the current machine twice when its connector is also online', async () => {
    loadLocalConnectorId.mockReturnValue('node-a');
    invokeLocal.mockResolvedValue({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'extension-a',
      browsers: [
        { browserId: 'extension-a', name: 'Chrome', status: 'connected', type: 'regular' },
      ],
    });
    const { client, send } = createConnectedClient();
    const listPromise = client.invoke('browser_list');

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    respond(client, send, 0, { count: 1, connectors: [CONNECTOR] });

    await expect(listPromise).resolves.toMatchObject({
      count: 1,
      browsers: [{ browserId: 'mearl:local:extension-a' }],
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns healthy sources with warnings when one connector fails', async () => {
    invokeLocal.mockResolvedValue({ count: 0, connectedCount: 0, browsers: [] });
    const { client, send } = createConnectedClient();
    const listPromise = client.invoke('browser_list');
    const secondConnector = { ...CONNECTOR, connectorId: 'node-b', name: 'broken-node' };

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    respond(client, send, 0, { count: 2, connectors: [CONNECTOR, secondConnector] });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    respond(client, send, 1, {
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'remote-chrome',
      browsers: [
        { browserId: 'remote-chrome', name: 'Chrome', status: 'connected', type: 'regular' },
      ],
    });
    respond(client, send, 2, 'connector unavailable', false);

    await expect(listPromise).resolves.toMatchObject({
      count: 1,
      warnings: ['broken-node: connector unavailable'],
    });
  });
});

it('transmits large page_eval arguments with the same browser and frame on every request', async () => {
  const client = new UnifiedClient();
  const pageWindow = {};
  invokeLocal.mockImplementation(async (action, payload) => {
    expect(action).toBe('page_eval');
    return { result: new Function('window', `return ${payload.expression}`)(pageWindow) };
  });
  await expect(
    client.invoke(
      'page_eval',
      {
        tabId: 7,
        frameId: 'frame-a',
        expression: 'value => value.length',
        args: ['x'.repeat(100000)],
      },
      { browser: 'mearl:local:chrome' },
    ),
  ).resolves.toEqual({ result: 100000 });
  expect(invokeLocal.mock.calls.length).toBeGreaterThan(2);
  for (const [, payload, options] of invokeLocal.mock.calls) {
    expect(payload).toMatchObject({ tabId: 7, frameId: 'frame-a' });
    expect(payload).not.toHaveProperty('args');
    expect(options).toMatchObject({ browser: 'chrome' });
  }
  expect(pageWindow).toEqual({});
});

it('resolves an implicit browser once before transferring and cleans the same browser after defaults change', async () => {
  const client = new UnifiedClient();
  const pageWindow = {};
  let changed = false;
  invokeLocal.mockImplementation(async (action, payload, options) => {
    if (action === 'browser_list')
      return {
        defaultBrowserId: 'a',
        browsers: [
          { browserId: 'a', name: 'A', status: 'connected', transport: 'extension' },
          { browserId: 'b', name: 'B', status: 'connected', transport: 'extension' },
        ],
      };
    expect(action).toBe('page_eval');
    expect(options.browser).toBe('a');
    if (!changed) {
      changed = true;
      (client as any).defaultBrowser = 'mearl:local:b';
      (client as any).defaultConnector = 'other-connector';
    }
    return { result: new Function('window', `return ${payload.expression}`)(pageWindow) };
  });
  await expect(
    client.invoke(
      'page_eval',
      { tabId: 7, expression: 'value => value.length', args: ['x'.repeat(100000)] },
      { local: true },
    ),
  ).resolves.toEqual({ result: 100000 });
  expect(invokeLocal.mock.calls.filter(([action]) => action === 'browser_list')).toHaveLength(1);
  expect(pageWindow).toEqual({});
});

it('filters an unsupported Provider when choosing the implicit target for large arguments', async () => {
  const client = new UnifiedClient();
  const pageWindow = {};
  invokeLocal.mockImplementation(async (action, payload, options) => {
    if (action === 'browser_list')
      return {
        defaultBrowserId: 'provider:phone',
        browsers: [
          {
            browserId: 'provider:phone',
            name: 'Phone',
            status: 'connected',
            transport: 'provider',
            capabilities: { actions: ['page_screenshot'] },
          },
          { browserId: 'chrome', name: 'Chrome', status: 'connected', transport: 'extension' },
        ],
      };
    expect(options.browser).toBe('chrome');
    return { result: new Function('window', `return ${payload.expression}`)(pageWindow) };
  });
  await expect(
    client.invoke(
      'page_eval',
      { tabId: 7, expression: 'value => value.length', args: ['x'.repeat(100000)] },
      { local: true },
    ),
  ).resolves.toEqual({ result: 100000 });
  expect(pageWindow).toEqual({});
});

it('keeps an explicitly configured socket throughout argument transfer', async () => {
  vi.stubEnv('MEARL_SOCKET_PATH', '/tmp/page-eval-host.sock');
  resolveLocalActionTarget.mockReturnValue({ socketPath: '/tmp/page-eval-host.sock' });
  const client = new UnifiedClient();
  const pageWindow = {};
  invokeLocal.mockImplementation(async (action, payload, options) => {
    expect(action).toBe('page_eval');
    expect(options.socketPath).toBe('/tmp/page-eval-host.sock');
    expect(options).not.toHaveProperty('browser');
    (client as any).defaultBrowser = 'mearl:local:other';
    return { result: new Function('window', `return ${payload.expression}`)(pageWindow) };
  });
  await expect(
    client.invoke(
      'page_eval',
      { tabId: 7, expression: 'value => value.length', args: ['x'.repeat(100000)] },
      { local: true },
    ),
  ).resolves.toEqual({ result: 100000 });
  expect(pageWindow).toEqual({});
});

it('uses a supported Provider route without requiring capabilities in browser_list', async () => {
  const client = new UnifiedClient();
  resolveLocalActionTarget.mockReturnValue({ browser: 'provider:phone' });
  const pageWindow = {};
  invokeLocal.mockImplementation(async (action, payload, options) => {
    expect(action).toBe('page_eval');
    expect(options.browser).toBe('provider:phone');
    return { result: new Function('window', `return ${payload.expression}`)(pageWindow) };
  });
  await expect(
    client.invoke(
      'page_eval',
      { tabId: 7, expression: 'value => value.length', args: ['x'.repeat(100000)] },
      { local: true },
    ),
  ).resolves.toEqual({ result: 100000 });
  expect(resolveLocalActionTarget).toHaveBeenCalledOnce();
  expect(pageWindow).toEqual({});
});
it('pins the connector action-aware target before sending any argument chunks', async () => {
  const { client, send } = createConnectedClient();
  const pageWindow = {};
  send.mockImplementation((wire: string) => {
    const message = JSON.parse(wire);
    let data;
    if (message.action === 'connector_list') data = { connectors: [CONNECTOR] };
    else if (message.action === '__resolve_action_target') {
      expect(message).toMatchObject({ connector: 'node-a', data: { action: 'page_eval' } });
      data = { browser: 'provider:phone' };
    } else {
      expect(message).toMatchObject({
        action: 'page_eval',
        connector: 'node-a',
        browser: 'provider:phone',
      });
      data = { result: new Function('window', `return ${message.data.expression}`)(pageWindow) };
    }
    queueMicrotask(() => (client as any).handleResponse({ id: message.id, success: true, data }));
  });
  await expect(
    client.invoke(
      'page_eval',
      { tabId: 7, expression: 'value => value.length', args: ['x'.repeat(100000)] },
      { connector: 'work-mac' },
    ),
  ).resolves.toEqual({ result: 100000 });
  const requests = send.mock.calls.map(([wire]) => JSON.parse(wire));
  expect(requests.filter(request => request.action === '__resolve_action_target')).toHaveLength(1);
  expect(requests.some(request => request.action === 'browser_list')).toBe(false);
  expect(pageWindow).toEqual({});
  await client.disconnect();
});
