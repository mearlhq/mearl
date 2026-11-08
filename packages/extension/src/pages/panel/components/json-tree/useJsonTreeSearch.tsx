import { useEffect, useMemo, useRef, RefObject, ReactNode } from 'react';
import { isPrimitive } from '../../utils/jsonHelpers';
import { tryParseJsonString } from '../../utils/helpers';

// 计算 query 在文本中出现的次数（大小写不敏感）
const countOccurrencesInText = (text: string, query: string): number => {
  let count = 0;
  let pos = 0;
  const lower = text.toLowerCase();
  while ((pos = lower.indexOf(query, pos)) !== -1) {
    count++;
    pos += query.length;
  }
  return count;
};

export const countJsonTreeMatches = (obj: any, query: string, nameKey?: string): number => {
  if (!query) return 0;

  const normalizedQuery = query.toLowerCase();
  const { parsed: parsedObj, format } = tryParseJsonString(obj);
  let count = nameKey ? countOccurrencesInText(nameKey, normalizedQuery) : 0;

  if (!format && isPrimitive(parsedObj)) {
    return count + countOccurrencesInText(String(parsedObj), normalizedQuery);
  }

  if (Array.isArray(parsedObj)) {
    parsedObj.forEach((item, index) => {
      count += countJsonTreeMatches(item, normalizedQuery, index.toString());
    });
  } else if (typeof parsedObj === 'object' && parsedObj !== null) {
    Object.entries(parsedObj).forEach(([key, value]) => {
      count += countJsonTreeMatches(value, normalizedQuery, key);
    });
  }

  return count;
};

interface UseJsonTreeSearchProps {
  data: any;
  name?: string;
  depth: number;
  searchQuery: string;
  currentMatchIndex: number;
  matchNavigationVersion: number;
  onMatchesFound?: (count: number) => void;
  matchStartIndex: number;
  pathKey: string;
  expanded: boolean;
  onToggleExpand?: (paths: Record<string, boolean>) => void;
  setIsExpanded: (value: boolean) => void;
  elementRef: RefObject<HTMLDivElement | null>;
}

export const useJsonTreeSearch = ({
  data,
  name,
  depth,
  searchQuery,
  currentMatchIndex,
  matchNavigationVersion,
  onMatchesFound,
  matchStartIndex,
  pathKey,
  expanded,
  onToggleExpand,
  setIsExpanded,
  elementRef,
}: UseJsonTreeSearchProps) => {
  // 用于追踪上一次的搜索查询，检测搜索查询是否变化
  const prevSearchQueryRef = useRef<string>('');
  // 用于追踪上一次的导航版本，支持单结果重复导航时重新展开
  const prevMatchNavigationVersionRef = useRef<number>(0);

  // 搜索匹配逻辑：同时计算当前节点的匹配次数（键名和值分开统计，供 highlightText 使用偏移量）
  const { isMatch, occurrenceCount, nameOccurrenceCount } = useMemo(() => {
    if (!searchQuery) return { isMatch: false, occurrenceCount: 0, nameOccurrenceCount: 0 };
    const query = searchQuery.toLowerCase();

    const nameCount = name ? countOccurrencesInText(name.toString(), query) : 0;
    const valueCount = isPrimitive(data) ? countOccurrencesInText(String(data), query) : 0;
    const total = nameCount + valueCount;

    return { isMatch: total > 0, occurrenceCount: total, nameOccurrenceCount: nameCount };
  }, [searchQuery, name, data]);

  // 检查子节点是否有匹配
  const hasMatchInChildren = useMemo(() => {
    if (!searchQuery || isPrimitive(data)) return false;
    return countJsonTreeMatches(data, searchQuery) > 0;
  }, [searchQuery, data]);

  // 自动展开包含匹配项的节点（仅在搜索查询变化时触发，避免用户主动折叠后被重新展开）
  useEffect(() => {
    // 检查搜索查询是否真的变化了
    const searchQueryChanged = prevSearchQueryRef.current !== searchQuery;
    const navigationTriggered = prevMatchNavigationVersionRef.current !== matchNavigationVersion;
    prevSearchQueryRef.current = searchQuery;
    prevMatchNavigationVersionRef.current = matchNavigationVersion;

    // 搜索词变化或用户触发上/下一个导航时，都允许自动展开命中分支
    if (
      (searchQueryChanged || navigationTriggered) &&
      searchQuery &&
      hasMatchInChildren &&
      !expanded
    ) {
      if (onToggleExpand) {
        onToggleExpand({ [pathKey]: true });
      } else {
        setIsExpanded(true);
      }
    }
  }, [
    searchQuery,
    matchNavigationVersion,
    hasMatchInChildren,
    expanded,
    pathKey,
    onToggleExpand,
    setIsExpanded,
  ]);

  // 滚动到当前匹配
  // 一个节点可能有多次匹配（如键名含多个 query），占用连续多个索引槽位
  useEffect(() => {
    if (
      !isMatch ||
      occurrenceCount <= 0 ||
      currentMatchIndex < matchStartIndex ||
      currentMatchIndex >= matchStartIndex + occurrenceCount ||
      !elementRef.current
    ) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const animationFrameId = requestAnimationFrame(() => {
      timeoutId = setTimeout(() => {
        elementRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 300);
    });

    return () => {
      cancelAnimationFrame(animationFrameId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [
    isMatch,
    occurrenceCount,
    currentMatchIndex,
    matchNavigationVersion,
    matchStartIndex,
    elementRef,
  ]);

  // 统计总匹配数（仅在根节点）
  useEffect(() => {
    if (depth === 0 && onMatchesFound && searchQuery) {
      const totalMatches = countJsonTreeMatches(data, searchQuery, name);
      onMatchesFound(totalMatches);
    }
  }, [searchQuery, depth, onMatchesFound, data, name]);

  // 高亮搜索文本（高亮所有出现位置，当前匹配项使用不同样式）
  // textStartOffset: 本次高亮的文本在节点所有匹配中的起始偏移量
  //   - 键名：传 0（或省略）
  //   - 值：传 nameOccurrenceCount
  const highlightText = (text: string, textStartOffset: number = 0): ReactNode => {
    if (!searchQuery || !isMatch) return text;

    const query = searchQuery.toLowerCase();
    const lowerText = text.toLowerCase();

    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let pos = lowerText.indexOf(query, 0);
    let occurrenceIdx = 0;

    if (pos === -1) return text;

    while (pos !== -1) {
      if (pos > lastIndex) parts.push(text.substring(lastIndex, pos));
      const globalIdx = matchStartIndex + textStartOffset + occurrenceIdx;
      const isCurrent = globalIdx === currentMatchIndex;
      parts.push(
        <span
          key={pos}
          className={
            isCurrent
              ? 'bg-orange-400 text-black font-semibold ring-1 ring-orange-600'
              : 'bg-yellow-400 text-black font-semibold'
          }
        >
          {text.substring(pos, pos + query.length)}
        </span>,
      );
      lastIndex = pos + query.length;
      pos = lowerText.indexOf(query, lastIndex);
      occurrenceIdx++;
    }

    if (lastIndex < text.length) parts.push(text.substring(lastIndex));

    return <>{parts}</>;
  };

  return {
    isMatch,
    hasMatchInChildren,
    highlightText,
    occurrenceCount,
    nameOccurrenceCount,
  };
};
