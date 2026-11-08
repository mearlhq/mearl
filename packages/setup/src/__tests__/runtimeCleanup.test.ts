import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  cleanupPluginRuntime: vi.fn(async () => {}),
  pluginDirectory: () => join(home, customRegistry ? 'custom' : '.mearl/plugins'),
}));
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

it('removes generated caches and dead session records while retaining user and browser state', async () => {
  const removed = [
    'managed-browsers/aaaaaaaaaaaaaaaa.log',
  ].map(file);
  const kept = [
    'adapter-sdk/module.js',
    'image-tool/objects/image',
    'notes/note.json',
    'notebook-skill/notebook.json',
    'config.json',
    'managed-profiles/profile/data',
    'design-overlay/export.png',
    'cdp-targets/aaaaaaaaaaaaaaaa.json',
  ].map(file);
  const root = join(home, '.mearl/plugin-pages/aaaaaaaaaaaaaaaa.json.d');
  mkdirSync(root, { recursive: true });
  const dead = join(root, 'session-aaaaaaaaaaaaaaaa.json');
  const live = join(root, 'session-bbbbbbbbbbbbbbbb.json');
  const persistent = join(root, 'persistent-aaaaaaaaaaaaaaaa.json');
  writeRecord(dead, { pid: 2147483647, identity: 'old' });
  writeRecord(live, { pid: process.pid, identity: 'current' });
  writeRecord(persistent, { pid: 2147483647, value: 'user rule' });
  await cleanupUninstalledRuntime();
  expect(cleanupPluginRuntime).toHaveBeenCalledOnce();
  for (const path of [...removed, dead]) expect(existsSync(path)).toBe(false);
  for (const path of [...kept, live, persistent]) expect(existsSync(path)).toBe(true);
});

it('isolates custom plugin registries from default runtime caches', async () => {
  customRegistry = true;
  const cache = file('managed-browsers/aaaaaaaaaaaaaaaa.log');
  await cleanupUninstalledRuntime();
  expect(existsSync(cache)).toBe(true);
});

it('retains shared SDK caches while a Provider is still running', async () => {
  const cache = file('managed-browsers/aaaaaaaaaaaaaaaa.log');
  const lease = file('providers/live/aaaaaaaaaaaaaaaa.json');
  writeRecord(lease, { pid: process.pid });
  await expect(cleanupUninstalledRuntime()).rejects.toThrow('Providers still use');
  expect(existsSync(cache)).toBe(true);
});
