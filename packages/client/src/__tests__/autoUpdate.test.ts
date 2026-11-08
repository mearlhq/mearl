import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCliUpdateDue,
  isGlobalClientPackageRoot,
  runCliAutoUpdate,
  scheduleCliAutoUpdate,
  setupUpdateCommand,
} from '../autoUpdate.js';
import { loadCliAutoUpdateIntervalDays } from '../unifiedConfig.js';

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mearl-cli-update-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

describe('CLI auto-update', () => {
  it('defaults to a daily check and accepts an interval or disabled setting', () => {
    const configPath = join(temporaryDirectory(), 'config.json');
    expect(loadCliAutoUpdateIntervalDays(configPath)).toBe(1);
    writeFileSync(configPath, JSON.stringify({ cliAutoUpdate: { intervalDays: 7 } }));
    expect(loadCliAutoUpdateIntervalDays(configPath)).toBe(7);
    writeFileSync(configPath, JSON.stringify({ cliAutoUpdate: false }));
    expect(loadCliAutoUpdateIntervalDays(configPath)).toBeNull();
    writeFileSync(configPath, JSON.stringify({ cliAutoUpdate: { intervalDays: 0 } }));
    expect(loadCliAutoUpdateIntervalDays(configPath)).toBe(1);
  });

  it('uses local calendar days', () => {
    const now = new Date(2026, 8, 27, 0, 1);
    expect(isCliUpdateDue(undefined, now, 1)).toBe(true);
    expect(isCliUpdateDue('2026-09-26', now, 1)).toBe(true);
    expect(isCliUpdateDue('2026-09-26', now, 2)).toBe(false);
    expect(isCliUpdateDue('2026-09-27', now, 1)).toBe(false);
    expect(isCliUpdateDue('invalid', now, 1)).toBe(true);
  });

  it('only runs from supported global client installations', () => {
    const directory = temporaryDirectory();
    const projectRoot = join(directory, 'project', 'lib', 'node_modules', '@mearl', 'client');
    mkdirSync(join(projectRoot, 'dist'), { recursive: true });
    writeFileSync(join(projectRoot, 'dist', 'bin.js'), '');
    expect(isGlobalClientPackageRoot(projectRoot)).toBe(false);

    if (process.platform !== 'win32') {
      const npmPrefix = join(directory, 'npm-prefix');
      const npmRoot = join(npmPrefix, 'lib', 'node_modules', '@mearl', 'client');
      mkdirSync(join(npmRoot, 'dist'), { recursive: true });
      mkdirSync(join(npmPrefix, 'bin'), { recursive: true });
      writeFileSync(join(npmRoot, 'dist', 'bin.js'), '');
      symlinkSync(join(npmRoot, 'dist', 'bin.js'), join(npmPrefix, 'bin', 'mearl'));
      expect(isGlobalClientPackageRoot(npmRoot)).toBe(true);
    }

    const pnpmHome = join(directory, 'pnpm-home');
    const pnpmRoot = join(
      pnpmHome,
      'global',
      '5',
      '.pnpm',
      '@mearl+client@2.18.0',
      'node_modules',
      '@mearl',
      'client',
    );
    expect(isGlobalClientPackageRoot(pnpmRoot)).toBe(false);
    mkdirSync(pnpmHome, { recursive: true });
    writeFileSync(join(pnpmHome, process.platform === 'win32' ? 'mearl.cmd' : 'mearl'), '');
    expect(isGlobalClientPackageRoot(pnpmRoot)).toBe(true);

    expect(
      isGlobalClientPackageRoot('/home/user/.config/yarn/global/node_modules/@mearl/client'),
    ).toBe(true);
    expect(
      isGlobalClientPackageRoot('/home/user/.bun/install/global/node_modules/@mearl/client'),
    ).toBe(true);
    expect(
      isGlobalClientPackageRoot(
        '/home/user/.volta/tools/image/packages/mearl/lib/node_modules/@mearl/client',
      ),
    ).toBe(true);
    expect(
      isGlobalClientPackageRoot(
        'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@mearl\\client',
        'win32',
        { APPDATA: 'C:\\Users\\user\\AppData\\Roaming' },
      ),
    ).toBe(true);
    expect(
      isGlobalClientPackageRoot('C:\\project\\npm\\node_modules\\@mearl\\client', 'win32', {
        APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
      }),
    ).toBe(false);
    expect(isGlobalClientPackageRoot('/project/node_modules/@mearl/client')).toBe(false);
    expect(isGlobalClientPackageRoot('/home/user/.npm/_npx/123/node_modules/@mearl/client')).toBe(
      false,
    );
  });

  it('uses setup for the installed environment and shared client', () => {
    const projectBin = join(temporaryDirectory(), 'node_modules', '.bin');
    const globalBin = join(temporaryDirectory(), 'bin');
    vi.stubEnv('PATH', [projectBin, globalBin].join(delimiter));
    vi.stubEnv('npm_config_package', '@mearl/client@3.0.0');
    expect(setupUpdateCommand('2.19.0', '/global/client', ['local'], true)).toMatchObject({
      command: 'npx',
      args: [
        '--yes',
        '--@mearl:registry=https://registry.npmjs.org',
        '@mearl/setup@2.19.0',
        'update',
        '--yes',
        '--target-line',
        '2.19.x',
        '--skip-skill',
      ],
      env: {
        MEARL_AUTO_UPDATE_CLIENT_ROOT: '/global/client',
        MEARL_AUTO_UPDATE_PROFILES: 'local',
        MEARL_AUTO_UPDATE_SEARCH_PATH: globalBin,
      },
    });
    const standalone = setupUpdateCommand('2.19.0', '/global/client', [], true);
    expect(standalone.env).not.toHaveProperty('npm_config_package');
    expect(standalone.env.MEARL_AUTO_UPDATE_CLIENT_ONLY).toBe('1');
    expect(standalone.args).not.toContain('--local');
    const mcp = setupUpdateCommand('2.19.0', '/global/client', ['mcp'], false);
    expect(mcp.env.MEARL_AUTO_UPDATE_CLIENT_ROOT).toBeUndefined();
    expect(mcp.env.MEARL_AUTO_UPDATE_PROFILES).toBe('mcp');
    expect(mcp.args).not.toContain('--mcp');
  });

  it.skipIf(process.platform === 'win32')(
    'ignores project bin directories when probing environments',
    async () => {
      const directory = temporaryDirectory();
      const projectBin = join(directory, 'node_modules', '.bin');
      const globalBin = join(directory, 'global-bin');
      mkdirSync(projectBin, { recursive: true });
      mkdirSync(globalBin, { recursive: true });
      writeFileSync(join(projectBin, 'mearl-native-host'), '#!/bin/sh\nprintf "2.20.0\\n"\n', {
        mode: 0o755,
      });
      writeFileSync(join(globalBin, 'mearl-native-host'), '#!/bin/sh\nprintf "2.18.0\\n"\n', {
        mode: 0o755,
      });
      vi.stubEnv('PATH', [projectBin, globalBin].join(delimiter));
      const update = vi.fn(async () => undefined);

      await runCliAutoUpdate('2.19.0', '/global/client', 'token', {
        statePath: join(directory, 'state.json'),
        lockPath: join(directory, 'lock'),
        fetchLatestVersion: async () => '2.19.0',
        update,
      });

      expect(update).toHaveBeenCalledExactlyOnceWith('2.19.0', '/global/client', ['local'], false);
    },
  );

  it('schedules once per interval and records the day when the worker starts', async () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, 'state.json');
    const lockPath = join(directory, 'update.lock');
    const workerPath = join(directory, 'worker.js');
    writeFileSync(workerPath, '');
    const launch = vi.fn();
    const packageRoot = '/global/lib/node_modules/@mearl/client';
    const scheduleOptions = {
      intervalDays: 2,
      packageRoot,
      statePath,
      lockPath,
      workerPath,
      launch,
    };

    scheduleCliAutoUpdate('2.18.0', { ...scheduleOptions, now: new Date(2026, 8, 27) });
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      workerPath,
      '2.18.0',
      packageRoot,
      expect.any(String),
    );
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(statePath)).toBe(false);

    await runCliAutoUpdate('2.18.0', packageRoot, readFileSync(lockPath, 'utf8'), {
      statePath,
      lockPath,
      now: new Date(2026, 8, 27),
      fetchLatestVersion: async () => '2.18.0',
      getInstalledEnvironments: () => [],
    });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastCheckDate).toBe('2026-09-27');
    expect(existsSync(lockPath)).toBe(false);

    scheduleCliAutoUpdate('2.18.0', { ...scheduleOptions, now: new Date(2026, 8, 28) });
    expect(launch).toHaveBeenCalledOnce();
    scheduleCliAutoUpdate('2.18.0', { ...scheduleOptions, now: new Date(2026, 8, 29) });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('delegates updates to setup for managed and standalone installations', async () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, 'state.json');
    const lockPath = join(directory, 'update.lock');
    const update = vi.fn(async () => undefined);
    const packageRoot = '/global/lib/node_modules/@mearl/client';
    const options = {
      statePath,
      lockPath,
      fetchLatestVersion: async () => '2.19.0',
      update,
    };

    await runCliAutoUpdate('2.19.0', packageRoot, 'token', {
      ...options,
      getInstalledEnvironments: () => [{ profile: 'cloud', version: '2.18.0' }],
    });
    expect(update).toHaveBeenCalledExactlyOnceWith('2.19.0', packageRoot, ['cloud'], false);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastResult.status).toBe('updated');

    await runCliAutoUpdate('2.18.0', packageRoot, 'token', {
      ...options,
      getInstalledEnvironments: () => [],
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith('2.19.0', packageRoot, [], true);

    await runCliAutoUpdate('2.19.0', packageRoot, 'token', {
      ...options,
      getInstalledEnvironments: () => [],
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastResult.status).toBe('current');
  });

  it('records failures and avoids downgrading a newer installed component', async () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, 'state.json');
    const update = vi.fn(async () => {
      throw new Error('setup failed');
    });
    const options = {
      statePath,
      lockPath: join(directory, 'lock'),
      fetchLatestVersion: async () => '2.19.0',
      getInstalledEnvironments: () => [{ profile: 'local' as const, version: '2.18.0' }],
      update,
    };

    await runCliAutoUpdate('2.18.0', '/global/client', 'token', options);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastResult).toMatchObject({
      status: 'failed',
      error: 'setup failed',
    });

    await runCliAutoUpdate('2.20.0-beta.1', '/global/client', 'token', options);
    expect(update).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastResult.status).toBe('skipped');

    await runCliAutoUpdate('2.18.0', '/global/client', 'token', {
      ...options,
      fetchLatestVersion: async () => '2.019.0',
    });
    expect(update).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastResult.status).toBe('failed');
  });
});

it('does not override exact beta setup with a stable npm range', () => {
  expect(setupUpdateCommand('3.0.0-beta.0', '/global/client', ['local'], true).args).toEqual(['--yes', '--@mearl:registry=https://registry.npmjs.org', '@mearl/setup@3.0.0-beta.0', 'update', '--yes', '--skip-skill']);
});
