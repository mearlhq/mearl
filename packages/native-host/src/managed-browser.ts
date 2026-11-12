/** Managed Chrome lifecycle for isolated, optionally headless browser instances. */

import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAEMON_HOME,
  hashKey,
  isAlive,
  keyedConfigFile,
  keyedDir,
  listRecordFiles,
  readRecord,
  removeRecord,
  pruneOrphanLogs,
  rotateLogIfNeeded,
  writeRecord,
  type DaemonRecord,
} from '@mearl/daemon-core';
import { CdpSession } from './cdp-backend/cdp-session.js';
import { pruneCdpSessionStorage } from './cdp-backend/plugin-pages.js';
import { readDevToolsActivePort } from './cdp-backend/discover.js';
import { cdpImportCookies } from './cdp-backend/cookie-transfer.js';
import { resolveCookieCopyPlan, type TransferableCookie } from './browser-cookie-copy.js';
import type { BuiltinBrowserLaunchOptions } from './builtin-provider-options.js';
import { stoppedPersistentBrowserRecord } from './persistent-browser-record.js';

const MANAGED_BROWSERS_SUBDIR = 'managed-browsers';
const MANAGED_BROWSER_LOCKS_SUBDIR = 'managed-browser-locks';
const MANAGED_PROFILES_SUBDIR = 'managed-profiles';
const LAUNCH_TIMEOUT_MS = 15000;
export const CLOSED_OWN_MANAGED_HOST = Symbol('closedOwnManagedHost');

export type ManagedBrowserUserAgentMode = NonNullable<BuiltinBrowserLaunchOptions['userAgentMode']>;

interface ManagedBrowserRecord extends DaemonRecord {
  pid: number;
  hostPid: number;
  browserId: string;
  name: string;
  headless: boolean;
  persistent: boolean;
  userDataDir: string;
  executablePath: string;
  cdpPort: number;
  createdAt: string;
  copiedCookies?: {
    domains: string[];
    count: number;
  };
}

export interface ManagedBrowserSummary {
  browserId: string;
  name: string;
  provider: 'local';
  headless: boolean;
  persistent: boolean;
  cdpPort: number;
  createdAt: string;
  copiedCookies?: ManagedBrowserRecord['copiedCookies'];
  running: boolean;
}

export interface ManagedBrowserManagerDeps {
  nativeHostScript: string;
  exportCookies: (domains: string[]) => Promise<TransferableCookie[]>;
  log: (...args: any[]) => void;
}

export function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error('name is required');
  if (name.length > 64) throw new Error('name must be at most 64 characters');
  if (/[/\\\0\r\n]/.test(name)) throw new Error('name contains unsupported characters');
  return name;
}

/** Use one case-insensitive identity for registry, locking, and persistent profile paths. */
export function managedBrowserId(name: string): string {
  return `managed:${name.toLocaleLowerCase('en-US')}`;
}

