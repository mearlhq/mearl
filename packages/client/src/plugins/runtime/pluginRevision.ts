import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { claimRecord, readRecord, writeRecord } from '@mearl/daemon-core';
import type { DaemonRecord } from '@mearl/daemon-core';
import { pluginHostPaths } from './pluginHostPaths.js';
import { skillManifestPath } from '../skillManifest.js';
import { findPluginRegistration, PluginError } from '../pluginRegistry.js';
import type { PluginRegistration } from '../pluginRegistry.js';

export interface PluginRevision {
  plugin: string;
  installationId: string;
  revision: string;
  originalRoot: string;
  entry: string;
  registration: PluginRegistration;
}

interface Installation extends DaemonRecord {
  installationId: string;
  root: string;
}
interface SourceFile {
  path: string;
  hash: string;
  bytes: Buffer;
  executable: boolean;
}
const MAX_REVISION_BYTES = 64 * 1024 * 1024;

function within(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function sourceRoot(entry: string): string {
  let candidate = dirname(entry);
  for (let depth = 0; depth < 6; depth++) {
    if (skillManifestPath(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return basename(dirname(entry)) === 'scripts' ? dirname(dirname(entry)) : dirname(entry);
}

function readSources(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const registry = realpathSync(pluginHostPaths().registry);
  let bytes = 0;
  const visit = (directory: string, ancestors: Set<string>) => {
    const real = realpathSync(directory);
    if (!within(root, real) || ancestors.has(real))
      throw new Error('Plugin snapshot has an external or cyclic directory link');
    const next = new Set([...ancestors, real]);
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (['.git', '__pycache__', 'node_modules', '.DS_Store'].includes(item.name)) continue;
      const file = join(directory, item.name);
      if (within(root, registry) && within(registry, file)) continue;
      const target = realpathSync(file);
      if (!within(root, target))
        throw new Error(`Plugin snapshot resource leaves the Skill directory: ${file}`);
      const stat = statSync(file);
      if (stat.isDirectory()) {
        visit(file, next);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported plugin resource: ${file}`);
      bytes += stat.size;
      if (bytes > MAX_REVISION_BYTES || files.length >= 10000)
        throw new Error('Plugin source snapshot exceeds 64 MiB or 10000 files');
      const content = readFileSync(file);
      bytes += content.length - stat.size;
      if (bytes > MAX_REVISION_BYTES) throw new Error('Plugin source snapshot exceeds 64 MiB');
      files.push({
        path: relative(root, file).split(sep).join('/'),
        hash: createHash('sha256').update(content).digest('hex'),
        bytes: content,
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  };
  visit(root, new Set());
  return files;
}

function fingerprint(files: SourceFile[], entry: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ entry, files: files.map(file => [file.path, file.hash, file.executable]) }),
    )
    .digest('hex');
}

/** Captures relative source and resources before a task is accepted; execution never reads the live entry. */
export function capturePluginRevision(plugin: string): PluginRevision {
  const registration = findPluginRegistration(plugin);
  if (!registration) throw new PluginError('PLUGIN_NOT_REGISTERED', `插件未注册: ${plugin}`);
  const entry = realpathSync(registration.entry);
  const root = realpathSync(sourceRoot(entry));
  const paths = pluginHostPaths();
  mkdirSync(paths.installations, { recursive: true, mode: 0o700 });
  const identityFile = join(paths.installations, `${plugin}.json`);
  let installation = readRecord<Installation>(identityFile);
  if (!installation || installation.root !== root) {
    const proposed: Installation = { pid: process.pid, root, installationId: randomUUID() };
    if (installation) writeRecord(identityFile, proposed);
    else claimRecord(identityFile, proposed);
    installation = readRecord<Installation>(identityFile);
  }
  if (!installation || installation.root !== root)
    throw new Error('Plugin installation changed during capture');
  const relativeEntry = relative(root, entry).split(sep).join('/');
  const files = readSources(root);
  const revision = fingerprint(files, relativeEntry);
  const revisionRoot = join(paths.revisions, installation.installationId, revision);
  if (!existsSync(revisionRoot)) {
    const temporary = `${revisionRoot}.${randomUUID()}.tmp`;
    try {
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const destination = resolve(temporary, file.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, file.bytes, {
          flag: 'wx',
          mode: file.executable ? 0o555 : 0o444,
        });
      }
      if (fingerprint(readSources(root), relativeEntry) !== revision)
        throw new PluginError('PLUGIN_SOURCE_CHANGED', '插件源码在创建快照时发生变化');
      mkdirSync(dirname(revisionRoot), { recursive: true, mode: 0o700 });
      renameSync(temporary, revisionRoot);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return {
    plugin,
    installationId: installation.installationId,
    revision,
    originalRoot: root,
    entry: join(revisionRoot, relativeEntry),
    registration: { ...registration, entry: join(revisionRoot, relativeEntry), source: undefined },
  };
}

export function prunePluginRevisions(references: Set<string>): void {
  const directory = pluginHostPaths().revisions;
  if (!existsSync(directory)) return;
  for (const installation of readdirSync(directory, { withFileTypes: true })) {
    if (!installation.isDirectory()) continue;
    const root = join(directory, installation.name);
    for (const revision of readdirSync(root, { withFileTypes: true })) {
      if (revision.isDirectory() && !references.has(`${installation.name}/${revision.name}`))
        rmSync(join(root, revision.name), { recursive: true, force: true });
    }
    if (!readdirSync(root).length) rmSync(root, { recursive: true, force: true });
  }
}

/** Recovery uses the retained snapshot after checking its identity and every source byte. */
export function restorePluginRevision(
  plugin: string,
  installationId: string,
  revision: string,
  entry: string,
): PluginRevision {
  if (!/^[a-f0-9-]{36}$/.test(installationId) || !/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Invalid recovery revision');
  const paths = pluginHostPaths();
  const registration = findPluginRegistration(plugin);
  const installation = readRecord<Installation>(join(paths.installations, `${plugin}.json`));
  if (
    !registration ||
    !installation ||
    installation.installationId !== installationId ||
    sourceRoot(realpathSync(registration.entry)) !== installation.root
  )
    throw new PluginError(
      'PLUGIN_TASK_INSTALLATION_CHANGED',
      'Task installation was removed or replaced',
    );
  try {
    const root = realpathSync(join(paths.revisions, installationId, revision));
    const restoredEntry = resolve(root, entry);
    if (
      !entry ||
      isAbsolute(entry) ||
      !within(root, restoredEntry) ||
      !within(root, realpathSync(restoredEntry)) ||
      fingerprint(readSources(root), entry) !== revision
    )
      throw new Error('Snapshot identity changed');
    return {
      plugin,
      installationId,
      revision,
      originalRoot: installation.root,
      entry: restoredEntry,
      registration: { ...registration, entry: restoredEntry, source: undefined },
    };
  } catch {
    throw new PluginError(
      'PLUGIN_TASK_REVISION_UNAVAILABLE',
      'Task source snapshot is missing or has changed',
    );
  }
}
