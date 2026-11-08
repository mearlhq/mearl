import { useState, useEffect, useRef, FC, ReactNode } from 'react';
import { QrCode } from 'lucide-react';
import { generateQrCodeSvgMarkup } from '../utils/qrCode';
import { t } from '../utils/i18n';
import { clsx } from 'clsx';

interface QRCodeHoverProps {
  url: string;
  size?: number;
  placement?: 'right' | 'left';
  children?: ReactNode;
  autoShow?: boolean; // 是否自动展示二维码
  description?: string; // 二维码底部描述文字
}

export const QRCodeHover: FC<QRCodeHoverProps> = ({
  url,
  size = 200,
  placement,
  children,
  autoShow = false,
  description,
}) => {
  const [showQR, setShowQR] = useState(autoShow);
  const [qrSvgMarkup, setQrSvgMarkup] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);

  // 当 autoShow 变化时，同步更新 showQR 状态
  useEffect(() => {
    setShowQR(autoShow);
  }, [autoShow]);

  useEffect(() => {
    if (showQR) {
      try {
        setQrSvgMarkup(generateQrCodeSvgMarkup(url));
      } catch (err) {
        console.error('Failed to generate QR code:', err);
      }
    }
  }, [showQR, url]);

  return (
    <div
      ref={containerRef}
      className="relative inline-block"
      onMouseEnter={() => setShowQR(true)}
      onMouseLeave={() => setShowQR(false)}
    >
      {children || (
        <button
          className="p-1 hover:bg-bg-secondary rounded transition-colors text-text-secondary hover:text-text-primary"
          title={t('showQRCode')}
        >
          <QrCode size={14} />
        </button>
      )}

      {showQR && qrSvgMarkup && (
        <div
          className={clsx(
            `absolute top-full mt-1 z-50 bg-white p-2 rounded shadow-lg border border-border ${placement === 'right' ? 'left-0' : 'right-0'}`,
          )}
          style={{ minWidth: size + 16 }}
        >
          <div
            role="img"
            aria-label="QR Code"
            className="block"
            style={{ width: size, height: size }}
            dangerouslySetInnerHTML={{ __html: qrSvgMarkup }}
          />
          {description && (
            <p className="text-center text-xxs text-gray-500 mt-0.5">{description}</p>
          )}
        </div>
      )}
    </div>
  );
};
