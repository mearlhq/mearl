import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectNativeHostInstallation, MEARL_NATIVE_HOST_NAMES } from '../nativeHost.js';

const directories: string[] = [];

function createInstallation(mode: 'skills' | 'mcp' = 'skills') {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-native-registration-'));
  directories.push(hostDir);
  const launcher = path.join(hostDir, 'launcher.sh');
  const hostPath = path.join(hostDir, 'host.js');
  fs.writeFileSync(hostPath, '');
  const manifest = path.join(hostDir, `${MEARL_NATIVE_HOST_NAMES[mode]}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ path: launcher }));
  const writeLauncher = (nodePaths: string[], legacy = false) => {
    const content = legacy
      ? `NODE_BIN=${JSON.stringify(nodePaths[0])}\nHOST_SCRIPT=${JSON.stringify(hostPath)}\n`
      : `# mearl-native-host-launcher: ${JSON.stringify({ version: 1, nodePaths, hostPath })}\n`;
    fs.writeFileSync(launcher, `#!/bin/sh\n${content}`, { mode: 0o755 });
  };
  const inspect = () => inspectNativeHostInstallation({ hostDir, platform: 'darwin' });
  return { hostDir, launcher, hostPath, manifest, writeLauncher, inspect };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('offline Native Messaging diagnostics', () => {
  it('ignores absent registrations', () => {
    const installation = createInstallation();
    fs.unlinkSync(installation.manifest);
    expect(installation.inspect()).toEqual([]);
  });

  it.each(['skills', 'mcp'] as const)(
    'diagnoses an obsolete version path in a legacy %s launcher',
    mode => {
      const installation = createInstallation(mode);
      const oldNode = '/opt/homebrew/Cellar/node/0.0.0/bin/node';
      installation.writeLauncher([oldNode], true);

      const diagnostics = installation.inspect();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].label).toContain(MEARL_NATIVE_HOST_NAMES[mode]);
      expect(diagnostics[0].details.join('\n')).toContain(oldNode);
      expect(diagnostics[0].details.join('\n')).toContain('mearl-native-host init');
    },
  );

  it('accepts a usable fallback when the preferred runtime is missing', () => {
    const installation = createInstallation();
    installation.writeLauncher([path.join(installation.hostDir, 'missing-node'), process.execPath]);
    expect(installation.inspect()).toEqual([]);
  });

  it('reports every failed Node candidate', () => {
    const installation = createInstallation();
    const candidates = ['old-node', 'broken-opt'].map(name =>
      path.join(installation.hostDir, name),
    );
    installation.writeLauncher(candidates);
    const text = JSON.stringify(installation.inspect());
    for (const candidate of candidates) expect(text).toContain(candidate);
  });

  it('reports a missing runtime script separately from Node', () => {
    const installation = createInstallation();
    installation.writeLauncher([process.execPath]);
    fs.unlinkSync(installation.hostPath);
    const diagnostics = installation.inspect();
    expect(diagnostics[0].details[0]).toContain('runtime script');
    expect(diagnostics[0].details[0]).toContain(installation.hostPath);
    expect(diagnostics[0].details.join('\n')).toContain('npx @mearl/setup update --local');
  });

  it('reports a missing launcher', () => {
    const installation = createInstallation();
    expect(installation.inspect()[0].details[0]).toContain(installation.launcher);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a non-executable Node candidate and a directory',
    () => {
      const installation = createInstallation();
      const nonExecutable = path.join(installation.hostDir, 'node');
      fs.writeFileSync(nonExecutable, '#!/bin/sh\n', { mode: 0o644 });
      installation.writeLauncher([nonExecutable, installation.hostDir]);
      expect(installation.inspect()[0].details[0]).toContain('No executable Node.js');
    },
  );

  it('reports malformed metadata without running shell content', () => {
    const installation = createInstallation();
    fs.writeFileSync(
      installation.launcher,
      '#!/bin/sh\n# mearl-native-host-launcher: {invalid}\nexit 99',
      { mode: 0o755 },
    );
    expect(installation.inspect()[0].details[0]).toContain('Cannot inspect');
  });

  it('reports malformed manifests without blocking other inspections', () => {
    const installation = createInstallation();
    installation.writeLauncher([process.execPath]);
    fs.writeFileSync(
      path.join(installation.hostDir, `${MEARL_NATIVE_HOST_NAMES.mcp}.json`),
      JSON.stringify({ path: installation.launcher }),
    );
    fs.writeFileSync(installation.manifest, '{invalid}');
    const diagnostics = installation.inspect();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].details[0]).toContain(installation.manifest);
  });

  it('reads metadata in a Windows command launcher', () => {
    const installation = createInstallation();
    fs.writeFileSync(
      installation.launcher,
      [
        '@echo off',
        `rem mearl-native-host-launcher: ${JSON.stringify({
          version: 1,
          nodePaths: [process.execPath],
          hostPath: installation.hostPath,
        })}`,
        `"${process.execPath}" "${installation.hostPath}" %*`,
      ].join('\r\n'),
      { mode: 0o755 },
    );
    expect(
      inspectNativeHostInstallation({ hostDir: installation.hostDir, platform: 'win32' }),
    ).toEqual([]);
  });
});
