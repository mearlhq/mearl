import { CSSProperties, FC, ReactNode, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { clsx } from 'clsx';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: 'default' | 'fullscreen';
  contentStyle?: CSSProperties;
  ariaLabel?: string;
}

export const Modal: FC<ModalProps> = ({
  isOpen,
  onClose,
  children,
  size = 'fullscreen',
  contentStyle,
  ariaLabel,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // 先设置 shouldRender，让 DOM 渲染
      setShouldRender(true);
      // 强制初始状态为不可见
      setIsVisible(false);
      // 使用 requestAnimationFrame 确保 DOM 已经渲染到页面上
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
    } else if (shouldRender) {
      // 先关闭动画
      setIsVisible(false);
      // 等待动画结束后再卸载
      const timer = setTimeout(() => {
        setShouldRender(false);
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

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!shouldRender) return null;

  const sizeClasses = size === 'fullscreen' ? 'w-[90%] h-[90%]' : 'max-w-2xl w-full mx-4';

  return (
    <div
      className={clsx(
        'fixed inset-0 z-50 mb-0 flex items-center justify-center transition-colors duration-200',
        isVisible ? 'bg-black/50' : 'bg-black/0',
      )}
      onClick={onClose}
      onContextMenu={event => event.stopPropagation()}
    >
      <div
        role={ariaLabel ? 'dialog' : undefined}
        aria-modal={ariaLabel ? true : undefined}
        aria-label={ariaLabel}
        className={clsx(
          'rounded-lg shadow-2xl flex flex-col bg-bg-primary transition-[opacity,scale] duration-200',
          isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
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
