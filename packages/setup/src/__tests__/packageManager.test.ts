import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGlobalPackageCommand,
  detectCliPackage,
  detectGlobalPackage,
  resolveInvokingPackageManager,
  resolvePackageManagerInstallation,
  type GlobalPackageManager,
} from '../packageManager.js';

const temporaryDirectories: string[] = [];

it('finds a development-linked CLI without treating it as a managed global installation', () => {
  const options = {
    env: { PATH: '/tools/bin' },
    platform: 'linux' as const,
    processExecPath: '/missing/node',
    existsSync: (file: string) => file === '/tools/bin/mearl',
    realpathSync: () => '/workspace/client/dist/bin.js',
    readFileSync: (file: string) => {
      if (file === '/workspace/client/package.json') return '{"name":"@mearl/client"}';
      throw new Error('missing');
    },
  };
  expect(detectCliPackage('@mearl/client', ['mearl'], options)).toEqual({
    packageName: '@mearl/client',
    packageRoot: '/workspace/client',
    executable: '/tools/bin/mearl',
  });
  expect(detectGlobalPackage('@mearl/client', ['mearl'], options)).toBeNull();
  expect(
    detectGlobalPackage('@mearl/client', ['mearl'], { ...options, includeLinked: true }),
  ).toBeNull();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('buildGlobalPackageCommand', () => {
  it.each<{
    manager: GlobalPackageManager;
    installArgs: string[];
    uninstallArgs: string[];
  }>([
    {
      manager: 'npm',
      installArgs: ['install', '-g', '@mearl/client@latest'],
      uninstallArgs: ['uninstall', '-g', '@mearl/client'],
    },
    {
      manager: 'pnpm',
      installArgs: ['add', '-g', '@mearl/client@latest'],
      uninstallArgs: ['remove', '-g', '@mearl/client'],
    },
    {
      manager: 'yarn',
      installArgs: ['global', 'add', '@mearl/client@latest'],
      uninstallArgs: ['global', 'remove', '@mearl/client'],
    },
    {
      manager: 'bun',
      installArgs: ['add', '-g', '@mearl/client@latest'],
      uninstallArgs: ['remove', '-g', '@mearl/client'],
    },
    {
      manager: 'volta',
      installArgs: ['install', '@mearl/client@latest'],
      uninstallArgs: ['uninstall', '@mearl/client'],
    },
  ])('builds $manager global lifecycle commands', ({ manager, installArgs, uninstallArgs }) => {
    const installation = { manager, command: `/tools/${manager}` };
    expect(buildGlobalPackageCommand(installation, 'update', ['@mearl/client'])).toEqual({
      ...installation,
      args: installArgs,
    });
    expect(buildGlobalPackageCommand(installation, 'uninstall', ['@mearl/client'])).toEqual({
      ...installation,
      args: uninstallArgs,
    });
  });

  it('pins every managed package to one target release line', () => {
    expect(
      buildGlobalPackageCommand(
        { manager: 'npm', command: '/tools/npm' },
        'update',
        ['@mearl/native-host', '@mearl/client'],
        '2.4.x',
      ),
    ).toEqual({
      manager: 'npm',
      command: '/tools/npm',
      args: ['install', '-g', '@mearl/native-host@2.4.x', '@mearl/client@2.4.x'],
    });
  });
});

describe('resolvePackageManagerInstallation', () => {
  const existing = new Set([
    '/Users/test/.nvm/versions/node/v22.0.0/bin/npm',
    '/Users/test/Library/pnpm/pnpm',
    '/Users/test/.bun/bin/bun',
    '/Users/test/.volta/bin/volta',
  ]);
  const existsSync = (candidate: string) => existing.has(candidate);

  it.each([
    {
      root: '/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/@mearl/client',
      manager: 'npm',
      command: '/Users/test/.nvm/versions/node/v22.0.0/bin/npm',
      binDirectory: '/Users/test/.nvm/versions/node/v22.0.0/bin',
    },
    {
      root: '/Users/test/Library/pnpm/global/5/.pnpm/@mearl+client@2.2.0/node_modules/@mearl/client',
      manager: 'pnpm',
      command: '/Users/test/Library/pnpm/pnpm',
      binDirectory: '/Users/test/Library/pnpm',
    },
    {
      root: '/Users/test/.bun/install/global/node_modules/@mearl/client',
      manager: 'bun',
      command: '/Users/test/.bun/bin/bun',
      binDirectory: '/Users/test/.bun/bin',
    },
    {
      root: '/Users/test/.config/yarn/global/node_modules/@mearl/client',
      manager: 'yarn',
      command: 'yarn',
      binDirectory: '/Users/test/.yarn/bin',
    },
    {
      root: '/Users/test/.volta/tools/image/packages/@mearl/client/lib/node_modules/@mearl/client',
      manager: 'volta',
      command: '/Users/test/.volta/bin/volta',
      binDirectory: '/Users/test/.volta/bin',
    },
  ])('recognizes $manager global layouts', ({ root, manager, command, binDirectory }) => {
    expect(
      resolvePackageManagerInstallation(root, '@mearl/client', {
        existsSync,
        processExecPath: '/missing/node',
      }),
    ).toEqual({ manager, command, binDirectory });
  });

  it('resolves the Windows npm global bin outside a sparse browser PATH', () => {
    const appData = '/Users/test/AppData/Roaming';
    expect(
      resolvePackageManagerInstallation(
        `${appData}/npm/node_modules/@mearl/client`,
        '@mearl/client',
        {
          env: { APPDATA: appData, PATH: '' },
          existsSync: candidate => candidate === '/tools/npm.cmd',
          platform: 'win32',
          processExecPath: '/tools/node.exe',
        },
      ),
    ).toEqual({
      manager: 'npm',
      command: '/tools/npm.cmd',
      binDirectory: `${appData}/npm`,
    });
  });

  it('does not treat an npx cache as a global package', () => {
    expect(
      resolvePackageManagerInstallation(
        '/Users/test/.npm/_npx/hash/node_modules/@mearl/client',
        '@mearl/client',
      ),
    ).toBeNull();
  });
});

describe('global package detection', () => {
  it.each([
    {
      manager: 'npm',
      packageRoot: '/tools/npm/lib/node_modules/@mearl/client',
      binDirectory: '/tools/npm/bin',
    },
    {
      manager: 'pnpm',
      packageRoot: '/home/test/pnpm/global/5/.pnpm/@mearl+client@2.20.0/node_modules/@mearl/client',
      binDirectory: '/home/test/pnpm',
    },
    {
      manager: 'yarn',
      packageRoot: '/home/test/.config/yarn/global/node_modules/@mearl/client',
      binDirectory: '/home/test/.yarn/bin',
    },
    {
      manager: 'bun',
      packageRoot: '/home/test/.bun/install/global/node_modules/@mearl/client',
      binDirectory: '/home/test/.bun/bin',
    },
    {
      manager: 'volta',
      packageRoot:
        '/home/test/.volta/tools/image/packages/client/2.20.0/lib/node_modules/@mearl/client',
      binDirectory: '/home/test/.volta/bin',
    },
  ])(
    'preserves normal $manager detection when linked removal is enabled',
    ({ manager, packageRoot, binDirectory }) => {
      const executable = path.join(binDirectory, 'mearl');
      const command = path.join(binDirectory, manager);
      const options = {
        env: { PATH: binDirectory },
        platform: 'linux' as const,
        processExecPath: '/missing/node',
        existsSync: (file: string) => file === executable || file === command,
        realpathSync: (file: string) => {
          if (file === executable) return path.join(packageRoot, 'dist/bin.js');
          throw new Error('Unexpected linked installation lookup');
        },
        readFileSync: (file: string) => {
          if (file === path.join(packageRoot, 'package.json')) return '{"name":"@mearl/client"}';
          throw new Error('missing');
        },
      };
      const expected = {
        packageName: '@mearl/client',
        packageRoot,
        executable,
        manager,
        command,
        binDirectory,
      };
      expect(detectGlobalPackage('@mearl/client', ['mearl'], options)).toEqual(expected);
      expect(
        detectGlobalPackage('@mearl/client', ['mearl'], { ...options, includeLinked: true }),
      ).toEqual(expected);
    },
  );

  it('detects a registered npm development link only when linked removal is enabled', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-setup-linked-test-'));
    temporaryDirectories.push(directory);
    const packageRoot = path.join(directory, 'workspace/client');
    const registeredRoot = path.join(directory, 'prefix/lib/node_modules/@mearl/client');
    const binDirectory = path.join(directory, 'prefix/bin');
    const entry = path.join(packageRoot, 'dist/bin.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(path.dirname(registeredRoot), { recursive: true });
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@mearl/client"}');
    fs.writeFileSync(entry, '#!/usr/bin/env node\n');
    fs.chmodSync(entry, 0o755);
    fs.symlinkSync(packageRoot, registeredRoot);
    const executable = path.join(binDirectory, 'mearl');
    fs.symlinkSync(entry, executable);
    const npmCommand = path.join(binDirectory, 'npm');
    fs.writeFileSync(npmCommand, '');
    fs.chmodSync(npmCommand, 0o755);
    const options = { env: { PATH: binDirectory }, processExecPath: '/missing/node' };

    expect(detectGlobalPackage('@mearl/client', ['mearl'], options)).toBeNull();
    expect(
      detectGlobalPackage('@mearl/client', ['mearl'], { ...options, includeLinked: true }),
    ).toEqual({
      packageName: '@mearl/client',
      packageRoot: fs.realpathSync(packageRoot),
      executable,
      manager: 'npm',
      command: npmCommand,
      binDirectory,
    });

    fs.unlinkSync(registeredRoot);
    const otherRoot = path.join(directory, 'workspace/other-client');
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, 'package.json'), '{"name":"@mearl/client"}');
    fs.symlinkSync(otherRoot, registeredRoot);
    expect(
      detectGlobalPackage('@mearl/client', ['mearl'], { ...options, includeLinked: true }),
    ).toBeNull();
  });

  it.each([false, true])('follows the owning npm package with includeLinked=%s', includeLinked => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-setup-test-'));
    temporaryDirectories.push(directory);
    const packageRoot = path.join(directory, 'prefix/lib/node_modules/@mearl/cloud-server');
    const binDirectory = path.join(directory, 'prefix/bin');
    const entry = path.join(packageRoot, 'dist/cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@mearl/cloud-server' }),
    );
    fs.writeFileSync(entry, '#!/usr/bin/env node\n');
    fs.chmodSync(entry, 0o755);
    const npmCommand = path.join(binDirectory, 'npm');
    fs.writeFileSync(npmCommand, '');
    fs.chmodSync(npmCommand, 0o755);
    fs.symlinkSync(entry, path.join(binDirectory, 'mearl-cloud-server'));

    expect(
      detectGlobalPackage('@mearl/cloud-server', ['mearl-cloud-server'], {
        includeLinked,
        env: { PATH: binDirectory },
        processExecPath: '/missing/node',
      }),
    ).toEqual({
      packageName: '@mearl/cloud-server',
      packageRoot: fs.realpathSync(packageRoot),
      executable: path.join(binDirectory, 'mearl-cloud-server'),
      manager: 'npm',
      command: fs.realpathSync(path.join(binDirectory, 'npm')),
      binDirectory,
    });
  });

  it('uses the package manager that invoked setup for a first install', () => {
    expect(
      resolveInvokingPackageManager({
        env: { npm_config_user_agent: 'pnpm/10.0.0 npm/? node/v22' },
        existsSync: candidate => candidate === '/tools/pnpm',
        processExecPath: '/tools/node',
      }),
    ).toEqual({ manager: 'pnpm', command: '/tools/pnpm' });
  });

  it.each([false, true])(
    'resolves a pnpm global bin wrapper with includeLinked=%s',
    includeLinked => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-setup-pnpm-test-'));
      temporaryDirectories.push(directory);
      const packageRoot = path.join(
        directory,
        'global/5/.pnpm/@mearl+cloud-server@2.2.0/node_modules/@mearl/cloud-server',
      );
      const binDirectory = path.join(directory, 'bin');
      const executable = path.join(binDirectory, 'mearl-cloud-server');
      const pnpmCommand = path.join(directory, 'pnpm');
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.mkdirSync(binDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@mearl/cloud-server' }),
      );
      fs.writeFileSync(
        executable,
        [
          '#!/bin/sh',
          'basedir=$(dirname "$0")',
          'exec node "$basedir/../global/5/.pnpm/@mearl+cloud-server@2.2.0/node_modules/@mearl/cloud-server/dist/cli.js" "$@"',
        ].join('\n'),
      );
      fs.chmodSync(executable, 0o755);
      fs.writeFileSync(pnpmCommand, '');
      fs.chmodSync(pnpmCommand, 0o755);

      expect(
        detectGlobalPackage('@mearl/cloud-server', ['mearl-cloud-server'], {
          includeLinked,
          env: { PATH: binDirectory },
          processExecPath: '/missing/node',
        }),
      ).toEqual({
        packageName: '@mearl/cloud-server',
        packageRoot,
        executable,
        manager: 'pnpm',
        command: pnpmCommand,
        binDirectory,
      });
    },
  );

  it.each([false, true])('resolves a pnpm Windows wrapper with includeLinked=%s', includeLinked => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-setup-pnpm-win-test-'));
    temporaryDirectories.push(directory);
    const packageRoot = path.join(
      directory,
      'global/5/.pnpm/@mearl+cloud-server@2.2.0/node_modules/@mearl/cloud-server',
    );
    const binDirectory = path.join(directory, 'bin');
    const executable = path.join(binDirectory, 'mearl-cloud-server.cmd');
    const pnpmCommand = path.join(directory, 'pnpm.cmd');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@mearl/cloud-server' }),
    );
    fs.writeFileSync(
      executable,
      [
        '@ECHO off',
        '"%~dp0\\node.exe" "%~dp0\\..\\global\\5\\.pnpm\\@mearl+cloud-server@2.2.0\\node_modules\\@mearl\\cloud-server\\dist\\cli.js" %*',
      ].join('\r\n'),
    );
    fs.writeFileSync(pnpmCommand, '');

    expect(
      detectGlobalPackage('@mearl/cloud-server', ['mearl-cloud-server'], {
        includeLinked,
        env: { PATH: binDirectory },
        platform: 'win32',
        processExecPath: 'C:\\missing\\node.exe',
      }),
    ).toEqual({
      packageName: '@mearl/cloud-server',
      packageRoot,
      executable,
      manager: 'pnpm',
      command: pnpmCommand,
      binDirectory,
    });
  });
});
