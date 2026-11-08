import { FC, ReactNode } from 'react';
import { CopyButton } from '../CopyButton';

interface DetailRowProps {
  label: string;
  value: ReactNode;
  showCopy?: boolean;
  copyText?: string;
  action?: ReactNode;
}

export const DetailRow: FC<DetailRowProps> = ({ label, value, showCopy, copyText, action }) => {
  return (
    <div className="flex items-center py-1.5 border-b border-border text-xs">
      <div className="w-32 font-medium text-text-secondary text-xxs shrink-0">{label}</div>
      <div
        className="flex-1 break-all text-text-primary text-xxs overflow-auto"
        title={typeof value === 'string' ? (value as string) : undefined}
      >
        {value}
      </div>
      {action && <div className="ml-2">{action}</div>}
      {showCopy && !action && (
        <div className="ml-2">
          <CopyButton text={copyText || String(value)} />
        </div>
      )}
    </div>
  );
};
