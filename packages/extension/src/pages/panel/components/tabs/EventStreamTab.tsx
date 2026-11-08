import {
  FC,
  RefObject,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { clsx } from 'clsx';
import { CapturedRequest } from '../../types';
import { t } from '../../utils/i18n';
import { DetailSection } from '../detail/DetailSection';
import { SSEMessageItem } from '../detail/SSEMessageItem';
import { JsonViewer } from '../detail/JsonViewer';
import { FrameScrubber } from '../detail/FrameScrubber';
import { SearchBar } from '../detail/SearchBar';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { useSearchUI } from '../../hooks/useSearchUI';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { parseSseFrames, aggregateParsedFrames } from '../../utils/sseAggregate';
import { normalizeSseMessageData } from '../../utils/sseMessageData';
import { Radio, Zap, RefreshCw, ArrowRight, List, Layers } from 'lucide-react';

const STICKY_SEARCH_TOP_PX = 8;

interface EventStreamTabProps {
  request: CapturedRequest;
  collapsedSections: Record<string, boolean>;
  toggleSection: (id: string) => void;
  expandedPaths: Record<string, boolean>;
  onToggleExpand: (paths: Record<string, boolean>) => void;
  containerRef?: RefObject<HTMLDivElement | null>;
  onSwitchToResponse?: () => void;
  // 修改响应开启时，SSE 消息数据可编辑
  modificationEnabled?: boolean;
  onMessageDataChange?: (index: number, path: string[], newValue: any) => void;
  onResetOverride?: () => void;
}

export const EventStreamTab: FC<EventStreamTabProps> = ({
  request,
  collapsedSections,
  toggleSection,
  expandedPaths,
  onToggleExpand,
  containerRef,
  onSwitchToResponse,
  modificationEnabled = false,
  onMessageDataChange,
  onResetOverride,
}) => {
  const messageCount = request.sseMessages?.length || 0;

  // 修改响应生效时展示 override 后的数据（按消息下标覆盖），否则展示原始捕获数据
  const modifiedOverride = request.responseOverride?.modifiedData;
  const overrideData = Array.isArray(modifiedOverride) ? modifiedOverride : undefined;
  const effectiveMessages = useMemo(() => {
    if (!request.sseMessages) return undefined;
    return request.sseMessages.map((message, index) => {
      const data = overrideData?.[index] ?? message.data;
      const normalizedData = normalizeSseMessageData(data);
      return normalizedData === message.data ? message : { ...message, data: normalizedData };
    });
  }, [request.sseMessages, overrideData]);

  const canEdit = modificationEnabled && !!onMessageDataChange;

  // 视图模式：逐条 / 聚合成一个大对象（持久化到 chrome.storage.local，DevTools 关闭后仍保留）
  const [viewMode, setViewMode] = useLocalStorage<'list' | 'merged'>('sseViewMode', 'list');

  // 聚合帧数限制：null 表示全部（并随流式增长）；拖动「聚合自 N 帧」可回放式调整并实时渲染
  const [frameLimit, setFrameLimit] = useState<number | null>(null);
  useEffect(() => {
    setFrameLimit(null); // 切换请求时重置回放位置
  }, [request.id]);

  // 解析与合并拆开：解析只随消息变化做一次，拖动帧数时复用同一份解析结果
  const parsedFrames = useMemo(
    () => (viewMode === 'merged' ? parseSseFrames(effectiveMessages) : []),
    [viewMode, effectiveMessages],
  );
  const totalFrames = parsedFrames.length;
  const effectiveLimit = frameLimit == null ? totalFrames : Math.min(frameLimit, totalFrames);
  const aggregated = useMemo(
    () =>
      viewMode === 'merged' ? aggregateParsedFrames(parsedFrames.slice(0, effectiveLimit)) : null,
    [viewMode, parsedFrames, effectiveLimit],
  );
  // 拖到最右（>= 全部）回到「全部/实时」状态
  const handleFrameLimitChange = useCallback(
    (next: number) => setFrameLimit(next >= totalFrames ? null : next),
    [totalFrames],
  );

  // ===== EventStream 全局搜索（跨全部 SSE 消息） =====
  const localSearchContainerRef = useRef<HTMLDivElement>(null);
  const searchContainerRef = containerRef ?? localSearchContainerRef;
  const searchStickySentinelRef = useRef<HTMLDivElement>(null);
  const [isSearchFloating, setIsSearchFloating] = useState(false);
  // 关闭 Ctrl/Cmd+F 绑定，避免与单条消息内的搜索快捷键冲突
  const {
    searchQuery,
    inputValue,
    setInputValue,
    currentMatchIndex,
    matchNavigationVersion,
    totalMatches,
    setTotalMatches,
    searchInputRef,
    handleNextMatch,
    handlePrevMatch,
    handleClose,
  } = useSearchUI(searchContainerRef, {
    bindCtrlF: false,
    preserveCurrentOnMatchCountChange: true,
  });

  // 搜索期间保持当前结果位置，避免流式消息到达时自动滚动到底部。
  useAutoScroll(messageCount, {
    enabled: request.isPending && !inputValue,
    externalContainerRef: containerRef,
  });

  useLayoutEffect(() => {
    const scrollContainer = containerRef?.current;
    const sentinel = searchStickySentinelRef.current;
    if (!scrollContainer || !sentinel || messageCount === 0) {
      setIsSearchFloating(false);
      return;
    }

    const updateFloatingState = () => {
      const containerTop = scrollContainer.getBoundingClientRect().top;
      const sentinelTop = sentinel.getBoundingClientRect().top;
      const next = sentinelTop <= containerTop + STICKY_SEARCH_TOP_PX;
      setIsSearchFloating(current => (current === next ? current : next));
    };

    updateFloatingState();
    scrollContainer.addEventListener('scroll', updateFloatingState, { passive: true });
    window.addEventListener('resize', updateFloatingState);
    return () => {
      scrollContainer.removeEventListener('scroll', updateFloatingState);
      window.removeEventListener('resize', updateFloatingState);
    };
  }, [containerRef, messageCount, request.id]);

  // 每条消息按当前请求、视图和查询词上报匹配数，切换上下文时不会短暂复用旧结果。
  const searchContextKey = `${request.id}:${viewMode}:${searchQuery}`;
  const [matchReport, setMatchReport] = useState<{
    key: string;
    counts: Record<number, number>;
  }>({ key: '', counts: {} });
  const matchCounts = matchReport.key === searchContextKey ? matchReport.counts : {};
  const handleMatchesFound = useCallback(
    (index: number, count: number) => {
      setMatchReport(prev => {
        const counts = prev.key === searchContextKey ? prev.counts : {};
        if (counts[index] === count)
          return prev.key === searchContextKey ? prev : { key: searchContextKey, counts };
        return { key: searchContextKey, counts: { ...counts, [index]: count } };
      });
    },
    [searchContextKey],
  );

  // 汇总全局匹配总数，并按消息顺序把「全局当前项」映射到具体某条消息
  const { globalTotal, activeMsgIdx, localMatchIndex } = useMemo(() => {
    let total = 0;
    let active = -1;
    let local = -1;
    let acc = 0;
    for (let i = 0; i < messageCount; i++) {
      const c = matchCounts[i] || 0;
      if (c > 0 && active === -1 && currentMatchIndex >= acc && currentMatchIndex < acc + c) {
        active = i;
        local = currentMatchIndex - acc;
      }
      acc += c;
      total += c;
    }
    return { globalTotal: total, activeMsgIdx: active, localMatchIndex: local };
  }, [matchCounts, currentMatchIndex, messageCount]);

  // 将全局总数同步给搜索栏（useSearchUI 会据此重置当前项）
  useEffect(() => {
    setTotalMatches(globalTotal);
  }, [globalTotal, setTotalMatches]);

  // 首次输入搜索词时，若区块处于折叠态则自动展开以显示命中；用户后续手动折叠不再强制展开
  const prevQueryRef = useRef('');
  useEffect(() => {
    const hadQuery = prevQueryRef.current;
    prevQueryRef.current = searchQuery;
    if (!hadQuery && searchQuery && collapsedSections['sse-messages']) {
      toggleSection('sse-messages');
    }
  }, [searchQuery, collapsedSections, toggleSection]);

  const [sseEnabled, setSseEnabled] = useState(true);
  const [justEnabled, setJustEnabled] = useState(false);
  useEffect(() => {
    chrome.storage.sync.get(['sseMonitoringEnabled'], result => {
      setSseEnabled(result.sseMonitoringEnabled !== false);
    });
    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.sseMonitoringEnabled !== undefined) {
        setSseEnabled(changes.sseMonitoringEnabled.newValue !== false);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const handleToggleSse = () => {
    chrome.storage.sync.set({ sseMonitoringEnabled: true });
    setSseEnabled(true);
    setJustEnabled(true);
  };

  return (
    <div className="p-3 overflow-x-clip">
      {request.sseMessages && request.sseMessages.length > 0 ? (
        <div className="relative">
          <div ref={searchStickySentinelRef} className="h-0" data-sse-search-sentinel />
          <div className="sticky top-2 z-30 h-7 -mb-7 w-full min-w-0 flex items-center justify-end pointer-events-none">
            <div
              className={clsx(
                'w-40 max-w-[45%] min-w-0 pointer-events-auto transition-[background-color,box-shadow,padding] duration-150',
                isSearchFloating
                  ? 'p-1 rounded-md bg-bg-primary/95 backdrop-blur-sm shadow-md ring-1 ring-border'
                  : 'bg-transparent',
              )}
              data-sse-search-floating={isSearchFloating}
            >
              <SearchBar
                searchQuery={inputValue}
                currentMatchIndex={currentMatchIndex}
                totalMatches={totalMatches}
                onSearchChange={setInputValue}
                onPrevMatch={handlePrevMatch}
                onNextMatch={handleNextMatch}
                onClose={handleClose}
                searchInputRef={searchInputRef}
                inline={true}
                inputBgStyle="white"
                enablePicker
                placeholder={t('searchSseMessages')}
              />
            </div>
          </div>
          <DetailSection
            title={
              <div className="flex items-center gap-2">
                <span>{t('sseMessages')}</span>
                {/* 视图切换：逐条 / 聚合成一个大对象 */}
                <div className="flex items-center rounded overflow-hidden border border-border text-2xs leading-5">
                  <button
                    onClick={() => setViewMode('list')}
                    className={clsx(
                      'flex items-center gap-1 px-1.5 cursor-pointer transition-colors',
                      viewMode === 'list'
                        ? 'bg-blue-500 text-white'
                        : 'text-text-secondary hover:bg-bg-hover',
                    )}
                    title={t('sseViewByMessage')}
                  >
                    <List className="w-3 h-3" />
                    {t('sseViewByMessage')}
                  </button>
                  <button
                    onClick={() => setViewMode('merged')}
                    className={clsx(
                      'flex items-center gap-1 px-1.5 cursor-pointer transition-colors',
                      viewMode === 'merged'
                        ? 'bg-blue-500 text-white'
                        : 'text-text-secondary hover:bg-bg-hover',
                    )}
                    title={t('sseAggregatedTip')}
                  >
                    <Layers className="w-3 h-3" />
                    {t('sseViewAggregated')}
                  </button>
                </div>
                <span className="text-2xs leading-5 px-1.5 rounded bg-purple-500/20 text-purple-600 dark:text-purple-400">
                  {t('totalMessages')}: {request.sseMessages.length}
                </span>
              </div>
            }
            collapsed={!!collapsedSections['sse-messages']}
            action={
              <div className="flex items-center gap-1.5">
                {/* 修改响应已生效：重置按钮 */}
                {canEdit && request.responseOverride && onResetOverride && (
                  <button
                    onClick={onResetOverride}
                    className="px-1.5 text-2xs leading-5 rounded bg-red-500 text-white hover:opacity-80 cursor-pointer"
                    title={t('resetResponse')}
                  >
                    {t('resetResponse')}
                  </button>
                )}
                {request.isPending && (
                  <span className="px-1.5 text-2xs leading-5 rounded bg-green-500/20 text-green-600">
                    {t('streaming')}
                  </span>
                )}
                <span className="w-40 h-7 shrink-0" aria-hidden />
              </div>
            }
            onToggle={() => toggleSection('sse-messages')}
          >
            <div className="space-y-2 -mb-3">
              {viewMode === 'merged' && aggregated ? (
                <div className="p-3 text-xs bg-bg-list rounded">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2 text-2xs text-text-secondary">
                    <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-600 dark:text-purple-400 font-medium">
                      {aggregated.primaryEvent}
                    </span>
                    <span className="inline-flex items-center whitespace-nowrap">
                      {t('sseAggregatedFromPrefix')}
                      <FrameScrubber
                        value={effectiveLimit}
                        total={totalFrames}
                        onChange={handleFrameLimitChange}
                        title={t('sseDragToScrubFrames')}
                      />
                      {effectiveLimit < totalFrames && (
                        <span className="opacity-60">/{totalFrames}</span>
                      )}
                      {t('sseAggregatedFromSuffix')}
                    </span>
                    {aggregated.heartbeatFrames > 0 && (
                      <span>{t('sseHeartbeatSkipped', String(aggregated.heartbeatFrames))}</span>
                    )}
                    {aggregated.otherEvents.length > 0 && (
                      <span>
                        · {aggregated.otherEvents.length} {t('sseOtherEvents')}
                      </span>
                    )}
                  </div>
                  {aggregated.merged !== null ? (
                    <JsonViewer
                      json={aggregated.merged}
                      expandedPaths={expandedPaths}
                      onToggleExpand={onToggleExpand}
                      pathPrefix="sse-merged"
                      defaultExpandDepth={4}
                      externalSearchQuery={searchQuery}
                      externalCurrentMatchIndex={activeMsgIdx === 0 ? localMatchIndex : -1}
                      externalMatchNavigationVersion={matchNavigationVersion}
                      onExternalMatchesFound={count => handleMatchesFound(0, count)}
                    />
                  ) : (
                    <p className="text-text-secondary">{t('noSseMessages')}</p>
                  )}
                </div>
              ) : (
                (effectiveMessages ?? []).map((msg, idx) => (
                  <SSEMessageItem
                    key={`${idx}-${msg.timestamp || ''}`}
                    message={msg}
                    index={idx}
                    expandedPaths={expandedPaths}
                    onToggleExpand={onToggleExpand}
                    searchQuery={searchQuery}
                    currentMatchIndex={idx === activeMsgIdx ? localMatchIndex : -1}
                    matchNavigationVersion={matchNavigationVersion}
                    onMatchesFound={handleMatchesFound}
                    editable={canEdit}
                    onValueChange={onMessageDataChange}
                  />
                ))
              )}
            </div>
          </DetailSection>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 px-4 gap-4">
          {!sseEnabled ? (
            /* SSE 未开启 */
            <div className="w-full max-w-xs rounded-lg border border-border bg-bg-secondary p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-text-primary text-xs font-medium">
                <Radio className="w-3.5 h-3.5 text-text-secondary" />
                <span>{t('sseMonitoring')}</span>
                <span className="ml-auto px-1.5 py-0.5 rounded text-2xs bg-red-500/10 text-red-500">
                  {t('disabled')}
                </span>
              </div>
              <p className="text-xxs text-text-secondary leading-relaxed">
                {t('sseMonitoringDesc')}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleToggleSse}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xxs rounded-md bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                >
                  <Zap className="w-3 h-3" />
                  {t('enableSseMonitoring')}
                </button>
                {onSwitchToResponse && (
                  <button
                    onClick={onSwitchToResponse}
                    className="flex items-center gap-1 text-xxs text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {t('sseViewRawResponse')}
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ) : justEnabled && chrome.devtools?.inspectedWindow ? (
            /* 刚开启，提示刷新 */
            <div className="w-full max-w-xs rounded-lg border border-border bg-bg-secondary p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-text-primary text-xs font-medium">
                <Radio className="w-3.5 h-3.5 text-green-500" />
                <span>{t('sseMonitoring')}</span>
                <span className="ml-auto px-1.5 py-0.5 rounded text-2xs bg-green-500/10 text-green-600 dark:text-green-400">
                  {t('enabled')}
                </span>
              </div>
              <p className="text-xxs text-text-secondary leading-relaxed">
                {t('sseMonitoringDisabledHint')}
              </p>
              <button
                onClick={() => chrome.devtools.inspectedWindow.reload({})}
                className="flex items-center gap-1.5 self-start mt-1 px-3 py-1.5 text-xxs rounded-md border border-border hover:bg-bg-hover transition-colors text-text-primary"
              >
                <RefreshCw className="w-3 h-3" />
                {t('refresh')}
              </button>
            </div>
          ) : (
            /* SSE 开启，等待数据 */
            <p className="text-xs text-text-secondary">
              {request.isPending ? t('waitingForMessages') : t('noSseMessages')}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
