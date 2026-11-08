import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createConnectionMock, ensureProvidersMock, installedProviderIds, liveBrowsers, spawnMock } =
  vi.hoisted(() => ({
    createConnectionMock: vi.fn(),
    ensureProvidersMock: vi.fn(async () => []),
    spawnMock: vi.fn(),
    installedProviderIds: ['fixture'],
    liveBrowsers: [
      {
        pid: process.pid,
        browserId: 'provider:fixture:waiting',
        providerBrowserId: 'waiting',
        socketPath: '/tmp/mearl-provider-pairing.sock',
        browserName: 'Pair fixture device',
        transport: 'provider' as const,
        providerId: 'fixture',
        providerName: 'Fixture provider',
        providerVersion: '1.0.0',
        providerProtocolVersion: 1,
        capabilities: { actions: [], screenshot: 'none' as const },
        status: 'pairing' as const,
      },
      {
        pid: process.pid,
        browserId: 'provider:fixture:device-a',
        providerBrowserId: 'device-a',
        socketPath: '/tmp/mearl-provider-fixture.sock',
        browserName: 'Fixture device',
        transport: 'provider' as const,
        providerId: 'fixture',
        providerName: 'Fixture provider',
        providerVersion: '1.0.0',
        providerProtocolVersion: 1,
        capabilities: {
          actions: ['page_eval' as const, 'tab_list' as const],
          screenshot: 'none' as const,
        },
        operations: ['close' as const, 'detach' as const, 'access' as const],
        status: 'connected' as const,
      },
      {
        pid: process.pid,
        browserId: 'native-browser',
        socketPath: '/tmp/mearl-native-browser.sock',
        browserName: 'Native browser',
        transport: 'extension' as const,
        status: 'connected' as const,
      },
    ],
  }));

vi.mock('node:net', () => ({
  default: { createConnection: createConnectionMock },
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@mearl/provider/runtime', () => ({
  ensureInstalledProvidersRunning: ensureProvidersMock,
  readLiveProvider: vi.fn((providerId: string) =>
    providerId === 'fixture' ? { pid: process.pid, providerId } : null,
  ),
}));

vi.mock('@mearl/provider/host', async importOriginal => ({
  ...await importOriginal<typeof import('@mearl/provider/host')>(),
  listInstalledProviders: vi.fn(() => installedProviderIds.map(providerId => ({ providerId }))),
  ensureProviderControlHost: vi.fn(async () => ({
    socketPath: '/tmp/mearl-provider-control.sock',
  })),
}));

vi.mock('../browserRegistry.js', () => ({
  listLiveBrowsers: vi.fn(() => liveBrowsers),
  findBrowser: vi.fn(
    (items: typeof liveBrowsers, selector: string) =>
      items.find(item => item.browserId === selector) ?? null,
  ),
  describeBrowser: vi.fn(),
}));

import { invoke, resolveLocalActionTarget } from '../socket.js';
import { listLiveBrowsers } from '../browserRegistry.js';
import { ensureProviderControlHost, listInstalledProviders } from '@mearl/provider/host';
import { readLiveProvider } from '@mearl/provider/runtime';

