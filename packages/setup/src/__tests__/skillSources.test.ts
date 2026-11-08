import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPlugin, OFFICIAL_PLUGIN_MANAGER } from '@mearl/client/plugin';
import { runCommand } from '@mearl/daemon-core';
import {
  checkTrackedSkillUpdates,
  hashSkillDirectory,
  inspectGlobalSkill,
  readLinkedSkillSource,
  matchesTrackedSkillSource,
  readTrackedSkillSources,
} from '../skillSources.js';

let directory: string;
let repository: string;
let homeDirectory: string;
let workspace: string;
let globalLock: string;
let projectLock: string;
function git(...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      `core.hooksPath=${join(directory, 'hooks')}`,
      ...args,
    ],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mearl-skill-source-test-'));
  repository = join(directory, 'repository');
  homeDirectory = join(directory, 'user');
  workspace = join(directory, 'workspace');
  await mkdir(repository);
  await mkdir(workspace);
  await mkdir(join(directory, 'hooks'));
  git('init', '-b', 'main');
  const source = join(repository, 'skills', 'sample');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: sample\ndescription: Fixture\n---\n');
  await writeFile(join(source, 'main.mjs'), 'export const value = 1;');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const sourceUrl = pathToFileURL(repository).href;
  globalLock = join(homeDirectory, '.agents', '.skill-lock.json');
  projectLock = join(workspace, 'skills-lock.json');
  await mkdir(dirname(globalLock), { recursive: true });
  await cp(source, join(homeDirectory, '.agents', 'skills', 'sample'), { recursive: true });
  await writeFile(
    globalLock,
    JSON.stringify({
      version: 3,
      skills: {
        sample: {
          sourceUrl,
          sourceType: 'git',
          ref: 'main',
          skillPath: 'skills/sample/SKILL.md',
          skillFolderHash: git('rev-parse', 'HEAD:skills/sample'),
        },
      },
    }),
  );
  await writeFile(
    projectLock,
    JSON.stringify({
      version: 1,
      skills: {
        sample: {
          source: sourceUrl,
          sourceType: 'git',
          ref: 'main',
          computedHash: await hashSkillDirectory(source),
        },
      },
    }),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const env = () => ({ ...process.env, XDG_STATE_HOME: undefined });

describe('read-only standard Skills source comparison', () => {
  it('compares global Git trees and project content in one checkout without modifying Skills or locks', async () => {
    const before = await Promise.all([readFile(globalLock, 'utf8'), readFile(projectLock, 'utf8')]);
    const runner = vi.fn(runCommand);
    await expect(
      checkTrackedSkillUpdates({ cwd: workspace, homeDirectory, env: env(), runCommand: runner }),
    ).resolves.toEqual([]);
    expect(runner.mock.calls.filter(([, args]) => args[0] === 'clone')).toHaveLength(1);
    expect(
      await Promise.all([readFile(globalLock, 'utf8'), readFile(projectLock, 'utf8')]),
    ).toEqual(before);
    await writeFile(join(repository, 'skills', 'sample', 'main.mjs'), 'export const value = 2;');
    git('add', '.');
    git('commit', '-m', 'updated fixture');
    const updates = await checkTrackedSkillUpdates({ cwd: workspace, homeDirectory, env: env() });
    expect(updates.map(update => [update.name, update.scope])).toEqual([
      ['sample', 'global'],
      ['sample', 'project'],
    ]);
    expect(
      await readFile(join(homeDirectory, '.agents', 'skills', 'sample', 'main.mjs'), 'utf8'),
    ).toBe('export const value = 1;');
  });
  it('accepts a global content hash written by the standard CLI for non-GitHub Git sources', async () => {
    const lock = JSON.parse(await readFile(globalLock, 'utf8'));
    lock.skills.sample.skillFolderHash = await hashSkillDirectory(
      join(repository, 'skills', 'sample'),
    );
    await writeFile(globalLock, JSON.stringify(lock));
    expect(
      readTrackedSkillSources('global', undefined, { homeDirectory, env: env() })[0].hashKind,
    ).toBe('folder');
    await expect(checkTrackedSkillUpdates({ homeDirectory, env: env() })).resolves.toEqual([]);
    await writeFile(join(repository, 'skills', 'sample', 'main.mjs'), 'export const value = 3;');
    git('add', '.');
    git('commit', '-m', 'content update');
    await expect(checkTrackedSkillUpdates({ homeDirectory, env: env() })).resolves.toEqual([
      { name: 'sample', source: lock.skills.sample.sourceUrl, scope: 'global' },
    ]);
  });
  it('does not report updates because a tracked Skill is disabled', async () => {
    const manifest = join(homeDirectory, '.agents', 'skills', 'sample', 'SKILL.md');
    await rename(manifest, manifest + '.mearl-disabled');
    await expect(checkTrackedSkillUpdates({ homeDirectory, env: env() })).resolves.toEqual([]);
  });
  it('reports unavailable sources as a check failure rather than claiming everything is current', async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'offline' }));
    await expect(
      checkTrackedSkillUpdates({ homeDirectory, env: env(), runCommand: runner }),
    ).rejects.toThrow('Unable to inspect');
    expect(JSON.parse(await readFile(globalLock, 'utf8')).skills.sample).toBeDefined();
  });
  it('rejects source-lock names that escape the installed Skill directory', async () => {
    await writeFile(
      globalLock,
      JSON.stringify({ skills: { '../outside': { source: pathToFileURL(repository).href } } }),
    );
    expect(() =>
      readTrackedSkillSources('global', undefined, { homeDirectory, env: env() }),
    ).toThrow('name');
  });
  it('does not reinterpret a custom source kind as a GitHub shorthand or claim it was checked', async () => {
    await writeFile(
      globalLock,
      JSON.stringify({
        skills: { sample: { source: 'example/private', sourceType: 'custom-catalog' } },
      }),
    );
    const before = await readFile(globalLock, 'utf8');
    const runner = vi.fn(runCommand);
    expect(
      readTrackedSkillSources('global', undefined, { homeDirectory, env: env() })[0].sourceType,
    ).toBe('custom-catalog');
    await expect(
      checkTrackedSkillUpdates({ homeDirectory, env: env(), runCommand: runner }),
    ).rejects.toThrow('external manager');
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(globalLock, 'utf8')).toBe(before);
  });
});

