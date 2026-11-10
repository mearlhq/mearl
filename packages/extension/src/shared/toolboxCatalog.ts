import { parseToolboxCatalogs, type ToolboxCatalogConfigs } from '@mearl/preset';
import { INSTALLATION_SITE } from './installation';
import { parseToolboxIcon, type ToolboxPluginToolLocale } from '@mearl/browser-core';

export interface ToolboxInstallableTool {
  id: string;
  plugin: string;
  repository: string;
  skill: string;
  title: string;
  description: string;
  icon: string;
  locales?: Record<string, ToolboxPluginToolLocale>;
}

export const TOOLBOX_CATALOG_URL = new URL('toolbox.json', INSTALLATION_SITE).href;

export function toolboxSkillSource(repository: string): string {
  return repository === 'mearlhq/mearl' ? `https://github.com/${repository}` : repository;
}

export interface ToolboxCatalogSource {
  id: string;
  url: string;
  label: string;
}
export function toolboxCatalogSources(config?: ToolboxCatalogConfigs): ToolboxCatalogSource[] {
  const seen = new Set([TOOLBOX_CATALOG_URL]);
  const sources: ToolboxCatalogSource[] = [
    { id: 'official', url: TOOLBOX_CATALOG_URL, label: 'Mearl' },
  ];
  for (const [id, entry] of Object.entries(parseToolboxCatalogs(config))) {
    if (entry.enabled === false || !entry.url || seen.has(entry.url)) continue;
    seen.add(entry.url);
    sources.push({ id, url: entry.url, label: entry.label ?? id });
  }
  return sources;
}

function validRepository(value: string): boolean {
  if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) return false;
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:#[a-zA-Z0-9_./-]+)?$/.test(value))
    return true;
  if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+(?:#[a-zA-Z0-9_./-]+)?$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      !url.password &&
      !url.search &&
      ((url.protocol === 'https:' && !url.username) ||
        (url.protocol === 'ssh:' && (!url.username || url.username === 'git'))) &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate website metadata before rendering or caching the install list. */
export function parseToolboxCatalog(value: unknown): ToolboxInstallableTool[] {
  if (!isRecord(value) || !Array.isArray(value.tools) || value.tools.length > 256) {
    throw new Error('Invalid toolbox catalog');
  }
  const ids = new Set<string>();
  return value.tools.map(tool => {
    if (
      !isRecord(tool) ||
      typeof tool.plugin !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(tool.plugin) ||
      typeof tool.id !== 'string' ||
      tool.id !== `plugin:${tool.plugin}` ||
      ids.has(tool.id) ||
      typeof tool.repository !== 'string' ||
      !validRepository(tool.repository) ||
      typeof tool.skill !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(tool.skill) ||
      typeof tool.title !== 'string' ||
      !tool.title.trim() ||
      typeof tool.description !== 'string' ||
      typeof tool.icon !== 'string' ||
      !parseToolboxIcon(tool.icon)
    ) {
      throw new Error('Invalid toolbox catalog entry');
    }
    if (
      tool.locales !== undefined &&
      (!isRecord(tool.locales) ||
        Object.values(tool.locales).some(
          locale =>
            !isRecord(locale) ||
            (locale.title !== undefined && typeof locale.title !== 'string') ||
            (locale.description !== undefined && typeof locale.description !== 'string'),
        ))
    ) {
      throw new Error('Invalid toolbox catalog locales');
    }
    ids.add(tool.id);
    return {
      id: tool.id,
      plugin: tool.plugin,
      repository: tool.repository,
      skill: tool.skill,
      title: tool.title,
      description: tool.description,
      icon: tool.icon,
      ...(tool.locales ? { locales: tool.locales as Record<string, ToolboxPluginToolLocale> } : {}),
    };
  });
}

export async function fetchToolboxCatalog(
  fetchImpl: typeof fetch = fetch,
  url = TOOLBOX_CATALOG_URL,
  signal?: AbortSignal,
): Promise<ToolboxInstallableTool[]> {
  const response = await fetchImpl(url, {
    cache: 'no-cache',
    credentials: 'omit',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      : AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Toolbox catalog returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty toolbox catalog response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw new Error('Toolbox catalog exceeds 256 KiB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseToolboxCatalog(JSON.parse(new TextDecoder().decode(bytes)));
}
