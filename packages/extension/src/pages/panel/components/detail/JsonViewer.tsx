import { useRef, FC, useState } from 'react';
import { Search, Maximize2, Languages, Check, Copy } from 'lucide-react';
import { JsonTree } from '../json-tree/JsonTree';
import { SearchBar } from './SearchBar';
import { useSearchUI } from '../../hooks/useSearchUI';
import { copyToClipboard } from '../../utils/clipboard';
import { t } from '../../utils/i18n';
import { clsx } from 'clsx';

interface JsonViewerProps {
  json: any;
  onPinField?: (path: string[], value: any) => void;
  onValueChange?: (path: string[], newValue: any) => void;
  editable?: boolean;
  onFullscreen?: () => void;
  onTranslate?: (targetLang: 'en' | 'zh-TW') => void;
  translateSuccess?: boolean;
  expandedPaths?: Record<string, boolean>;
  onToggleExpand?: (paths: Record<string, boolean>) => void;
  pathPrefix?: string;
  defaultExpandDepth?: number;
  defaultRawFormats?: string[];
  defaultActionsVisible?: boolean;
  /**
   * 外部受控搜索（如 EventStream 全局搜索）。
   * 当 externalSearchQuery 非空时，接管本组件的高亮/匹配：
   * - 使用外部查询词高亮，隐藏内部搜索按钮/搜索框；
   * - externalCurrentMatchIndex 为 -1 时本视图内没有“当前项”（不高亮橙色、不滚动）；
   * - 匹配数量通过 onExternalMatchesFound 上报给外部统一统计。
   */
  externalSearchQuery?: string;
  externalCurrentMatchIndex?: number;
  externalMatchNavigationVersion?: number;
  onExternalMatchesFound?: (count: number) => void;
}

export const JsonViewer: FC<JsonViewerProps> = ({
  json,
  onPinField,
  onValueChange,
  editable = false,
  onFullscreen,
  onTranslate,
  translateSuccess,
  expandedPaths,
  onToggleExpand,
  pathPrefix = '',
  defaultExpandDepth = 2,
  defaultRawFormats,
  defaultActionsVisible = true,
  externalSearchQuery,
  externalCurrentMatchIndex,
  externalMatchNavigationVersion,
  onExternalMatchesFound,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [copied, setCopied] = useState(false);

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

  // 外部（全局）搜索激活时接管内部搜索状态
  const globalActive = !!externalSearchQuery;
  const effectiveSearchQuery = globalActive ? externalSearchQuery! : searchQuery;
  const effectiveCurrentMatchIndex = globalActive
    ? (externalCurrentMatchIndex ?? -1)
    : currentMatchIndex;
  const effectiveMatchNavigationVersion = globalActive
    ? (externalMatchNavigationVersion ?? 0)
    : matchNavigationVersion;
  const effectiveOnMatchesFound = globalActive ? onExternalMatchesFound : setTotalMatches;
  // 全局搜索接管时，内部搜索框即使 showSearch 为 true 也不渲染，避免同一棵树两个查询词冲突
  const showInternalSearch = showSearch && !globalActive;

  const handleCopy = async () => {
    const text = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleTranslate = (lang: 'en' | 'zh-TW') => {
    setShowLangMenu(false);
    onTranslate?.(lang);
  };

  return (
    <div ref={containerRef} className="group border border-border rounded bg-bg-secondary">
      {/* 顶部固定区域：搜索按钮或搜索栏（使用 sticky 固定在滚动容器顶部） */}
      <div
        className={clsx(
          `sticky top-0 z-10 p-0.5 bg-bg-secondary rounded-t ${
            showInternalSearch ? 'border-b border-border' : ''
          }`,
        )}
      >
        {/* 搜索和全屏按钮（当搜索框未显示时） */}
        {!showInternalSearch && (
          <div
            className={clsx(
              `absolute top-1 right-1 flex items-center gap-0.5 z-20 transition-opacity ${
                defaultActionsVisible
                  ? 'opacity-100'
                  : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'
              }`,
            )}
          >
            <button
              onClick={handleCopy}
              className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              title={t('copy')}
            >
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
            {!globalActive && (
              <button
                onClick={() => setShowSearch(true)}
                className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                title="Search (Ctrl/Cmd+F)"
              >
                <Search size={12} />
              </button>
            )}
            {/* 翻译按钮 */}
            {editable && onTranslate && (
              <div className="relative">
                <button
                  onClick={() => setShowLangMenu(!showLangMenu)}
                  className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  title={t('translate')}
                >
                  {translateSuccess ? (
                    <Check size={12} className="text-green-500" />
                  ) : (
                    <Languages size={12} />
                  )}
                </button>
                {/* 语言选择下拉框 */}
                {showLangMenu && (
                  <div className="absolute top-full right-0 mt-1 bg-bg-primary border border-border rounded shadow-lg overflow-hidden z-30 min-w-30">
                    <button
                      onClick={() => handleTranslate('en')}
                      className="w-full px-3 py-1.5 text-left text-xxs text-text-primary hover:bg-bg-hover transition-colors"
                    >
                      {t('english')}
                    </button>
                    <button
                      onClick={() => handleTranslate('zh-TW')}
                      className="w-full px-3 py-1.5 text-left text-xxs text-text-primary hover:bg-bg-hover transition-colors"
                    >
                      {t('traditionalChinese')}
                    </button>
                  </div>
                )}
              </div>
            )}
            {onFullscreen && (
              <button
                onClick={onFullscreen}
                className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                title={t('fullscreen')}
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
        )}

        {/* 搜索栏（固定在顶部） */}
        {showInternalSearch && (
          <SearchBar
            searchQuery={inputValue}
            currentMatchIndex={currentMatchIndex}
            totalMatches={totalMatches}
            onSearchChange={setInputValue}
            onPrevMatch={handlePrevMatch}
            onNextMatch={handleNextMatch}
            onClose={handleClose}
            searchInputRef={searchInputRef}
            compact={true}
            inputBgStyle="white"
            enablePicker={true}
          />
        )}
      </div>

      {/* JSON 内容（可滚动） */}
      <div className="p-2 overflow-x-auto max-h-none">
        <pre className="font-mono text-2xs">
          {editable ? (
            <JsonTree
              data={json}
              onPinField={onPinField}
              onValueChange={onValueChange}
              editable={editable}
              searchQuery={effectiveSearchQuery}
              currentMatchIndex={effectiveCurrentMatchIndex}
              matchNavigationVersion={effectiveMatchNavigationVersion}
              onMatchesFound={effectiveOnMatchesFound}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              pathPrefix={pathPrefix}
              defaultExpandDepth={defaultExpandDepth}
              defaultRawFormats={defaultRawFormats}
            />
          ) : (
            <JsonTree
              data={json}
              onPinField={onPinField}
              searchQuery={effectiveSearchQuery}
              currentMatchIndex={effectiveCurrentMatchIndex}
              matchNavigationVersion={effectiveMatchNavigationVersion}
              onMatchesFound={effectiveOnMatchesFound}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              pathPrefix={pathPrefix}
              defaultExpandDepth={defaultExpandDepth}
              defaultRawFormats={defaultRawFormats}
            />
          )}
        </pre>
      </div>
    </div>
  );
};