export function chromeExecutableCandidates(platform = process.platform): string[] {
  const envPath = process.env.MEARL_CHROME_PATH;
  const candidates = envPath ? [envPath] : [];
  if (platform === 'darwin') {
    return candidates.concat([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env.PROGRAMFILES ?? '';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? '';
    return candidates.concat([
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }
  return candidates.concat([
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]);
}

export function resolveChromeExecutable(explicitPath?: string): string {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`Chrome executable not found: ${explicitPath}`);
    return explicitPath;
  }
  const found = chromeExecutableCandidates().find(candidate => candidate && existsSync(candidate));
  if (!found) {
    throw new Error('Chrome executable not found. Set executablePath or MEARL_CHROME_PATH.');
  }
  return found;
}

export function desktopChromeUserAgent(version: string, platform = process.platform): string {
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) {
    throw new Error(`Invalid Chrome version: ${version}`);
  }
  const platformToken =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export function resolveChromeVersion(executablePath: string): string {
  const result = spawnSync(executablePath, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''} ${result.stderr ?? ''}`;
  const version = output.match(/\b(\d+(?:\.\d+){1,3})\b/)?.[1];
  if (!version) {
    throw new Error(`Could not determine Chrome version from: ${executablePath}`);
  }
  return version;
}

export function resolveUserAgentMode(value: unknown): ManagedBrowserUserAgentMode {
  if (value === undefined || value === 'default') return 'default';
  if (value === 'desktop') return 'desktop';
  throw new Error('userAgentMode must be "default" or "desktop"');
}

export function buildManagedChromeArgs(options: {
  userDataDir: string;
  headless: boolean;
  userAgent?: string;
}): string[] {
  return [
    `--user-data-dir=${options.userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=devtools://devtools',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.userAgent ? [`--user-agent=${options.userAgent}`] : []),
    'about:blank',
  ];
}

function browserSummary(record: ManagedBrowserRecord, running: boolean): ManagedBrowserSummary {
  return {
    browserId: record.browserId,
    name: record.name,
    provider: 'local',
    headless: record.headless,
    persistent: record.persistent,
    cdpPort: record.cdpPort,
    createdAt: record.createdAt,
    copiedCookies: record.copiedCookies,
    running,
  };
}

/** Verify both PID liveness and the instance-specific command line before managing a process. */
export function isManagedProcess(
  pid: number,
  commandMarker: string,
  platform = process.platform,
): boolean {
  if (!isAlive(pid)) return false;

  try {
    if (platform === 'win32') {
      const escapedMarker = commandMarker.replace(/'/g, "''");
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p.CommandLine -and $p.CommandLine.Contains('${escapedMarker}')) { exit 0 } else { exit 1 }`,
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
      return result.status === 0;
    }

    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 && result.stdout.includes(commandMarker);
  } catch {
    return false;
  }
}

interface ManagedBrowserState {
  record: ManagedBrowserRecord;
  running: boolean;
}

function hasLiveLifecycleLock(browserId: string): boolean {
  try {
    const token = readFileSync(keyedConfigFile(MANAGED_BROWSER_LOCKS_SUBDIR, browserId), 'utf-8');
    const pid = Number(token.split(':', 1)[0]);
    return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid);
  } catch {
    return false;
  }
}

function listRecords(): ManagedBrowserState[] {
  pruneOrphanLogs(keyedDir(MANAGED_BROWSERS_SUBDIR));
  const records: ManagedBrowserState[] = [];
  for (const file of listRecordFiles(keyedDir(MANAGED_BROWSERS_SUBDIR))) {
    const record = readRecord<ManagedBrowserRecord>(file);
    if (!record) {
      removeRecord(file);
      continue;
    }
    const running = isManagedProcess(record.pid, record.userDataDir);
    if (!running) {
      // Closing owns cleanup and may still need its host to send the receipt.
      if (hasLiveLifecycleLock(record.browserId) || readRecord(file)?.pid !== record.pid) continue;
      signalProcess(record.hostPid, 'SIGTERM', `--browser-id ${record.browserId}`);
      pruneCdpSessionStorage(
        keyedConfigFile('plugin-pages', `${record.browserId}:${record.userDataDir}`),
      );
      removeRecord(keyedConfigFile('browsers', record.browserId));
      if (!record.persistent) {
        removeRecord(file);
        rmSync(record.userDataDir, { recursive: true, force: true });
        continue;
      }
    }
    records.push({ record, running });
  }
  return records;
}

export function listManagedBrowsers(): ManagedBrowserSummary[] {
  return listRecords().map(({ record, running }) => browserSummary(record, running));
}

function findManagedRecord(selector: string): ManagedBrowserRecord | null {
  const normalized = selector.trim().toLowerCase();
  return (
    listRecords().find(
      ({ record }) =>
        record.browserId.toLowerCase() === normalized || record.name.toLowerCase() === normalized,
    )?.record ?? null
  );
}

async function waitForActivePort(userDataDir: string): Promise<number> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = readDevToolsActivePort(userDataDir);
    if (info) return info.port;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not expose a CDP port within ${LAUNCH_TIMEOUT_MS}ms`);
}

export async function waitForBrowserRegistration(
  browserId: string,
  expectedPid: number,
): Promise<void> {
  const file = keyedConfigFile('browsers', browserId);
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const record = readRecord(file);
    if (record?.pid === expectedPid && isAlive(expectedPid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Managed browser ${browserId} did not register within ${LAUNCH_TIMEOUT_MS}ms`);
}

function signalProcess(pid: number, signal: NodeJS.Signals, commandMarker: string): void {
  if (!isManagedProcess(pid, commandMarker)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited.
  }
}

async function waitForProcessExit(
  pid: number,
  commandMarker: string,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (isManagedProcess(pid, commandMarker)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return true;
}

export async function stopProcess(pid: number, commandMarker: string): Promise<boolean> {
  signalProcess(pid, 'SIGTERM', commandMarker);
  if (await waitForProcessExit(pid, commandMarker, 3000)) return true;
  signalProcess(pid, 'SIGKILL', commandMarker);
  return waitForProcessExit(pid, commandMarker, 1000);
}

function profileDirectory(browserId: string, persistent: boolean): string {
  if (!persistent) return mkdtempSync(join(tmpdir(), 'mearl-browser-'));
  const dir = join(DAEMON_HOME, MANAGED_PROFILES_SUBDIR, hashKey(browserId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function removeStoppedInstance(browserId: string): Promise<void> {
  const file = keyedConfigFile(MANAGED_BROWSERS_SUBDIR, browserId);
  const record = readRecord<ManagedBrowserRecord>(file);
  if (!record || isManagedProcess(record.pid, record.userDataDir)) return;

  await stopProcess(record.hostPid, `--browser-id ${record.browserId}`);
  removeRecord(file);
  removeRecord(keyedConfigFile('browsers', record.browserId));
  if (!record.persistent) rmSync(record.userDataDir, { recursive: true, force: true });
}

export function acquireLaunchLock(browserId: string): () => void {
  const lockDir = keyedDir(MANAGED_BROWSER_LOCKS_SUBDIR);
  const lockFile = keyedConfigFile(MANAGED_BROWSER_LOCKS_SUBDIR, browserId);
  mkdirSync(lockDir, { recursive: true });

  const token = `${process.pid}:${randomUUID()}`;
  const tryAcquire = (): boolean => {
    try {
      writeFileSync(lockFile, token, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return false;
    }
  };

  if (!tryAcquire()) {
    let observedToken = '';
    try {
      observedToken = readFileSync(lockFile, 'utf-8');
    } catch {
      // The owner may have released the lock between the create and read attempts.
    }
    const ownerPid = Number(observedToken.split(':', 1)[0]);
    if (Number.isInteger(ownerPid) && !isAlive(ownerPid)) {
      const staleFile = `${lockFile}.${process.pid}.${randomUUID()}.stale`;
      try {
        // Re-read immediately before the atomic move so a freshly replaced lock is not
        // reclaimed based on the previous owner's PID.
        if (readFileSync(lockFile, 'utf-8') !== observedToken) {
          throw new Error('Launch lock owner changed');
        }
        renameSync(lockFile, staleFile);
        const movedToken = readFileSync(staleFile, 'utf-8');
        if (movedToken === observedToken) {
          rmSync(staleFile, { force: true });
        } else {
          try {
            renameSync(staleFile, lockFile);
          } catch {
            // A live contender owns the lock path; keep its lock intact.
          }
        }
      } catch {
        // Another contender already recovered or replaced the stale lock.
      }
    }
    if (!tryAcquire())
      throw new Error(`Managed browser lifecycle operation already in progress: ${browserId}`);
  }

  return () => {
    try {
      if (readFileSync(lockFile, 'utf-8') === token) rmSync(lockFile, { force: true });
    } catch {
      // The lock has already been released or superseded.
    }
  };
}

export async function launchManagedBrowser(
  input: BuiltinBrowserLaunchOptions,
  deps: ManagedBrowserManagerDeps,
): Promise<Record<string, any>> {
  const name = validateName(input.name);
  const browserId = managedBrowserId(name);
  const cookieCopy = resolveCookieCopyPlan(input.copyCookieDomains);
  const copyCookieDomains = cookieCopy.domains;

  const headless = input.headless !== false;
  const persistent = input.persistent === true;
  const executablePath = resolveChromeExecutable(input.executablePath);
  const userAgentMode = resolveUserAgentMode(input.userAgentMode);
  const userAgent =
    userAgentMode === 'desktop'
      ? desktopChromeUserAgent(resolveChromeVersion(executablePath))
      : undefined;
  const userDataDir = profileDirectory(browserId, persistent);
  const logDir = keyedDir(MANAGED_BROWSERS_SUBDIR);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${hashKey(browserId)}.log`);
  let logFd: number | undefined;

  let chromePid = 0;
  let hostPid = 0;
  let session: CdpSession | null = null;
  let recordWritten = false;
  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = acquireLaunchLock(browserId);
    await removeStoppedInstance(browserId);
    const existing = findManagedRecord(browserId);
    if (existing) throw new Error(`Managed browser already running: ${browserId}`);
    rotateLogIfNeeded(logPath);
    logFd = openSync(logPath, 'a', 0o600);
    const exportedCookies =
      copyCookieDomains.length > 0
        ? await deps.exportCookies(copyCookieDomains)
        : ([] as TransferableCookie[]);
    const cookies = cookieCopy.select(exportedCookies);
    const chromeArgs = buildManagedChromeArgs({ userDataDir, headless, userAgent });
    rmSync(join(userDataDir, 'DevToolsActivePort'), { force: true });
    const chrome = spawn(executablePath, chromeArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      windowsHide: headless,
    });
    await new Promise<void>((resolve, reject) => {
      chrome.once('error', reject);
      chrome.once('spawn', resolve);
    });
    chromePid = chrome.pid ?? 0;
    if (!chromePid) throw new Error('Chrome launched without a process id');
    chrome.unref();

    const cdpPort = await waitForActivePort(userDataDir);
    session = new CdpSession({ port: cdpPort, userDataDir });
    const copiedCookieCount = await cdpImportCookies(session, cookies);
    if (input.url) {
      const browser = await session.getBrowserClient();
      await browser.sendCommand('Target.createTarget', { url: input.url, background: headless });
    }
    session.close();
    session = null;

    const host = spawn(
      process.execPath,
      [
        deps.nativeHostScript,
        '--daemon',
        '--cdp-port',
        String(cdpPort),
        '--cdp-user-data-dir',
        userDataDir,
        '--browser-id',
        browserId,
        '--browser-name',
        name,
        ...(headless ? ['--browser-headless'] : []),
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      host.once('error', reject);
      host.once('spawn', resolve);
    });
    hostPid = host.pid ?? 0;
    if (!hostPid) throw new Error('Native host launched without a process id');
    host.unref();

    const record: ManagedBrowserRecord = {
      pid: chromePid,
      hostPid,
      browserId,
      name,
      headless,
      persistent,
      userDataDir,
      executablePath,
      cdpPort,
      createdAt: new Date().toISOString(),
      ...(copyCookieDomains.length > 0
        ? { copiedCookies: { domains: copyCookieDomains, count: copiedCookieCount } }
        : {}),
    };
    writeRecord(keyedConfigFile(MANAGED_BROWSERS_SUBDIR, browserId), record);
    recordWritten = true;
    await waitForBrowserRegistration(browserId, hostPid);
    deps.log(`managed browser launched: ${browserId}, chrome=${chromePid}, host=${hostPid}`);
    return {
      ...browserSummary(record, true),
      created: true,
      reused: false,
    };
  } catch (error) {
    session?.close();
    if (hostPid) await stopProcess(hostPid, `--browser-id ${browserId}`);
    if (chromePid) await stopProcess(chromePid, userDataDir);
    if (recordWritten) removeRecord(keyedConfigFile(MANAGED_BROWSERS_SUBDIR, browserId));
    if (!persistent) rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  } finally {
    releaseLock?.();
    if (logFd !== undefined) closeSync(logFd);
  }
}

export async function closeManagedBrowser(
  browserId: string,
  options: { deleteProfile?: boolean } = {},
): Promise<{
  browserId: string;
  closed: true;
  profileDeleted: boolean;
  [CLOSED_OWN_MANAGED_HOST]: boolean;
}> {
  const unlock = acquireLaunchLock(browserId);
  try {
    const recordFile = keyedConfigFile(MANAGED_BROWSERS_SUBDIR, browserId);
    const record = readRecord<ManagedBrowserRecord>(recordFile);
    if (!record) throw new Error(`Managed browser not found: ${browserId}`);

    if (!(await stopProcess(record.pid, record.userDataDir)))
      throw new Error(`Managed browser did not exit: ${browserId}`);
    const closingOwnHost = record.hostPid === process.pid;
    if (!closingOwnHost && !(await stopProcess(record.hostPid, `--browser-id ${browserId}`)))
      throw new Error(`Managed browser host did not exit: ${browserId}`);
    pruneCdpSessionStorage(keyedConfigFile('plugin-pages', `${browserId}:${record.userDataDir}`));
    removeRecord(keyedConfigFile('browsers', browserId));

    const deleteProfile = options.deleteProfile === true || !record.persistent;
    const stoppedRecord = stoppedPersistentBrowserRecord(record, deleteProfile);
    if (stoppedRecord) {
      writeRecord(recordFile, stoppedRecord);
    } else {
      removeRecord(recordFile);
      rmSync(record.userDataDir, { recursive: true, force: true });
    }
    return {
      browserId,
      closed: true,
      profileDeleted: deleteProfile,
      [CLOSED_OWN_MANAGED_HOST]: closingOwnHost,
    };
  } finally {
    unlock();
  }
}
