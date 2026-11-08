import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  claimRecord,
  ensureDir,
  hashKey,
  isAlive,
  keyedConfigFile,
  keyedDir,
  listRecordFiles,
  readLiveRecords,
  readRecord,
  removeInvalidRecord,
  removeRecordIfPid,
  writeRecord,
  writeRecordIfPid,
  type DaemonRecord,
} from '@mearl/daemon-core';
import {
  MEARL_PROVIDER_PROTOCOL_VERSION,
  type InstalledProviderManifest,
  type ProviderBrowser,
  type ProviderDescriptor,
  type ProviderPackageMetadata,
} from './types.js';
import { validateProviderLaunchForm, isProviderInputSchema } from './provider-runtime.js';
import { assertProviderProtocolVersion, isProviderControlSessionModes } from './protocol.js';

export const INSTALLED_PROVIDERS_SUBDIR = 'providers/installed';
export const LIVE_PROVIDERS_SUBDIR = 'providers/live';
export const STARTING_PROVIDERS_SUBDIR = 'providers/starting';
export const PROVIDER_SOCKETS_SUBDIR = 'providers/sockets';
export const PROVIDER_DATA_SUBDIR = 'providers/data';
export const BROWSERS_SUBDIR = 'browsers';
export const PROVIDER_START_TOKEN_ENV = 'MEARL_PROVIDER_START_TOKEN';
const RESERVED_PROVIDER_IDS = new Set(['local']);

export interface LiveProviderRecord extends DaemonRecord {
  providerId: string;
  providerName: string;
  providerVersion: string;
  providerProtocolVersion: number;
  socketPath: string;
  startedAt: string;
  updatedAt: number;
}

export interface ProviderStartRecord extends DaemonRecord {
  providerId: string;
  token: string;
  startedAt: string;
}

export interface ProviderBrowserRecord extends DaemonRecord {
  browserId: string;
  providerBrowserId: string;
  browserName: string;
  socketPath: string;
  transport: 'provider';
  provider: {
    id: string;
    name: string;
    builtin: boolean;
    version: string;
    protocolVersion: number;
  };
  capabilities?: Extract<ProviderBrowser['control'], { kind: 'provider' }>['capabilities'];
  status: ProviderBrowser['status'];
  ownership?: ProviderBrowser['ownership'];
  persistence: ProviderBrowser['persistence'];
  operations: ProviderBrowser['operations'];
  references?: ProviderBrowser['references'];
  details?: ProviderBrowser['details'];
  pairing?: ProviderBrowser['pairing'];
  startedAt: string;
  updatedAt: number;
  lastFocusedAt?: number;
}

export interface RegisteredBrowserRecord extends DaemonRecord {
  browserId: string;
  browserName: string;
  socketPath: string;
  transport: 'extension' | 'cdp' | 'provider';
  extensionVersion?: string;
  nativeHostVersion?: string;
  provider?: ProviderBrowserRecord['provider'];
  capabilities?: Extract<ProviderBrowser['control'], { kind: 'provider' }>['capabilities'];
  status?: ProviderBrowser['status'];
  ownership?: ProviderBrowserRecord['ownership'];
  persistence?: ProviderBrowserRecord['persistence'];
  operations?: ProviderBrowserRecord['operations'];
  references?: ProviderBrowser['references'];
  details?: ProviderBrowser['details'];
  pairing?: ProviderBrowser['pairing'];
  startedAt?: string;
  updatedAt?: number;
  lastFocusedAt?: number;
}

export function providerBrowserKey(providerId: string, browserId: string): string {
  const redundantPrefix = `managed:${providerId}:`;
  const scopedBrowserId = browserId.toLowerCase().startsWith(redundantPrefix.toLowerCase())
    ? browserId.slice(redundantPrefix.length)
    : browserId;
  const encodedBrowserId = encodeURIComponent(scopedBrowserId).replace(/%3A/gi, ':');
  return `provider:${encodeURIComponent(providerId)}:${encodedBrowserId}`;
}

export function providerSocketPath(providerId: string): string {
  const suffix = hashKey(providerId);
  if (process.platform === 'win32') return `\\\\.\\pipe\\mearl-provider-${suffix}`;
  return join(keyedDir(PROVIDER_SOCKETS_SUBDIR), `${suffix}.sock`);
}

/** Persistent private data directory owned by one installed provider. */
export function providerDataDir(providerId: string): string {
  return join(keyedDir(PROVIDER_DATA_SUBDIR), hashKey(providerId));
}

