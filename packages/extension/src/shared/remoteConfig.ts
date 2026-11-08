export const MEARL_REMOTE_BASE_URL = 'https://github.com/mearlhq/mearl/releases/';
export const MEARL_REMOTE_CONFIG_URL = `${MEARL_REMOTE_BASE_URL}latest/download/config.json`;

const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const SHA256_PATTERN = /^[a-f\d]{64}$/i;

export interface RemoteConfig {
  banner?: {
    text: string;
    url: string;
  };
  latestVersion?: string;
  downloadUrl?: string;
  downloadSha256?: string;
}

export interface RemoteExtensionRelease {
  archiveUrl: string;
  changelogUrl: string;
  sha256?: string;
  version: string;
}

interface ParsedVersion {
  beta?: number;
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const match = RELEASE_VERSION_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { beta: Number(match[4]) }),
  };
}

export function compareReleaseVersions(leftValue: string, rightValue: string): number | null {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.beta === undefined && right.beta !== undefined) return 1;
  if (left.beta !== undefined && right.beta === undefined) return -1;
  return (left.beta ?? 0) - (right.beta ?? 0);
}

export function getExtensionChangelogUrl(version: string): string | null {
  return parseVersion(version) ? `${MEARL_REMOTE_BASE_URL}tag/v${version}` : null;
}

export function getRemoteExtensionRelease(config: RemoteConfig): RemoteExtensionRelease | null {
  if (typeof config.latestVersion !== 'string' || typeof config.downloadUrl !== 'string') {
    return null;
  }
  const version = config.latestVersion;
  if (!parseVersion(version)) return null;
  const expectedArchiveUrl = `${MEARL_REMOTE_BASE_URL}download/v${version}/mearl-chrome-v${version}.zip`;
  let archiveUrl: string;
  try {
    archiveUrl = new URL(config.downloadUrl).toString();
  } catch {
    return null;
  }
  if (archiveUrl !== expectedArchiveUrl) return null;
  if (config.downloadSha256 !== undefined && !SHA256_PATTERN.test(config.downloadSha256)) {
    return null;
  }
  const changelogUrl = getExtensionChangelogUrl(version);
  if (!changelogUrl) return null;
  return {
    archiveUrl,
    changelogUrl,
    ...(config.downloadSha256 ? { sha256: config.downloadSha256.toLowerCase() } : {}),
    version,
  };
}

export async function fetchRemoteConfig(fetchImpl: typeof fetch = fetch): Promise<RemoteConfig> {
  const response = await fetchImpl(MEARL_REMOTE_CONFIG_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Remote config returned HTTP ${response.status}`);
  return (await response.json()) as RemoteConfig;
}
