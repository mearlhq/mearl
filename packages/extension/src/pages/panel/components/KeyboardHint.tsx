import type { HTMLAttributes } from 'react';
import { clsx } from 'clsx';

interface KeyboardHintProps extends HTMLAttributes<HTMLDivElement> {
  surface?: 'primary' | 'secondary';
}

export function KeyboardHint({ className, surface = 'secondary', ...props }: KeyboardHintProps) {
  return (
    <div
      className={clsx(
        'flex items-center px-1 py-0.5 border border-border rounded',
        surface === 'primary' ? 'bg-bg-primary' : 'bg-bg-secondary',
        className,
      )}
      {...props}
    />
  );
}
