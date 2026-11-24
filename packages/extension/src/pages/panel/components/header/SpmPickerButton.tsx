import { FC, useEffect, useRef } from 'react';
import { MapPin } from 'lucide-react';
import { clsx } from 'clsx';

interface SpmPickerButtonProps {
  active: boolean;
  continuous?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  title: string;
}

export const SpmPickerButton: FC<SpmPickerButtonProps> = ({
  active,
  continuous = false,
  onClick,
  onDoubleClick,
  title,
}) => {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (clickTimer.current !== null) clearTimeout(clickTimer.current);
    },
    [],
  );

  return (
    <button
      onClick={() => {
        if (!onDoubleClick) {
          onClick();
          return;
        }
        if (clickTimer.current !== null) clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null;
          onClick();
        }, 220);
      }}
      onDoubleClick={() => {
        if (clickTimer.current !== null) {
          clearTimeout(clickTimer.current);
          clickTimer.current = null;
        }
        onDoubleClick?.();
      }}
      aria-pressed={active}
      data-continuous={continuous ? 'true' : undefined}
      className={clsx(
        'relative p-0.75 rounded transition-colors cursor-pointer',
        active
          ? 'bg-blue-500/20 text-blue-600 hover:bg-blue-500/30 dark:text-blue-400'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
        continuous && 'ring-1 ring-blue-500/60',
      )}
      title={title}
    >
      <MapPin size={14} />
    </button>
  );
};
