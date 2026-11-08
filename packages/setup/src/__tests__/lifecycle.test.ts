const setupRelease = vi.hoisted(() => ({ SETUP_VERSION: '2.22.0' }));
vi.mock('../setupVersion.js', () => setupRelease);
beforeEach(() => { setupRelease.SETUP_VERSION = '2.22.0'; });
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMearlLifecycle, type MearlLifecycleDependencies } from '../lifecycle.js';
import {
  detectGlobalPackage,
  type DetectedGlobalPackage,
  type GlobalPackageManager,
} from '../packageManager.js';
import { detectMearlProfiles } from '../profiles.js';
import type { DetectedMearlProfiles, MearlProfile } from '../profiles.js';
import type { CommandRunner } from '@mearl/daemon-core';
import { OFFICIAL_NPM_REGISTRY } from '../npmRegistry.js';

function detectedPackage(
  profile: MearlProfile,
  manager: GlobalPackageManager = 'npm',
): DetectedGlobalPackage {
  const names = {
    local: ['@mearl/native-host', 'mearl-native-host'],
    cloud: ['@mearl/cloud-server', 'mearl-cloud-server'],
    mcp: ['@mearl/mcp-server', 'mearl-mcp-server'],
  } as const;
  const [packageName, binName] = names[profile];
  return {
    packageName,
    packageRoot: `/tools/${manager}/lib/node_modules/${packageName}`,
    executable: `/tools/${manager}/bin/${binName}`,
    manager,
    command: `/tools/${manager}/bin/${manager}`,
  };
}

function detectedClient(manager: GlobalPackageManager = 'npm'): DetectedGlobalPackage {
  return {
    packageName: '@mearl/client',
    packageRoot: `/tools/${manager}/lib/node_modules/@mearl/client`,
    executable: `/tools/${manager}/bin/mearl`,
    manager,
    command: `/tools/${manager}/bin/${manager}`,
  };
}

function dependencies(
  detected: DetectedMearlProfiles,
): Required<
  Pick<
    MearlLifecycleDependencies,
    | 'cleanupNativeHost'
    | 'readManagement'
    | 'claimLifecycle'
    | 'cleanupRuntime'
    | 'confirm'
    | 'detectPackage'
    | 'detectProfiles'
    | 'existsSync'
    | 'installManagedPlugins'
    | 'preparePreset'
    | 'prepareBrowserPreset'
    | 'resolveInvokingManager'
    | 'runCommand'
    | 'runSkillOperation'
    | 'uninstallManagedPlugins'
    | 'writeLine'
  >
> {
  return {
    readManagement: vi.fn(async () => ({ setup: undefined, source: undefined, revision: undefined })),
    claimLifecycle: vi.fn(() => ({ release: vi.fn(), lifecycle: { started: vi.fn(), finished: vi.fn() } })),
    cleanupNativeHost: vi.fn(() => true),
    cleanupRuntime: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    detectPackage: vi.fn(() => null),
    detectProfiles: vi.fn(() => detected),
    existsSync: vi.fn(() => true),
    installManagedPlugins: vi.fn(async () => 'skipped' as const),
    preparePreset: vi.fn(async () => undefined),
    prepareBrowserPreset: vi.fn(async () => undefined),
    resolveInvokingManager: vi.fn(() => ({
      manager: 'pnpm',
      command: '/tools/pnpm/bin/pnpm',
    })),
    runCommand: vi.fn<CommandRunner>(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
    })),
    runSkillOperation: vi.fn(async () => true),
    uninstallManagedPlugins: vi.fn(async () => 'skipped' as const),
    writeLine: vi.fn(),
  };
}

