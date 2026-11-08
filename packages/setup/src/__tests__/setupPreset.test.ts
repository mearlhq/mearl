import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PresetInstaller } from '../preset.js';
import { prepareSetupPreset } from '../setupPreset.js';

let directory: string;
const source = 'https://assets.example.test/preset.json';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mearl-setup-preset-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture() {
  const load = vi.fn(async () => new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, id: 'team', version: '1.0.0' })));
  const installer = new PresetInstaller({ directory, load, hosts: () => [] });
  return { load, installer };
}
it('leaves a fresh installation empty unless a source or distribution fallback is provided', async () => {
  const f = fixture();
  expect(await prepareSetupPreset({}, f)).toBeUndefined();
  expect(f.load).not.toHaveBeenCalled();
  expect(await prepareSetupPreset({ fallbackSource: source }, f)).toBeDefined();
});
it('resumes exact accepted resources and overrides without downloading or replacing with defaults', async () => {
  const f = fixture();
  await f.installer.stage(source, { overrides: { user: { choice: true } } });
  f.load.mockClear();
  const plan = await prepareSetupPreset({ fallbackSource: 'https://other.example.test/preset.json' }, f);
  expect((await plan!.activate()).ready).toBe(true);
  expect((await f.installer.store.current()).receipt?.overrides).toEqual({ user: { choice: true } });
  expect(f.load).not.toHaveBeenCalled();
});
it('gives an explicit source priority over an accepted selection', async () => {
  const f = fixture();
  await f.installer.stage(source);
  f.load.mockClear();
  const explicit = 'https://assets.example.test/explicit.json';
  await prepareSetupPreset({ source: explicit, fallbackSource: source }, f);
  expect((await f.installer.store.current()).receipt?.snapshot.source).toBe(explicit);
  expect(f.load).toHaveBeenCalledOnce();
});
it('propagates source failures without choosing another preset', async () => {
  const f = fixture(); f.load.mockRejectedValueOnce(new Error('offline'));
  await expect(prepareSetupPreset({ source, fallbackSource: source }, f)).rejects.toThrow('offline');
  expect((await f.installer.store.current()).activation).toBeUndefined();
});