export function installedProviderFile(providerId: string): string {
  return keyedConfigFile(INSTALLED_PROVIDERS_SUBDIR, providerId);
}

export function liveProviderFile(providerId: string): string {
  return keyedConfigFile(LIVE_PROVIDERS_SUBDIR, providerId);
}

export function startingProviderFile(providerId: string): string {
  return keyedConfigFile(STARTING_PROVIDERS_SUBDIR, providerId);
}

export function claimProviderStart(providerId: string, token: string, pid = process.pid): boolean {
  const file = startingProviderFile(providerId);
  const existing = readRecord<ProviderStartRecord>(file);
  if (existing && isAlive(existing.pid)) return existing.token === token;
  if (existing) removeRecordIfPid(file, existing.pid);
  else removeInvalidRecord(file);
  return claimRecord(file, {
    pid,
    providerId,
    token,
    startedAt: new Date().toISOString(),
  } satisfies ProviderStartRecord);
}

export function readProviderStart(providerId: string): ProviderStartRecord | null {
  const record = readRecord<ProviderStartRecord>(startingProviderFile(providerId));
  return record && isAlive(record.pid) ? record : null;
}

export function transferProviderStart(providerId: string, token: string, pid: number): boolean {
  const file = startingProviderFile(providerId);
  const record = readRecord<ProviderStartRecord>(file);
  if (!record || record.token !== token) return false;
  return writeRecordIfPid(file, record.pid, { ...record, pid });
}

export function releaseProviderStart(providerId: string, token: string): boolean {
  const file = startingProviderFile(providerId);
  const record = readRecord<ProviderStartRecord>(file);
  return record?.token === token ? removeRecordIfPid(file, record.pid) : false;
}

