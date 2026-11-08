import { useState, FC } from 'react';
import { Edit, Check } from 'lucide-react';
import { t } from '../utils/i18n';
import { sendMessageSafely } from '../utils/safeChrome';

interface ResendButtonProps {
  inspectedTabId?: number;
  originalUrl: string;
  apiName: string;
  method: string;
  queryParams?: Array<{ name: string; value: string }>;
  requestData: any;
  isEditing: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onSuccess?: (response: any, requestData: any) => void;
  onError?: (error: string) => void;
}

export const ResendButton: FC<ResendButtonProps> = ({
  inspectedTabId,
  originalUrl,
  apiName,
  method,
  queryParams,
  requestData,
  isEditing,
  onEditStart,
  onEditCancel,
  onSuccess,
  onError,
}) => {
  const [isSending, setIsSending] = useState(false);
  const tabId = inspectedTabId ?? globalThis.chrome?.devtools?.inspectedWindow?.tabId;
  if (typeof tabId !== 'number') return null;

  const handleSend = async () => {
    setIsSending(true);

    try {
      const result = await sendMessageSafely({
        action: 'resendProtocolRequest',
        tabId,
        data: {
          apiName,
          method,
          requestData,
          originalUrl,
          queryParams,
        },
      });

      if (result.success) {
        onSuccess?.(result.response, result.requestData);
        onEditCancel();
      } else {
        const errorMsg = result.error || t('resendError');
        onError?.(errorMsg);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : t('resendError');
      onError?.(errorMsg);
    } finally {
      setIsSending(false);
    }
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={handleSend}
          disabled={isSending}
          title={t('confirmSend')}
          className="px-2 py-0.5 rounded transition-colors cursor-pointer text-2xs bg-blue-600 text-white active:bg-blue-500 min-w-11.25 h-5 flex items-center justify-center gap-1 disabled:opacity-50"
        >
          <Check className="w-3 h-3" />
          {isSending ? t('sending') : t('confirmSend')}
        </button>
        <button
          onClick={onEditCancel}
          disabled={isSending}
          title={t('cancelEdit')}
          className="px-2 py-0.5 rounded transition-colors cursor-pointer text-2xs bg-bg-secondary text-text-primary hover:bg-bg-hover min-w-11.25 h-5 flex items-center justify-center disabled:opacity-50"
        >
          {t('cancelEdit')}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onEditStart}
      title={t('resendRequest')}
      className="px-2 py-0.5 rounded transition-colors cursor-pointer text-2xs bg-blue-500 text-white hover:bg-blue-600 min-w-11.25 h-5 flex items-center justify-center gap-1"
    >
      <Edit className="w-3 h-3" />
      {t('resend')}
    </button>
  );
};
