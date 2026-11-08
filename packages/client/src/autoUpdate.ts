import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmExecEnvironment } from '@mearl/daemon-core';
import { isNewerRelease, parseReleaseVersion } from './check.js';
import { loadCliAutoUpdateIntervalDays } from './unifiedConfig.js';

export type InstalledMearlEnvironment = { profile: 'local' | 'cloud' | 'mcp'; version: string };

interface AutoUpdateState {
  lastCheckDate?: string;
  lastResult?: {
    checkedAt: string;
    status: 'current' | 'updated' | 'skipped' | 'failed';
    version?: string;
    error?: string;
  };
}

interface ScheduleOptions {
  intervalDays?: number | null;
  packageRoot?: string | null;
  now?: Date;
  statePath?: string;
  lockPath?: string;
  workerPath?: string;
  launch?: (worker: string, installedVersion: string, packageRoot: string, token: string) => void;
}

interface WorkerOptions {
  fetchLatestVersion?: () => Promise<string>;
  getInstalledEnvironments?: () => InstalledMearlEnvironment[];
  update?: (
    version: string,
    packageRoot: string,
    profiles: InstalledMearlEnvironment['profile'][],
    updateClient: boolean,
  ) => Promise<void>;
  now?: Date;
  statePath?: string;
  lockPath?: string;
}

const CONFIG_DIR = join(homedir(), '.mearl');
const STATE_PATH = join(CONFIG_DIR, 'cli-auto-update-state.json');
const LOCK_PATH = join(CONFIG_DIR, 'cli-auto-update.lock');
const LOCK_STALE_MS = 10 * 60_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const VERSION_URL = 'https://registry.npmjs.org/@mearl%2Fclient/latest';

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
    ? timestamp / 86_400_000
    : null;
}

export function isCliUpdateDue(
  lastCheckDate: string | undefined,
  now: Date,
  intervalDays: number,
): boolean {
  const previous = typeof lastCheckDate === 'string' ? dayNumber(lastCheckDate) : null;
  const today = dayNumber(localDate(now));
  return (
    previous === null || today === null || today < previous || today - previous >= intervalDays
  );
}

export function isGlobalClientPackageRoot(
  packageRoot: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const resolvedRoot = platform === 'win32' ? win32.resolve(packageRoot) : resolve(packageRoot);
  const normalized = resolvedRoot.replaceAll('\\', '/').toLowerCase();
  if (!normalized.endsWith('/node_modules/@mearl/client')) return false;
  const pnpmGlobalRoot = /\/global\/\d+\/(?:\.pnpm\/.*\/)?node_modules\//.exec(normalized);
  if (pnpmGlobalRoot) {
    const pnpmHome = resolvedRoot.slice(0, pnpmGlobalRoot.index);
    return existsSync(join(pnpmHome, platform === 'win32' ? 'mearl.cmd' : 'mearl'));
  }
  if (normalized.includes('/.volta/tools/image/packages/')) return true;
  const npmSuffix = '/lib/node_modules/@mearl/client';
  if (platform !== 'win32' && normalized.endsWith(npmSuffix)) {
    const prefix = resolvedRoot.slice(0, -npmSuffix.length);
    try {
      return (
        realpathSync(join(prefix, 'bin', 'mearl')) ===
        realpathSync(join(packageRoot, 'dist', 'bin.js'))
      );
    } catch {
      return false;
    }
  }
  const windowsNpmRoot =
    platform === 'win32' && env.APPDATA
      ? `${win32.resolve(env.APPDATA).replaceAll('\\', '/').toLowerCase()}/npm/node_modules/@mearl/client`
      : null;
  return (
    normalized.includes('/.bun/install/global/') ||
    /\/(?:\.config\/yarn|\.yarn|yarn\/data|yarn)\/global\//.test(normalized) ||
    (platform === 'win32' && normalized === windowsNpmRoot)
  );
}

