import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createConnectionMock, ensureProvidersMock, liveBrowsers, spawnMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn(),
  ensureProvidersMock: vi.fn(async () => []),
  liveBrowsers: [] as Array<{
    pid: number;
    browserId: string;
    socketPath: string;
    browserName: string;
    transport?: 'provider' | 'extension' | 'cdp';
    status?: 'pairing' | 'connected';
  }>,
  spawnMock: vi.fn(),
}));
let inventoryTime = Date.now();

vi.mock('node:net', () => ({
  default: {
    createConnection: createConnectionMock,
  },
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../browserRegistry.js', () => ({
  listLiveBrowsers: vi.fn(() => liveBrowsers),
  findBrowser: vi.fn(() => null),
  describeBrowser: vi.fn(),
}));

vi.mock('@mearl/provider/runtime', () => ({
  ensureInstalledProvidersRunning: ensureProvidersMock,
  readLiveProvider: vi.fn(() => null),
}));

vi.mock('@mearl/provider/host', () => ({
  listInstalledProviders: vi.fn(() => []),
}));

import { invoke, SOCKET_PATH } from '../socket.js';

const DISCOVERY_SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\mearl-agent-42'
    : path.join(os.tmpdir(), 'mearl-agent-42.sock');

interface MockSocket extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

function createConnectionErrorSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.end = vi.fn();
  socket.write = vi.fn();
  queueMicrotask(() => {
    socket.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });
  return socket;
}

function createBrowserListSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.end = vi.fn();
  socket.write = vi.fn((line: string) => {
    const request = JSON.parse(line) as { id: string };
    queueMicrotask(() => {
      socket.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            id: request.id,
            success: true,
            data: {
              count: liveBrowsers.filter(browser => browser.transport === 'provider').length + 1,
              connectedCount: 1,
              browsers: [
                ...liveBrowsers
                  .filter(browser => browser.transport === 'provider')
                  .map(browser => ({
                    browserId: browser.browserId,
                    name: browser.browserName,
                    type: 'managed',
                    status: browser.status,
                    transport: browser.transport,
                  })),
                {
                  browserId: 'cdp',
                  name: 'CDP',
                  type: 'regular',
                  status: 'connected',
                  transport: 'cdp',
                },
              ],
            },
          })}\n`,
        ),
      );
    });
  });
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

function createNoCdpListSocket(): MockSocket {
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
              count: 0,
              connectedCount: 0,
              browsers: [],
              warnings: ['CDP endpoint unavailable'],
            },
          })}\n`,
        ),
      ),
    );
  });
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

describe('browser_list local inventory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    inventoryTime += 5000;
    vi.setSystemTime(inventoryTime);
    liveBrowsers.length = 0;
    createConnectionMock
      .mockImplementationOnce(() => createConnectionErrorSocket())
      .mockImplementationOnce(() => createBrowserListSocket());
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
  });

  afterEach(() => {
    delete process.env.MEARL_SOCKET_PATH;
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('starts an inventory daemon and returns registered browsers', async () => {
    const resultPromise = invoke('browser_list');
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({
      count: 1,
      connectedCount: 1,
      defaultBrowserId: 'cdp',
      browsers: [expect.objectContaining({ browserId: 'cdp', transport: 'cdp' })],
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'mearl-native-host',
      ['--daemon', '--inventory', '--skip-browser-registration'],
      expect.objectContaining({ detached: true }),
    );
    expect(ensureProvidersMock).not.toHaveBeenCalled();
  });

  it('uses the inventory daemon when only an unpaired Provider is registered', async () => {
    liveBrowsers.push({
      pid: 42,
      browserId: 'provider:example-device:device',
      socketPath: '/tmp/example-device.sock',
      browserName: 'Example device',
      transport: 'provider',
      status: 'pairing',
    });

    const resultPromise = invoke('browser_list');
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({
      count: 2,
      connectedCount: 1,
      defaultBrowserId: 'cdp',
      browsers: [
        expect.objectContaining({ browserId: 'provider:example-device:device', status: 'pairing' }),
        expect.objectContaining({ browserId: 'cdp', transport: 'cdp' }),
      ],
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'mearl-native-host',
      ['--daemon', '--inventory', '--skip-browser-registration'],
      expect.objectContaining({ detached: true }),
    );
    expect(createConnectionMock).not.toHaveBeenCalledWith('/tmp/example-device.sock');
  });

  it('routes inventory through a configured instance socket', async () => {
    process.env.MEARL_SOCKET_PATH = '/tmp/pinned-host.sock';
    createConnectionMock.mockReset().mockImplementation(() => createBrowserListSocket());

    const resultPromise = invoke('browser_list');
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toMatchObject({
      browsers: [expect.objectContaining({ browserId: 'cdp' })],
    });
    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/pinned-host.sock');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('loads inventory from a connected managed CDP browser', async () => {
    liveBrowsers.push({
      pid: 84,
      browserId: 'managed:account-a',
      socketPath: '/tmp/managed-a.sock',
      browserName: 'Managed Chrome',
      transport: 'cdp',
      status: 'connected',
    });

    createConnectionMock.mockReset().mockImplementation(() => createBrowserListSocket());
    const resultPromise = invoke('browser_list');
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({
      browsers: [expect.objectContaining({ browserId: 'cdp' })],
    });
    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/managed-a.sock');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent discovery requests', async () => {
    createConnectionMock.mockReset();
    createConnectionMock.mockImplementation((socketPath: string) =>
      socketPath === SOCKET_PATH ? createConnectionErrorSocket() : createBrowserListSocket(),
    );

    const results = Promise.all([invoke('browser_list'), invoke('browser_list')]);
    await vi.runAllTimersAsync();
    await expect(results).resolves.toHaveLength(2);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('retries the discovery socket when another browser registers during startup', async () => {
    spawnMock.mockImplementationOnce(() => {
      liveBrowsers.push({
        pid: 42,
        browserId: 'late-browser',
        socketPath: '/tmp/late-browser.sock',
        browserName: 'Late Browser',
      });
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        unref: ReturnType<typeof vi.fn>;
      };
      child.pid = 42;
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    const resultPromise = invoke('browser_list');
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toMatchObject({ defaultBrowserId: 'cdp' });

    expect(createConnectionMock).toHaveBeenCalledTimes(2);
    expect(createConnectionMock).toHaveBeenNthCalledWith(2, DISCOVERY_SOCKET_PATH);
    expect(createConnectionMock).not.toHaveBeenCalledWith('/tmp/late-browser.sock');
  });

  it('caches empty inventory for a short series of calls', async () => {
    createConnectionMock
      .mockReset()
      .mockImplementationOnce(() => createConnectionErrorSocket())
      .mockImplementationOnce(() => createNoCdpListSocket());

    const first = invoke('browser_list');
    await vi.runAllTimersAsync();
    await expect(first).resolves.toMatchObject({ count: 0 });
    await expect(invoke('browser_list')).resolves.toMatchObject({ count: 0 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(createConnectionMock).toHaveBeenCalledTimes(2);
  });
});

it('keeps a pinned transport endpoint independent of registry selectors', async () => {
  createConnectionMock.mockReset().mockImplementation(() => createBrowserListSocket());
  await invoke(
    'page_eval',
    { tabId: 7, expression: '42' },
    { browser: 'absent-from-registry', socketPath: '/tmp/pinned-page-eval.sock', timeoutSec: 1 },
  );
  expect(createConnectionMock).toHaveBeenCalledExactlyOnceWith('/tmp/pinned-page-eval.sock');
});
