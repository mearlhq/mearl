import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import {
  assertPluginName,
  findPluginRegistration,
  pluginDirectory,
  unregisterPlugin,
} from './pluginRegistry.js';

export const OFFICIAL_PLUGIN_MANAGER = '@mearl/setup:official';

export interface OfficialPluginDefinition {
  description: string;
  installArgs: readonly string[];
  setup?: string;
  skill: string;
}
export type OfficialPluginName = string;
export const OFFICIAL_PLUGINS: Record<string, OfficialPluginDefinition> = {};

export interface PluginCatalogSelection {
  path: string;
  sha256: string;
}
export interface PluginCatalog {
  schemaVersion: 1;
  revision: string;
  plugins: Record<string, OfficialPluginDefinition>;
  selection?: PluginCatalogSelection;
}
const MAX_CATALOG_BYTES = 256 * 1024;
const catalogPath = () => join(pluginDirectory(), '.official-catalog.json');

export function validateOfficialPluginCatalog(value: unknown): PluginCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid managed plugin catalog');
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.revision) ||
    !input.plugins ||
    typeof input.plugins !== 'object' ||
    Array.isArray(input.plugins) ||
    Object.keys(input).some(
      key => !['schemaVersion', 'revision', 'plugins', 'selection'].includes(key),
    ) ||
    Object.keys(input.plugins).length > 200
  )
    throw new Error('Invalid managed plugin catalog');
  const selection = input.selection as PluginCatalogSelection | undefined;
  if (
    selection !== undefined &&
    (!selection ||
      typeof selection !== 'object' ||
      Array.isArray(selection) ||
      Object.keys(selection).some(key => !['path', 'sha256'].includes(key)) ||
      typeof selection.path !== 'string' ||
      !isAbsolute(selection.path) ||
      selection.path.length > 4096 ||
      /[\0\r\n]/.test(selection.path) ||
      typeof selection.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(selection.sha256))
  )
    throw new Error('Invalid plugin catalog selection');
  const plugins: Record<string, OfficialPluginDefinition> = {};
  for (const [name, value] of Object.entries(input.plugins)) {
    assertPluginName(name);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid managed plugin declaration');
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).some(
        key => !['description', 'installArgs', 'setup', 'skill'].includes(key),
      ) ||
      typeof item.description !== 'string' ||
      item.description.length > 1000 ||
      typeof item.skill !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(item.skill) ||
      !Array.isArray(item.installArgs) ||
      item.installArgs.length === 0 ||
      item.installArgs.length > 32 ||
      item.installArgs.some(
        arg => typeof arg !== 'string' || arg.length > 2048 || /[\0\r\n]/.test(arg),
      ) ||
      (item.setup !== undefined &&
        (typeof item.setup !== 'string' || !/^[a-z][a-z0-9-]*$/.test(item.setup)))
    )
      throw new Error('Invalid managed plugin declaration');
    plugins[name] = {
      description: item.description,
      skill: item.skill,
      installArgs: [...item.installArgs] as string[],
      ...(item.setup !== undefined && { setup: item.setup as string }),
    };
  }
  const catalog: PluginCatalog = {
    schemaVersion: 1,
    revision: input.revision,
    plugins,
    ...(selection ? { selection: { path: selection.path, sha256: selection.sha256 } } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_CATALOG_BYTES)
    throw new Error('Managed plugin catalog exceeds 256 KiB');
  return catalog;
}

function selectionMatches(selection: PluginCatalogSelection): boolean {
  try {
    const before = lstatSync(selection.path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) return false;
    const fd = openSync(selection.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) return false;
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      return (
        size === stat.size &&
        createHash('sha256').update(bytes.subarray(0, size)).digest('hex') === selection.sha256
      );
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function readOfficialPluginCatalog(): PluginCatalog | undefined {
  let source: string;
  try {
    source = readFileSync(catalogPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (Buffer.byteLength(source) > MAX_CATALOG_BYTES)
    throw new Error('Managed plugin catalog exceeds 256 KiB');
  const catalog = validateOfficialPluginCatalog(JSON.parse(source));
  return catalog.selection && !selectionMatches(catalog.selection) ? undefined : catalog;
}

/** Installation hosts persist only the catalog selected by an approved preset. */
export function replaceOfficialPluginCatalog(
  revision: string,
  plugins: Record<string, OfficialPluginDefinition>,
  selection?: PluginCatalogSelection,
): void {
  const catalog = validateOfficialPluginCatalog({
    schemaVersion: 1,
    revision,
    plugins,
    ...(selection ? { selection } : {}),
  });
  const content = JSON.stringify(catalog);
  if (Buffer.byteLength(content) > MAX_CATALOG_BYTES)
    throw new Error('Managed plugin catalog exceeds 256 KiB');
  if (catalog.selection && !selectionMatches(catalog.selection))
    throw new Error('PLUGIN_CATALOG_SELECTION_CHANGED');
  mkdirSync(pluginDirectory(), { recursive: true, mode: 0o700 });
  const file = catalogPath();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    if (catalog.selection && !selectionMatches(catalog.selection))
      throw new Error('PLUGIN_CATALOG_SELECTION_CHANGED');
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  refreshOfficialPlugins();
}

function refreshOfficialPlugins(): Record<string, OfficialPluginDefinition> {
  let plugins: Record<string, OfficialPluginDefinition> = {};
  try {
    plugins = readOfficialPluginCatalog()?.plugins ?? {};
  } catch {
    /* An invalid optional catalog cannot disable registered plugin or browser commands. */
  }
  for (const name of Object.keys(OFFICIAL_PLUGINS)) delete OFFICIAL_PLUGINS[name];
  Object.assign(OFFICIAL_PLUGINS, plugins);
  return OFFICIAL_PLUGINS;
}

/** Remove only registrations owned by the catalog for the exact active selection. */
export function uninstallOfficialPluginCatalog(selection: PluginCatalogSelection): void {
  const catalog = readOfficialPluginCatalog();
  if (catalog?.selection?.path !== selection.path || catalog.selection.sha256 !== selection.sha256)
    return;
  for (const name of Object.keys(catalog.plugins)) {
    if (findPluginRegistration(name)?.managedBy === OFFICIAL_PLUGIN_MANAGER) unregisterPlugin(name);
  }
  rmSync(catalogPath(), { force: true });
  refreshOfficialPlugins();
}

refreshOfficialPlugins();

export function findOfficialPlugin(name: string): OfficialPluginDefinition | undefined {
  const plugins = refreshOfficialPlugins();
  return Object.hasOwn(plugins, name) ? plugins[name] : undefined;
}

export function listOfficialPluginNames(setup?: string): string[] {
  return Object.entries(refreshOfficialPlugins())
    .filter(([, item]) => setup === undefined || item.setup === setup)
    .map(([name]) => name);
}
