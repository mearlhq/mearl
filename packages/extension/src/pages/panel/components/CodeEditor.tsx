import { clsx } from 'clsx';
import {
  FC,
  useRef,
  useMemo,
  useState,
  useCallback,
  useEffect,
  KeyboardEvent,
  ChangeEvent,
  RefObject,
} from 'react';
import { AlignLeft, Highlighter, Search } from 'lucide-react';
import Prism from './prismSetup';
import { t } from '../utils/i18n';
import { useSafeFocus } from '../../../shared/hooks/useSafeFocus';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import { handleJsonKeyDown } from './json-tree/useJsonTextareaKeyboard';
import { SearchBar } from './detail/SearchBar';
import { useSessionStorageBoolean } from '../hooks/useSessionStorage';

const PRISM_LANG: Record<string, string> = {
  html: 'markup',
  css: 'css',
  js: 'javascript',
  json: 'json',
  markdown: 'markdown',
};

const HIGHLIGHT_STORAGE_KEY = 'code-editor-highlight-enabled';
const LARGE_CODE_HIGHLIGHT_LIMIT = 200_000;
const LONG_JS_LINE_HIGHLIGHT_LIMIT = 12_000;
const PARTIAL_HIGHLIGHT_WINDOW_SIZE = 60_000;
const PARTIAL_HIGHLIGHT_ANCHOR_DEBOUNCE = 80;

function buildLineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function findScrollableParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    const canScrollY =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight > node.clientHeight;
    if (canScrollY) return node;
    node = node.parentElement;
  }
  return null;
}

function buildEscapedCache(text: string): { escaped: string; rawToEscaped: number[] } {
  const rawToEscaped = new Array<number>(text.length + 1);
  const parts: string[] = [];
  let escapedOffset = 0;

  for (let i = 0; i < text.length; i++) {
    rawToEscaped[i] = escapedOffset;
    const code = text.charCodeAt(i);
    if (code === 38) {
      parts.push('&amp;');
      escapedOffset += 5;
    } else if (code === 60) {
      parts.push('&lt;');
      escapedOffset += 4;
    } else if (code === 62) {
      parts.push('&gt;');
      escapedOffset += 4;
    } else {
      parts.push(text[i]);
      escapedOffset += 1;
    }
  }

  rawToEscaped[text.length] = escapedOffset;
  return { escaped: parts.join(''), rawToEscaped };
}

function getLongestLineLength(text: string): number {
  let longest = 0;
  let current = 0;

  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    if (charCode === 10) {
      if (current > longest) longest = current;
      current = 0;
      continue;
    }
    if (charCode !== 13) current++;
  }

  return current > longest ? current : longest;
}

interface HtmlRange {
  hStart: number;
  hEnd: number;
}

/**
 * Step 1: 从已高亮的 HTML 字符串中计算所有匹配的 HTML 范围（只在 highlight/query 变化时运行）。
 */
function computeMatchRanges(html: string, query: string): { ranges: HtmlRange[]; total: number } {
  if (!query) return { ranges: [], total: 0 };
  const lowerQuery = query.toLowerCase();

  // 构建 plainText 偏移 → html 偏移的映射
  const plainToHtml: number[] = [];
  let hi = 0;
  while (hi < html.length) {
    if (html[hi] === '<') {
      while (hi < html.length && html[hi] !== '>') hi++;
      hi++;
    } else if (html[hi] === '&') {
      const entityStart = hi;
      while (hi < html.length && html[hi] !== ';') hi++;
      hi++;
      plainToHtml.push(entityStart);
    } else {
      plainToHtml.push(hi);
      hi++;
    }
  }

  // 在纯文本中找所有匹配位置，转换为 html 范围
  const plainText = html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const ranges: HtmlRange[] = [];
  let pos = plainText.toLowerCase().indexOf(lowerQuery, 0);
  while (pos !== -1) {
    const pEnd = pos + query.length - 1;
    ranges.push({
      hStart: plainToHtml[pos] ?? 0,
      hEnd: plainToHtml[pEnd + 1] ?? html.length,
    });
    pos = plainText.toLowerCase().indexOf(lowerQuery, pos + lowerQuery.length);
  }
  return { ranges, total: ranges.length };
}