interface MockSocket extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('external provider routing', () => {
  it('queries only the selected Provider launch form without invoking ordinary discovery', async () => {
    const providerId = 'org.fixture_test';
    vi.mocked(listInstalledProviders).mockReturnValueOnce([{ providerId, browserType: { dynamicLaunchForm: true } }] as any);
    vi.mocked(readLiveProvider).mockReturnValueOnce({ providerId, providerProtocolVersion: 3, socketPath: '/selected-provider.sock' } as any);
    vi.mocked(listLiveBrowsers).mockReturnValueOnce([
      { ...liveBrowsers[1]!, provider: { id: providerId } },
      { ...liveBrowsers[1]!, browserId: 'provider:other:unrelated', provider: { id: 'other' } },
    ] as any);
    const form = { inputSchema: { type: 'object', properties: { spaceId: { type: 'string', options: [{ value: '8', label: 'Existing' }] } } }, variant: 'attach' };
    let request: any;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket; socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        request = JSON.parse(line);
        queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ id: request.id, success: true, data: form }) + '\n')));
      });
      queueMicrotask(() => socket.emit('connect')); return socket;
    });
    const result = await invoke('browser_list', { provider: providerId, launchForm: { variant: 'attach', values: { name: 'kept' } } });
    expect(result.discovery).toEqual({ provider: providerId, launchForm: form });
    expect(ensureProvidersMock).toHaveBeenCalledExactlyOnceWith([providerId]);
    expect(createConnectionMock).toHaveBeenCalledExactlyOnceWith('/selected-provider.sock');
    expect(request).toMatchObject({ action: 'browser_providers', data: { operation: 'launch_form', variant: 'attach', values: { name: 'kept' } } });
    expect(result.browsers.every((browser: any) => browser.provider?.id === providerId)).toBe(true);
    expect(result.browsers).toHaveLength(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not treat an ignored launch-form request from an older endpoint as an empty candidate list', async () => {
    vi.mocked(listInstalledProviders).mockReturnValueOnce([{ providerId: 'fixture', browserType: { dynamicLaunchForm: true } }] as any);
    vi.mocked(readLiveProvider).mockReturnValueOnce({ providerProtocolVersion: 3, socketPath: '/old.sock' } as any);
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket; socket.end = vi.fn();
      socket.write = vi.fn((line: string) => { const request = JSON.parse(line); queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ id: request.id, success: true, data: { browsers: [] } }) + '\n'))); });
      queueMicrotask(() => socket.emit('connect')); return socket;
    });
    await expect(invoke('browser_list', { provider: 'fixture', launchForm: { values: {} } })).rejects.toThrow();
    expect(createConnectionMock).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'provider:fixture:device-a'])(
    'refuses an external-control browser on an older host before socket dispatch (%s)',
    async selector => {
      const target = liveBrowsers[1]!;
      const capabilities = target.capabilities as { controlSessionMode?: string };
      capabilities.controlSessionMode = 'external';
      try {
        await expect(invoke('page_eval', { tabId: 7, expression: '42' }, selector ? { browser: selector } : {})).rejects.toThrow('CONTROL_SESSION_MODE_UNSUPPORTED');
        expect(createConnectionMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        delete capabilities.controlSessionMode;
      }
    },
  );

  it('routes an external-control browser through a compatible host without inventing a session', async () => {
    const target = liveBrowsers[1]!;
    const capabilities = target.capabilities as { controlSessionMode?: string };
    capabilities.controlSessionMode = 'external';
    vi.mocked(ensureProviderControlHost).mockResolvedValueOnce({
      pid: process.pid, ready: true, token: 'test', protocolVersion: 3,
      socketPath: '/tmp/mearl-provider-control.sock', controlSessionModes: ['mearl', 'external'],
    });
    let envelope: Record<string, any> | undefined;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const message = JSON.parse(line);
        envelope = message;
        queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ id: message.id, success: true, data: { value: 42 } }) + '\n')));
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });
    try {
      await expect(invoke('page_eval', { tabId: 7, expression: '42' }, { browser: target.browserId })).resolves.toEqual({ value: 42 });
      expect(envelope).toMatchObject({ providerTarget: target.browserId, action: 'page_eval' });
      expect(envelope).not.toHaveProperty('controlSessionId');
    } finally {
      delete capabilities.controlSessionMode;
    }
  });
  it.each([undefined, 'provider:fixture:device-a'])('routes host-provided discovery to an ordinary Provider (%s)', async browser => {
    let envelope: Record<string, any> | undefined;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const request = JSON.parse(line);
        envelope = request;
        queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ id: request.id, success: true, data: { apps: { status: 'unsupported', entries: [] } } }) + '\n')));
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });
    await expect(invoke('get_capabilities', {}, browser ? { browser } : {})).resolves.toMatchObject({ apps: { status: 'unsupported' } });
    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-provider-control.sock');
    expect(envelope).toMatchObject({ action: 'get_capabilities', data: {}, providerTarget: 'provider:fixture:device-a' });
  });
  it('sends the explicit caller deadline to the Provider control host', async () => {
    let envelope: Record<string, any> | undefined;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const message = JSON.parse(line);
        envelope = message;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(JSON.stringify({ id: message.id, success: true, data: {} }) + '\n'),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });
    const before = Date.now();
    await invoke(
      'page_eval',
      { tabId: 7, expression: '1+1' },
      { browser: 'provider:fixture:device-a', timeoutSec: 300 },
    );
    expect(envelope?.deadline).toBeGreaterThanOrEqual(before + 300_000);
    expect(envelope?.deadline).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(envelope?.data).toEqual({ tabId: 7, expression: '1+1' });
  });
  it.each(['provider', 'extension', 'ambiguous', 'missing'])(
    'resolves %s session ownership across control hosts',
    async transport => {
      const session = {
        sessionId: 's_aB3d_E-f',
        browserId: transport === 'provider' ? 'provider:fixture:device-a' : 'native-browser',
        transport,
      };
      const requests: Record<string, unknown>[] = [];
      createConnectionMock.mockImplementation((socketPath: string) => {
        const socket = new EventEmitter() as MockSocket;
        socket.end = vi.fn();
        socket.write = vi.fn((line: string) => {
          const request = JSON.parse(line);
          requests.push(request);
          const ownsSession =
            transport === 'ambiguous' ||
            (transport === 'provider'
              ? socketPath === '/tmp/mearl-provider-control.sock'
              : transport === 'extension' && socketPath === '/tmp/mearl-native-browser.sock');
          queueMicrotask(() =>
            socket.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  id: request.id,
                  success: true,
                  data: { session: ownsSession ? session : null },
                }) + '\n',
              ),
            ),
          );
        });
        queueMicrotask(() => socket.emit('connect'));
        return socket;
      });
      const lookup = invoke('__control_session_resolve', { sessionId: session.sessionId });
      if (transport === 'ambiguous')
        await expect(lookup).rejects.toThrow('CONTROL_SESSION_AMBIGUOUS');
      else
        await expect(lookup).resolves.toEqual({
          session: transport === 'missing' ? null : session,
        });
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.action === '__control_session_resolve')).toBe(true);
      expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-native-browser.sock');
      expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-provider-control.sock');
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('routes declared downloads and their artifacts without requiring upload support', async () => {
    const target = liveBrowsers[1]!;
    const capabilities = target.capabilities;
    target.capabilities = { actions: ['page_download'] as any, screenshot: 'none' };
    const requests: Record<string, unknown>[] = [];
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const request = JSON.parse(line);
        requests.push(request);
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(JSON.stringify({ id: request.id, success: true, data: {} }) + '\n'),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });
    try {
      for (const action of ['page_download', '__artifact_read', '__artifact_remove']) {
        await invoke(action, { tabId: 7 }, { browser: target.browserId });
      }
      expect(requests.map(request => request.action)).toEqual([
        'page_download',
        '__artifact_read',
        '__artifact_remove',
      ]);
      expect(requests.every(request => request.providerTarget === target.browserId)).toBe(true);
      await expect(invoke('__artifact_init', {}, { browser: target.browserId })).rejects.toThrow(
        'does not support __artifact_init',
      );
      target.capabilities = capabilities;
      await expect(invoke('page_download', {}, { browser: target.browserId })).rejects.toThrow(
        'does not support page_download',
      );
      expect(requests).toHaveLength(3);
    } finally {
      target.capabilities = capabilities;
    }
  });
  it('routes scoped release through Mearl without requiring Provider detach support', async () => {
    const target = liveBrowsers[1]!;
    const operations = target.operations;
    target.operations = ['close'];
    let request: Record<string, unknown> | undefined;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        request = JSON.parse(line);
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(
              JSON.stringify({ id: request!.id, success: true, data: { released: true } }) + '\n',
            ),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });
    try {
      await expect(
        invoke(
          'browser_release',
          {},
          {
            browser: target.browserId,
            controlSessionId: 'cs_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        ),
      ).resolves.toEqual({ released: true });
      expect(request).toMatchObject({
        providerTarget: target.browserId,
        controlSessionId: 'cs_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      });
      await expect(invoke('browser_release', {}, { browser: target.browserId })).rejects.toThrow(
        'does not support browser_release',
      );
    } finally {
      target.operations = operations;
    }
  });
  it('routes Provider actions through the shared Mearl control host', async () => {
    let request: Record<string, unknown> | undefined;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        request = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ id: request!.id, success: true, data: { result: 2 } })}\n`,
            ),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });

    await expect(
      invoke(
        'page_eval',
        { tabId: 1000, expression: '1 + 1' },
        { browser: 'provider:fixture:device-a' },
      ),
    ).resolves.toEqual({ result: 2 });

    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-provider-control.sock');
    expect(request).toMatchObject({
      action: 'page_eval',
      providerTarget: 'provider:fixture:device-a',
      data: { tabId: 1000, expression: '1 + 1' },
    });
  });

  it('does not use a pairing-only provider as the implicit action target', async () => {
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(`${JSON.stringify({ id: request.id, success: true, data: {} })}\n`),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });

    await expect(invoke('tab_list')).resolves.toEqual({});

    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-provider-control.sock');
    expect(createConnectionMock).not.toHaveBeenCalledWith('/tmp/mearl-provider-pairing.sock');
  });

  it('rejects an explicitly selected provider until pairing finishes', async () => {
    await expect(
      invoke('page_eval', { expression: 'location.href' }, { browser: 'provider:fixture:waiting' }),
    ).rejects.toThrow('is waiting for device pairing');

    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it('uses capabilities when selecting and validating a provider target', async () => {
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(`${JSON.stringify({ id: request.id, success: true, data: {} })}\n`),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });

    await expect(invoke('page_click')).resolves.toEqual({});
    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-native-browser.sock');

    vi.clearAllMocks();
    await expect(
      invoke('page_click', {}, { browser: 'provider:fixture:device-a' }),
    ).rejects.toThrow('does not support page_click');
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it('routes browser_release to a Provider that declares detach', async () => {
    let request: Record<string, unknown> | undefined;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        request = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ id: request!.id, success: true, data: { detached: true } })}\n`,
            ),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });

    await expect(
      invoke('browser_release', {}, { browser: 'provider:fixture:device-a' }),
    ).resolves.toEqual({ detached: true });
    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-provider-control.sock');
    expect(request).toMatchObject({
      action: 'browser_release',
      providerTarget: 'provider:fixture:device-a',
    });
  });

  it('uses a native host as the authoritative browser-list aggregator', async () => {
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                id: request.id,
                success: true,
                data: {
                  count: 1,
                  connectedCount: 0,
                  warnings: ['provider fixture: startup warning'],
                  browsers: [
                    {
                      browserId: 'managed:fixture',
                      name: 'Managed fixture',
                      type: 'managed',
                      status: 'stopped',
                    },
                  ],
                },
              })}\n`,
            ),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });

    await expect(invoke('browser_list')).resolves.toMatchObject({
      count: 1,
      warnings: ['provider fixture: startup warning'],
      browsers: [expect.objectContaining({ browserId: 'managed:fixture', type: 'managed' })],
    });

    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-native-browser.sock');
    expect(createConnectionMock).not.toHaveBeenCalledWith('/tmp/mearl-provider-fixture.sock');
    expect(ensureProvidersMock).not.toHaveBeenCalled();
  });

  it('keeps the Provider inventory when local CDP discovery cannot start', async () => {
    vi.mocked(listLiveBrowsers).mockReturnValue(
      liveBrowsers.filter(browser => browser.transport === 'provider'),
    );
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      );
      return child;
    });

    try {
      await expect(invoke('browser_list')).resolves.toMatchObject({
        count: 2,
        connectedCount: 1,
        defaultBrowserId: 'provider:fixture:device-a',
        warnings: [expect.stringContaining('Local CDP discovery could not complete: ENOENT')],
        browsers: [
          expect.objectContaining({
            browserId: 'provider:fixture:waiting',
            status: 'pairing',
          }),
          expect.objectContaining({
            browserId: 'provider:fixture:device-a',
            status: 'connected',
          }),
        ],
      });
      expect(createConnectionMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledWith(
        'mearl-native-host',
        ['--daemon', '--discover-cdp'],
        expect.objectContaining({ detached: true }),
      );
      expect(ensureProvidersMock).not.toHaveBeenCalled();
    } finally {
      vi.mocked(listLiveBrowsers).mockReturnValue(liveBrowsers);
    }
  });

  it('uses a native host to recover an installed provider missing from live records', async () => {
    vi.mocked(listLiveBrowsers).mockReturnValue(
      liveBrowsers.filter(browser => browser.transport === 'provider'),
    );
    installedProviderIds.push('missing');
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        unref: ReturnType<typeof vi.fn>;
      };
      child.pid = 42;
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        const request = JSON.parse(line) as { id: string };
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                id: request.id,
                success: true,
                data: {
                  count: 2,
                  connectedCount: 1,
                  warnings: ['provider missing: startup warning'],
                  browsers: [
                    { browserId: 'provider:fixture:device-a', status: 'connected' },
                    { browserId: 'provider:missing:offline', status: 'stopped' },
                  ],
                },
              })}\n`,
            ),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });

    try {
      await expect(invoke('browser_list')).resolves.toMatchObject({
        count: 2,
        warnings: ['provider missing: startup warning'],
      });
      expect(createConnectionMock).toHaveBeenCalledWith(expect.stringContaining('mearl-agent-42'));
      expect(ensureProvidersMock).not.toHaveBeenCalled();
    } finally {
      installedProviderIds.pop();
      vi.mocked(listLiveBrowsers).mockReturnValue(liveBrowsers);
    }
  });

  it('does not route forced CDP actions through a provider', async () => {
    let request: Record<string, unknown> | undefined;
    createConnectionMock.mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.end = vi.fn();
      socket.write = vi.fn((line: string) => {
        request = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(`${JSON.stringify({ id: request!.id, success: true, data: {} })}\n`),
          ),
        );
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });

    await expect(invoke('tab_list', {}, { transport: 'cdp' })).resolves.toEqual({});
    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/mearl-native-browser.sock');
    expect(request).toMatchObject({ action: 'tab_list', transport: 'cdp' });

    await expect(
      invoke('tab_list', {}, { browser: 'provider:fixture:device-a', transport: 'cdp' }),
    ).rejects.toThrow('does not support the CDP transport');
  });
});

