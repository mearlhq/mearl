import { SETUP_VERSION } from './setupVersion.js';
import { readExtensionReleaseVersion } from '@mearl/browser-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runUnifiedCheck } from '@mearl/client/check';
import { CLIENT_VERSION, invoke as invokeLocalMearl } from '@mearl/client/local';
import AdmZip from 'adm-zip';
import WebSocket, { type RawData } from 'ws';
import { compareMearlReleaseVersions, isMearlReleaseVersion } from './version.js';

export const MEARL_EXTENSION_DOWNLOAD_PAGE = SETUP_VERSION.includes('-beta.')
  ? `https://github.com/mearlhq/mearl/releases/tag/v${SETUP_VERSION}`
  : 'https://github.com/mearlhq/mearl/releases/latest';
export const MEARL_EXTENSION_REMOTE_CONFIG_URL = 'https://mearlhq.github.io/mearl/config.json';
export const MEARL_EXTENSION_DIRECTORY_NAME = 'chrome-extension';
export const MEARL_EXTENSION_ID = 'aoehhjnofngknnjefamjbplchbolghkm';
export const MEARL_EXTENSION_SETUP_MARKER = '.mearl-setup.json';

const ARCHIVE_PATTERN = /mearl-chrome-v(\d+\.\d+\.\d+(?:-beta\.\d+)?)\.zip/g;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f\d]{64}$/i;

export interface BrowserExtensionRelease {
  archiveUrl: string;
  sha256?: string;
  version: string;
}

export interface BrowserExtensionInstallOptions {
  force?: boolean;
  targetDirectory?: string;
  chromeUserDataDirectory?: string;
  waitForCdpMs?: number;
  writeLine?: (line: string) => void;
  release?: BrowserExtensionRelease;
}

export interface SetupManagedBrowserExtensionUpdateOptions {
  release: BrowserExtensionRelease;
  targetDirectory: string;
}

export interface SetupManagedBrowserExtensionUpdateResult extends BrowserExtensionRelease {
  path: string;
}

export interface BrowserExtensionInstallResult {
  activation?: 'cdp' | 'native-host';
  extensionId?: string;
  filesUpdated?: boolean;
  loaded: boolean;
  path: string;
  version: string;
  archiveUrl: string;
  cdpError?: string;
}

export interface BrowserExtensionDependencies {
  connectCdp?: typeof connectBrowserExtensionViaCdp;
  extractArchive?: (archivePath: string, destination: string) => Promise<void>;
  fetch?: typeof fetch;
  inspectInstalled?: typeof inspectSetupManagedExtension;
  inspectInstallation?: typeof inspectMearlExtensionViaCdp;
  loadUnpacked?: typeof loadUnpackedViaCdp;
  reloadInstalled?: typeof reloadInstalledExtension;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ExtensionManifest {
  key?: unknown;
  manifest_version?: unknown;
  version_name?: unknown;
  name?: unknown;
  version?: unknown;
}

interface DevToolsActivePort {
  port: number;
  browserWsPath: string;
}

interface SetupMarker {
  extensionId: string;
  path: string;
  schemaVersion: 1;
}

export interface InstalledBrowserExtension {
  id: string;
  location: string;
  name: string;
  path: string;
  version: string;
}

export class BrowserExtensionConflictError extends Error {
  constructor(readonly installed: InstalledBrowserExtension) {
    super(
      `Mearl extension ${installed.id} is already installed from ${installed.location} at ${installed.path || '(managed location)'}. Re-run with --force to replace it.`,
    );
    this.name = 'BrowserExtensionConflictError';
  }
}

export function isUnsupportedCdpMethodError(message: string): boolean {
  return /Method not (?:available|found)|wasn't found|unknown method/i.test(message);
}

export function resolveChromeUserDataDirectory(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? home, 'Google', 'Chrome', 'User Data');
  }
  return path.join(home, '.config', 'google-chrome');
}

export function resolveMearlExtensionDirectory(home = os.homedir()): string {
  return path.join(home, '.mearl', MEARL_EXTENSION_DIRECTORY_NAME);
}

export function findLatestExtensionVersion(html: string): string | null {
  const versions = Array.from(html.matchAll(ARCHIVE_PATTERN), match => match[1]!).filter(
    isMearlReleaseVersion,
  );
  return versions.sort(compareMearlReleaseVersions).at(-1) ?? null;
}

