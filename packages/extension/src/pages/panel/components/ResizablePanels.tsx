import {
  useState,
  useRef,
  useEffect,
  useCallback,
  FC,
  ReactNode,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

const STACKED_PANEL_MEDIA_QUERY = '(max-width: 719px)';

interface ResizablePanelsProps {
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  defaultLeftWidth?: number; // 百分比，例如 30 表示 30%
  minLeftWidth?: number; // 最小百分比
  maxLeftWidth?: number; // 最大百分比
  defaultTopHeight?: number; // 窄屏上方面板默认高度百分比
  minTopHeight?: number; // 窄屏上方面板最小高度百分比
  maxTopHeight?: number; // 窄屏上方面板最大高度百分比
  storageKey: string; // localStorage key
}

export const ResizablePanels: FC<ResizablePanelsProps> = ({
  leftPanel,
  rightPanel,
  defaultLeftWidth = 30,
  minLeftWidth = 15,
  maxLeftWidth = 70,
  defaultTopHeight = 40,
  minTopHeight = 25,
  maxTopHeight = 70,
  storageKey,
}) => {
  const [leftWidth, setLeftWidth] = useLocalStorage<number>(storageKey, defaultLeftWidth);
  const [topHeight, setTopHeight] = useLocalStorage<number>(
    `${storageKey}-stacked-height`,
    defaultTopHeight,
  );
  const [isStacked, setIsStacked] = useState(
    () => window.matchMedia(STACKED_PANEL_MEDIA_QUERY).matches,
  );
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDoubleClick = () => {
    if (isStacked) {
      setTopHeight(defaultTopHeight);
      return;
    }
    setLeftWidth(defaultLeftWidth);
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia(STACKED_PANEL_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setIsStacked(event.matches);

    setIsStacked(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const handleMouseMove = useCallback(
    (e: Event) => {
      if (!isDragging || !containerRef.current) return;

      const container = containerRef.current;
      const containerRect = container.getBoundingClientRect();
      const mouseEvent = e as globalThis.MouseEvent;

      if (isStacked) {
        const mouseY = mouseEvent.clientY - containerRect.top;
        const nextTopHeight = (mouseY / containerRect.height) * 100;
        setTopHeight(Math.max(minTopHeight, Math.min(maxTopHeight, nextTopHeight)));
        return;
      }

      const mouseX = mouseEvent.clientX - containerRect.left;
      const nextLeftWidth = (mouseX / containerRect.width) * 100;
      setLeftWidth(Math.max(minLeftWidth, Math.min(maxLeftWidth, nextLeftWidth)));
    },
    [
      isDragging,
      isStacked,
      minLeftWidth,
      maxLeftWidth,
      minTopHeight,
      maxTopHeight,
      setLeftWidth,
      setTopHeight,
    ],
  );

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
    }
  }, [isDragging]);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = isStacked ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isDragging, isStacked, handleMouseMove, handleMouseUp]);

  const firstPanelStyle = isStacked
    ? { width: '100%', height: `${topHeight}%`, minHeight: 'min(7rem, 55%)' }
    : { width: `${leftWidth}%`, height: '100%' };
  const secondPanelStyle = isStacked
    ? { width: '100%', flex: 1 }
    : { width: `${100 - leftWidth}%`, height: '100%' };

  return (
    <div
      ref={containerRef}
      className={`flex flex-1 min-w-0 min-h-0 overflow-hidden relative ${isStacked ? 'flex-col' : 'flex-row'}`}
    >
      {/* 左侧／上方面板 */}
      <div style={firstPanelStyle} className="flex-none min-w-0 min-h-0 overflow-hidden">
        {leftPanel}
      </div>

      {/* 分隔条 */}
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        role="separator"
        aria-orientation={isStacked ? 'horizontal' : 'vertical'}
        aria-valuemin={isStacked ? minTopHeight : minLeftWidth}
        aria-valuemax={isStacked ? maxTopHeight : maxLeftWidth}
        aria-valuenow={isStacked ? topHeight : leftWidth}
        className={`bg-border shrink-0 relative group ${
          isStacked ? 'h-px w-full cursor-row-resize' : 'h-full w-px cursor-col-resize'
        }`}
      >
        {/* 增加拖拽热区 */}
        <div
          className={
            isStacked
              ? 'absolute inset-x-0 -top-1 -bottom-1 h-3'
              : 'absolute inset-y-0 -left-1 -right-1 w-3'
          }
        />
      </div>

      {/* 右侧／下方面板 */}
      <div style={secondPanelStyle} className="flex-none min-w-0 min-h-0 overflow-hidden">
        {rightPanel}
      </div>
    </div>
  );
};
