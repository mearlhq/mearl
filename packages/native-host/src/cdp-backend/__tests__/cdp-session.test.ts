import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpSession, type PageSession } from '../cdp-session.js';
import { CdpClient } from '../client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecord } from '@mearl/daemon-core';

afterEach(() => vi.restoreAllMocks());

describe('CDP session reuse', () => {
  it('restores target IDs before discovery after a host restart and separates browser lifetimes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-cdp-targets-'));
    const targetRegistryFile = join(directory, 'targets.json');
    const client = (identity: string) => {
      const listeners = new Map<string, (event: any) => void>();
      return {
        identity,
        closed: false,
        close() {
          this.closed = true;
        },
        on: vi.fn((event, listener) => {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        }),
        listeners,
      };
    };
    const first = client('same-browser'),
      second = client('same-browser'),
      next = client('new-browser');
    vi.spyOn(CdpClient, 'connect')
      .mockResolvedValueOnce(first as any)
      .mockResolvedValueOnce(second as any)
      .mockResolvedValueOnce(next as any);
    const create = () =>
      new CdpSession({ endpointUrl: 'ws://localhost/devtools/browser/test', targetRegistryFile });
    const sessions: CdpSession[] = [];
    try {
      const original = create();
      sessions.push(original);
      expect(await original.ensureTargetRegistered('closed-tab')).toBe(1000);
      expect(await original.ensureTargetRegistered('surviving-tab')).toBe(1001);
      first.listeners.get('Target.targetDestroyed')?.({ targetId: 'closed-tab' });
      original.close();
      const restarted = create();
      sessions.push(restarted);
      const observed = vi.fn(() => expect(restarted.listRegisteredTabIds()).toEqual([1001]));
      restarted.onBrowserConnected(observed);
      expect(await restarted.ensureTargetRegistered('new-tab-discovered-first')).toBe(1002);
      expect(observed).toHaveBeenCalledOnce();
      expect(await restarted.ensureTargetRegistered('surviving-tab')).toBe(1001);
      expect(readRecord(targetRegistryFile)?.targets).toEqual([
        [1001, 'surviving-tab'],
        [1002, 'new-tab-discovered-first'],
      ]);
      restarted.close();
      const newBrowser = create();
      sessions.push(newBrowser);
      expect(await newBrowser.ensureTargetRegistered('fresh-tab')).toBe(1003);
      expect(newBrowser.listRegisteredTabIds()).toEqual([1003]);
      await expect(newBrowser.getPageSession(1001)).rejects.toThrow('Tab 1001 not found');
    } finally {
      sessions.forEach(session => session.close());
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reuses the attached default page when an action omits tabId', async () => {
    const session = new CdpSession();
    const page = {
      targetId: 'target-a',
      client: { closed: false },
    } as PageSession;
    const internals = session as unknown as {
      pageSessions: Map<string, PageSession>;
      findDefaultPageTarget: ReturnType<typeof vi.fn>;
      createPageSession: ReturnType<typeof vi.fn>;
    };
    internals.pageSessions.set('target-a', page);
    internals.findDefaultPageTarget = vi.fn().mockResolvedValue({ id: 'target-a' });
    internals.createPageSession = vi.fn();

    await expect(session.getPageSession()).resolves.toBe(page);
    expect(internals.createPageSession).not.toHaveBeenCalled();
  });

  it('initializes a target once when discovery and tab control attach concurrently', async () => {
    const session = new CdpSession();
    const page = { targetId: 'target-a', client: { closed: false } } as PageSession;
    const internals = session as unknown as {
      findTargetById: ReturnType<typeof vi.fn>;
      createPageSession: ReturnType<typeof vi.fn>;
    };
    internals.findTargetById = vi.fn().mockResolvedValue({ id: 'target-a' });
    internals.createPageSession = vi.fn().mockResolvedValue(page);
    const tabId = await session.ensureTargetRegistered('target-a');

    await expect(
      Promise.all([session.getPageSession(tabId), session.getPageSession(tabId)]),
    ).resolves.toEqual([page, page]);
    expect(internals.createPageSession).toHaveBeenCalledTimes(1);
  });

  it('reuses the discovered tab ID when tab_open registers the same target', async () => {
    const session = new CdpSession();
    const internals = session as unknown as {
      findTargetById: ReturnType<typeof vi.fn>;
      createPageSession: ReturnType<typeof vi.fn>;
    };
    internals.findTargetById = vi.fn().mockResolvedValue({ id: 'target-a' });
    internals.createPageSession = vi.fn().mockResolvedValue({ targetId: 'target-a' });
    const discoveredId = await session.ensureTargetRegistered('target-a');

    await expect(session.registerTarget('target-a')).resolves.toBe(discoveredId);
    expect(session.listRegisteredTabIds()).toEqual([discoveredId]);
  });

  it('notifies session state when the browser connection is replaced', async () => {
    const first = { closed: false, on: vi.fn() };
    const second = { closed: false, on: vi.fn() };
    vi.spyOn(CdpClient, 'connect')
      .mockResolvedValueOnce(first as unknown as CdpClient)
      .mockResolvedValueOnce(second as unknown as CdpClient);
    const session = new CdpSession({ endpointUrl: 'ws://localhost/devtools/browser/test' });
    const onConnected = vi.fn();
    session.onBrowserConnected(onConnected);

    await expect(session.getBrowserClient()).resolves.toBe(first);
    first.closed = true;
    await expect(session.getBrowserClient()).resolves.toBe(second);
    expect(onConnected).toHaveBeenCalledTimes(2);
  });
});

it('does not publish the browser connection before asynchronous reference initialization completes', async () => {
  let inventoryReady!: (value: unknown) => void;
  const inventory = new Promise(resolve => { inventoryReady = resolve; });
  const client = { identity: 'a'.repeat(64), closed: false, close: vi.fn(), on: vi.fn(), sendCommand: vi.fn(() => inventory) };
  vi.spyOn(CdpClient, 'connect').mockResolvedValue(client as any);
  const session = new CdpSession({ endpointUrl: 'ws://localhost/devtools/browser/test' });
  const first = session.getBrowserClient();
  await vi.waitFor(() => expect(client.sendCommand).toHaveBeenCalledWith('Target.getTargets'));
  let published = false;
  const second = session.getBrowserClient().then(value => { published = true; return value; });
  await Promise.resolve(); expect(published).toBe(false);
  inventoryReady({ targetInfos: [] });
  expect(await first).toBe(client); expect(await second).toBe(client);
  expect(client.on).toHaveBeenCalledWith('Target.targetDestroyed', expect.any(Function));
  session.close();
});