/**
 * Step 2: 将已计算好的 ranges 注入 <mark> 标签（currentMatchIndex 变化时只运行此步）。
 */
function applySearchMarks(html: string, ranges: HtmlRange[], activeIdx: number): string {
  if (!ranges.length) return html;
  const result: string[] = [];
  let cursor = 0;
  for (let idx = 0; idx < ranges.length; idx++) {
    const { hStart, hEnd } = ranges[idx];
    if (hStart < cursor) continue;
    result.push(html.slice(cursor, hStart));
    const cls =
      idx === activeIdx
        ? 'bg-orange-400 text-black font-semibold ring-1 ring-orange-600'
        : 'bg-yellow-400 text-black font-semibold';
    result.push(`<mark class="${cls}" style="border-radius:2px">`);
    result.push(html.slice(hStart, hEnd));
    result.push('</mark>');
    cursor = hEnd;
  }
  result.push(html.slice(cursor));
  return result.join('');
}

const SHARED = 'p-2 font-mono text-xxs leading-[1.5] whitespace-pre';
const MIN_H = 'min-h-0';

interface CodeEditorProps {
  code: string;
  language: 'html' | 'css' | 'js' | 'json' | 'markdown' | 'text';
  /** 传入则进入可编辑模式 */
  onChange?: (value: string) => void;
  /** 编辑模式下的最小高度 class，默认 min-h-[calc(100vh-138px)] */
  minHeightClass?: string;
  /** 弹窗打开时自动聚焦 */
  autoFocus?: boolean;
  className?: string;
  /** 是否显示右上角工具按钮（搜索/高亮） */
  showToolbar?: boolean;
  /** 提供则在右上角工具栏显示「格式化」按钮（与 showToolbar 独立，仅编辑模式有意义） */
  onFormat?: () => void;
  /** 搜索栏是否使用紧凑模式 */
  searchCompact?: boolean;
  /** 搜索输入框背景样式 */
  searchInputBgStyle?: 'white' | 'secondary';
  /** 搜索栏是否启用页面元素 Picker */
  searchEnablePicker?: boolean;
  /** 外部触发打开搜索，值变化时生效 */
  openSearchVersion?: number;
  /** 外部触发关闭搜索，值变化时生效 */
  closeSearchVersion?: number;
  /** 搜索可见性变化回调 */
  onSearchVisibleChange?: (visible: boolean) => void;
  /** 使用外部搜索状态（由父组件渲染搜索框并驱动高亮） */
  useExternalSearch?: boolean;
  /** 外部搜索词 */
  externalSearchQuery?: string;
  /** 外部当前匹配索引 */
  externalCurrentMatchIndex?: number;
  /** 外部搜索匹配数量回调 */
  onExternalMatchesFound?: (count: number) => void;
  /** 编辑模式下无内容时显示的占位文字 */
  placeholder?: string;
}

