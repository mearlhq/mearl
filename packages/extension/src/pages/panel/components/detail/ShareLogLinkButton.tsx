import { FC, useState } from 'react';
import { Check, Share2 } from 'lucide-react';
import { CapturedRequest } from '../../types';
import { copyToClipboard } from '../../utils/clipboard';
import { callBrowserUiOperation, useBrowserUiSettings } from '../../utils/browserUiSettings';
import { browserUiUrl } from '../../../../shared/browserUiSettings';
import { showToast } from '../../utils/toast';
import { t } from '../../utils/i18n';
import { fetchAccountIdentity } from '../../utils/accounts';

interface ShareLogLinkButtonProps {
  request: CapturedRequest;
}

/** 从响应头里取 eagleeye 全链路 traceId（大小写不敏感），没有则空串。 */
function getEagleeyeTraceId(request: CapturedRequest): string {
  return (
    request.responseHeaders?.find(h => h.name.toLowerCase() === 'eagleeye-traceid')?.value ?? ''
  );
}

/** 从请求头里取指定字段（大小写不敏感），没有则 undefined。 */
function getRequestHeader(request: CapturedRequest, name: string): string | undefined {
  return request.headers?.find(h => h.name.toLowerCase() === name)?.value || undefined;
}

export const ShareLogLinkButton: FC<ShareLogLinkButtonProps> = ({ request }) => {
  const [copied, setCopied] = useState(false);
  const settings = useBrowserUiSettings();

  const traceId = getEagleeyeTraceId(request);
  // apiName 和 traceId 都没有时，链接无法定位到具体日志，直接不展示按钮
  if (!settings.operations?.['logs.share'] || !request.apiName && !traceId) return null;

  const handleClick = async () => {
    try {
      const requestUserId = getRequestHeader(request, 'x-uid');
      const browserUserId = requestUserId ? '' : (await fetchAccountIdentity()).value;
      const url = browserUiUrl(await callBrowserUiOperation('logs.share', {
        apiName: request.apiName,
        timestampMs: request.timestampMs,
        traceId,
        // 真机抓包优先使用设备账号；浏览器请求则使用当前 unb。
        uid: requestUserId || browserUserId,
        utdid: getRequestHeader(request, 'x-utdid'),
      }));
      const success = await copyToClipboard(url);
      if (success) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch { showToast(t('copyFailed'), 'error'); }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-bg-secondary"
      title={t('shareLogLink')}
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Share2 className="h-3 w-3 text-text-secondary hover:text-text-primary" />
      )}
    </button>
  );
};
