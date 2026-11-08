import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_HOME, isAlive } from '@mearl/daemon-core';
import {
  resolvePackageManagerInstallation,
  type PackageManagerInstallation,
} from '@mearl/setup/package-manager';
import {
  findExecutable,
  npmExecEnvironment,
  prependCommandPath,
  prependNodePath,
  prependPathDirectory,
  runCommand,
  type CommandRunner,
} from '@mearl/daemon-core';
import {
  compareMearlReleaseLines,
  isMearlReleaseVersion,
  isMearlReleaseVersionInLine,
  mearlReleaseLineForVersion,
} from '@mearl/setup/version';

export const NATIVE_HOST_UPDATE_TIMEOUT_MS = 5 * 60_000;

const UPDATE_LOCK_PATH = path.join(DAEMON_HOME, 'native-host-update.lock');
const UPDATE_LOCK_POLL_MS = 500;
const INVALID_UPDATE_LOCK_GRACE_MS = 10_000;

export type NativeHostUpdateError =
  | 'lock-timeout'
  | 'network'
  | 'package-unavailable'
  | 'setup-failed'
  | 'timeout'
  | 'verification-failed'
  | 'unknown';

export interface NativeHostUpdateCommand {
  args: string[];
}

type UpdateLockRunner = <T>(targetVersion: string, operation: () => Promise<T>) => Promise<T>;

export interface RunNativeHostUpdateOptions {
  areTargetsInstalled?: (
    targetReleaseLine: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<boolean>;
  environment?: NodeJS.ProcessEnv;
  nodePath?: string;
  packageBinDirectory?: string | null;
  packageManagerCommand?: string | null;
  packageRunner?: string;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  timeoutMs?: number;
  updateLockPath?: string;
  withUpdateLock?: UpdateLockRunner;
}

export interface NativeHostUpdateCoordinatorOptions {
  hostVersion: string;
  log: (...args: unknown[]) => void;
  requestRestart: () => void | Promise<void>;
  runUpdate: (targetVersion: string) => Promise<void>;
}

export class NativeHostUpdateFailure extends Error {
  constructor(
    readonly updateError: NativeHostUpdateError,
    message: string,
  ) {
    super(message);
    this.name = 'NativeHostUpdateFailure';
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

interface UpdateLockState {
  modifiedAt: number;
  owner: { pid: number; startedAt: number } | null;
}

function readLockState(lockPath: string): UpdateLockState | null {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) {
      return { modifiedAt: stat.mtimeMs, owner: null };
    }
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      const owner =
        Number.isInteger(value.pid) &&
        (value.pid as number) > 0 &&
        typeof value.startedAt === 'number' &&
        Number.isFinite(value.startedAt) &&
        value.startedAt > 0
          ? { pid: value.pid as number, startedAt: value.startedAt }
          : null;
      return { modifiedAt: stat.mtimeMs, owner };
    } catch {
      return { modifiedAt: stat.mtimeMs, owner: null };
    }
  } catch {
    return null;
  }
}

async function withNativeHostUpdateLock<T>(
  lockPath: string,
  targetVersion: string,
  operation: () => Promise<T>,
): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const owner = `${JSON.stringify({ pid: process.pid, startedAt, targetVersion })}\n`;

  while (true) {
    try {
      const handle = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(handle, owner, 'utf8');
      } finally {
        fs.closeSync(handle);
      }
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const existing = readLockState(lockPath);
      const staleAfter = existing?.owner
        ? NATIVE_HOST_UPDATE_TIMEOUT_MS
        : INVALID_UPDATE_LOCK_GRACE_MS;
      const referenceTime = existing?.owner?.startedAt ?? existing?.modifiedAt;
      const expired = referenceTime !== undefined && Date.now() - referenceTime > staleAfter;
      const ownerAlive = existing?.owner ? isAlive(existing.owner.pid) : false;
      if (expired && !ownerAlive) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Another waiter may have recovered the same stale lock.
        }
      }
      if (Date.now() - startedAt > NATIVE_HOST_UPDATE_TIMEOUT_MS + 10_000) {
        throw new NativeHostUpdateFailure(
          'lock-timeout',
          'Another Mearl Native Host update did not finish in time',
        );
      }
      await wait(UPDATE_LOCK_POLL_MS);
    }
  }

  try {
    return await operation();
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === owner) fs.unlinkSync(lockPath);
    } catch {
      // The update result is authoritative even if best-effort lock cleanup fails.
    }
  }
}

function classifyUpdateFailure(output: string): NativeHostUpdateError {
  if (
    /\b(?:E404|ETARGET)\b|no matching version found|404\s+not found|package.+not found/i.test(
      output,
    )
  ) {
    return 'package-unavailable';
  }
  if (
    /\b(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ERR_SOCKET_TIMEOUT)\b|fetch failed|network request/i.test(
      output,
    )
  ) {
    return 'network';
  }
  return 'setup-failed';
}

export function nativeHostUpdateCommand(targetVersion: string): NativeHostUpdateCommand {
  if (!isMearlReleaseVersion(targetVersion)) {
    throw new Error('The Native Host update target must be a valid Mearl release');
  }
  const releaseLine = mearlReleaseLineForVersion(targetVersion);
  const beta = targetVersion.includes('-beta.');
  const packageSpec = `@mearl/setup@${beta ? targetVersion : releaseLine}`;
  const args = [
    '--yes',
    packageSpec,
    'update',
    '--local',
    '--yes',
    ...(beta ? [] : ['--target-line', releaseLine]),
    '--skip-skill',
  ];
  return {
    args,
  };
}

