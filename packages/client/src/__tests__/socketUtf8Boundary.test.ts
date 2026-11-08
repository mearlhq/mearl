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

describe('socket UTF-8 responses', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('preserves a multibyte character split across response chunks', async () => {
    vi.stubEnv('MEARL_SOCKET_PATH', '/tmp/mearl-utf8-boundary.sock');
    const expected = '边界首字符';
    const socket = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    };
    socket.end = vi.fn();
    socket.write = vi.fn((line: string) => {
      const request = JSON.parse(line) as { id: string };
      const response = Buffer.from(
        `${JSON.stringify({ id: request.id, success: true, data: expected })}\n`,
      );
      const characterStart = response.indexOf(Buffer.from('首'));
      queueMicrotask(() => {
        socket.emit('data', response.subarray(0, characterStart + 1));
        socket.emit('data', response.subarray(characterStart + 1));
      });
    });
    createConnectionMock.mockReturnValue(socket);
    queueMicrotask(() => socket.emit('connect'));

    await expect(invoke('tab_list')).resolves.toBe(expected);
  });
});
