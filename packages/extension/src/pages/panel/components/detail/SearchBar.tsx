import { FC, RefObject } from 'react';
import { ChevronUp, ChevronDown, X, Crosshair } from 'lucide-react';
import { t } from '../../utils/i18n';
import { useElementPicker } from '../../hooks/useElementPicker';
import { clsx } from 'clsx';

interface SearchBarProps {
  searchQuery: string;
  currentMatchIndex: number;
  totalMatches: number;
  onSearchChange: (value: string) => void;
  onPrevMatch: () => void;
  onNextMatch: () => void;
  onClose: () => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  compact?: boolean;
  inputBgStyle?: 'white' | 'secondary';
  enablePicker?: boolean;
  // 内联模式：去掉外层内边距，输入框高度贴合所在行（如固定在区块标题栏时），不撑高原有布局
  inline?: boolean;
  // 自定义占位符（默认使用「在 JSON 中搜索...」）
  placeholder?: string;
}

export const SearchBar: FC<SearchBarProps> = ({
  searchQuery,
  currentMatchIndex,
  totalMatches,
  onSearchChange,
  onPrevMatch,
  onNextMatch,
  onClose,
  searchInputRef,
  compact = false,
  inputBgStyle = 'secondary',
  enablePicker = false,
  inline = false,
  placeholder,
}) => {
  const dense = compact || inline;
  const padding = dense ? 'p-0.5' : 'p-1';
  const { isPicking, toggle: handlePickClick } = useElementPicker({ onPicked: onSearchChange });

  return (
    <div
      className={clsx(
        `flex w-full min-w-0 items-center ${inline ? 'gap-0.5' : 'gap-1'} ${
          inline ? '' : compact ? 'p-1' : 'px-2 py-1.5 bg-toolbar'
        }`,
      )}
    >
      <div className={clsx('relative flex-1 min-w-0', inline && 'mr-1')}>
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) {
                onPrevMatch();
              } else {
                onNextMatch();
              }
            } else if (e.key === 'Escape' && searchQuery) {
              e.preventDefault();
              onSearchChange('');
            }
          }}
          placeholder={
            isPicking
              ? t('pickingElement') || 'Click element…'
              : placeholder || t('searchInJson') || 'Search...'
          }
          className={clsx(
            `w-full min-w-0 px-1.5 border border-border rounded outline-none text-text-primary ${
              inline ? 'h-5 py-0 text-2xs' : compact ? 'py-0.5 text-2xs' : 'py-1 text-xs'
            } ${inline && searchQuery ? 'pr-5' : ''} ${
              inputBgStyle === 'white' ? 'bg-white dark:bg-neutral-800' : 'bg-bg-secondary'
            }`,
          )}
        />
        {/* 内联模式：清空按钮内嵌在输入框内（有内容时显示） */}
        {inline && searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-0.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-secondary hover:text-text-primary"
            title={t('clear')}
          >
            <X size={10} />
          </button>
        )}
      </div>
      {searchQuery && (
        <>
          <span
            className={clsx(
              `shrink-0 whitespace-nowrap text-text-secondary ${dense ? 'text-3xs' : 'text-xs'}`,
            )}
          >
            {totalMatches > 0 ? `${currentMatchIndex + 1}/${totalMatches}` : '0/0'}
          </span>
          <button
            onClick={onPrevMatch}
            disabled={totalMatches === 0}
            className={clsx(
              `shrink-0 ${padding} rounded transition-colors disabled:opacity-40 text-text-secondary hover:bg-bg-hover disabled:hover:bg-transparent`,
            )}
            title={t('prevMatch')}
          >
            <ChevronUp size={dense ? 10 : 12} />
          </button>
          <button
            onClick={onNextMatch}
            disabled={totalMatches === 0}
            className={clsx(
              `shrink-0 ${padding} rounded transition-colors disabled:opacity-40 text-text-secondary hover:bg-bg-hover disabled:hover:bg-transparent`,
            )}
            title={t('nextMatch')}
          >
            <ChevronDown size={dense ? 10 : 12} />
          </button>
        </>
      )}
      {enablePicker && (
        <button
          onClick={handlePickClick}
          className={clsx(
            `shrink-0 ${dense ? 'p-0.5' : 'p-1'} rounded transition-colors ${
              isPicking
                ? 'bg-blue-500 text-white ring-1 ring-blue-400'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`,
          )}
          title={
            isPicking
              ? t('pickingElement') || 'Picking…'
              : t('pickElementForSearch') || 'Pick element'
          }
        >
          <Crosshair size={compact ? 10 : 12} />
        </button>
      )}
      {/* 内联模式下清空按钮已内嵌在输入框内，这里不再重复渲染尾部按钮 */}
      {!inline && (
        <button
          onClick={() => {
            if (searchQuery) {
              // 有内容时，清空内容
              onSearchChange('');
            } else {
              // 没有内容时，关闭搜索框
              onClose();
            }
          }}
          className={clsx(
            `${padding} rounded transition-colors text-text-secondary hover:bg-bg-hover`,
          )}
          title={searchQuery ? t('clear') : t('close')}
        >
          <X size={dense ? 10 : 12} />
        </button>
      )}
    </div>
  );
};
