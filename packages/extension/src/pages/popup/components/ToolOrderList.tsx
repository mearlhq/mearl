import { useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, GripHorizontal, GripVertical } from 'lucide-react';
import { t } from '../../panel/utils/i18n';

interface ToolOrderListProps {
  tools: { id: string; title: string }[];
  pinnedCount: number;
  onOrderChange: (order: string[]) => void;
  onPinnedCountChange: (count: number) => void;
}

export function ToolOrderList({
  tools,
  pinnedCount,
  onOrderChange,
  onPinnedCountChange,
}: ToolOrderListProps) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // 原生拖放事件可能连续触发，提交位置使用同步引用，渲染状态只负责提示。
  const dragRef = useRef<{ id: string | null; index: number | null }>({ id: null, index: null });
  const dividerRef = useRef<HTMLDivElement>(null);
  const count = Math.min(pinnedCount, tools.length);

  const clearDrag = () => {
    dragRef.current = { id: null, index: null };
    setDragged(null);
    setDropIndex(null);
  };
  const startDrag = (event: DragEvent, id: string) => {
    dragRef.current = { id, index: null };
    setDragged(id);
    setDropIndex(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };
  const moveTool = (id: string, target: number) => {
    const ids = tools.map(tool => tool.id);
    const from = ids.indexOf(id);
    if (from < 0 || from === target) return;
    ids.splice(from, 1);
    ids.splice(target, 0, id);
    onOrderChange(ids);
  };
  const dragOver = (event: DragEvent, index: number) => {
    if (!dragRef.current.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dragRef.current.index = index;
    setDropIndex(index);
  };
  const isDropTarget = (index: number) => {
    if (dropIndex !== index) return false;
    if (dragged === 'divider') return index !== count;
    const from = tools.findIndex(tool => tool.id === dragged);
    return from >= 0 && index !== from && index !== from + 1;
  };
  const dropMarker = (index: number) =>
    isDropTarget(index) ? (
      <span
        data-tool-drop-indicator
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-px z-10 border-t border-accent-blue"
      />
    ) : null;

  const divider = (
    <li key="divider" onDragOver={event => dragOver(event, count)} className="relative z-10 h-0">
      <div
        ref={dividerRef}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('toolboxTopToolsDivider')}
        aria-valuemin={0}
        aria-valuemax={tools.length}
        aria-valuenow={count}
        tabIndex={0}
        draggable
        title={t('toolboxTopToolsDividerHint')}
        onDragStart={event => startDrag(event, 'divider')}
        onDragEnd={clearDrag}
        onKeyDown={event => {
          const next =
            event.key === 'ArrowUp'
              ? count - 1
              : event.key === 'ArrowDown'
                ? count + 1
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tools.length
                    : null;
          if (next === null) return;
          event.preventDefault();
          onPinnedCountChange(Math.max(0, Math.min(tools.length, next)));
          requestAnimationFrame(() => dividerRef.current?.focus());
        }}
        className={`absolute left-1/2 flex h-3 w-4 -translate-x-1/2 cursor-grab items-center justify-center rounded-sm bg-bg-primary text-text-secondary outline-none hover:bg-bg-hover hover:text-accent-blue focus-visible:ring-1 focus-visible:ring-accent-blue active:cursor-grabbing ${count === 0 ? 'top-0' : count === tools.length ? 'bottom-0' : '-top-px -translate-y-1/2'} ${dragged === 'divider' ? 'opacity-40' : ''}`}
      >
        <GripHorizontal className="h-3 w-3" aria-hidden="true" />
      </div>
    </li>
  );

  const toolRows = tools.map((tool, index) => (
    <li
      key={tool.id}
      data-tool-id={tool.id}
      draggable
      onDragStart={event => startDrag(event, tool.id)}
      onDragOver={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        dragOver(event, index + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0));
      }}
      className={`relative flex items-center gap-2 border-b px-3 py-2 text-text-primary ${index === count - 1 ? 'border-accent-blue/60' : 'border-border'} ${dragged === tool.id ? 'opacity-40' : ''}`}
    >
      {dropMarker(index)}
      <GripVertical
        className="h-3.5 w-3.5 shrink-0 cursor-grab text-text-secondary"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-xs">{tool.title}</span>
      <button
        type="button"
        disabled={index === 0}
        draggable={false}
        onClick={() => moveTool(tool.id, index - 1)}
        className="cursor-pointer rounded p-1 text-text-secondary hover:bg-bg-hover disabled:opacity-30"
        aria-label={t('toolboxMoveUp', tool.title)}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled={index === tools.length - 1}
        draggable={false}
        onClick={() => moveTool(tool.id, index + 1)}
        className="cursor-pointer rounded p-1 text-text-secondary hover:bg-bg-hover disabled:opacity-30"
        aria-label={t('toolboxMoveDown', tool.title)}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
    </li>
  ));
  toolRows.splice(count, 0, divider);

  return (
    <ul
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          dragRef.current.index = null;
          setDropIndex(null);
        }
      }}
      onDrop={event => {
        event.preventDefault();
        const { id, index } = dragRef.current;
        if (id && index !== null) {
          if (id === 'divider') onPinnedCountChange(index);
          else {
            const from = tools.findIndex(tool => tool.id === id);
            moveTool(id, index - (from < index ? 1 : 0));
          }
        }
        clearDrag();
      }}
      onDragEnd={clearDrag}
      className="min-h-0 overflow-auto rounded border border-border bg-bg-primary"
    >
      {toolRows}
      <li aria-hidden="true" className="relative h-0">
        {dropMarker(tools.length)}
      </li>
    </ul>
  );
}
