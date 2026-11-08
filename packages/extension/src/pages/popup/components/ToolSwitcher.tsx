import { useEffect, useId, useRef } from 'react';
import { ArrowRightLeft, Check } from 'lucide-react';
import { t } from '../../panel/utils/i18n';
import { useDelayedHover } from '../../../shared/hooks/useDelayedHover';
import { ToolboxIcon, type ToolboxIconSource } from '../../../shared/toolboxIcons';

interface ToolSwitcherProps {
  currentId: string;
  tools: Array<{
    id: string;
    title: string;
    icon: ToolboxIconSource;
    onClick: () => void;
  }>;
}

export function ToolSwitcher({ currentId, tools }: ToolSwitcherProps) {
  const { open, setOpen, scheduleOpen, scheduleClose, cancelOpen, cancelClose } = useDelayedHover();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusOnOpenRef = useRef(false);

  const focusMenu = () => {
    const menu = menuRef.current;
    (
      menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu?.querySelector<HTMLButtonElement>('button')
    )?.focus();
  };

  const openWithFocus = () => {
    focusOnOpenRef.current = true;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    if (focusOnOpenRef.current) {
      focusOnOpenRef.current = false;
      focusMenu();
    }
    const ownerDocument = rootRef.current?.ownerDocument ?? document;
    const documents = new Set([document, ownerDocument]);
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    documents.forEach(doc => doc.addEventListener('pointerdown', dismiss));
    return () => documents.forEach(doc => doc.removeEventListener('pointerdown', dismiss));
  }, [open, setOpen]);

  return (
    <div
      ref={rootRef}
      className="relative flex items-center"
      onMouseEnter={scheduleOpen}
      onMouseLeave={() => {
        cancelOpen();
        if (!menuRef.current?.contains(rootRef.current?.ownerDocument.activeElement ?? null)) {
          scheduleClose();
        }
      }}
      onFocus={cancelClose}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (
          event.target === triggerRef.current &&
          ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)
        ) {
          event.preventDefault();
          if (open) focusMenu();
          else openWithFocus();
          return;
        }
        if (!open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        } else if (event.key === 'Tab') {
          setOpen(false);
          triggerRef.current?.focus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []),
          ];
          const current = buttons.indexOf(event.target as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        title={t('toolboxSwitchTool')}
        aria-label={t('toolboxSwitchTool')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary ${open ? 'bg-bg-hover text-text-primary' : ''}`}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          onMouseEnter={cancelClose}
          aria-label={t('toolboxSwitchTool')}
          className="absolute right-0 top-full z-50 mt-1 max-h-[min(320px,70vh)] w-52 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border border-border bg-bg-primary p-1 shadow-lg"
        >
          {tools.map(({ id, title, icon, onClick }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={id === currentId}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                if (id !== currentId) onClick();
              }}
              className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-bg-hover focus:bg-bg-hover focus:outline-none ${id === currentId ? 'text-blue-500' : 'text-text-primary'}`}
            >
              <ToolboxIcon icon={icon} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {id === currentId ? <Check className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
