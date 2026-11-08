import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createLauncherScript } from '../launcher.js';

const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-launcher-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createNode(prefix: string, formula: string, version: string): string {
  const nodePath = path.join(prefix, 'Cellar', formula, version, 'bin/node');
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(
    nodePath,
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
  );
  fs.chmodSync(nodePath, 0o755);
  return nodePath;
}

function linkFormula(prefix: string, formula: string, nodePath: string): string {
  const optPath = path.join(prefix, 'opt', formula);
  fs.mkdirSync(path.dirname(optPath), { recursive: true });
  fs.symlinkSync(path.dirname(path.dirname(nodePath)), optPath);
  return path.join(optPath, 'bin/node');
}

function readNodeCandidates(directory: string, nodePath: string): string[] {
  const launcher = createLauncherScript(directory, '/host/index.js', 'test-host', nodePath);
  return JSON.parse(
    fs.readFileSync(launcher, 'utf-8').split('\n')[1].replace('# mearl-native-host-launcher: ', ''),
  ).nodePaths;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('native host launcher', () => {
  it.each([
    ['opt/homebrew', 'node'],
    ['usr/local', 'node'],
    ['home/linuxbrew/.linuxbrew', 'node'],
    ['custom brew prefix', 'node@22'],
  ])('uses the stable formula path under %s for %s', (location, formula) => {
    const directory = createDirectory();
    const prefix = path.join(directory, location);
    const nodePath = createNode(prefix, formula, '22.12.0');
    const stablePath = linkFormula(prefix, formula, nodePath);

    expect(readNodeCandidates(directory, nodePath)).toEqual([stablePath, nodePath]);
  });

  it.each(['missing', 'broken', 'non-executable', 'different-runtime'])(
    'keeps the installing runtime when the stable entry is %s',
    state => {
      const directory = createDirectory();
      const nodePath = createNode(directory, 'node', '22.12.0');
      if (state === 'broken') {
        linkFormula(directory, 'node', path.join(directory, 'missing/bin/node'));
      } else if (state === 'non-executable') {
        linkFormula(directory, 'node', nodePath);
        fs.chmodSync(nodePath, 0o644);
      } else if (state === 'different-runtime') {
        linkFormula(directory, 'node', createNode(directory, 'node', '24.0.0'));
      }

      expect(readNodeCandidates(directory, nodePath)).toEqual([
        nodePath,
        path.join(directory, 'opt/node/bin/node'),
      ]);
    },
  );

  it.each([
    '/usr/bin/node',
    '/home/test/.nvm/versions/node/v22.12.0/bin/node',
    '/home/test/.local/share/fnm/node-versions/v22.12.0/installation/bin/node',
    '/opt/homebrew/Cellar/other-tool/22.12.0/bin/node',
  ])('preserves non-Homebrew Node paths: %s', nodePath => {
    expect(readNodeCandidates(createDirectory(), nodePath)).toEqual([nodePath]);
  });

  it('launches both integrations after an upgrade removes the old keg, with a minimal GUI PATH', () => {
    const directory = createDirectory();
    const prefix = path.join(directory, 'custom brew prefix');
    const oldNode = createNode(prefix, 'node', '22.12.0');
    const stablePath = linkFormula(prefix, 'node', oldNode);
    const hostPath = path.join(directory, 'host script.js');
    fs.writeFileSync(hostPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const launchers = ['skills', 'mcp'].map(mode =>
      createLauncherScript(directory, hostPath, `ai.mearl.${mode}`, oldNode),
    );

    const newNode = createNode(prefix, 'node', '22.13.0');
    fs.unlinkSync(path.join(prefix, 'opt/node'));
    linkFormula(prefix, 'node', newNode);
    fs.rmSync(path.join(prefix, 'Cellar/node/22.12.0'), { recursive: true });
    expect(fs.existsSync(oldNode)).toBe(false);
    const args = ['--version', 'argument with spaces', 'quote"value', '$HOME'];

    for (const launcher of launchers) {
      expect(fs.readFileSync(launcher, 'utf-8')).toContain(stablePath);
      const output = execFileSync(launcher, args, {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf-8',
      });
      expect(JSON.parse(output)).toEqual(args);
    }
    expect(readNodeCandidates(directory, newNode)).toEqual([stablePath, newNode]);
  });

  it('falls back to the original runtime and exposes it to child processes when opt disappears', () => {
    const directory = createDirectory();
    const nodePath = createNode(directory, 'node@22', '22.12.0');
    linkFormula(directory, 'node@22', nodePath);
    const hostPath = path.join(directory, 'host.js');
    fs.writeFileSync(
      hostPath,
      `
      import { execFileSync } from 'node:child_process';
      process.stdout.write(execFileSync('node', ['-p', 'process.env.PATH'], { encoding: 'utf-8' }));
    `,
    );
    const launcher = createLauncherScript(directory, hostPath, 'test-host', nodePath);
    fs.unlinkSync(path.join(directory, 'opt/node@22'));

    const output = execFileSync(launcher, [], { env: { PATH: '' }, encoding: 'utf-8' });
    expect(output.trim()).toBe(path.dirname(nodePath));
  });

  it('can use an opt entry created after installation when the old runtime is removed', () => {
    const directory = createDirectory();
    const oldNode = createNode(directory, 'node', '22.12.0');
    const hostPath = path.join(directory, 'host.js');
    fs.writeFileSync(hostPath, 'process.stdout.write("recovered");');
    const launcher = createLauncherScript(directory, hostPath, 'test-host', oldNode);
    const newNode = createNode(directory, 'node', '22.13.0');
    linkFormula(directory, 'node', newNode);
    fs.rmSync(path.join(directory, 'Cellar/node/22.12.0'), { recursive: true });

    expect(execFileSync(launcher, [], { env: { PATH: '' }, encoding: 'utf-8' })).toBe('recovered');
  });

  it('quotes Node and host paths literally, including shell syntax', () => {
    const directory = createDirectory();
    const prefix = path.join(
      directory,
      'brew \'quoted\' "$HOME" $(printf injected) `printf injected` \\path',
    );
    const nodePath = createNode(prefix, 'node', '22.12.0');
    linkFormula(prefix, 'node', nodePath);
    const hostPath = path.join(prefix, 'host \'quoted\' "$HOME" `printf injected`.js');
    fs.writeFileSync(hostPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const launcher = createLauncherScript(directory, hostPath, 'test-host', nodePath);

    expect(JSON.parse(execFileSync(launcher, ['literal $HOME'], { encoding: 'utf-8' }))).toEqual([
      'literal $HOME',
    ]);
  });

  it('reports unavailable runtimes on stderr without contaminating Native Messaging stdout', () => {
    const directory = createDirectory();
    const nodePath = createNode(directory, 'node', '22.12.0');
    const hostPath = path.join(directory, 'host.js');
    fs.writeFileSync(hostPath, 'throw new Error("must not start");');
    const launcher = createLauncherScript(directory, hostPath, 'test-host', nodePath);
    fs.unlinkSync(nodePath);

    const result = spawnSync(launcher, [], { env: { PATH: '' }, encoding: 'utf-8' });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no executable Node.js');
    expect(result.stderr).toContain(nodePath);
    expect(result.stderr).toContain(path.join(directory, 'opt/node/bin/node'));
    expect(result.stderr).toContain('mearl-native-host init');
  });

  it('reports a missing host script with a repair command', () => {
    const directory = createDirectory();
    const hostPath = path.join(directory, 'missing-host.js');
    const launcher = createLauncherScript(directory, hostPath, 'test-host');

    const result = spawnSync(launcher, [], { encoding: 'utf-8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(hostPath);
    expect(result.stderr).toContain('npx @mearl/setup update --local');
  });
});
