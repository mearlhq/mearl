import { FC } from 'react';
import { AlertCircle, Download, ExternalLink } from 'lucide-react';
import { Modal, ModalHeader, ModalContent } from './modal';
import { t } from '../utils/i18n';

interface TranslateErrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  errorType: 'not-supported' | 'downloading' | 'failed';
  downloadProgress?: number; // 0-100
  errorMessage?: string;
}

export const TranslateErrorModal: FC<TranslateErrorModalProps> = ({
  isOpen,
  onClose,
  errorType,
  downloadProgress,
  errorMessage,
}) => {
  return (
    <Modal size="default" isOpen={isOpen} onClose={onClose}>
      <ModalHeader
        title={
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-orange-500" />
            <span>{t('translateError')}</span>
          </div>
        }
        onClose={onClose}
      />

      <ModalContent>
        <div className="space-y-3 text-xs">
          {/* 错误类型说明 */}
          {errorType === 'not-supported' && (
            <>
              <p className="text-text-secondary">{t('translateNotSupportedDesc')}</p>

              {/* 开启步骤 */}
              <div className="space-y-2">
                <p className="font-medium text-text-primary">{t('translateEnableSteps')}</p>
                <ol className="list-decimal list-inside space-y-1.5 text-text-secondary">
                  <li>{t('translateStep1')}</li>
                  <li>{t('translateStep2')}</li>
                  <li>{t('translateStep3')}</li>
                </ol>
              </div>

              {/* Chrome 帮助文档 */}
              <div className="pt-2 border-t border-border">
                <a
                  href="https://developer.chrome.com/docs/ai/built-in-apis"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:text-blue-600 text-xs flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('translateLearnMore')}
                </a>
              </div>
            </>
          )}

          {errorType === 'downloading' && (
            <>
              <p className="text-text-secondary">{t('translateModelDownloading')}</p>

              {/* 下载进度 */}
              {downloadProgress !== undefined && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-text-primary">
                    <div className="flex items-center gap-2">
                      <Download className="w-4 h-4 text-blue-500 animate-pulse" />
                      <span>{t('downloadProgress')}</span>
                    </div>
                    <span className="font-medium">{Math.round(downloadProgress)}%</span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-blue-500 dark:bg-blue-400 h-full transition-all duration-300"
                      style={{ width: `${downloadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              <p className="text-text-secondary text-xxs">{t('translateDownloadHint')}</p>
            </>
          )}

          {errorType === 'failed' && (
            <>
              <p className="text-text-secondary">{t('translateFailedDesc')}</p>

              {errorMessage && (
                <div className="bg-bg-primary rounded border border-border p-2.5 font-mono text-xxs text-red-500">
                  {errorMessage}
                </div>
              )}

              <p className="text-text-secondary text-xxs">{t('translateRetryHint')}</p>
            </>
          )}
        </div>
      </ModalContent>
    </Modal>
  );
};
