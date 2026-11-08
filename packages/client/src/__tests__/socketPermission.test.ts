import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createConnectionMock, spawnMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  default: {
    createConnection: createConnectionMock,
  },
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../browserRegistry.js', () => ({
  listLiveBrowsers: vi.fn(() => []),
  findBrowser: vi.fn(() => null),
  describeBrowser: vi.fn(),
}));

import { invoke } from '../socket.js';

function createPermissionErrorSocket(): EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const socket = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  socket.end = vi.fn();
  socket.write = vi.fn();
  queueMicrotask(() => {
    socket.emit('error', Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
  });
  return socket;
}

describe('socket permission errors', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('uses the configured native-host socket and explains sandbox EPERM failures', async () => {
    const socketPath = '/tmp/mearl-agent-42.sock';
    vi.stubEnv('MEARL_SOCKET_PATH', socketPath);
    createConnectionMock.mockImplementation(() => createPermissionErrorSocket());

    await expect(invoke('tab_list')).rejects.toThrow(
      [
        `Socket 连接被执行环境拦截: ${socketPath}`,
        '当前进程没有访问该 Mearl Unix Socket 的权限（EPERM）。',
      ].join('\n'),
    );

    expect(createConnectionMock).toHaveBeenCalledWith(socketPath);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