export function extensionArchiveUrl(version: string): string {
  if (!isMearlReleaseVersion(version)) {
    throw new Error(`Invalid Mearl browser extension version: ${version}`);
  }
  return `https://github.com/mearlhq/mearl/releases/download/v${version}/mearl-chrome-v${version}.zip`;
}

function validateExtensionRelease(release: BrowserExtensionRelease): BrowserExtensionRelease {
  if (!isMearlReleaseVersion(release.version)) {
    throw new Error('Remote extension config has an invalid latestVersion');
  }
  const configSource = process.env.MEARL_EXTENSION_CONFIG_URL;
  const expectedArchiveUrl =
    configSource && configSource !== MEARL_EXTENSION_REMOTE_CONFIG_URL
      ? new URL(`mearl-chrome-v${release.version}.zip`, configSource).toString()
      : extensionArchiveUrl(release.version);
  let archiveUrl: string;
  try {
    archiveUrl = new URL(release.archiveUrl).toString();
  } catch {
    throw new Error('Remote extension config has an invalid downloadUrl');
  }
  if (archiveUrl !== expectedArchiveUrl) {
    throw new Error('Remote extension downloadUrl does not match latestVersion');
  }
  if (release.sha256 !== undefined && !SHA256_PATTERN.test(release.sha256)) {
    throw new Error('Remote extension config has an invalid downloadSha256');
  }
  return {
    archiveUrl,
    ...(release.sha256 ? { sha256: release.sha256.toLowerCase() } : {}),
    version: release.version,
  };
}

export async function fetchBrowserExtensionRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserExtensionRelease> {
  if (!process.env.MEARL_EXTENSION_CONFIG_URL && SETUP_VERSION.includes('-beta.')) {
    return { version: SETUP_VERSION, archiveUrl: extensionArchiveUrl(SETUP_VERSION) };
  }
  const response = await fetchImpl(
    process.env.MEARL_EXTENSION_CONFIG_URL || MEARL_EXTENSION_REMOTE_CONFIG_URL,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Extension config returned HTTP ${response.status}`);
  }
  const config = (await response.json()) as Record<string, unknown>;
  return validateExtensionRelease({
    archiveUrl: typeof config.downloadUrl === 'string' ? config.downloadUrl : '',
    ...(typeof config.downloadSha256 === 'string' ? { sha256: config.downloadSha256 } : {}),
    version: typeof config.latestVersion === 'string' ? config.latestVersion : '',
  });
}

function readDevToolsActivePort(userDataDirectory: string): DevToolsActivePort | null {
  try {
    const content = fs
      .readFileSync(path.join(userDataDirectory, 'DevToolsActivePort'), 'utf8')
      .trim();
    const [portValue, browserWsPath = '/devtools/browser'] = content
      .split(/\r?\n/)
      .map(value => value.trim());
    const port = Number(portValue);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    if (!browserWsPath.startsWith('/')) return null;
    return { port, browserWsPath };
  } catch {
    return null;
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

class CdpConnection {
  private closed = false;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: Record<string, any>) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', data => this.handleMessage(data));
    socket.on('close', () => this.close(new Error('CDP WebSocket closed before responding')));
    socket.on('error', error => this.close(error));
  }

  static connect(endpoint: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        handshakeTimeout: 5_000,
        maxPayload: 8 * 1024 * 1024,
        perMessageDeflate: false,
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          socket.terminate();
          reject(error);
        } else {
          resolve(new CdpConnection(socket));
        }
      };
      socket.once('open', () => finish());
      socket.once('error', error => finish(error));
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        finish(new Error(`CDP WebSocket returned HTTP ${response.statusCode ?? 0}`));
      });
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        },
      );
    });
  }

  close(error = new Error('CDP connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.terminate();
  }

  private handleMessage(data: RawData): void {
    try {
      const message = JSON.parse(rawDataToString(data)) as {
        id?: number;
        error?: { message?: string };
        result?: Record<string, any>;
      };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'CDP command failed'));
      } else {
        pending.resolve(message.result ?? {});
      }
    } catch {
      // Ignore unrelated malformed protocol events and let command timeouts report failure.
    }
  }
}

interface BrowserExtensionCdpSession {
  close(): void;
  inspectInstallation(): Promise<InstalledBrowserExtension | null>;
  loadUnpacked(extensionDirectory: string): Promise<{ extensionId: string }>;
}

function sameExtensionPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isSetupManagedInstallation(
  installed: InstalledBrowserExtension,
  targetDirectory: string,
): boolean {
  return installed.location === 'UNPACKED' && sameExtensionPath(installed.path, targetDirectory);
}

function setupMarkerPath(directory: string): string {
  return path.join(directory, MEARL_EXTENSION_SETUP_MARKER);
}

function hasSetupMarker(targetDirectory: string): boolean {
  try {
    const marker = JSON.parse(
      fs.readFileSync(setupMarkerPath(targetDirectory), 'utf8'),
    ) as Partial<SetupMarker>;
    return (
      marker.schemaVersion === 1 &&
      marker.extensionId === MEARL_EXTENSION_ID &&
      typeof marker.path === 'string' &&
      sameExtensionPath(marker.path, targetDirectory)
    );
  } catch {
    return false;
  }
}

async function writeSetupMarker(directory: string, targetDirectory: string): Promise<void> {
  const marker: SetupMarker = {
    extensionId: MEARL_EXTENSION_ID,
    path: path.resolve(targetDirectory),
    schemaVersion: 1,
  };
  await fs.promises.writeFile(setupMarkerPath(directory), `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  });
}

