import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { isCommandProcessAlive, runCommand, withOwnedCommands } from '../command.js';

describe('owned installation command lifecycle', () => {
  it.runIf(process.platform !== 'win32')('terminates a slow command and its writing child before allowing a retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mearl-owned-command-'));
    try {
      const file = join(directory, 'writes');
      const child = `trap '' TERM; while :; do printf x >> "$1"; sleep 0.02; done`;
      const parent = `trap '' TERM; /bin/sh -c "$1" writer "$2" & wait`;
      const lifecycle = { started: vi.fn(), finished: vi.fn() };
      await expect(withOwnedCommands(lifecycle, () => runCommand('/bin/sh', ['-c', parent, 'parent', child, file], { capture: true, timeoutMs: 1000 }))).rejects.toThrow('timed out');
      expect(lifecycle.started).toHaveBeenCalledOnce();
      expect(lifecycle.finished).toHaveBeenCalledOnce();
      expect(isCommandProcessAlive(lifecycle.started.mock.calls[0][0])).toBe(false);
      const size = (await stat(file)).size;
      expect(size).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await stat(file)).size).toBe(size);
      await withOwnedCommands(lifecycle, () => runCommand('/bin/sh', ['-c', 'printf retry >> "$1"', 'writer', file], { capture: true, timeoutMs: 1000 }));
      expect((await readFile(file, 'utf8')).slice(size)).toBe('retry');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 10_000);
});
