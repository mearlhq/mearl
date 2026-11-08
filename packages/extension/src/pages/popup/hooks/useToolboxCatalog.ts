import { useCallback, useEffect, useState } from 'react';
import { fetchToolboxCatalog, parseToolboxCatalog, toolboxCatalogSources, type ToolboxInstallableTool, type ToolboxCatalogSource } from '../../../shared/toolboxCatalog';
import { storageGetSafely, storageSetSafely } from '../../panel/utils/safeChrome';
import { useBrowserUiSettings } from '../../panel/utils/browserUiSettings';

export const TOOLBOX_CATALOG_CACHE_KEY = 'mearl-toolbox-catalog-cache';
export const toolboxCatalogCacheKey = (url: string) => `${TOOLBOX_CATALOG_CACHE_KEY}:${url}`;
interface DirectoryState { tools: ToolboxInstallableTool[] | null; loading: boolean; failed: boolean }
export interface ToolboxCatalogIssue { source: ToolboxCatalogSource; reason: 'unavailable' | 'conflict'; plugin?: string; usingCache?: boolean }

export function useToolboxCatalog(enabled: boolean) {
  const settings = useBrowserUiSettings();
  const sourceKey = JSON.stringify(toolboxCatalogSources(settings.toolCatalogs));
  const sources: ToolboxCatalogSource[] = JSON.parse(sourceKey);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const selected: ToolboxCatalogSource[] = JSON.parse(sourceKey);
    const controller = new AbortController();
    let cancelled = false;
    setDirectories(current => Object.fromEntries(selected.map(source => [source.url, { tools: current[source.url]?.tools ?? null, loading: true, failed: false }])));
    for (const source of selected) {
      let remoteLoaded = false;
      let cacheLoaded = false;
      const key = toolboxCatalogCacheKey(source.url);
      void storageGetSafely<unknown>([key]).then(result => {
        const cached = result?.[key];
        if (cancelled || remoteLoaded || !cached) return;
        const tools = parseToolboxCatalog(cached);
        setDirectories(current => ({ ...current, [source.url]: { ...current[source.url], tools: current[source.url]?.tools ?? tools } }));
      }).catch(() => {}).finally(() => {
        cacheLoaded = true;
        if (!cancelled && !remoteLoaded) setDirectories(current => ({ ...current, [source.url]: { ...current[source.url], loading: !current[source.url]?.failed } }));
      });
      void fetchToolboxCatalog(fetch, source.url, controller.signal).then(tools => {
        if (cancelled) return;
        remoteLoaded = true;
        setDirectories(current => ({ ...current, [source.url]: { tools, loading: false, failed: false } }));
        void storageSetSafely({ [key]: { tools } }).catch(() => {});
      }).catch(() => {
        if (!cancelled) setDirectories(current => ({ ...current, [source.url]: { tools: current[source.url]?.tools ?? null, loading: !cacheLoaded, failed: true } }));
      });
    }
    return () => { cancelled = true; controller.abort(); };
  }, [enabled, sourceKey, revision]);

  const tools: ToolboxInstallableTool[] = [];
  const issues: ToolboxCatalogIssue[] = [];
  const installedSources = new Map<string, ToolboxInstallableTool>();
  const groups = sources.map((source, sourceIndex) => {
    const directory = directories[source.url];
    if (directory?.failed) issues.push({ source, reason: 'unavailable', usingCache: Boolean(directory.tools?.length) });
    const entries = (directory?.tools ?? []).filter(tool => {
      const existing = installedSources.get(tool.id);
      if (existing) {
        if (existing.repository !== tool.repository || existing.skill !== tool.skill) issues.push({ source, reason: 'conflict', plugin: tool.plugin });
        return false;
      }
      installedSources.set(tool.id, tool);
      tools.push(tool);
      return true;
    });
    return { source, tools: entries, pendingPriority: sources.slice(0, sourceIndex).some(prior => !directories[prior.url] || directories[prior.url].loading) };
  });
  return {
    tools: sources.some(source => directories[source.url]?.tools !== null && directories[source.url]?.tools !== undefined) ? tools : null,
    groups, issues,
    loading: enabled && sources.some(source => !directories[source.url] || directories[source.url].loading),
    failed: issues.some(issue => issue.reason === 'unavailable'),
    retry,
  };
}
