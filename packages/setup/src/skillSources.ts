import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { lstatSync, realpathSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCommand, type CommandRunner } from '@mearl/daemon-core';
import { satisfies, valid } from 'semver';
import {
  DISABLED_SKILL_MANIFEST,
  getSkillEnabled,
  findPluginDirectoryEntry,
  findPluginRegistration,
  listPluginNames,
  OFFICIAL_PLUGIN_MANAGER,
  pluginRegistrationNeedsRefresh,
  readInstalledSkillMetadata,
} from '@mearl/client/plugin';
import { existsSync } from 'node:fs';

import {
  gitSource,
  isPublicSkillSource,
  matchesTrackedSkillSource,
  readTrackedSkillSources,
  type SourceOptions,
  type SkillSourceScope,
  type TrackedSkillSource,
} from './skillSourceReceipts.js';
export {
  isPublicSkillSource,
  matchesTrackedSkillSource,
  readTrackedSkillSources,
} from './skillSourceReceipts.js';
export type { SkillSourceScope, TrackedSkillSource } from './skillSourceReceipts.js';

function skillName(text: string): string | undefined {
  return text
    .match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
    .match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1]
    ?.trim();
}
async function findSkillDirectory(root: string, name: string, skillPath?: string): Promise<string> {
  if (skillPath) {
    const directory = resolve(root, skillPath.replace(/(?:^|\/)SKILL\.md$/, ''));
    const resolvedRoot = await realpath(root);
    const candidate = await realpath(directory);
    if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep))
      throw new Error('Skill source path escapes its repository');
    if (skillName(await readFile(join(candidate, 'SKILL.md'), 'utf8')) === name) return candidate;
  }
  const matches: string[] = [];
  let scanned = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (++scanned > 10_000 || depth > 32)
      throw new Error('Skill source discovery exceeds its limit');
    const entries = await readdir(directory, { withFileTypes: true });
    const manifest = entries.find(entry => entry.name === 'SKILL.md' && entry.isFile());
    if (manifest && skillName(await readFile(join(directory, 'SKILL.md'), 'utf8')) === name)
      matches.push(directory);
    for (const entry of entries)
      if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name))
        await visit(join(directory, entry.name), depth + 1);
  };
  await visit(root, 0);
  if (matches.length !== 1) throw new Error(`Cannot uniquely locate Skill source: ${name}`);
  return matches[0];
}

/** Matches the public Skills folder hash without writing to the installed Skill. */
export async function hashSkillDirectory(
  directory: string,
  ignoreRuntimeFiles = false,
): Promise<string> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  let total = 0;
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (
        ['.git', 'node_modules'].includes(entry.name) ||
        (ignoreRuntimeFiles && ['__pycache__', '.DS_Store'].includes(entry.name))
      )
        continue;
      const file = join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const info = await stat(file);
        total += info.size;
        if (total > 64 * 1024 * 1024 || files.length >= 10_000)
          throw new Error('Skill source exceeds the comparison limit');
        files.push({
          path: relative(directory, file)
            .split(sep)
            .join('/')
            .replace(ignoreRuntimeFiles ? /^SKILL\.md\.mearl-disabled$/ : /$^/, 'SKILL.md'),
          bytes: await readFile(file),
        });
      }
    }
  };
  await visit(directory);
  const hash = createHash('sha256');
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

