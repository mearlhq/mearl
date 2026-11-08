import type { ButtonHTMLAttributes, FC } from 'react';
import { clsx } from 'clsx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}

export const Button: FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}) => (
  <button
    {...props}
    className={clsx(
      'cursor-pointer rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1.5 text-xs',
      variant === 'primary'
        ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
        : 'border-border bg-bg-primary text-text-primary hover:border-blue-400',
      className,
    )}
  />
);