function globalSearchPath(pathValue: string | undefined): string | undefined {
  return pathValue
    ?.split(delimiter)
    .filter(directory => !/(?:^|[\\/])node_modules[\\/]\.bin[\\/]?$/i.test(directory))
    .join(delimiter);
}

function currentGlobalClientRoot(): string | null {
  let directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (manifest.name === '@mearl/client') {
        return isGlobalClientPackageRoot(directory) ? directory : null;
      }
    } catch {
      // Continue toward the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function readState(statePath: string): AutoUpdateState {
  try {
    const value: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as AutoUpdateState)
      : {};
  } catch {
    return {};
  }
}

function writeState(statePath: string, state: AutoUpdateState): void {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* No temporary file to remove. */
    }
    throw error;
  }
}

function acquireLock(lockPath: string, token: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, token);
      } finally {
        closeSync(descriptor);
      }
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS) return false;
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
  } catch {
    // A missing lock does not affect the current command or update result.
  }
}

function launchWorker(worker: string, version: string, packageRoot: string, token: string): void {
  const child = spawn(process.execPath, [worker, version, packageRoot, token], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', () => releaseLock(LOCK_PATH, token));
  child.unref();
}

/** Queue a detached check after the CLI command has finished. */
export function scheduleCliAutoUpdate(
  installedVersion: string,
  options: ScheduleOptions = {},
): void {
  try {
    const intervalDays =
      options.intervalDays === undefined ? loadCliAutoUpdateIntervalDays() : options.intervalDays;
    if (intervalDays === null) return;
    const packageRoot =
      options.packageRoot === undefined ? currentGlobalClientRoot() : options.packageRoot;
    if (!packageRoot) return;
    const now = options.now ?? new Date();
    const statePath = options.statePath ?? STATE_PATH;
    const lockPath = options.lockPath ?? LOCK_PATH;
    if (!isCliUpdateDue(readState(statePath).lastCheckDate, now, intervalDays)) return;
    const token = randomUUID();
    if (!acquireLock(lockPath, token)) return;
    let launched = false;
    try {
      if (!isCliUpdateDue(readState(statePath).lastCheckDate, now, intervalDays)) return;
      const worker =
        options.workerPath ?? fileURLToPath(new URL('./autoUpdateWorker.js', import.meta.url));
      if (!existsSync(worker)) return;
      (options.launch ?? launchWorker)(worker, installedVersion, packageRoot, token);
      launched = true;
    } finally {
      if (!launched) releaseLock(lockPath, token);
    }
  } catch {
    // Update scheduling must never change CLI behavior.
  }
}

export function setupUpdateCommand(
  version: string,
  packageRoot: string,
  profiles: InstalledMearlEnvironment['profile'][],
  updateClient: boolean,
): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  if (profiles.length === 0 && !updateClient) {
    throw new Error('An update target is required');
  }
  if (!parseReleaseVersion(version)) throw new Error('A valid Mearl release is required');
  const [major, minor] = version.split('.');
  const env = npmExecEnvironment();
  delete env.MEARL_AUTO_UPDATE_CLIENT_ROOT;
  delete env.MEARL_AUTO_UPDATE_CLIENT_ONLY;
  delete env.MEARL_AUTO_UPDATE_PROFILES;
  env.MEARL_AUTO_UPDATE_SEARCH_PATH = globalSearchPath(env.PATH);
  if (updateClient || profiles.some(profile => profile === 'local' || profile === 'cloud')) {
    env.MEARL_AUTO_UPDATE_CLIENT_ROOT = packageRoot;
  }
  if (profiles.length === 0) env.MEARL_AUTO_UPDATE_CLIENT_ONLY = '1';
  else env.MEARL_AUTO_UPDATE_PROFILES = profiles.join(',');
  return {
    command: 'npx',
    args: [
      '--yes',
      '--@mearl:registry=https://registry.npmjs.org',
      `@mearl/setup@${version}`,
      'update',
      '--yes',
      ...(version.includes('-beta.') ? [] : ['--target-line', `${major}.${minor}.x`]),
      '--skip-skill',
    ],
    env,
  };
}

