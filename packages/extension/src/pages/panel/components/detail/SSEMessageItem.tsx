import { memo } from 'react';
import { JsonViewer } from './JsonViewer';

interface SSEMessage {
  event: string;
  data: any; // 已经是解析后的数据
  eventId?: string;
  timestamp?: number;
  duration?: number;
}

interface SSEMessageItemProps {
  message: SSEMessage;
  index: number;
  expandedPaths: Record<string, boolean>;
  onToggleExpand: (paths: Record<string, boolean>) => void;
  // EventStream 全局搜索：受控查询词与导航状态
  searchQuery?: string;
  // 本条消息内的“当前匹配项”下标；-1 表示全局当前项不在本条消息内
  currentMatchIndex?: number;
  matchNavigationVersion?: number;
  // 上报本条消息内的匹配数量，供全局统一统计
  onMatchesFound?: (index: number, count: number) => void;
  // 修改响应开启时，允许编辑本条消息数据
  editable?: boolean;
  onValueChange?: (index: number, path: string[], newValue: any) => void;
}

export const SSEMessageItem = memo<SSEMessageItemProps>(
  ({
    message,
    index,
    expandedPaths,
    onToggleExpand,
    searchQuery,
    currentMatchIndex,
    matchNavigationVersion,
    onMatchesFound,
    editable,
    onValueChange,
  }) => {
    const pathPrefix = `sse-message-${index}`;

    return (
      <div className="p-3 text-xs bg-bg-list rounded">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-2xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-600 dark:text-purple-400 font-medium">
              {message.event}
            </span>
            {message.eventId && (
              <span className="text-2xs text-text-secondary">ID: {message.eventId}</span>
            )}
          </div>
          {message.timestamp && (
            <span className="text-2xs text-text-secondary">
              {new Date(message.timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
        <JsonViewer
          json={message.data}
          editable={editable}
          onValueChange={
            editable && onValueChange
              ? (path, newValue) => onValueChange(index, path, newValue)
              : undefined
          }
          expandedPaths={expandedPaths}
          onToggleExpand={onToggleExpand}
          pathPrefix={pathPrefix}
          defaultExpandDepth={3}
          externalSearchQuery={searchQuery}
          externalCurrentMatchIndex={currentMatchIndex}
          externalMatchNavigationVersion={matchNavigationVersion}
          onExternalMatchesFound={count => onMatchesFound?.(index, count)}
        />
      </div>
    );
  },
  (prevProps, nextProps) => {
    // 自定义比较函数：只有消息内容、展开状态、索引或全局搜索状态变化时才重新渲染
    return (
      prevProps.message.event === nextProps.message.event &&
      prevProps.message.data === nextProps.message.data &&
      prevProps.message.eventId === nextProps.message.eventId &&
      prevProps.message.timestamp === nextProps.message.timestamp &&
      prevProps.index === nextProps.index &&
      prevProps.expandedPaths === nextProps.expandedPaths &&
      prevProps.searchQuery === nextProps.searchQuery &&
      prevProps.currentMatchIndex === nextProps.currentMatchIndex &&
      prevProps.matchNavigationVersion === nextProps.matchNavigationVersion &&
      prevProps.editable === nextProps.editable
    );
  },
);

SSEMessageItem.displayName = 'SSEMessageItem';
