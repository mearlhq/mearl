import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginTaskManager } from '../pluginTaskManager.js';
import type { PluginRevision } from '../pluginRevision.js';

let directory: string;
let manager: PluginTaskManager;
const revision = (id = 'source-one', installationId = 'installation-one'): PluginRevision => ({
  plugin: 'fixture',
  installationId,
  revision: id,
  originalRoot: '/fixture',
  entry: '/fixture/main.mjs',
  registration: { entry: '/fixture/main.mjs' },
});
const declaration = () => ({
  pageRuntime: {
    version: 1,
    matches: ['https://example.test/*'],
    code: 'host => ({receive: message => message})',
  },
});
const describeCached = (source = revision(), signal = new AbortController().signal) =>
  manager.describeRevision(source, signal, { cache: true });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-descriptions-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', directory);
});
afterEach(async () => {
  await manager?.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('immutable plugin declarations', () => {
  it('reuses declarations across page and state callers without exposing cached objects', async () => {
    const execute = vi.fn().mockImplementation(async () => declaration());
    manager = new PluginTaskManager({ execute });
    const first = await describeCached();
    first.pageRuntime!.matches.push('https://mutated.test/*');
    const second = await describeCached();
    expect(second.pageRuntime!.matches).toEqual(['https://example.test/*']);
    second.pageRuntime!.code = 'changed';
    expect((await describeCached()).pageRuntime!.code).toBe(declaration().pageRuntime.code);
    expect(execute).toHaveBeenCalledOnce();
    await describeCached(revision('source-two'));
    await describeCached(revision('source-one', 'installation-two'));
    expect(execute).toHaveBeenCalledTimes(3);
    await manager.describeRevision(revision(), new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('does not retain failures or ignore cancellation on cached reads', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockImplementation(async () => declaration());
    manager = new PluginTaskManager({ execute });
    await expect(describeCached()).rejects.toThrow('unavailable');
    await expect(describeCached()).resolves.toEqual(declaration());
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    await expect(describeCached(revision(), cancelled.signal)).rejects.toThrow('cancelled');
    expect(execute).toHaveBeenCalledTimes(2);
    await manager.close();
    await expect(describeCached()).rejects.toThrow();
  });

  it('bounds revision retention and evicts the least recently used declaration', async () => {
    const execute = vi.fn().mockImplementation(async () => declaration());
    manager = new PluginTaskManager({ execute });
    for (let index = 0; index < 64; index++) await describeCached(revision(String(index)));
    await describeCached(revision('0'));
    await describeCached(revision('64'));
    await describeCached(revision('0'));
    expect(execute).toHaveBeenCalledTimes(65);
    await describeCached(revision('1'));
    expect(execute).toHaveBeenCalledTimes(66);
  });

  it('bounds cached declaration bytes and retries an execution cancelled before completion', async () => {
    const execute = vi
      .fn()
      .mockImplementation(async () => ({ ...declaration(), padding: 'a'.repeat(5 * 1024 * 1024) }));
    manager = new PluginTaskManager({ execute });
    await describeCached(revision('large-one'));
    await describeCached(revision('large-two'));
    await describeCached(revision('large-one'));
    expect(execute).toHaveBeenCalledTimes(3);
    const cancelled = new AbortController();
    execute.mockImplementationOnce(async () => {
      cancelled.abort(new Error('cancelled during load'));
      return declaration();
    });
    await expect(describeCached(revision('cancelled'), cancelled.signal)).rejects.toThrow(
      'cancelled during load',
    );
    await describeCached(revision('cancelled'));
    expect(execute).toHaveBeenCalledTimes(5);
  });
});
