import { FC, ReactNode, useRef } from 'react';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import { JsonTree } from './JsonTree';
import { SearchBar } from '../detail/SearchBar';
import { useSearchUI } from '../../hooks/useSearchUI';
import { t } from '../../utils/i18n';

interface SearchableJsonTreeProps {
  data: any;
  editable?: boolean;
  onValueChange?: (path: string[], newValue: any) => void;
  onPinField?: (path: string[], value: any) => void;
  /** 外层容器 class（边框/背景/圆角等） */
  className?: string;
  /** JSON 文本字号 class，默认 text-xxs */
  textClassName?: string;
  /** data 非可渲染对象时展示的占位内容（不传则始终渲染树） */
  empty?: ReactNode;
}

const isRenderable = (data: any) => data != null && typeof data === 'object';

/**
 * {@link JsonTree} 的轻量封装：内置搜索交互，可直接作为「树形模式」与 {@link CodeEditor}
 * 的「代码模式」配对使用。交互与 CodeEditor 对齐：右上角悬浮搜索按钮 + Cmd/Ctrl+F 唤起
 * 搜索栏，搜索状态复用全局 {@link useSearchUI}（与 JsonViewer / PinnedFieldItem 一致）。
 *
 * 与 detail/JsonViewer 的区别：本组件只做「树 + 搜索」，样式（className/字号/空态）可配置；
 * JsonViewer 额外带复制/翻译/全屏等操作且样式固定，面向详情面板场景。
 */
export const SearchableJsonTree: FC<SearchableJsonTreeProps> = ({
  data,
  editable,
  onValueChange,
  onPinField,
  className = '',
  textClassName = 'text-xxs',
  empty,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    searchQuery,
    inputValue,
    setInputValue,
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
  } = useSearchUI(containerRef);

  const btnCls =
    'p-0.5 rounded transition-opacity opacity-0 group-hover:opacity-100 text-text-secondary hover:text-text-primary hover:bg-bg-hover';

  const showEmpty = !isRenderable(data) && empty !== undefined;

  return (
    <div
      ref={containerRef}
      className={clsx(`group relative flex flex-col overflow-hidden ${className}`)}
    >
      {!showSearch && (
        <div className="absolute top-1 right-1 z-10 flex gap-0.5">
          <button
            onClick={() => setShowSearch(true)}
            className={btnCls}
            title={t('searchShortcut')}
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {showSearch && (
        <div className="shrink-0 border-b border-border bg-bg-secondary">
          <SearchBar
            searchQuery={inputValue}
            currentMatchIndex={currentMatchIndex}
            totalMatches={totalMatches}
            onSearchChange={setInputValue}
            onPrevMatch={handlePrevMatch}
            onNextMatch={handleNextMatch}
            onClose={handleClose}
            searchInputRef={searchInputRef}
            compact
            inputBgStyle="white"
            enablePicker
          />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {showEmpty ? (
          empty
        ) : (
          <pre className={clsx(`font-mono ${textClassName}`)}>
            <JsonTree
              data={data}
              editable={editable}
              onValueChange={onValueChange}
              onPinField={onPinField}
              searchQuery={searchQuery}
              currentMatchIndex={currentMatchIndex}
              matchNavigationVersion={matchNavigationVersion}
              onMatchesFound={setTotalMatches}
            />
          </pre>
        )}
      </div>
    </div>
  );
};