function browserCdpEndpoint(chromeUserDataDirectory: string): string {
  const activePort = readDevToolsActivePort(chromeUserDataDirectory);
  if (!activePort) throw new Error('Chrome remote debugging is not enabled');
  return `ws://127.0.0.1:${activePort.port}${activePort.browserWsPath}`;
}

async function inspectInstallationWithConnection(
  connection: CdpConnection,
): Promise<InstalledBrowserExtension | null> {
  const target = await connection.send('Target.createTarget', {
    background: true,
    url: 'chrome://extensions-internals',
  });
  try {
    const attached = await connection.send('Target.attachToTarget', {
      flatten: true,
      targetId: target.targetId,
    });
    const evaluated = await connection.send(
      'Runtime.evaluate',
      {
        awaitPromise: true,
        expression:
          "document.readyState === 'complete' ? document.body.innerText : new Promise(resolve => addEventListener('load', () => resolve(document.body.innerText), {once:true}))",
        returnByValue: true,
      },
      attached.sessionId,
    );
    const text = evaluated.result?.value;
    if (typeof text !== 'string') {
      throw new Error('chrome://extensions-internals did not return extension inventory');
    }
    const inventory = JSON.parse(text) as Array<Record<string, unknown>>;
    const installed = inventory.find(extension => extension.id === MEARL_EXTENSION_ID);
    if (!installed) return null;
    if (
      typeof installed.location !== 'string' ||
      typeof installed.name !== 'string' ||
      typeof installed.path !== 'string' ||
      typeof installed.version !== 'string'
    ) {
      throw new Error('Chrome returned incomplete Mearl extension metadata');
    }
    let version = installed.version;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(installed.path, 'manifest.json'), 'utf8'),
      );
      if (manifest.version === installed.version)
        version = readExtensionReleaseVersion(manifest) ?? version;
    } catch {}
    return {
      id: MEARL_EXTENSION_ID,
      location: installed.location,
      name: installed.name,
      path: installed.path,
      version,
    };
  } finally {
    if (typeof target.targetId === 'string') {
      await connection.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
    }
  }
}

async function loadUnpackedWithConnection(
  connection: CdpConnection,
  extensionDirectory: string,
): Promise<{ extensionId: string }> {
  const loaded = await connection.send('Extensions.loadUnpacked', {
    path: path.resolve(extensionDirectory),
  });
  if (loaded.id !== MEARL_EXTENSION_ID) {
    throw new Error(
      `Extensions.loadUnpacked returned unexpected extension ID: ${String(loaded.id)}`,
    );
  }

  const inventory = await connection.send('Extensions.getExtensions');
  const extension = Array.isArray(inventory.extensions)
    ? inventory.extensions.find(candidate => candidate?.id === loaded.id)
    : null;
  if (!extension?.enabled) {
    throw new Error('Chrome loaded the extension but did not report it as enabled');
  }
  return { extensionId: loaded.id };
}

async function connectBrowserExtensionViaCdp(
  chromeUserDataDirectory = resolveChromeUserDataDirectory(),
): Promise<BrowserExtensionCdpSession> {
  const connection = await CdpConnection.connect(browserCdpEndpoint(chromeUserDataDirectory));
  return {
    close: () => connection.close(),
    inspectInstallation: () => inspectInstallationWithConnection(connection),
    loadUnpacked: extensionDirectory => loadUnpackedWithConnection(connection, extensionDirectory),
  };
}

