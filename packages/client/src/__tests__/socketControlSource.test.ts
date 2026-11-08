import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createConnectionMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  default: {
    createConnection: createConnectionMock,
  },
}));

vi.mock('../browserRegistry.js', () => ({
  listLiveBrowsers: vi.fn(() => []),
  findBrowser: vi.fn(() => null),
  describeBrowser: vi.fn(),
}));

import { invoke } from '../socket.js';

describe('socket control source', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('serializes remote control with the compatible native-host wire value', async () => {
    vi.stubEnv('MEARL_SOCKET_PATH', '/tmp/mearl-control-source.sock');
    let request: Record<string, any> | undefined;
    const socket = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    };
    socket.end = vi.fn();
    socket.write = vi.fn((line: string) => {
      request = JSON.parse(line);
      queueMicrotask(() => {
        socket.emit(
          'data',
          Buffer.from(`${JSON.stringify({ id: request?.id, success: true, data: {} })}\n`),
        );
      });
    });
    createConnectionMock.mockReturnValue(socket);
    queueMicrotask(() => socket.emit('connect'));

    await invoke('tab_list', {}, { controlSource: 'remote' });

    expect(request).toMatchObject({
      action: 'tab_list',
      data: {},
      controlSource: 'cloud',
    });
  });
});