/** Checks source content in a temporary checkout; never invokes the mutating Skills `check` alias. */
export async function checkTrackedSkillUpdates(
  options: SourceOptions & { cwd?: string; runCommand?: CommandRunner } = {},
): Promise<Array<{ name: string; source: string; scope: SkillSourceScope }>> {
  const sources = [
    ...readTrackedSkillSources('global', undefined, options),
    ...(options.cwd ? readTrackedSkillSources('project', options.cwd, options) : []),
  ];
  if (sources.some(source => !isPublicSkillSource(source)))
    throw new Error('Installed Skills require an external manager. Enable its preset.');
  if (sources.length > 500) throw new Error('Too many tracked Skills to inspect at once');
  const temporary = await mkdtemp(join(tmpdir(), 'mearl-skill-sources-'));
  const checkouts = new Map<string, Promise<string>>();
  const runner = options.runCommand ?? runCommand;
  const updates: Array<{ name: string; source: string; scope: SkillSourceScope }> = [];
  try {
    for (const source of sources) {
      const local = isAbsolute(source.source) ? source.source : undefined;
      const location = local ? { repository: local } : gitSource(source.source, source.ref);
      const key = JSON.stringify(location);
      let checkout = checkouts.get(key);
      if (!checkout) {
        const target = join(temporary, String(checkouts.size));
        checkout = local
          ? Promise.resolve(local)
          : (async () => {
              const result = await runner(
                'git',
                [
                  'clone',
                  '--depth',
                  '1',
                  '--filter=blob:none',
                  ...(location.ref ? ['--branch', location.ref] : []),
                  '--',
                  location.repository,
                  target,
                ],
                {
                  capture: true,
                  env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
                  timeoutMs: 120_000,
                },
              );
              if (result.code !== 0)
                throw new Error(`Unable to inspect Skill source: ${source.name}`);
              return target;
            })();
        checkouts.set(key, checkout);
      }
      const root = await realpath(await checkout);
      const directory = await findSkillDirectory(
        root,
        source.name,
        source.skillPath ?? location.subdirectory,
      );
      let changed: boolean;
      if (source.expectedHash && source.hashKind === 'git-tree' && !local) {
        const folder = relative(root, directory).split(sep).join('/');
        const result = await runner(
          'git',
          ['rev-parse', `HEAD${folder ? ':' + folder : '^{tree}'}`],
          { cwd: root, capture: true, timeoutMs: 30_000 },
        );
        if (result.code !== 0 || !/^[a-f\d]{40,64}$/.test(result.stdout.trim()))
          throw new Error(`Unable to compare Skill revision: ${source.name}`);
        changed = result.stdout.trim() !== source.expectedHash;
      } else if (source.expectedHash && source.hashKind === 'folder')
        changed = (await hashSkillDirectory(directory)) !== source.expectedHash;
      else {
        const installed = join(
          source.scope === 'global' ? (options.homeDirectory ?? homedir()) : options.cwd!,
          '.agents',
          'skills',
          source.name,
        );
        changed =
          (await hashSkillDirectory(directory, true)) !==
          (await hashSkillDirectory(installed, true));
      }
      if (changed) updates.push({ name: source.name, source: source.source, scope: source.scope });
    }
    return updates;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface SkillInstallationStatus {
  state: 'ready' | 'missing' | 'version' | 'registration' | 'migration' | 'conflict';
  reason?: string;
}

/** Developer links keep their Git checkout as the source receipt without changing a manager's lock. */
export function readLinkedSkillSource(
  directory: string,
  name: string,
): TrackedSkillSource | undefined {
  try {
    if (!lstatSync(directory).isSymbolicLink()) return undefined;
    const actual = realpathSync(directory);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', actual, ...args],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2_000,
          maxBuffer: 16_384,
        },
      ).trim();
    const root = git('rev-parse', '--show-toplevel');
    const folder = relative(root, actual);
    if (folder === '..' || folder.startsWith('..' + sep) || isAbsolute(folder)) return undefined;
    const skillPath = (folder ? folder.split(sep).join('/') + '/' : '') + 'SKILL.md';
    if (git('ls-files', '--full-name', '--error-unmatch', '--', 'SKILL.md') !== skillPath)
      return undefined;
    const source = git('config', '--get', 'remote.origin.url');
    if (!source || source.length > 4096 || /[\0\r\n]/.test(source)) return undefined;
    if (!isAbsolute(source)) gitSource(source);
    return { name, source, scope: 'global', skillPath, sourceType: 'git', hashKind: 'folder' };
  } catch {
    return undefined;
  }
}

