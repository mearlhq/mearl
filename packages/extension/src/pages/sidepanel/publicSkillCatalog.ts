import releasedSkills from '../../../../../skills/catalog.json';
import type { SkillCatalog, SkillSummary } from './skillCatalog';

const source = 'mearlhq/mearl';
const bundledDocs = import.meta.glob<string>('../../../../../skills/*/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const previewCache = new Map<string, string>();
function scalar(markdown: string, key: 'name' | 'description') {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  const value = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return '';
    }
  }
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replace(/''/g, "'")
    : value;
}
// The catalog follows the release snapshot; source-only Skills join it during version preparation.
const builtinSkills: SkillSummary[] = Object.entries(bundledDocs)
  .filter(([path]) => releasedSkills.includes(path.split('/').at(-2)!))
  .map(([path, markdown]) => {
    const folder = path.split('/').at(-2)!;
    const name = scalar(markdown, 'name') || folder;
    const installSource = `https://github.com/${source}`;
    const pageBase = `https://github.com/${source}/tree/main`;
    return {
      id: `${source}/${name}`,
      name,
      source,
      installSource,
      sourceType: 'github',
      description: scalar(markdown, 'description'),
      installs: 0,
      tags: [],
      collectionIds: [],
      files: [`skills/${folder}/SKILL.md`],
      pageUrl: `${pageBase}/skills/${encodeURIComponent(folder)}`,
    };
  });

async function requestJson(url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok)
    throw new Error(
      response.status === 403 || response.status === 429
        ? 'SKILLS_RATE_LIMITED'
        : 'SKILLS_REQUEST_FAILED',
    );
  return response.json();
}

async function search(query: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!query.trim()) return { skills: builtinSkills };
  const params = new URLSearchParams({ q: query.trim(), limit: '50' });
  const result = await requestJson(`https://skills.sh/api/search?${params}`, signal);
  if (!Array.isArray(result?.skills)) throw new Error('SKILLS_INVALID_RESPONSE');
  const skills: SkillSummary[] = result.skills.slice(0, 50).flatMap((value: any) => {
    if (
      typeof value?.source !== 'string' ||
      !repositoryPattern.test(value.source) ||
      typeof value.name !== 'string' ||
      !value.name ||
      typeof value.id !== 'string' ||
      !value.id
    )
      return [];
    return [
      {
        id: value.id,
        name: value.name,
        source: value.source,
        installSource: `https://github.com/${value.source}`,
        sourceType: 'github',
        description: typeof value.description === 'string' ? value.description : '',
        installs: Number.isFinite(value.installs) ? value.installs : 0,
        tags: [],
        collectionIds: [],
        files: [],
        pageUrl: `https://skills.sh/${value.id.split('/').map(encodeURIComponent).join('/')}`,
      },
    ];
  });
  return { skills };
}

async function markdown(skill: SkillSummary, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const builtin = skill.source === source && builtinSkills.find(item => item.name === skill.name);
  if (builtin) return bundledDocs[`../../../../../${builtin.files[0]}`];
  if (!repositoryPattern.test(skill.source)) throw new Error('SKILLS_MARKDOWN_UNAVAILABLE');
  const key = JSON.stringify([skill.source, skill.name]);
  const cached = previewCache.get(key);
  if (cached !== undefined) return cached;
  const base = `https://api.github.com/repos/${skill.source}`;
  const repository = await requestJson(base, signal);
  if (typeof repository.default_branch !== 'string' || !repository.default_branch)
    throw new Error('SKILLS_MARKDOWN_UNAVAILABLE');
  const tree = await requestJson(
    `${base}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
    signal,
  );
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('SKILLS_MARKDOWN_UNAVAILABLE');
  const candidates = tree.tree.filter(
    (item: any) =>
      item?.type === 'blob' &&
      typeof item.path === 'string' &&
      (item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md')) &&
      /^[a-f0-9]{40,64}$/.test(item.sha) &&
      Number.isSafeInteger(item.size) &&
      item.size <= 2 * 1024 * 1024,
  );
  const load = async (candidate: { sha: string }) => {
    // Blob IDs address the selected file; a tree ID is not a raw-file commit ref.
    const blob = await requestJson(`${base}/git/blobs/${candidate.sha}`, signal);
    if (
      blob.encoding !== 'base64' ||
      typeof blob.content !== 'string' ||
      blob.content.length > 3 * 1024 * 1024
    )
      throw new Error('SKILLS_INVALID_RESPONSE');
    return new TextDecoder().decode(
      Uint8Array.from(atob(blob.content.replace(/\s/g, '')), char => char.charCodeAt(0)),
    );
  };
  const exact = candidates.filter(
    (item: { path: string }) => item.path.split('/').at(-2) === skill.name,
  );
  const preferred = exact.length === 1 ? exact[0] : undefined;
  const preferredContent = preferred ? await load(preferred) : undefined;
  let found =
    preferredContent !== undefined && scalar(preferredContent, 'name') === skill.name
      ? preferredContent
      : undefined;
  if (found === undefined) {
    if (candidates.length > 32) throw new Error('SKILLS_MARKDOWN_UNAVAILABLE');
    for (const candidate of candidates) {
      const content = candidate === preferred ? preferredContent! : await load(candidate);
      if (scalar(content, 'name') !== skill.name) continue;
      if (found !== undefined) throw new Error('SKILLS_MARKDOWN_UNAVAILABLE');
      found = content;
    }
  }
  if (found === undefined) throw new Error('SKILLS_MARKDOWN_UNAVAILABLE');
  signal?.throwIfAborted();
  if (previewCache.size >= 64) previewCache.delete(previewCache.keys().next().value!);
  previewCache.set(key, found);
  return found;
}

export const publicSkillCatalog: SkillCatalog = {
  managerId: 'skills',
  title: 'Skills',
  homeUrl: 'https://skills.sh',
  revision: 'public-skills',
  search,
  markdown,
};
