import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  records: [] as Array<{ pid: number; serverUrl: string }>,
  stop: vi.fn(),
}));

vi.mock('@mearl/daemon-core', () => ({
  DAEMON_HOME: '/tmp',
  claimRecord: vi.fn(),
  createDaemon: vi.fn(() => ({
    logs: vi.fn(),
    restart: vi.fn(),
    running: vi.fn(),
    start: vi.fn(),
    status: vi.fn(),
    stop: mocks.stop,
  })),
  isAlive: vi.fn(),
  keyedConfigFile: vi.fn((_subdir: string, key: string) => `/tmp/${key}.json`),
  keyedDir: vi.fn(() => '/tmp/connectors'),
  keyedLogFile: vi.fn((_subdir: string, key: string) => `/tmp/${key}.log`),
  readLiveRecords: vi.fn(() => mocks.records),
  readRecord: vi.fn(),
  removeRecordIfPid: vi.fn(),
  writeRecord: vi.fn(),
  writeRecordIfPid: vi.fn(),
}));

import { stopDaemonByPid } from '../daemon.js';

describe('cloud connector daemon lifecycle', () => {
  beforeEach(() => {
    mocks.records = [];
    mocks.stop.mockReset();
  });

  it('keeps the requested pid bound to the stop operation', async () => {
    mocks.records = [{ pid: 12345, serverUrl: 'wss://cloud.example/ws' }];

    await stopDaemonByPid(12345);

    expect(mocks.stop).toHaveBeenCalledWith(12345);
  });
});
