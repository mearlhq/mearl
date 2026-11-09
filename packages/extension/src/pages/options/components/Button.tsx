import type { ButtonHTMLAttributes, FC } from 'react';
import { clsx } from 'clsx';
import { LoaderCircle } from 'lucide-react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
  loading?: boolean;
}

export const Button: FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  className,
  loading = false,
  children,
  disabled,
  ...props
}) => (
  <button
    {...props}
    disabled={disabled || loading}
    aria-busy={loading || props['aria-busy']}
    className={clsx(
      'cursor-pointer rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1.5 text-xs',
      variant === 'primary'
        ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
        : 'border-border bg-bg-primary text-text-primary hover:border-blue-400',
      className,
      loading && 'relative',
    )}
  >
    {loading ? (
      <>
        <span className="opacity-0">{children}</span>
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
        </span>
      </>
    ) : (
      children
    )}
  </button>
);
