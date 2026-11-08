import { FC, useEffect, useState, useMemo, useRef, useCallback, MouseEvent } from 'react';
import { EyeOff, X, Search, ArrowLeftRight, BrushCleaning } from 'lucide-react';
import { clsx } from 'clsx';
import { CapturedRequest, NavigationDivider, PinnedField } from '../types';
import { t } from '../utils/i18n';
import { useAutoScroll } from '../hooks/useAutoScroll';
import type { useRequestFilters } from '../hooks/useRequestFilters';
import { useFilterBarCollapsed } from '../hooks/useFilterBarCollapsed';
import { useListKeyNav } from '../hooks/useListKeyNav';
import { FilterBarToggleButton, CollapsibleFilterChips } from './header';
import { RequestListItem } from './RequestListItem';

export const RESOURCE_TYPE_COLORS: Record<string, string> = {
  protocol: 'bg-violet-500/20 text-violet-700 dark:text-violet-400',
  xhr: 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
  fetch: 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
  jsonp: 'bg-purple-500/20 text-purple-700 dark:text-purple-400',
  script: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  stylesheet: 'bg-sky-500/20 text-sky-700 dark:text-sky-400',
  document: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
  image: 'bg-rose-500/20 text-rose-700 dark:text-rose-400',
  font: 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  media: 'bg-pink-500/20 text-pink-700 dark:text-pink-400',
  websocket: 'bg-teal-500/20 text-teal-700 dark:text-teal-400',
  other: 'bg-gray-500/20 text-gray-600 dark:text-gray-400',
};

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  get protocol() { const label = t('requestProtocolLabel'); return label === 'requestProtocolLabel' ? 'Protocol' : label; },
  xhr: 'XHR',
  fetch: 'Fetch',
  jsonp: 'JSONP',
  script: 'JS',
  stylesheet: 'CSS',
  document: 'Doc',
  image: 'IMG',
  font: 'Font',
  media: 'Media',
  websocket: 'WS',
  other: 'Other',
};

interface RequestListProps {
  filters: ReturnType<typeof useRequestFilters>;
  requests: CapturedRequest[];
  /** 清空所有列表（搜索行内的清空按钮） */
  onClear: () => void;
  selectedRequestId: number | null;
  onSelectRequest: (id: number) => void;
  onHideApi: (apiName: string) => void;
  pinnedFieldsByRequestId: Map<number, PinnedField[]>;
  onUnpinField: (path: string, apiName: string, type: 'request' | 'response') => void;
  filterText: string;
  onFilterChange: (text: string) => void;
  /** 页面导航分隔记录（保留日志时标记页面跳转） */
  navigationDividers?: NavigationDivider[];
}

