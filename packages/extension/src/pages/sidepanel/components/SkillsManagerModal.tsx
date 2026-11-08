import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpCircle,
  Blocks,
  Check,
  Download,
  ExternalLink,
  Loader2,
  PackageSearch,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AgentInstalledSkill,
  AgentInstalledSkillScope,
  AgentServiceRequest,
  AgentSkillInstalledListResult,
  AgentSkillProviderId,
  AgentSkillScope,
} from '@mearl/browser-core';
import { Modal, ModalContent, ModalHeader } from '../../panel/components/modal/Modal';
import { CodeEditor } from '../../panel/components/CodeEditor';
import { t } from '../../panel/utils/i18n';
import { resolveSkillCatalog, type SkillCatalog, type SkillSummary } from '../skillCatalog';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../shared/browserRequestUi';
import { requestNativeHost } from '../nativeHostRequest';
import { MarkdownContent } from './MarkdownContent';

type SkillsTab = 'browse' | 'installed';
type SkillDetailViewMode = 'preview' | 'code';
type AgentSkillMutationAction =
  | 'agent_skills_install'
  | 'agent_skills_update'
  | 'agent_skills_uninstall';

type SkillDetail =
  | { type: 'catalog'; skill: SkillSummary }
  | { type: 'installed'; skill: AgentInstalledSkill };

interface SkillsManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  providerId: AgentSkillProviderId;
  providerLabel?: string;
  cwd?: string;
}

function errorText(error: unknown, catalogTitle = 'Skills'): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SKILLS_LOGIN_REQUIRED') return t('agentSkillsLoginRequired', catalogTitle);
  if (message === 'SKILLS_MARKDOWN_UNAVAILABLE') {
    return t('agentSkillsMarkdownUnavailable');
  }
  if (message === 'SKILLS_INVALID_RESPONSE') return t('agentSkillsInvalidResponse', catalogTitle);
  if (message === 'SKILLS_RATE_LIMITED') return t('agentSkillsRateLimited');
  if (message === 'SKILLS_REQUEST_FAILED') return t('agentSkillsRequestFailed');
  if (message === 'SKILL_MANAGER_CHANGED') return t('agentSkillsManagerChanged');
  return message;
}

function skillKey(skill: Pick<AgentInstalledSkill, 'name' | 'scope'>): string {
  return `${skill.scope}:${skill.name}`;
}

function installedScopeText(scope: AgentInstalledSkillScope): string {
  switch (scope) {
    case 'global':
      return t('agentSkillsGlobal');
    case 'project':
      return t('agentSkillsProject');
    case 'system':
      return t('agentSkillsSystem');
    case 'admin':
      return t('agentSkillsAdmin');
    case 'built-in':
      return t('agentSkillsBuiltIn');
    default:
      return t('agentSkillsUnknownScope');
  }
}

function isManagedScope(scope: AgentInstalledSkillScope): scope is AgentSkillScope {
  return scope === 'global' || scope === 'project';
}

function hasAvailableUpdate(skill: AgentInstalledSkill, updates: ReadonlySet<string>): boolean {
  return isManagedScope(skill.scope) && updates.has(skillKey(skill));
}

function canViewInstalledSkill(skill: AgentInstalledSkill): boolean {
  return Boolean(skill.path && skill.path !== 'bundled');
}