function updateWithSetup(
  version: string,
  packageRoot: string,
  profiles: InstalledMearlEnvironment['profile'][],
  updateClient: boolean,
): Promise<void> {
  const { command, args, env } = setupUpdateCommand(version, packageRoot, profiles, updateClient);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    const timeout = setTimeout(() => child.kill(), UPDATE_TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Setup exited with code ${code ?? 'unknown'}`));
    });
  });
}

function installedEnvironments(): InstalledMearlEnvironment[] {
  const versions: InstalledMearlEnvironment[] = [];
  const env = { ...process.env, PATH: globalSearchPath(process.env.PATH) };
  const executables = [
    { profile: 'local', executable: 'mearl-native-host' },
    { profile: 'cloud', executable: 'mearl-cloud-server' },
    { profile: 'mcp', executable: 'mearl-mcp-server' },
  ] as const;
  for (const { profile, executable } of executables) {
    try {
      const result = spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1_024,
        windowsHide: true,
        shell: process.platform === 'win32',
        env,
      });
      const version = result.stdout?.trim();
      if (result.status === 0 && typeof version === 'string' && parseReleaseVersion(version)) {
        versions.push({ profile, version });
      }
    } catch {
      // Other installed environments can still be checked and updated.
    }
  }
  return versions;
}

async function fetchLatestClientVersion(): Promise<string> {
  const response = await fetch(VERSION_URL, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  const payload = (await response.json()) as { version?: unknown };
  const version = payload.version;
  if (typeof version !== 'string') {
    throw new Error('Registry returned an invalid release version');
  }
  return version;
}

/** Runs only in the detached worker process. */
export async function runCliAutoUpdate(
  installedVersion: string,
  packageRoot: string,
  token: string,
  options: WorkerOptions = {},
): Promise<void> {
  const statePath = options.statePath ?? STATE_PATH;
  const lockPath = options.lockPath ?? LOCK_PATH;
  try {
    writeState(statePath, {
      ...readState(statePath),
      lastCheckDate: localDate(options.now ?? new Date()),
    });
  } catch {
    releaseLock(lockPath, token);
    return;
  }
  let result: NonNullable<AutoUpdateState['lastResult']>;
  try {
    const version = await (options.fetchLatestVersion ?? fetchLatestClientVersion)();
    if (!parseReleaseVersion(version))
      throw new Error('Registry returned an invalid release version');
    const environments = (options.getInstalledEnvironments ?? installedEnvironments)();
    const installedVersions = [
      installedVersion,
      ...environments.map(environment => environment.version),
    ];
    const updateClient = isNewerRelease(version, installedVersion);
    const staleProfiles = environments
      .filter(environment => isNewerRelease(version, environment.version))
      .map(environment => environment.profile);
    const updateAvailable = updateClient || staleProfiles.length > 0;
    const newerInstalled = installedVersions.some(installed => isNewerRelease(installed, version));
    if (updateAvailable && newerInstalled) {
      result = {
        checkedAt: new Date().toISOString(),
        status: 'skipped',
        version,
        error: 'An installed component is newer than the latest published release',
      };
    } else if (updateAvailable) {
      await (options.update ?? updateWithSetup)(version, packageRoot, staleProfiles, updateClient);
      result = { checkedAt: new Date().toISOString(), status: 'updated', version };
    } else {
      result = { checkedAt: new Date().toISOString(), status: 'current', version };
    }
  } catch (error) {
    result = {
      checkedAt: new Date().toISOString(),
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    writeState(statePath, { ...readState(statePath), lastResult: result });
  } catch {
    /* The result is best effort. */
  }
  releaseLock(lockPath, token);
}
