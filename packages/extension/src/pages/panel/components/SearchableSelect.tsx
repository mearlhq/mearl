import { useState, useEffect, useRef, FC, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSafeFocus } from '../../../shared/hooks/useSafeFocus';
import { clsx } from 'clsx';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SearchableSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  searchPlaceholder?: string;
  noDataText?: string;
  minWidth?: string;
  /** Whether to show the search input. Default true. Set to false for short option lists. */
  searchable?: boolean;
  /** Override the default trigger button className (otherwise the built-in compact style is used). */
  triggerClassName?: string;
  /** Override the dropdown panel width / extra className (default: w-64). */
  panelClassName?: string;
  /** Fully custom trigger content. When set, the default label+chevron layout is replaced. */
  triggerContent?: ReactNode;
  /** Optional native title for the trigger (tooltip). */
  triggerTitle?: string;
  /** Horizontal alignment of the dropdown panel relative to the trigger. Default 'left'. */
  align?: 'left' | 'right';
  /** Prevent opening or changing the current value. */
  disabled?: boolean;
  /** Accessible label for triggers whose visible content is not descriptive enough. */
  ariaLabel?: string;
}

export const SearchableSelect: FC<SearchableSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  className = '',
  searchPlaceholder = 'Search...',
  noDataText = 'No data',
  minWidth = 'min-w-32',
  searchable = true,
  triggerClassName,
  panelClassName,
  triggerContent,
  triggerTitle,
  align = 'left',
  disabled = false,
  ariaLabel,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useSafeFocus(searchInputRef, { enabled: isOpen && searchable });

  // 获取当前选中的选项
  const selectedOption = options.find(opt => opt.value === value);

  // 过滤选项列表（仅在启用搜索时依据输入过滤）
  const filteredOptions = searchable
    ? options.filter(
        opt =>
          opt.label.toLowerCase().includes(searchInput.toLowerCase()) ||
          opt.value.toLowerCase().includes(searchInput.toLowerCase()) ||
          (opt.description && opt.description.toLowerCase().includes(searchInput.toLowerCase())),
      )
    : options;

  // 点击外部关闭下拉框
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchInput('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setSearchInput('');
  };

  return (
    <div className={clsx(`relative ${className}`)} ref={containerRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        title={triggerTitle}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={clsx(
          triggerClassName ??
            `flex items-center gap-1 px-2 py-0.5 text-2xs rounded bg-bg-secondary text-text-primary border border-border hover:bg-bg-hover transition-colors ${minWidth}`,
          disabled && 'cursor-not-allowed',
        )}
      >
        {triggerContent ?? (
          <>
            <span
              className={clsx(
                'flex-1 text-left truncate',
                !selectedOption && 'text-text-secondary/60',
              )}
            >
              {selectedOption ? selectedOption.label : placeholder}
            </span>
            <ChevronDown size={12} />
          </>
        )}
      </button>

      {isOpen && (
        <div
          className={clsx(
            'absolute top-full mt-1 bg-bg-primary border border-border rounded shadow-lg z-50 max-h-[min(14rem,40vh)] overflow-hidden flex flex-col',
            align === 'right' ? 'right-0' : 'left-0',
            panelClassName ?? 'w-64',
          )}
        >
          {/* 搜索框（可选） */}
          {searchable && (
            <div className="shrink-0 p-2 border-b border-border">
              <input
                ref={searchInputRef}
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full px-2 py-1 text-2xs rounded bg-bg-secondary text-text-primary border border-border focus:outline-none focus:border-blue-500"
              />
            </div>
          )}

          {/* 选项列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="listbox">
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-4 text-center text-2xs text-text-secondary">{noDataText}</div>
            ) : (
              filteredOptions.map(option => (
                <div
                  key={option.value}
                  onClick={event => {
                    event.preventDefault();
                    if (!option.disabled) handleSelect(option.value);
                  }}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  className={clsx(
                    `px-2 py-1.5 text-2xs cursor-pointer transition-colors ${
                      option.disabled
                        ? 'cursor-not-allowed opacity-50'
                        : option.value === value
                          ? 'bg-blue-600 text-white'
                          : 'hover:bg-bg-hover text-text-primary'
                    }`,
                  )}
                >
                  <div className="font-medium">{option.label}</div>
                  {option.description && (
                    <div className="text-3xs opacity-75">{option.description}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