export const RequestList: FC<RequestListProps> = ({
  filters,
  requests,
  onClear,
  selectedRequestId,
  onSelectRequest,
  onHideApi,
  pinnedFieldsByRequestId,
  onUnpinField,
  filterText,
  onFilterChange,
  navigationDividers = [],
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; apiName: string } | null>(
    null,
  );
  const {
    availableTypes,
    selectedTypes,
    setSelectedTypes,
    availableNamespaces,
    selectedNamespaces,
    setSelectedNamespaces,
    displayedRequests,
  } = filters;
  const autoScrollRef = useAutoScroll(displayedRequests.length);
  const listRef = useRef<HTMLDivElement | null>(null);
  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      autoScrollRef(node);
    },
    [autoScrollRef],
  );

  const [filterBarCollapsed, toggleFilterBarCollapsed, filterBarReady] = useFilterBarCollapsed();

  const hasFilterChips = availableTypes.length > 0 || availableNamespaces.length > 1;

  type ListItem = CapturedRequest | NavigationDivider;
  const isDivider = (item: ListItem): item is NavigationDivider =>
    (item as NavigationDivider).type === 'navigation-divider';

  const mergedListItems = useMemo<ListItem[]>(() => {
    if (navigationDividers.length === 0) return displayedRequests;
    const items: ListItem[] = [...displayedRequests, ...navigationDividers];
    items.sort((a, b) => a.timestampMs - b.timestampMs);
    return items;
  }, [displayedRequests, navigationDividers]);

  const toggleType = (type: string) => {
    setSelectedTypes(
      selectedTypes.includes(type)
        ? selectedTypes.filter(selected => selected !== type)
        : [...selectedTypes, type],
    );
  };

  const toggleNamespace = (ns: string) => {
    setSelectedNamespaces(prev => (prev.includes(ns) ? prev.filter(s => s !== ns) : [...prev, ns]));
  };
  const handleKeyDown = useListKeyNav(
    displayedRequests,
    selectedRequestId,
    onSelectRequest,
    listRef,
  );

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleContextMenu = (e: MouseEvent, apiName: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, apiName });
  };

  return (
    <div className="@container relative w-full h-full bg-bg-list flex flex-col">
      {/* 过滤输入框 + 清空按钮同一行 */}
      <div className="border-b border-border bg-bg-primary">
        <div className="flex items-stretch">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-secondary" />
            <input
              type="text"
              value={filterText}
              onChange={e => onFilterChange(e.target.value)}
              placeholder={t('filterRequests')}
              className="w-full pl-7 pr-2 py-1.25 text-xxs leading-4 bg-bg-primary text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-blue-500"
            />
            {filterText && (
              <button
                onClick={() => onFilterChange('')}
                className={clsx(
                  'absolute top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary',
                  hasFilterChips ? 'right-6' : 'right-2',
                )}
              >
                <X className="w-3 h-3" />
              </button>
            )}
            {hasFilterChips && (
              <FilterBarToggleButton
                collapsed={filterBarCollapsed}
                onToggle={toggleFilterBarCollapsed}
              />
            )}
          </div>
          {/* 短竖线分隔，上下留白不贯通 */}
          <span className="w-px h-3.5 self-center bg-border" aria-hidden="true" />
          <button
            onClick={onClear}
            title={t('clearAllRequests')}
            className="shrink-0 self-center flex items-center ml-1 mr-1.5 p-1 rounded text-text-secondary transition-colors cursor-pointer hover:text-text-primary hover:bg-bg-hover"
          >
            <BrushCleaning className="w-3 h-3" />
          </button>
        </div>
        {hasFilterChips && (
          <CollapsibleFilterChips collapsed={filterBarCollapsed} ready={filterBarReady}>
            {availableTypes.length > 0 && (
              <div className="border-t border-border px-2 py-1 flex items-center gap-1 flex-wrap">
                {availableTypes.map(({ type, count }) => {
                  const isSelected = selectedTypes.includes(type);
                  const baseColor =
                    RESOURCE_TYPE_COLORS[type] ?? 'bg-gray-500/20 text-gray-600 dark:text-gray-400';
                  const label = RESOURCE_TYPE_LABELS[type] ?? type.toUpperCase();
                  return (
                    <button
                      key={type}
                      onClick={() => toggleType(type)}
                      aria-pressed={isSelected}
                      className={clsx(
                        'flex items-center gap-0.5 px-1.5 py-0.5 rounded text-2xs font-medium transition-colors',
                        isSelected
                          ? baseColor
                          : 'bg-bg-secondary text-text-secondary opacity-50 hover:opacity-75',
                      )}
                    >
                      {label}
                      <span className="opacity-75 ml-0.5">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {availableNamespaces.length > 1 && (
              <div
                className={clsx(
                  'py-1 flex items-center gap-1 flex-wrap',
                  availableTypes.length > 0
                    ? 'mx-2 w-fit max-w-full border-t border-border/50'
                    : 'px-2 border-t border-border',
                )}
              >
                {availableNamespaces.map(({ ns, count }) => {
                  const isActive = selectedNamespaces.includes(ns);
                  return (
                    <button
                      key={ns}
                      onClick={() => toggleNamespace(ns)}
                      title={ns}
                      aria-pressed={isActive}
                      className={clsx(
                        'flex items-center gap-0.5 px-1.5 py-0.5 rounded text-2xs font-medium transition-colors',
                        isActive
                          ? 'bg-violet-500/20 text-violet-700 dark:text-violet-400'
                          : selectedNamespaces.length === 0
                            ? 'bg-bg-secondary text-text-secondary hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400'
                            : 'bg-bg-secondary text-text-secondary opacity-50 hover:opacity-75',
                      )}
                    >
                      {ns}
                      <span className="opacity-75 ml-0.5">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </CollapsibleFilterChips>
        )}
      </div>

      {/* 空态：无原始请求（保留搜索栏）/ 过滤后为空 / 正常列表 */}
      {requests.length === 0 && !filterText ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 text-text-secondary pointer-events-none">
          <small className="text-xs">{t('requestsWillAppearHere')}</small>
        </div>
      ) : displayedRequests.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-text-secondary pointer-events-none">
          <div className="text-center text-xs">
            <small className="text-xs">{t('noMatchingRequests')}</small>
          </div>
        </div>
      ) : (
        <div
          ref={combinedRef}
          className="flex-1 overflow-y-auto outline-none"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {mergedListItems.map(item => {
            if (isDivider(item)) {
              return (
                <div
                  key={`nav-${item.id}`}
                  className="flex items-center gap-1.5 px-2 py-0.5 bg-yellow-500/5 border-b border-border"
                >
                  <ArrowLeftRight className="w-3 h-3 text-yellow-600 dark:text-yellow-400 shrink-0" />
                  <span
                    className="text-2xs text-yellow-600/70 dark:text-yellow-400/70 truncate"
                    title={item.url}
                  >
                    {item.url.replace(/^https?:\/\//, '')}
                  </span>
                </div>
              );
            }
            return (
              <RequestListItem
                key={item.id}
                req={item}
                isSelected={item.id === selectedRequestId}
                pinnedFields={pinnedFieldsByRequestId.get(item.id) || []}
                onSelect={() => onSelectRequest(item.id)}
                onContextMenu={e => handleContextMenu(e, item.apiName)}
                onUnpinField={onUnpinField}
              />
            );
          })}
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed shadow-lg rounded border border-border bg-bg-primary py-0.5 z-50"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onHideApi(contextMenu.apiName);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-xs flex items-center gap-1.5 transition-colors text-red-600 hover:bg-bg-hover"
          >
            <EyeOff size={14} />
            {t('blockApi')}
          </button>
        </div>
      )}
    </div>
  );
};
