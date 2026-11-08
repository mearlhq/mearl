/// <reference types="node" preserve="true" />
/**
 * Unified Native Messaging Host installer for Mearl.
 *
 * Registers a Chrome Native Messaging Host manifest so that the browser
 * extension can launch the native-host process via `chrome.runtime.connectNative()`.
 *
 * Both MCP and Skills integration modes share this installer. By default it
 * installs both hosts (they run the same binary and share one Unix socket, so
 * the two integrations can be used at the same time); pass a specific `--mode`
 * (CLI) or `mode` option (API) to install just one.
 *
 * CLI:
 *   mearl-native-host init [--mode skills|mcp|both] [--extension-id <id>]
 *
 * API:
 *   import { installNativeHost } from '@mearl/native-host';
 *   await installNativeHost(); // installs both
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLauncherScript } from './launcher.js';
import {
  MEARL_NATIVE_HOST_NAMES,
  resolveNativeHostDirectory,
  uninstallNativeHostArtifacts,
} from '@mearl/setup/native-host';

const DEFAULT_EXTENSION_ID = 'aoehhjnofngknnjefamjbplchbolghkm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntegrationMode = 'skills' | 'mcp';

/** All integration modes — used when installing every host manifest at once. */
const ALL_MODES: IntegrationMode[] = ['skills', 'mcp'];

export interface InstallOptions {
  /**
   * Integration mode. Determines the host name. Defaults to `'both'`, which
   * installs the manifests for both Skills and MCP so the two integrations can
   * be used simultaneously (they share the same Unix socket and handlers).
   */
  mode?: IntegrationMode | 'both';
  /** Chrome extension ID. Defaults to the published store ID. */
  extensionId?: string;
  /** Suppress console output when `true`. Uses stderr to avoid interfering with stdio transport. */
  silent?: boolean;
  /** Skip installation if the manifest file already exists. Defaults to `false`. */
  skipIfExists?: boolean;
}

export interface UninstallOptions {
  /** Integration manifest to remove. Defaults to both Skills and MCP. */
  mode?: IntegrationMode | 'both';
  /** Suppress console output when `true`. */
  silent?: boolean;
}

export interface UninstallDependencies {
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
  homedir?: () => string;
  hostDir?: string;
  platform?: NodeJS.Platform;
  unlinkSync?: typeof fs.unlinkSync;
  unregisterWindowsNativeHost?: (hostName: string) => void;
  writeLine?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

export function resolveHostDir(): string {
  return resolveNativeHostDirectory();
}

/**
 * Resolve the absolute path to the native-host runtime entry point (`index.js`).
 *
 * Priority:
 *  1. Sibling `index.js` (co-located build output — the common case)
 *  2. `require.resolve('@mearl/native-host/runtime')` (npm-installed package)
 */
function resolveNativeHostPath(): string {
  const siblingPath = path.join(__dirname, 'index.js');
  if (fs.existsSync(siblingPath)) {
    return siblingPath;
  }

  try {
    const require = createRequire(import.meta.url);
    return require.resolve('@mearl/native-host/runtime');
  } catch {
    throw new Error(
      'Cannot locate native-host runtime entry point. ' +
        'Ensure @mearl/native-host is installed correctly.',
    );
  }
}

/**
 * On Windows, Chrome discovers Native Messaging Hosts via the Windows Registry,
 * not by scanning a directory. We must create a registry key whose default value
 * points to the manifest JSON file.
 *
 * Registry path (per-user):
 *   HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\<hostName>
 *     (Default) = <manifestPath>
 */
function registerWindowsNativeHost(hostName: string, manifestPath: string): void {
  const regKey = `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;

  // REG ADD creates the key if it doesn't exist, and /f overwrites without prompting.
  // /ve sets the (Default) value, /t REG_SZ specifies string type.
  // Using execFileSync instead of execSync to avoid shell interpolation (command injection).
  execFileSync('reg', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    stdio: 'pipe',
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function installNativeHost(options: InstallOptions = {}): Promise<boolean> {
  const {
    mode = 'both',
    extensionId = DEFAULT_EXTENSION_ID,
    silent = false,
    skipIfExists = false,
  } = options;

  // Install every host manifest so Skills and MCP can be used at the same time.
  if (mode === 'both') {
    const results = await Promise.all(
      ALL_MODES.map(m => installNativeHost({ ...options, mode: m })),
    );
    return results.every(Boolean);
  }

  const hostName = MEARL_NATIVE_HOST_NAMES[mode];
  if (!hostName) {
    throw new Error(`Unknown mode: ${mode}. Expected 'skills' or 'mcp'.`);
  }

  const log = (...args: any[]) => {
    if (!silent) console.error(...args);
  };

  try {
    const hostDir = resolveHostDir();

    // Skip if manifest already exists (used by postinstall to avoid re-running)
    if (skipIfExists) {
      const manifestPath = path.join(hostDir, `${hostName}.json`);
      if (fs.existsSync(manifestPath)) {
        log(`✅ Already installed: ${manifestPath}`);
        return true;
      }
    }

    if (!fs.existsSync(hostDir)) {
      fs.mkdirSync(hostDir, { recursive: true });
      log(`✅ Created directory: ${hostDir}`);
    }

    const resolvedHostPath = resolveNativeHostPath();
    log(`✅ Native host path: ${resolvedHostPath}`);

    const launcherPath = createLauncherScript(hostDir, resolvedHostPath, hostName);
    log(`✅ Launcher script: ${launcherPath}`);

    const manifest = {
      name: hostName,
      description: 'Mearl Native Messaging Bridge',
      path: launcherPath,
      type: 'stdio' as const,
      allowed_origins: [`chrome-extension://${extensionId}/`],
    };

