import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { findOfficialPlugin, findPluginRegistration, OFFICIAL_PLUGIN_MANAGER, readOfficialPluginCatalog, registerPlugin } from '@mearl/client/plugin';
import { processIdentity } from '@mearl/daemon-core';
import { MEARL_PROVIDER_PROTOCOL_VERSION } from '@mearl/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preparePreset } from '@mearl/preset/bundles';
import { PresetInstallationStore } from '@mearl/setup/preset';
import type { TrackedSkillSource } from '@mearl/setup/skill-sources';
import { PresetComponentInstaller, runPresetProviderCommand } from '../preset-components.js';
import { AgentSkillManager } from '../agent/skill-manager.js';

let directory: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'mearl-preset-components-')));
  vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory);
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'plugins'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

async function fixture(skills: Record<string, object>, suffix = '', providers: Record<string, object> = {}, catalog?: unknown) {
  const runtime = Buffer.from('module.exports=()=>({catalog:()=>({})})');
  const sha256 = createHash('sha256').update(runtime).digest('hex');
  const preset = { schemaVersion: 1, id: 'sample', version: '1.0.0', skills, providers, ...(catalog !== undefined ? { packages: { catalog: { source: './catalog.json', targets: ['node'] } } } : {}) };
  const bundle = { schemaVersion: 1, id: 'catalog', version: '1.0.0', resources: { 'runtime.cjs': { sha256, byteLength: runtime.length } }, contributions: { appProfiles: [], nodeRuntimes: { 'native-host': { entry: 'runtime.cjs', bindings: { 'plugins.catalog': 'catalog' } } } } };
  const prepared = await preparePreset('https://fixture.test/preset.json', { mearlApiVersion: '1.0.0', load: async source => source.endsWith('.cjs') ? runtime : Buffer.from(JSON.stringify(source.endsWith('/catalog.json') ? bundle : preset)) });
  const store = new PresetInstallationStore({ directory: join(directory, 'capabilities' + suffix) });
  const receipt = await store.apply(prepared, { expectedRevision: null });
  const sources: TrackedSkillSource[] = [];
  const calls: string[][] = [];
  const run = vi.fn(async (_command: string, args: string[]) => {
    const start = args.indexOf('--skill') + 1;
    const names = args.slice(start).slice(0, args.slice(start).findIndex(value => value.startsWith('--')));
    calls.push(names);
    const source = args[args.indexOf('add') + 1];
    for (const name of names) {
      const target = join(directory, '.agents', 'skills', name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'SKILL.md'), `---\nname: ${name}\nversion: "3.1.0"\n---\n`);
      sources.push({ name, source, scope: 'global', hashKind: 'folder' });
    }
    return { stdout: 'installed', stderr: '' };
  });
  const manager = new AgentSkillManager({ run, backend: () => undefined, readSources: () => sources });
  const nodeStatus = () => ({ revision: receipt.nodeRevision, installationRevision: receipt.revision });
  const options = { store, skills: manager, nodeStatus, listProviders: () => [], ownerFile: join(directory, '.owner.json'), ...(catalog !== undefined ? { pluginCatalog: () => catalog } : {}) };
  return { prepared, store, receipt, sources, calls, run, manager, options, installer: new PresetComponentInstaller(options) };
}

function pluginEntry(skill: string, name = skill) {
  const scripts = join(directory, '.agents', 'skills', skill, 'scripts');
  mkdirSync(scripts, { recursive: true });
  const entry = join(scripts, 'main.mjs');
  writeFileSync(entry, `export const name=${JSON.stringify(name)}; export default app=>app.command('read',()=>({}));`);
  return entry;
}

