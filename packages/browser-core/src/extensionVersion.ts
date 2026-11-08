interface ExtensionManifestVersion {
  version?: unknown;
  version_name?: unknown;
}

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const STABLE_BUILD = 65_535;

/** Chrome compares four numeric components; stable builds sort after their betas. */
export function extensionManifestVersion(release: string): { version: string; version_name: string } {
  const match = RELEASE.exec(release);
  if (!match) throw new Error('Invalid extension release version');
  const parts = match.slice(1, 4).map(Number);
  const build = match[4] === undefined ? STABLE_BUILD : Number(match[4]);
  if (parts.some(value => value > STABLE_BUILD) || build > STABLE_BUILD || (match[4] !== undefined && build === STABLE_BUILD)) {
    throw new Error('Extension release version exceeds Chrome numeric limits');
  }
  return { version: [...parts, build].join('.'), version_name: release };
}

/** Verify the display release against the numeric version, accepting legacy stable manifests. */
export function readExtensionReleaseVersion(manifest: ExtensionManifestVersion): string | null {
  if (typeof manifest.version !== 'string') return null;
  if (manifest.version_name === undefined) {
    const match = RELEASE.exec(manifest.version);
    return match && match[4] === undefined && match.slice(1, 4).every(value => Number(value) <= STABLE_BUILD)
      ? manifest.version
      : null;
  }
  if (typeof manifest.version_name !== 'string') return null;
  try {
    return extensionManifestVersion(manifest.version_name).version === manifest.version
      ? manifest.version_name
      : null;
  } catch {
    return null;
  }
}