function writeManifest(file: string, manifest: InstalledProviderManifest): void {
  ensureDir(keyedDir(INSTALLED_PROVIDERS_SUBDIR));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function validateInstalledProviderManifest(
  manifest: InstalledProviderManifest,
): string | null {
  if (
    !manifest ||
    typeof manifest.providerId !== 'string' ||
    !manifest.providerId.trim() ||
    typeof manifest.name !== 'string' ||
    !manifest.name.trim() ||
    typeof manifest.version !== 'string' ||
    !manifest.version.trim()
  ) {
    return 'manifest is incomplete';
  }
  try {
    assertProviderProtocolVersion(
      manifest.protocolVersion,
      `Installed Provider ${manifest.providerId}`,
    );
  } catch (error) {
    return (error as Error).message;
  }
  if (RESERVED_PROVIDER_IDS.has(manifest.providerId)) {
    return `providerId ${manifest.providerId} is reserved for a built-in Provider`;
  }
  if (!isProviderBrowserType(manifest.browserType)) {
    return 'browserType is invalid';
  }
  if (typeof manifest.packageName !== 'string' || !manifest.packageName.trim()) {
    return 'packageName is required';
  }
  if (typeof manifest.packageRoot !== 'string' || !isAbsolute(manifest.packageRoot)) {
    return 'packageRoot must be an absolute path';
  }
  if (typeof manifest.entryPath !== 'string' || !isAbsolute(manifest.entryPath)) {
    return 'entryPath must be an absolute path';
  }
  const entryRelative = relative(manifest.packageRoot, manifest.entryPath);
  if (
    entryRelative === '' ||
    isAbsolute(entryRelative) ||
    entryRelative === '..' ||
    entryRelative.startsWith(`..${sep}`)
  ) {
    return 'entryPath must be a file inside packageRoot';
  }
  if (!isFile(manifest.entryPath)) return 'entryPath does not exist or is not a file';
  return null;
}

export function installProvider(manifest: InstalledProviderManifest): void {
  const invalid = validateInstalledProviderManifest(manifest);
  if (invalid) throw new Error(`Invalid provider manifest: ${invalid}`);
  writeManifest(installedProviderFile(manifest.providerId), manifest);
}

interface ProviderPackageJson {
  name?: unknown;
  version?: unknown;
  mearl?: { provider?: Partial<ProviderPackageMetadata> };
}

function packageFile(packageRoot: string): string {
  return join(packageRoot, 'package.json');
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isProviderBrowserType(value: unknown): value is ProviderPackageMetadata['browserType'] {
  if (!value || typeof value !== 'object') return false;
  const browserType = value as Partial<ProviderPackageMetadata['browserType']>;
  if (typeof browserType.name !== 'string' || !browserType.name.trim()) return false;
  if (browserType.controlSessionModes !== undefined && !isProviderControlSessionModes(browserType.controlSessionModes))
    return false;
  if (
    browserType.documentationUrl !== undefined &&
    (typeof browserType.documentationUrl !== 'string' ||
      !/^https?:\/\//.test(browserType.documentationUrl))
  )
    return false;
  if (
    browserType.help !== undefined &&
    (!Array.isArray(browserType.help) ||
      browserType.help.some(item => typeof item !== 'string' || !item.trim()))
  )
    return false;
  if (!isProviderObjectSchema(browserType.inputSchema)) return false;
  if (
    browserType.dynamicLaunchForm !== undefined &&
    typeof browserType.dynamicLaunchForm !== 'boolean'
  )
    return false;
  if (browserType.launchForm !== undefined) {
    try {
      validateProviderLaunchForm(browserType.launchForm);
    } catch {
      return false;
    }
  }
  return (
    browserType.configuration === undefined ||
    (Boolean(browserType.configuration) &&
      typeof browserType.configuration === 'object' &&
      isProviderObjectSchema(browserType.configuration.inputSchema))
  );
}

function isProviderObjectSchema(value: unknown): boolean {
  return isProviderInputSchema(value) && value.type === 'object';
}

export function registerProviderPackage(packageRoot: string): InstalledProviderManifest {
  if (!isAbsolute(packageRoot)) throw new Error('Provider packageRoot must be an absolute path');
  let packageJson: ProviderPackageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageFile(packageRoot), 'utf8')) as ProviderPackageJson;
  } catch (error) {
    throw new Error(`Unable to read Provider package metadata from ${packageRoot}`, {
      cause: error,
    });
  }
  const metadata = packageJson.mearl?.provider;
  if (
    typeof packageJson.name !== 'string' ||
    !packageJson.name.trim() ||
    typeof packageJson.version !== 'string' ||
    !packageJson.version.trim() ||
    typeof metadata?.providerId !== 'string' ||
    !metadata.providerId.trim() ||
    typeof metadata.name !== 'string' ||
    !metadata.name.trim() ||
    metadata.protocolVersion !== MEARL_PROVIDER_PROTOCOL_VERSION ||
    typeof metadata.entry !== 'string' ||
    !metadata.entry.trim() ||
    !isProviderBrowserType(metadata.browserType)
  ) {
    throw new Error(`Invalid mearl.provider metadata in ${packageFile(packageRoot)}`);
  }
  if (isAbsolute(metadata.entry)) {
    throw new Error(`Provider entry must be relative to ${packageFile(packageRoot)}`);
  }
  const normalizedRoot = resolve(packageRoot);
  const entryPath = resolve(normalizedRoot, metadata.entry);
  const entryRelative = relative(normalizedRoot, entryPath);
  if (
    isAbsolute(entryRelative) ||
    entryRelative === '..' ||
    entryRelative.startsWith(`..${sep}`) ||
    !isFile(entryPath)
  ) {
    throw new Error(`Provider entry must be an existing file inside ${normalizedRoot}`);
  }

  const installed = listInstalledProviders();
  const idConflict = installed.find(
    provider =>
      provider.providerId === metadata.providerId && provider.packageName !== packageJson.name,
  );
  if (idConflict) {
    throw new Error(
      `Provider id ${metadata.providerId} is already registered by ${idConflict.packageName}`,
    );
  }
  const packageConflict = installed.find(
    provider =>
      provider.packageName === packageJson.name && provider.providerId !== metadata.providerId,
  );
  if (packageConflict) {
    throw new Error(
      `Package ${packageJson.name} is already registered as Provider ${packageConflict.providerId}`,
    );
  }

  const manifest: InstalledProviderManifest = {
    providerId: metadata.providerId,
    name: metadata.name,
    version: packageJson.version,
    protocolVersion: metadata.protocolVersion,
    browserType: metadata.browserType,
    packageName: packageJson.name,
    packageRoot: normalizedRoot,
    entryPath,
  };
  installProvider(manifest);
  return manifest;
}

export function uninstallProvider(providerId: string): void {
  rmSync(installedProviderFile(providerId), { force: true });
}