describe('accepted preset external component installation', () => {
  it('prepares a Skill plugin before registering it and permits retry after setup fails', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' } });
    await f.manager.installGlobal('example/skills', 'alpha');
    const entry = pluginEntry('alpha', 'a');
    writeFileSync(entry, 'export const name="a"; export const setup=()=>{throw new Error("missing runtime")}; export default app=>app.command("read",()=>({}));');
    await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('missing runtime');
    expect(findPluginRegistration('a')).toBeUndefined();
    expect(await f.installer.status(f.receipt.revision)).toMatchObject({ components: [{ id: 'alpha', state: 'pending' }] });

    writeFileSync(entry, 'export const name="a"; export const setup=({runCommand})=>{if(typeof runCommand!=="function")throw new Error("missing runner")}; export default app=>app.command("read",()=>({}));');
    await expect(f.installer.install(f.receipt.revision)).resolves.toMatchObject({ components: [{ id: 'alpha', state: 'ready' }] });
    expect(findPluginRegistration('a')?.entry).toBe(entry);
  });

  it('does not overwrite an undeclared exported plugin name during confirmed replacement', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' } }, '', {}, { a: { description: 'A', skill: 'alpha' } });
    await f.manager.installGlobal('example/skills', 'alpha');
    pluginEntry('alpha', 'b');
    const previousA = pluginEntry('legacy-a', 'a');
    const previousB = pluginEntry('legacy-b', 'b');
    registerPlugin('a', previousA); registerPlugin('b', previousB);
    await expect(f.installer.install(f.receipt.revision, { replaceSkills: ['alpha'] })).rejects.toThrow('SKILL_PLUGIN_NAME_CONFLICT: alpha');
    expect(findPluginRegistration('a')?.entry).toBe(previousA);
    expect(findPluginRegistration('b')?.entry).toBe(previousB);
    expect(f.run).toHaveBeenCalledOnce();
  });
  it('preflights declared plugin aliases and replaces only confirmed registrations without reinstalling ready Skill files', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' }, beta: { source: 'example/skills', dependsOn: ['alpha'] } }, '', {}, { a: { description: 'A', skill: 'alpha' }, b: { description: 'B', skill: 'beta' } });
    await f.manager.installGlobal('example/skills', 'alpha');
    const installedA = pluginEntry('alpha', 'a');
    const legacyA = pluginEntry('legacy-alpha', 'a');
    const legacyB = pluginEntry('legacy-beta', 'b');
    registerPlugin('a', legacyA); registerPlugin('my-a', legacyA); registerPlugin('b', legacyB);
    expect(await f.installer.status(f.receipt.revision)).toMatchObject({ components: [{ id: 'alpha', reason: 'SKILL_PLUGIN_REGISTRATION_CONFLICT' }, { id: 'beta', reason: 'SKILL_PLUGIN_REGISTRATION_CONFLICT' }] });
    await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('SKILL_PLUGIN_REGISTRATION_CONFLICT: alpha');
    await expect(f.installer.install(f.receipt.revision, { replaceSkills: ['alpha'] })).rejects.toThrow('SKILL_PLUGIN_REGISTRATION_CONFLICT: beta');
    expect(findPluginRegistration('a')?.entry).toBe(legacyA);
    expect(f.run).toHaveBeenCalledOnce();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => { const result = await original(...args); pluginEntry('beta', 'b'); return result; });
    expect(await f.installer.install(f.receipt.revision, { replaceSkills: ['alpha', 'beta'] })).toMatchObject({ catalogReady: true, components: [{ state: 'ready' }, { state: 'ready' }] });
    expect(f.calls).toEqual([['alpha'], ['beta']]);
    expect(findPluginRegistration('a')).toMatchObject({ entry: installedA, managedBy: OFFICIAL_PLUGIN_MANAGER });
    expect(findPluginRegistration('b')).toMatchObject({ entry: join(directory, '.agents/skills/beta/scripts/main.mjs'), managedBy: OFFICIAL_PLUGIN_MANAGER });
    expect(findPluginRegistration('my-a')?.entry).toBe(legacyA);
    await f.installer.install(f.receipt.revision);
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('repairs an explicitly selected registration conflict without a catalog while retaining unrelated user aliases', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' } });
    await f.manager.installGlobal('example/skills', 'alpha');
    const installed = pluginEntry('alpha', 'tool');
    const previous = pluginEntry('previous', 'tool');
    registerPlugin('tool', previous);
    registerPlugin('custom-previous', previous);
    await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('已由其他 Skill 注册');
    expect(await f.installer.install(f.receipt.revision, { replaceSkills: ['alpha'] })).toMatchObject({ components: [{ id: 'alpha', state: 'ready' }] });
    expect(findPluginRegistration('tool')).toMatchObject({ entry: installed, managedBy: OFFICIAL_PLUGIN_MANAGER });
    expect(findPluginRegistration('custom-previous')?.entry).toBe(previous);
    expect(f.run).toHaveBeenCalledOnce();
  });
  it('marks registrations created by preset installation and repair for lifecycle management', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' } }, '', {}, { tool: { description: 'Tool', skill: 'alpha' } });
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => { const result = await original(...args); pluginEntry('alpha', 'tool'); return result; });
    expect(await f.installer.install(f.receipt.revision)).toMatchObject({ catalogReady: true });
    expect(findPluginRegistration('tool')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
    const entry = findPluginRegistration('tool')!.entry;
    registerPlugin('my-tool', entry);
    expect(await f.installer.status(f.receipt.revision)).toMatchObject({ catalogReady: true, components: [{ state: 'ready' }] });
    writeFileSync(entry, 'export const name="tool"; export default app=>app.command("read",()=>({updated:true}));');
    expect(await f.installer.install(f.receipt.revision)).toMatchObject({ catalogReady: true });
    expect(findPluginRegistration('tool')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
    expect(findPluginRegistration('my-tool')?.entry).toBe(entry);
    registerPlugin('old-tool', entry, undefined, { managedBy: OFFICIAL_PLUGIN_MANAGER });
    expect(await f.installer.status(f.receipt.revision)).toMatchObject({ components: [{ state: 'pending', reason: 'SKILL_PLUGIN_REGISTRATION_REQUIRED' }] });
    expect(await f.installer.install(f.receipt.revision)).toMatchObject({ catalogReady: true, components: [{ state: 'ready' }] });
    expect(findPluginRegistration('old-tool')).toBeUndefined();
    expect(findPluginRegistration('my-tool')?.entry).toBe(entry);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'custom-manager'])('refreshes existing user registrations without claiming ownership: %s', async managedBy => {
    const f = await fixture({ alpha: { source: 'example/skills' } });
    await f.manager.installGlobal('example/skills', 'alpha');
    const entry = pluginEntry('alpha', 'tool');
    registerPlugin('tool', entry, undefined, { managedBy });
    writeFileSync(entry, 'export const name="tool"; export default app=>app.command("read",()=>({updated:true}));');
    expect(await f.installer.install(f.receipt.revision)).toMatchObject({ components: [{ state: 'ready' }] });
    expect(findPluginRegistration('tool')?.managedBy).toBe(managedBy);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('preserves custom user aliases when a preset would replace or remove them', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' } });
    await f.manager.installGlobal('example/skills', 'alpha');
    const entry = pluginEntry('alpha', 'tool');
    registerPlugin('my-tool', entry);
    writeFileSync(entry, 'export const name="tool"; export default app=>app.command("read",()=>({updated:true}));');
    await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('SKILL_USER_PLUGIN_ALIAS_CONFLICT');
    expect(findPluginRegistration('my-tool')?.entry).toBe(entry);
    expect(findPluginRegistration('tool')).toBeUndefined();
    rmSync(entry);
    await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('SKILL_PLUGIN_REGISTRATION_REQUIRED');
    expect(findPluginRegistration('my-tool')?.entry).toBe(entry);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('migrates declared setup-owned Skills and retains disabled state and repeat readiness', async () => {
    const f = await fixture({ alpha: { source: 'example/skills#next', version: '^3', migrateFrom: ['example/skills'] } });
    const entry = pluginEntry('alpha', 'tool');
    const manifest = join(directory, '.agents/skills/alpha/SKILL.md');
    writeFileSync(manifest, '---\nname: alpha\nversion: 2.0.0\n---\n');
    renameSync(manifest, manifest + '.mearl-disabled');
    registerPlugin('tool', entry, undefined, { managedBy: OFFICIAL_PLUGIN_MANAGER });
    f.sources.push({ name: 'alpha', source: 'example/skills', scope: 'global', hashKind: 'folder' });
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => { f.sources.length = 0; return original(...args); });
    expect(await f.installer.status(f.receipt.revision)).toMatchObject({ components: [{ state: 'pending', reason: 'SKILL_SOURCE_MIGRATION_REQUIRED' }] });
    expect(await f.installer.install(f.receipt.revision)).toMatchObject({ components: [{ state: 'ready' }] });
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(manifest + '.mearl-disabled')).toBe(true);
    expect(findPluginRegistration('tool')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
    expect(await f.installer.install(f.receipt.revision)).toMatchObject({ components: [{ state: 'ready' }] });
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'custom-manager'])('rejects a manual legacy Skill before any Provider or Skill side effect: %s', async managedBy => {
    const f = await fixture({ alpha: { source: 'example/skills#next', migrateFrom: ['example/skills'] } }, '', { device: { source: '@example/device' } });
    const entry = pluginEntry('alpha', 'tool');
    writeFileSync(join(directory, '.agents/skills/alpha/SKILL.md'), '---\nname: alpha\n---\n');
    registerPlugin('tool', entry, undefined, { managedBy });
    f.sources.push({ name: 'alpha', source: 'example/skills', scope: 'global', hashKind: 'folder' });
    const installProvider = vi.fn();
    const installer = new PresetComponentInstaller({ ...f.options, installProvider });
    await expect(installer.install(f.receipt.revision)).rejects.toThrow('SKILL_SOURCE_CONFLICT');
    expect(installProvider).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(findPluginRegistration('tool')?.managedBy).toBe(managedBy);
  });

  it('ends a hung Provider command before releasing the batch for retry', async () => {
    const { receipt, options } = await fixture({}, '', { device: { source: '@example/device' } });
    const installProvider = vi.fn(async () => {
      await runPresetProviderCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)'], { timeoutMs: 100 });
      throw new Error('Unexpected command success');
    });
    const installer = new PresetComponentInstaller({ ...options, installProvider });
    await expect(installer.install(receipt.revision)).rejects.toThrow('timed out');
    expect(existsSync(options.ownerFile)).toBe(false);
    await expect(installer.install(receipt.revision)).rejects.toThrow('timed out');
    expect(installProvider).toHaveBeenCalledTimes(2);
  });

  it('checks an explicit Provider target in addition to its broader compatibility range', async () => {
    const { receipt, options } = await fixture({}, '', { device: { source: '@example/device@1.2.0', version: '^1' } });
    const root = join(directory, 'provider'); mkdirSync(root);
    const entry = join(root, 'runtime.js'); writeFileSync(entry, '');
    let manifest = { providerId: 'device', name: 'Device', version: '1.9.0', protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION, browserType: { name: 'Device', inputSchema: { type: 'object' as const, properties: {} } }, packageName: '@example/device', packageRoot: root, entryPath: entry };
    const write = () => writeFileSync(join(root, 'package.json'), JSON.stringify({ name: manifest.packageName, version: manifest.version, mearl: { provider: { ...manifest, entry: 'runtime.js' } } }));
    write();
    const installProvider = vi.fn(async () => { manifest = { ...manifest, version: '1.2.0' }; write(); return { manifest, manager: 'npm' as const }; });
    const installer = new PresetComponentInstaller({ ...options, listProviders: () => [manifest], installProvider });
    expect((await installer.status(receipt.revision)).components[0]).toMatchObject({ state: 'pending', reason: 'PROVIDER_VERSION_REQUIRED' });
    expect((await installer.install(receipt.revision)).components[0].state).toBe('ready');
    expect(installProvider).toHaveBeenCalledExactlyOnceWith('@example/device@1.2.0');
  });

  it('rejects an unverifiable Provider tag before installing any package', async () => {
    const { receipt, options, run } = await fixture({ alpha: { source: 'example/one' } }, '', { device: { source: '@example/device@beta' } });
    const installProvider = vi.fn();
    const installer = new PresetComponentInstaller({ ...options, installProvider });
    await expect(installer.install(receipt.revision)).rejects.toThrow('dist-tags require');
    expect(installProvider).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('keeps a crashed host receipt busy while its tracked command is still alive', async () => {
    const { installer, receipt, run, options } = await fixture({ alpha: { source: 'example/one' } });
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], { detached: true, stdio: 'ignore' });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    writeFileSync(options.ownerFile, JSON.stringify({ pid: 1073741824, active: true, token: 'interrupted', children: [{ pid: child.pid, group: child.pid, processIdentity: processIdentity(child.pid!) }] }));
    try {
      await expect(installer.install(receipt.revision)).rejects.toThrow('PRESET_INSTALL_BUSY');
      expect(run).not.toHaveBeenCalled();
    } finally { process.kill(-child.pid!, 'SIGKILL'); await closed; }
    await installer.install(receipt.revision);
    expect(run).toHaveBeenCalledOnce();
  });

  it('installs an independent source group once and retries from actual files without running commands again', async () => {
    const { installer, receipt, calls, run } = await fixture({ alpha: { source: 'example/skills', version: '^3' }, beta: { source: 'example/skills', version: '^3' } });
    expect((await installer.status(receipt.revision)).components.every(entry => entry.state === 'pending')).toBe(true);
    const result = await installer.install(receipt.revision);
    expect(result.components).toEqual([{ kind: 'skills', id: 'alpha', state: 'ready' }, { kind: 'skills', id: 'beta', state: 'ready' }]);
    expect(calls).toEqual([['alpha', 'beta']]);
    await installer.install(receipt.revision);
    expect(run).toHaveBeenCalledOnce();
    expect(existsSync(join(directory, '.owner.json'))).toBe(false);
  });

  it('does not group across dependencies or move a later source before its prerequisite', async () => {
    const { installer, receipt, calls } = await fixture({
      last: { source: 'example/first', dependsOn: ['middle'] },
      middle: { source: 'example/second', dependsOn: ['first'] },
      first: { source: 'example/first' },
      dependent: { source: 'example/first', dependsOn: ['last'] },
    });
    await installer.install(receipt.revision);
    expect(calls).toEqual([['first'], ['middle'], ['last'], ['dependent']]);
  });

  it('keeps completed side effects after failure and retries only the remaining component', async () => {
    const { installer, receipt, calls, run } = await fixture({ alpha: { source: 'example/one' }, beta: { source: 'example/two', dependsOn: ['alpha'] } });
    const original = run.getMockImplementation()!;
    let fail = true;
    run.mockImplementation(async (...args) => {
      if (args[1].includes('example/two') && fail) throw new Error('offline');
      return original(...args);
    });
    await expect(installer.install(receipt.revision)).rejects.toThrow('offline');
    expect((await installer.status(receipt.revision)).components.map(entry => entry.state)).toEqual(['ready', 'pending']);
    fail = false;
    await installer.install(receipt.revision);
    expect(calls).toEqual([['alpha'], ['beta']]);
  });

  it('rejects source conflicts before installing any other declared component', async () => {
    const { installer, receipt, run } = await fixture({ alpha: { source: 'example/one' }, beta: { source: 'example/two' } });
    const target = join(directory, '.agents', 'skills', 'beta');
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'SKILL.md'), '---\nname: beta\n---\n');
    await expect(installer.install(receipt.revision)).rejects.toThrow('SKILL_SOURCE_UNKNOWN: beta');
    expect(run).not.toHaveBeenCalled();
  });
  it('replaces only confirmed Skill sources and preserves disabled state while resuming missing components', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' }, beta: { source: 'example/skills' } });
    const target = join(directory, '.agents', 'skills', 'alpha');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md.mearl-disabled'), '---\nname: alpha\nversion: 2.0.0\n---\n');
    f.sources.push({ name: 'alpha', source: 'example/other', scope: 'global', hashKind: 'folder' });
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => { f.sources.length = 0; return original(...args); });
    await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('SKILL_SOURCE_CONFLICT');
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.installer.install(f.receipt.revision, { replaceSkills: ['alpha'] })).toMatchObject({ components: [{ id: 'alpha', state: 'ready' }, { id: 'beta', state: 'ready' }] });
    expect(f.calls).toEqual([['alpha', 'beta']]);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(false);
    expect(existsSync(join(target, 'SKILL.md.mearl-disabled'))).toBe(true);
    await f.installer.install(f.receipt.revision);
    expect(f.run).toHaveBeenCalledOnce();
  });
  it('does not replace an unconfirmed conflict or an undeclared Skill', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' }, beta: { source: 'example/skills' } });
    for (const name of ['alpha', 'beta']) {
      const target = join(directory, '.agents', 'skills', name);
      mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'SKILL.md'), `---\nname: ${name}\n---\n`);
      f.sources.push({ name, source: 'example/other', scope: 'global', hashKind: 'folder' });
    }
    await expect(f.installer.install(f.receipt.revision, { replaceSkills: ['alpha'] })).rejects.toThrow('SKILL_SOURCE_CONFLICT: beta');
    await expect(f.installer.install(f.receipt.revision, { replaceSkills: ['undeclared'] })).rejects.toThrow('INVALID_SKILL_REPLACEMENT_SELECTION');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('retains manifest conflict checks even for a confirmed source replacement', async () => {
    const f = await fixture({ alpha: { source: 'example/skills' } });
    const target = join(directory, '.agents', 'skills', 'alpha');
    mkdirSync(target, { recursive: true });
    for (const file of ['SKILL.md', 'SKILL.md.mearl-disabled']) writeFileSync(join(target, file), '---\nname: alpha\n---\n');
    await expect(f.installer.install(f.receipt.revision, { replaceSkills: ['alpha'] })).rejects.toThrow('SKILL_MANIFEST_CONFLICT');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('stops subsequent commands when the selected installation changes during one accepted command', async () => {
    const { installer, receipt, run, calls, store, prepared } = await fixture({ alpha: { source: 'example/one' }, beta: { source: 'example/two' } });
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (...args) => {
      const result = await original(...args);
      await store.apply(prepared, { expectedRevision: receipt.revision, overrides: { switched: true } });
      return result;
    });
    await expect(installer.install(receipt.revision)).rejects.toThrow('PRESET_SELECTION_CHANGED');
    expect(calls).toEqual([['alpha']]);
  });

  it('rejects stale and inactive Node selections before running commands', async () => {
    const { installer, receipt, options, run } = await fixture({ alpha: { source: 'example/one' } });
    await expect(installer.install('0'.repeat(64))).rejects.toThrow('PRESET_SELECTION_CHANGED');
    const inactive = new PresetComponentInstaller({ ...options, nodeStatus: () => ({ revision: null, installationRevision: null }) });
    await expect(inactive.install(receipt.revision)).rejects.toThrow('PRESET_SELECTION_CHANGED');
    expect(run).not.toHaveBeenCalled();
  });

  it('shares the owner lease across capability directories and releases it after completion', async () => {
    const first = await fixture({ alpha: { source: 'example/one' } }, '-one');
    const second = await fixture({ beta: { source: 'example/two' } }, '-two');
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const original = first.run.getMockImplementation()!;
    first.run.mockImplementation(async (...args) => { started(); await gate; return original(...args); });
    const running = first.installer.install(first.receipt.revision);
    await entered;
    await expect(second.installer.install(second.receipt.revision)).rejects.toThrow('PRESET_INSTALL_BUSY');
    expect(second.run).not.toHaveBeenCalled();
    finish(); await running;
    await second.installer.install(second.receipt.revision);
    expect(second.run).toHaveBeenCalledOnce();
  });
});

