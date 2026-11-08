import { FC, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

interface DetailSectionProps {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
}

const ChevronIcon: FC<{ collapsed: boolean; onToggle: () => void }> = ({ collapsed, onToggle }) => (
  <span
    aria-hidden
    onClick={onToggle}
    className="inline-flex w-4 h-4 items-center justify-center cursor-pointer text-text-secondary shrink-0"
  >
    <ChevronDown
      size={16}
      className={clsx(
        'transition-transform duration-120 ease',
        collapsed ? '-rotate-90' : 'rotate-0',
      )}
    />
  </span>
);

export const DetailSection: FC<DetailSectionProps> = ({
  title,
  action,
  children,
  collapsed,
  onToggle,
}) => (
  <div className={clsx(collapsed ? 'mb-2' : 'mb-4')}>
    <div
      className={clsx(
        'flex items-center gap-y-1 mb-2 pb-1 border-b',
        collapsed ? 'border-transparent' : 'border-[rgb(42,87,201)]',
      )}
    >
      <div className="flex flex-1 min-w-0 shrink-0 items-center gap-1.5 font-medium text-xxs text-text-primary leading-5 select-none mr-2">
        <ChevronIcon collapsed={collapsed} onToggle={onToggle} />
        <span>{title}</span>
      </div>
      {action && <div className="flex shrink-0 items-center ml-auto">{action}</div>}
    </div>
    <div className="px-1">{!collapsed && children}</div>
  </div>
);
