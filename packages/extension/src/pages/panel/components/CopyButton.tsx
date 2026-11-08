import { FC, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '../utils/i18n';
import { copyToClipboard } from '../utils/clipboard';

interface CopyButtonProps {
  text: string;
  onCopy?: () => void;
  iconOnly?: boolean;
  size?: 'sm' | 'md';
}

export const CopyButton: FC<CopyButtonProps> = ({
  text,
  onCopy,
  iconOnly = false,
  size = 'md',
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onCopy?.();
    } else {
      console.error('复制失败');
    }
  };

  const iconSize = size === 'sm' ? 12 : 14;

  if (iconOnly) {
    return (
      <button
        onClick={handleCopy}
        className="p-1 hover:bg-bg-secondary rounded transition-colors shrink-0"
        title={t('copy')}
      >
        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      className="px-2 py-0.5 rounded transition-colors cursor-pointer text-2xs bg-bg-secondary text-text-primary hover:bg-bg-hover min-w-11.25 h-5 flex items-center justify-center"
    >
      {copied ? <Check size={iconSize} className="text-green-500" /> : t('copy')}
    </button>
  );
};