export async function loadUnpackedViaCdp(
  extensionDirectory: string,
  chromeUserDataDirectory = resolveChromeUserDataDirectory(),
): Promise<{ extensionId: string }> {
  const connection = await CdpConnection.connect(browserCdpEndpoint(chromeUserDataDirectory));
  try {
    return await loadUnpackedWithConnection(connection, extensionDirectory);
  } finally {
    connection.close();
  }
}

export async function inspectMearlExtensionViaCdp(
  chromeUserDataDirectory = resolveChromeUserDataDirectory(),
): Promise<InstalledBrowserExtension | null> {
  const connection = await CdpConnection.connect(browserCdpEndpoint(chromeUserDataDirectory));
  try {
    return await inspectInstallationWithConnection(connection);
  } finally {
    connection.close();
  }
}

async function inspectSetupManagedExtension(targetDirectory: string): Promise<string[]> {
  const result = await runUnifiedCheck(
    { clientVersion: CLIENT_VERSION, json: true, local: true, timeoutSec: 5 },
    { writeJson: () => {} },
  );
  const matches = result.browsers
    .filter(
      browser =>
        browser.status === 'connected' &&
        browser.transport === 'extension' &&
        browser.extensionInstallation?.extensionId === MEARL_EXTENSION_ID &&
        typeof browser.extensionInstallation.setupManagedPath === 'string' &&
        sameExtensionPath(browser.extensionInstallation.setupManagedPath, targetDirectory),
    )
    .map(browser => browser.browserId);
  return matches;
}

