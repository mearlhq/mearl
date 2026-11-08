import { callBrowserUiOperationResult, type BrowserUiProvider } from '../panel/utils/browserUiSettings';
import { browserUiUrl } from '../../shared/browserUiSettings';
import { publicSkillCatalog } from './publicSkillCatalog';

export interface SkillSummary {
  id: string;
  name: string;
  source: string;
  sourceType: string;
  description: string;
  installs: number;
  tags: string[];
  collectionIds: string[];
  files: string[];
  pageUrl: string;
  installSource?: string;
  latestVersionHash?: string;
  latestVersionAt?: string;
  authorName?: string;
  authorAvatar?: string;
}
export interface SkillCatalog {
  managerId: string;
  title: string;
  homeUrl: string;
  revision: string;
  search(query: string, signal?: AbortSignal): Promise<{ skills: SkillSummary[] }>;
  markdown(skill: SkillSummary, signal?: AbortSignal): Promise<string>;
}

function normalizeSkills(input: unknown): { skills: SkillSummary[] } {
  const skills = (input as { skills?: unknown[] })?.skills;
  if (!Array.isArray(skills) || skills.length > 50) throw new Error('SKILLS_INVALID_RESPONSE');
  return { skills: skills.map(value => {
    const skill = value as SkillSummary;
    if (!skill || typeof skill.id !== 'string' || typeof skill.name !== 'string' || !skill.name || typeof skill.source !== 'string' || !skill.source || typeof skill.sourceType !== 'string' || typeof skill.description !== 'string' || !Number.isFinite(skill.installs) || ['tags', 'collectionIds', 'files'].some(key => !Array.isArray(skill[key as keyof SkillSummary]) || !(skill[key as keyof SkillSummary] as unknown[]).every(item => typeof item === 'string')) || skill.installSource !== undefined && typeof skill.installSource !== 'string') throw new Error('SKILLS_INVALID_RESPONSE');
    return { ...skill, pageUrl: browserUiUrl(skill.pageUrl) };
  }) };
}

/** The description pins the same provider and config for search and preview. */
export async function resolveSkillCatalog(signal?: AbortSignal): Promise<SkillCatalog> {
  let response: { data: any; provider: BrowserUiProvider };
  try {
    response = await callBrowserUiOperationResult('skills.catalog', { operation: 'describe' }, { signal });
  } catch (error) {
    if (error instanceof Error && error.message === 'CAPABILITY_NOT_INSTALLED') return publicSkillCatalog;
    throw error;
  }
  if (response.data?.available === false) return publicSkillCatalog;
  const { managerId, title, homeUrl } = response.data ?? {};
  if (response.data?.available !== true || typeof managerId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(managerId) || typeof title !== 'string' || !title || title.length > 128) throw new Error('SKILLS_INVALID_RESPONSE');
  const { provider } = response;
  const invoke = async (input: unknown, signal?: AbortSignal) => (await callBrowserUiOperationResult('skills.catalog', input, { provider, signal })).data;
  return {
    managerId, title, homeUrl: browserUiUrl(homeUrl), revision: JSON.stringify(provider),
    search: async (query, signal) => normalizeSkills(await invoke({ operation: 'search', query, limit: 50 }, signal)),
    markdown: async (skill, signal) => {
      const result = await invoke({ operation: 'markdown', skill }, signal);
      if (typeof result !== 'string') throw new Error('SKILLS_MARKDOWN_UNAVAILABLE');
      return result;
    },
  };
}
