import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createConnectionMock, spawnMock, socketDirectory } = vi.hoisted(() => {
  const socketDirectory =
    process.platform === 'win32'
      ? undefined
      : process.getBuiltinModule('node:fs')!.mkdtempSync('/tmp/mearl-stale-socket-');
  if (socketDirectory) vi.stubEnv('TMPDIR', socketDirectory);
  return { createConnectionMock: vi.fn(), spawnMock: vi.fn(), socketDirectory };
});

vi.mock('node:net', () => ({
  default: { createConnection: createConnectionMock },
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../browserRegistry.js', () => ({
  listLiveBrowsers: vi.fn(() => []),
  findBrowser: vi.fn(() => null),
  describeBrowser: vi.fn(),
}));

import { invokeLocalHost, setDefaultBrowser, SOCKET_PATH } from '../socket.js';
import { listLiveBrowsers } from '../browserRegistry.js';

afterAll(() => {
  vi.unstubAllEnvs();
  if (socketDirectory) fs.rmSync(socketDirectory, { recursive: true, force: true });
});

interface MockSocket extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

function connectionRefusedSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.end = vi.fn();
  socket.write = vi.fn();
  queueMicrotask(() => {
    socket.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  });
  return socket;
}

function successfulSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.end = vi.fn();
  socket.write = vi.fn((line: string) => {
    const request = JSON.parse(line) as { id: string };
    queueMicrotask(() => {
      socket.emit(
        'data',
        Buffer.from(`${JSON.stringify({ id: request.id, success: true, data: { tabs: [] } })}\n`),
      );
    });
  });
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

function mockSocketFile(...inodes: number[]) {
  const lstat = fs.lstatSync;
  const unlink = fs.unlinkSync;
  const unlinkSocket = vi.fn();
  vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
    if (file !== SOCKET_PATH) return lstat(file, options);
    const inode = inodes.length > 1 ? inodes.shift() : inodes[0];
    return { dev: 1, ino: inode, isSocket: () => true, uid: process.getuid?.() } as fs.Stats;
  });
  vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (file === SOCKET_PATH) unlinkSocket(file);
    else unlink(file);
  });
  return unlinkSocket;
}

describe('stale legacy socket recovery', () => {
  beforeEach(() => {
    vi.mocked(listLiveBrowsers).mockReturnValue([]);
    vi.useFakeTimers();
    createConnectionMock
      .mockImplementationOnce(() => connectionRefusedSocket())
      .mockImplementationOnce(() => successfulSocket());
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
  });

  afterEach(() => {
    setDefaultBrowser(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('auto-starts the local host without routing infrastructure calls to the selected provider', async () => {
    setDefaultBrowser('external');
    vi.mocked(listLiveBrowsers).mockReturnValue([
      {
        browserId: 'external',
        browserName: 'External',
        transport: 'provider',
        socketPath: '/external.sock',
        status: 'ready',
        capabilities: { actions: ['preset_components_install'] },
      },
    ] as any);
    const result = invokeLocalHost('preset_components_install', {
      installationRevision: 'a'.repeat(64),
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ tabs: [] });
    expect(createConnectionMock.mock.calls.every(([socket]) => socket === SOCKET_PATH)).toBe(true);
    expect(spawnMock).toHaveBeenCalledOnce();
    vi.mocked(listLiveBrowsers).mockReturnValue([]);
  });

  it.runIf(process.platform !== 'win32')(
    'removes a same-user stale socket, respawns, and transparently retries',
    async () => {
      const unlinkSpy = mockSocketFile(10);

      const resultPromise = invokeLocalHost('preset_components_install');
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toEqual({ tabs: [] });
      expect(unlinkSpy).toHaveBeenCalledWith(SOCKET_PATH);
      expect(spawnMock).toHaveBeenCalledWith(
        'mearl-native-host',
        ['--daemon', '--inventory'],
        expect.objectContaining({ detached: true }),
      );
      expect(createConnectionMock).toHaveBeenCalledTimes(2);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not unlink a replacement socket created by another recovery',
    async () => {
      const unlinkSpy = mockSocketFile(10, 11);

      const resultPromise = invokeLocalHost('preset_components_install');
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toEqual({ tabs: [] });
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledOnce();
    },
  );
});
