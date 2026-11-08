import { FC, useState } from 'react';
import { Check } from 'lucide-react';
import { copyToClipboard } from '../../utils/clipboard';
import { t } from '../../utils/i18n';

interface TraceidCopyButtonProps {
  traceid: string;
}

export const TraceidCopyButton: FC<TraceidCopyButtonProps> = ({ traceid }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(traceid);
    if (!success) {
      return;
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex h-5 w-16 items-center justify-center rounded font-mono text-2xs text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary cursor-pointer"
      title={t('copyFullTraceid')}
      aria-label={t('copyFullTraceid')}
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <span>#{traceid.slice(0, 8)}</span>}
    </button>
  );
};