describe('developer Skill source receipts', () => {
  it('uses a tracked Git checkout for a directory link without writing source locks', async () => {
    const link = join(directory, 'linked-sample');
    await symlink(join(repository, 'skills/sample'), link, 'dir');
    git('remote', 'add', 'origin', 'git@github.com:example/skills.git');
    const receipt = readLinkedSkillSource(link, 'sample');
    expect(receipt).toMatchObject({
      name: 'sample',
      source: 'git@github.com:example/skills.git',
      skillPath: 'skills/sample/SKILL.md',
      scope: 'global',
    });
    expect(matchesTrackedSkillSource('https://github.com/example/skills', receipt!)).toBe(true);
    expect(matchesTrackedSkillSource('example/other', receipt!)).toBe(false);
    expect(readLinkedSkillSource(join(repository, 'skills/sample'), 'sample')).toBeUndefined();
    git('rm', '--cached', 'skills/sample/SKILL.md');
    expect(readLinkedSkillSource(link, 'sample')).toBeUndefined();
  });
  it('does not infer a source for links outside Git or without an origin', async () => {
    const target = join(directory, 'loose'),
      link = join(directory, 'linked');
    await mkdir(target);
    await writeFile(join(target, 'SKILL.md'), '---\nname: sample\n---\n');
    await symlink(target, link, 'dir');
    expect(readLinkedSkillSource(link, 'sample')).toBeUndefined();
    const gitLink = join(directory, 'linked-git');
    await symlink(join(repository, 'skills/sample'), gitLink, 'dir');
    expect(readLinkedSkillSource(gitLink, 'sample')).toBeUndefined();
  });
});

it('keeps lock precedence and ref requirements when accepting a development link', async () => {
  const installed = join(homeDirectory, '.agents/skills/sample');
  await rm(installed, { recursive: true });
  await symlink(join(repository, 'skills/sample'), installed, 'dir');
  git('remote', 'add', 'origin', 'https://github.com/example/skills.git');
  const before = await readFile(globalLock, 'utf8');
  const options = { homeDirectory, readSources: () => [] };
  expect(inspectGlobalSkill('example/skills', 'sample', undefined, options)).toEqual({
    state: 'ready',
  });
  expect(
    inspectGlobalSkill('example/skills', 'sample', undefined, {
      ...options,
      readSources: () => [
        {
          name: 'sample',
          source: 'example/other',
          scope: 'global' as const,
          hashKind: 'folder' as const,
        },
      ],
    }),
  ).toEqual({ state: 'conflict', reason: 'SKILL_SOURCE_CONFLICT' });
  for (const source of [
    'example/skills#main',
    'https://github.com/example/skills/tree/main/skills',
    'https://github.com/example/skills/blob/main/skills/sample/SKILL.md',
  ])
    expect(inspectGlobalSkill(source, 'sample', undefined, options)).toEqual({
      state: 'conflict',
      reason: 'SKILL_SOURCE_UNKNOWN',
    });
  expect(await readFile(globalLock, 'utf8')).toBe(before);
});

