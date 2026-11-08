import { FC, useState } from 'react';
import { CopyButton } from '../CopyButton';

interface DetailRowUrlProps {
  label: string;
  value: string;
}

export const DetailRowUrl: FC<DetailRowUrlProps> = ({ label, value }) => {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="flex py-1.5 border-b border-border">
      <div className="w-32 font-medium text-text-secondary text-xxs">{label}</div>
      <div className="flex-1 flex items-center gap-2">
        <div
          className="flex-1 break-all line-clamp-2 relative cursor-help text-text-primary text-xxs"
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
          title={value}
        >
          {value}
          {showTooltip && (
            <div className="absolute z-50 left-0 top-full mt-1 text-xs px-2 py-1 rounded shadow-lg max-w-md break-all bg-neutral-800 text-white">
              {value}
            </div>
          )}
        </div>
        <CopyButton text={value} />
      </div>
    </div>
  );
};
