import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeHostUpdateCoordinator,
  NativeHostUpdateFailure,
  nativeHostUpdateCommand,
  runNativeHostUpdate,
} from '../host-updater.js';
import type { CommandRunner } from '@mearl/daemon-core';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Native Host automatic update', () => {
  it('constructs one closed release-line setup command', () => {
    expect(nativeHostUpdateCommand('2.4.0')).toEqual({
      args: [
        '--yes',
        '@mearl/setup@2.4.x',
        'update',
        '--local',
        '--yes',
        '--target-line',
        '2.4.x',
        '--skip-skill',
      ],
    });
  });

  it.each(['latest', '../2.4.0', '2.4.0;echo unsafe', '@mearl/setup@2.4.0'])(
    'rejects an unsafe update target %s',
    target => {
      expect(() => nativeHostUpdateCommand(target)).toThrow('valid Mearl release');
    },
  );

  it('runs the matching setup release line with bounded captured output', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: '', stderr: '' }));
    const areTargetsInstalled = vi
      .fn<(targetReleaseLine: string, environment: NodeJS.ProcessEnv) => Promise<boolean>>()
      .mockResolvedValue(true);

    await runNativeHostUpdate('2.4.0', {
      areTargetsInstalled,
      environment: { PATH: '/usr/bin', npm_config_package: '@mearl/client@3.0.0' },
      nodePath: '/tools/node/bin/node',
      packageBinDirectory: '/tools/global/bin',
      packageManagerCommand: null,
      packageRunner: '/tools/node/bin/npx',
      runner,
      withUpdateLock: async (_target, operation) => operation(),
    });

    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][2]?.env).not.toHaveProperty('npm_config_package');
    expect(areTargetsInstalled).toHaveBeenCalledOnce();
    expect(areTargetsInstalled).toHaveBeenCalledWith(
      '2.4.x',
      expect.objectContaining({
        PATH: `/tools/global/bin${path.delimiter}/tools/node/bin${path.delimiter}/usr/bin`,
      }),
    );
    expect(runner).toHaveBeenCalledWith(
      '/tools/node/bin/npx',
      nativeHostUpdateCommand('2.4.0').args,
      expect.objectContaining({
        capture: true,
        timeoutMs: 5 * 60_000,
      }),
    );
  });

  it('keeps the old Host running when the installed release cannot be verified', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: '', stderr: '' }));

    await expect(
      runNativeHostUpdate('2.4.0', {
        areTargetsInstalled: async () => false,
        packageManagerCommand: null,
        packageRunner: '/tools/npx',
        runner,
        withUpdateLock: async (_target, operation) => operation(),
      }),
    ).rejects.toMatchObject<Partial<NativeHostUpdateFailure>>({
      updateError: 'verification-failed',
    });
  });

  it('classifies an unavailable setup release line without exposing its output', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      code: 1,
      stdout: '',
      stderr: 'npm error code ETARGET No matching version found',
    }));

    await expect(
      runNativeHostUpdate('2.4.0', {
        areTargetsInstalled: async () => false,
        packageManagerCommand: null,
        packageRunner: '/tools/npx',
        runner,
        withUpdateLock: async (_target, operation) => operation(),
      }),
    ).rejects.toMatchObject<Partial<NativeHostUpdateFailure>>({
      updateError: 'package-unavailable',
      message: 'The Mearl setup release line did not complete successfully',
    });
  });

  it('verifies both the Native Host and client before accepting an update', async () => {
    const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-host-bin-test-'));
    temporaryDirectories.push(binDirectory);
    for (const executableName of ['mearl-native-host', 'mearl']) {
      const executable = path.join(binDirectory, executableName);
      fs.writeFileSync(executable, '');
      fs.chmodSync(executable, 0o755);
    }
    const runner = vi.fn<CommandRunner>(async command => {
      if (command === '/tools/npx') {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '2.4.7\n', stderr: '' };
    });

    await runNativeHostUpdate('2.4.12', {
      environment: { PATH: binDirectory },
      nodePath: '/tools/node',
      packageBinDirectory: binDirectory,
      packageManagerCommand: null,
      packageRunner: '/tools/npx',
      runner,
      withUpdateLock: async (_target, operation) => operation(),
    });

    expect(runner).toHaveBeenCalledWith(
      path.join(binDirectory, 'mearl-native-host'),
      ['--version'],
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledWith(
      path.join(binDirectory, 'mearl'),
      ['--version'],
      expect.any(Object),
    );
  });

  it('rejects an update when the client did not reach the target release', async () => {
    const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-host-bin-test-'));
    temporaryDirectories.push(binDirectory);
    for (const executableName of ['mearl-native-host', 'mearl']) {
      const executable = path.join(binDirectory, executableName);
      fs.writeFileSync(executable, '');
      fs.chmodSync(executable, 0o755);
    }
    const runner = vi.fn<CommandRunner>(async command => {
      if (command === '/tools/npx') return { code: 0, stdout: '', stderr: '' };
      const version = command.endsWith(`${path.sep}mearl`) ? '2.4.6' : '2.4.7';
      return { code: 0, stdout: `${version}\n`, stderr: '' };
    });

    await expect(
      runNativeHostUpdate('2.4.12', {
        environment: { PATH: binDirectory },
        nodePath: '/tools/node',
        packageBinDirectory: binDirectory,
        packageManagerCommand: null,
        packageRunner: '/tools/npx',
        runner,
        withUpdateLock: async (_target, operation) => operation(),
      }),
    ).rejects.toMatchObject<Partial<NativeHostUpdateFailure>>({
      updateError: 'verification-failed',
      message: 'The installed Native Host and client do not match the Extension release line',
    });
  });

  it.each(['', '{"pid":'])('recovers a stale malformed update lock', async content => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-host-update-test-'));
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, 'update.lock');
    fs.writeFileSync(lockPath, content);
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    await runNativeHostUpdate('2.4.0', {
      areTargetsInstalled: async () => true,
      packageBinDirectory: null,
      packageManagerCommand: null,
      packageRunner: '/tools/npx',
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
      updateLockPath: lockPath,
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('updates once for a newer Extension and restarts only after success', async () => {
    const runUpdate = vi.fn(async () => {});
    const requestRestart = vi.fn(async () => {});
    const coordinator = new NativeHostUpdateCoordinator({
      hostVersion: '2.3.12',
      log: vi.fn(),
      requestRestart,
      runUpdate,
    });

    coordinator.evaluate('2.4.8', true);
    coordinator.evaluate('2.4.8', true);

    await vi.waitFor(() => expect(requestRestart).toHaveBeenCalledOnce());
    expect(runUpdate).toHaveBeenCalledOnce();
    expect(runUpdate).toHaveBeenCalledWith('2.4.8');
    expect(runUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      requestRestart.mock.invocationCallOrder[0]!,
    );
  });

  it('treats patch releases in one release line as compatible', () => {
    const runUpdate = vi.fn(async () => {});
    const coordinator = new NativeHostUpdateCoordinator({
      hostVersion: '2.3.1',
      log: vi.fn(),
      requestRestart: vi.fn(),
      runUpdate,
    });

    coordinator.evaluate('2.3.12', true);

    expect(runUpdate).not.toHaveBeenCalled();
  });

  it('does not downgrade a newer Host or restart after an update failure', async () => {
    const runUpdate = vi.fn(async () => {
      throw new NativeHostUpdateFailure('network', 'offline');
    });
    const requestRestart = vi.fn(async () => {});
    const log = vi.fn();
    const coordinator = new NativeHostUpdateCoordinator({
      hostVersion: '2.4.0',
      log,
      requestRestart,
      runUpdate,
    });

    coordinator.evaluate('2.3.0', true);
    expect(runUpdate).not.toHaveBeenCalled();

    const failingCoordinator = new NativeHostUpdateCoordinator({
      hostVersion: '2.3.0',
      log,
      requestRestart,
      runUpdate,
    });
    failingCoordinator.evaluate('2.4.0', true);

    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith('Native Host automatic update failed (network)'),
    );
    expect(requestRestart).not.toHaveBeenCalled();
  });
});

it('keeps beta setup and runtime updates on the exact release', () => {
  expect(nativeHostUpdateCommand('3.0.0-beta.0').args).toEqual(['--yes', '@mearl/setup@3.0.0-beta.0', 'update', '--local', '--yes', '--skip-skill']);
});
