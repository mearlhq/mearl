import { FC, useMemo, useRef } from 'react';
import { Search, X, ArrowLeftRight, BrushCleaning } from 'lucide-react';
import { clsx } from 'clsx';
import { NavigationDivider, PinnedEventField, RumEvent } from '../types';
import { t } from '../utils/i18n';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useFilterBarCollapsed } from '../hooks/useFilterBarCollapsed';
import { useListKeyNav } from '../hooks/useListKeyNav';
import { FilterBarToggleButton, CollapsibleFilterChips } from './header';
import { ValueDisplay } from './ValueDisplay';
import { shortenFieldPath } from '../utils/helpers';

const API_COLOR = 'bg-rose-500/20 text-rose-700 dark:text-rose-400';

// 事件类型 → 颜色映射
const EVENT_TYPE_COLORS: Record<string, string> = {
  resource: 'bg-blue-500/20 text-blue-700 dark:text-blue-400',
  assets: 'bg-teal-500/20 text-teal-700 dark:text-teal-400',
  api: API_COLOR,
  view: 'bg-purple-500/20 text-purple-700 dark:text-purple-400',
  error: 'bg-red-500/20 text-red-600',
  action: 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
  custom: 'bg-teal-500/20 text-teal-700 dark:text-teal-400',
  // aplus 事件类型（颜色与 content-script 中的高亮叠加层保持一致）
  EXP: 'bg-green-500/20 text-green-700 dark:text-green-400',
  CLK: 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
  PV: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
  SDF: 'bg-teal-500/20 text-teal-700 dark:text-teal-400',
  // arms 事件类型
  pv: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
  perf: 'bg-violet-500/20 text-violet-700 dark:text-violet-400',
  health: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400',
  UNKNOWN: 'bg-gray-500/20 text-gray-600 dark:text-gray-400',
};

const SUB_TYPE_COLORS: Record<string, string> = {
  js: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  css: 'bg-sky-500/20 text-sky-700 dark:text-sky-400',
  image: 'bg-green-500/20 text-green-700 dark:text-green-400',
  xhr: 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
  fetch: 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
  api: API_COLOR,
  perf: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
  pv: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
  fsp: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
};

const SOURCE_COLORS: Record<string, string> = {
  rum: 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-400',
  aplus: 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  arms: 'bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-400',
};

export function getEventLabel(ev: RumEvent): string {
  const raw = ev.name || ev.url;
  const isAplus = ev.source === 'aplus';
  // i18n-tracker 转换后的 rum EXP/CLK 事件也使用 aplus 风格的 label 展示
  const isAplusLike = isAplus || (ev.source === 'rum' && ['EXP', 'CLK'].includes(ev.event_type));
  if (raw) {
    try {
      if (raw.startsWith('http')) {
        const pathname = new URL(raw).pathname;
        const parts = pathname.split('/').filter(Boolean);
        return parts.slice(-3).join('/') || raw;
      }
      // SPM 字符串（用点分隔，如 181.29022011.foo.bar-item）
      // aplus 只取最后两段，rum 取最后三段
      if (raw.includes('.') && !raw.startsWith('/') && !raw.includes('/')) {
        const parts = raw.split('.');
        return parts.slice(isAplusLike ? -2 : -3).join('.') || raw;
      }
      const parts = raw.split('/').filter(Boolean);
      return parts.slice(-3).join('/') || raw;
    } catch {
      return raw;
    }
  }
  return ev.event_type;
}

interface RumEventListProps {
  events: RumEvent[];
  totalEventCount: number;
  /** 清空所有列表（搜索行内的清空按钮） */
  onClear: () => void;
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
  filterText: string;
  onFilterChange: (text: string) => void;
  availableTypes: { type: string; count: number }[];
  selectedTypes: string[];
  onToggleType: (type: string) => void;
  onSetTypes: (types: string[]) => void;
  navigationDividers?: NavigationDivider[];
  pinnedEventFieldsByEventId?: Map<string, PinnedEventField[]>;
  onUnpinEventField?: (path: string, eventSubType: string) => void;
}

