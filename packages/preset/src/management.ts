import { valid, validRange, satisfies, subset } from 'semver';
import { isJsonObject, PresetError } from './manifest.js';

export interface SetupManagement {
  package: string;
  version: string;
  registry?: string;
  runtime?: string;
}

/** Declarative installation guidance; never accepts commands, arguments or executable hooks. */
export function parseSetupManagement(value: unknown): SetupManagement | undefined {
  if (value === undefined) return;
  const invalid = (): never => { throw new PresetError('PRESET_INVALID', 'Invalid defaults.management.setup declaration'); };
  if (!isJsonObject(value) || Object.keys(value).some(key => key !== 'setup') || !isJsonObject(value.setup)) return invalid();
  const setup = value.setup;
  if (Object.keys(setup).some(key => !['package', 'version', 'registry', 'runtime'].includes(key)) ||
    typeof setup.package !== 'string' || setup.package.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(setup.package) ||
    typeof setup.version !== 'string' || setup.version.length > 64 || !(valid(setup.version) === setup.version || /^[a-z][a-z0-9.-]*$/.test(setup.version))) return invalid();
  if (setup.registry !== undefined) {
    if (typeof setup.registry !== 'string' || setup.registry.length > 2048 || !/^https:\/\/[a-zA-Z0-9./:_-]+$/.test(setup.registry)) return invalid();
    try {
      const url = new URL(setup.registry);
      if (!url.hostname || url.username || url.password || url.search || url.hash) return invalid();
    } catch { return invalid(); }
  }
  if (setup.runtime !== undefined && (typeof setup.runtime !== 'string' || setup.runtime.length > 128 || !validRange(setup.runtime))) return invalid();
  return { ...setup } as unknown as SetupManagement;
}

export function setupManagementCommand(setup: SetupManagement): string {
  return `npx${setup.registry ? ` --registry=${setup.registry}` : ''} ${setup.package}@${setup.version}`;
}

export function setupRuntimeCompatible(setup: SetupManagement, version: string, targetLine?: string): boolean {
  return !setup.runtime || (satisfies(version, setup.runtime, { includePrerelease: true }) && (!targetLine || subset(targetLine, setup.runtime, { includePrerelease: true })));
}