describe('setup-owned Skill source migration', () => {
  async function legacy(managedBy?: string) {
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'plugins'));
    const scripts = join(homeDirectory, '.agents/skills/sample/scripts');
    await mkdir(scripts, { recursive: true });
    const entry = join(scripts, 'main.mjs');
    await writeFile(entry, 'export default app=>app.command("read",()=>({}));');
    registerPlugin('sample', entry, undefined, { managedBy });
    return entry;
  }
  const receipt = (patch = {}) => [
    {
      name: 'sample',
      source: 'https://github.com/example/skills.git',
      ref: 'legacy',
      scope: 'global' as const,
      hashKind: 'folder' as const,
      ...patch,
    },
  ];
  const inspect = (patch = {}) =>
    inspectGlobalSkill('example/skills#next', 'sample', '^3', {
      homeDirectory,
      readSources: () => receipt(),
      migrateFrom: ['example/skills#legacy'],
      ...patch,
    });
  afterEach(() => vi.unstubAllEnvs());

  it('marks only a declared, receipt-backed setup installation for migration, including disabled Skills', async () => {
    await legacy(OFFICIAL_PLUGIN_MANAGER);
    expect(inspect()).toEqual({ state: 'migration', reason: 'SKILL_SOURCE_MIGRATION_REQUIRED' });
    const installed = join(homeDirectory, '.agents/skills/sample/SKILL.md');
    await rename(installed, installed + '.mearl-disabled');
    expect(inspect()).toEqual({ state: 'migration', reason: 'SKILL_SOURCE_MIGRATION_REQUIRED' });
  });

  it('installs the requested ref when an existing same-repository receipt omits its ref', () => {
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'plugins'));
    const options = { migrateFrom: [], readSources: () => receipt({ ref: undefined }) };
    expect(inspect(options)).toEqual({
      state: 'migration',
      reason: 'SKILL_SOURCE_MIGRATION_REQUIRED',
    });
    expect(
      inspect({
        ...options,
        readSources: () =>
          receipt({ ref: undefined, source: 'https://github.com/example/other.git' }),
      }).state,
    ).toBe('conflict');
    expect(
      inspect({
        ...options,
        readSources: () =>
          receipt({ ref: undefined, source: 'https://github.com/example/skills.git#release' }),
      }).state,
    ).toBe('conflict');
  });

  it.each([undefined, 'custom-manager'])(
    'preserves manual or other-manager registration: %s',
    async managedBy => {
      await legacy(managedBy);
      expect(inspect()).toEqual({ state: 'conflict', reason: 'SKILL_SOURCE_CONFLICT' });
      expect(inspect({ readSources: () => receipt({ ref: undefined }) }).state).toBe('conflict');
    },
  );

  it('requires a legacy source receipt and keeps ref, identity and declared-source boundaries', async () => {
    await legacy(OFFICIAL_PLUGIN_MANAGER);
    for (const patch of [
      { migrateFrom: [] },
      { readSources: () => receipt({ source: 'example/other' }) },
      { readSources: () => receipt({ ref: 'release' }) },
      { readSources: () => [] },
    ])
      expect(inspect(patch).state).toBe('conflict');
    await writeFile(
      join(homeDirectory, '.agents/skills/sample/SKILL.md'),
      '---\nname: another\n---\n',
    );
    expect(inspect().state).toBe('conflict');
  });

  it.each([false, true])(
    'preserves a manual symlink alias even when its entry is missing: %s',
    async missing => {
      const entry = await legacy(OFFICIAL_PLUGIN_MANAGER);
      const alias = join(directory, 'alias');
      await symlink(dirname(dirname(entry)), alias, 'dir');
      registerPlugin('my-alias', join(alias, 'scripts/main.mjs'));
      if (missing) await rm(entry);
      expect(inspect()).toEqual({ state: 'conflict', reason: 'SKILL_SOURCE_CONFLICT' });
    },
  );
});
