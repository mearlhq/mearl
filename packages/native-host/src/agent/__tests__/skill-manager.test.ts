import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISABLED_SKILL_MANIFEST,
  findPluginRegistration,
  getSkillEnabled,
  setSkillEnabled,
} from '@mearl/client/plugin';
import { AgentSkillManager, type SkillCliRunner } from '../skill-manager.js';

vi.mock('node:os', async importOriginal => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn(original.homedir) };
});

function managerWith(run: SkillCliRunner): AgentSkillManager {
  return new AgentSkillManager({ run, readSources: scope => [{ name: 'notebook-skill', source: 'example/skills', scope, hashKind: 'folder' }] });
}

describe('AgentSkillManager', () => {
  it('builds a non-interactive project install command', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mearl-skill-command-'));
    const skill = join(workspace, '.agents', 'skills', 'mearl');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: mearl\n---\n');
    const run = vi.fn<SkillCliRunner>(async (_executable, _args) => ({
      stdout: 'installed',
      stderr: '',
    }));
    const manager = managerWith(run);

    await expect(
      manager.install({
        providerId: 'qoder',
        source: 'example/skills',
        name: 'mearl',
        scope: 'project',
        cwd: workspace,
      }),
    ).resolves.toEqual({ ok: true, output: 'installed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(
      expect.stringMatching(/npx(?:\.cmd)?$/),
      [
        '-y',
        'skills@1.5.0',
        'add',
        'example/skills',
        '--skill',
        'mearl',
        '--agent',
        'qoder',
        '--full-depth',
        '--yes',
      ],
      realpathSync(workspace),
    );
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe('sidebar Skill plugin registration', () => {
  let directory: string;
  let source: string;
  let installed: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mearl-sidebar-skill-'));
    vi.mocked(homedir).mockReturnValue(directory);
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'plugins'));
    source = join(directory, 'source', 'notebook-skill');
    installed = join(directory, '.agents', 'skills', 'notebook-skill');
    const entry = join(source, 'scripts', 'main.mjs');
    mkdirSync(dirname(entry), { recursive: true });
    mkdirSync(join(source, 'assets'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: notebook-skill\n---\n');
    writeFileSync(
      join(source, 'assets', 'index.html'),
      '<!doctype html><html><body><h1>Workspace Notes</h1></body></html>',
    );
    writeFileSync(
      entry,
      `
      export const name = 'notebook';
      export const toolbox = { version: 1, title: 'Workspace Notes', page: { type: 'sandbox', entry: 'assets/index.html', commands: ['list'] } };
      export default app => app.command('list', () => []);
    `,
    );
    mkdirSync(dirname(installed), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('registers a global Skill plugin when installed and unregisters it after the configured tool removes the Skill', async () => {
    const run = vi.fn<SkillCliRunner>(async (_executable, args) => {
      if (args.includes('add')) symlinkSync(source, installed, 'dir');
      if (args.includes('remove')) unlinkSync(installed);
      return { stdout: 'success', stderr: '' };
    });
    const manager = managerWith(run);
    const data = {
      providerId: 'codex' as const,
      name: 'notebook-skill',
      scope: 'global' as const,
    };

    await manager.install({ ...data, source: 'example/skills' });
    expect(findPluginRegistration('notebook')).toMatchObject({
      managedBy: 'skills',
      toolbox: { title: 'Workspace Notes' },
      pageBundle: {
        hash: expect.any(String),
        size: expect.any(Number),
        chunks: expect.any(Number),
      },
    });

    await manager.uninstall(data);
    expect(findPluginRegistration('notebook')).toBeUndefined();
    expect(existsSync(join(source, 'scripts', 'main.mjs'))).toBe(true);
  });

  it('registers a project Skill plugin and refreshes its toolbox on update', async () => {
    const workspace = join(directory, 'workspace');
    const projectSkill = join(workspace, '.agents', 'skills', 'notebook-skill');
    mkdirSync(dirname(projectSkill), { recursive: true });
    const run = vi.fn<SkillCliRunner>(async (_executable, args) => {
      if (args.includes('add') && !existsSync(projectSkill)) symlinkSync(source, projectSkill, 'dir');
      else if (args.includes('add')) {
        writeFileSync(
          join(source, 'assets', 'index.html'),
          '<!doctype html><html><body><h1>Updated workspace notes</h1></body></html>',
        );
      }
      return { stdout: 'success', stderr: '' };
    });
    const manager = managerWith(run);
    const data = {
      providerId: 'codex' as const,
      name: 'notebook-skill',
      scope: 'project' as const,
      cwd: workspace,
    };

    await manager.install({ ...data, source: 'example/skills' });
    const originalHash = findPluginRegistration('notebook')?.pageBundle?.hash;
    await manager.update(data);
    expect(findPluginRegistration('notebook')?.pageBundle?.hash).not.toBe(originalHash);
  });

  it.each([false, true])('preserves disabled state when an update fails: %s', async fail => {
    const run = vi.fn<SkillCliRunner>(async (_executable, args) => {
      if (args.includes('add') && !existsSync(installed)) symlinkSync(source, installed, 'dir');
      else if (args.includes('add')) {
        writeFileSync(join(source, 'SKILL.md'), '# Updated Skill');
        if (fail) throw new Error('update failed');
      }
      return { stdout: 'success', stderr: '' };
    });
    const manager = managerWith(run);
    const data = {
      providerId: 'codex' as const,
      name: 'notebook-skill',
      scope: 'global' as const,
    };
    await manager.install({ ...data, source: 'example/skills' });
    setSkillEnabled(installed, false);
    if (fail) await expect(manager.update(data)).rejects.toThrow('update failed');
    else await manager.update(data);
    expect(getSkillEnabled(installed)).toBe(false);
    expect(readFileSync(join(installed, DISABLED_SKILL_MANIFEST), 'utf8')).toBe('# Updated Skill');
    expect(findPluginRegistration('notebook')?.toolbox?.title).toBe('Workspace Notes');
    setSkillEnabled(installed, true);
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe('# Updated Skill');
  });

  it('keeps a global registration when the same Skill is installed and removed in a project', async () => {
    const workspace = join(directory, 'workspace');
    const projectSkill = join(workspace, '.agents', 'skills', 'notebook-skill');
    mkdirSync(dirname(projectSkill), { recursive: true });
    const run = vi.fn<SkillCliRunner>(async (_executable, args, cwd) => {
      if (args.includes('add')) symlinkSync(source, cwd ? projectSkill : installed, 'dir');
      if (args.includes('remove') && cwd) unlinkSync(projectSkill);
      return { stdout: 'success', stderr: '' };
    });
    const manager = managerWith(run);
    const global = {
      providerId: 'codex' as const,
      name: 'notebook-skill',
      scope: 'global' as const,
    };
    const project = { ...global, scope: 'project' as const, cwd: workspace };

    await manager.install({ ...global, source: 'example/skills' });
    await expect(manager.install({ ...project, source: 'example/skills' })).rejects.toThrow(
      '已由其他 Skill 注册',
    );
    expect(findPluginRegistration('notebook')?.entry).toBe(join(installed, 'scripts', 'main.mjs'));

    await manager.uninstall(project);
    expect(findPluginRegistration('notebook')?.entry).toBe(join(installed, 'scripts', 'main.mjs'));
    expect(existsSync(installed)).toBe(true);
  });

  it('reports a missing installation path instead of silently skipping registration', async () => {
    const manager = managerWith(async () => ({ stdout: 'success', stderr: '' }));
    await expect(
      manager.install({
        providerId: 'codex',
        name: 'notebook-skill',
        source: 'example/skills',
        scope: 'global',
      }),
    ).rejects.toThrow('Skill 安装完成但找不到安装目录');
    expect(findPluginRegistration('notebook')).toBeUndefined();
  });
});

it('checks source revisions without invoking the Skills check/update command', async () => {
  const run = vi.fn<SkillCliRunner>();
  const checkUpdates = vi.fn(async () => [{ name: 'sample', scope: 'global' as const, source: 'example/skills' }]);
  const manager = new AgentSkillManager({ run, checkUpdates });
  await expect(manager.checkUpdates({ providerId: 'codex' })).resolves.toEqual({ updates: [{ name: 'sample', scope: 'global', source: 'example/skills' }] });
  expect(run).not.toHaveBeenCalled();
});
