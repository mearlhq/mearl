import { useState, useRef, useEffect, FC, DragEvent, KeyboardEvent } from 'react';
import { Search, Maximize2, X, Check, GripVertical } from 'lucide-react';
import { PinnedField } from '../../types';
import { JsonTree } from '../json-tree/JsonTree';
import { SearchBar } from './SearchBar';
import { JsonModal } from '../modal';
import { useSearchUI } from '../../hooks/useSearchUI';
import { useSessionStorage } from '../../hooks/useSessionStorage';
import { ValueDisplay } from '../ValueDisplay';
import { t } from '../../utils/i18n';
import { useSafeFocus } from '../../../../shared/hooks/useSafeFocus';
import { clsx } from 'clsx';

interface PinnedFieldItemProps {
  field: PinnedField;
  index: number;
  onUnpin: (path: string) => void;
  onValueChange?: (path: string[], newValue: any) => void;
  editable?: boolean;
  onPinField?: (path: string[], value: any) => void;
  expandedPaths?: Record<string, boolean>;
  onToggleExpand?: (paths: Record<string, boolean>) => void;
  dragHandlers?: {
    onDragStart: (e: DragEvent) => void;
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  isDragging?: boolean;
  isDragOver?: boolean;
}

export const PinnedFieldItem: FC<PinnedFieldItemProps> = ({
  field,
  index: _index,
  onUnpin,
  onValueChange,
  editable = false,
  onPinField,
  expandedPaths,
  onToggleExpand,
  dragHandlers,
  isDragging = false,
  isDragOver = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isEditingName, setIsEditingName] = useState<boolean>(false);
  const [editedName, setEditedName] = useState<string>(field.path);
  const nameInputRef = useRef<HTMLTextAreaElement>(null);
  const editNameContainerRef = useRef<HTMLDivElement>(null);

  useSafeFocus(nameInputRef, { enabled: isEditingName });

  const getDefaultCollapsed = (value: any): boolean => {
    if (value === null || value === undefined) return true;
    if (typeof value === 'object') return false;
    return true;
  };

  const [isCollapsed, setIsCollapsed] = useSessionStorage<boolean>(
    `pinned-field-collapsed-${field.path}`,
    getDefaultCollapsed(field.value),
  );

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

  // 自适应高度
  useEffect(() => {
    if (nameInputRef.current && isEditingName) {
      const textarea = nameInputRef.current;
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [editedName, isEditingName]);

  useEffect(() => {
    if (!isEditingName) return;

    const handlePointerDownOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (editNameContainerRef.current?.contains(target)) return;
      handleNameCancel();
    };

    document.addEventListener('pointerdown', handlePointerDownOutside, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside, true);
    };
  }, [isEditingName]);

  // 将字符串路径转换为数组路径，供 JsonTree 使用
  const basePath = field.path.split('.');

  const handleNameEdit = () => {
    setIsEditingName(true);
    setEditedName(field.path);
  };

  const handleNameSave = () => {
    if (editedName.trim() && editedName !== field.path) {
      // 先取消关注旧字段，再关注新字段
      onUnpin(field.path);
      if (onPinField) {
        const newPath = editedName.split('.');
        onPinField(newPath, field.value);
      }
    }
    setIsEditingName(false);
  };

  const handleNameCancel = () => {
    setEditedName(field.path);
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleNameSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleNameCancel();
    }
  };

  const handleDragStart = (e: DragEvent) => {
    if (containerRef.current) {
      e.dataTransfer.setDragImage(containerRef.current, 0, 0);
    }
    dragHandlers?.onDragStart(e);
  };