it('resolves Provider page_eval capabilities using the same registry rules as dispatch', () => {
  expect(resolveLocalActionTarget('page_eval', { tabId: 7 })).toEqual({
    browser: 'provider:fixture:device-a',
  });
  expect(createConnectionMock).not.toHaveBeenCalled();
});
it('skips an unsupported Provider before resolving an ordinary browser for page_eval', () => {
  vi.mocked(listLiveBrowsers).mockReturnValueOnce([
    { ...liveBrowsers[1], capabilities: { actions: ['page_screenshot'], screenshot: 'native' } },
    {
      browserId: 'chrome',
      browserName: 'Chrome',
      socketPath: '/tmp/chrome.sock',
      pid: process.pid,
      transport: 'extension',
      status: 'connected',
    },
  ] as any);
  expect(resolveLocalActionTarget('page_eval', { tabId: 7 })).toEqual({ browser: 'chrome' });
});
it('returns only the actual browser identity for remote route resolution', async () => {
  await expect(
    invoke('__resolve_action_target', { action: 'page_eval', data: { tabId: 7 } }),
  ).resolves.toEqual({ browser: 'provider:fixture:device-a' });
  expect(createConnectionMock).not.toHaveBeenCalled();
  await expect(invoke('__resolve_action_target', { action: '__extension_reload' })).rejects.toThrow(
    'Invalid browser capability action',
  );
});