export function stopProvider(providerId: string): boolean {
  const live = readLiveProvider(providerId);
  if (!live) return false;
  try {
    process.kill(live.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  return true;
}

export function listInstalledProviders(): InstalledProviderManifest[] {
  const manifests: InstalledProviderManifest[] = [];
  for (const file of listRecordFiles(keyedDir(INSTALLED_PROVIDERS_SUBDIR))) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as InstalledProviderManifest;
      if (
        parsed &&
        typeof parsed.providerId === 'string' &&
        typeof parsed.packageName === 'string'
      ) {
        manifests.push(parsed);
      }
    } catch {
      // A broken third-party manifest must not break discovery of other providers.
    }
  }
  return manifests.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

export function readLiveProvider(providerId: string): LiveProviderRecord | null {
  const record = readRecord<LiveProviderRecord>(liveProviderFile(providerId));
  return record && isAlive(record.pid) ? record : null;
}

export function publishLiveProvider(
  descriptor: ProviderDescriptor,
  socketPath: string,
): LiveProviderRecord {
  const now = Date.now();
  const record: LiveProviderRecord = {
    pid: process.pid,
    providerId: descriptor.providerId,
    providerName: descriptor.name,
    providerVersion: descriptor.version,
    providerProtocolVersion: descriptor.protocolVersion ?? MEARL_PROVIDER_PROTOCOL_VERSION,
    socketPath,
    startedAt: new Date(now).toISOString(),
    updatedAt: now,
  };
  writeRecord(liveProviderFile(descriptor.providerId), record);
  return record;
}

export function unpublishLiveProvider(providerId: string, pid = process.pid): void {
  removeRecordIfPid(liveProviderFile(providerId), pid);
}

export function listLiveProviders(): LiveProviderRecord[] {
  return readLiveRecords<LiveProviderRecord>(keyedDir(LIVE_PROVIDERS_SUBDIR));
}

export function publishProviderBrowsers(
  descriptor: ProviderDescriptor,
  socketPath: string,
  browsers: ProviderBrowser[],
  previousIds: ReadonlySet<string>,
): Set<string> {
  const nextIds = new Set<string>();
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  for (const browser of browsers) {
    const browserId = providerBrowserKey(descriptor.providerId, browser.browserId);
    nextIds.add(browserId);
    const file = keyedConfigFile(BROWSERS_SUBDIR, browserId);
    const previous = readRecord<ProviderBrowserRecord>(file);
    const record: ProviderBrowserRecord = {
      pid: process.pid,
      browserId,
      providerBrowserId: browser.browserId,
      browserName: browser.name,
      socketPath,
      transport: 'provider',
      provider: {
        id: descriptor.providerId,
        name: descriptor.name,
        builtin: descriptor.builtin === true,
        version: descriptor.version,
        protocolVersion: descriptor.protocolVersion ?? MEARL_PROVIDER_PROTOCOL_VERSION,
      },
      capabilities: browser.control.kind === 'provider' ? browser.control.capabilities : undefined,
      status: browser.status,
      ownership: browser.ownership,
      persistence: browser.persistence,
      operations: browser.operations,
      pairing: browser.pairing,
      references: browser.references,
      details: browser.details,
      startedAt: previous?.startedAt ?? startedAt,
      updatedAt: now,
      lastFocusedAt: Math.max(browser.lastFocusedAt ?? 0, previous?.lastFocusedAt ?? 0),
    };
    writeRecord(file, record);
  }

  for (const browserId of previousIds) {
    if (!nextIds.has(browserId)) {
      removeRecordIfPid(keyedConfigFile(BROWSERS_SUBDIR, browserId), process.pid);
    }
  }
  return nextIds;
}

export function touchProviderBrowser(browserId: string): void {
  const file = keyedConfigFile(BROWSERS_SUBDIR, browserId);
  const record = readRecord<ProviderBrowserRecord>(file);
  if (!record || record.pid !== process.pid) return;
  writeRecordIfPid(file, process.pid, {
    ...record,
    lastFocusedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export function unpublishProviderBrowsers(browserIds: Iterable<string>, pid = process.pid): void {
  for (const browserId of browserIds) {
    removeRecordIfPid(keyedConfigFile(BROWSERS_SUBDIR, browserId), pid);
  }
}

export function listProviderBrowserRecords(): ProviderBrowserRecord[] {
  return listRegisteredBrowserRecords().filter(
    (record): record is ProviderBrowserRecord => record.transport === 'provider',
  );
}

export function listRegisteredBrowserRecords(): RegisteredBrowserRecord[] {
  return readLiveRecords<RegisteredBrowserRecord>(keyedDir(BROWSERS_SUBDIR));
}

export function removeStaleProviderSocket(providerId: string, socketPath?: string): void {
  if (process.platform === 'win32') return;
  const socket = socketPath ?? providerSocketPath(providerId);
  if (existsSync(socket) && !readLiveProvider(providerId)) rmSync(socket, { force: true });
}
