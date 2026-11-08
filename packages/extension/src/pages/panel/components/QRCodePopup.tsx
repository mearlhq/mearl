import { useCallback, useEffect, useState, useRef, FC } from 'react';
import { createPortal } from 'react-dom';
import { generateQrCodeSvgMarkup } from '../utils/qrCode';
import { t } from '../utils/i18n';

const CLOSE_DELAY_MS = 150;

interface QRCodePopupProps {
  url: string;
  harmonyUrl?: string;
  targetRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  size?: number;
}

export const QRCodePopup: FC<QRCodePopupProps> = ({
  url,
  harmonyUrl,
  targetRef,
  onClose,
  size = 160,
}) => {
  const [qrSvgMarkup, setQrSvgMarkup] = useState<string>('');
  const [platform, setPlatform] = useState<'androidIos' | 'harmony'>('androidIos');
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const popupRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrUrl = platform === 'harmony' && harmonyUrl ? harmonyUrl : url;

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, CLOSE_DELAY_MS);
  }, [cancelClose, onClose]);

  // 生成二维码
  useEffect(() => {
    if (qrUrl) {
      try {
        setQrSvgMarkup(generateQrCodeSvgMarkup(qrUrl));
      } catch (err) {
        console.error('Failed to generate QR code:', err);
      }
    }
  }, [qrUrl]);

  useEffect(() => {
    setPlatform('androidIos');
  }, [url]);

  // 计算位置
  useEffect(() => {
    const updatePosition = () => {
      if (!targetRef.current) return;

      const rect = targetRef.current.getBoundingClientRect();
      const popupWidth = size + 16; // padding
      const popupHeight = size + (harmonyUrl ? 40 : 16); // padding + platform switch

      // 默认在按钮左侧
      let left = rect.left - popupWidth - 8;
      let top = rect.top + rect.height / 2 - popupHeight / 2;

      // 如果左侧空间不足，则显示在右侧
      if (left < 8) {
        left = rect.right + 8;
      }

      // 确保不超出视口底部
      const viewportHeight = window.innerHeight;
      if (top + popupHeight > viewportHeight - 8) {
        top = viewportHeight - popupHeight - 8;
      }

      // 确保不超出视口顶部
      if (top < 8) {
        top = 8;
      }

      setPosition({ top, left });
    };

    updatePosition();

    // 窗口大小变化时重新计算位置
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [targetRef, size, harmonyUrl]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    target.addEventListener('mouseenter', cancelClose);
    target.addEventListener('mouseleave', scheduleClose);
    return () => {
      target.removeEventListener('mouseenter', cancelClose);
      target.removeEventListener('mouseleave', scheduleClose);
      cancelClose();
    };
  }, [targetRef, cancelClose, scheduleClose]);

  // 处理 ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!qrSvgMarkup) return null;

  return createPortal(
    <div
      ref={popupRef}
      className="qr-code-popup fixed z-[9999] bg-white p-2 rounded shadow-lg border border-border"
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      style={{
        top: position.top,
        left: position.left,
        minWidth: size + 16,
      }}
    >
      <div
        role="img"
        aria-label="QR Code"
        className="block"
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: qrSvgMarkup }}
      />
      {harmonyUrl && (
        <button
          type="button"
          className="block mx-auto mt-1 text-xxs text-text-secondary hover:brightness-75 focus-visible:brightness-75 focus-visible:outline-none transition-[filter] cursor-pointer"
          onClick={() => setPlatform(current => (current === 'harmony' ? 'androidIos' : 'harmony'))}
        >
          {platform === 'harmony' ? t('accountSwitchToAndroidIos') : t('accountSwitchToHarmony')}
        </button>
      )}
    </div>,
    document.body,
  );
};
