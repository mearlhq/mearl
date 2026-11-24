import { FC } from 'react';
import { MapPin } from 'lucide-react';
import { clsx } from 'clsx';

interface SpmPickerButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
}

export const SpmPickerButton: FC<SpmPickerButtonProps> = ({ active, onClick, title }) => (
  <button
    onClick={onClick}
    aria-pressed={active}
    className={clsx(
      'p-0.75 rounded transition-colors cursor-pointer',
      active
        ? 'bg-blue-500/20 text-blue-600 hover:bg-blue-500/30 dark:text-blue-400'
        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
    )}
    title={title}
  >
    <MapPin size={14} />
  </button>
);
