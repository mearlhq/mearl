import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  findExecutable,
  npmExecEnvironment,
  prependPathDirectory,
  runCommand,
  withOwnedCommands,
  versionManagerExecutableCandidates,
} from '../command.js';

it('retains command ownership in both outer setup and nested component leases', async () => {
  const outer = { started: vi.fn(), finished: vi.fn() };
  const inner = { started: vi.fn(), finished: vi.fn() };
  const result = await withOwnedCommands(outer, () => withOwnedCommands(inner, () => runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { capture: true })));
  expect(result.stdout).toBe('ok');
  expect(outer.started).toHaveBeenCalledOnce();
  expect(inner.started).toHaveBeenCalledWith(outer.started.mock.calls[0][0]);
  expect(outer.finished).toHaveBeenCalledWith(outer.started.mock.calls[0][0]);
  expect(inner.finished).toHaveBeenCalledWith(outer.started.mock.calls[0][0]);
});

describe('npmExecEnvironment', () => {
  it('removes inherited package selectors while preserving installation configuration', () => {
    const environment = {
      npm_config_package: '@mearl/client@2.22.4',
      NPM_CONFIG_PACKAGE: '@mearl/setup@2.22.4',
      npm_config_registry: 'https://registry.example.com/',
      HTTPS_PROXY: 'http://proxy.example.com',
      PATH: '/usr/bin',
    };

    expect(npmExecEnvironment(environment)).toEqual({
      npm_config_registry: environment.npm_config_registry,
      HTTPS_PROXY: environment.HTTPS_PROXY,
      PATH: environment.PATH,
    });
    expect(environment.npm_config_package).toBe('@mearl/client@2.22.4');
    expect(environment.NPM_CONFIG_PACKAGE).toBe('@mearl/setup@2.22.4');
  });

  it('runs a nested npx package from an npm exec environment without registry access', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'mearl-npm-exec-'));
    try {
      const fixture = path.join(directory, 'fixture');
      mkdirSync(fixture);
      writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name: 'mearl-npm-exec-fixture', version: '1.0.0', bin: './bin.js' }),
      );
      writeFileSync(
        path.join(fixture, 'bin.js'),
        `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), registry: process.env.npm_config_registry }));
`,
        { mode: 0o755 },
      );
      const npx = findExecutable('npx', { extraDirectories: [path.dirname(process.execPath)] });
      expect(npx).not.toBeNull();
      const result = await runCommand(
        npx!,
        ['--offline', '--yes', fixture, 'plugin', 'ensure', 'sample-request'],
        {
          cwd: directory,
          capture: true,
          timeoutMs: 15_000,
          env: npmExecEnvironment({
            ...process.env,
            npm_config_package: '@mearl/client@2.22.4',
            npm_config_registry: 'https://registry.invalid/',
            npm_config_cache: path.join(directory, 'cache'),
          }),
        },
      );
      expect(result.stderr).not.toContain('No such file or directory');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        args: ['plugin', 'ensure', 'sample-request'],
        registry: 'https://registry.invalid/',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

it('tees stdout and stderr while capturing complete UTF-8 output', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const result = await runCommand(
      process.execPath,
      [
        '-e',
        `
      const bytes = Buffer.from('✓ 文档');
      process.stdout.write(bytes.subarray(0, 1));
      setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.stderr.write('progress'); }, 20);
    `,
      ],
      { tee: true },
    );
    expect(result).toEqual({ code: 0, stdout: '✓ 文档', stderr: 'progress' });
    expect(stdout.mock.calls.map(([chunk]) => chunk).join('')).toBe('✓ 文档');
    expect(stderr).toHaveBeenCalledWith('progress');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

describe('prependPathDirectory', () => {
  it('adds a global package bin without mutating the source environment', () => {
    const environment = { PATH: '/usr/bin' };

    expect(prependPathDirectory('/tools/global/bin', environment)).toEqual({
      PATH: `/tools/global/bin${path.delimiter}/usr/bin`,
    });
    expect(environment).toEqual({ PATH: '/usr/bin' });
  });
});

describe('versionManagerExecutableCandidates', () => {
  const directory = (name: string) => ({
    name,
    isDirectory: () => true,
  });

  it('uses configured NVM and FNM roots', () => {
    const readdirSync = vi.fn((root: string) => {
      if (root === '/tools/nvm/versions/node') return [directory('v20.19.5')];
      if (root === '/tools/fnm/node-versions') return [directory('v22.14.0')];
      throw new Error('missing directory');
    }) as unknown as typeof import('node:fs').readdirSync;

    const candidates = versionManagerExecutableCandidates('/home/test', ['agent'], {
      env: {
        NVM_DIR: '/tools/nvm',
        FNM_DIR: '/tools/fnm',
      },
      platform: 'linux',
      readdirSync,
    });

    expect(candidates).toContain('/tools/nvm/versions/node/v20.19.5/bin/agent');
    expect(candidates).toContain('/tools/fnm/node-versions/v22.14.0/installation/bin/agent');
  });

  it.each([
    ['linux', {}, '/home/test/.local/share/fnm/node-versions'],
    ['linux', { XDG_DATA_HOME: '/data' }, '/data/fnm/node-versions'],
    ['darwin', {}, '/home/test/Library/Application Support/fnm/node-versions'],
    ['darwin', { XDG_DATA_HOME: '/data' }, '/data/fnm/node-versions'],
    ['win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, null],
  ] as const)('uses the %s FNM default root', (platform, env, expectedRoot) => {
    const roots: string[] = [];
    const readdirSync = vi.fn((root: string) => {
      roots.push(root);
      throw new Error('missing directory');
    }) as unknown as typeof import('node:fs').readdirSync;

    versionManagerExecutableCandidates('/home/test', ['agent'], {
      env,
      platform,
      readdirSync,
    });

    const root =
      expectedRoot ?? path.join('C:\\Users\\test\\AppData\\Roaming', 'fnm', 'node-versions');
    expect(roots).toContain(root);
  });
});
