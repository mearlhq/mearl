import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAlive, isProcessGroupAlive, isProcessOwnerAlive, processIdentity } from '../process.js';

vi.mock('node:fs', async original => ({ ...(await original<typeof import('node:fs')>()) }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', platform);
});

function stat(pid: number, state: string, group = pid, identity = '12345', threads = 1): string {
  const fields = Array<string>(20).fill('0');
  fields[0] = state;
  fields[1] = '1';
  fields[2] = String(group);
  fields[17] = String(threads);
  fields[19] = identity;
  return `${pid} (worker (with spaces)) ${fields.join(' ')}\n`;
}

function proc(entries: Record<number, string | Error>) {
  const directories = Object.keys(entries) as unknown as ReturnType<typeof fs.readdirSync>;
  const list = vi.spyOn(fs, 'readdirSync').mockReturnValue(directories);
  vi.spyOn(fs, 'readFileSync').mockImplementation(path => {
    const pid = String(path).match(/^\/proc\/(\d+)\/stat$/)?.[1];
    const value = pid ? entries[Number(pid)] : undefined;
    if (value instanceof Error) throw value;
    if (value === undefined)
      throw Object.assign(new Error('Process disappeared'), { code: 'ENOENT' });
    return value;
  });
  return list;
}

describe('process ownership', () => {
  it('distinguishes a live owner from a reused pid identity', () => {
    const identity = processIdentity(process.pid);
    expect(identity).toBeTruthy();
    expect(isProcessOwnerAlive({ pid: process.pid, processIdentity: identity })).toBe(true);
    expect(isProcessOwnerAlive({ pid: process.pid, processIdentity: 'different process' })).toBe(
      false,
    );
    expect(isProcessOwnerAlive({ pid: -1 })).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')(
    'recognizes an actual unreaped Linux zombie and its group',
    async () => {
      const directory = fs.mkdtempSync(join(tmpdir(), 'mearl-zombie-'));
      const release = join(directory, 'release');
      const parent = spawn(
        process.execPath,
        [
          '-e',
          `
      const {spawn} = require('node:child_process');
      const {existsSync, writeSync} = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {detached:true,stdio:'ignore'});
      child.once('exit', () => process.exit(0));
      writeSync(1, String(child.pid) + '\\n');
      const clock = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 10000;
      // Keep libuv from reaping the child until the observing test releases this parent.
      while (!existsSync(process.argv[1]) && Date.now() < deadline) Atomics.wait(clock, 0, 0, 10);
    `,
          release,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exited = once(parent, 'exit');
      const lines = createInterface({ input: parent.stdout });
      try {
        const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(10000) });
        const pid = Number(line);
        expect(pid).toBeGreaterThan(0);
        await vi.waitFor(
          () => expect(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')).toMatch(/\) Z /),
          { timeout: 5000 },
        );
        expect(process.kill(pid, 0)).toBe(true);
        expect(process.kill(-pid, 0)).toBe(true);
        expect(isAlive(pid)).toBe(false);
        // This fixture owns the group's sole member. Unreadable system processes
        // intentionally keep a general procfs scan uncertain.
        vi.spyOn(fs, 'readdirSync').mockReturnValue([String(pid)] as unknown as ReturnType<
          typeof fs.readdirSync
        >);
        expect(isProcessGroupAlive(pid)).toBe(false);
      } finally {
        fs.writeFileSync(release, 'release');
        lines.close();
        await exited;
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    15000,
  );
});

describe('Linux process liveness', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });

  it.each(['R', 'S', 'D', 'T', 't'])('keeps %s processes alive', state => {
    proc({ 12: stat(12, state) });
    expect(isAlive(12)).toBe(true);
  });

  it.each(['Z', 'X', 'x'])(
    'recognizes an exited %s owner while its pid remains allocated',
    state => {
      proc({ 12: stat(12, state) });
      expect(process.kill(12, 0)).toBe(true);
      expect(isAlive(12)).toBe(false);
      expect(isProcessOwnerAlive({ pid: 12, processIdentity: '12345' })).toBe(false);
    },
  );

  it('parses creation identity when the command name contains spaces and parentheses', () => {
    proc({ 12: stat(12, 'S') });
    expect(processIdentity(12)).toBe('12345');
    expect(isProcessOwnerAlive({ pid: 12, processIdentity: '12345' })).toBe(true);
    expect(isProcessOwnerAlive({ pid: 12, processIdentity: 'different' })).toBe(false);
  });

  it('confirms groups containing only exited members without waiting for init to reap them', () => {
    proc({ 12: stat(12, 'Z'), 13: stat(13, 'Z', 12), 20: stat(20, 'S') });
    expect(isProcessGroupAlive(12)).toBe(false);
  });

  it('keeps a group active while a descendant survives its exited owner', () => {
    proc({ 12: stat(12, 'Z'), 13: stat(13, 'S', 12) });
    expect(isProcessOwnerAlive({ pid: 12 })).toBe(false);
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it('keeps descendants active even after the owner has been reaped', () => {
    proc({ 13: stat(13, 'T', 12) });
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it('retains a zombie thread-group leader while other threads remain', () => {
    proc({ 12: stat(12, 'Z', 12, '12345', 2) });
    expect(isAlive(12)).toBe(true);
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it('retains uncertain groups when membership changes during inspection', () => {
    const list = proc({ 12: stat(12, 'Z'), 13: stat(13, 'Z', 12) });
    list.mockReturnValueOnce(['12'] as unknown as ReturnType<typeof fs.readdirSync>);
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it('retains uncertainty when a group member pid is reused during inspection', () => {
    proc({ 12: stat(12, 'Z') });
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(stat(12, 'Z'))
      .mockReturnValueOnce(stat(12, 'Z', 12, '67890'));
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it.each([Object.assign(new Error('Permission denied'), { code: 'EACCES' }), 'invalid stat'])(
    'keeps owners and groups active when inspection is unavailable: %s',
    failure => {
      proc({ 12: failure });
      expect(isAlive(12)).toBe(true);
      expect(isProcessGroupAlive(12)).toBe(true);
    },
  );

  it('does not infer an absent group from a partial procfs view', () => {
    proc({ 20: stat(20, 'S') });
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it('retains uncertainty when another visible process cannot be inspected', () => {
    proc({
      12: stat(12, 'Z'),
      20: Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    });
    expect(isAlive(12)).toBe(false);
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it('retains permission failures even when visible group members have exited', () => {
    proc({ 12: stat(12, 'Z') });
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    });
    expect(isAlive(12)).toBe(true);
    expect(isProcessGroupAlive(12)).toBe(true);
  });

  it('recognizes a group that disappears while procfs is scanned', () => {
    proc({});
    vi.mocked(process.kill)
      .mockReturnValueOnce(true)
      .mockImplementation(() => {
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      });
    expect(isProcessGroupAlive(12)).toBe(false);
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid process identities: %s', pid => {
    expect(isAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);
    expect(process.kill).not.toHaveBeenCalled();
  });
});
