import { useEffect, useRef, FC, Fragment, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';

export interface ContextMenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // 调整菜单位置，确保不超出视口
  useEffect(() => {
    if (menuRef.current) {
      const menu = menuRef.current;
      const rect = menu.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let adjustedX = x;
      let adjustedY = y;

      // 确保菜单右边界不超出视口
      if (x + rect.width > viewportWidth) {
        adjustedX = Math.max(5, viewportWidth - rect.width - 5);
      }

      // 确保菜单下边界不超出视口
      if (y + rect.height > viewportHeight) {
        adjustedY = Math.max(5, viewportHeight - rect.height - 5);
      }

      // 确保菜单左边界和上边界不超出视口
      adjustedX = Math.max(5, adjustedX);
      adjustedY = Math.max(5, adjustedY);

      menu.style.left = `${adjustedX}px`;
      menu.style.top = `${adjustedY}px`;
    }
  }, [x, y]);

  const menuContent = (
    <>
      {/* 背景遮罩 */}
      <div className="fixed inset-0 z-100 bg-transparent" />

      {/* 菜单 */}
      <div
        ref={menuRef}
        className="fixed rounded shadow-lg border border-border bg-bg-primary py-0.5 min-w-32 z-101 flex flex-col"
        style={{
          left: x,
          top: y,
        }}
      >
        {items.map((item, index) => (
          <Fragment key={index}>
            {item.divider ? (
              <div className="h-px my-0.5 bg-border" />
            ) : (
              <button
                className={clsx(
                  'w-full text-left px-3 py-1.5 text-xxs transition-colors whitespace-nowrap flex items-center gap-2',
                  item.disabled
                    ? 'cursor-not-allowed text-text-secondary opacity-50'
                    : 'text-text-primary hover:bg-bg-hover',
                )}
                onClick={() => {
                  if (!item.disabled && item.onClick) {
                    item.onClick();
                    onClose();
                  }
                }}
                disabled={item.disabled}
              >
                {item.icon && (
                  <span className="shrink-0 flex items-center text-text-secondary">
                    {item.icon}
                  </span>
                )}
                <span className="flex-1">{item.label}</span>
              </button>
            )}
          </Fragment>
        ))}
      </div>
    </>
  );

  return createPortal(menuContent, document.body);
};
