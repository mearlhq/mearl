import { useEffect, useMemo, useRef, useState, FC } from 'react';
import { AlertCircle, Search } from 'lucide-react';
import { JsonTree } from '../json-tree/JsonTree';
import { CopyButton } from '../CopyButton';
import { SearchBar } from '../detail/SearchBar';
import { CodeEditor } from '../CodeEditor';
import { formatJsonForEditor, parseJsonTextForEditor } from '../../utils/jsonEditor';
import { Modal, ModalHeader, ModalContent, ModalFooter } from './Modal';
import { JsonKeyboardHints } from '../JsonKeyboardHints';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useSearchUI } from '../../hooks/useSearchUI';
import { t } from '../../utils/i18n';
import { clsx } from 'clsx';

interface JsonModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  data: any;
  onPinField?: (path: string[], value: any) => void;
  expandedPaths?: Record<string, boolean>;
  onToggleExpand?: (paths: Record<string, boolean>) => void;
  pathPrefix?: string;
  initialPath?: string[];
  editable?: boolean;
  onValueChange?: (path: string[], newValue: any) => void;
}

type JsonModalViewMode = 'tree' | 'code';

const JSON_MODAL_VIEW_MODE_STORAGE_KEY = 'json-modal-view-mode';

export const JsonModal: FC<JsonModalProps> = ({
  isOpen,
  onClose,
  title,
  data,
  onPinField,
  expandedPaths,
  onToggleExpand,
  pathPrefix = '',
  initialPath,
  editable = false,
  onValueChange,
}) => {
  const [viewMode, setViewMode] = useLocalStorage<JsonModalViewMode>(
    JSON_MODAL_VIEW_MODE_STORAGE_KEY,
    'tree',
  );
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
  const [codeText, setCodeText] = useState<string>(formatJsonForEditor(data));
  const [codeError, setCodeError] = useState<string>('');
  const formattedJson = useMemo(() => formatJsonForEditor(data), [data]);
  const prevIsOpenRef = useRef<boolean>(false);
  const prevViewModeRef = useRef<JsonModalViewMode>(viewMode);

  const handleCodeChange = (value: string) => {
    setCodeText(value);

    if (!editable || !onValueChange) {
      return;
    }

    const { error } = parseJsonTextForEditor(value, t('invalidJsonFormat'), {
      includeErrorPrefix: true,
    });

    setCodeError(error || '');
  };

  const handleCodeSave = () => {
    if (!editable || !onValueChange) return;

    const { parsed, error } = parseJsonTextForEditor(codeText, t('invalidJsonFormat'), {
      includeErrorPrefix: true,
    });

    if (error) {
      setCodeError(error);
      return;
    }

    setCodeError('');
    onValueChange([], parsed);
  };

  const handleCodeFormat = () => {
    const { parsed, error } = parseJsonTextForEditor(codeText, t('invalidJsonFormat'), {
      includeErrorPrefix: true,
    });
    if (error) {
      setCodeError(error);
      return;
    }
    setCodeText(formatJsonForEditor(parsed));
    setCodeError('');
  };

  const handleCodeCancel = () => {
    setCodeText(formattedJson);
    setCodeError('');
  };

  // 当弹窗关闭时清理搜索状态
  useEffect(() => {
    if (!isOpen) {
      setShowSearch(false);
      setInputValue('');
      setTotalMatches(0);
      setCodeError('');
    }
  }, [isOpen, setShowSearch, setInputValue, setTotalMatches]);

  useEffect(() => {
    const hasOpened = isOpen && !prevIsOpenRef.current;
    const switchedToCode = isOpen && viewMode === 'code' && prevViewModeRef.current !== 'code';

    if (hasOpened || switchedToCode) {
      setCodeText(formatJsonForEditor(data));
      setCodeError('');
    }

    prevIsOpenRef.current = isOpen;
    prevViewModeRef.current = viewMode;
  }, [data, isOpen, viewMode]);

  // 切换树形/代码模式时重置匹配数，由新视图重新上报
  useEffect(() => {
    setTotalMatches(0);
  }, [viewMode, setTotalMatches]);

  const handleSearchToggle = () => {
    if (showSearch) {
      handleClose();
    } else {
      setShowSearch(true);
    }
  };

  const isSearchActive = showSearch;
  const copyText = viewMode === 'code' ? codeText : formattedJson;

  const modeButtonClass = (mode: JsonModalViewMode) =>
    `px-1.5 py-0.5 text-2xs transition-colors cursor-pointer ${
      viewMode === mode
        ? 'bg-blue-500 text-white'
        : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
    }`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="fullscreen">
      <div ref={containerRef} className="contents">
        <ModalHeader
          title={title}
          onClose={onClose}
          actions={
            <>
              <CopyButton text={copyText} />
              {viewMode === 'code' && editable && (
                <button
                  onClick={handleCodeFormat}
                  className="px-1.5 py-0.5 text-2xs rounded transition-colors cursor-pointer bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  {t('formatJson')}
                </button>
              )}
              <div className="flex items-center rounded overflow-hidden border border-border bg-bg-secondary">
                <button
                  onClick={() => setViewMode('tree')}
                  className={modeButtonClass('tree')}
                  title={t('jsonViewModeTree')}
                >
                  {t('jsonViewModeTree')}
                </button>
                <button
                  onClick={() => setViewMode('code')}
                  className={modeButtonClass('code')}
                  title={t('jsonViewModeCode')}
                >
                  {t('jsonViewModeCode')}
                </button>
              </div>
              <button
                onClick={handleSearchToggle}
                className={clsx(
                  `p-1 rounded transition-colors cursor-pointer ${
                    isSearchActive
                      ? 'bg-blue-500 text-white hover:bg-blue-600'
                      : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`,
                )}
                title="Search (Ctrl/Cmd+F)"
              >
                <Search size={12} />
              </button>
            </>
          }
        />

        {/* 搜索栏 */}
        {showSearch && (
          <div className="p-1 bg-toolbar">
            <SearchBar
              searchQuery={inputValue}
              currentMatchIndex={currentMatchIndex}
              totalMatches={totalMatches}
              onSearchChange={setInputValue}
              onPrevMatch={handlePrevMatch}
              onNextMatch={handleNextMatch}
              onClose={handleClose}
              searchInputRef={searchInputRef}
              compact={false}
              inputBgStyle="white"
              enablePicker={true}
            />
          </div>
        )}

        <ModalContent>
          {viewMode === 'tree' ? (
            <pre className="font-mono text-xxs">
              <JsonTree
                data={data}
                path={initialPath}
                onPinField={onPinField}
                editable={editable}
                onValueChange={onValueChange}
                searchQuery={searchQuery}
                currentMatchIndex={currentMatchIndex}
                matchNavigationVersion={matchNavigationVersion}
                onMatchesFound={setTotalMatches}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
                pathPrefix={pathPrefix}
              />
            </pre>
          ) : (
            <>
              <CodeEditor
                code={editable ? codeText : formattedJson}
                language="json"
                onChange={editable ? handleCodeChange : undefined}
                showToolbar={false}
                useExternalSearch={true}
                externalSearchQuery={searchQuery}
                externalCurrentMatchIndex={currentMatchIndex}
                onExternalMatchesFound={setTotalMatches}
              />
            </>
          )}
        </ModalContent>

        <ModalFooter>
          {viewMode === 'code' && editable ? (
            <div className="flex items-center justify-between w-full">
              {codeError ? (
                <div className="flex items-center gap-1.5 text-xs text-red-500 px-1 min-w-0 flex-1 mr-3">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{codeError}</span>
                </div>
              ) : (
                <div className="flex-1" />
              )}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => {
                    handleCodeCancel();
                    onClose();
                  }}
                  className="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={() => {
                    handleCodeSave();
                    if (!codeError) onClose();
                  }}
                  disabled={!!codeError}
                  className="px-2 py-1 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {t('save')}
                </button>
              </div>
            </div>
          ) : viewMode === 'code' ? (
            <JsonKeyboardHints storageKey="json-modal-code-shortcuts-visible" mode="code" />
          ) : (
            <JsonKeyboardHints storageKey="json-modal-shortcuts-visible" mode="tree" />
          )}
        </ModalFooter>
      </div>
    </Modal>
  );
};
