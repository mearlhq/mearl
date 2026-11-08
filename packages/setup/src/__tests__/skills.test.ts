import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEARL_SKILL_SOURCE, SKILLS_CLI_PACKAGE, parseGlobalMearlSkillPaths, resolveSkillsInvocation, runGlobalMearlSkillOperation } from '../skills.js';
import type { CommandRunner } from '@mearl/daemon-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

it('clears the outer npm exec package selection before running the Skills CLI', () => {
  const environment = {
    PATH: '/usr/bin',
    npm_config_package: '@mearl/setup@3.0.0',
    npm_config_registry: 'https://registry.example.com/',
  };
  const invocation = resolveSkillsInvocation({
    env: environment,
    platform: 'linux',
    processExecPath: '/usr/bin/node',
    existsSync: candidate => candidate === '/usr/bin/npx',
  });

  expect(invocation).toMatchObject({
    command: '/usr/bin/npx',
    argsPrefix: ['-y', SKILLS_CLI_PACKAGE],
    env: { PATH: '/usr/bin', npm_config_registry: environment.npm_config_registry },
  });
  expect(invocation?.env).not.toHaveProperty('npm_config_package');
  expect(environment.npm_config_package).toBe('@mearl/setup@3.0.0');
});

vi.mock('node:os', async original => { const os = await original<typeof import('node:os')>(); return { ...os, homedir: vi.fn(os.homedir) }; });
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'mearl-public-skills-')); vi.mocked(homedir).mockReturnValue(directory); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });


describe('parseGlobalMearlSkillPaths', () => {
  it('returns unique global mearl paths only', () => {
    expect(
      parseGlobalMearlSkillPaths(
        JSON.stringify([
          { name: 'mearl', scope: 'global', path: '/skills/mearl' },
          { name: 'mearl', scope: 'global', path: '/skills/mearl' },
          { name: 'mearl', scope: 'project', path: '/project/.skills/mearl' },
          { name: 'other', scope: 'global', path: '/skills/other' },
        ]),
      ),
    ).toEqual(['/skills/mearl']);
  });
});

describe('runGlobalMearlSkillOperation', () => {
  it('installs and verifies a global skill through the resolved CLI', async () => {
    const runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === 'list'
          ? JSON.stringify([{ name: 'mearl', scope: 'global', path: '/skills/mearl' }])
          : '',
      stderr: '',
    }));

    await expect(
      runGlobalMearlSkillOperation('install', {
        env: { MEARL_SKILLS_PATH: '/tools/skills', PATH: '' },
        existsSync: candidate => candidate === '/tools/skills',
        runCommand,
        writeLine: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/skills',
      ['add', MEARL_SKILL_SOURCE, '--skill', 'mearl', '--global'],
      expect.objectContaining({ capture: false }),
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/skills',
      ['list', '--global', '--json'],
      expect.objectContaining({ capture: true }),
    );
  });

  it('reinstalls the tracked global skill from the public source on update', async () => {
    const runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === 'list'
          ? JSON.stringify([{ name: 'mearl', scope: 'global', path: '/skills/mearl' }])
          : 'Installed 1 skill',
      stderr: 'Installed 1 skill',
    }));

    await expect(
      runGlobalMearlSkillOperation('update', {
        env: { MEARL_SKILLS_PATH: '/tools/skills', PATH: '' },
        existsSync: candidate => candidate === '/tools/skills',
        runCommand,
        writeLine: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/skills',
      ['add', MEARL_SKILL_SOURCE, '--skill', 'mearl', '--global', '--yes'],
      expect.objectContaining({ capture: true }),
    );
  });

  it('passes --yes to a non-interactive skill installation', async () => {
    const runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === 'list'
          ? JSON.stringify([{ name: 'mearl', scope: 'global', path: '/skills/mearl' }])
          : '',
      stderr: '',
    }));

    await expect(
      runGlobalMearlSkillOperation('install', {
        env: { MEARL_SKILLS_PATH: '/tools/skills', PATH: '' },
        existsSync: candidate => candidate === '/tools/skills',
        runCommand,
        writeLine: vi.fn(),
        yes: true,
      }),
    ).resolves.toBe(true);

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/skills',
      ['add', MEARL_SKILL_SOURCE, '--skill', 'mearl', '--global', '--yes'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('does not report success when interactive installation was cancelled', async () => {
    const runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'list' ? '[]' : '',
      stderr: '',
    }));
    const writeLine = vi.fn();

    await expect(
      runGlobalMearlSkillOperation('install', {
        env: { MEARL_SKILLS_PATH: '/tools/skills', PATH: '' },
        existsSync: candidate => candidate === '/tools/skills',
        runCommand,
        writeLine,
      }),
    ).resolves.toBe(false);

    expect(writeLine).toHaveBeenCalledWith(
      'Skill: installation finished without a tracked global mearl skill.',
    );
  });
});


it('rejects a Skills update failure even when the CLI exits zero', async () => {
  const runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
    code: 0, stderr: '', stdout: args[0] === 'list' ? JSON.stringify([{ name: 'mearl', path: '/skills/mearl', scope: 'global' }]) : 'Failed to update 1 skill',
  }));
  await expect(runGlobalMearlSkillOperation('update', {
    env: { MEARL_SKILLS_PATH: '/tools/skills' }, existsSync: () => true,
    runCommand, writeLine: vi.fn(),
  })).resolves.toBe(false);
});
