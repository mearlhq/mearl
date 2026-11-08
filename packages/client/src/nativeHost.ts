import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEARL_NATIVE_HOST_NAMES, type NativeHostIntegrationMode } from '@mearl/browser-core';
export { MEARL_NATIVE_HOST_NAMES, type NativeHostIntegrationMode };

export interface NativeHostDirectoryOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
}

export function resolveNativeHostDirectory(options: NativeHostDirectoryOptions = {}): string {
  const env = options.env ?? process.env;
  const home = (options.homedir ?? os.homedir)();
  switch (options.platform ?? process.platform) {
    case 'darwin':
      return path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
    case 'linux':
      return path.join(home, '.config/google-chrome/NativeMessagingHosts');
    case 'win32':
      return path.join(
        env.PROGRAMDATA || 'C:\\ProgramData',
        'Google\\Chrome\\NativeMessagingHosts',
      );
    default:
      throw new Error(`Unsupported platform: ${String(options.platform ?? process.platform)}`);
  }
}

export interface NativeHostDiagnostic {
  label: string;
  details: string[];
}

export interface NativeHostLauncherMetadata {
  version: 1;
  nodePaths: string[];
  hostPath: string;
}

function readLauncherMetadata(content: string): NativeHostLauncherMetadata | null {
  const metadata = content.match(/^(?:#|rem) mearl-native-host-launcher: (.+)\r?$/m);
  if (metadata) {
    const parsed = JSON.parse(metadata[1]) as Record<string, unknown>;
    if (
      parsed.version === 1 &&
      Array.isArray(parsed.nodePaths) &&
      parsed.nodePaths.length > 0 &&
      parsed.nodePaths.every(value => typeof value === 'string' && path.isAbsolute(value)) &&
      typeof parsed.hostPath === 'string' &&
      path.isAbsolute(parsed.hostPath)
    ) {
      return { version: 1, nodePaths: parsed.nodePaths, hostPath: parsed.hostPath };
    }
    throw new Error('Invalid native host launcher metadata');
  }

  // Legacy launchers stored these assignments as JSON strings.
  const node = content.match(/^NODE_BIN=(".*")\r?$/m);
  const host = content.match(/^HOST_SCRIPT=(".*")\r?$/m);
  if (!node || !host) return null;
  const nodePath: unknown = JSON.parse(node[1]);
  const hostPath: unknown = JSON.parse(host[1]);
  if (
    typeof nodePath !== 'string' ||
    !path.isAbsolute(nodePath) ||
    typeof hostPath !== 'string' ||
    !path.isAbsolute(hostPath)
  ) {
    throw new Error('Invalid native host launcher paths');
  }
  return { version: 1, nodePaths: [nodePath], hostPath };
}

/** Inspect registrations even when Chrome cannot start the native host. Never execute launchers. */
export function inspectNativeHostInstallation(
  options: NativeHostDirectoryOptions & { hostDir?: string } = {},
): NativeHostDiagnostic[] {
  const platform = options.platform ?? process.platform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) return [];
  const hostDir = options.hostDir ?? resolveNativeHostDirectory(options);
  const diagnostics: NativeHostDiagnostic[] = [];
  const isUsable = (filePath: string, executable: boolean): boolean => {
    try {
      fs.accessSync(
        filePath,
        executable && platform !== 'win32' ? fs.constants.X_OK : fs.constants.R_OK,
      );
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  };

  for (const hostName of Object.values(MEARL_NATIVE_HOST_NAMES)) {
    const manifestPath = path.join(hostDir, `${hostName}.json`);
    const details: string[] = [];
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { path?: unknown };
      if (typeof manifest?.path !== 'string' || !path.isAbsolute(manifest.path)) {
        details.push(`Invalid launcher path in ${manifestPath}`);
      } else if (!isUsable(manifest.path, true)) {
        details.push(`Launcher is missing or not executable: ${manifest.path}`);
      } else {
        const metadata = readLauncherMetadata(fs.readFileSync(manifest.path, 'utf-8'));
        if (metadata) {
          if (!metadata.nodePaths.some(candidate => isUsable(candidate, true))) {
            details.push(
              `No executable Node.js found. Launcher candidates: ${metadata.nodePaths.join(', ')}`,
            );
          }
          if (!isUsable(metadata.hostPath, false)) {
            details.push(
              `Native host runtime script is missing or unreadable: ${metadata.hostPath}`,
            );
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(manifestPath))
        continue;
      details.push(
        `Cannot inspect ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (details.length) {
      diagnostics.push({
        label: `Native Messaging registration needs repair: ${hostName}`,
        details: [
          ...details,
          `Registration: ${manifestPath}`,
          'Run `mearl-native-host init` with a working Node.js, then reopen the extension. If the runtime package is missing, run `npx @mearl/setup update --local`.',
        ],
      });
    }
  }
  return diagnostics;
}
