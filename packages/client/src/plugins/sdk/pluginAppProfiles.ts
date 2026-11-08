import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  validateAppProfileContribution,
  type AppProfileContribution,
} from '@mearl/browser-core';
import { pluginFileVersion } from '../pluginSource.js';

/** Profile resources share the Skill root and metadata refresh rules of toolbox resources. */
export function loadPluginAppProfiles(
  entry: string,
  value: unknown,
): {
  appProfiles?: AppProfileContribution;
  profileSources?: Record<string, string>;
} {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('appProfiles must be an object');
  const declaration = value as Record<string, unknown>;
  if (!Array.isArray(declaration.profiles))
    throw new Error('appProfiles.profiles must be an array');
  const root = realpathSync(
    basename(dirname(entry)) === 'scripts' ? dirname(dirname(entry)) : dirname(entry),
  );
  const sources: Record<string, string> = {};
  const profiles = declaration.profiles.map(profile => {
    if (typeof profile !== 'string') return profile;
    if (isAbsolute(profile) || !profile.endsWith('.json'))
      throw new Error('Profile resource must be a relative JSON path');
    const reference = resolve(root, profile);
    const file = realpathSync(reference);
    const inside = relative(root, file);
    if (inside.startsWith('..') || isAbsolute(inside))
      throw new Error('Profile resource must stay inside the Skill directory');
    const version = pluginFileVersion(file);
    const content = readFileSync(file, 'utf8');
    if (content.length > 65_536) throw new Error('Profile resource exceeds 64 KiB');
    const parsed = JSON.parse(content);
    if (pluginFileVersion(reference) !== version)
      throw new Error('Profile resource changed during registration');
    sources[reference] = version;
    return parsed;
  });
  return {
    appProfiles: validateAppProfileContribution({ ...declaration, profiles }),
    profileSources: sources,
  };
}
