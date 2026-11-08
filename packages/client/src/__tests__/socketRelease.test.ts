import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function createConnectionErrorSocket(code: string): EventEmitter & {
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
    socket.emit('error', Object.assign(new Error(code), { code }));
  });
  return socket;
}

describe('legacy connection recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createConnectionMock.mockImplementation(() => createConnectionErrorSocket('ENOENT'));
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('can retry native-host startup on a later invocation in the same process', async () => {
    const failedAction = invoke('tab_list').then(
      () => null,
      error => error as Error,
    );
    await vi.runAllTimersAsync();
    await expect(failedAction).resolves.toMatchObject({
      message: expect.stringContaining('未找到 Socket'),
    });
    expect(spawnMock).toHaveBeenCalledOnce();
    spawnMock.mockClear();
    createConnectionMock.mockClear();

    const laterAction = invoke('tab_list').then(
      () => null,
      error => error as Error,
    );
    await vi.runAllTimersAsync();

    await expect(laterAction).resolves.toMatchObject({
      message: expect.stringContaining('未找到 Socket'),
    });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(createConnectionMock).toHaveBeenCalledTimes(2);
  });
});