export const EventList: FC<RumEventListProps> = ({
  events,
  totalEventCount,
  onClear,
  selectedEventId,
  onSelectEvent,
  filterText,
  onFilterChange,
  availableTypes,
  selectedTypes,
  onToggleType,
  onSetTypes,
  navigationDividers = [],
  pinnedEventFieldsByEventId,
  onUnpinEventField,
}) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useAutoScroll(events.length);
  const [filterBarCollapsed, toggleFilterBarCollapsed, filterBarReady] = useFilterBarCollapsed();
  const hasFilterChips = availableTypes.length > 0;
  const handleKeyDown = useListKeyNav(events, selectedEventId, onSelectEvent, listRef);

  type EventListItem = RumEvent | NavigationDivider;
  const isDivider = (item: EventListItem): item is NavigationDivider =>
    (item as NavigationDivider).type === 'navigation-divider';

  const mergedListItems = useMemo<EventListItem[]>(() => {
    if (navigationDividers.length === 0) return events;
    const items: EventListItem[] = [...events, ...navigationDividers];
    items.sort((a, b) => {
      const tsA = isDivider(a) ? a.timestampMs : a.batchTimestampMs;
      const tsB = isDivider(b) ? b.timestampMs : b.batchTimestampMs;
      return tsA - tsB;
    });
    return items;
  }, [events, navigationDividers]);

  return (
    <div className="relative w-full h-full bg-bg-list flex flex-col">
      {/* 过滤输入框 + 清空按钮同一行 */}
      <div className="border-b border-border bg-bg-primary">
        <div className="flex items-stretch">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-secondary" />
            <input
              type="text"
              value={filterText}
              onChange={e => onFilterChange(e.target.value)}
              placeholder={t('rumFilterEvents')}
              className="w-full pl-7 pr-2 py-1.25 text-xxs leading-4 bg-bg-primary text-text-primary placeholder:text-text-secondary focus:outline-none"
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
        {availableTypes.length > 0 &&
          (() => {
            // key 格式: "${source}/${eventTypeKey}"，按 source 分组渲染为独立行
            const groups = new Map<string, typeof availableTypes>();
            availableTypes.forEach(item => {
              const slashIdx = item.type.indexOf('/');
              const source = slashIdx >= 0 ? item.type.slice(0, slashIdx) : 'unknown';
              if (!groups.has(source)) groups.set(source, []);
              groups.get(source)!.push(item);
            });

            return (
              <CollapsibleFilterChips collapsed={filterBarCollapsed} ready={filterBarReady}>
                <div className="border-t border-border px-2 pt-1 pb-0.5 flex flex-col gap-0.5">
                  {Array.from(groups.entries()).map(([source, items]) => {
                    const sourceTypes = items.map(i => i.type);
                    const anySelected = sourceTypes.some(t => selectedTypes.includes(t));
                    const allSelected = sourceTypes.every(t => selectedTypes.includes(t));
                    const handleSourceClick = () => {
                      if (allSelected) {
                        onSetTypes(selectedTypes.filter(t => !sourceTypes.includes(t)));
                      } else {
                        const toAdd = sourceTypes.filter(t => !selectedTypes.includes(t));
                        onSetTypes([...selectedTypes, ...toAdd]);
                      }
                    };
                    return (
                      <div key={source} className="flex items-center py-0.5">
                        {/* 来源标签：点击全选/全取消该来源下所有类型，固定在行首 */}
                        <button
                          onClick={handleSourceClick}
                          title={allSelected ? t('deselectAllOfSource') : t('selectAllOfSource')}
                          className={clsx(
                            'shrink-0 px-1.5 py-0.5 rounded text-2xs font-semibold transition-opacity cursor-pointer',
                            SOURCE_COLORS[source] ?? 'bg-gray-500/20 text-text-secondary',
                            !anySelected && 'opacity-50 hover:opacity-75',
                          )}
                        >
                          {source}
                        </button>
                        {/* 该来源下的事件类型 pills，横向滚动无滚动条 */}
                        <div
                          className="flex items-center gap-1 overflow-x-auto ml-1"
                          style={{ scrollbarWidth: 'none' }}
                        >
                          {items.map(({ type, count }) => {
                            const slashIdx = type.indexOf('/');
                            const evKey = slashIdx >= 0 ? type.slice(slashIdx + 1) : type;
                            const isSelected = selectedTypes.includes(type);
                            const isResourceSub = evKey.startsWith('resource:');
                            const subType = isResourceSub ? evKey.slice('resource:'.length) : null;
                            const baseColor = isResourceSub
                              ? (SUB_TYPE_COLORS[subType!] ??
                                EVENT_TYPE_COLORS.resource ??
                                'bg-gray-500/20 text-text-secondary')
                              : (EVENT_TYPE_COLORS[evKey] ??
                                SOURCE_COLORS[source] ??
                                'bg-gray-500/20 text-text-secondary');
                            return (
                              <button
                                key={type}
                                title={isResourceSub ? evKey : undefined}
                                onClick={() => onToggleType(type)}
                                className={clsx(
                                  'flex items-center gap-0.5 px-1.5 py-0.5 rounded text-2xs font-medium transition-colors',
                                  isSelected
                                    ? baseColor
                                    : 'bg-bg-secondary text-text-secondary opacity-50 hover:opacity-75',
                                )}
                              >
                                {subType ?? evKey}
                                <span className="opacity-60">{count}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CollapsibleFilterChips>
            );
          })()}
      </div>

      {totalEventCount === 0 && !filterText ? (
        <div className="absolute inset-0 flex items-center justify-center text-text-secondary pointer-events-none">
          <small className="text-xs">{t('rumWaitingForEvents')}</small>
        </div>
      ) : events.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-text-secondary pointer-events-none">
          <small className="text-xs">{t('noMatchingRequests')}</small>
        </div>
      ) : (
        <div
          ref={node => {
            listRef.current = node;
            autoScrollRef(node);
          }}
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

            const isSelected = item.id === selectedEventId;
            const label = getEventLabel(item);
            const eventTypeColor =
              EVENT_TYPE_COLORS[item.event_type] ?? 'bg-gray-500/20 text-text-secondary';
            const subTypeColor = item.type
              ? (SUB_TYPE_COLORS[item.type] ?? 'bg-gray-500/20 text-text-secondary')
              : null;
            const sourceColor = item.source ? (SOURCE_COLORS[item.source] ?? null) : null;
            const isFailed = item.success === 0;

            return (
              <div
                key={item.id}
                data-list-id={item.id}
                onClick={() => onSelectEvent(item.id)}
                className={clsx(
                  'px-2 py-1.5 border-b border-border border-l-2 cursor-pointer transition-colors text-xs text-text-primary',
                  isSelected ? 'border-l-blue-500 bg-bg-selected' : 'border-l-transparent',
                )}
              >
                <div className="flex items-center justify-between gap-1.5 mb-1">
                  <div className="flex items-center gap-1 flex-wrap">
                    {sourceColor && (
                      <span
                        className={clsx(`px-1 py-0 rounded text-3xs font-normal ${sourceColor}`)}
                      >
                        {item.source}
                      </span>
                    )}
                    <span
                      className={clsx(`px-1 py-0 rounded text-3xs font-normal ${eventTypeColor}`)}
                    >
                      {item.event_type}
                    </span>
                    {subTypeColor && (
                      <span
                        className={clsx(`px-1 py-0 rounded text-3xs font-normal ${subTypeColor}`)}
                      >
                        {item.type}
                      </span>
                    )}
                    {item.duration !== undefined && (
                      <span className="px-1 py-0 rounded text-3xs font-normal bg-blue-500/20 text-accent-blue">
                        {Math.round(item.duration)}ms
                      </span>
                    )}
                    {isFailed && (
                      <span className="px-1 py-0 rounded text-3xs font-normal bg-red-500/20 text-red-600">
                        Fail
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-2xs text-text-secondary">{item.batchTimestamp}</span>
                  </div>
                </div>
                <div
                  className={clsx(
                    'font-semibold text-xs truncate',
                    isFailed || item.validation?.level === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : item.validation?.level === 'warning'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-text-primary',
                  )}
                  title={
                    item.validation?.issues.length
                      ? item.validation.issues.map(i => i.message).join('\n')
                      : label
                  }
                >
                  {label}
                </div>
                {/* Pinned event fields */}
                {(() => {
                  const fields = pinnedEventFieldsByEventId?.get(item.id);
                  if (!fields || fields.length === 0) return null;
                  return (
                    <div className="mt-1.5 space-y-1">
                      {fields.map((field, idx) => (
                        <div key={idx} className="flex items-center gap-1 group text-2xs">
                          <span className="px-1 rounded shrink-0 text-white text-3xs bg-teal-500">
                            EVT
                          </span>
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            <span
                              className="font-medium truncate text-accent-blue"
                              title={field.path}
                            >
                              {shortenFieldPath(field.path)}:
                            </span>
                            <span className="truncate" title={JSON.stringify(field.value)}>
                              <ValueDisplay value={field.value} colored />
                            </span>
                          </div>
                          {onUnpinEventField && (
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                onUnpinEventField(field.path, field.eventSubType);
                              }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-text-secondary hover:text-red-600"
                              title={t('unpinField')}
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
