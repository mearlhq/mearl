import { EventEmitter } from 'node:events';
import { MEARL_PROVIDER_PROTOCOL_VERSION } from '../protocol.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ record: null as any, spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
vi.mock('@mearl/daemon-core', () => ({
  keyedConfigFile: () => '/tmp/control-fixture.json',
  isAlive: (pid: number) => pid > 0,
  readRecord: () => state.record,
  removeInvalidRecord: vi.fn(),
  removeRecordIfPid: (_file: string, pid: number) => {
    if (state.record?.pid !== pid) return false;
    state.record = null;
    return true;
  },
  claimRecord: (_file: string, record: any) => {
    if (state.record) return false;
    state.record = record;
    return true;
  },
  writeRecordIfPid: (_file: string, pid: number, record: any) => {
    if (state.record?.pid !== pid) return false;
    state.record = record;
    return true;
  },
}));

afterEach(() => {
  state.record = null;
  vi.clearAllMocks();
  vi.resetModules();
});

describe('shared Provider control host startup', () => {
  it('treats missing mode support as Mearl-only without replacing the live host', async () => {
    state.record = {
      pid: 123, ready: true, token: 'old', socketPath: '/tmp/old.sock',
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
    };
    const { assertProviderControlSessionMode, ensureProviderControlHost } = await import('../control-host.js');
    const host = await ensureProviderControlHost();
    expect(() => assertProviderControlSessionMode(host)).not.toThrow();
    expect(() => assertProviderControlSessionMode(host, 'external')).toThrow('CONTROL_SESSION_MODE_UNSUPPORTED');
    expect(() => assertProviderControlSessionMode({ controlSessionModes: ['mearl', 'external'] }, 'external')).not.toThrow();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.record.token).toBe('old');
  });
  it.each([undefined, MEARL_PROVIDER_PROTOCOL_VERSION - 1])(
    'rejects protocol %s without replacing a live host',
    async protocolVersion => {
      state.record = {
        pid: 123,
        ready: true,
        token: 'old',
        socketPath: '/tmp/old.sock',
        protocolVersion,
      };
      const { ensureProviderControlHost } = await import('../control-host.js');
      await expect(ensureProviderControlHost()).rejects.toThrow('PROVIDER_PROTOCOL_MISMATCH');
      expect(state.spawn).not.toHaveBeenCalled();
      expect(state.record.token).toBe('old');
    },
  );
  it('reuses a ready host without spawning another process', async () => {
    state.record = {
      pid: 123,
      ready: true,
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
      token: 'test',
      socketPath: '/tmp/ready.sock',
    };
    const { ensureProviderControlHost } = await import('../control-host.js');
    expect(await ensureProviderControlHost()).toBe(state.record);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it('coalesces callers and preserves a child that becomes ready before the parent publishes its pid', async () => {
    state.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { pid: 123, unref: vi.fn() });
      queueMicrotask(() => {
        state.record = {
          ...state.record,
          pid: 123,
          ready: true,
          protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
          socketPath: '/tmp/ready.sock',
        };
        child.emit('spawn');
      });
      return child;
    });
    const { ensureProviderControlHost } = await import('../control-host.js');
    const first = ensureProviderControlHost();
    const second = ensureProviderControlHost();
    expect(first).toBe(second);
    expect(await first).toMatchObject({ pid: 123, ready: true });
    expect(state.spawn).toHaveBeenCalledOnce();
    expect(state.record.ready).toBe(true);
  });

  it('removes a failed startup claim so a later caller can recover', async () => {
    state.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('Native host is unavailable')));
      return child;
    });
    const { ensureProviderControlHost } = await import('../control-host.js');
    await expect(ensureProviderControlHost()).rejects.toThrow('Native host is unavailable');
    expect(state.record).toBeNull();
    state.record = {
      pid: 456,
      ready: true,
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
      token: 'recovered',
      socketPath: '/tmp/recovered.sock',
    };
    expect(await ensureProviderControlHost()).toMatchObject({ pid: 456 });
  });
});
