import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeRecord } from '@mearl/daemon-core';

let home: string;
let customRegistry = false;
const state = vi.hoisted(() => ({ home: '/tmp/mearl-cleanup-unused' }));
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => state.home,
}));
vi.mock('@mearl/client/plugin', () => ({
  cleanupPluginRuntime: vi.fn(async ({ removeData }: { removeData: () => void }) => removeData()),
  pluginDirectory: () => join(home, customRegistry ? 'custom' : '.mearl/plugins'),
}));
vi.mock('@mearl/provider/host', () => ({ listInstalledProviders: () => [] }));
import { cleanupUninstalledRuntime } from '../runtimeCleanup.js';
import { cleanupPluginRuntime } from '@mearl/client/plugin';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mearl-setup-cleanup-'));
  state.home = home;
  customRegistry = false;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});
function file(path: string) {
  const target = join(home, '.mearl', path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'content');
  return target;
}

it('deletes the entire data directory, including preset resources and user data', async () => {
  for (const path of [
    'capabilities/active-node.json',
    'capabilities/rollback.json',
    'capabilities/installations/receipt.json',
    'capabilities/blobs/resource.bin',
    'cli-auto-update-state.json',
    'chrome-extension/manifest.json',
    'plugins/.host/state/preferences.json',
    'providers/data/private.json',
    'providers/live/aaaaaaaaaaaaaaaa.json',
    'providers/installed/incomplete.json',
    'notes/note.json',
    'config.json',
    'managed-profiles/profile/data',
    'plugin-pages/aaaaaaaaaaaaaaaa.json.d/persistent-bbbbbbbbbbbbbbbb.json',
    'unknown/old-file',
  ])
    file(path);
  const sibling = join(home, 'other.txt');
  writeFileSync(sibling, 'outside Mearl');
  await cleanupUninstalledRuntime();
  expect(cleanupPluginRuntime).toHaveBeenCalledExactlyOnceWith({
    removeData: expect.any(Function),
    defaultRegistry: join(home, '.mearl', 'plugins'),
  });
  expect(existsSync(join(home, '.mearl'))).toBe(false);
  expect(existsSync(sibling)).toBe(true);
  await cleanupUninstalledRuntime();
  expect(existsSync(join(home, '.mearl'))).toBe(false);
});

it('deletes default data with a separate plugin registry without recursively deleting that registry', async () => {
  customRegistry = true;
  const external = join(home, 'custom');
  mkdirSync(external);
  writeFileSync(join(external, 'personal.txt'), 'personal');
  file('notes/note.json');
  await cleanupUninstalledRuntime();
  expect(cleanupPluginRuntime).toHaveBeenCalledExactlyOnceWith({
    removeData: expect.any(Function),
    defaultRegistry: join(home, '.mearl', 'plugins'),
  });
  expect(existsSync(join(home, '.mearl'))).toBe(false);
  expect(existsSync(join(external, 'personal.txt'))).toBe(true);
});

it('unlinks a symlinked data directory without traversing it', async () => {
  const target = join(home, 'target');
  mkdirSync(target);
  const userData = join(target, 'personal.txt');
  writeFileSync(userData, 'personal');
  symlinkSync(target, join(home, '.mearl'), 'junction');
  await cleanupUninstalledRuntime();
  expect(existsSync(join(home, '.mearl'))).toBe(false);
  expect(existsSync(userData)).toBe(true);
  expect(cleanupPluginRuntime).not.toHaveBeenCalled();
});

it.each([
  ['providers/live', 'Providers are still running'],
  ['providers/starting', 'Providers are still running'],
  ['managed-browsers', 'Managed browsers are still running'],
  ['connectors', 'Cloud connectors are still running'],
  ['browsers', 'Could not stop Mearl Native Host'],
])(
  'retains the directory while %s has an owner that cannot be stopped',
  async (directory, error) => {
    const note = file('notes/note.json');
    const lease = file(`${directory}/aaaaaaaaaaaaaaaa.json`);
    writeRecord(lease, { pid: process.pid, transport: 'extension' });
    await expect(cleanupUninstalledRuntime()).rejects.toThrow(error);
    expect(existsSync(note)).toBe(true);
    expect(cleanupPluginRuntime).not.toHaveBeenCalled();
  },
);

it('keeps local data available for retry when the plugin service cannot stop', async () => {
  vi.mocked(cleanupPluginRuntime).mockRejectedValueOnce(new Error('plugin service still running'));
  const note = file('notes/note.json');
  await expect(cleanupUninstalledRuntime()).rejects.toThrow('plugin service still running');
  expect(existsSync(note)).toBe(true);
});

it('rechecks for processes that start while the plugin service stops', async () => {
  const note = file('notes/note.json');
  vi.mocked(cleanupPluginRuntime).mockImplementationOnce(async options => {
    writeRecord(file('providers/starting/aaaaaaaaaaaaaaaa.json'), { pid: process.pid });
    options?.removeData?.();
  });
  await expect(cleanupUninstalledRuntime()).rejects.toThrow('Providers are still running');
  expect(existsSync(note)).toBe(true);
});

it('does not signal a reused PID with a Native Host name in its arguments', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', 'mearl-native-host'],
    {
      stdio: 'ignore',
    },
  );
  const exited = once(child, 'exit');
  try {
    await once(child, 'spawn');
    expect(child.pid).toBeDefined();
    writeRecord(file('browsers/aaaaaaaaaaaaaaaa.json'), {
      pid: child.pid!,
      transport: 'extension',
      socketPath: join(home, `mearl-agent-${child.pid}.sock`),
    });
    await expect(cleanupUninstalledRuntime()).rejects.toThrow('Could not stop Mearl Native Host');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    child.kill();
    await exited;
  }
});
