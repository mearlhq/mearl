import { FC, useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { RemoteConfig } from '../../hooks/useRemoteConfig';
import { storageGetSafely, storageSetSafely } from '../../utils/safeChrome';

const BANNER_DISMISSED_KEY = 'mearl-banner-dismissed';

interface BannerProps {
  config: RemoteConfig | null;
}

export const Banner: FC<BannerProps> = ({ config }) => {
  const banner = config?.banner;
  // undefined = 还没读完；null = 读完无值；string = 已 dismiss 的文案
  const [dismissedText, setDismissedText] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    storageGetSafely<string>([BANNER_DISMISSED_KEY])
      .then(result => {
        if (cancelled) return;
        setDismissedText(result?.[BANNER_DISMISSED_KEY] ?? null);
      })
      .catch(() => {
        if (!cancelled) setDismissedText(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDismiss = () => {
    if (!banner?.text) return;
    setDismissedText(banner.text);
    storageSetSafely({ [BANNER_DISMISSED_KEY]: banner.text }).catch(() => {
      /* ignore */
    });
  };

  if (
    dismissedText === undefined ||
    !banner?.text ||
    !banner?.url ||
    banner.text === dismissedText
  ) {
    return null;
  }

  return (
    <a
      href={banner.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group hidden @[480px]:flex items-center gap-1 flex-1 min-w-0 ml-3 mr-2 text-xxs text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400 truncate transition-colors"
      title={banner.text}
    >
      <span className="truncate">{banner.text}</span>
      <button
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          handleDismiss();
        }}
        className="shrink-0 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
      >
        <X size={10} strokeWidth={2} />
      </button>
    </a>
  );
};