  return (
    <>
      <div
        ref={containerRef}
        onDragEnter={dragHandlers?.onDragEnter}
        onDragOver={dragHandlers?.onDragOver}
        onDragEnd={dragHandlers?.onDragEnd}
        className={clsx(
          `relative border rounded group bg-bg-primary transition-all ${
            isDragging ? 'opacity-40' : ''
          } ${isDragOver ? 'border-accent-blue' : 'border-border'}`,
        )}
      >
        {/* 拖拽手柄 - 绝对定位不占用空间 */}
        {!isEditingName && dragHandlers && (
          <div
            draggable={true}
            onDragStart={handleDragStart}
            className="absolute left-px top-0 bottom-0 flex items-center cursor-grab active:cursor-grabbing text-text-secondary hover:text-text-primary opacity-0 hover:opacity-100 transition-opacity pointer-events-auto"
            title={t('dragToReorder')}
          >
            <GripVertical size={12} className="shrink-0" />
          </div>
        )}
        <div className="flex items-start justify-between px-2 py-1 leading-5">
          <div className="font-medium font-mono flex-1 text-2xs break-all flex items-center gap-1">
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="w-4 h-4 flex items-center justify-center shrink-0 transition-colors text-text-secondary hover:text-text-primary focus:outline-none text-xxs font-bold"
            >
              {isCollapsed ? '+' : '−'}
            </button>
            {isEditingName ? (
              <div ref={editNameContainerRef} className="contents">
                <textarea
                  ref={nameInputRef}
                  value={editedName}
                  onChange={e => setEditedName(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  onBlur={handleNameCancel}
                  className="flex-1 -ml-1.5 -translate-y-px px-1.25 py-0 border border-accent-blue rounded text-2xs font-mono bg-bg-secondary text-text-primary outline-none min-w-25 resize-none overflow-hidden whitespace-break-spaces break-all"
                  rows={1}
                />
                <button
                  onMouseDown={e => {
                    e.preventDefault();
                    handleNameSave();
                  }}
                  className="p-0.5 rounded text-2xs bg-green-500 text-white cursor-pointer"
                  title={t('save')}
                >
                  <Check size={12} />
                </button>
                <button
                  onMouseDown={e => {
                    e.preventDefault();
                    handleNameCancel();
                  }}
                  className="p-0.5 rounded text-2xs bg-red-500 text-white cursor-pointer"
                  title={t('cancel')}
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <>
                <span
                  className="text-accent-blue cursor-pointer hover:opacity-80 min-w-0 break-all"
                  onClick={handleNameEdit}
                >
                  {field.path}
                </span>
                {isCollapsed && (
                  <span className="font-normal">
                    <ValueDisplay value={field.value} />
                  </span>
                )}
              </>
            )}
          </div>
          {!isEditingName && (
            <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => onUnpin(field.path)}
                className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-red-600 hover:text-white"
                title={t('unpinField')}
              >
                <X size={12} />
              </button>
              {!showSearch && (
                <>
                  <button
                    onClick={() => setShowSearch(true)}
                    className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    title="Search (Ctrl/Cmd+F)"
                  >
                    <Search size={12} />
                  </button>
                  <button
                    onClick={() => setIsFullscreen(true)}
                    className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    title={t('fullscreen')}
                  >
                    <Maximize2 size={12} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 搜索栏 */}
        {!isCollapsed && showSearch && (
          <div className="px-2 pb-1">
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
              inputBgStyle="secondary"
            />
          </div>
        )}

        {!isCollapsed && (
          <div className="px-2 pb-2 font-mono text-2xs break-all overflow-x-auto overflow-y-auto">
            {field.value === null || field.value === undefined ? (
              <span className="text-text-secondary">null</span>
            ) : editable ? (
              <JsonTree
                data={field.value}
                path={basePath}
                onValueChange={onValueChange}
                onPinField={onPinField}
                editable={true}
                searchQuery={searchQuery}
                currentMatchIndex={currentMatchIndex}
                matchNavigationVersion={matchNavigationVersion}
                onMatchesFound={setTotalMatches}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
                pathPrefix={`pinned-${field.path}`}
              />
            ) : (
              <JsonTree
                data={field.value}
                path={basePath}
                onPinField={onPinField}
                searchQuery={searchQuery}
                currentMatchIndex={currentMatchIndex}
                matchNavigationVersion={matchNavigationVersion}
                onMatchesFound={setTotalMatches}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
                pathPrefix={`pinned-${field.path}`}
              />
            )}
          </div>
        )}
      </div>

      {/* 全屏模态框 */}
      <JsonModal
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        title={field.path}
        data={field.value}
        initialPath={basePath}
        onPinField={onPinField}
        expandedPaths={expandedPaths}
        onToggleExpand={onToggleExpand}
        pathPrefix={`pinned-${field.path}`}
      />
    </>
  );
};
