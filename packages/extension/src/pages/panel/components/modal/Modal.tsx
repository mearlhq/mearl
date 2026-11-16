import { CSSProperties, FC, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { clsx } from 'clsx';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onExited?: () => void;
  children: ReactNode;
  size?: 'compact' | 'default' | 'fullscreen';
  contentStyle?: CSSProperties;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  topLayer?: boolean;
}

export const Modal: FC<ModalProps> = ({
  isOpen,
  onClose,
  onExited,
  children,
  size = 'fullscreen',
  contentStyle,
  ariaLabel,
  ariaLabelledBy,
  topLayer = false,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const exitCallback = useRef(onExited);
  exitCallback.current = onExited;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [shouldRender, topLayer]);

  useEffect(() => {
    if (isOpen) {
      // 先设置 shouldRender，让 DOM 渲染
      setShouldRender(true);
      // 强制初始状态为不可见
      setIsVisible(false);
      // 使用 requestAnimationFrame 确保 DOM 已经渲染到页面上
      let enterFrame: number | undefined;
      const renderFrame = requestAnimationFrame(() => {
        enterFrame = requestAnimationFrame(() => setIsVisible(true));
      });
      return () => {
        cancelAnimationFrame(renderFrame);
        if (enterFrame !== undefined) cancelAnimationFrame(enterFrame);
      };
    } else if (shouldRender) {
      // 先关闭动画
      setIsVisible(false);
      // 等待动画结束后再卸载
      const timer = setTimeout(() => {
        setShouldRender(false);
        exitCallback.current?.();
      }, 200); // 与 CSS 过渡时间匹配
      return () => clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    if (isOpen && !topLayer) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose, topLayer]);

  if (!shouldRender) return null;

  const sizeClasses = {
    compact: 'max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-lg',
    default: 'max-w-2xl w-full mx-4',
    fullscreen: 'w-[90%] h-[90%]',
  }[size];
  const panelMotion = clsx(
    'transition-[opacity,scale] duration-200 motion-reduce:transition-none',
    isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
  );

  if (topLayer) {
    return (
      <dialog
        ref={dialogRef}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={clsx(
          'fixed inset-0 m-auto flex-col overflow-hidden rounded-md border border-border bg-bg-primary text-text-primary shadow-xs open:flex',
          'backdrop:transition-colors backdrop:duration-200 motion-reduce:backdrop:transition-none',
          isVisible ? 'backdrop:bg-black/20' : 'backdrop:bg-transparent',
          sizeClasses,
          panelMotion,
        )}
        style={contentStyle}
        onCancel={event => {
          event.preventDefault();
          if (isOpen) onClose();
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') event.stopPropagation();
        }}
      >
        {children}
      </dialog>
    );
  }

  return (
    <div
      className={clsx(
        'fixed inset-0 z-50 mb-0 flex items-center justify-center transition-colors duration-200 motion-reduce:transition-none',
        isVisible ? 'bg-black/50' : 'bg-black/0',
      )}
      onClick={onClose}
      onContextMenu={event => event.stopPropagation()}
    >
      <div
        role={ariaLabel || ariaLabelledBy ? 'dialog' : undefined}
        aria-modal={ariaLabel || ariaLabelledBy ? true : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={clsx(
          'rounded-lg shadow-2xl flex flex-col bg-bg-primary',
          panelMotion,
          sizeClasses,
        )}
        style={contentStyle}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

interface ModalHeaderProps {
  title: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
}

export const ModalHeader: FC<ModalHeaderProps> = ({ title, onClose, actions }) => {
  return (
    <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-toolbar min-h-8">
      <h2 className="font-medium text-xs text-text-primary">{title}</h2>
      <div className="flex items-center gap-2 min-h-5">
        {actions}
        <button
          onClick={onClose}
          className="transition-colors cursor-pointer text-text-secondary hover:text-text-primary"
          title="Close (ESC)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

interface ModalContentProps {
  children: ReactNode;
}

export const ModalContent: FC<ModalContentProps> = ({ children }) => {
  return <div className="flex-1 overflow-y-auto p-3 bg-bg-secondary flex flex-col">{children}</div>;
};

interface ModalFooterProps {
  children: ReactNode;
}

export const ModalFooter: FC<ModalFooterProps> = ({ children }) => {
  return (
    <div className="border-t border-toolbar-border bg-toolbar text-text-secondary p-1 flex items-center justify-between">
      {children}
    </div>
  );
};