export const CodeEditor: FC<CodeEditorProps> = ({
  code,
  language,
  onChange,
  minHeightClass,
  autoFocus,
  className = '',
  showToolbar = true,
  onFormat,
  searchCompact = true,
  searchInputBgStyle = 'white',
  searchEnablePicker = true,
  openSearchVersion,
  closeSearchVersion,
  onSearchVisibleChange,
  useExternalSearch = false,
  externalSearchQuery = '',
  externalCurrentMatchIndex = 0,
  onExternalMatchesFound,
  placeholder,
}) => {
  const minH = minHeightClass ?? MIN_H;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useSafeFocus(taRef, { enabled: !!autoFocus });

  const [highlightEnabled, toggleHighlightEnabled] = useSessionStorageBoolean(
    HIGHLIGHT_STORAGE_KEY,
    true,
  );
  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [partialAnchorOffset, setPartialAnchorOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const partialAnchorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const partialAnchorRef = useRef(0);
  const openSearchVersionRef = useRef<number | undefined>(openSearchVersion);
  const closeSearchVersionRef = useRef<number | undefined>(closeSearchVersion);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchInput('');
    setSearchQuery('');
  }, []);

  const openSearchBar = useCallback(() => {
    setShowSearch(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  // 防抖更新 searchQuery
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchInput) {
      setSearchQuery('');
      return;
    }
    debounceRef.current = setTimeout(() => setSearchQuery(searchInput), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  // 重置 currentMatchIndex
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  const activeSearchQuery = useExternalSearch ? externalSearchQuery : searchQuery;
  const activeCurrentMatchIndex = useExternalSearch ? externalCurrentMatchIndex : currentMatchIndex;
  const lineStartOffsets = useMemo(() => buildLineStartOffsets(code), [code]);
  const escapedCodeCache = useMemo(() => buildEscapedCache(code), [code]);

  const highlightMode = useMemo<'off' | 'full' | 'partial'>(() => {
    if (!highlightEnabled) return 'off';
    if (code.length > LARGE_CODE_HIGHLIGHT_LIMIT) return 'partial';
    if (language === 'js' && getLongestLineLength(code) > LONG_JS_LINE_HIGHLIGHT_LIMIT)
      return 'partial';
    return 'full';
  }, [highlightEnabled, code, language]);

  const isHighlightActive = highlightMode !== 'off';
  const isPartialHighlight = highlightMode === 'partial';

  const getAnchorFromScroll = useCallback(
    (el: HTMLElement): number => {
      const style = window.getComputedStyle(el);
      const fontSize = Number.parseFloat(style.fontSize) || 11;
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
      const charWidth = Math.max(5, fontSize * 0.62);
      const lineIndex = Math.max(
        0,
        Math.min(lineStartOffsets.length - 1, Math.floor(el.scrollTop / lineHeight)),
      );
      const columnIndex = Math.max(0, Math.floor(el.scrollLeft / charWidth));
      return Math.min(code.length, (lineStartOffsets[lineIndex] ?? 0) + columnIndex);
    },
    [code.length, lineStartOffsets],
  );

  const getAnchorFromParentScroll = useCallback(
    (preEl: HTMLElement, parentEl: HTMLElement): number => {
      const preRect = preEl.getBoundingClientRect();
      const parentRect = parentEl.getBoundingClientRect();
      const visibleTopInPre = Math.max(0, parentRect.top - preRect.top);

      const style = window.getComputedStyle(preEl);
      const fontSize = Number.parseFloat(style.fontSize) || 11;
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
      const charWidth = Math.max(5, fontSize * 0.62);
      const lineIndex = Math.max(
        0,
        Math.min(lineStartOffsets.length - 1, Math.floor(visibleTopInPre / lineHeight)),
      );
      const columnIndex = Math.max(0, Math.floor(preEl.scrollLeft / charWidth));
      return Math.min(code.length, (lineStartOffsets[lineIndex] ?? 0) + columnIndex);
    },
    [code.length, lineStartOffsets],
  );

  const getAnchorFromViewport = useCallback(
    (preEl: HTMLElement): number => {
      const preRect = preEl.getBoundingClientRect();
      const visibleTopInPre = Math.max(0, -preRect.top);

      const style = window.getComputedStyle(preEl);
      const fontSize = Number.parseFloat(style.fontSize) || 11;
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
      const charWidth = Math.max(5, fontSize * 0.62);
      const lineIndex = Math.max(
        0,
        Math.min(lineStartOffsets.length - 1, Math.floor(visibleTopInPre / lineHeight)),
      );
      const columnIndex = Math.max(0, Math.floor(preEl.scrollLeft / charWidth));
      return Math.min(code.length, (lineStartOffsets[lineIndex] ?? 0) + columnIndex);
    },
    [code.length, lineStartOffsets],
  );

  const schedulePartialAnchorUpdate = useCallback(
    (anchor: number) => {
      if (!isPartialHighlight) return;
      const windowSize = Math.min(PARTIAL_HIGHLIGHT_WINDOW_SIZE, code.length);
      const half = Math.floor(windowSize / 2);
      let start = Math.max(0, partialAnchorRef.current - half);
      let end = start + windowSize;
      if (end > code.length) {
        end = code.length;
        start = Math.max(0, end - windowSize);
      }
      const guard = Math.max(1000, Math.floor(windowSize * 0.2));
      if (anchor >= start + guard && anchor <= end - guard) return;

      if (partialAnchorTimerRef.current) clearTimeout(partialAnchorTimerRef.current);
      partialAnchorTimerRef.current = setTimeout(() => {
        partialAnchorRef.current = anchor;
        setPartialAnchorOffset(anchor);
      }, PARTIAL_HIGHLIGHT_ANCHOR_DEBOUNCE);
    },
    [isPartialHighlight, code.length],
  );

  useEffect(() => {
    if (partialAnchorTimerRef.current) {
      clearTimeout(partialAnchorTimerRef.current);
      partialAnchorTimerRef.current = null;
    }
    if (!isPartialHighlight) {
      partialAnchorRef.current = 0;
      setPartialAnchorOffset(0);
      return;
    }
    const anchorSource = taRef.current ?? preRef.current;
    const anchor = anchorSource ? getAnchorFromScroll(anchorSource) : 0;
    partialAnchorRef.current = anchor;
    setPartialAnchorOffset(anchor);
  }, [isPartialHighlight, code, getAnchorFromScroll]);

  useEffect(() => {
    return () => {
      if (partialAnchorTimerRef.current) {
        clearTimeout(partialAnchorTimerRef.current);
        partialAnchorTimerRef.current = null;
      }
    };
  }, []);

  // 只读模式下，内容通常跟随外层容器纵向滚动，需要监听父滚动容器来更新高亮窗口锚点
  useEffect(() => {
    if (!isPartialHighlight || onChange) return;
    const preEl = preRef.current;
    if (!preEl) return;
    const parentEl = findScrollableParent(preEl);

    if (parentEl) {
      const updateAnchor = () => {
        schedulePartialAnchorUpdate(getAnchorFromParentScroll(preEl, parentEl));
      };

      parentEl.addEventListener('scroll', updateAnchor, { passive: true });
      window.addEventListener('resize', updateAnchor);
      updateAnchor();

      return () => {
        parentEl.removeEventListener('scroll', updateAnchor);
        window.removeEventListener('resize', updateAnchor);
      };
    }

    const updateAnchorByWindow = () => {
      schedulePartialAnchorUpdate(getAnchorFromViewport(preEl));
    };

    window.addEventListener('scroll', updateAnchorByWindow, { passive: true });
    window.addEventListener('resize', updateAnchorByWindow);
    updateAnchorByWindow();

    return () => {
      window.removeEventListener('scroll', updateAnchorByWindow);
      window.removeEventListener('resize', updateAnchorByWindow);
    };
  }, [
    isPartialHighlight,
    onChange,
    getAnchorFromParentScroll,
    getAnchorFromViewport,
    schedulePartialAnchorUpdate,
  ]);

  // 异步高亮：支持按滚动锚点局部高亮，降低长文本卡顿
  const [baseHighlight, setBaseHighlight] = useState<string | null>(null);
  const hlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hlTimerRef.current) clearTimeout(hlTimerRef.current);

    if (!isHighlightActive) {
      setBaseHighlight(null);
      return;
    }

    const prismLang = PRISM_LANG[language];
    if (!prismLang || !Prism.languages[prismLang]) {
      setBaseHighlight(null);
      return;
    }

    const grammar = Prism.languages[prismLang];
    const highlightNow = () => {
      if (isPartialHighlight) {
        const windowSize = Math.min(PARTIAL_HIGHLIGHT_WINDOW_SIZE, code.length);
        const half = Math.floor(windowSize / 2);
        let start = Math.max(0, partialAnchorOffset - half);
        let end = start + windowSize;
        if (end > code.length) {
          end = code.length;
          start = Math.max(0, end - windowSize);
        }
        const prefix = escapedCodeCache.escaped.slice(0, escapedCodeCache.rawToEscaped[start] ?? 0);
        const windowCode = code.slice(start, end);
        const suffix = escapedCodeCache.escaped.slice(
          escapedCodeCache.rawToEscaped[end] ?? escapedCodeCache.escaped.length,
        );
        setBaseHighlight(prefix + Prism.highlight(windowCode, grammar, prismLang) + suffix);
        return;
      }
      setBaseHighlight(Prism.highlight(code, grammar, prismLang));
    };

    const renderLength = isPartialHighlight
      ? Math.min(PARTIAL_HIGHLIGHT_WINDOW_SIZE, code.length)
      : code.length;
    if (renderLength <= 50_000) {
      highlightNow();
      return;
    }

    setBaseHighlight(null);
    hlTimerRef.current = setTimeout(highlightNow, 0);
    return () => {
      if (hlTimerRef.current) clearTimeout(hlTimerRef.current);
    };
  }, [
    code,
    language,
    isHighlightActive,
    isPartialHighlight,
    partialAnchorOffset,
    escapedCodeCache,
  ]);

  // 稳定的 HTML 基础（高亮版或转义版），仅在 highlight/code 变化时重建
  const htmlBase = useMemo(
    () =>
      isHighlightActive ? (baseHighlight ?? escapedCodeCache.escaped) : escapedCodeCache.escaped,
    [isHighlightActive, baseHighlight, escapedCodeCache],
  );

  // Step 1: 计算匹配范围（O(N)），仅在 htmlBase 或 searchQuery 变化时运行
  const { ranges, total } = useMemo(
    () => computeMatchRanges(htmlBase, activeSearchQuery),
    [htmlBase, activeSearchQuery],
  );

  // Step 2: 注入 mark 标签（O(N+M)），currentMatchIndex 变化时不重跑 Step 1
  const markedHtml = useMemo(
    () => (ranges.length ? applySearchMarks(htmlBase, ranges, activeCurrentMatchIndex) : htmlBase),
    [htmlBase, ranges, activeCurrentMatchIndex],
  );

  // 滚动到当前匹配的 <mark>
  useEffect(() => {
    if (!activeSearchQuery || !preRef.current) return;
    const marks = preRef.current.querySelectorAll('mark');
    const active = marks[activeCurrentMatchIndex];
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeCurrentMatchIndex, activeSearchQuery, markedHtml]);

  useEffect(() => {
    if (useExternalSearch) {
      onSearchVisibleChange?.(false);
      return;
    }
    onSearchVisibleChange?.(showSearch);
  }, [showSearch, onSearchVisibleChange, useExternalSearch]);

  useEffect(() => {
    if (!useExternalSearch) return;
    onExternalMatchesFound?.(total);
  }, [onExternalMatchesFound, total, useExternalSearch]);

  // Cmd/Ctrl+F 打开搜索
  useEffect(() => {
    if (useExternalSearch) return;

    const el = containerRef.current;
    if (!el) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && el.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        openSearchBar();
      }
      if (e.key === 'Escape' && showSearch) {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [showSearch, closeSearch, openSearchBar, useExternalSearch]);

  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  useEffect(() => {
    if (useExternalSearch) return;
    if (openSearchVersion === undefined) return;
    if (openSearchVersionRef.current === undefined) {
      openSearchVersionRef.current = openSearchVersion;
      return;
    }
    if (openSearchVersion !== openSearchVersionRef.current) {
      openSearchBar();
    }
    openSearchVersionRef.current = openSearchVersion;
  }, [openSearchVersion, openSearchBar, useExternalSearch]);

  useEffect(() => {
    if (useExternalSearch) return;
    if (closeSearchVersion === undefined) return;
    if (closeSearchVersionRef.current === undefined) {
      closeSearchVersionRef.current = closeSearchVersion;
      return;
    }
    if (closeSearchVersion !== closeSearchVersionRef.current) {
      closeSearch();
    }
    closeSearchVersionRef.current = closeSearchVersion;
  }, [closeSearchVersion, closeSearch, useExternalSearch]);

  const handleNextMatch = useCallback(() => {
    if (total > 0) setCurrentMatchIndex(i => (i + 1) % total);
  }, [total]);

  const handlePrevMatch = useCallback(() => {
    if (total > 0) setCurrentMatchIndex(i => (i - 1 + total) % total);
  }, [total]);

  // 同步滚动
  const handleScroll = useCallback(() => {
    if (!taRef.current || !preRef.current) return;
    preRef.current.scrollTop = taRef.current.scrollTop;
    preRef.current.scrollLeft = taRef.current.scrollLeft;
    schedulePartialAnchorUpdate(getAnchorFromScroll(taRef.current));
  }, [getAnchorFromScroll, schedulePartialAnchorUpdate]);

  const handleReadOnlyScroll = useCallback(() => {
    if (!preRef.current) return;
    schedulePartialAnchorUpdate(getAnchorFromScroll(preRef.current));
  }, [getAnchorFromScroll, schedulePartialAnchorUpdate]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const ta = taRef.current;
    if (!ta || !onChange) return;
    const result = handleJsonKeyDown(e, ta.value, ta.selectionStart, ta.selectionEnd);
    if (!result) return;
    const [newText, newStart, newEnd] = result;
    onChange(newText);
    requestAnimationFrame(() => {
      ta.selectionStart = newStart;
      ta.selectionEnd = newEnd;
    });
  };

  const btnCls =
    'p-0.5 rounded transition-opacity opacity-0 group-hover:opacity-100 text-text-secondary hover:text-text-primary hover:bg-bg-hover';

  const hasToolbar = showToolbar || !!onFormat;
  const toolbar = (
    <div className="absolute top-1 right-1 z-10 flex gap-0.5">
      {showToolbar && (
        <>
          <button onClick={openSearchBar} className={btnCls} title={t('searchShortcut')}>
            <Search className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={toggleHighlightEnabled}
            className={clsx(
              isHighlightActive
                ? 'p-0.5 rounded transition-opacity opacity-0 group-hover:opacity-100 text-blue-500 hover:text-blue-600 hover:bg-bg-hover'
                : btnCls,
            )}
            title={
              !highlightEnabled
                ? t('highlightEnable')
                : isPartialHighlight
                  ? t('highlightPartial')
                  : t('highlightDisable')
            }
          >
            <Highlighter className="w-3.5 h-3.5" />
          </button>
        </>
      )}
      {onFormat && (
        <button onClick={onFormat} className={btnCls} title={t('formatJson')}>
          <AlignLeft className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );

  const searchBar = !useExternalSearch && showSearch && (
    <div className="sticky top-0 z-10 border-b border-border bg-bg-secondary">
      <SearchBar
        searchQuery={searchInput}
        currentMatchIndex={currentMatchIndex}
        totalMatches={total}
        onSearchChange={setSearchInput}
        onPrevMatch={handlePrevMatch}
        onNextMatch={handleNextMatch}
        onClose={closeSearch}
        searchInputRef={searchInputRef as RefObject<HTMLInputElement>}
        compact={searchCompact}
        inputBgStyle={searchInputBgStyle}
        enablePicker={searchEnablePicker}
      />
    </div>
  );

  // 只读模式
  if (!onChange) {
    return (
      <div
        ref={containerRef}
        className={clsx(
          `group relative border border-border rounded bg-bg-secondary h-full flex flex-col ${className}`,
        )}
      >
        {hasToolbar && !showSearch && !useExternalSearch && toolbar}
        {searchBar}
        <pre
          ref={preRef}
          onScroll={handleReadOnlyScroll}
          className={clsx(
            `prism-highlight ${SHARED} text-text-primary overflow-auto flex-1 min-h-0`,
          )}
          dangerouslySetInnerHTML={{ __html: markedHtml }}
        />
      </div>
    );
  }

  // 编辑模式：grid 叠层，textarea 透明文字覆盖高亮 pre
  const displayHtml = markedHtml + '\n';
  return (
    <div
      ref={containerRef}
      className={clsx(
        `group relative border border-border rounded bg-bg-secondary focus-within:border-blue-500 h-full flex flex-col ${className}`,
      )}
    >
      {showToolbar && !showSearch && !useExternalSearch && toolbar}
      {searchBar}
      <div className={clsx(`grid ${minH} flex-1 overflow-y-auto`)}>
        {/* 高亮层（只展示，不交互）*/}
        <pre
          ref={preRef}
          aria-hidden
          className={clsx(
            `prism-highlight [grid-area:1/1] ${SHARED} text-text-primary overflow-auto pointer-events-none m-0`,
          )}
          dangerouslySetInnerHTML={{ __html: displayHtml }}
        />
        {/* 编辑层（透明文字，保留原生光标与 Ctrl+Z）*/}
        <textarea
          ref={taRef}
          value={code}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={placeholder}
          className={clsx(
            `[grid-area:1/1] ${SHARED} ${minH} text-transparent caret-text-primary bg-transparent resize-none focus:outline-none [text-decoration:none] [&::spelling-error]:no-underline`,
            placeholder && 'placeholder:text-text-secondary placeholder:opacity-50',
          )}
        />
      </div>
    </div>
  );
};
