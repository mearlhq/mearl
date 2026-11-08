export const MEARL_RELEASE_VERSION_MAX_LENGTH = 64;

const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const RELEASE_LINE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.x$/;
const RELEASE_COMPONENT_MAXIMUM = 65_535;

export interface MearlReleaseVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  channel: 'stable' | 'beta';
  beta?: number;
}

export interface MearlReleaseLine {
  raw: string;
  major: number;
  minor: number;
}

function parseComponent(value: string): number | null {
  const component = Number(value);
  return Number.isSafeInteger(component) && component <= RELEASE_COMPONENT_MAXIMUM
    ? component
    : null;
}

export function parseMearlReleaseVersion(value: unknown): MearlReleaseVersion | null {
  if (typeof value !== 'string' || value.length > MEARL_RELEASE_VERSION_MAX_LENGTH) return null;
  const match = RELEASE_VERSION_PATTERN.exec(value);
  if (!match) return null;
  const major = parseComponent(match[1]!);
  const minor = parseComponent(match[2]!);
  const patch = parseComponent(match[3]!);
  const beta = match[4] === undefined ? undefined : parseComponent(match[4]);
  if (major === null || minor === null || patch === null || beta === null) return null;
  return {
    raw: value,
    major,
    minor,
    patch,
    channel: beta === undefined ? 'stable' : 'beta',
    ...(beta === undefined ? {} : { beta }),
  };
}

export function isMearlReleaseVersion(value: unknown): value is string {
  return parseMearlReleaseVersion(value) !== null;
}

export function parseMearlReleaseLine(value: unknown): MearlReleaseLine | null {
  if (typeof value !== 'string' || value.length > MEARL_RELEASE_VERSION_MAX_LENGTH) return null;
  const match = RELEASE_LINE_PATTERN.exec(value);
  if (!match) return null;
  const major = parseComponent(match[1]!);
  const minor = parseComponent(match[2]!);
  if (major === null || minor === null) return null;
  return { raw: value, major, minor };
}

export function isMearlReleaseLine(value: unknown): value is string {
  return parseMearlReleaseLine(value) !== null;
}

export function mearlReleaseLineForVersion(version: string): string {
  const parsed = parseMearlReleaseVersion(version);
  if (!parsed) throw new Error('A valid Mearl release version is required');
  return `${parsed.major}.${parsed.minor}.x`;
}

export function isMearlReleaseVersionInLine(version: string, releaseLine: string): boolean {
  const parsedVersion = parseMearlReleaseVersion(version);
  const parsedLine = parseMearlReleaseLine(releaseLine);
  return (
    parsedVersion !== null &&
    parsedLine !== null &&
    parsedVersion.major === parsedLine.major &&
    parsedVersion.minor === parsedLine.minor
  );
}

export function compareMearlReleaseLines(leftVersion: string, rightVersion: string): -1 | 0 | 1 {
  const left = parseMearlReleaseVersion(leftVersion);
  const right = parseMearlReleaseVersion(rightVersion);
  if (!left || !right) {
    throw new Error('Mearl release-line comparison requires valid release versions');
  }
  for (const key of ['major', 'minor'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

export function compareMearlReleaseVersions(leftVersion: string, rightVersion: string): -1 | 0 | 1 {
  const left = parseMearlReleaseVersion(leftVersion);
  const right = parseMearlReleaseVersion(rightVersion);
  if (!left || !right) {
    throw new Error('Mearl release comparison requires valid release versions');
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.channel !== right.channel) return left.channel === 'stable' ? 1 : -1;
  const leftBeta = left.beta ?? 0;
  const rightBeta = right.beta ?? 0;
  if (leftBeta < rightBeta) return -1;
  if (leftBeta > rightBeta) return 1;
  return 0;
}

/** Explicit release lines win; beta setup keeps all runtime packages on its own release. */
export function mearlPackageSelector(setupVersion: string, targetLine?: string): string {
  if (targetLine) return targetLine;
  return parseMearlReleaseVersion(setupVersion)?.channel === 'beta' ? setupVersion : 'latest';
}