function installsText(installs: number): string {
  if (installs >= 1000) return `${(installs / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(installs);
}

export function SkillsManagerModal({ isOpen, onClose, providerId, providerLabel, cwd }: SkillsManagerModalProps) {
  const contextKey = `${providerId}:${cwd || ''}`;
  const contextKeyRef = useRef(contextKey);
  const installedRequestIdRef = useRef(0);
  contextKeyRef.current = contextKey;

  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [tab, setTab] = useState<SkillsTab>('browse');
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [installedResult, setInstalledResult] = useState<AgentSkillInstalledListResult | null>(
    null,
  );
  const [installedLoading, setInstalledLoading] = useState(false);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [updates, setUpdates] = useState(new Set<string>());
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [scope, setScope] = useState<AgentSkillScope>(cwd ? 'project' : 'global');
  const [confirmingUninstallKey, setConfirmingUninstallKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailMarkdown, setDetailMarkdown] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailViewMode, setDetailViewMode] = useState<SkillDetailViewMode>('preview');

  useEffect(() => {
    if (!cwd && scope === 'project') setScope('global');
  }, [cwd, scope]);

  useEffect(() => {
    installedRequestIdRef.current += 1;
    setInstalledResult(null);
    setInstalledLoading(false);
    setInstalledError(null);
    setUpdates(new Set());
    setCheckingUpdates(false);
    setMutationKey(null);
    setMutationError(null);
    setConfirmingUninstallKey(null);
    setDetail(null);
    setDetailMarkdown('');
    setDetailLoading(false);
    setDetailError(null);
    setDetailViewMode('preview');
  }, [contextKey]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setSkills([]);
    setBrowseLoading(true);
    setBrowseError(null);
    setDetail(current => current?.type === 'catalog' ? null : current);
    void resolveSkillCatalog(controller.signal).then(result => {
      if (!controller.signal.aborted) setCatalog(result);
    }).catch(error => {
      if (!controller.signal.aborted) { setBrowseError(errorText(error)); setBrowseLoading(false); }
    });
    const changed = (message: any) => {
      if (message?.action === BROWSER_REQUEST_UI_CHANGED) {
        controller.abort(); setCatalogEpoch(current => current + 1);
      }
    };
    chrome.runtime.onMessage.addListener(changed);
    return () => { controller.abort(); chrome.runtime.onMessage.removeListener(changed); };
  }, [catalogEpoch]);

  useEffect(() => {
    if (!isOpen || !catalog) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        setBrowseLoading(true);
        setBrowseError(null);
        catalog.search(query, controller.signal)
          .then(result => { if (!controller.signal.aborted) setSkills(result.skills); })
          .catch(error => {
            if (!controller.signal.aborted) setBrowseError(errorText(error, catalog.title));
          })
          .finally(() => {
            if (!controller.signal.aborted) setBrowseLoading(false);
          });
      },
      query.trim() ? 300 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [catalog, isOpen, query]);

  const detailCatalog = detail?.type === 'catalog' ? catalog : null;
  useEffect(() => {
    if (!isOpen || !detail || detail.type === 'catalog' && !catalog) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setDetailMarkdown('');
    const request =
      detail.type === 'catalog'
        ? detailCatalog!.markdown(detail.skill, controller.signal)
        : requestNativeHost('agent_skills_read', {
            providerId,
            path: detail.skill.path,
            ...(cwd ? { cwd } : {}),
          }).then(result => result.content);
    request
      .then(markdown => {
        if (!controller.signal.aborted) setDetailMarkdown(markdown);
      })
      .catch(error => {
        if (!controller.signal.aborted) setDetailError(errorText(error, detailCatalog?.title));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [detailCatalog, cwd, detail, isOpen, providerId]);

  const loadInstalled = useCallback(async () => {
    const requestContext = contextKey;
    if (contextKeyRef.current !== requestContext) return;
    const requestId = ++installedRequestIdRef.current;
    setInstalledLoading(true);
    setInstalledError(null);
    try {
      const result = await requestNativeHost('agent_skills_installed', {
        providerId,
        ...(cwd ? { cwd } : {}),
      });
      if (installedRequestIdRef.current !== requestId || contextKeyRef.current !== requestContext) {
        return;
      }
      setInstalledResult(result);
    } catch (error) {
      if (installedRequestIdRef.current !== requestId || contextKeyRef.current !== requestContext) {
        return;
      }
      setInstalledError(errorText(error));
    } finally {
      if (installedRequestIdRef.current === requestId && contextKeyRef.current === requestContext) {
        setInstalledLoading(false);
      }
    }
  }, [contextKey, cwd, providerId]);

  useEffect(() => {
    if (!isOpen) {
      installedRequestIdRef.current += 1;
      setInstalledLoading(false);
      return;
    }
    void loadInstalled();
    return () => {
      installedRequestIdRef.current += 1;
    };
  }, [isOpen, loadInstalled]);

  const installedKeys = useMemo(
    () => new Set((installedResult?.skills || []).map(skillKey)),
    [installedResult],
  );
  const orderedInstalledSkills = useMemo(() => {
    const installedSkills = installedResult?.skills || [];
    if (updates.size === 0) return installedSkills;
    return [...installedSkills].sort(
      (left, right) =>
        Number(hasAvailableUpdate(right, updates)) - Number(hasAvailableUpdate(left, updates)),
    );
  }, [installedResult, updates]);

  const mutate = useCallback(
    async <A extends AgentSkillMutationAction>(
      key: string,
      affectedSkillKey: string,
      action: A,
      data: AgentServiceRequest<A>,
    ) => {
      const mutationContext = contextKey;
      setMutationKey(key);
      setMutationError(null);
      try {
        await requestNativeHost(action, data);
        if (contextKeyRef.current !== mutationContext) return;
        setUpdates(current => {
          if (!current.has(affectedSkillKey)) return current;
          const next = new Set(current);
          next.delete(affectedSkillKey);
          return next;
        });
        await loadInstalled();
      } catch (error) {
        if (contextKeyRef.current === mutationContext) {
          setMutationError(errorText(error));
          if (error instanceof Error && error.message === 'SKILL_MANAGER_CHANGED') setCatalogEpoch(current => current + 1);
        }
      } finally {
        if (contextKeyRef.current === mutationContext) setMutationKey(null);
      }
    },
    [contextKey, loadInstalled],
  );

  const install = useCallback(
    (skill: SkillSummary) =>
      catalog ? mutate(`install:${scope}:${skill.name}`, `${scope}:${skill.name}`, 'agent_skills_install', {
        providerId,
        source: skill.installSource ?? skill.source,
        expectedManagerId: catalog.managerId,
        name: skill.name,
        scope,
        ...(cwd ? { cwd } : {}),
      }) : Promise.resolve(),
    [catalog, cwd, mutate, providerId, scope],
  );

  const update = useCallback(
    (skill: AgentInstalledSkill) => {
      if (!isManagedScope(skill.scope)) return Promise.resolve();
      const key = skillKey(skill);
      return mutate(`update:${key}`, key, 'agent_skills_update', {
        providerId,
        name: skill.name,
        scope: skill.scope,
        ...(cwd ? { cwd } : {}),
      });
    },
    [cwd, mutate, providerId],
  );

  const uninstall = useCallback(
    async (skill: AgentInstalledSkill) => {
      if (!isManagedScope(skill.scope)) return;
      const key = skillKey(skill);
      await mutate(`uninstall:${key}`, key, 'agent_skills_uninstall', {
        providerId,
        name: skill.name,
        scope: skill.scope,
        ...(cwd ? { cwd } : {}),
      });
      setConfirmingUninstallKey(current => (current === key ? null : current));
    },
    [cwd, mutate, providerId],
  );

  const checkUpdates = useCallback(async () => {
    const requestContext = contextKey;
    setCheckingUpdates(true);
    setMutationError(null);
    try {
      const result = await requestNativeHost('agent_skills_check_updates', {
        providerId,
        ...(cwd ? { cwd } : {}),
      });
      if (contextKeyRef.current === requestContext) {
        setUpdates(new Set(result.updates.map(skillKey)));
      }
    } catch (error) {
      if (contextKeyRef.current === requestContext) setMutationError(errorText(error));
    } finally {
      if (contextKeyRef.current === requestContext) setCheckingUpdates(false);
    }
  }, [contextKey, cwd, providerId]);

  const headerActions = catalog ? (
    <a
      href={catalog.homeUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-3xs text-text-secondary hover:text-text-primary"
    >
      {catalog.title}
      <ExternalLink className="w-3 h-3" />
    </a>
  ) : null;

  const detailModeButtonClass = (mode: SkillDetailViewMode) =>
    `px-1.5 py-0.5 text-2xs transition-colors cursor-pointer ${
      detailViewMode === mode
        ? 'bg-blue-500 text-white'
        : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
    }`;

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalHeader
        title={t('agentSkillsTitle', providerLabel || providerId)}
        onClose={onClose}
        actions={headerActions}
      />
      <ModalContent>
        {detail ? (
          <div className="min-h-0 flex-1 flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <button
                onClick={() => setDetail(null)}
                className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                title={t('agentSkillsBack')}
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{detail.skill.name}</div>
                <div className="text-3xs text-text-secondary truncate">
                  {detail.type === 'catalog' ? detail.skill.source : detail.skill.path}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex items-center overflow-hidden rounded border border-border bg-bg-secondary">
                  <button
                    onClick={() => setDetailViewMode('preview')}
                    className={detailModeButtonClass('preview')}
                    title={t('agentSkillsPreview')}
                  >
                    {t('agentSkillsPreview')}
                  </button>
                  <button
                    onClick={() => setDetailViewMode('code')}
                    className={detailModeButtonClass('code')}
                    title={t('jsonViewModeCode')}
                  >
                    {t('jsonViewModeCode')}
                  </button>
                </div>
                {detail.type === 'catalog' ? (
                  <a
                    href={detail.skill.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                  >
                    {t('agentSkillsOpenPage', catalog?.title ?? 'Skills')}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                ) : null}
              </div>
            </div>
            {detailLoading ? (
              <div className="flex-1 flex items-center justify-center text-text-secondary">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : detailError ? (
              <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-500">
                {detailError}
              </div>
            ) : detailViewMode === 'preview' ? (
              <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-bg-primary p-3 text-xs leading-5 text-text-primary">
                <MarkdownContent>{detailMarkdown}</MarkdownContent>
              </div>
            ) : (
              <CodeEditor
                code={detailMarkdown}
                language="markdown"
                className="min-h-0 flex-1 bg-bg-primary"
              />
            )}
          </div>
        ) : (
          <div className="@container min-h-0 flex-1 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex rounded border border-border bg-bg-primary p-0.5">
                <button
                  onClick={() => setTab('browse')}
                  className={`px-2.5 py-1 rounded text-xs cursor-pointer ${
                    tab === 'browse'
                      ? 'bg-blue-600 text-white'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  {t('agentSkillsBrowse')}
                </button>
                <button
                  onClick={() => setTab('installed')}
                  className={`px-2.5 py-1 rounded text-xs cursor-pointer ${
                    tab === 'installed'
                      ? 'bg-blue-600 text-white'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  {t('agentSkillsInstalled')}
                  {installedResult ? ` (${installedResult.skills.length})` : ''}
                </button>
              </div>
              {tab === 'browse' ? (
                <label className="flex items-center gap-1 text-xs text-text-secondary">
                  {t('agentSkillsInstallTo')}
                  <select
                    value={scope}
                    onChange={event => setScope(event.target.value as AgentSkillScope)}
                    className="h-7 rounded border border-border bg-bg-primary px-1.5 text-xs text-text-primary outline-none focus:border-blue-500"
                  >
                    <option value="global">{t('agentSkillsGlobal')}</option>
                    <option value="project" disabled={!cwd}>
                      {t('agentSkillsProject')}
                    </option>
                  </select>
                </label>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void checkUpdates()}
                    disabled={checkingUpdates || mutationKey !== null}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {checkingUpdates ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <PackageSearch className="w-3 h-3" />
                    )}
                    {t('agentSkillsCheckUpdates')}
                  </button>
                  <button
                    onClick={() => void loadInstalled()}
                    disabled={installedLoading}
                    className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer disabled:opacity-40"
                    title={t('agentSkillsRefresh')}
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${installedLoading ? 'animate-spin' : ''}`}
                    />
                  </button>
                </div>
              )}
            </div>

            {mutationError ? (
              <div className="rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-xs text-red-500">
                {mutationError}
              </div>
            ) : null}

            {tab === 'browse' ? (
              <>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 w-3.5 h-3.5 -translate-y-1/2 text-text-secondary" />
                  <input
                    value={query}
                    onChange={event => {
                      setQuery(event.target.value);
                      if (!catalog && !browseLoading) setCatalogEpoch(current => current + 1);
                    }}
                    placeholder={t('agentSkillsSearchPlaceholder')}
                    className="h-8 w-full rounded border border-border bg-bg-primary pl-7 pr-2 text-xs text-text-primary outline-none placeholder:text-text-secondary focus:border-blue-500"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {browseLoading ? (
                    <div className="h-full flex items-center justify-center text-text-secondary">
                      <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                  ) : browseError ? (
                    <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-500">
                      {browseError}
                    </div>
                  ) : skills.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-xs text-text-secondary">
                      {t('agentSkillsNoResults')}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 @[620px]:grid-cols-2">
                      {skills.map(skill => {
                        const key = `install:${scope}:${skill.name}`;
                        const installed = installedKeys.has(`${scope}:${skill.name}`);
                        return (
                          <div
                            key={`${skill.source}:${skill.name}`}
                            className="flex flex-col gap-2 rounded border border-border bg-bg-primary p-2"
                          >
                            <button
                              onClick={() => setDetail({ type: 'catalog', skill })}
                              className="min-w-0 text-left cursor-pointer"
                            >
                              <div className="flex items-center gap-1.5">
                                <Blocks className="w-4 h-4 shrink-0 text-blue-600" />
                                <span className="truncate text-sm font-medium hover:text-blue-600">
                                  {skill.name}
                                </span>
                              </div>
                              <div className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-text-secondary">
                                {skill.description || t('agentSkillsNoDescription')}
                              </div>
                            </button>
                            <div className="flex flex-wrap gap-1">
                              {skill.tags.slice(0, 3).map(tag => (
                                <span
                                  key={tag}
                                  className="rounded bg-bg-secondary px-1.5 py-0.5 text-3xs text-text-secondary"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                            <div className="mt-auto flex items-center justify-between gap-2 text-3xs text-text-secondary">
                              <span>
                                {t('agentSkillsInstalls', installsText(skill.installs))}
                                {skill.authorName ? ` · ${skill.authorName}` : ''}
                              </span>
                              <button
                                onClick={() => void install(skill)}
                                disabled={installed || checkingUpdates || mutationKey !== null}
                                className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {mutationKey === key ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Download className="w-3 h-3" />
                                )}
                                {installed ? t('agentSkillsInstalled') : t('agentSkillsInstall')}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                {installedLoading && !installedResult ? (
                  <div className="h-full flex items-center justify-center text-text-secondary">
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                ) : installedError ? (
                  <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-500">
                    {installedError}
                  </div>
                ) : !installedResult?.skills.length ? (
                  <div className="h-full flex items-center justify-center text-xs text-text-secondary">
                    {t('agentSkillsNoneInstalled')}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {orderedInstalledSkills.map(skill => {
                      const key = skillKey(skill);
                      const updating = mutationKey === `update:${key}`;
                      const uninstalling = mutationKey === `uninstall:${key}`;
                      const managed = isManagedScope(skill.scope);
                      const hasUpdate = hasAvailableUpdate(skill, updates);
                      const viewable = canViewInstalledSkill(skill);
                      return (
                        <div
                          key={`${key}:${skill.path}`}
                          className="flex items-center gap-2 rounded border border-border bg-bg-primary p-2"
                        >
                          <button
                            onClick={() => setDetail({ type: 'installed', skill })}
                            disabled={!viewable}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer disabled:cursor-default"
                          >
                            <Blocks className="w-4 h-4 shrink-0 text-blue-600" />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span
                                  className="min-w-0 truncate text-sm font-medium"
                                  title={skill.name}
                                >
                                  {skill.name}
                                </span>
                                <span className="shrink-0 whitespace-nowrap rounded bg-bg-secondary px-1.5 py-0.5 text-3xs text-text-secondary">
                                  {installedScopeText(skill.scope)}
                                </span>
                                {hasUpdate ? (
                                  <span className="shrink-0 whitespace-nowrap rounded bg-blue-500/10 px-1.5 py-0.5 text-3xs text-blue-600">
                                    {t('agentSkillsUpdateAvailable')}
                                  </span>
                                ) : null}
                              </div>
                              <div
                                className="truncate text-3xs text-text-secondary"
                                title={skill.path}
                              >
                                {skill.path}
                              </div>
                            </div>
                          </button>
                          {hasUpdate ? (
                            <button
                              onClick={() => void update(skill)}
                              disabled={checkingUpdates || mutationKey !== null}
                              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer disabled:opacity-40"
                            >
                              {updating ? (
                                <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
                              ) : (
                                <ArrowUpCircle className="w-3 h-3 shrink-0" />
                              )}
                              {t('agentSkillsUpdate')}
                            </button>
                          ) : null}
                          {managed ? (
                            confirmingUninstallKey === key || uninstalling ? (
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  onClick={() => void uninstall(skill)}
                                  disabled={checkingUpdates || mutationKey !== null}
                                  className="p-1 rounded text-red-500 hover:bg-bg-hover cursor-pointer disabled:opacity-40"
                                >
                                  {uninstalling ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Check className="w-3.5 h-3.5" />
                                  )}
                                </button>
                                <button
                                  onClick={() => setConfirmingUninstallKey(null)}
                                  disabled={uninstalling}
                                  className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer disabled:opacity-40"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setConfirmingUninstallKey(key)}
                                disabled={checkingUpdates || mutationKey !== null}
                                className="shrink-0 p-1.5 rounded text-text-secondary hover:text-red-500 hover:bg-bg-hover cursor-pointer disabled:opacity-40"
                                title={t('agentSkillsUninstall')}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}
