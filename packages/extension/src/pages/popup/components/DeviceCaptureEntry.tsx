import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../panel/utils/i18n';

interface DeviceCaptureEntryProps {
  onBack?: () => void;
  headerActions?: ReactNode;
  surface?: 'popup' | 'tab';
}

export function DeviceCaptureEntry({
  onBack,
  headerActions,
  surface = 'popup',
}: DeviceCaptureEntryProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const deviceCaptureUrl = chrome.runtime.getURL(
    `src/pages/device-capture/index.html?embedded=1${onBack ? '&toolbox=1' : ''}${surface === 'popup' ? '&autoLaunch=0' : ''}`,
  );

  useEffect(() => {
    if (!onBack) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'mearl-toolbox-back') onBack();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onBack]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const connectHeader = () => {
    observerRef.current?.disconnect();
    setHeaderTarget(null);
    if (!headerActions) return;
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    const attach = () => {
      const target = frameDocument.getElementById('mearl-toolbox-header-actions');
      if (!target) return false;
      setHeaderTarget(target);
      observerRef.current?.disconnect();
      return true;
    };
    if (attach()) return;
    observerRef.current = new MutationObserver(attach);
    observerRef.current.observe(frameDocument, { childList: true, subtree: true });
  };

  return (
    <>
      {headerTarget && headerActions ? createPortal(headerActions, headerTarget) : null}
      <iframe
        ref={iframeRef}
        src={deviceCaptureUrl}
        title={t('realDeviceCapture')}
        className="h-full w-full border-0 bg-bg-primary"
        onLoad={connectHeader}
      />
    </>
  );
}
