import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MEARL_NATIVE_HOST_NAMES,
  resolveNativeHostDirectory,
  type NativeHostIntegrationMode,
} from '@mearl/client/native-host';

export { MEARL_NATIVE_HOST_NAMES, resolveNativeHostDirectory, type NativeHostIntegrationMode };

export interface NativeHostCleanupOptions {
  mode?: NativeHostIntegrationMode | 'both';
  silent?: boolean;
}

export interface NativeHostCleanupDependencies {
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
  homedir?: () => string;
  hostDir?: string;
  platform?: NodeJS.Platform;
  unlinkSync?: typeof fs.unlinkSync;
  unregisterWindowsNativeHost?: (hostName: string) => void;
  writeLine?: (line: string) => void;
}

function unregisterWindowsNativeHost(hostName: string): void {
  const registryKey = `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
  try {
    execFileSync('reg', ['delete', registryKey, '/f'], { stdio: 'pipe' });
  } catch {
    // A missing registry key is already the desired state.
  }
}

export function uninstallNativeHostArtifacts(
  options: NativeHostCleanupOptions = {},
  dependencies: NativeHostCleanupDependencies = {},
): boolean {
  const { mode = 'both', silent = false } = options;
  if (mode === 'both') {
    return (['skills', 'mcp'] as const)
      .map(integrationMode =>
        uninstallNativeHostArtifacts({ ...options, mode: integrationMode }, dependencies),
      )
      .every(Boolean);
  }

  const writeLine = dependencies.writeLine ?? (line => console.error(line));
  const log = (line: string): void => {
    if (!silent) writeLine(line);
  };

  try {
    const existsSync = dependencies.existsSync ?? fs.existsSync;
    const platform = dependencies.platform ?? process.platform;
    const hostDir =
      dependencies.hostDir ??
      resolveNativeHostDirectory({
        env: dependencies.env,
        homedir: dependencies.homedir,
        platform,
      });
    const unlinkSync = dependencies.unlinkSync ?? fs.unlinkSync;
    const unregister = dependencies.unregisterWindowsNativeHost ?? unregisterWindowsNativeHost;
    const hostName = MEARL_NATIVE_HOST_NAMES[mode];
    const launcherExtension = platform === 'win32' ? 'cmd' : 'sh';
    const artifacts = [
      path.join(hostDir, `${hostName}.json`),
      path.join(hostDir, `${hostName}-launcher.${launcherExtension}`),
    ];

    for (const artifact of artifacts) {
      if (!existsSync(artifact)) continue;
      unlinkSync(artifact);
      log(`✅ Removed: ${artifact}`);
    }
    if (platform === 'win32') unregister(hostName);
    return true;
  } catch (error) {
    log(`❌ Uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
