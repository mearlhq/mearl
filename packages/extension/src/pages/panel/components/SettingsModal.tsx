import { getExtensionVersion } from '../../../shared/extensionVersion';
import { FC, lazy, Suspense, useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { Modal, ModalHeader } from './modal/Modal';
import { t } from '../utils/i18n';

import { INSTALLATION_SITE } from '../../../shared/installation';
import { useBrowserUiSettings } from '../utils/browserUiSettings';

interface SettingsModalProps {
  onClose: () => void;
  previewTabId?: number;
}

const Options = lazy(() => import('../../options/Options'));

export const SettingsModal: FC<SettingsModalProps> = ({ onClose, previewTabId }) => {
  const settings = useBrowserUiSettings();
  const [contextTabId, setContextTabId] = useState<number | null | undefined>(undefined);

  // 页面设置绑定具体 tab。预览和 DevTools 使用所检查的页面，Popup 使用活动标签页。
  useEffect(() => {
    const report = (tabId?: number) => {
      if (typeof tabId === 'number') {
        chrome.runtime.sendMessage({ action: 'settingsSetContextTab', tabId }).catch(() => {});
        setContextTabId(tabId);
      } else {
        setContextTabId(null);
      }
    };
    if (previewTabId !== undefined) {
      report(previewTabId);
      return;
    }
    const devtoolsTabId = (
      globalThis as unknown as { chrome?: { devtools?: { inspectedWindow?: { tabId?: number } } } }
    ).chrome?.devtools?.inspectedWindow?.tabId;
    if (typeof devtoolsTabId === 'number') {
      report(devtoolsTabId);
      return;
    }
    if (!chrome.tabs?.query) {
      setContextTabId(null);
      return;
    }
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => report(tab?.id))
      .catch(() => setContextTabId(null));
  }, [previewTabId]);

  const optionsUrl =
    previewTabId !== undefined || contextTabId === undefined
      ? null
      : `${chrome.runtime.getURL('src/pages/options/index.html')}?iframe=1${
          contextTabId === null ? '' : `&tabId=${contextTabId}`
        }`;
  const loading = (
    <div className="flex h-full items-center justify-center text-xs text-text-secondary">
      {t('loading')}
    </div>
  );

  return (
    <Modal isOpen onClose={onClose} size="fullscreen" ariaLabel={t('settings')}>
      <ModalHeader
        title={
          <span className="flex items-center gap-1.5">
            {t('settings')}
            <span className="text-text-secondary">v{getExtensionVersion()}</span>
          </span>
        }
        actions={
          <a
            href={settings.links?.manual ?? INSTALLATION_SITE.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-blue-600 transition-colors"
            title={t('userManual')}
          >
            <BookOpen className="w-3.5 h-3.5" />
            {t('userManual')}
          </a>
        }
        onClose={onClose}
      />
      <div
        className={
          previewTabId === undefined ? 'flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-y-auto'
        }
      >
        {previewTabId !== undefined ? (
          <Suspense fallback={loading}>
            <Options embeddedTabId={previewTabId} />
          </Suspense>
        ) : optionsUrl ? (
          <iframe src={optionsUrl} className="w-full h-full border-0" title={t('settings')} />
        ) : (
          loading
        )}
      </div>
    </Modal>
  );
};
