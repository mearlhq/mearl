import { beforeEach, describe, expect, it, vi } from 'vitest';

const records = vi.hoisted(() => new Map<string, Record<string, any>>());

vi.mock('@mearl/daemon-core', () => ({
  keyedConfigFile: (_directory: string, browserId: string) => browserId,
  keyedDir: (directory: string) => directory,
  listRecordFiles: () => [...records.keys()],
  readRecord: (file: string) => records.get(file),
  claimRecord: (file: string, record: Record<string, any>) => {
    if (records.has(file)) return false;
    records.set(file, record);
    return true;
  },
  writeRecordIfPid: (file: string, pid: number, record: Record<string, any>) => {
    if (records.get(file)?.pid !== pid) return false;
    records.set(file, record);
    return true;
  },
  removeRecord: (file: string) => records.delete(file),
  removeInvalidRecord: (file: string) => records.delete(file),
  removeRecordIfPid: (file: string, pid: number) => {
    if (records.get(file)?.pid !== pid) return false;
    records.delete(file);
    return true;
  },
  isAlive: () => true,
}));

import {
  initBrowserRegistry,
  listRegisteredBrowsers,
  registerBrowser,
  retireUnreachableBrowserRecord,
  unregisterBrowser,
} from '../browser-registry.js';

beforeEach(() => {
  records.clear();
  initBrowserRegistry({ log: vi.fn() });
});

describe('browser discovery focus rank', () => {
  it('puts an auto-discovered CDP browser behind an existing browser on reconnect', () => {
    records.set('extension-a', {
      pid: process.pid,
      browserId: 'extension-a',
      socketPath: '/tmp/extension-a.sock',
      browserName: 'Chrome',
      nativeHostVersion: '2.19.0',
      transport: 'extension',
      lastFocusedAt: 0,
      updatedAt: 1,
    });
    records.set('cdp', {
      pid: process.pid,
      browserId: 'cdp',
      socketPath: '/tmp/old-cdp.sock',
      browserName: 'CDP',
      nativeHostVersion: '2.19.0',
      transport: 'cdp',
      lastFocusedAt: 100,
      updatedAt: 1,
    });

    registerBrowser({
      browserId: 'cdp',
      socketPath: '/tmp/new-cdp.sock',
      browserName: 'CDP',
      nativeHostVersion: '2.19.0',
      transport: 'cdp',
      lastFocusedAt: -1,
      preserveFocus: false,
    });

    expect(records.get('cdp')?.lastFocusedAt).toBe(-1);
    expect(listRegisteredBrowsers().map(browser => browser.browserId)).toEqual([
      'extension-a',
      'cdp',
    ]);
  });
});

describe('CDP discovery record ownership', () => {
  it('rejects another live daemon without claiming a published record', () => {
    records.set('cdp', {
      pid: process.pid + 1,
      browserId: 'cdp',
      socketPath: '/tmp/other-cdp.sock',
      transport: 'cdp',
    });

    expect(
      registerBrowser({
        browserId: 'cdp',
        socketPath: '/tmp/new-cdp.sock',
        browserName: 'CDP',
        nativeHostVersion: '2.19.0',
        transport: 'cdp',
        lastFocusedAt: -1,
        preserveFocus: false,
      }),
    ).toBe(false);
    expect(records.get('cdp')?.socketPath).toBe('/tmp/other-cdp.sock');
  });

  it('retires a live-pid record only when its socket is unreachable', async () => {
    records.set('cdp', {
      pid: process.pid + 1,
      browserId: 'cdp',
      socketPath: '/tmp/old-cdp.sock',
      transport: 'cdp',
    });
    await expect(retireUnreachableBrowserRecord('cdp', async () => true)).resolves.toBe(false);
    expect(records.has('cdp')).toBe(true);
    await expect(retireUnreachableBrowserRecord('cdp', async () => false)).resolves.toBe(true);
    expect(records.has('cdp')).toBe(false);
  });

  it('does not remove a successor record when the old daemon shuts down', () => {
    expect(
      registerBrowser({
        browserId: 'cdp',
        socketPath: '/tmp/old-cdp.sock',
        browserName: 'CDP',
        nativeHostVersion: '2.19.0',
        transport: 'cdp',
      }),
    ).toBe(true);
    records.set('cdp', {
      ...records.get('cdp'),
      pid: process.pid + 1,
      socketPath: '/tmp/new-cdp.sock',
    });

    unregisterBrowser();
    expect(records.get('cdp')?.socketPath).toBe('/tmp/new-cdp.sock');
  });
});
