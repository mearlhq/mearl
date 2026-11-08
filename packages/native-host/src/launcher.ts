import fs from 'node:fs';
import path from 'node:path';
import type { NativeHostLauncherMetadata } from '@mearl/client/native-host';

function resolveLauncherNodePaths(execPath: string): string[] {
  const nodePath = path.resolve(execPath);
  const homebrewNode = nodePath.match(
    /^(.*)\/Cellar\/(node(?:@\d+(?:\.\d+)*)?)\/[^/]+\/bin\/node$/,
  );
  if (!homebrewNode) return [nodePath];

  const [, prefix, formula] = homebrewNode;
  const stablePath = path.join(prefix, 'opt', formula, 'bin', 'node');
  try {
    fs.accessSync(stablePath, fs.constants.X_OK);
    // Keep the installing formula and runtime; Homebrew maintains opt across upgrades.
    if (
      fs.statSync(stablePath).isFile() &&
      fs.realpathSync(stablePath) === fs.realpathSync(nodePath)
    ) {
      return [stablePath, nodePath];
    }
  } catch {
    // An unavailable opt entry leaves the installing runtime as the usable path.
  }
  return [nodePath, stablePath];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createLauncherScript(
  hostDir: string,
  hostPath: string,
  hostName: string,
  execPath: string = process.execPath,
): string {
  const nodePaths =
    process.platform === 'win32' ? [path.resolve(execPath)] : resolveLauncherNodePaths(execPath);
  // Read-only CLI diagnostics use this metadata without executing the launcher.
  const metadata: NativeHostLauncherMetadata = { version: 1, nodePaths, hostPath };
  const metadataLine = `mearl-native-host-launcher: ${JSON.stringify(metadata)}`;

  if (process.platform === 'win32') {
    const launcherPath = path.join(hostDir, `${hostName}-launcher.cmd`);
    const content = `@echo off\r\nrem ${metadataLine}\r\n"${nodePaths[0]}" "${hostPath}" %*\r\n`;
    fs.writeFileSync(launcherPath, content, 'utf-8');
    return launcherPath;
  }

  const launcherPath = path.join(hostDir, `${hostName}-launcher.sh`);
  const content = [
    '#!/bin/sh',
    `# ${metadataLine}`,
    `HOST_SCRIPT=${shellQuote(hostPath)}`,
    'if [ ! -f "$HOST_SCRIPT" ] || [ ! -r "$HOST_SCRIPT" ]; then',
    '  printf \'%s\\n\' "Mearl native host: runtime script is missing or unreadable: $HOST_SCRIPT" >&2',
    "  printf '%s\\n' 'Run npx @mearl/setup update --local to repair the installation.' >&2",
    '  exit 1',
    'fi',
    `for NODE_BIN in ${nodePaths.map(shellQuote).join(' ')}; do`,
    '  if [ -f "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then',
    '    PATH="${NODE_BIN%/*}${PATH:+:$PATH}"',
    '    export PATH',
    '    exec "$NODE_BIN" "$HOST_SCRIPT" "$@"',
    '  fi',
    'done',
    `printf '%s\\n' ${shellQuote(`Mearl native host: no executable Node.js found. Tried: ${nodePaths.join(', ')}`)} >&2`,
    "printf '%s\\n' 'Run mearl-native-host init with a working Node.js, then reopen the extension.' >&2",
    'exit 127',
    '',
  ].join('\n');
  fs.writeFileSync(launcherPath, content, 'utf-8');
  fs.chmodSync(launcherPath, 0o755);

  return launcherPath;
}
