import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareCapabilitySnapshot } from '@mearl/preset';
import { MEARL_SKILL_SOURCE, captureSkillsCli, runGlobalMearlSkillOperation } from '../skills.js';

vi.mock('node:os', async original => { const os = await original<typeof import('node:os')>(); return { ...os, homedir: vi.fn(os.homedir) }; });
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mearl-skills-cli-')); vi.mocked(homedir).mockReturnValue(directory); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function select(code: string) {
  const folder = join(directory, '.mearl', 'capabilities');
  await mkdir(join(folder, 'objects'), { recursive: true });
  const modules: Record<string, { sha256: string; byteLength: number }> = {};
  for (const [id, source] of Object.entries({ manager: code, unrelated: 'throw new Error("Browser host is unavailable")' })) {
    const sha256 = createHash('sha256').update(source).digest('hex');
    modules[id] = { sha256, byteLength: Buffer.byteLength(source) };
    await writeFile(join(folder, 'objects', sha256 + '.cjs'), source);
  }
  const snapshot = await prepareCapabilitySnapshot({ schemaVersion: 1, modules, bindings: { 'skills.manager': { module: 'manager', handler: 'manager' }, 'browser.open': { module: 'unrelated', handler: 'open' } } });
  await writeFile(join(folder, 'active-node.json'), JSON.stringify(snapshot));
  return { folder, snapshot };
}
const backend = (id: string) => `module.exports=host=>({manager:()=>({id:${JSON.stringify(id)},cli:(args,options)=>host.runCommand(${JSON.stringify(id)},args,options)})})`;
it('captures the preset manager locally and preserves arguments, terminal interaction and failure codes', async () => {
  await select(backend('custom'));
  const runCommand = vi.fn(async () => ({ code: 7, stdout: 'visible output', stderr: 'detail' }));
  const cli = await captureSkillsCli({ runCommand });
  expect(cli?.id).toBe('custom');
  expect(await cli?.run(['add', 'https://github.com/example/skills', '--skill', 'sample'], { cwd: directory, tee: true })).toEqual({ code: 7, stdout: 'visible output', stderr: 'detail' });
  expect(runCommand).toHaveBeenCalledWith('custom', ['add', 'https://github.com/example/skills', '--skill', 'sample'], { cwd: directory, tee: true });
  await select(backend('replacement'));
  await cli?.run(['list']);
  expect(runCommand).toHaveBeenLastCalledWith('custom', ['list'], undefined);
  expect((await captureSkillsCli({ runCommand }))?.id).toBe('replacement');
});
it('uses the public tool when the installed manager explicitly selects the core default', async () => {
  await select('module.exports=()=>({manager:()=>undefined})');
  const runCommand = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  const cli = await captureSkillsCli({ env: { MEARL_SKILLS_PATH: '/tools/skills' }, existsSync: () => true, runCommand });
  expect(cli?.id).toBe('skills');
  await cli?.run(['list'], { capture: true });
  expect(runCommand).toHaveBeenCalledWith('/tools/skills', ['list'], expect.objectContaining({ capture: true }));
});
it('rejects corrupt or outdated configured managers before invoking another tool', async () => {
  const { folder, snapshot } = await select(backend('custom'));
  const runCommand = vi.fn();
  await writeFile(join(folder, 'objects', snapshot.modules.manager.sha256 + '.cjs'), 'damaged');
  await expect(captureSkillsCli({ runCommand })).rejects.toThrow();
  await select('module.exports=()=>({manager:()=>({id:"custom"})})');
  await expect(captureSkillsCli({ runCommand })).rejects.toThrow('preset update');
  expect(runCommand).not.toHaveBeenCalled();
});
it('uses the same configured manager for the base public Mearl Skill and its verification', async () => {
  await select(backend('custom'));
  const runCommand = vi.fn(async (_command: string, args: string[]) => ({ code: 0, stdout: args[0] === 'list' ? JSON.stringify([{ name: 'mearl', scope: 'global', path: join(directory, '.agents', 'skills', 'mearl') }]) : '', stderr: '' }));
  expect(await runGlobalMearlSkillOperation('install', { runCommand, yes: true, writeLine: vi.fn() })).toBe(true);
  expect(runCommand.mock.calls.every(([command]) => command === 'custom')).toBe(true);
  expect(runCommand.mock.calls[0][1]).toEqual(['add', MEARL_SKILL_SOURCE, '--skill', 'mearl', '--global', '--yes']);
});

it('retains a preset-managed Mearl Skill at its declared source and ref', async () => {
  const { preparePreset } = await import('@mearl/preset/bundles');
  const { PresetInstallationStore } = await import('../presetStore.js');
  const code = backend('custom');
  const sha256 = createHash('sha256').update(code).digest('hex');
  const sources: Record<string, unknown> = {
    'https://example.test/preset.json': { schemaVersion: 1, id: 'team', version: '1.0.0', packages: { manager: { source: './bundle.json', targets: ['node'] } }, skills: { mearl: { source: 'https://github.com/example/skills#stable', version: '^3' } } },
    'https://example.test/bundle.json': { schemaVersion: 1, id: 'manager', version: '1.0.0', resources: { 'manager.cjs': { sha256, byteLength: Buffer.byteLength(code) } }, contributions: { appProfiles: [], nodeRuntimes: { 'native-host': { entry: 'manager.cjs', bindings: { 'skills.manager': 'manager' } } } } },
  };
  const prepared = await preparePreset('https://example.test/preset.json', { mearlApiVersion: '1.0.0', load: async source => new TextEncoder().encode(source.endsWith('.cjs') ? code : JSON.stringify(sources[source])) });
  const store = new PresetInstallationStore({ directory: join(directory, '.mearl', 'capabilities') });
  await store.apply(prepared, { expectedRevision: null });
  const runCommand = vi.fn();
  expect(await runGlobalMearlSkillOperation('install', { runCommand, writeLine: vi.fn() })).toBe(false);
  const skill = join(directory, '.agents', 'skills', 'mearl');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: mearl\nversion: "3.0.0"\n---\n');
  await writeFile(join(directory, '.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: { mearl: { sourceUrl: 'https://github.com/example/skills', sourceType: 'github', ref: 'stable' } } }));
  expect(await runGlobalMearlSkillOperation('install', { runCommand, writeLine: vi.fn() })).toBe(true);
  expect(await runGlobalMearlSkillOperation('update', { runCommand, writeLine: vi.fn() })).toBe(true);
  await writeFile(join(skill, 'SKILL.md'), 'x'.repeat(1024 * 1024 + 1));
  expect(await runGlobalMearlSkillOperation('update', { runCommand, writeLine: vi.fn() })).toBe(false);
  expect(runCommand).not.toHaveBeenCalled();
  expect((await store.current()).preset?.skills.mearl.source).toBe('https://github.com/example/skills#stable');
});


it('uses the manager source receipt for local CLI inspection and retains strict ref checks', async () => {
  await select('module.exports=()=>({manager:()=>({id:"custom",cli:async()=>({code:0,stdout:"",stderr:""}),readSources:()=>[{name:"sample",source:"example/skills",ref:"release",scope:"global",hashKind:"folder"}]})})');
  const skill = join(directory, '.agents/skills/sample');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: sample\nversion: 3.1.0\n---\n');
  const cli = await captureSkillsCli({ runCommand: vi.fn() });
  expect(cli?.inspectGlobal('example/skills#release', 'sample', '^3')).toEqual({ state: 'ready' });
  expect(cli?.inspectGlobal('example/skills#other', 'sample', '^3').state).toBe('conflict');
});
