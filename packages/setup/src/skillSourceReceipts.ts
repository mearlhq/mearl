import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillSourceScope = 'global' | 'project';
export interface TrackedSkillSource {
  name: string;
  source: string;
  scope: SkillSourceScope;
  ref?: string;
  skillPath?: string;
  sourceType?: string;
  expectedHash?: string;
  hashKind: 'git-tree' | 'folder';
}
export interface SourceOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}
function lockFile(
  scope: SkillSourceScope,
  cwd: string | undefined,
  options: SourceOptions,
): string {
  const env = options.env ?? process.env;
  return scope === 'project'
    ? join(cwd!, 'skills-lock.json')
    : env.XDG_STATE_HOME
      ? join(env.XDG_STATE_HOME, 'skills', '.skill-lock.json')
      : join(options.homeDirectory ?? homedir(), '.agents', '.skill-lock.json');
}
export function readTrackedSkillSources(
  scope: SkillSourceScope,
  cwd?: string,
  options: SourceOptions = {},
): TrackedSkillSource[] {
  const file = lockFile(scope, cwd, options);
  let text: string;
  try {
    if (statSync(file).size > 4 * 1024 * 1024) throw new Error('Skill source lock exceeds 4 MiB');
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lock = JSON.parse(text) as { skills?: Record<string, Record<string, unknown>> };
  if (!lock || !lock.skills || typeof lock.skills !== 'object' || Array.isArray(lock.skills))
    throw new Error('Invalid Skills source lock');
  return Object.entries(lock.skills).flatMap(([name, entry]) => {
    if (!entry || typeof entry !== 'object' || entry.sourceType === 'node_modules') return [];
    if (!name || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name))
      throw new Error('Invalid tracked Skill name');
    const source = typeof entry.sourceUrl === 'string' ? entry.sourceUrl : entry.source;
    if (typeof source !== 'string' || !source.trim()) return [];
    if (source.length > 4096 || /[\0\r\n]/.test(source))
      throw new Error('Invalid tracked Skill source');
    const expectedHash = scope === 'global' ? entry.skillFolderHash : entry.computedHash;
    return [
      {
        name,
        source,
        scope,
        ...(typeof entry.sourceType === 'string' ? { sourceType: entry.sourceType } : {}),
        ...(typeof entry.ref === 'string' ? { ref: entry.ref } : {}),
        ...(typeof entry.skillPath === 'string' ? { skillPath: entry.skillPath } : {}),
        ...(typeof expectedHash === 'string' && expectedHash ? { expectedHash } : {}),
        hashKind:
          scope === 'global' &&
          typeof expectedHash === 'string' &&
          /^[a-f0-9]{40}$/.test(expectedHash)
            ? ('git-tree' as const)
            : ('folder' as const),
      },
    ];
  });
}

/** Custom source kinds require their installed backend, even if they use owner/repo syntax. */
export function isPublicSkillSource(source: TrackedSkillSource): boolean {
  return (
    source.sourceType === undefined ||
    ['github', 'gitlab', 'git', 'local', 'well-known'].includes(source.sourceType)
  );
}

export function gitSource(
  source: string,
  ref?: string,
): { repository: string; ref?: string; subdirectory?: string } {
  if (/^[\w.-]+\/[\w.-]+$/.test(source))
    return { repository: `https://github.com/${source}.git`, ...(ref ? { ref } : {}) };
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(source))
    return { repository: source, ...(ref ? { ref } : {}) };
  const url = new URL(source);
  if (
    !['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol) ||
    url.password ||
    (url.username && url.protocol !== 'ssh:') ||
    url.search ||
    url.hash
  )
    throw new Error('Skill source is not a supported Git repository');
  if (url.hostname === 'github.com' && !url.port) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2)
      return {
        repository: `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}.git`,
        ...(ref || (['tree', 'blob'].includes(parts[2]) && parts[3])
          ? { ref: ref || decodeURIComponent(parts[3]) }
          : {}),
        ...(['tree', 'blob'].includes(parts[2]) && parts.length > 4
          ? {
              subdirectory: decodeURIComponent(parts.slice(4).join('/')).replace(
                /\/SKILL\.md$/,
                '',
              ),
            }
          : {}),
      };
  }
  return { repository: url.href, ...(ref ? { ref } : {}) };
}

/** Compare the manager's existing source receipt; no network access or second lockfile. */
export function matchesTrackedSkillSource(
  requested: string,
  tracked: TrackedSkillSource,
  normalize: (source: string, sourceType?: string) => string = source => source,
  refMatch: 'exact' | 'missing' = 'exact',
): boolean {
  const location = (source: string, ref?: string, sourceType?: string) => {
    const value = normalize(source, sourceType);
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\0\r\n]/.test(value))
      throw new Error('Invalid normalized Skill source');
    const hash = value.indexOf('#');
    const fragment = hash < 0 ? undefined : value.slice(hash + 1);
    const plain = hash < 0 ? value : value.slice(0, hash);
    const parsed = isAbsolute(plain)
      ? { repository: plain, ref: ref ?? fragment }
      : gitSource(plain, ref ?? fragment);
    let repository = parsed.repository;
    if (repository.startsWith('file:')) repository = fileURLToPath(repository);
    if (isAbsolute(repository)) repository = resolve(repository);
    else {
      const ssh = repository.match(/^[\w.-]+@([\w.-]+):(.+)$/);
      const url = new URL(ssh ? `ssh://${ssh[1]}/${ssh[2]}` : repository);
      // Authentication transport is independent of the repository's identity.
      repository = `${url.hostname.toLowerCase()}${url.port ? ':' + url.port : ''}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`;
    }
    return { ...parsed, repository, ref: parsed.ref || undefined };
  };
  try {
    const expected = location(requested);
    const actual = location(tracked.source, tracked.ref, tracked.sourceType);
    if (expected.repository !== actual.repository) return false;
    if (
      refMatch === 'missing'
        ? !expected.ref || actual.ref !== undefined
        : expected.ref !== actual.ref
    )
      return false;
    if (!expected.subdirectory) return true;
    const path = (tracked.skillPath ?? actual.subdirectory ?? '')
      .replace(/(?:^|\/)SKILL\.md$/, '')
      .replace(/\/+$/, '');
    return path === expected.subdirectory || path.startsWith(expected.subdirectory + '/');
  } catch {
    return (
      refMatch === 'exact' &&
      normalize(requested) === normalize(tracked.source, tracked.sourceType) &&
      !tracked.ref
    );
  }
}
