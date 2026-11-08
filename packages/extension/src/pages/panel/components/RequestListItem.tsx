import { FC, MouseEvent } from 'react';
import { X, Ellipsis } from 'lucide-react';
import { clsx } from 'clsx';
import { CapturedRequest, PinnedField } from '../types';
import { ValueDisplay } from './ValueDisplay';
import { t } from '../utils/i18n';
import { formatTimestamp, getRetStatus, shortenFieldPath } from '../utils/helpers';
import { RESOURCE_TYPE_COLORS, RESOURCE_TYPE_LABELS } from './RequestList';

interface RequestListItemProps {
  req: CapturedRequest;
  isSelected: boolean;
  pinnedFields: PinnedField[];
  onSelect: () => void;
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void;
  onUnpinField: (path: string, apiName: string, type: 'request' | 'response') => void;
}

export const RequestListItem: FC<RequestListItemProps> = ({
  req,
  isSelected,
  pinnedFields,
  onSelect,
  onContextMenu,
  onUnpinField,
}) => {
  const retStatus = getRetStatus(req.responseBody);
  const timestamp = formatTimestamp(req.timestampMs);

  return (
    <div
      data-list-id={req.id}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={clsx(
        'px-2 py-1.5 border-b border-border border-l-2 cursor-pointer transition-colors text-xs text-text-primary',
        isSelected ? 'border-l-blue-500 bg-bg-selected' : 'border-l-transparent',
      )}
    >
      <div className="flex items-center justify-between gap-1.5 mb-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Method / resource-type badge */}
          {(() => {
            const rt = req.resourceType ?? '';
            const isApiType = req.source !== 'requests' || rt === 'xhr' || rt === 'fetch' || !rt;
            if (isApiType) {
              return (
                <span
                  className={clsx(
                    'px-1 py-0 rounded text-3xs font-normal',
                    req.method?.toUpperCase() === 'POST'
                      ? 'bg-orange-500/20 text-orange-700 dark:text-orange-400'
                      : 'bg-green-500/20 text-green-800 dark:text-green-400',
                  )}
                >
                  {req.method?.toUpperCase()}
                </span>
              );
            }
            const label = RESOURCE_TYPE_LABELS[rt] ?? rt.toUpperCase();
            const color =
              RESOURCE_TYPE_COLORS[rt] ?? 'bg-gray-500/20 text-gray-600 dark:text-gray-400';
            return (
              <span className={clsx(`px-1 py-0 rounded text-3xs font-normal ${color}`)}>
                {label}
              </span>
            );
          })()}

          {/* HTTP status —— pending 时显示省略号，避免短暂的 status=0 误导 */}
          {req.isPending ? (
            <span className="px-1 py-0 rounded text-3xs font-normal bg-gray-400/20 text-text-secondary inline-flex items-center">
              <Ellipsis className="w-2.5 h-2.5" />
            </span>
          ) : (
            <span
              className={clsx(
                'px-1 py-0 rounded text-3xs font-normal',
                req.status >= 200 && req.status < 300
                  ? 'bg-green-500/20 text-green-600'
                  : 'bg-red-500/20 text-red-600',
              )}
            >
              {req.status}
            </span>
          )}

          {/* Duration — 优先显示配置的 mock 响应时长 */}
          {(() => {
            const displayDuration =
              req.responseOverride?.duration !== undefined
                ? req.responseOverride.duration
                : req.duration;
            return displayDuration !== undefined ? (
              <span
                className="px-1 py-0 rounded text-3xs font-normal bg-blue-500/20 text-accent-blue cursor-default"
                title={t('durationMs', String(displayDuration))}
              >
                {displayDuration}ms
              </span>
            ) : null;
          })()}

          {req.isProxy && (
            <span
              className="px-1 py-0 rounded text-3xs font-normal bg-amber-500/20 text-amber-600"
              title={t('proxyRequest')}
            >
              Proxy
            </span>
          )}
          {req.isSSE && (
            <span
              className="px-1 py-0 rounded text-3xs font-normal bg-purple-500/20 text-purple-600 dark:text-purple-400"
              title="Server-Sent Events"
            >
              SSE
            </span>
          )}
          {req.isAutoTranslated && (
            <span
              className="px-1 py-0 rounded text-3xs font-normal bg-teal-500/20 text-teal-700"
              title="Auto Translated"
            >
              Translated
            </span>
          )}
          {req.responseOverride && (
            <span
              className="px-1 py-0 rounded text-3xs font-medium bg-yellow-500/20 text-yellow-700"
              title="Response Modified"
            >
              Modified
            </span>
          )}
        </div>
        <span className="shrink-0 text-2xs text-text-secondary cursor-default" title={timestamp}>
          <span className="@[240px]:hidden">{formatTimestamp(req.timestampMs, 'short')}</span>
          <span className="hidden @[240px]:inline">{timestamp}</span>
        </span>
      </div>

      {/* API name */}
      <div
        className={clsx(
          'font-semibold text-xs truncate',
          retStatus === 'error'
            ? 'text-red-600 dark:text-red-400'
            : retStatus === 'warning'
              ? 'text-yellow-600 dark:text-yellow-400'
              : 'text-text-primary',
        )}
        title={req.apiName}
      >
        {req.apiName}
      </div>

      {/* Pinned fields */}
      {pinnedFields.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {pinnedFields
            .slice()
            .sort((a, b) => {
              if (a.type === 'request' && b.type === 'response') return -1;
              if (a.type === 'response' && b.type === 'request') return 1;
              return 0;
            })
            .map((field, idx) => (
              <div key={idx} className="flex items-center gap-1 group text-2xs">
                <span
                  className={clsx(
                    'px-1 rounded shrink-0 text-white text-3xs',
                    field.type === 'request' ? 'bg-blue-500' : 'bg-green-500',
                  )}
                >
                  {field.type === 'request' ? 'REQ' : 'RES'}
                </span>
                <div className="flex-1 min-w-0 flex items-center gap-1">
                  <span className="font-medium truncate text-accent-blue" title={field.path}>
                    {shortenFieldPath(field.path)}:
                  </span>
                  <span className="truncate" title={JSON.stringify(field.value)}>
                    <ValueDisplay value={field.value} colored />
                  </span>
                </div>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    onUnpinField(field.path, field.apiName, field.type);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-text-secondary hover:text-red-600"
                  title={t('unpinField')}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
