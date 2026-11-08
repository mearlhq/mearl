import { useState, useRef, useEffect, RefObject } from 'react';

interface UseSearchUIOptions {
  // 是否绑定 Ctrl/Cmd+F 快捷键（默认绑定）。
  // 当同一容器内存在多个搜索实例（如 EventStream 全局搜索 + 单条消息搜索）时，
  // 外层可关闭快捷键绑定，避免一次按键同时打开多个搜索框。
  bindCtrlF?: boolean;
  // 流式内容会持续增加匹配项；开启后保留当前项，仅在结果收缩越界时调整。
  preserveCurrentOnMatchCountChange?: boolean;
}

export const useSearchUI = (
  containerRef: RefObject<HTMLElement | null>,
  options?: UseSearchUIOptions,
) => {
  const bindCtrlF = options?.bindCtrlF !== false;
  const preserveCurrentOnMatchCountChange = options?.preserveCurrentOnMatchCountChange === true;
  const [inputValue, setInputValue] = useState<string>(''); // 用户输入的值（立即更新）
  const [searchQuery, setSearchQuery] = useState<string>(''); // 实际用于搜索的值（防抖后更新）
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const [matchNavigationVersion, setMatchNavigationVersion] = useState<number>(0);
  const [totalMatches, setTotalMatches] = useState<number>(0);
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 防抖更新搜索查询（300ms）
  useEffect(() => {
    // 清除之前的定时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // 如果输入为空，立即清空搜索（不需要防抖）
    if (inputValue === '') {
      setSearchQuery('');
      return;
    }

    // 设置新的定时器
    debounceTimerRef.current = setTimeout(() => {
      setSearchQuery(inputValue);
    }, 300);

    // 清理函数
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [inputValue]);

  // 查询词变化时从第一项开始。
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  // 流式内容新增命中时保留当前位置，仅在结果收缩越界时回到最后一项。
  useEffect(() => {
    setCurrentMatchIndex(prev => {
      if (totalMatches <= 0) return 0;
      if (!preserveCurrentOnMatchCountChange && searchQuery) return 0;
      return Math.min(prev, totalMatches - 1);
    });
  }, [totalMatches, searchQuery, preserveCurrentOnMatchCountChange]);

  // 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        bindCtrlF &&
        (e.ctrlKey || e.metaKey) &&
        e.key === 'f' &&
        containerRef.current?.contains(e.target as Node)
      ) {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === 'Escape' && showSearch) {
        // 阻止冒泡，避免在 Modal 等容器内关闭搜索框时连带触发外层的 ESC 关闭
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(false);
        setInputValue('');
        setSearchQuery('');
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [showSearch, containerRef, bindCtrlF]);

  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  const handleNextMatch = () => {
    if (totalMatches > 0) {
      setMatchNavigationVersion(prev => prev + 1);
      setCurrentMatchIndex(prev => (prev + 1) % totalMatches);
    }
  };

  const handlePrevMatch = () => {
    if (totalMatches > 0) {
      setMatchNavigationVersion(prev => prev + 1);
      setCurrentMatchIndex(prev => (prev - 1 + totalMatches) % totalMatches);
    }
  };

  const handleClose = () => {
    setShowSearch(false);
    setInputValue('');
    setSearchQuery('');
    setMatchNavigationVersion(0);
  };

  return {
    searchQuery, // 用于搜索的值（防抖后）
    inputValue, // 用于输入框显示的值（立即更新）
    setInputValue, // 更新输入框的值
    setSearchQuery,
    currentMatchIndex,
    matchNavigationVersion,
    totalMatches,
    setTotalMatches,
    showSearch,
    setShowSearch,
    searchInputRef,
    handleNextMatch,
    handlePrevMatch,
    handleClose,
  };
};