async function reloadInstalledExtension(browserIds: string[]): Promise<void> {
  if (browserIds.length === 0) throw new Error('No setup-managed Mearl extension was found');
  const failures: string[] = [];
  let reloaded = 0;
  for (const browserId of browserIds) {
    try {
      await invokeLocalMearl(
        '__extension_reload',
        {},
        {
          browser: browserId,
          timeoutSec: 5,
        },
      );
      reloaded += 1;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (reloaded === 0) {
    throw new Error(`Failed to reload the connected extension: ${failures.join('; ')}`);
  }
}

async function replaceDirectory(stagingDirectory: string, targetDirectory: string): Promise<void> {
  const backupDirectory = `${targetDirectory}.backup-${randomUUID()}`;
  const targetExists = fs.existsSync(targetDirectory);
  try {
    if (targetExists) await fs.promises.rename(targetDirectory, backupDirectory);
    await fs.promises.rename(stagingDirectory, targetDirectory);
  } catch (error) {
    if (!fs.existsSync(targetDirectory) && fs.existsSync(backupDirectory)) {
      await fs.promises.rename(backupDirectory, targetDirectory);
    }
    throw error;
  }
  if (targetExists) {
    await fs.promises.rm(backupDirectory, { force: true, recursive: true });
  }
}

function readExtensionManifest(directory: string): ExtensionManifest {
  const manifestPath = path.join(directory, 'manifest.json');
  let parsed: ExtensionManifest;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
  } catch (error) {
    throw new Error(
      `Downloaded extension has no valid manifest.json: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
  if (
    parsed.manifest_version !== 3 ||
    typeof parsed.name !== 'string' ||
    typeof parsed.key !== 'string' ||
    parsed.key.length === 0
  ) {
    throw new Error('Downloaded archive is not a valid Manifest V3 extension');
  }
  if (!readExtensionReleaseVersion(parsed)) {
    throw new Error('Downloaded extension manifest has an invalid version');
  }
  return parsed;
}

async function extractExtensionArchive(archivePath: string, destination: string): Promise<void> {
  const archive = new AdmZip(archivePath);
  // Extension releases contain ordinary files and directories, never symlinks.
  // Validate every entry before writing anything into the fresh staging directory.
  for (const entry of archive.getEntries()) {
    const name = entry.entryName;
    const type = (entry.header.attr >>> 16) & 0o170000;
    if (
      name.includes('\\') ||
      name.includes('\0') ||
      path.posix.isAbsolute(name) ||
      path.win32.isAbsolute(name) ||
      name.split('/').some(part => part === '..' || part === '.') ||
      (type !== 0 && type !== 0o100000 && type !== 0o040000)
    ) {
      throw new Error('Extension archive contains an unsafe entry');
    }
  }
  await archive.extractAllToAsync(destination, false);
}

async function downloadAndReplaceExtension(
  releaseInput: BrowserExtensionRelease,
  targetDirectory: string,
  fetchImpl: typeof fetch,
  extractArchive: (archivePath: string, destination: string) => Promise<void>,
  { managed = true }: { managed?: boolean } = {},
): Promise<BrowserExtensionRelease> {
  const release = validateExtensionRelease(releaseInput);
  const parentDirectory = path.dirname(targetDirectory);
  const stagingDirectory = `${targetDirectory}.staging-${randomUUID()}`;
  const archivePath = path.join(parentDirectory, `.mearl-extension-${randomUUID()}.zip`);
  await fs.promises.mkdir(parentDirectory, { recursive: true });
  try {
    const response = await fetchImpl(release.archiveUrl, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Extension archive returned HTTP ${response.status}: ${release.archiveUrl}`);
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`Extension archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
      throw new Error('Extension archive is empty or too large');
    }
    if (release.sha256) {
      const actualSha256 = createHash('sha256').update(archive).digest('hex');
      if (actualSha256 !== release.sha256) {
        throw new Error('Extension archive SHA256 does not match remote config');
      }
    }
    await fs.promises.writeFile(archivePath, archive, { mode: 0o600 });
    await fs.promises.mkdir(stagingDirectory, { recursive: true });
    await extractArchive(archivePath, stagingDirectory);
    const manifest = readExtensionManifest(stagingDirectory);
    if (readExtensionReleaseVersion(manifest) !== release.version) {
      throw new Error(
        `Extension archive version ${String(manifest.version)} does not match ${release.version}`,
      );
    }
    if (managed) await writeSetupMarker(stagingDirectory, targetDirectory);
    await replaceDirectory(stagingDirectory, targetDirectory);
    return release;
  } finally {
    await fs.promises.rm(archivePath, { force: true });
    await fs.promises.rm(stagingDirectory, { force: true, recursive: true });
  }
}

export async function downloadMearlBrowserExtension(
  directory = path.join(os.homedir(), '.mearl', 'extension-downloads'),
  dependencies: Pick<BrowserExtensionDependencies, 'extractArchive' | 'fetch'> = {},
): Promise<BrowserExtensionRelease & { path: string }> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const release = await fetchBrowserExtensionRelease(fetchImpl);
  const parent = path.resolve(directory);
  await fs.promises.mkdir(parent, { recursive: true });
  const target = await fs.promises.mkdtemp(path.join(parent, `mearl-v${release.version}-`));
  try {
    await downloadAndReplaceExtension(
      release,
      target,
      fetchImpl,
      dependencies.extractArchive ?? extractExtensionArchive,
      { managed: false },
    );
    return { ...release, path: target };
  } catch (error) {
    await fs.promises.rm(target, { force: true, recursive: true });
    throw error;
  }
}

export async function updateSetupManagedBrowserExtensionFiles(
  options: SetupManagedBrowserExtensionUpdateOptions,
  dependencies: Pick<BrowserExtensionDependencies, 'extractArchive' | 'fetch'> = {},
): Promise<SetupManagedBrowserExtensionUpdateResult> {
  const targetDirectory = path.resolve(options.targetDirectory);
  if (!hasSetupMarker(targetDirectory)) {
    throw new Error('The running extension is not managed by Mearl setup');
  }
  const fetchImpl = dependencies.fetch ?? fetch;
  const extractArchive = dependencies.extractArchive ?? extractExtensionArchive;
  const release = await downloadAndReplaceExtension(
    options.release,
    targetDirectory,
    fetchImpl,
    extractArchive,
  );
  return { ...release, path: targetDirectory };
}

export async function installMearlBrowserExtension(
  options: BrowserExtensionInstallOptions = {},
  dependencies: BrowserExtensionDependencies = {},
): Promise<BrowserExtensionInstallResult> {
  const connectCdp = dependencies.connectCdp ?? connectBrowserExtensionViaCdp;
  const fetchImpl = dependencies.fetch ?? fetch;
  const extractArchive = dependencies.extractArchive ?? extractExtensionArchive;
  const loadUnpacked = dependencies.loadUnpacked ?? loadUnpackedViaCdp;
  const inspectInstallation = dependencies.inspectInstallation ?? inspectMearlExtensionViaCdp;
  const inspectInstalled = dependencies.inspectInstalled ?? inspectSetupManagedExtension;
  const reloadInstalled = dependencies.reloadInstalled ?? reloadInstalledExtension;
  const sleep =
    dependencies.sleep ??
    (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const writeLine = options.writeLine ?? (line => console.error(line));
  const targetDirectory = path.resolve(options.targetDirectory ?? resolveMearlExtensionDirectory());
  const release = options.release
    ? validateExtensionRelease(options.release)
    : await fetchBrowserExtensionRelease(fetchImpl);
  const chromeUserDataDirectory =
    options.chromeUserDataDirectory ?? resolveChromeUserDataDirectory();
  const waitForCdpMs = Math.max(0, options.waitForCdpMs ?? 0);
  const useSharedCdpSession = !dependencies.inspectInstallation && !dependencies.loadUnpacked;
  let setupManagedBrowserIds: string[] = [];
  if (hasSetupMarker(targetDirectory)) {
    try {
      setupManagedBrowserIds = await inspectInstalled(targetDirectory);
    } catch {
      // A missing Native Host connection cannot prove ownership; CDP performs the safe fallback.
    }
  }
  const setupManagedAtStart = setupManagedBrowserIds.length > 0;
  let cdpSession: BrowserExtensionCdpSession | undefined;

  const inspectOnce = async (): Promise<InstalledBrowserExtension | null> => {
    if (!useSharedCdpSession) {
      return options.force ? null : inspectInstallation(chromeUserDataDirectory);
    }
    const candidate = await connectCdp(chromeUserDataDirectory);
    try {
      const installed = options.force ? null : await candidate.inspectInstallation();
      cdpSession?.close();
      cdpSession = candidate;
      return installed;
    } catch (error) {
      candidate.close();
      throw error;
    }
  };

  const waitForCdpInspection = async (): Promise<string | undefined> => {
    const deadline = Date.now() + waitForCdpMs;
    let lastFailure: string | undefined;
    let lastNoticeAt = 0;
    do {
      try {
        const installed = await inspectOnce();
        if (
          installed &&
          !isSetupManagedInstallation(installed, targetDirectory) &&
          !options.force
        ) {
          throw new BrowserExtensionConflictError(installed);
        }
        return undefined;
      } catch (error) {
        if (error instanceof BrowserExtensionConflictError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        lastFailure = message;
        if (waitForCdpMs === 0 || isUnsupportedCdpMethodError(message)) {
          break;
        }
        if (lastNoticeAt === 0) {
          writeLine(
            'Waiting for Chrome remote debugging before checking the installed extension...',
          );
          writeLine(
            'Open chrome://inspect/#remote-debugging, enable remote debugging, and approve the connection.',
          );
          lastNoticeAt = Date.now();
        } else if (Date.now() - lastNoticeAt >= 15_000) {
          writeLine('Still waiting for Chrome remote debugging...');
          lastNoticeAt = Date.now();
        }
        await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
      }
    } while (Date.now() < deadline);
    return lastFailure;
  };

  try {
    if (!setupManagedAtStart) {
      const cdpError = await waitForCdpInspection();
      if (cdpError) {
        return {
          filesUpdated: false,
          loaded: false,
          path: targetDirectory,
          version: release.version,
          archiveUrl: release.archiveUrl,
          cdpError,
        };
      }
    }

    await downloadAndReplaceExtension(release, targetDirectory, fetchImpl, extractArchive);

    if (setupManagedAtStart) {
      try {
        await reloadInstalled(setupManagedBrowserIds);
        return {
          activation: 'native-host',
          extensionId: MEARL_EXTENSION_ID,
          filesUpdated: true,
          loaded: true,
          path: targetDirectory,
          version: release.version,
          archiveUrl: release.archiveUrl,
        };
      } catch (reloadError) {
        const cdpError = await waitForCdpInspection();
        if (cdpError) {
          const reloadMessage =
            reloadError instanceof Error ? reloadError.message : String(reloadError);
          return {
            filesUpdated: true,
            loaded: false,
            path: targetDirectory,
            version: release.version,
            archiveUrl: release.archiveUrl,
            cdpError: `Native Host reload failed: ${reloadMessage}; CDP fallback failed: ${cdpError}`,
          };
        }
      }
    }

    try {
      const loaded = cdpSession
        ? await cdpSession.loadUnpacked(targetDirectory)
        : await loadUnpacked(targetDirectory, chromeUserDataDirectory);
      return {
        activation: 'cdp',
        extensionId: loaded.extensionId,
        filesUpdated: true,
        loaded: true,
        path: targetDirectory,
        version: release.version,
        archiveUrl: release.archiveUrl,
      };
    } catch (error) {
      return {
        filesUpdated: true,
        loaded: false,
        path: targetDirectory,
        version: release.version,
        archiveUrl: release.archiveUrl,
        cdpError: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    cdpSession?.close();
  }
}
