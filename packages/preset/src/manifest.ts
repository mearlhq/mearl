import { validateInstallationOrigin } from './installation.js';
import { valid, validRange } from 'semver';
import type { JsonObject, JsonValue, PresetComponent, PresetManifest } from './types.js';

export class PresetError extends Error {
  constructor(
    readonly code: 'PRESET_INVALID' | 'PRESET_CYCLE' | 'PRESET_INCOMPATIBLE' | 'PRESET_DEPENDENCY',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PresetError';
  }
}

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const componentId = /^[a-z][a-z0-9-]{0,79}$/;

function invalid(path: string, reason: string): never {
  throw new PresetError('PRESET_INVALID', `${path}: ${reason}`);
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function object(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isJsonObject(value)) invalid(path, 'expected a plain object');
  for (const key of Object.keys(value)) if (unsafeKeys.has(key)) invalid(path, `unsafe key ${key}`);
}

function fields(value: unknown, path: string, names: string[]): asserts value is Record<string, unknown> {
  object(value, path);
  for (const key of Object.keys(value)) {
    if (!names.includes(key)) invalid(`${path}.${key}`, 'unknown field');
  }
}

function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    invalid(path, 'expected a non-empty trimmed string');
  }
}

function id(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !componentId.test(value)) invalid(path, 'invalid ID');
}

function range(value: unknown, path: string): asserts value is string {
  text(value, path);
  if (validRange(value) === null) invalid(path, 'invalid version range');
}

function stringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array');
  for (const [index, item] of value.entries()) text(item, `${path}[${index}]`);
  if (new Set(value).size !== value.length) invalid(path, 'duplicate values');
}

function json(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 32) invalid(path, 'JSON nesting exceeds 32 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, (item, index) => json(item, `${path}[${index}]`, depth + 1));
  object(value, path);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, `${path}.${key}`, depth + 1)]));
}

/** Validates and clones JSON configuration without executing or evaluating it. */
export function clonePresetDefaults(value: unknown): JsonObject {
  object(value, 'defaults');
  return json(value, 'defaults') as JsonObject;
}

function component(value: unknown, path: string, kind: string): PresetComponent {
  fields(value, path, ['source', 'version', 'enabled', 'targets', 'dependsOn', 'migrateFrom']);
  if ('source' in value) text(value.source, `${path}.source`);
  if ('version' in value) range(value.version, `${path}.version`);
  if ('migrateFrom' in value) {
    if (kind !== 'skills') invalid(`${path}.migrateFrom`, 'only Skills support source migration');
    stringArray(value.migrateFrom, `${path}.migrateFrom`);
    if (value.migrateFrom.length > 16) invalid(`${path}.migrateFrom`, 'exceeds 16 sources');
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') invalid(`${path}.enabled`, 'expected a boolean');
  if ('targets' in value) {
    stringArray(value.targets, `${path}.targets`);
    if (value.targets.length === 0 || value.targets.some(item => item !== 'browser' && item !== 'node')) {
      invalid(`${path}.targets`, 'expected browser and/or node');
    }
  }
  if ('dependsOn' in value) {
    stringArray(value.dependsOn, `${path}.dependsOn`);
    for (const item of value.dependsOn) id(item, `${path}.dependsOn`);
  }
  return json(value, path) as PresetComponent;
}

export function validatePreset(value: unknown): PresetManifest {
  fields(value, 'preset', ['schemaVersion', 'id', 'version', 'extends', 'requires', 'packages', 'skills', 'providers', 'appProfiles', 'defaults', 'permissions']);
  if (value.schemaVersion !== 1) invalid('schemaVersion', 'only version 1 is supported');
  id(value.id, 'id');
  text(value.version, 'version');
  if (valid(value.version) !== value.version) invalid('version', 'expected an exact semantic version');
  const result: PresetManifest = { schemaVersion: 1, id: value.id, version: value.version };
  if ('extends' in value) {
    fields(value.extends, 'extends', ['source', 'version']);
    text(value.extends.source, 'extends.source');
    if ('version' in value.extends) range(value.extends.version, 'extends.version');
    result.extends = { source: value.extends.source, ...(value.extends.version === undefined ? {} : { version: value.extends.version as string }) };
  }
  if ('requires' in value) {
    fields(value.requires, 'requires', ['mearlApi']);
    if ('mearlApi' in value.requires) range(value.requires.mearlApi, 'requires.mearlApi');
    result.requires = { ...(value.requires.mearlApi === undefined ? {} : { mearlApi: value.requires.mearlApi as string }) };
  }
  for (const kind of ['packages', 'skills', 'providers'] as const) {
    if (!(kind in value)) continue;
    const declarations = value[kind];
    object(declarations, kind);
    result[kind] = Object.fromEntries(Object.entries(declarations).map(([key, item]) => {
      id(key, `${kind}.${key}`);
      return [key, component(item, `${kind}.${key}`, kind)];
    }));
  }
  if ('appProfiles' in value) {
    object(value.appProfiles, 'appProfiles');
    result.appProfiles = Object.fromEntries(Object.entries(value.appProfiles).map(([key, target]) => {
      id(key, `appProfiles.${key}`);
      text(target, `appProfiles.${key}`);
      return [key, target];
    }));
  }
  if ('defaults' in value) result.defaults = clonePresetDefaults(value.defaults);
  if ('permissions' in value) {
    fields(value.permissions, 'permissions', ['origins']);
    if ('origins' in value.permissions) stringArray(value.permissions.origins, 'permissions.origins');
    const origins = value.permissions.origins as string[] | undefined ?? [];
    if (origins.length > 64) invalid('permissions.origins', 'exceeds 64 scopes');
    result.permissions = { origins: [...new Set(origins.map((origin, index) => {
      try { return validateInstallationOrigin(origin); }
      catch { return invalid(`permissions.origins[${index}]`, 'expected an explicit HTTP host scope'); }
    }))] };
  }
  if (JSON.stringify(result).length > 262_144) invalid('preset', 'manifest exceeds 256 Ki UTF-16 code units');
  return result;
}
