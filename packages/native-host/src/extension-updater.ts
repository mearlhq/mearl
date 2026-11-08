import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DAEMON_HOME, isAlive } from '@mearl/daemon-core';
import {
  fetchBrowserExtensionRelease,
  updateSetupManagedBrowserExtensionFiles,
  type BrowserExtensionRelease,
} from '@mearl/setup/browser-extension';
import { compareMearlReleaseVersions, isMearlReleaseVersion } from '@mearl/setup/version';

const EXTENSION_UPDATE_LOCK_PATH = path.join(DAEMON_HOME, 'extension-update.lock');
const EXTENSION_UPDATE_LOCK_STALE_MS = 10 * 60_000;
const INVALID_UPDATE_LOCK_GRACE_MS = 10_000;

export interface SetupExtensionUpdateRequest {
  currentVersion: string;
  setupManagedPath: string;
}

export interface SetupExtensionUpdateResult {
  changelogUrl: string;
  updated: boolean;
  version: string;
}

export interface SetupExtensionUpdaterDependencies {
  fetchRelease?: () => Promise<BrowserExtensionRelease>;
  isProcessAlive?: (pid: number) => boolean;
  lockPath?: string;
  now?: () => number;
  updateFiles?: typeof updateSetupManagedBrowserExtensionFiles;
}

interface UpdateLockOwner {
  id: string;
  pid: number;
  startedAt: number;
}

interface UpdateLockState {
  modifiedAt: number;
  owner: UpdateLockOwner | null;
}

function readUpdateLock(lockPath: string): UpdateLockState | null {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) {
      return { modifiedAt: stat.mtimeMs, owner: null };
    }
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<UpdateLockOwner>;
      const owner =
        typeof value.id === 'string' &&
        Number.isInteger(value.pid) &&
        (value.pid ?? 0) > 0 &&
        typeof value.startedAt === 'number'
          ? (value as UpdateLockOwner)
          : null;
      return { modifiedAt: stat.mtimeMs, owner };
    } catch {
      return { modifiedAt: stat.mtimeMs, owner: null };
    }
  } catch {
    return null;
  }
}

async function withExtensionUpdateLock<T>(
  operation: () => Promise<T>,
  dependencies: SetupExtensionUpdaterDependencies,
): Promise<T> {
  const lockPath = dependencies.lockPath ?? EXTENSION_UPDATE_LOCK_PATH;
  const now = dependencies.now ?? Date.now;
  const isProcessAlive = dependencies.isProcessAlive ?? isAlive;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const owner: UpdateLockOwner = { id: randomUUID(), pid: process.pid, startedAt: now() };
  const serializedOwner = `${JSON.stringify(owner)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, serializedOwner, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const state = readUpdateLock(lockPath);
      const stale =
        state === null ||
        (state.owner
          ? now() - state.owner.startedAt > EXTENSION_UPDATE_LOCK_STALE_MS &&
            !isProcessAlive(state.owner.pid)
          : now() - state.modifiedAt > INVALID_UPDATE_LOCK_GRACE_MS);
      if (!stale || attempt > 0) {
        throw new Error('Another extension update is already running', { cause: error });
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        throw new Error('Another extension update is already running', { cause: unlinkError });
      }
    }
  }

  try {
    return await operation();
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === serializedOwner) fs.unlinkSync(lockPath);
    } catch {
      // The update result is authoritative even if lock cleanup races another process.
    }
  }
}

export async function updateSetupManagedExtension(
  request: SetupExtensionUpdateRequest,
  dependencies: SetupExtensionUpdaterDependencies = {},
): Promise<SetupExtensionUpdateResult> {
  if (!isMearlReleaseVersion(request.currentVersion)) {
    throw new Error('The running extension reported an invalid version');
  }
  if (!request.setupManagedPath || !path.isAbsolute(request.setupManagedPath)) {
    throw new Error('A setup-managed extension path is required');
  }

  const release = await (dependencies.fetchRelease ?? fetchBrowserExtensionRelease)();
  const changelogUrl = `https://github.com/mearlhq/mearl/releases/tag/v${release.version}`;
  if (compareMearlReleaseVersions(release.version, request.currentVersion) <= 0) {
    return { changelogUrl, updated: false, version: request.currentVersion };
  }

  return withExtensionUpdateLock(async () => {
    await (dependencies.updateFiles ?? updateSetupManagedBrowserExtensionFiles)({
      release,
      targetDirectory: request.setupManagedPath,
    });
    return { changelogUrl, updated: true, version: release.version };
  }, dependencies);
}