it('publishes only enabled aliases using the resolved Skill source and binds them to the accepted selection', async () => {
  const source = 'https://github.com/example/alternative#stable';
  const f = await fixture({ alpha: { source }, beta: { source: 'example/disabled', enabled: false } }, '', {}, { tool: { description: 'Tool', skill: 'alpha' }, disabled: { description: 'Disabled', skill: 'beta' } });
  expect(await f.installer.status(f.receipt.revision)).toMatchObject({ catalogReady: false });
  expect(readOfficialPluginCatalog()).toBeUndefined();
  expect(f.run).not.toHaveBeenCalled();
  expect(await f.installer.install(f.receipt.revision)).toMatchObject({ catalogReady: false });
  expect(findOfficialPlugin('tool')?.installArgs).toEqual([source, '--skill', 'alpha', '--yes']);
  expect(findOfficialPlugin('disabled')).toBeUndefined();
  const scripts = join(directory, '.agents', 'skills', 'alpha', 'scripts');
  mkdirSync(scripts);
  writeFileSync(join(scripts, 'main.mjs'), 'export const name="tool"; export default app=>app.command("read",()=>({}));');
  await f.manager.repairGlobalRegistration('alpha');
  expect(await f.installer.status(f.receipt.revision)).toMatchObject({ catalogReady: true, components: [{ id: 'alpha', state: 'ready' }] });
  expect(f.run).toHaveBeenCalledOnce();
  await f.store.apply(f.prepared, { expectedRevision: f.receipt.revision, overrides: { team: 'other' } });
  expect(findOfficialPlugin('tool')).toBeUndefined();
});
it('rejects catalog entries outside the accepted Skill declarations before running installers', async () => {
  const f = await fixture({ alpha: { source: 'example/one' } }, '', {}, { wrong: { description: 'Wrong', skill: 'unselected' } });
  await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('SKILL_UNDECLARED');
  expect(f.run).not.toHaveBeenCalled();
  expect(readOfficialPluginCatalog()).toBeUndefined();
});

it('keeps an unfinished batch catalog private and publishes it only after the accepted commands finish', async () => {
  const f = await fixture({ alpha: { source: 'example/skills' } }, '', {}, { tool: { description: 'Tool', skill: 'alpha' } });
  const original = f.run.getMockImplementation()!;
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.run.mockImplementation(async (...args) => { started(); await gate; return original(...args); });
  const running = f.installer.install(f.receipt.revision);
  await entered;
  try { expect(readOfficialPluginCatalog()).toBeUndefined(); }
  finally { finish(); }
  await running;
  expect(findOfficialPlugin('tool')?.skill).toBe('alpha');
});

it('does not publish the catalog of a batch whose Skill command failed', async () => {
  const f = await fixture({ alpha: { source: 'example/skills' } }, '', {}, { tool: { description: 'Tool', skill: 'alpha' } });
  f.run.mockRejectedValueOnce(new Error('offline'));
  await expect(f.installer.install(f.receipt.revision)).rejects.toThrow('offline');
  expect(readOfficialPluginCatalog()).toBeUndefined();
  await f.installer.install(f.receipt.revision);
  expect(findOfficialPlugin('tool')?.skill).toBe('alpha');
});