    const manifestPath = path.join(hostDir, `${hostName}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    if (process.platform === 'win32') {
      registerWindowsNativeHost(hostName, manifestPath);
      log(`✅ Windows registry key created for: ${hostName}`);
    } else {
      fs.chmodSync(manifestPath, 0o644);
    }

    log(`✅ Manifest installed: ${manifestPath}`);
    log(`✅ Extension ID: ${extensionId}`);
    log(`✅ Host name: ${hostName}`);

    return true;
  } catch (error) {
    log(`❌ Installation failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && 'code' in error && (error as any).code === 'EACCES') {
      log('\n   Permission denied. Try running with sudo.');
    }
    return false;
  }
}

export async function uninstallNativeHost(
  options: UninstallOptions = {},
  dependencies: UninstallDependencies = {},
): Promise<boolean> {
  return uninstallNativeHostArtifacts(options, dependencies);
}

// ---------------------------------------------------------------------------
// CLI entry point for Native Messaging manifest lifecycle commands.
// ---------------------------------------------------------------------------

export interface ParsedNativeHostInstallArgs {
  showHelp: boolean;
  uninstall: boolean;
  mode: IntegrationMode | 'both';
  extensionId?: string;
  skipIfExists: boolean;
}

export async function parseNativeHostInstallArgs(
  argv: string[],
): Promise<ParsedNativeHostInstallArgs> {
  const normalizedArgv =
    argv[0] === '--init'
      ? ['init', ...argv.slice(1)]
      : argv[0] === '--uninstall'
        ? ['uninstall', ...argv.slice(1)]
        : argv;
  let operation: 'init' | 'uninstall' = 'init';
  let mode: IntegrationMode | 'both' = 'both';
  let extensionId: string | undefined;
  let showHelp = false;
  let skipIfExists = false;
  let index = 0;

  if (normalizedArgv[0] === 'init' || normalizedArgv[0] === 'uninstall') {
    operation = normalizedArgv[0];
    index = 1;
  } else if (normalizedArgv[0] && !normalizedArgv[0].startsWith('-')) {
    throw new Error(`Unknown command: ${normalizedArgv[0]}`);
  }

  const readValue = (name: string): string | null => {
    const argument = normalizedArgv[index];
    if (argument === name) {
      const value = normalizedArgv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`argument missing for option '${name}'`);
      }
      index += 1;
      return value;
    }
    if (argument?.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    return null;
  };

  for (; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index];
    if (argument === '--help' || argument === '-h') {
      showHelp = true;
      continue;
    }
    if (argument === '--skip-if-exists') {
      skipIfExists = true;
      continue;
    }
    const parsedMode = readValue('--mode');
    if (parsedMode !== null) {
      if (parsedMode !== 'skills' && parsedMode !== 'mcp' && parsedMode !== 'both') {
        throw new Error(`Invalid --mode: ${parsedMode}. Allowed choices are skills, mcp, and both`);
      }
      mode = parsedMode;
      continue;
    }
    const parsedExtensionId = readValue('--extension-id');
    if (parsedExtensionId !== null) {
      extensionId = parsedExtensionId;
      continue;
    }
    throw new Error(
      argument?.startsWith('-')
        ? `unknown option '${argument}'`
        : `unexpected argument '${argument}'`,
    );
  }

  if (operation === 'uninstall' && extensionId) {
    throw new Error('--extension-id is only available for init');
  }
  if (operation === 'uninstall' && skipIfExists) {
    throw new Error('--skip-if-exists is only available for init');
  }
  return {
    showHelp,
    uninstall: operation === 'uninstall',
    mode,
    ...(extensionId ? { extensionId } : {}),
    skipIfExists,
  };
}

function printHelp(): void {
  console.error(`Usage:
  mearl-native-host init [options]
  mearl-native-host uninstall [options]

Options:
  --mode <skills|mcp|both> Integration mode (default: both — installs both hosts)
  --extension-id <id>      Chrome extension ID (default: ${DEFAULT_EXTENSION_ID})
  --skip-if-exists         Keep existing Native Messaging manifests unchanged
  -h, --help               Show this help message

Compatibility aliases:
  --init, --uninstall      Established flag forms for init and uninstall

Examples:
  mearl-native-host init
  mearl-native-host init --mode mcp
  mearl-native-host uninstall --mode skills
  mearl-native-host init --extension-id abcdefghijklmnopqrstuvwxyzabcdef`);
}

export async function runCli(argv: string[]): Promise<number> {
  let parsed: ParsedNativeHostInstallArgs;
  try {
    parsed = await parseNativeHostInstallArgs(argv);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    return 2;
  }

  if (parsed.showHelp) {
    printHelp();
    return 0;
  }

  if (parsed.extensionId && !/^[a-z]{32}$/.test(parsed.extensionId)) {
    console.error(`❌ Invalid extension ID: ${parsed.extensionId}`);
    console.error('   Must be a 32-character lowercase string (see chrome://extensions/)');
    return 2;
  }

  if (parsed.uninstall) {
    const success = await uninstallNativeHost({ mode: parsed.mode });
    if (success) console.error('\n✅ Uninstall complete!\n');
    return success ? 0 : 1;
  }

  const success = await installNativeHost({
    mode: parsed.mode,
    extensionId: parsed.extensionId,
    skipIfExists: parsed.skipIfExists,
  });

  if (success) {
    console.error(`
✅ Installation complete!

Next steps:
1. Ensure Chrome is running (the extension auto-connects to native host)
2. Start using CLI commands

Verify:
  mearl tab_list
  mearl get_requests --payload '{"tabId":12345,"count":1}'
`);
  }

  return success ? 0 : 1;
}