function currentNativeHostPackageRoot(entryPath: string): string | null {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (manifest.name === '@mearl/native-host') return current;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function currentPackageManagerInstallation(
  environment: NodeJS.ProcessEnv,
  nodePath: string,
  platform: NodeJS.Platform,
): PackageManagerInstallation | null {
  const packageRoot = currentNativeHostPackageRoot(fileURLToPath(import.meta.url));
  if (!packageRoot) return null;
  return resolvePackageManagerInstallation(packageRoot, '@mearl/native-host', {
    env: environment,
    platform,
    processExecPath: nodePath,
  });
}

async function installedLocalPackagesMatch(
  targetReleaseLine: string,
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<boolean> {
  const installedVersions: string[] = [];
  for (const executableName of ['mearl-native-host', 'mearl']) {
    const executable = findExecutable(executableName, { env: environment });
    if (!executable) return false;
    try {
      const result = await runner(executable, ['--version'], {
        capture: true,
        env: environment,
        timeoutMs: 5_000,
      });
      const installedVersion = result.stdout.trim();
      if (result.code !== 0 || !(targetReleaseLine.includes('-beta.') ? installedVersion === targetReleaseLine : isMearlReleaseVersionInLine(installedVersion, targetReleaseLine))) {
        return false;
      }
      installedVersions.push(installedVersion);
    } catch {
      return false;
    }
  }
  return new Set(installedVersions).size === 1;
}

export async function runNativeHostUpdate(
  targetVersion: string,
  options: RunNativeHostUpdateOptions = {},
): Promise<void> {
  const command = nativeHostUpdateCommand(targetVersion);
  const targetReleaseLine = targetVersion.includes('-beta.') ? targetVersion : mearlReleaseLineForVersion(targetVersion);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;
  const currentInstallation = currentPackageManagerInstallation(environment, nodePath, platform);
  const managerCommand =
    options.packageManagerCommand === undefined
      ? (currentInstallation?.command ?? null)
      : options.packageManagerCommand;
  const packageBinDirectory =
    options.packageBinDirectory === undefined
      ? (currentInstallation?.binDirectory ?? null)
      : options.packageBinDirectory;
  let childEnvironment = npmExecEnvironment(prependNodePath(environment, nodePath));
  if (managerCommand) childEnvironment = prependCommandPath(managerCommand, childEnvironment);
  if (packageBinDirectory) {
    childEnvironment = prependPathDirectory(packageBinDirectory, childEnvironment);
  }
  const packageRunner =
    options.packageRunner ??
    findExecutable('npx', {
      env: childEnvironment,
      extraDirectories: [path.dirname(nodePath)],
      platform,
    });
  if (!packageRunner) {
    throw new NativeHostUpdateFailure('package-unavailable', 'The package runner is unavailable');
  }
  const runner = options.runner ?? runCommand;
  const areTargetsInstalled =
    options.areTargetsInstalled ??
    ((version, env) => installedLocalPackagesMatch(version, env, runner));
  const withUpdateLock =
    options.withUpdateLock ??
    ((version, operation) =>
      withNativeHostUpdateLock(options.updateLockPath ?? UPDATE_LOCK_PATH, version, operation));

  await withUpdateLock(targetVersion, async () => {
    let result;
    try {
      result = await runner(packageRunner, command.args, {
        capture: true,
        env: childEnvironment,
        timeoutMs: options.timeoutMs ?? NATIVE_HOST_UPDATE_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyUpdateFailure(message);
      throw new NativeHostUpdateFailure(
        /timed out/i.test(message)
          ? 'timeout'
          : classified === 'setup-failed'
            ? 'unknown'
            : classified,
        'The Native Host update process did not complete',
      );
    }
    if (result.code !== 0) {
      throw new NativeHostUpdateFailure(
        classifyUpdateFailure(`${result.stderr.slice(0, 8_192)}\n${result.stdout.slice(0, 8_192)}`),
        'The Mearl setup release line did not complete successfully',
      );
    }
    if (!(await areTargetsInstalled(targetReleaseLine, childEnvironment))) {
      throw new NativeHostUpdateFailure(
        'verification-failed',
        'The installed Native Host and client do not match the Extension release line',
      );
    }
  });
}

export class NativeHostUpdateCoordinator {
  #automaticAttempted = false;
  #operation: Promise<void> | null = null;

  constructor(private readonly options: NativeHostUpdateCoordinatorOptions) {}

  evaluate(extensionVersion: unknown, checkForUpdates: unknown): void {
    if (checkForUpdates !== true || this.#automaticAttempted || this.#operation) return;
    if (
      !isMearlReleaseVersion(extensionVersion) ||
      !isMearlReleaseVersion(this.options.hostVersion)
    ) {
      this.options.log('Skipped Native Host update check because a release version was invalid');
      return;
    }
    const targetVersion = extensionVersion as string;
    if (compareMearlReleaseLines(this.options.hostVersion, targetVersion) >= 0) return;

    this.#automaticAttempted = true;
    const operation = this.options
      .runUpdate(targetVersion)
      .then(() => this.options.requestRestart())
      .catch(error => {
        const category =
          error instanceof NativeHostUpdateFailure ? error.updateError : ('unknown' as const);
        this.options.log(`Native Host automatic update failed (${category})`);
      })
      .finally(() => {
        if (this.#operation === operation) this.#operation = null;
      });
    this.#operation = operation;
  }
}
