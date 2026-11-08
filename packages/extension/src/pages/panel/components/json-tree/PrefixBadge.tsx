import { useState, FC, MouseEvent } from 'react';
import { Check } from 'lucide-react';
import { clsx } from 'clsx';

type BadgeVariant = 'orange' | 'amber' | 'blue' | 'green';

interface PrefixBadgeProps {
  text: string;
  tooltip?: string;
  copyText?: string; // 如果提供，则可复制
  variant?: BadgeVariant;
  onClick?: (e: MouseEvent) => void; // 点击回调（优先于 copyText）
  toggled?: boolean; // 是否处于切换状态（如原始字符串模式）
}

export const PrefixBadge: FC<PrefixBadgeProps> = ({
  text,
  tooltip,
  copyText,
  variant = 'orange',
  onClick,
  toggled = false,
}) => {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = (textToCopy: string) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(err => {
          console.error('复制失败:', err);
          fallbackCopy(textToCopy);
        });
    } else {
      fallbackCopy(textToCopy);
    }
  };

  const fallbackCopy = (textToCopy: string) => {
    const textArea = document.createElement('textarea');
    textArea.value = textToCopy;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('复制失败(fallback):', err);
    }
    document.body.removeChild(textArea);
  };

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (onClick) {
      onClick(e);
    } else if (copyText) {
      copyToClipboard(copyText);
    }
  };

  const variantClasses = {
    orange:
      'bg-orange-500/15 text-orange-600 dark:bg-orange-500/20 dark:text-orange-400 border-orange-500/30',
    amber: 'bg-amber-500/10 text-amber-500 border-amber-500/25',
    blue: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 border-blue-500/25',
    green:
      'bg-green-500/15 text-green-600 dark:bg-green-500/20 dark:text-green-400 border-green-500/30',
  };

  const isInteractive = !!(onClick || copyText);
  const baseClasses = `px-1 rounded text-[8px] font-medium shrink-0 border inline-flex items-center justify-center ${variantClasses[variant]}`;
  const interactiveClasses = isInteractive ? 'cursor-pointer hover:opacity-80' : '';
  const toggledClasses = toggled ? 'line-through opacity-60' : '';

  return (
    <span
      className={clsx(`${baseClasses} ${interactiveClasses} ${toggledClasses}`)}
      title={tooltip}
      onClick={handleClick}
    >
      {copied ? <Check size={10} className="text-green-600" /> : text}
    </span>
  );
};