describe('runMearlLifecycle', () => {
  it.each<{
    manager: GlobalPackageManager;
    args: string[];
  }>([
    { manager: 'npm', args: ['uninstall', '-g'] },
    { manager: 'pnpm', args: ['remove', '-g'] },
    { manager: 'yarn', args: ['global', 'remove'] },
    { manager: 'bun', args: ['remove', '-g'] },
    { manager: 'volta', args: ['uninstall'] },
  ])(
    'keeps the normal $manager uninstall command for the Host and shared client',
    async ({ manager, args }) => {
      const deps = dependencies(new Map([['local', detectedPackage('local', manager)]]));
      deps.detectPackage = vi.fn(() => detectedClient(manager));
      await expect(
        runMearlLifecycle(
          { operation: 'uninstall', profile: 'local', yes: true, skipSkill: true },
          deps,
        ),
      ).resolves.toBe(true);
      expect(deps.runCommand).toHaveBeenCalledTimes(2);
      expect(deps.runCommand).toHaveBeenNthCalledWith(
        1,
        `/tools/${manager}/bin/${manager}`,
        [...args, '@mearl/native-host'],
        expect.anything(),
      );
      expect(deps.runCommand).toHaveBeenNthCalledWith(
        2,
        `/tools/${manager}/bin/${manager}`,
        [...args, '@mearl/client'],
        expect.anything(),
      );
      expect(deps.resolveInvokingManager).not.toHaveBeenCalled();
    },
  );

  it('uninstalls registered development links using their global npm prefix', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-setup-linked-uninstall-'));
    try {
      const binDirectory = join(directory, 'prefix/bin');
      mkdirSync(binDirectory, { recursive: true });
      for (const [name, bin] of [
        ['native-host', 'mearl-native-host'],
        ['client', 'mearl'],
      ]) {
        const packageRoot = join(directory, 'workspace', name);
        const registeredRoot = join(directory, 'prefix/lib/node_modules/@mearl', name);
        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        mkdirSync(join(directory, 'prefix/lib/node_modules/@mearl'), { recursive: true });
        writeFileSync(
          join(packageRoot, 'package.json'),
          JSON.stringify({ name: `@mearl/${name}` }),
        );
        writeFileSync(join(packageRoot, 'dist/bin.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
        symlinkSync(packageRoot, registeredRoot);
        symlinkSync(join(packageRoot, 'dist/bin.js'), join(binDirectory, bin));
      }
      const npmCommand = join(binDirectory, 'npm');
      writeFileSync(npmCommand, '', { mode: 0o755 });
      const deps = dependencies(new Map());
      deps.detectProfiles = vi.fn((env, options) =>
        detectMearlProfiles({ env, ...options, processExecPath: '/missing/node' }),
      );
      deps.detectPackage = vi.fn((name, bins, options) =>
        detectGlobalPackage(name, bins, { ...options, processExecPath: '/missing/node' }),
      );

      await expect(
        runMearlLifecycle(
          { operation: 'uninstall', yes: true, skipSkill: true, env: { PATH: binDirectory } },
          deps,
        ),
      ).resolves.toBe(true);
      expect(deps.cleanupNativeHost).toHaveBeenCalledExactlyOnceWith({
        mode: 'both',
        silent: true,
      });
      expect(deps.runCommand).toHaveBeenCalledWith(
        npmCommand,
        ['uninstall', '-g', '@mearl/native-host'],
        expect.anything(),
      );
      expect(deps.runCommand).toHaveBeenCalledWith(
        npmCommand,
        ['uninstall', '-g', '@mearl/client'],
        expect.anything(),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['install', 'update', 'uninstall'] as const)(
    'applies the official registry only to package downloads during %s',
    async operation => {
      const deps = dependencies(new Map([['local', detectedPackage('local')]]));
      const registry = 'https://mirror.example/';
      await expect(
        runMearlLifecycle(
          {
            operation,
            profiles: ['local'],
            yes: true,
            skipSkill: true,
            env: { ...process.env, npm_config_registry: registry },
          },
          deps,
        ),
      ).resolves.toBe(true);
      const packageCalls = deps.runCommand.mock.calls.filter(([, args]) =>
        ['install', 'uninstall'].includes(args[0]),
      );
      expect(packageCalls.length).toBeGreaterThan(0);
      for (const [, , options] of packageCalls) {
        expect(options?.env?.npm_config_registry).toBe(
          operation === 'uninstall' ? registry : OFFICIAL_NPM_REGISTRY,
        );
      }
      const hookCalls = deps.runCommand.mock.calls.filter(([, args]) => args[0] === '--init');
      for (const [, , options] of hookCalls) {
        expect(options?.env?.npm_config_registry).toBe(registry);
      }
    },
  );

  it('detects global update targets using the path from before npx starts', async () => {
    const deps = dependencies(new Map([['local', detectedPackage('local')]]));
    const env = {
      ...process.env,
      PATH: '/project/node_modules/.bin:/tools/npm/bin',
      MEARL_AUTO_UPDATE_PROFILES: 'local',
      MEARL_AUTO_UPDATE_SEARCH_PATH: '/tools/npm/bin',
    };

    await expect(
      runMearlLifecycle({ operation: 'update', skipSkill: true, env }, deps),
    ).resolves.toBe(true);
    expect(deps.detectProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ PATH: '/tools/npm/bin' }),
    );
  });

  it('updates a standalone global client from its package root when npx shadows PATH', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-setup-client-update-'));
    try {
      const packageRoot = join(directory, 'lib', 'node_modules', '@mearl', 'client');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@mearl/client' }));
      const deps = dependencies(new Map());

      await expect(
        runMearlLifecycle(
          {
            operation: 'update',
            skipSkill: true,
            targetLine: '2.19.x',
            env: { ...process.env, MEARL_AUTO_UPDATE_CLIENT_ROOT: packageRoot },
          },
          deps,
        ),
      ).resolves.toBe(true);

      expect(deps.runCommand).toHaveBeenCalledOnce();
      expect(deps.runCommand).toHaveBeenCalledWith(
        expect.any(String),
        ['install', '-g', '@mearl/client@2.19.x'],
        expect.any(Object),
      );
      expect(deps.writeLine).toHaveBeenCalledWith('update targets: client CLI');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the explicit client owner alongside a separately installed native host', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-setup-client-owner-'));
    try {
      const packageRoot = join(directory, 'lib', 'node_modules', '@mearl', 'client');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@mearl/client' }));
      const deps = dependencies(new Map([['local', detectedPackage('local', 'pnpm')]]));

      await expect(
        runMearlLifecycle(
          {
            operation: 'update',
            skipSkill: true,
            env: { ...process.env, MEARL_AUTO_UPDATE_CLIENT_ROOT: packageRoot },
          },
          deps,
        ),
      ).resolves.toBe(true);

      expect(deps.runCommand).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        ['install', '-g', '@mearl/client@latest'],
        expect.any(Object),
      );
      expect(deps.runCommand).toHaveBeenNthCalledWith(
        2,
        '/tools/pnpm/bin/pnpm',
        ['add', '-g', '@mearl/native-host@latest'],
        expect.any(Object),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps current environments untouched when only the client needs an update', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mearl-setup-client-only-'));
    try {
      const packageRoot = join(directory, 'lib', 'node_modules', '@mearl', 'client');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@mearl/client' }));
      const deps = dependencies(new Map([['local', detectedPackage('local', 'pnpm')]]));

      await expect(
        runMearlLifecycle(
          {
            operation: 'update',
            skipSkill: true,
            env: {
              ...process.env,
              MEARL_AUTO_UPDATE_CLIENT_ROOT: packageRoot,
              MEARL_AUTO_UPDATE_CLIENT_ONLY: '1',
            },
          },
          deps,
        ),
      ).resolves.toBe(true);

      expect(deps.runCommand).toHaveBeenCalledOnce();
      expect(deps.runCommand).toHaveBeenCalledWith(
        expect.any(String),
        ['install', '-g', '@mearl/client@latest'],
        expect.any(Object),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a client-only update without a valid global client root', async () => {
    const deps = dependencies(new Map([['local', detectedPackage('local')]]));
    await expect(
      runMearlLifecycle(
        {
          operation: 'update',
          env: {
            ...process.env,
            MEARL_AUTO_UPDATE_CLIENT_ROOT: '/missing/client',
            MEARL_AUTO_UPDATE_CLIENT_ONLY: '1',
          },
        },
        deps,
      ),
    ).resolves.toBe(false);
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it('preserves the running Qoder cloud mode when automatic update selects cloud', async () => {
    const deps = dependencies(new Map([['cloud', detectedPackage('cloud')]]));
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === 'status' ? '[CloudServer] Status: running\n[CloudServer] Mode: qoder\n' : '',
      stderr: '',
    }));
    const env = { ...process.env, MEARL_AUTO_UPDATE_PROFILES: 'cloud' };
    delete env.MEARL_CLOUD_MODE;

    await expect(
      runMearlLifecycle({ operation: 'update', skipSkill: true, env }, deps),
    ).resolves.toBe(true);

    const startCall = vi.mocked(deps.runCommand).mock.calls.find(call => call[1][0] === 'start');
    expect(startCall).toBeDefined();
    expect(startCall?.[2]?.env?.MEARL_CLOUD_MODE).toBeUndefined();
  });

  it('defaults install to the local environment', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));

    await expect(runMearlLifecycle({ operation: 'install' }, deps)).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/client@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/native-host@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/pnpm/bin/mearl-native-host',
      ['--init', '--mode', 'skills'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runSkillOperation).toHaveBeenCalledWith(
      'install',
      expect.objectContaining({ runCommand: expect.any(Function), yes: undefined }),
    );
    expect(deps.installManagedPlugins).toHaveBeenCalledWith({
      env: process.env,
      includeMearlSkill: true,
      mearlSkillOperation: 'install',
      runCommand: expect.any(Function),
      writeLine: deps.writeLine,
    });
    expect(deps.runCommand.mock.invocationCallOrder[2]).toBeLessThan(
      deps.runSkillOperation.mock.invocationCallOrder[0]!,
    );
  });

  it('fails setup when the configured skill batch throws', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));
    deps.installManagedPlugins = vi.fn().mockRejectedValue(new Error('optional install failed'));

    await expect(runMearlLifecycle({ operation: 'install' }, deps)).resolves.toBe(false);
    expect(deps.writeLine).toHaveBeenCalledWith(
      'Managed plugin batch: optional install failed; failed.',
    );
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
    expect(deps.writeLine).toHaveBeenLastCalledWith(
      'Mearl setup incomplete. Review the messages above.',
    );
  });

  it('uses one configured batch instead of installing the base skill separately', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));
    deps.installManagedPlugins = vi.fn(async () => 'installed' as const);

    await expect(runMearlLifecycle({ operation: 'install' }, deps)).resolves.toBe(true);

    expect(deps.installManagedPlugins).toHaveBeenCalledExactlyOnceWith({
      env: process.env,
      includeMearlSkill: true,
      mearlSkillOperation: 'install',
      runCommand: expect.any(Function),
      writeLine: deps.writeLine,
    });
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });

  it('uses one configured batch when updating the base skill and plugins', async () => {
    const deps = dependencies(new Map([['local', detectedPackage('local')]]));
    deps.installManagedPlugins = vi.fn(async () => 'installed' as const);

    await expect(runMearlLifecycle({ operation: 'update' }, deps)).resolves.toBe(true);

    expect(deps.installManagedPlugins).toHaveBeenCalledExactlyOnceWith({
      env: process.env,
      includeMearlSkill: true,
      mearlSkillOperation: 'update',
      runCommand: expect.any(Function),
      writeLine: deps.writeLine,
    });
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });

  it('does not change optional skills when skill updates are disabled or version-pinned', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));

    await expect(runMearlLifecycle({ operation: 'install', skipSkill: true }, deps)).resolves.toBe(
      true,
    );
    await expect(
      runMearlLifecycle({ operation: 'install', targetLine: '2.14.x' }, deps),
    ).resolves.toBe(true);
    expect(deps.installManagedPlugins).not.toHaveBeenCalled();
    expect(deps.uninstallManagedPlugins).not.toHaveBeenCalled();
  });

  it('installs local and cloud roles together with one unified client', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn((packageName: string) =>
      packageName === '@mearl/native-host'
        ? detectedPackage('local', 'pnpm')
        : detectedPackage('cloud', 'pnpm'),
    );
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'status' ? '[CloudServer] Status: stopped\n' : '',
      stderr: '',
    }));

    await expect(
      runMearlLifecycle({ operation: 'install', profiles: ['local', 'cloud'] }, deps),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/client@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/native-host@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      4,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/cloud-server@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runSkillOperation).toHaveBeenCalledTimes(1);
  });

  it('uses the installed client owner regardless of profile flag order', async () => {
    const deps = dependencies(
      new Map([
        ['local', detectedPackage('local', 'npm')],
        ['cloud', detectedPackage('cloud', 'pnpm')],
      ]),
    );
    deps.detectPackage = vi.fn((packageName: string) => {
      if (packageName === '@mearl/client') return detectedClient('bun');
      if (packageName === '@mearl/native-host') return detectedPackage('local', 'npm');
      if (packageName === '@mearl/cloud-server') return detectedPackage('cloud', 'pnpm');
      return null;
    });
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'status' ? '[CloudServer] Status: stopped\n' : '',
      stderr: '',
    }));

    await expect(
      runMearlLifecycle({ operation: 'update', profiles: ['cloud', 'local'] }, deps),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/bun/bin/bun',
      ['add', '-g', '@mearl/client@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/npm/bin/npm',
      ['install', '-g', '@mearl/native-host@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      4,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/cloud-server@latest'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('removes the legacy cloud client before installing the unified client', async () => {
    const deps = dependencies(new Map([['cloud', detectedPackage('cloud', 'pnpm')]]));
    deps.detectPackage = vi.fn((packageName: string) => {
      if (packageName === '@mearl/cloud-client') {
        return {
          ...detectedPackage('cloud', 'pnpm'),
          packageName,
          packageRoot: '/tools/pnpm/lib/node_modules/@mearl/cloud-client',
          executable: '/tools/pnpm/bin/mearl-cloud',
        };
      }
      return null;
    });

    await expect(runMearlLifecycle({ operation: 'update', profile: 'cloud' }, deps)).resolves.toBe(
      true,
    );

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['remove', '-g', '@mearl/cloud-client'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/client@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/cloud-server@latest'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('does not uninstall a missing unified client while removing a legacy cloud environment', async () => {
    const deps = dependencies(new Map([['cloud', detectedPackage('cloud', 'pnpm')]]));
    deps.detectPackage = vi.fn((packageName: string) => {
      if (packageName !== '@mearl/cloud-client') return null;
      return {
        ...detectedPackage('cloud', 'pnpm'),
        packageName,
        packageRoot: '/tools/pnpm/lib/node_modules/@mearl/cloud-client',
        executable: '/tools/pnpm/bin/mearl-cloud',
      };
    });

    await expect(
      runMearlLifecycle({ operation: 'uninstall', profile: 'cloud', yes: true }, deps),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['remove', '-g', '@mearl/cloud-client'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/pnpm/bin/pnpm',
      ['remove', '-g', '@mearl/cloud-server'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand.mock.calls.flatMap(call => call[1])).not.toContain('@mearl/client');
  });

  it('auto-updates every detected environment and updates the shared skill once', async () => {
    const deps = dependencies(
      new Map([
        ['local', detectedPackage('local', 'npm')],
        ['cloud', detectedPackage('cloud', 'pnpm')],
      ]),
    );

    await expect(runMearlLifecycle({ operation: 'update' }, deps)).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/npm/bin/npm',
      ['install', '-g', '@mearl/client@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/npm/bin/npm',
      ['install', '-g', '@mearl/native-host@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/npm/bin/mearl-native-host',
      ['--init', '--mode', 'skills'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      4,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/cloud-server@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      5,
      '/tools/pnpm/bin/mearl-cloud-server',
      ['status'],
      expect.objectContaining({ capture: true }),
    );
    expect(deps.runSkillOperation).toHaveBeenCalledTimes(1);
    expect(deps.runSkillOperation).toHaveBeenCalledWith('update', expect.any(Object));
  });

  it('restarts a running cloud server after updating the cloud packages', async () => {
    const deps = dependencies(new Map([['cloud', detectedPackage('cloud', 'pnpm')]]));
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'status' ? '[CloudServer] Status: running\n' : '',
      stderr: '',
    }));

    await expect(runMearlLifecycle({ operation: 'update', profile: 'cloud' }, deps)).resolves.toBe(
      true,
    );

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/client@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/cloud-server@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/pnpm/bin/mearl-cloud-server',
      ['status'],
      expect.objectContaining({ capture: true }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      4,
      '/tools/pnpm/bin/mearl-cloud-server',
      ['restart'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('does not start a stopped cloud server during an update', async () => {
    const deps = dependencies(new Map([['cloud', detectedPackage('cloud')]]));
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'status' ? '[CloudServer] Status: stopped\n' : '',
      stderr: '',
    }));

    await expect(runMearlLifecycle({ operation: 'update', profile: 'cloud' }, deps)).resolves.toBe(
      true,
    );

    expect(deps.runCommand).toHaveBeenCalledTimes(3);
    expect(deps.writeLine).toHaveBeenCalledWith(
      'Hook: cloud update skipped because cloud-server is not running.',
    );
  });

  it('starts the cloud server after installing the cloud environment', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('cloud', 'pnpm'));
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'status' ? '[CloudServer] Status: stopped\n' : '',
      stderr: '',
    }));

    await expect(runMearlLifecycle({ operation: 'install', profile: 'cloud' }, deps)).resolves.toBe(
      true,
    );

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/client@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/cloud-server@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      4,
      '/tools/pnpm/bin/mearl-cloud-server',
      ['start'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('uses the ordinary cloud lifecycle with a Qoder mode marker', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('cloud', 'pnpm'));
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'status' ? '[CloudServer] Status: stopped\n' : '',
      stderr: '',
    }));

    await expect(
      runMearlLifecycle({ operation: 'install', profile: 'cloud', cloudMode: 'qoder' }, deps),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/pnpm/bin/mearl-cloud-server',
      ['status'],
      expect.objectContaining({
        capture: true,
        env: expect.objectContaining({ MEARL_CLOUD_MODE: 'qoder' }),
      }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      4,
      '/tools/pnpm/bin/mearl-cloud-server',
      ['start'],
      expect.objectContaining({
        capture: false,
        env: expect.objectContaining({ MEARL_CLOUD_MODE: 'qoder' }),
      }),
    );
  });

  it('refreshes Qoder pairing during an automatic cloud update without a live daemon', async () => {
    const deps = dependencies(new Map([['cloud', detectedPackage('cloud', 'pnpm')]]));
    deps.runCommand = vi.fn<CommandRunner>(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === 'status'
          ? '[CloudServer] Status: stopped\n[CloudServer] Mode: qoder pairing (no listening service)\n'
          : '',
      stderr: '',
    }));

    await expect(runMearlLifecycle({ operation: 'update', profile: 'cloud' }, deps)).resolves.toBe(
      true,
    );

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      4,
      '/tools/pnpm/bin/mearl-cloud-server',
      ['start'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('stops the cloud server before uninstalling the cloud environment', async () => {
    const deps = dependencies(new Map([['cloud', detectedPackage('cloud')]]));
    deps.detectPackage = vi.fn((packageName: string) =>
      packageName === '@mearl/client' ? detectedClient() : null,
    );

    await expect(
      runMearlLifecycle({ operation: 'uninstall', profile: 'cloud', yes: true }, deps),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/npm/bin/mearl-cloud-server',
      ['stop'],
      expect.objectContaining({
        capture: false,
        env: expect.objectContaining({ MEARL_CLOUD_MODE: 'websocket' }),
      }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/npm/bin/npm',
      ['uninstall', '-g', '@mearl/cloud-server'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/npm/bin/npm',
      ['uninstall', '-g', '@mearl/client'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('updates the local Host and CLI from one release line without touching the Skill', async () => {
    const deps = dependencies(new Map([['local', detectedPackage('local', 'pnpm')]]));

    await expect(
      runMearlLifecycle(
        {
          operation: 'update',
          profile: 'local',
          targetLine: '2.4.x',
          skipSkill: true,
          yes: true,
        },
        deps,
      ),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/client@2.4.x'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/native-host@2.4.x'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      3,
      '/tools/pnpm/bin/mearl-native-host',
      ['--init', '--mode', 'skills'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
    expect(deps.uninstallManagedPlugins).not.toHaveBeenCalled();
  });

  it('rejects an unsafe release line before launching a package manager', async () => {
    const deps = dependencies(new Map([['local', detectedPackage('local')]]));

    await expect(
      runMearlLifecycle({ operation: 'update', targetLine: 'latest;echo unsafe' }, deps),
    ).rejects.toThrow('targetLine');
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it('passes non-interactive mode to skill installation', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));

    await expect(runMearlLifecycle({ operation: 'install', yes: true }, deps)).resolves.toBe(true);

    expect(deps.runSkillOperation).toHaveBeenCalledWith(
      'install',
      expect.objectContaining({ yes: true }),
    );
  });

  it('keeps the shared skill when another selected-out environment still needs it', async () => {
    const deps = dependencies(
      new Map([
        ['local', detectedPackage('local')],
        ['cloud', detectedPackage('cloud')],
      ]),
    );

    await expect(
      runMearlLifecycle({ operation: 'uninstall', profile: 'local', yes: true }, deps),
    ).resolves.toBe(true);

    expect(deps.cleanupNativeHost).toHaveBeenCalledWith({
      mode: 'both',
      silent: true,
    });
    expect(deps.runCommand).toHaveBeenCalledWith(
      '/tools/npm/bin/npm',
      ['uninstall', '-g', '@mearl/native-host'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
    expect(deps.uninstallManagedPlugins).not.toHaveBeenCalled();
  });

  it('keeps the MCP native host registration when MCP remains installed', async () => {
    const deps = dependencies(
      new Map([
        ['local', detectedPackage('local')],
        ['mcp', detectedPackage('mcp')],
      ]),
    );

    await expect(
      runMearlLifecycle({ operation: 'uninstall', profile: 'local', yes: true }, deps),
    ).resolves.toBe(true);

    expect(deps.cleanupNativeHost).toHaveBeenCalledWith({
      mode: 'skills',
      silent: true,
    });
  });

  it('removes the shared skill once after every dependent environment is removed', async () => {
    const deps = dependencies(
      new Map([
        ['local', detectedPackage('local')],
        ['cloud', detectedPackage('cloud')],
      ]),
    );
    deps.uninstallManagedPlugins = vi.fn(async () => 'uninstalled' as const);

    await expect(runMearlLifecycle({ operation: 'uninstall', yes: true }, deps)).resolves.toBe(
      true,
    );

    expect(deps.runSkillOperation).not.toHaveBeenCalled();
    expect(deps.uninstallManagedPlugins).toHaveBeenCalledExactlyOnceWith({
      env: process.env,
      includeMearlSkill: true,
      runCommand: expect.any(Function),
      writeLine: deps.writeLine,
    });
  });

  it('uses one batch when uninstalling the base skill and plugins', async () => {
    const deps = dependencies(new Map([['local', detectedPackage('local')]]));
    deps.uninstallManagedPlugins = vi.fn(async () => 'uninstalled' as const);

    await expect(
      runMearlLifecycle({ operation: 'uninstall', profile: 'local', yes: true }, deps),
    ).resolves.toBe(true);

    expect(deps.uninstallManagedPlugins).toHaveBeenCalledExactlyOnceWith({
      env: process.env,
      includeMearlSkill: true,
      runCommand: expect.any(Function),
      writeLine: deps.writeLine,
    });
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });

  it('reports an incomplete uninstall when its setup-managed plugin cannot be removed', async () => {
    const deps = dependencies(new Map([['local', detectedPackage('local')]]));
    deps.uninstallManagedPlugins = vi.fn(async () => 'failed' as const);

    await expect(
      runMearlLifecycle({ operation: 'uninstall', profile: 'local', yes: true }, deps),
    ).resolves.toBe(false);
    expect(deps.writeLine).toHaveBeenLastCalledWith(
      'Mearl setup incomplete. Review the messages above.',
    );
  });

  it('fully uninstalls registered CLI plugins and Providers', async () => {
    const base = dependencies(new Map([['local', detectedPackage('local')]]));
    base.uninstallManagedPlugins = vi.fn(async () => 'uninstalled' as const);
    const uninstallPlugin = vi.fn(async () => ({
      removed: true,
      unregisteredNames: ['custom'],
    }));
    const uninstallProvider = vi.fn(async () => ({
      manager: 'npm' as const,
      manifest: { providerId: 'example-device' } as never,
    }));
    const deps = {
      ...base,
      listPlugins: vi.fn(() => ['custom']),
      listProviders: vi.fn(() => [{ providerId: 'example-device' } as never]),
      uninstallPlugin,
      uninstallProvider,
    };

    await expect(
      runMearlLifecycle({ operation: 'uninstall', full: true, yes: true }, deps),
    ).resolves.toBe(true);

    expect(uninstallPlugin).toHaveBeenCalledExactlyOnceWith('custom', expect.any(Function));
    expect(uninstallProvider).toHaveBeenCalledExactlyOnceWith('example-device');
    expect(base.writeLine).toHaveBeenCalledWith('CLI plugin custom: uninstalled.');
    expect(base.writeLine).toHaveBeenCalledWith('Provider example-device: uninstalled.');
    expect(base.cleanupRuntime).toHaveBeenCalledOnce();
  });

  it('runs residual cache cleanup even when nothing remains installed', async () => {
    const deps = { ...dependencies(new Map()), listPlugins: () => [], listProviders: () => [] };
    await expect(
      runMearlLifecycle({ operation: 'uninstall', full: true, yes: true }, deps),
    ).resolves.toBe(true);
    expect(deps.cleanupRuntime).toHaveBeenCalledOnce();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it('keeps shared runtime caches when another profile remains installed', async () => {
    const deps = {
      ...dependencies(
        new Map([
          ['local', detectedPackage('local')],
          ['mcp', detectedPackage('mcp')],
        ]),
      ),
      listPlugins: () => [],
      listProviders: () => [],
    };
    await expect(
      runMearlLifecycle(
        { operation: 'uninstall', profiles: ['local'], full: true, yes: true, skipSkill: true },
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.cleanupRuntime).not.toHaveBeenCalled();
  });

  it('reports cleanup failure without reporting uninstall success', async () => {
    const deps = {
      ...dependencies(new Map()),
      listPlugins: () => [],
      listProviders: () => [],
      cleanupRuntime: vi.fn(async () => {
        throw new Error('service still running');
      }),
    };
    await expect(
      runMearlLifecycle({ operation: 'uninstall', full: true, yes: true }, deps),
    ).resolves.toBe(false);
    expect(deps.writeLine).toHaveBeenLastCalledWith('Runtime caches: service still running');
  });

  it('supports full cleanup when no environment package remains', async () => {
    const base = dependencies(new Map());
    const uninstallPlugin = vi.fn(async () => ({
      removed: true,
      unregisteredNames: ['custom'],
    }));
    const deps = {
      ...base,
      listPlugins: vi.fn(() => ['custom']),
      listProviders: vi.fn(() => []),
      uninstallPlugin,
      uninstallProvider: vi.fn(),
    };

    await expect(
      runMearlLifecycle(
        { operation: 'uninstall', profiles: ['local'], full: true, yes: true },
        deps,
      ),
    ).resolves.toBe(true);

    expect(uninstallPlugin).toHaveBeenCalledExactlyOnceWith('custom', expect.any(Function));
    expect(base.runCommand).not.toHaveBeenCalled();
    expect(base.runSkillOperation).not.toHaveBeenCalled();
  });

  it('confirms full cleanup before changing registrations', async () => {
    const base = dependencies(new Map());
    base.confirm = vi.fn(async () => false);
    const uninstallPlugin = vi.fn();
    const uninstallProvider = vi.fn();
    const deps = {
      ...base,
      listPlugins: vi.fn(() => ['custom']),
      listProviders: vi.fn(() => [{ providerId: 'example-device' } as never]),
      uninstallPlugin,
      uninstallProvider,
    };

    await expect(runMearlLifecycle({ operation: 'uninstall', full: true }, deps)).resolves.toBe(
      false,
    );

    expect(base.confirm).toHaveBeenCalledExactlyOnceWith(
      'Uninstall all CLI plugins and Providers?',
    );
    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(uninstallProvider).not.toHaveBeenCalled();
  });

  it('continues full cleanup after an individual integration fails', async () => {
    const base = dependencies(new Map());
    const uninstallProvider = vi.fn(async () => ({
      manager: 'npm' as const,
      manifest: { providerId: 'example-device' } as never,
    }));
    const deps = {
      ...base,
      listPlugins: vi.fn(() => ['broken']),
      listProviders: vi.fn(() => [{ providerId: 'example-device' } as never]),
      uninstallPlugin: vi.fn(async () => {
        throw new Error('remove failed');
      }),
      uninstallProvider,
    };

    await expect(
      runMearlLifecycle({ operation: 'uninstall', full: true, yes: true }, deps),
    ).resolves.toBe(false);

    expect(uninstallProvider).toHaveBeenCalledExactlyOnceWith('example-device');
    expect(base.writeLine).toHaveBeenCalledWith('CLI plugin broken: remove failed');
    expect(base.writeLine).toHaveBeenLastCalledWith(
      'Mearl setup incomplete. Review the messages above.',
    );
  });

  it('runs the MCP-owned configuration after first installing its package', async () => {
    const deps = dependencies(new Map());
    const installedMcp = detectedPackage('mcp');
    deps.detectPackage = vi.fn(() => installedMcp);

    await expect(runMearlLifecycle({ operation: 'install', profile: 'mcp' }, deps)).resolves.toBe(
      true,
    );

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/pnpm/bin/pnpm',
      ['add', '-g', '@mearl/mcp-server@latest'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/npm/bin/mearl-mcp-configure',
      ['--global-install'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });

  it('passes non-interactive mode to MCP configuration', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('mcp'));

    await expect(
      runMearlLifecycle({ operation: 'install', profile: 'mcp', yes: true }, deps),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/npm/bin/mearl-mcp-configure',
      ['--global-install', '--yes'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('lets the MCP package clean its configuration before package removal', async () => {
    const deps = dependencies(new Map([['mcp', detectedPackage('mcp')]]));

    await expect(
      runMearlLifecycle({ operation: 'uninstall', profile: 'mcp', yes: true }, deps),
    ).resolves.toBe(true);

    expect(deps.runCommand).toHaveBeenNthCalledWith(
      1,
      '/tools/npm/bin/mearl-mcp-uninstall',
      ['--managed-by-setup', '--yes'],
      expect.objectContaining({ capture: false }),
    );
    expect(deps.runCommand).toHaveBeenNthCalledWith(
      2,
      '/tools/npm/bin/npm',
      ['uninstall', '-g', '@mearl/mcp-server'],
      expect.objectContaining({ capture: false }),
    );
  });

  it('rejects updating a requested environment that is not detected', async () => {
    const deps = dependencies(new Map());

    await expect(runMearlLifecycle({ operation: 'update', profile: 'cloud' }, deps)).resolves.toBe(
      false,
    );

    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it('reports package manager launch failures without running the skill step', async () => {
    const deps = dependencies(new Map());
    deps.runCommand = vi.fn<CommandRunner>(async () => {
      throw new Error('package manager unavailable');
    });

    await expect(runMearlLifecycle({ operation: 'install' }, deps)).resolves.toBe(false);

    expect(deps.writeLine).toHaveBeenCalledWith(
      'Packages (shared client): package manager unavailable',
    );
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });

  it('reports local native host initialization failures without installing the skill', async () => {
    const deps = dependencies(new Map());
    deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));
    deps.runCommand = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });

    await expect(runMearlLifecycle({ operation: 'install' }, deps)).resolves.toBe(false);

    expect(deps.writeLine).toHaveBeenCalledWith('Hook: local install failed (exit 1).');
    expect(deps.runSkillOperation).not.toHaveBeenCalled();
  });

  it('treats an auto-detected uninstall with no installation as complete', async () => {
    const deps = dependencies(new Map());

    await expect(runMearlLifecycle({ operation: 'uninstall' }, deps)).resolves.toBe(true);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });
});

it('prepares the selected manager after runtime initialization and before any Skill batch', async () => {
  const deps = dependencies(new Map());
  deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));
  const prepareSkills = vi.fn(async () => {});
  expect(await runMearlLifecycle({ operation: 'install' }, { ...deps, prepareSkills })).toBe(true);
  expect(deps.runCommand.mock.invocationCallOrder[2]).toBeLessThan(prepareSkills.mock.invocationCallOrder[0]);
  expect(prepareSkills.mock.invocationCallOrder[0]).toBeLessThan(deps.installManagedPlugins.mock.invocationCallOrder[0]);
  expect(prepareSkills.mock.invocationCallOrder[0]).toBeLessThan(deps.runSkillOperation.mock.invocationCallOrder[0]);
});

it('saves the preset before package changes and activates it before the Skill batch', async () => {
  const installation = detectedPackage('local');
  const deps = dependencies(new Map([['local', installation]]));
  const status = { ready: false, revision: 'a'.repeat(64), pending: [{ reason: 'BROWSER_SYNC_REQUIRED' }] } as any;
  const activate = vi.fn(async () => status);
  const onPresetStatus = vi.fn();
  deps.preparePreset.mockImplementation(async () => { deps.readManagement.mockResolvedValue({ setup: undefined, source: undefined, revision: status.revision }); return { revision: status.revision, activate }; });
  expect(await runMearlLifecycle({ operation: 'update' }, { ...deps, onPresetStatus })).toBe(true);
  expect(deps.preparePreset).toHaveBeenCalledWith(expect.objectContaining({ source: undefined }));
  expect(deps.preparePreset.mock.invocationCallOrder[0]).toBeLessThan(deps.runCommand.mock.invocationCallOrder[0]);
  expect(deps.runCommand.mock.invocationCallOrder[2]).toBeLessThan(activate.mock.invocationCallOrder[0]);
  expect(activate.mock.invocationCallOrder[0]).toBeLessThan(deps.installManagedPlugins.mock.invocationCallOrder[0]);
  expect(onPresetStatus).toHaveBeenCalledExactlyOnceWith(status);
});

it('does not modify packages when preset preparation fails, or activate after package failure', async () => {
  const deps = dependencies(new Map([['local', detectedPackage('local')]]));
  deps.preparePreset.mockRejectedValueOnce(new Error('Preset resource unavailable'));
  expect(await runMearlLifecycle({ operation: 'update' }, deps)).toBe(false);
  expect(deps.runCommand).not.toHaveBeenCalled();
  const activate = vi.fn();
  deps.preparePreset.mockImplementation(async () => { deps.readManagement.mockResolvedValue({ setup: undefined, source: undefined, revision: 'a'.repeat(64) }); return { revision: 'a'.repeat(64), activate }; });
  deps.runCommand.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
  expect(await runMearlLifecycle({ operation: 'update' }, deps)).toBe(false);
  expect(activate).not.toHaveBeenCalled();
  expect(deps.installManagedPlugins).not.toHaveBeenCalled();
});

it('does not prepare presets when maintaining an older release line or uninstalling', async () => {
  const deps = dependencies(new Map([['local', detectedPackage('local')]]));
  await runMearlLifecycle({ operation: 'update', targetLine: '2.22.x' }, deps);
  expect(deps.preparePreset).not.toHaveBeenCalled();
  await runMearlLifecycle({ operation: 'uninstall', yes: true }, deps);
  expect(deps.preparePreset).not.toHaveBeenCalled();
});
it('does not run the fallback Skill tool after package or manager preparation failure', async () => {
  const deps = dependencies(new Map());
  deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));
  const prepareSkills = vi.fn(async () => { throw new Error('Preset is unavailable'); });
  expect(await runMearlLifecycle({ operation: 'install' }, { ...deps, prepareSkills })).toBe(false);
  expect(deps.runSkillOperation).not.toHaveBeenCalled();
  expect(deps.installManagedPlugins).not.toHaveBeenCalled();
  prepareSkills.mockClear();
  deps.runCommand.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
  expect(await runMearlLifecycle({ operation: 'install' }, { ...deps, prepareSkills })).toBe(false);
  expect(prepareSkills).not.toHaveBeenCalled();
});

it('installs exact beta runtime packages by default without selecting latest', async () => {
  setupRelease.SETUP_VERSION = '3.0.0-beta.0';
  const deps = dependencies(new Map());
  deps.detectPackage = vi.fn(() => detectedPackage('local', 'pnpm'));
  await expect(runMearlLifecycle({ operation: 'install', skipSkill: true }, deps)).resolves.toBe(true);
  const commands = vi.mocked(deps.runCommand).mock.calls.map(([, args]) => args);
  expect(commands).toContainEqual(['add', '-g', '@mearl/client@3.0.0-beta.0']);
  expect(commands).toContainEqual(['add', '-g', '@mearl/native-host@3.0.0-beta.0']);
  expect(commands.flat().some(value => String(value).endsWith('@latest'))).toBe(false);
});

it('adopts a browser preset after initializing the runtime and before any Skill installation', async () => {
  setupRelease.SETUP_VERSION = '3.0.0-beta.5';
  const deps = dependencies(new Map());
  deps.detectPackage = vi.fn(() => detectedPackage('local'));
  const status = { revision: 'a'.repeat(64), ready: false } as any;
  const activate = vi.fn(async () => status);
  deps.prepareBrowserPreset.mockImplementation(async () => { deps.readManagement.mockResolvedValue({ setup: undefined, source: undefined, revision: status.revision }); return { revision: status.revision, activate }; });
  const onPresetStatus = vi.fn();
  expect(await runMearlLifecycle({ operation: 'install', defaultPresetSource: 'https://default.example.test/preset.json' }, { ...deps, onPresetStatus })).toBe(true);
  expect(deps.runCommand.mock.invocationCallOrder.at(-1)).toBeLessThan(deps.prepareBrowserPreset.mock.invocationCallOrder[0]);
  expect(activate.mock.invocationCallOrder[0]).toBeLessThan(deps.installManagedPlugins.mock.invocationCallOrder[0]);
  expect(onPresetStatus).toHaveBeenCalledWith(status);
  expect(deps.preparePreset).toHaveBeenCalledOnce();
});

it('uses the distribution default only when no browser selection was adopted', async () => {
  setupRelease.SETUP_VERSION = '3.0.0-beta.5';
  const deps = dependencies(new Map());
  deps.detectPackage = vi.fn(() => detectedPackage('local'));
  const activate = vi.fn(async () => ({ revision: 'a'.repeat(64), ready: true }) as any);
  deps.preparePreset.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { deps.readManagement.mockResolvedValue({ setup: undefined, source: undefined, revision: 'a'.repeat(64) }); return { revision: 'a'.repeat(64), activate }; });
  expect(await runMearlLifecycle({ operation: 'install', defaultPresetSource: 'https://default.example.test/preset.json' }, deps)).toBe(true);
  expect(deps.preparePreset).toHaveBeenLastCalledWith(expect.objectContaining({ fallbackSource: 'https://default.example.test/preset.json' }));
  expect(deps.prepareBrowserPreset.mock.invocationCallOrder[0]).toBeLessThan(deps.preparePreset.mock.invocationCallOrder[1]);
  expect(activate).toHaveBeenCalledOnce();
});

it('stops before fallback defaults or Skills if browser preset discovery fails', async () => {
  setupRelease.SETUP_VERSION = '3.0.0-beta.5';
  const deps = dependencies(new Map());
  deps.detectPackage = vi.fn(() => detectedPackage('local'));
  deps.prepareBrowserPreset.mockRejectedValueOnce(new Error('different presets'));
  expect(await runMearlLifecycle({ operation: 'install', defaultPresetSource: 'https://default.example.test/preset.json' }, deps)).toBe(false);
  expect(deps.preparePreset).toHaveBeenCalledOnce();
  expect(deps.installManagedPlugins).not.toHaveBeenCalled();
  expect(deps.runSkillOperation).not.toHaveBeenCalled();
});

it('does not adopt a browser preset during an unattended runtime update', async () => {
  setupRelease.SETUP_VERSION = '3.0.0-beta.5';
  const deps = dependencies(new Map([['local', detectedPackage('local')]]));
  await runMearlLifecycle({ operation: 'update', defaultPresetSource: 'https://default.example.test/preset.json', env: { MEARL_AUTO_UPDATE_PROFILES: 'local' } }, deps);
  expect(deps.prepareBrowserPreset).not.toHaveBeenCalled();
  expect(deps.preparePreset).toHaveBeenCalledOnce();
  deps.preparePreset.mockClear();
  await runMearlLifecycle({ operation: 'update', defaultPresetSource: 'https://default.example.test/preset.json', skipSkill: true }, deps);
  expect(deps.prepareBrowserPreset).not.toHaveBeenCalled();
  expect(deps.preparePreset).toHaveBeenCalledOnce();
});

it('rejects an incompatible installed management policy before changing packages', async () => {
  setupRelease.SETUP_VERSION = '3.0.0-beta.8';
  const deps = dependencies(new Map([['local', detectedPackage('local')]]));
  deps.readManagement.mockResolvedValue({ setup: { package: '@team/setup', version: 'beta', runtime: '>=4.0.0 <5' }, source: 'https://example.test/preset.json', revision: 'a'.repeat(64) });
  expect(await runMearlLifecycle({ operation: 'update' }, deps)).toBe(false);
  expect(deps.runCommand).not.toHaveBeenCalled();
  expect(deps.writeLine).toHaveBeenCalledWith(expect.stringContaining('npx @team/setup@beta update'));
  expect(deps.claimLifecycle.mock.results[0].value.release).toHaveBeenCalledOnce();
});
it('rechecks accepted management before a package command and preserves corrupt installations', async () => {
  const deps = dependencies(new Map([['local', detectedPackage('local')]]));
  deps.readManagement.mockRejectedValueOnce(new Error('BUNDLE_INTEGRITY'));
  expect(await runMearlLifecycle({ operation: 'uninstall', yes: true }, deps)).toBe(false);
  expect(deps.cleanupNativeHost).not.toHaveBeenCalled();
  expect(deps.runCommand).not.toHaveBeenCalled();
  deps.readManagement.mockResolvedValueOnce({ setup: undefined, source: undefined, revision: undefined }).mockResolvedValueOnce({ setup: undefined, source: undefined, revision: undefined }).mockResolvedValue({ setup: undefined, source: undefined, revision: 'b'.repeat(64) });
  expect(await runMearlLifecycle({ operation: 'update' }, deps)).toBe(false);
  expect(deps.runCommand).not.toHaveBeenCalled();
});
it('stops a second lifecycle operation while the first owns the shared lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-lifecycle-lease-'));
  const { claimPresetInstallation } = await import('../presetInstallationLease.js');
  const first = dependencies(new Map([['local', detectedPackage('local')]]));
  const second = dependencies(new Map([['local', detectedPackage('local')]]));
  first.claimLifecycle = second.claimLifecycle = vi.fn(() => claimPresetInstallation(join(directory, 'lifecycle.json')));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  first.readManagement.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { setup: undefined, source: undefined, revision: undefined }; });
  const pending = runMearlLifecycle({ operation: 'update' }, first);
  try {
    await started;
    expect(await runMearlLifecycle({ operation: 'uninstall', yes: true }, second)).toBe(false);
    expect(second.runCommand).not.toHaveBeenCalled();
    expect(second.cleanupNativeHost).not.toHaveBeenCalled();
  } finally { release(); await pending; rmSync(directory, { recursive: true, force: true }); }
});
it('pins a managed stable installation to the verified installer version instead of latest', async () => {
  setupRelease.SETUP_VERSION = '3.0.1';
  const deps = dependencies(new Map([['local', detectedPackage('local')]]));
  deps.readManagement.mockResolvedValue({ setup: { package: '@team/setup', version: 'latest', runtime: '>=3.0.0 <3.0.10' }, source: 'https://example.test/preset.json', revision: 'a'.repeat(64) });
  expect(await runMearlLifecycle({ operation: 'update' }, deps)).toBe(true);
  expect(deps.runCommand).toHaveBeenCalledWith(expect.any(String), ['install', '-g', '@mearl/client@3.0.1'], expect.any(Object));
});