/** Keep the user's disabled state when an installer replaces the Skill directory. */
export async function preserveSkillDisabled<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const disabled = getSkillEnabled(directory) === false;
  try {
    return await operation();
  } finally {
    if (disabled && existsSync(join(directory, 'SKILL.md')))
      renameSync(join(directory, 'SKILL.md'), join(directory, DISABLED_SKILL_MANIFEST));
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

function hasOnlySetupRegistrations(directory: string, allowUnregistered = false): boolean {
  const contains = (root: string, entry: string) => {
    const path = relative(root, entry);
    return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
  };
  const registrations = listPluginNames()
    .flatMap(name => findPluginRegistration(name) ?? [])
    .filter(
      registration =>
        contains(resolve(directory), resolve(registration.entry)) ||
        contains(canonicalPath(directory), canonicalPath(registration.entry)),
    );
  return (
    (allowUnregistered || registrations.length > 0) &&
    registrations.every(registration => registration.managedBy === OFFICIAL_PLUGIN_MANAGER)
  );
}

/** CLI and Agent readiness use the same source, manifest and registration evidence. */
export function inspectGlobalSkill(
  source: string,
  name: string,
  version?: string,
  options: {
    homeDirectory?: string;
    readSources?: typeof readTrackedSkillSources;
    externalManager?: boolean;
    migrateFrom?: readonly string[];
    normalizeSource?: (source: string, sourceType?: string) => string;
  } = {},
): SkillInstallationStatus {
  if (!source.trim() || !name || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name))
    throw new Error('Invalid Skill identity');
  const directory = join(options.homeDirectory ?? homedir(), '.agents', 'skills', name);
  if (
    existsSync(join(directory, 'SKILL.md')) &&
    existsSync(join(directory, DISABLED_SKILL_MANIFEST))
  )
    return { state: 'conflict', reason: 'SKILL_MANIFEST_CONFLICT' };
  const receipt = (options.readSources ?? readTrackedSkillSources)('global', undefined, {
    homeDirectory: options.homeDirectory,
  }).find(entry => entry.name === name);
  const tracked =
    receipt ??
    (!/(?:#|\/(?:tree|blob)\/)/.test(source) ? readLinkedSkillSource(directory, name) : undefined);
  if (
    tracked &&
    ((!options.externalManager && !isPublicSkillSource(tracked)) ||
      !matchesTrackedSkillSource(source, tracked, options.normalizeSource))
  ) {
    const metadata = readInstalledSkillMetadata(directory);
    if (
      receipt &&
      (options.externalManager || isPublicSkillSource(receipt)) &&
      metadata?.name === name
    ) {
      // A missing ref requires installing the requested ref before the Skill can be ready.
      const missingRef = matchesTrackedSkillSource(
        source,
        receipt,
        options.normalizeSource,
        'missing',
      );
      const declaredMigration = options.migrateFrom?.some(previous =>
        matchesTrackedSkillSource(previous, receipt, options.normalizeSource),
      );
      if ((missingRef || declaredMigration) && hasOnlySetupRegistrations(directory, missingRef)) {
        return { state: 'migration', reason: 'SKILL_SOURCE_MIGRATION_REQUIRED' };
      }
    }
    return { state: 'conflict', reason: 'SKILL_SOURCE_CONFLICT' };
  }
  const metadata = readInstalledSkillMetadata(directory);
  if (!metadata) return { state: 'missing', reason: 'SKILL_NOT_INSTALLED' };
  if (!tracked) return { state: 'conflict', reason: 'SKILL_SOURCE_UNKNOWN' };
  if (metadata.name !== name) return { state: 'conflict', reason: 'SKILL_MANIFEST_IDENTITY' };
  if (
    version &&
    (!metadata.version || !valid(metadata.version) || !satisfies(metadata.version, version))
  )
    return { state: 'version', reason: 'SKILL_VERSION_REQUIRED' };
  const entry = findPluginDirectoryEntry(directory);
  const names = listPluginNames().filter(name => {
    const registered = findPluginRegistration(name)?.entry;
    return registered !== undefined && resolve(dirname(dirname(registered))) === resolve(directory);
  });
  const managedNames = names.filter(
    name => findPluginRegistration(name)?.managedBy === OFFICIAL_PLUGIN_MANAGER,
  );
  // User aliases may share a managed Skill without participating in its readiness or cleanup.
  const requiredNames = managedNames.length ? managedNames : names;
  if (
    entry &&
    (requiredNames.length !== 1 ||
      !requiredNames.some(name => {
        const registration = findPluginRegistration(name)!;
        return (
          resolve(registration.entry) === resolve(entry) &&
          !pluginRegistrationNeedsRefresh(registration, true)
        );
      }))
  )
    return { state: 'registration', reason: 'SKILL_PLUGIN_REGISTRATION_REQUIRED' };
  if (!entry && names.length)
    return { state: 'registration', reason: 'SKILL_PLUGIN_REGISTRATION_REQUIRED' };
  return { state: 'ready' };
}
