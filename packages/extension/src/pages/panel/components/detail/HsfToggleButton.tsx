import { FC } from 'react';
import { t } from '../../utils/i18n';

interface HsfToggleButtonProps {
  enabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  label?: string;
  title?: string;
}

export const HsfToggleButton: FC<HsfToggleButtonProps> = ({
  enabled,
  loading,
  onClick,
  label = 'HSF',
  title,
}) => {
  const className = `px-2 py-0.5 rounded transition-colors cursor-pointer text-2xs min-w-11.25 h-5 flex items-center justify-center disabled:opacity-50 ${
    enabled
      ? 'bg-blue-500 text-white hover:bg-blue-600'
      : 'bg-bg-secondary text-text-primary hover:bg-bg-hover'
  }`;

  return (
    <button
      onClick={onClick}
      disabled={loading}
      title={title ?? t('viewInHsfOps')}
      className={className}
    >
      {label}
    </button>
  );
};
