import { useState, useRef, useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Save, Loader2, Check, X } from 'lucide-react';
import { clsx } from 'clsx';
import { showToast } from '../utils/toast';

export interface RequestSaveChoice<T> {
  id: string | number;
  label: string;
  value: T;
}
export interface RequestSaveLabels {
  create: string;
  update: string;
  search: string;
  empty: string;
  failed: string;
}
interface RequestSaveButtonProps<T, R> {
  reference?: R;
  onReferenceChange(reference: R): void;
  persistConfig?: boolean;
  onSaveComplete?(): void;
  labels: RequestSaveLabels;
  loadChoices(search: string): Promise<{ success: boolean; data?: RequestSaveChoice<T>[] }>;
  save(
    choice: T | undefined,
    reference: R | undefined,
  ): Promise<{ success: boolean; error?: string; reference?: R }>;
}

/** The host owns inline controls and their portal so they share page focus and geometry. */
export function RequestSaveButton<T, R>({
  reference,
  onReferenceChange,
  persistConfig = true,
  onSaveComplete,
  labels,
  loadChoices,
  save,
}: RequestSaveButtonProps<T, R>) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [suites, setSuites] = useState<RequestSaveChoice<T>[]>([]);
  const [suiteSearch, setSuiteSearch] = useState('');
  const [loadingSuites, setLoadingSuites] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [localReference, setLocalReference] = useState<R | undefined>(reference);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  // 是否已保存过
  const hasSavedConfig = !!localReference;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suiteSearchInputRef = useRef<HTMLInputElement>(null);

  // 外部引用变化时同步按钮的保存状态
  useEffect(() => {
    setLocalReference(reference);
  }, [reference]);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  // 清理 debounce
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, []);

  // 下拉打开时聚焦搜索框（用 JS 聚焦避免跨 frame autoFocus 被拦截）
  useEffect(() => {
    if (showDropdown) requestAnimationFrame(() => suiteSearchInputRef.current?.focus());
  }, [showDropdown]);

  const fetchSuites = async (searchName?: string) => {
    setLoadingSuites(true);
    try {
      const response = await loadChoices(searchName ?? '');
      if (response.success && response.data) {
        setSuites(response.data);
      }
    } catch (e) {
      console.error('[RequestSaveButton] Failed to fetch suites:', e);
    } finally {
      setLoadingSuites(false);
    }
  };

  const handleOpenDropdown = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (saving) return;

    // 已保存过的用例，直接更新
    if (localReference) {
      handleSave();
      return;
    }

    // 未保存过，显示下拉选择用例集
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.right - 192 });
    }
    setSuiteSearch('');
    const nextVisible = !showDropdown;
    setShowDropdown(nextVisible);
    if (nextVisible) {
      fetchSuites('');
    }
  };

  const handleSearchChange = (value: string) => {
    setSuiteSearch(value);
    // debounce 远程搜索
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = setTimeout(() => {
      fetchSuites(value);
    }, 300);
  };

  // 统一的保存/更新逻辑
  const handleSave = async (suite?: RequestSaveChoice<T>) => {
    if (suite) {
      setShowDropdown(false);
    }
    setSaving(true);
    try {
      const response = await save(suite?.value, localReference);
      if (response.success && response.reference !== undefined && !localReference) {
        if (persistConfig) {
          setLocalReference(response.reference);
          onReferenceChange(response.reference);
        } else {
          setLocalReference(undefined);
          onSaveComplete?.();
        }
      }

      if (response.success) {
        setSaveStatus('success');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        throw new Error(response.error || labels.failed);
      }
    } catch (err) {
      console.error('[RequestSaveButton] Error:', err);
      setSaveStatus('error');
      showToast(err instanceof Error ? err.message : labels.failed, 'error');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative inline-flex items-center" onClick={e => e.stopPropagation()}>
      <button
        ref={buttonRef}
        onClick={handleOpenDropdown}
        disabled={saving}
        title={hasSavedConfig ? labels.update : labels.create}
        className={clsx(
          `p-0.5 rounded transition-colors disabled:opacity-50 ${
            saveStatus === 'success'
              ? 'text-green-500'
              : saveStatus === 'error'
                ? 'text-red-500'
                : hasSavedConfig
                  ? 'text-blue-500 hover:text-blue-600 hover:bg-bg-secondary'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-secondary'
          }`,
        )}
      >
        {saving ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : saveStatus === 'success' ? (
          <Check className="w-3.5 h-3.5" />
        ) : saveStatus === 'error' ? (
          <X className="w-3.5 h-3.5" />
        ) : (
          <Save className="w-3.5 h-3.5" />
        )}
      </button>
      {showDropdown &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ top: dropdownPos.top, left: Math.max(0, dropdownPos.left) }}
            className="fixed z-50 bg-bg-primary border border-border rounded shadow-lg w-48 max-h-52 overflow-hidden flex flex-col"
          >
            <div className="p-1.5 border-b border-border shrink-0">
              <input
                type="text"
                value={suiteSearch}
                onChange={e => handleSearchChange(e.target.value)}
                onClick={e => e.stopPropagation()}
                placeholder={labels.search}
                ref={suiteSearchInputRef}
                className="w-full px-1.5 py-0.5 text-2xs rounded bg-bg-secondary text-text-primary border border-border focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {loadingSuites ? (
                <div className="flex items-center justify-center py-4 text-text-secondary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                </div>
              ) : suites.length === 0 ? (
                <div className="px-2 py-3 text-xxs text-text-secondary text-center">
                  {labels.empty}
                </div>
              ) : (
                suites.map(suite => (
                  <button
                    key={suite.id}
                    onClick={e => {
                      e.stopPropagation();
                      handleSave(suite);
                    }}
                    className="w-full text-left px-2 py-1 text-xxs text-text-primary hover:bg-bg-hover transition-colors truncate block"
                  >
                    {suite.label}
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
